/**
 * AssignmentLedgerCard — Sprint L (2026-05-14).
 *
 * Zero-based budgeting view. Every dollar of recurring income gets a job:
 * committed bills, variable spending caps, savings goals, debt paydown.
 * The "unassigned" line shows what's left over (or what's over-committed).
 *
 * v1 is read-only: it surfaces the ledger so the user can SEE where every
 * dollar is going, identify drift, and decide what to change. Inline-edit
 * + rebalance suggestions are L-3 and L-4 follow-ups.
 *
 * Layout:
 *   - Income headline + horizontal allocation bar
 *   - 4 collapsible assignment groups (Committed / Variable / Savings / Debt)
 *   - 5th group (Unbudgeted) when caught-without-cap spend exists
 *   - "Total assigned" + "Unassigned" footer with color
 *   - "vs Actual" toggle to switch from planned-only to planned+actual+drift
 *   - 3-month history strip showing per-kind planned vs actual drift
 *
 * Note: this card sits BELOW the StatStrip and ABOVE the Net Worth
 * projected card on the Budgets panel.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type AssignmentGroup,
  type AssignmentItem as AssignmentItemT,
  type AssignmentKind,
  type AssignmentLedger,
  type MonthHistorySummary,
  type RebalanceSuggestion,
} from "../api/client";

// Color tokens per kind, used for the stacked bar + group accents.
// Tailwind classes — same palette as the existing budget viz so the
// user gets a consistent mental model.
const KIND_COLOR: Record<AssignmentKind, string> = {
  committed: "bg-blue-500",
  variable: "bg-amber-500",
  savings: "bg-emerald-500",
  debt: "bg-rose-500",
  unbudgeted_actual: "bg-slate-400",
};
const KIND_DOT_COLOR: Record<AssignmentKind, string> = {
  committed: "bg-blue-500",
  variable: "bg-amber-500",
  savings: "bg-emerald-500",
  debt: "bg-rose-500",
  unbudgeted_actual: "bg-slate-400",
};
const KIND_ICON: Record<AssignmentKind, string> = {
  committed: "🏠",
  variable: "🛍️",
  savings: "💰",
  debt: "💳",
  unbudgeted_actual: "❓",
};

interface Props {
  data: AssignmentLedger;
}

export default function AssignmentLedgerCard({ data }: Props) {
  // "Planned" view = just commitments. "Actual" view = adds the actual
  // columns and drift indicators so the user can see if they're holding
  // to their plan or breaking it.
  const [showActual, setShowActual] = useState(false);
  // L-4 — modal state. Opening this triggers a fetch of rebalance
  // suggestions for the current unassigned amount.
  const [rebalanceOpen, setRebalanceOpen] = useState(false);
  // M-4 — grouping axis toggle.
  //   "commitment" = group by Committed / Variable / Savings / Debt
  //                  (the YNAB-style axis; default).
  //   "category"   = group by Housing / Food / Transport / etc.
  //                  (super-category axis; same one the donut uses).
  // Savings goals + Debt paydown stay in their own dedicated groups
  // in EITHER view since they don't naturally fit the category tree.
  const [groupBy, setGroupBy] = useState<"commitment" | "category">("commitment");

  // The 4 (or 5) groups already arrive sorted by kind from the API.
  // Compute total income-vs-planned for the headline bar.
  const income = data.income_cents;
  const totalPlanned = data.total_planned_cents;
  const unassigned = data.unassigned_cents;

  // Sprint M-4: re-group committed + variable + unbudgeted items by
  // their parent_id (super-category) when groupBy === "category".
  // Savings + debt groups stay as-is — they don't fit the category
  // tree. The data shape stays identical (AssignmentGroup[]) so the
  // rest of the render code is unchanged.
  const effectiveGroups = useMemo<AssignmentGroup[]>(() => {
    if (groupBy !== "category") return data.groups;

    // Pull category-bearing items out, leave savings + debt + unbudgeted_actual
    // alone (those don't have parent_id in a meaningful way for this axis).
    const categoryItems: AssignmentLedger["groups"][0]["items"] = [];
    const passthrough: AssignmentGroup[] = [];
    for (const g of data.groups) {
      if (g.kind === "committed" || g.kind === "variable") {
        categoryItems.push(...g.items);
      } else {
        passthrough.push(g);
      }
    }

    // Bucket categoryItems by parent_id (or "Unparented" if missing).
    type Bucket = { label: string; items: typeof categoryItems };
    const buckets = new Map<string, Bucket>();
    for (const item of categoryItems) {
      const key = item.parent_id != null
        ? `p${item.parent_id}`
        : "unparented";
      const label = item.parent_name ?? "Other categories";
      const b = buckets.get(key);
      if (b) {
        b.items.push(item);
      } else {
        buckets.set(key, { label, items: [item] });
      }
    }

    // Convert buckets to AssignmentGroup shape. Use "committed" as the
    // group kind so the existing styling kicks in (icon + color);
    // future polish can introduce per-super-category icons.
    const categoryGroups: AssignmentGroup[] = Array.from(buckets.entries())
      .map(([key, b]) => ({
        kind: "committed" as AssignmentKind,
        label: b.label,
        planned_cents: b.items.reduce((s, i) => s + i.planned_cents, 0),
        actual_cents: b.items.reduce((s, i) => s + i.actual_cents, 0),
        items: b.items,
      }))
      .sort((a, b) => b.planned_cents - a.planned_cents);

    return [...categoryGroups, ...passthrough];
  }, [data.groups, groupBy]);

  // Bar segment widths — each kind's share of TOTAL INCOME (so the bar
  // visually shows what fraction of income is assigned where, and the
  // remaining sliver is "unassigned"). Width math clamps at 100%.
  const barSegments = useMemo(() => {
    if (income <= 0) return [];
    const segs: { kind: AssignmentKind; pct: number; cents: number }[] = [];
    for (const g of data.groups) {
      if (g.kind === "unbudgeted_actual") continue; // not part of plan
      if (g.planned_cents <= 0) continue;
      segs.push({
        kind: g.kind,
        pct: Math.min(100, (g.planned_cents / income) * 100),
        cents: g.planned_cents,
      });
    }
    return segs;
  }, [data.groups, income]);

  return (
    <div className="bg-card border border-border rounded-md shadow-card mb-6 p-5">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-1 gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-text">The plan</h3>
        <div className="flex items-baseline gap-3 flex-wrap">
          {/* M-4 — group-by toggle. Cycles between Commitment axis
              (Committed / Variable / Savings / Debt) and Category axis
              (Housing / Food / etc.). Same data, different cut. */}
          <div
            role="group"
            aria-label="Group ledger by"
            className="inline-flex rounded-md border border-border bg-hover/40 p-0.5 text-[10px]"
          >
            <button
              type="button"
              onClick={() => setGroupBy("commitment")}
              aria-pressed={groupBy === "commitment"}
              className={`px-2 py-0.5 rounded font-semibold uppercase tracking-wider ${
                groupBy === "commitment"
                  ? "bg-brand text-white shadow-sm"
                  : "text-text-muted hover:text-text"
              }`}
            >
              Commitment
            </button>
            <button
              type="button"
              onClick={() => setGroupBy("category")}
              aria-pressed={groupBy === "category"}
              className={`px-2 py-0.5 rounded font-semibold uppercase tracking-wider ${
                groupBy === "category"
                  ? "bg-brand text-white shadow-sm"
                  : "text-text-muted hover:text-text"
              }`}
            >
              Category
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowActual((v) => !v)}
            className="text-[11px] text-brand hover:underline focus:outline-none focus:underline"
            aria-pressed={showActual}
          >
            {showActual ? "Show planned only" : "Show vs actual →"}
          </button>
        </div>
      </div>
      <p className="text-[11px] text-text-soft mb-4">
        Every dollar of recurring income gets a job — drift over time
        shows your habits. Totals here are the caps you've{" "}
        <strong className="font-semibold">budgeted</strong>; the "Fixed
        monthly bills" card above is a different lens (what's{" "}
        <em>detected recurring</em> in your transactions), so the two
        won't match.
      </p>

      {/* Income headline + stacked allocation bar */}
      <div className="mb-5">
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
            Income (recurring)
          </span>
          <span className="text-xl font-bold tabular-nums text-text">
            {fmtCents(income)}
          </span>
        </div>
        <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden flex">
          {barSegments.map((s, i) => (
            <div
              key={s.kind + i}
              className={`h-full ${KIND_COLOR[s.kind]}`}
              style={{ width: `${s.pct}%` }}
              aria-label={`${s.kind}: ${fmtCents(s.cents)}`}
              title={`${s.kind}: ${fmtCents(s.cents)} (${s.pct.toFixed(0)}% of income)`}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[10px] text-text-muted">
          {barSegments.map((s) => (
            <span key={s.kind} className="inline-flex items-center gap-1">
              <span
                className={`inline-block w-2 h-2 rounded-sm ${KIND_DOT_COLOR[s.kind]}`}
              />
              <span className="capitalize">{s.kind}</span>
              <span className="tabular-nums">{fmtCents(s.cents)}</span>
            </span>
          ))}
          {unassigned !== 0 && (
            <button
              type="button"
              onClick={() => setRebalanceOpen(true)}
              className={`inline-flex items-center gap-1 font-semibold rounded px-1.5 py-0.5 hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-brand/40 ${
                unassigned > 0
                  ? "text-inflow hover:bg-emerald-50"
                  : "text-outflow hover:bg-red-50"
              }`}
              title="Get suggestions for what to do with this"
            >
              <span
                className={`inline-block w-2 h-2 rounded-sm border ${
                  unassigned > 0
                    ? "bg-inflow/50 border-inflow"
                    : "bg-outflow/50 border-outflow"
                }`}
              />
              {unassigned > 0 ? "unassigned" : "deficit"} {fmtCents(Math.abs(unassigned))}
              <span aria-hidden className="text-[10px] ml-0.5">→</span>
            </button>
          )}
        </div>
      </div>

      {/* Groups */}
      <div className="space-y-2 mb-4">
        {effectiveGroups.map((g, idx) => (
          <Group
            key={`${groupBy}-${g.kind}-${idx}-${g.label}`}
            group={g}
            showActual={showActual}
            monthStart={data.month_start}
          />
        ))}
      </div>

      {/* Footer — Total assigned + Unassigned */}
      <div className="border-t border-border pt-3 space-y-1">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-text-soft">Total assigned</span>
          <span className="font-semibold tabular-nums text-text">
            {fmtCents(totalPlanned)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setRebalanceOpen(true)}
          className={`w-full flex items-baseline justify-between text-base font-bold rounded px-2 py-1 -mx-2 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-brand/40 transition-colors ${
            unassigned >= 0
              ? "text-inflow hover:bg-emerald-50"
              : "text-outflow hover:bg-red-50"
          }`}
          aria-label={`${
            unassigned >= 0 ? "Unassigned" : "Deficit"
          } ${fmtCents(Math.abs(unassigned))}. Click for rebalance suggestions.`}
        >
          <span>
            {unassigned >= 0 ? "Unassigned" : "Over-committed"}
            <span aria-hidden className="text-[10px] font-normal ml-1.5 text-text-soft">
              click for suggestions →
            </span>
          </span>
          <span className="tabular-nums">
            {unassigned >= 0 ? "+" : "−"}
            {fmtCents(Math.abs(unassigned))}
          </span>
        </button>
        <UnassignedHint cents={unassigned} />
      </div>

      {/* History strip */}
      {data.history.length > 0 && (
        <HistoryStrip history={data.history} currentMonth={data.month_start} />
      )}

      {/* L-4 — rebalance suggestions modal */}
      {rebalanceOpen && (
        <RebalanceModal
          monthStart={data.month_start}
          unassignedCents={unassigned}
          onClose={() => setRebalanceOpen(false)}
        />
      )}
    </div>
  );
}

/* ============================================================== */
/*  RebalanceModal — L-4 suggestions UI                            */
/* ============================================================== */

interface RebalanceModalProps {
  monthStart: string;
  unassignedCents: number;
  onClose: () => void;
}

function RebalanceModal({
  monthStart,
  unassignedCents,
  onClose,
}: RebalanceModalProps) {
  const qc = useQueryClient();
  const suggestionsQ = useQuery({
    queryKey: ["rebalanceSuggestions", monthStart],
    queryFn: () => api.budgetRebalanceSuggestions(monthStart),
  });

  // Track which suggestion was just applied so we can show a check.
  const [appliedKind, setAppliedKind] = useState<string | null>(null);

  // Close on ESC.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const applyMutation = useMutation({
    mutationFn: async (suggestion: RebalanceSuggestion) => {
      if (!suggestion.apply) throw new Error("No apply action on suggestion");
      const a = suggestion.apply;
      if (a.kind === "noop") {
        // Nothing to mutate; just close.
        return;
      }
      if (a.kind === "patch_budgets_multi") {
        // Sequential PATCHes via upsertBudget (which is a POST that
        // upserts on category+month — the existing pattern).
        for (const p of a.budget_patches) {
          await api.upsertBudget({
            category_id: p.category_id,
            month_start: monthStart,
            amount_cents: p.new_cap_cents,
          });
        }
        return;
      }
      if (a.kind === "set_goal_funding_rate") {
        if (a.goal_id != null && a.goal_new_monthly_cents != null) {
          await api.goalSetFundingRate(a.goal_id, a.goal_new_monthly_cents);
        }
        return;
      }
      throw new Error(`Unknown apply kind: ${a.kind}`);
    },
    onSuccess: (_data, suggestion) => {
      setAppliedKind(suggestion.kind);
      // Invalidate everything the ledger depends on so the panel
      // recomputes with the new assignments.
      qc.invalidateQueries({ queryKey: ["assignmentLedger"] });
      qc.invalidateQueries({ queryKey: ["budgetRollup"] });
      qc.invalidateQueries({ queryKey: ["goals"] });
      qc.invalidateQueries({ queryKey: ["budgets"] });
      // Close after a brief "applied" confirmation.
      setTimeout(() => onClose(), 900);
    },
  });

  const isSurplus = unassignedCents > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Rebalance surplus or deficit"
    >
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-3 border-b border-border">
          <div>
            <h2 className="text-base font-bold text-text">
              {isSurplus
                ? `Give your ${fmtCents(unassignedCents)} surplus a job`
                : `You're over-committed by ${fmtCents(Math.abs(unassignedCents))}`}
            </h2>
            <p className="text-[11px] text-text-soft mt-0.5">
              {isSurplus
                ? "Unassigned money tends to leak into variable spend. Pick a strategy:"
                : "Pick a category to trim. Smart Recommendations also shows ranked options."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text text-lg leading-none px-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-3">
          {suggestionsQ.isLoading && (
            <div className="text-sm text-text-muted text-center py-8">
              Analyzing your data...
            </div>
          )}
          {suggestionsQ.isError && (
            <div className="text-sm text-outflow text-center py-8">
              Couldn't load suggestions. Try again in a moment.
            </div>
          )}
          {suggestionsQ.data?.suggestions.length === 0 && (
            <div className="text-sm text-text-muted text-center py-8">
              No suggestions right now — your ledger is balanced.
            </div>
          )}
          {suggestionsQ.data?.suggestions.map((s) => (
            <SuggestionCard
              key={s.kind + s.rank}
              suggestion={s}
              applied={appliedKind === s.kind}
              applying={applyMutation.isPending && appliedKind == null}
              onApply={() => applyMutation.mutate(s)}
            />
          ))}
          {applyMutation.isError && (
            <div className="text-xs text-outflow text-center mt-2">
              Apply failed. Try again or apply manually.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SuggestionCard({
  suggestion,
  applied,
  applying,
  onApply,
}: {
  suggestion: RebalanceSuggestion;
  applied: boolean;
  applying: boolean;
  onApply: () => void;
}) {
  const noop = suggestion.apply?.kind === "noop";
  return (
    <div
      className={`border rounded-md p-3 transition-colors ${
        applied
          ? "border-inflow bg-emerald-50"
          : "border-border hover:bg-hover"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-brand">
              #{suggestion.rank}
            </span>
            <h3 className="text-sm font-semibold text-text">
              {suggestion.title}
            </h3>
            {applied && (
              <span className="text-[10px] font-bold text-inflow">
                ✓ Applied
              </span>
            )}
          </div>
          <p className="text-[11px] text-text-soft leading-relaxed mb-2">
            {suggestion.description}
          </p>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-brand">
            {suggestion.impact_text}
          </div>
        </div>
        {suggestion.apply && (
          <button
            type="button"
            onClick={onApply}
            disabled={applied || applying}
            className={`text-xs font-semibold px-3 py-1.5 rounded shadow-sm flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
              noop
                ? "bg-card border border-border text-text hover:bg-hover"
                : "bg-brand text-white hover:bg-brand/90"
            }`}
          >
            {applied ? "Applied" : applying ? "..." : noop ? "Hold" : "Apply"}
          </button>
        )}
      </div>
    </div>
  );
}

/* ============================================================== */
/*  Group — one of the 4 (or 5) collapsible buckets                */
/* ============================================================== */

function Group({
  group,
  showActual,
  monthStart,
}: {
  group: AssignmentGroup;
  showActual: boolean;
  monthStart: string;
}) {
  const [open, setOpen] = useState(false);
  const planned = group.planned_cents;
  const actual = group.actual_cents;
  const isUnbudgeted = group.kind === "unbudgeted_actual";

  // Drift % vs planned — used for the chip color in "vs actual" mode.
  const driftPct = planned > 0 ? Math.round(((actual - planned) / planned) * 100) : 0;
  const driftCents = actual - planned;
  const overspent = !isUnbudgeted && driftCents > 0 && planned > 0;
  const underspent = !isUnbudgeted && driftCents < 0 && planned > 0;

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-hover focus:outline-none focus:bg-hover transition-colors text-left"
        aria-expanded={open}
      >
        <span aria-hidden className="text-base flex-shrink-0">
          {KIND_ICON[group.kind]}
        </span>
        <span
          className={`inline-block w-1 h-6 rounded-sm flex-shrink-0 ${
            KIND_COLOR[group.kind]
          }`}
          aria-hidden
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-text">{group.label}</div>
          <div className="text-[10px] text-text-muted">
            {group.items.length} {group.items.length === 1 ? "line" : "lines"}
          </div>
        </div>
        {showActual && !isUnbudgeted && (
          <div className="text-right text-[10px] flex-shrink-0">
            <div className="text-text-soft">
              Spent <span className="tabular-nums">{fmtCents(actual)}</span>
            </div>
            {overspent && (
              <div className="text-outflow font-semibold tabular-nums">
                +{fmtCents(driftCents)} ({driftPct >= 0 ? "+" : ""}
                {driftPct}%)
              </div>
            )}
            {underspent && (
              <div className="text-inflow font-semibold tabular-nums">
                −{fmtCents(Math.abs(driftCents))} under
              </div>
            )}
          </div>
        )}
        <div className="text-sm font-bold tabular-nums text-text flex-shrink-0 ml-2">
          {isUnbudgeted ? fmtCents(actual) : fmtCents(planned)}
        </div>
        <span
          className="text-text-muted text-xs flex-shrink-0 ml-1"
          aria-hidden
        >
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="border-t border-border bg-slate-50/50 divide-y divide-border">
          {group.items.length === 0 ? (
            <div className="px-3 py-2 text-xs text-text-muted italic">
              No items
            </div>
          ) : (
            group.items.map((item, idx) => (
              <ItemRow
                key={`${item.kind}-${item.label}-${idx}`}
                item={item}
                isUnbudgeted={isUnbudgeted}
                showActual={showActual}
                monthStart={monthStart}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================== */
/*  ItemRow — single ledger item with inline edit (L-3)             */
/* ============================================================== */

interface ItemRowProps {
  item: AssignmentItemT;
  isUnbudgeted: boolean;
  showActual: boolean;
  monthStart: string;
}

function ItemRow({ item, isUnbudgeted, showActual, monthStart }: ItemRowProps) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  // Input shows dollars (with cents). Backend uses cents.
  const [draftDollars, setDraftDollars] = useState(() =>
    (item.planned_cents / 100).toFixed(2),
  );

  // What kinds support inline edit:
  //   committed / variable / unbudgeted_actual → PATCH the Budget cap
  //   savings → POST set_funding_rate on the goal
  //   debt    → not editable for v1 (the Plan ledger debt row is an
  //             aggregate across a debt account, not a budget cap)
  const editable =
    !isUnbudgeted &&
    (item.category_id != null || (item.kind === "savings" && item.goal_id != null));

  const saveMutation = useMutation({
    mutationFn: async (newCents: number) => {
      if (newCents < 0) throw new Error("Amount can't be negative");
      if (item.category_id != null) {
        await api.upsertBudget({
          category_id: item.category_id,
          month_start: monthStart,
          amount_cents: newCents,
        });
        return;
      }
      if (item.kind === "savings" && item.goal_id != null) {
        await api.goalSetFundingRate(item.goal_id, newCents);
        return;
      }
      throw new Error("Row not editable");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assignmentLedger"] });
      qc.invalidateQueries({ queryKey: ["budgetRollup"] });
      qc.invalidateQueries({ queryKey: ["goals"] });
      qc.invalidateQueries({ queryKey: ["budgets"] });
      setEditing(false);
    },
  });

  function commit() {
    const parsed = Math.round(parseFloat(draftDollars) * 100);
    if (!Number.isFinite(parsed)) {
      setEditing(false);
      return;
    }
    if (parsed === item.planned_cents) {
      // No change → just exit edit mode quietly.
      setEditing(false);
      return;
    }
    saveMutation.mutate(parsed);
  }

  return (
    <div className="px-3 py-1.5 flex items-baseline justify-between gap-3">
      <div className="text-xs text-text truncate flex-1 min-w-0">
        {item.label}
        {item.is_paid && (
          <span
            className="ml-1.5 text-[9px] font-bold uppercase tracking-wider text-inflow"
            title="Likely already paid this month"
          >
            paid ✓
          </span>
        )}
      </div>
      <div className="text-right flex-shrink-0 flex items-baseline gap-2">
        {editing ? (
          <div className="flex items-baseline gap-1">
            <span className="text-xs text-text-muted">$</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={draftDollars}
              onChange={(e) => setDraftDollars(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraftDollars((item.planned_cents / 100).toFixed(2));
                  setEditing(false);
                }
              }}
              disabled={saveMutation.isPending}
              autoFocus
              className="w-20 text-xs font-semibold tabular-nums border border-brand/40 focus:border-brand bg-card rounded px-1 py-0.5 outline-none text-right"
              aria-label={`Edit ${item.label} planned amount`}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!editable) return;
              setDraftDollars((item.planned_cents / 100).toFixed(2));
              setEditing(true);
            }}
            disabled={!editable}
            title={
              editable
                ? "Click to edit"
                : "Edit via Category Budgets section below"
            }
            className={`text-xs font-semibold tabular-nums text-text ${
              editable
                ? "hover:bg-brand/10 hover:text-brand rounded px-1 focus:outline-none focus:ring-1 focus:ring-brand/40 cursor-pointer"
                : "cursor-default"
            }`}
          >
            {isUnbudgeted
              ? fmtCents(item.actual_cents)
              : fmtCents(item.planned_cents)}
            {editable && (
              <span aria-hidden className="ml-1 text-text-muted text-[10px]">
                ✎
              </span>
            )}
          </button>
        )}
        {showActual && !isUnbudgeted && (
          <div className="text-[10px] text-text-soft tabular-nums">
            spent {fmtCents(item.actual_cents)}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================== */
/*  UnassignedHint — short prose under the unassigned amount       */
/* ============================================================== */

function UnassignedHint({ cents }: { cents: number }) {
  if (cents > 50_00) {
    return (
      <p className="text-[11px] text-text-soft mt-1 leading-relaxed">
        💡 You have <span className="font-semibold text-inflow">{fmtCents(cents)}</span>{" "}
        of income with no job. Common moves: bump a savings goal, pay extra on a card,
        or raise an underfunded category. Anything not assigned tends to disappear into
        variable spending.
      </p>
    );
  }
  if (cents < -50_00) {
    return (
      <p className="text-[11px] text-outflow mt-1 leading-relaxed">
        ⚠️ You've committed <span className="font-semibold">{fmtCents(Math.abs(cents))}</span>{" "}
        more than you earn. Trim one of the variable categories above or push a
        savings goal's target date out.
      </p>
    );
  }
  return (
    <p className="text-[11px] text-text-muted mt-1">
      ✓ Every dollar has a job.
    </p>
  );
}

/* ============================================================== */
/*  HistoryStrip — 3-month drift visualization                     */
/* ============================================================== */

function HistoryStrip({
  history,
  currentMonth,
}: {
  history: MonthHistorySummary[];
  currentMonth: string;
}) {
  // History arrives newest → oldest from the API (months 1, 2, 3 ago).
  // Reverse so the strip reads left→right chronologically.
  const ordered = [...history].reverse();
  const kinds: AssignmentKind[] = ["committed", "variable", "savings", "debt"];

  return (
    <div className="mt-5 pt-4 border-t border-border">
      <div className="flex items-baseline justify-between mb-2">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
          3-month drift
        </h4>
        <span className="text-[10px] text-text-soft">
          Planned vs actual per kind
        </span>
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-text-muted text-[9px] uppercase tracking-wider">
            <th className="text-left font-normal pb-1"></th>
            {ordered.map((m) => (
              <th
                key={m.month_start}
                className="text-right font-normal pb-1 tabular-nums"
              >
                {formatMonthLabel(m.month_start)}
              </th>
            ))}
            <th className="text-right font-normal pb-1 pl-2">Pattern</th>
          </tr>
        </thead>
        <tbody>
          {kinds.map((k) => {
            const drifts = ordered.map((m) => {
              const v = m.by_kind[k];
              if (!v || v.planned === 0) return null;
              return v.actual - v.planned;
            });
            const pattern = summarizeDrifts(drifts);
            return (
              <tr key={k} className="border-t border-border/50">
                <td className="py-1.5 pr-2 text-text-soft capitalize">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={`inline-block w-1.5 h-1.5 rounded-sm ${KIND_DOT_COLOR[k]}`}
                      aria-hidden
                    />
                    {k}
                  </span>
                </td>
                {ordered.map((m, idx) => {
                  const v = m.by_kind[k];
                  if (!v) {
                    return (
                      <td
                        key={m.month_start}
                        className="text-right text-text-muted py-1.5 tabular-nums"
                      >
                        —
                      </td>
                    );
                  }
                  const drift = v.actual - v.planned;
                  let cls = "text-text-soft";
                  if (v.planned > 0 && drift > v.planned * 0.1)
                    cls = "text-outflow font-semibold";
                  if (v.planned > 0 && drift < -v.planned * 0.1)
                    cls = "text-inflow";
                  return (
                    <td
                      key={m.month_start}
                      className={`text-right py-1.5 tabular-nums ${cls}`}
                      title={`Planned ${fmtCents(v.planned)} · Actual ${fmtCents(v.actual)}`}
                    >
                      {fmtCents(v.actual)}
                    </td>
                  );
                })}
                <td className="text-right py-1.5 pl-2 text-text-muted">
                  {pattern}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[10px] text-text-muted mt-2">
        Current month: <span className="font-mono">{currentMonth}</span> (excluded from history)
      </p>
    </div>
  );
}

function formatMonthLabel(iso: string): string {
  // iso = "2026-04-01" → "Apr"
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short" });
}

function summarizeDrifts(drifts: (number | null)[]): string {
  const valid = drifts.filter((d): d is number => d !== null);
  if (valid.length === 0) return "—";
  const overCount = valid.filter((d) => d > 0).length;
  const underCount = valid.filter((d) => d < 0).length;
  if (overCount === valid.length) return "over every month";
  if (underCount === valid.length) return "under every month";
  if (overCount > underCount) return "trending over";
  if (underCount > overCount) return "trending under";
  return "varied";
}
