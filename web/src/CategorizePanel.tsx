/**
 * CategorizePanel — Sprint Q-1 (kanban revision).
 *
 * Drag-and-drop transaction triage in a kanban layout. The user asked for:
 *
 *   "every transaction in click-and-draggable modules that I can drag
 *    into the buckets/categories they belong to. and over time the
 *    machine should be able to get smarter and recommend them, and
 *    maybe indicate that it's a 'guessed' placement."
 *
 * Layout (kanban — chosen over sidebar+grid in the second pass):
 *
 *  ┌Uncat┐ ┌Housing┐ ┌Food─┐ ┌Trans─┐ ┌Subs──┐ ┌Health┐ …
 *  │ $? ?│ │$2K ✓  │ │$12 ?│ │$45 ?│ │$15 ?│ │     │
 *  │ $? ?│ │       │ │ $8 ✓│ │     │ │$10 ?│ │     │
 *  │     │ │       │ │     │ │     │ │     │ │     │
 *  └─────┘ └───────┘ └─────┘ └─────┘ └─────┘ └─────┘ →scroll
 *
 *   - Each column is one category.
 *   - Cards live inside their CURRENT category column.
 *   - Drag a card to a different column to recategorize.
 *   - Cards show a confidence badge inline:
 *       manual  → no badge, solid border (user-confirmed)
 *       rule    → blue "rule" badge, dashed border
 *       default → amber "guess" badge, dashed border
 *       unset   → amber "?" badge, dashed amber border (in Uncategorized col)
 *   - Filter toggle hides confirmed cards so the user can triage only
 *     the guesses without losing the spatial map of where everything
 *     already lives.
 *   - Horizontal scroll: with ~24 categories the columns won't fit on
 *     screen. That's the deliberate tradeoff — user opted for kanban
 *     after seeing the sidebar-grid alternative.
 *
 * Q-2 (auto-rule creation on drag) and Q-3 (similarity-based pre-
 * placement for fully uncategorized cards) build on top of this — they
 * don't change the layout, just enrich the cards.
 */
import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
} from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type Category,
  type CategorySuggestion,
  type Transaction,
} from "./api/client";

// ============================================================
// Configuration
// ============================================================

const DEFAULT_LOOKBACK_DAYS = 30;
const PAGE_SIZE = 200;

/** Width of one kanban column. Tuned to fit a 2-line description + the
 *  amount + the badges on one card without truncation past ~24 chars. */
const COLUMN_WIDTH_PX = 224;

// ============================================================
// Confidence helpers
// ============================================================

type Confidence = "manual" | "rule" | "default" | "unset";

function confidenceOf(tx: Transaction): Confidence {
  const src = (tx.category_source ?? "unset") as string;
  if (src === "manual") return "manual";
  if (src === "rule") return "rule";
  if (src === "default") return "default";
  return "unset";
}

function confidenceBadge(c: Confidence): { label: string; cls: string } | null {
  if (c === "manual") return null;
  if (c === "rule") return { label: "rule", cls: "bg-brand/15 text-brand" };
  if (c === "default") return { label: "guess", cls: "bg-warn/15 text-warn" };
  return { label: "?", cls: "bg-outflow/15 text-outflow" };
}

function cardBorderClass(c: Confidence): string {
  if (c === "manual") return "border-border";
  if (c === "unset") return "border-warn/60 border-dashed";
  return "border-border border-dashed";
}

// ============================================================
// Main panel
// ============================================================

export default function CategorizePanel() {
  const qc = useQueryClient();
  const [lookbackDays, setLookbackDays] = useState<number>(DEFAULT_LOOKBACK_DAYS);
  const [filterMode, setFilterMode] = useState<"all" | "review">("review");
  const [expandedTxnId, setExpandedTxnId] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropTargetCatId, setDropTargetCatId] = useState<number | null>(null);

  const sinceISO = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - lookbackDays);
    return d.toISOString().slice(0, 10);
  }, [lookbackDays]);

  // -------- queries --------
  const txQ = useQuery({
    queryKey: ["categorize", "transactions", sinceISO],
    queryFn: () =>
      api.listTransactions({
        start_date: sinceISO,
        limit: PAGE_SIZE,
      }),
    staleTime: 30 * 1000,
  });
  const catQ = useQuery({
    queryKey: ["categorize", "categories"],
    queryFn: api.listCategories,
    staleTime: 5 * 60 * 1000,
  });
  // Q-3 — similarity-based suggestions for uncategorized rows. Keyed
  // independently so it refetches after each drag (a drag categorizes
  // a merchant, which adds votes to the index → better next guess).
  const suggestQ = useQuery({
    queryKey: ["categorize", "suggestions"],
    queryFn: api.categorySuggestions,
    staleTime: 60 * 1000,
  });

  // txn_id → suggestion lookup for O(1) access while rendering cards.
  const suggestionByTxnId = useMemo(() => {
    const m = new Map<number, CategorySuggestion>();
    for (const s of suggestQ.data?.suggestions ?? []) {
      m.set(s.txn_id, s);
    }
    return m;
  }, [suggestQ.data]);

  // Q-2 "machine learned" feedback — set after a drag creates a rule
  // that matched siblings. Shown as a dismissible banner, auto-cleared.
  const [learnedBanner, setLearnedBanner] = useState<string | null>(null);

  // -------- mutations --------
  //
  // Two flavors here:
  //   - recategorizeM: the DRAG action. Q-2 upgrade — instead of a plain
  //     recategorize, a drag now calls /rules/from-transaction, which
  //     ALSO creates a priority-230 merchant rule and cascades it over
  //     uncategorized rows. A drag is an explicit "this merchant belongs
  //     here" teaching signal, so it's worth a rule.
  //   - confirmM: click the badge or "Confirm all" on a column. Re-
  //     POSTs the SAME category_id so the backend bumps the row's
  //     category_source from rule/default to manual WITHOUT creating a
  //     new rule (the rule that placed it was already right).
  //
  // Both share onMutate/onSettled, just with different intent.
  const recategorizeM = useMutation({
    mutationFn: ({
      txnId,
      categoryId,
    }: {
      txnId: number;
      categoryId: number;
    }) =>
      api.createRuleFromTransaction({
        transaction_id: txnId,
        category_id: categoryId,
      }),
    onMutate: async ({ txnId, categoryId }) => {
      await qc.cancelQueries({ queryKey: ["categorize", "transactions"] });
      const key = ["categorize", "transactions", sinceISO];
      const prev = qc.getQueryData<Transaction[]>(key);
      if (prev) {
        qc.setQueryData<Transaction[]>(
          key,
          prev.map((t) =>
            t.id === txnId
              ? {
                  ...t,
                  category_id: categoryId,
                  category_source: "manual" as unknown as Transaction["category_source"],
                }
              : t,
          ),
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(["categorize", "transactions", sinceISO], ctx.prev);
      }
    },
    onSuccess: (result) => {
      // result.txns_now_matching includes the dragged txn itself; the
      // "learned" story is interesting only when it caught OTHERS too.
      const siblings = Math.max(0, result.txns_now_matching - 1);
      if (siblings > 0) {
        setLearnedBanner(
          `Learned "${result.pattern}" → ${result.category_slug}. ` +
            `${siblings} similar transaction${siblings === 1 ? "" : "s"} auto-placed.`,
        );
      } else {
        setLearnedBanner(
          `Learned "${result.pattern}" → ${result.category_slug}. ` +
            `Future charges from this merchant will land here automatically.`,
        );
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["categorize", "transactions"] });
      qc.invalidateQueries({ queryKey: ["categorize", "suggestions"] });
      qc.invalidateQueries({ queryKey: ["budgetRollup"] });
    },
  });

  // Auto-dismiss the learned banner after a few seconds.
  useEffect(() => {
    if (learnedBanner == null) return;
    const t = setTimeout(() => setLearnedBanner(null), 6000);
    return () => clearTimeout(t);
  }, [learnedBanner]);

  /** Confirm-in-place: keep the existing category, just promote
   *  category_source to manual so the badge goes away. Accepts a list
   *  of txn ids so the column-header "Confirm all" can fire N
   *  optimistic updates in one shot, then issue N parallel POSTs. */
  const confirmM = useMutation({
    mutationFn: async (
      pairs: Array<{ txnId: number; categoryId: number }>,
    ) => {
      // Fire in parallel. The backend recategorize endpoint accepts
      // the SAME category_id and still bumps the source to manual.
      await Promise.all(
        pairs.map((p) =>
          api.recategorizeTransaction(p.txnId, { category_id: p.categoryId }),
        ),
      );
    },
    onMutate: async (pairs) => {
      await qc.cancelQueries({ queryKey: ["categorize", "transactions"] });
      const key = ["categorize", "transactions", sinceISO];
      const prev = qc.getQueryData<Transaction[]>(key);
      const ids = new Set(pairs.map((p) => p.txnId));
      if (prev) {
        qc.setQueryData<Transaction[]>(
          key,
          prev.map((t) =>
            ids.has(t.id)
              ? {
                  ...t,
                  category_source: "manual" as unknown as Transaction["category_source"],
                }
              : t,
          ),
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) {
        qc.setQueryData(["categorize", "transactions", sinceISO], ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["categorize", "transactions"] });
      qc.invalidateQueries({ queryKey: ["categorize", "suggestions"] });
      qc.invalidateQueries({ queryKey: ["budgetRollup"] });
    },
  });

  // -------- ESC dismisses the expanded card --------
  useEffect(() => {
    if (expandedTxnId == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setExpandedTxnId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expandedTxnId]);

  // -------- which cards are visible based on filterMode --------
  const visibleTxns = useMemo(() => {
    const all = txQ.data ?? [];
    if (filterMode === "all") return all;
    return all.filter((t) => confidenceOf(t) !== "manual");
  }, [txQ.data, filterMode]);

  // -------- frozen column layout --------
  //
  // User feedback (2026-05-15): columns were being re-sorted by card
  // count on every render. When you confirmed cards in column X, X's
  // count dropped, X slid sideways, and you'd click the wrong column.
  // Fix: lock the column order + the set of which columns appear on
  // first data load. Don't recompute until the user changes filterMode
  // or lookbackDays — those are the only legitimate triggers for "show
  // me a fresh layout."
  //
  // Stored as ``(number | null)[]`` — the catId for each column in
  // left-to-right order. ``null`` is the Uncategorized pseudo-column.
  const [columnLayout, setColumnLayout] = useState<(number | null)[] | null>(
    null,
  );

  // Reset the layout whenever the user changes filter or lookback —
  // those are the explicit "I want a different view" signals.
  useEffect(() => {
    setColumnLayout(null);
  }, [filterMode, lookbackDays]);

  // First-pass: lock in the natural ranking once both queries land.
  useEffect(() => {
    if (columnLayout != null) return;
    if (!txQ.data || !catQ.data) return;

    // Use the CURRENT filter view for the initial sort, so the order
    // reflects what the user actually sees. After that, layout is
    // frozen — confirming cards doesn't move columns around.
    const all =
      filterMode === "all"
        ? txQ.data
        : txQ.data.filter((t) => confidenceOf(t) !== "manual");

    const counts = new Map<number | null, number>();
    for (const t of all) {
      const k = t.category_id ?? null;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }

    const layout: (number | null)[] = [];
    // Uncategorized first — only if it has any cards (review mode)
    // or always in all mode.
    if ((counts.get(null) ?? 0) > 0 || filterMode === "all") {
      layout.push(null);
    }
    // Categories sorted by count desc. In review mode skip empty
    // columns so the surface stays tractable; in all mode show every
    // category column (so it's available as a drop target).
    const ranked = catQ.data
      .map((c) => ({ id: c.id, count: counts.get(c.id) ?? 0 }))
      .sort((a, b) => b.count - a.count);
    for (const r of ranked) {
      if (filterMode === "review" && r.count === 0) continue;
      layout.push(r.id);
    }
    setColumnLayout(layout);
  }, [columnLayout, txQ.data, catQ.data, filterMode]);

  // -------- build the column descriptors from the frozen layout --------
  // Card groupings recompute on every render (so confirming a card
  // updates the card count + total), but the COLUMN ORDER and the
  // COLUMN SET are pinned by columnLayout.
  const columns = useMemo(() => {
    if (columnLayout == null) return [];

    const grouped = new Map<number | null, Transaction[]>();
    for (const t of visibleTxns) {
      const k = t.category_id ?? null;
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k)!.push(t);
    }
    // Sort cards within each column by descending magnitude (biggest
    // first) — that's almost always what the user wants to attend to.
    for (const arr of grouped.values()) {
      arr.sort((a, b) => Math.abs(b.amount_cents) - Math.abs(a.amount_cents));
    }

    const cats = catQ.data ?? [];
    return columnLayout.map((catId) => {
      const cat = catId == null ? null : cats.find((c) => c.id === catId);
      return {
        catId,
        label: cat ? cat.name : "Uncategorized",
        icon: cat ? (cat.icon ?? null) : "❓",
        cards: grouped.get(catId) ?? [],
      };
    });
  }, [columnLayout, visibleTxns, catQ.data]);

  const reviewCount = (txQ.data ?? []).filter(
    (t) => confidenceOf(t) !== "manual",
  ).length;
  const totalCount = txQ.data?.length ?? 0;

  // -------- drag handlers --------
  function handleDragStart(e: DragEvent<HTMLDivElement>, txnId: number) {
    setDraggingId(txnId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(txnId));
  }
  function handleDragEnd() {
    setDraggingId(null);
    setDropTargetCatId(null);
  }
  function handleColumnOver(
    e: DragEvent<HTMLDivElement>,
    catId: number | null,
  ) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTargetCatId(catId);
  }
  function handleColumnLeave() {
    setDropTargetCatId(null);
  }
  function handleColumnDrop(
    e: DragEvent<HTMLDivElement>,
    catId: number | null,
  ) {
    e.preventDefault();
    setDropTargetCatId(null);
    setDraggingId(null);
    if (catId == null) return; // can't recategorize INTO Uncategorized
    const txnIdStr = e.dataTransfer.getData("text/plain");
    const txnId = Number(txnIdStr);
    if (!Number.isFinite(txnId)) return;
    recategorizeM.mutate({ txnId, categoryId: catId });
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex-shrink-0">
        <h1 className="text-2xl font-bold text-text">Categorize</h1>
        <p className="text-sm text-text-soft mt-1 leading-relaxed">
          Each category is a column. Drag a card to a different column to
          move it. Cards with a dashed border are guesses — drop them
          where they belong to confirm.
        </p>
      </div>

      {/* filter strip */}
      <div className="flex flex-wrap items-center gap-3 text-xs flex-shrink-0">
        <div className="flex gap-1 bg-card border border-border rounded-md p-0.5 shadow-sm">
          {(["review", "all"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setFilterMode(mode)}
              className={`px-3 py-1 rounded transition-colors ${
                filterMode === mode
                  ? "bg-brand text-white font-semibold"
                  : "text-text-muted hover:text-text"
              }`}
            >
              {mode === "review"
                ? `Needs review · ${reviewCount}`
                : `All · ${totalCount}`}
            </button>
          ))}
        </div>
        <div className="flex gap-1 bg-card border border-border rounded-md p-0.5 shadow-sm">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setLookbackDays(d)}
              className={`px-3 py-1 rounded transition-colors ${
                lookbackDays === d
                  ? "bg-brand text-white font-semibold"
                  : "text-text-muted hover:text-text"
              }`}
            >
              Last {d}d
            </button>
          ))}
        </div>
        <span className="text-text-soft italic ml-auto">
          ← scroll horizontally to see more columns →
        </span>
      </div>

      {/* Q-2 "machine learned" banner — appears after a drag creates a
          merchant rule. Auto-dismisses; click ✕ to close early. */}
      {learnedBanner && (
        <div className="flex items-center gap-2 bg-inflow/10 border border-inflow/30 rounded-md px-3 py-2 text-xs text-text flex-shrink-0">
          <span className="text-inflow font-bold">🧠</span>
          <span className="flex-1">{learnedBanner}</span>
          <button
            onClick={() => setLearnedBanner(null)}
            className="text-text-muted hover:text-text"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* ----- The kanban itself ----- */}
      {txQ.isLoading ? (
        <div className="text-sm text-text-soft py-8 text-center">
          Loading transactions…
        </div>
      ) : columns.length === 0 ? (
        <div className="text-sm text-text-soft py-8 text-center">
          {filterMode === "review"
            ? "Inbox zero — everything in this window is confirmed. Switch to All to see all transactions."
            : "No transactions in this window."}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-3" style={{ scrollbarGutter: "stable" }}>
          {columns.map((col) => (
            <KanbanColumn
              key={col.catId ?? "uncat"}
              column={col}
              isDropActive={dropTargetCatId === col.catId}
              isReceivable={col.catId != null}
              onDragOver={(e) => handleColumnOver(e, col.catId)}
              onDragLeave={handleColumnLeave}
              onDrop={(e) => handleColumnDrop(e, col.catId)}
              onCardDragStart={handleDragStart}
              onCardDragEnd={handleDragEnd}
              onCardExpand={(id) => setExpandedTxnId(id)}
              onCardConfirm={(txnId, catId) =>
                confirmM.mutate([{ txnId, categoryId: catId }])
              }
              onConfirmAll={(pairs) => confirmM.mutate(pairs)}
              suggestionByTxnId={suggestionByTxnId}
              onAcceptSuggestion={(txnId, catId) =>
                // Accepting a suggestion is the same teaching signal as a
                // drag — recategorize + create the merchant rule.
                recategorizeM.mutate({ txnId, categoryId: catId })
              }
              draggingId={draggingId}
            />
          ))}
        </div>
      )}

      {/* ----- Expanded-card modal ----- */}
      {expandedTxnId != null && (
        <ExpandedCardModal
          txnId={expandedTxnId}
          txns={txQ.data ?? []}
          categories={catQ.data ?? []}
          onClose={() => setExpandedTxnId(null)}
        />
      )}
    </div>
  );
}

// ============================================================
// Kanban column
// ============================================================

interface KanbanColumnProps {
  column: {
    catId: number | null;
    label: string;
    icon: string | null;
    cards: Transaction[];
  };
  isDropActive: boolean;
  /** Whether this column can accept drops. The Uncategorized column
   *  cannot — there's no way to "uncategorize" a transaction; the
   *  user has to pick a real bucket. */
  isReceivable: boolean;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
  onCardDragStart: (e: DragEvent<HTMLDivElement>, txnId: number) => void;
  onCardDragEnd: () => void;
  onCardExpand: (txnId: number) => void;
  /** Click-badge-to-confirm: keep the card in place, promote source
   *  to manual. The badge will disappear after the optimistic update. */
  onCardConfirm: (txnId: number, categoryId: number) => void;
  /** "Confirm all RULE cards in this column" — sends the list of
   *  unconfirmed pairs as a batch. */
  onConfirmAll: (pairs: Array<{ txnId: number; categoryId: number }>) => void;
  /** Q-3 — txn_id → similarity suggestion, for uncategorized cards. */
  suggestionByTxnId: Map<number, CategorySuggestion>;
  /** Q-3 — accept a suggestion (recategorize + create rule). */
  onAcceptSuggestion: (txnId: number, categoryId: number) => void;
  draggingId: number | null;
}

function KanbanColumn({
  column,
  isDropActive,
  isReceivable,
  onDragOver,
  onDragLeave,
  onDrop,
  onCardDragStart,
  onCardDragEnd,
  onCardExpand,
  onCardConfirm,
  onConfirmAll,
  suggestionByTxnId,
  onAcceptSuggestion,
  draggingId,
}: KanbanColumnProps) {
  const totalCents = column.cards.reduce(
    (s, t) => s + Math.abs(t.amount_cents),
    0,
  );

  // "Confirm all" is offered only when this column has at least one
  // non-manual card AND the column accepts drops (not Uncategorized).
  // Uncategorized has no category to confirm INTO.
  const unconfirmedPairs: Array<{ txnId: number; categoryId: number }> =
    isReceivable && column.catId != null
      ? column.cards
          .filter((t) => confidenceOf(t) !== "manual")
          .map((t) => ({ txnId: t.id, categoryId: column.catId as number }))
      : [];

  return (
    <div
      className="flex-shrink-0 flex flex-col bg-hover/30 border border-border rounded-md overflow-hidden"
      style={{ width: COLUMN_WIDTH_PX }}
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-border bg-card flex items-center justify-between gap-2 flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {column.icon && (
            <span className="text-sm flex-shrink-0">{column.icon}</span>
          )}
          <span className="text-xs font-semibold text-text truncate">
            {column.label}
          </span>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-[10px] text-text-soft tabular-nums">
            {column.cards.length}
          </div>
          {totalCents > 0 && (
            <div className="text-[9px] text-text-muted tabular-nums">
              {fmtCents(totalCents)}
            </div>
          )}
        </div>
      </div>
      {/* "Confirm all N" button — only shown when there ARE unconfirmed
          cards in this column. Pressing it batch-promotes all of them. */}
      {unconfirmedPairs.length > 0 && (
        <button
          onClick={() => onConfirmAll(unconfirmedPairs)}
          className="text-[10px] font-semibold uppercase tracking-wider text-brand hover:bg-brand/10 border-b border-border py-1.5 transition-colors"
          title={`Mark all ${unconfirmedPairs.length} unconfirmed cards in this column as user-confirmed.`}
        >
          ✓ Confirm all {unconfirmedPairs.length}
        </button>
      )}
      {/* Drop area */}
      <div
        onDragOver={isReceivable ? onDragOver : undefined}
        onDragLeave={isReceivable ? onDragLeave : undefined}
        onDrop={isReceivable ? onDrop : undefined}
        className={`flex-1 overflow-y-auto p-1.5 space-y-1.5 transition-colors ${
          isDropActive && isReceivable
            ? "bg-brand/10 ring-2 ring-brand/40 ring-inset"
            : ""
        }`}
        style={{ minHeight: "200px", maxHeight: "calc(100vh - 260px)" }}
      >
        {column.cards.length === 0 && (
          <div className="text-[10px] text-text-soft italic text-center pt-4">
            {isReceivable
              ? "drop a card here"
              : "no uncategorized transactions"}
          </div>
        )}
        {column.cards.map((t) => (
          <TxnCard
            key={t.id}
            tx={t}
            isDragging={draggingId === t.id}
            onDragStart={(e) => onCardDragStart(e, t.id)}
            onDragEnd={onCardDragEnd}
            onExpand={() => onCardExpand(t.id)}
            onConfirm={
              t.category_id != null
                ? () => onCardConfirm(t.id, t.category_id as number)
                : undefined
            }
            suggestion={
              t.category_id == null ? suggestionByTxnId.get(t.id) : undefined
            }
            onAcceptSuggestion={onAcceptSuggestion}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Transaction card
// ============================================================

interface TxnCardProps {
  tx: Transaction;
  isDragging: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onExpand: () => void;
  /** Optional "confirm in place" handler. Bound only when the card
   *  already has a category (otherwise there's nothing to confirm —
   *  the user has to drag it somewhere first). */
  onConfirm?: () => void;
  /** Q-3 — similarity suggestion for an uncategorized card. */
  suggestion?: CategorySuggestion;
  /** Q-3 — accept the suggestion (recategorize + create rule). */
  onAcceptSuggestion?: (txnId: number, categoryId: number) => void;
}

function TxnCard({
  tx,
  isDragging,
  onDragStart,
  onDragEnd,
  onExpand,
  onConfirm,
  suggestion,
  onAcceptSuggestion,
}: TxnCardProps) {
  const confidence = confidenceOf(tx);
  const badge = confidenceBadge(confidence);
  const borderCls = cardBorderClass(confidence);
  const isOutflow = tx.amount_cents < 0;
  const desc = tx.description_clean || tx.description_raw || "(no description)";
  const dateLabel = new Date(tx.posted_date + "T00:00:00").toLocaleDateString(
    undefined,
    { month: "short", day: "numeric" },
  );

  // The badge is interactive iff the card is unconfirmed AND has a
  // category to confirm. Uncategorized "?" cards have no category, so
  // they stay non-clickable until the user drags them somewhere.
  const badgeIsClickable = badge != null && confidence !== "unset" && onConfirm != null;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onExpand}
      className={`bg-card border ${borderCls} rounded-md p-2 shadow-sm hover:shadow-md transition-all cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-30" : ""
      }`}
      role="button"
      tabIndex={0}
      aria-label={`Transaction: ${desc}, ${fmtCents(tx.amount_cents)}. Drag to a category column.`}
    >
      <div className="flex items-baseline justify-between gap-1 mb-1">
        <span
          className={`text-xs font-bold tabular-nums ${
            isOutflow ? "text-outflow" : "text-inflow"
          }`}
        >
          {isOutflow ? "" : "+"}
          {fmtCents(tx.amount_cents)}
        </span>
        {badge && (
          badgeIsClickable ? (
            <button
              onClick={(e) => {
                // Don't open the expand modal when clicking the badge.
                e.stopPropagation();
                onConfirm?.();
              }}
              className={`text-[8px] font-bold uppercase tracking-wider rounded px-1 py-0.5 transition-colors hover:bg-inflow hover:text-white cursor-pointer ${badge.cls}`}
              title={
                confidence === "rule"
                  ? "Auto-placed by a rule. Click to confirm placement (badge will disappear)."
                  : "Plaid's guess. Click to confirm, or drag the card to a different column."
              }
            >
              {badge.label} ✓
            </button>
          ) : (
            <span
              className={`text-[8px] font-bold uppercase tracking-wider rounded px-1 py-0.5 ${badge.cls}`}
              title="Uncategorized — drag this card to a bucket."
            >
              {badge.label}
            </span>
          )
        )}
      </div>
      <div
        className="text-[11px] text-text font-medium leading-snug line-clamp-2 break-words"
        title={desc}
      >
        {desc}
      </div>
      <div className="text-[9px] text-text-soft mt-1 tabular-nums">
        {dateLabel}
      </div>

      {/* Q-3 — similarity suggestion strip. Only on uncategorized cards
          that the backend could match to a merchant the user has filed
          before. One click accepts (recategorize + create rule). */}
      {suggestion && onAcceptSuggestion && (
        <button
          onClick={(e) => {
            e.stopPropagation(); // don't open the expand modal
            onAcceptSuggestion(tx.id, suggestion.category_id);
          }}
          className="mt-1.5 w-full flex items-center justify-between gap-1 rounded bg-brand/10 border border-brand/30 px-1.5 py-1 text-[9px] text-brand hover:bg-brand hover:text-white transition-colors group"
          title={
            `Suggested from ${suggestion.sample_count} past transaction` +
            `${suggestion.sample_count === 1 ? "" : "s"} at this merchant ` +
            `(${Math.round(suggestion.score * 100)}% went to ${suggestion.category_name}). ` +
            `Click to accept + teach a rule.`
          }
        >
          <span className="truncate font-semibold">
            → {suggestion.category_name}
          </span>
          <span className="flex-shrink-0 font-bold">accept ✓</span>
        </button>
      )}
    </div>
  );
}

// ============================================================
// Expanded card modal
// ============================================================

interface ExpandedCardModalProps {
  txnId: number;
  txns: Transaction[];
  categories: Category[];
  onClose: () => void;
}

function ExpandedCardModal({
  txnId,
  txns,
  categories,
  onClose,
}: ExpandedCardModalProps) {
  const tx = txns.find((t) => t.id === txnId);
  if (!tx) return null;
  const cat = categories.find((c) => c.id === tx.category_id) ?? null;
  const confidence = confidenceOf(tx);
  const badge = confidenceBadge(confidence);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-text/30"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="bg-card border border-border rounded-md shadow-2xl max-w-md w-full p-5"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex items-start justify-between gap-3 mb-3">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
                Transaction #{tx.id}
              </div>
              <h2 className="text-2xl font-bold tabular-nums mt-1">
                {tx.amount_cents < 0 ? "" : "+"}
                {fmtCents(tx.amount_cents)}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text"
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-text-muted">
                Description (cleaned)
              </dt>
              <dd className="text-text font-medium">
                {tx.description_clean || (
                  <span className="italic text-text-soft">(none)</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-text-muted">
                Raw bank description
              </dt>
              <dd className="font-mono text-[11px] text-text-muted break-all">
                {tx.description_raw || (
                  <span className="italic">(none)</span>
                )}
              </dd>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-text-muted">
                  Posted
                </dt>
                <dd className="text-text tabular-nums">
                  {new Date(tx.posted_date + "T00:00:00").toLocaleDateString()}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-text-muted">
                  Source
                </dt>
                <dd className="text-text capitalize">
                  {tx.source ?? "unknown"}
                </dd>
              </div>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-text-muted">
                Current category
              </dt>
              <dd className="flex items-center gap-2 text-text">
                <span>{cat?.name ?? "—"}</span>
                {badge && (
                  <span
                    className={`text-[9px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 ${badge.cls}`}
                  >
                    {badge.label}
                  </span>
                )}
              </dd>
            </div>
            {tx.memo && (
              <div>
                <dt className="text-[10px] uppercase tracking-wider text-text-muted">
                  Memo
                </dt>
                <dd className="text-text">{tx.memo}</dd>
              </div>
            )}
          </dl>

          <p className="text-[11px] text-text-soft mt-4 leading-relaxed">
            To recategorize, close this and drag the card to a different
            column.
          </p>
        </div>
      </div>
    </>
  );
}
