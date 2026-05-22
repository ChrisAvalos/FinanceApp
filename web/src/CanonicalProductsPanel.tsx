/**
 * Canonical products panel — Phase 10 Slice E.
 *
 * Three sections:
 *   1. Stats + "Run canonicalizer" button (idempotent batch process).
 *   2. Search + filterable list of canonical products (one card each).
 *   3. Detail view (slides over) showing every linked ReceiptItem +
 *      RecurringPurchase across every merchant.
 *
 * Plus a "Merge two canonicals" workflow when the user spots over-
 * fragmentation — pick two cards, hit merge, drop_id's links re-point
 * to keep_id, drop is deleted.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type CanonicalProduct,
  type CanonicalProductDetail,
} from "./api/client";
import { SkelStat } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";
import DeleteWithConfirm from "./components/DeleteWithConfirm";

/* ------------------------------------------------------------------ */
/*  Card (list view)                                                    */
/* ------------------------------------------------------------------ */

function CanonicalCard({
  c,
  selected,
  onOpen,
  onSelect,
}: {
  c: CanonicalProduct;
  selected: boolean;
  onOpen: () => void;
  onSelect: () => void;
}) {
  const sizeStr = c.size_value != null && c.size_unit
    ? ` · ${c.size_value} ${c.size_unit}${c.form ? ` (${c.form})` : ""}`
    : c.form ? ` · ${c.form}` : "";
  return (
    <div
      className={`border rounded-md p-3 bg-card hover:shadow-card-hover cursor-pointer transition-shadow ${
        selected ? "border-brand ring-2 ring-brand/30" : "border-border"
      }`}
      onClick={onOpen}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {c.brand && (
              <span className="px-1.5 py-0.5 rounded-sm bg-slate-100 text-text-muted text-[10px] font-semibold uppercase tracking-wide">
                {c.brand}
              </span>
            )}
            <h4 className="text-sm font-semibold text-text">{c.name}</h4>
            {c.name_locked && <span className="text-[10px] text-text-soft">(renamed)</span>}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {c.category || "uncategorized"}{sizeStr}
            {c.primary_upc && <span className="ml-1 font-mono text-text-soft">UPC {c.primary_upc}</span>}
          </div>
          <div className="text-[11px] text-text-soft mt-1">
            {c.receipt_item_count} item{c.receipt_item_count === 1 ? "" : "s"} ·
            {c.recurring_pattern_count} pattern{c.recurring_pattern_count === 1 ? "" : "s"} ·
            {c.observation_count} observation{c.observation_count === 1 ? "" : "s"}
            {c.merchants.length > 0 && ` · ${c.merchants.slice(0, 3).join(" / ")}${c.merchants.length > 3 ? "…" : ""}`}
          </div>
        </div>
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          onClick={(e) => e.stopPropagation()}
          className="mt-1 shrink-0"
          title="Select for merge"
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Detail view                                                         */
/* ------------------------------------------------------------------ */

function DetailView({
  detail,
  onClose,
  onRename,
  onDelete,
}: {
  detail: CanonicalProductDetail;
  onClose: () => void;
  onRename: (newName: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(detail.name);

  return (
    <div className="bg-card border border-border rounded-md shadow-card p-5 mb-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          {editing ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (draftName.trim() && draftName !== detail.name) {
                  onRename(draftName.trim());
                }
                setEditing(false);
              }}
            >
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="flex-1 px-2 py-1 text-sm border border-border rounded"
              />
              <button type="submit" className="text-xs font-semibold text-brand">Save</button>
              <button type="button" onClick={() => setEditing(false)} className="text-xs text-text-muted">Cancel</button>
            </form>
          ) : (
            <div>
              <h3 className="text-base font-semibold text-text">
                {detail.name}
                {detail.name_locked && <span className="text-[11px] text-text-soft ml-2">(renamed)</span>}
                <button onClick={() => setEditing(true)} className="ml-2 text-xs text-brand hover:underline">
                  Rename
                </button>
              </h3>
              <div className="text-xs text-text-muted mt-0.5">
                {detail.brand && <span className="font-semibold">{detail.brand}</span>}
                {detail.category && ` · ${detail.category}`}
                {detail.size_value != null && detail.size_unit && ` · ${detail.size_value} ${detail.size_unit}`}
                {detail.form && ` · ${detail.form}`}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Sprint 38 — two-click confirm replaces window.confirm. */}
          <DeleteWithConfirm
            label={`Delete "${detail.name}"?`}
            onConfirm={onDelete}
          />
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-text-muted hover:text-text">
            Close
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-xs">
        <div>
          <div className="text-text-muted uppercase tracking-wide">Receipt items</div>
          <div className="text-lg font-semibold tabular-nums">{detail.receipt_item_count}</div>
        </div>
        <div>
          <div className="text-text-muted uppercase tracking-wide">Patterns</div>
          <div className="text-lg font-semibold tabular-nums">{detail.recurring_pattern_count}</div>
        </div>
        <div>
          <div className="text-text-muted uppercase tracking-wide">Observations</div>
          <div className="text-lg font-semibold tabular-nums">{detail.observation_count}</div>
        </div>
        <div>
          <div className="text-text-muted uppercase tracking-wide">Merchants</div>
          <div className="text-lg font-semibold tabular-nums">{detail.merchants.length}</div>
        </div>
      </div>

      {detail.linked_patterns.length > 0 && (
        <div className="mb-4">
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
            Recurring patterns
          </h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {detail.linked_patterns.map((p) => (
              <div key={p.id} className="border border-border rounded p-2 text-xs">
                <div className="font-semibold text-text">{p.canonical_name}</div>
                <div className="text-text-muted mt-0.5">
                  {p.primary_merchant || "—"} ·
                  {p.cadence_days ? ` every ${p.cadence_days}d` : " no cadence"} ·
                  {p.occurrence_count}x ·
                  {p.typical_line_total_cents != null && ` typical ${fmtCents(p.typical_line_total_cents)}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
        Linked receipt items ({detail.linked_items.length})
      </h4>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[10px] font-semibold uppercase tracking-wide">
              <th className="px-3 py-1.5 text-left">Date</th>
              <th className="px-3 py-1.5 text-left">Merchant</th>
              <th className="px-3 py-1.5 text-left">Item</th>
              <th className="px-3 py-1.5 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {detail.linked_items.length === 0 && (
              <tr>
                <td colSpan={4} className="p-4 text-center text-xs text-text-muted">
                  No receipt items linked yet.
                </td>
              </tr>
            )}
            {detail.linked_items.map((it) => (
              <tr key={it.receipt_item_id} className="border-b border-border last:border-0 hover:bg-hover">
                <td className="px-3 py-1.5 text-xs text-text-muted whitespace-nowrap">
                  {it.purchase_date || "—"}
                </td>
                <td className="px-3 py-1.5 text-xs">{it.merchant || "—"}</td>
                <td className="px-3 py-1.5 text-xs">{it.name || it.raw_line}</td>
                <td className="px-3 py-1.5 text-right text-xs tabular-nums font-semibold">
                  {it.line_total_cents != null ? fmtCents(it.line_total_cents) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */

export default function CanonicalProductsPanel() {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [lastRun, setLastRun] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["canonicalProducts", query],
    queryFn: () => api.listCanonicalProducts(query.trim() ? { q: query.trim() } : {}),
  });
  const detail = useQuery({
    queryKey: ["canonicalProduct", openId],
    queryFn: () => (openId ? api.getCanonicalProduct(openId) : null),
    enabled: openId != null,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["canonicalProducts"] });
    qc.invalidateQueries({ queryKey: ["canonicalProduct"] });
  };
  const runCanonicalize = useMutation({
    mutationFn: api.runCanonicalize,
    onSuccess: (r) => {
      invalidate();
      setLastRun(
        `Linked ${r.items_linked}/${r.items_processed} items, ` +
        `${r.patterns_linked}/${r.patterns_processed} patterns, ` +
        `created ${r.canonicals_created} new canonical product${r.canonicals_created === 1 ? "" : "s"}.`,
      );
    },
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.patchCanonicalProduct(id, { name }),
    onSuccess: invalidate,
  });
  const destroy = useMutation({
    mutationFn: api.deleteCanonicalProduct,
    onSuccess: () => { invalidate(); setOpenId(null); },
  });
  const merge = useMutation({
    mutationFn: ({ keepId, dropId }: { keepId: number; dropId: number }) =>
      api.mergeCanonicalProducts(keepId, dropId),
    onSuccess: () => {
      invalidate();
      setSelectedIds(new Set());
    },
  });

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalLinked = useMemo(
    () => (list.data ?? []).reduce((s, c) => s + c.receipt_item_count, 0),
    [list.data],
  );

  const selectedArray = Array.from(selectedIds);
  const canMerge = selectedArray.length === 2;

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip
          syncedAt={list.dataUpdatedAt > 0 ? new Date(list.dataUpdatedAt).toISOString() : null}
          label="Last fetched"
        />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Canonical products</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">{list.data?.length ?? 0}</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Receipt items linked</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">{totalLinked}</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Brands tracked</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
            {new Set((list.data ?? []).map((c) => c.brand).filter(Boolean)).size}
          </div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Coming next</div>
          <div className="text-sm font-semibold mt-1 text-text">Cross-store deals</div>
          <div className="text-[11px] text-text-soft mt-0.5">via the Deals panel</div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-md shadow-card mb-4 p-4 flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, brand, or normalized key…"
          className="flex-1 min-w-[200px] px-3 py-2 border border-border rounded text-sm"
        />
        <button
          onClick={() => runCanonicalize.mutate()}
          disabled={runCanonicalize.isPending}
          className="px-3 py-2 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy disabled:opacity-50"
          title="Walk every unmatched receipt item + recurring pattern, find or create a canonical, persist the link"
        >
          {runCanonicalize.isPending ? "Running…" : "Run canonicalizer"}
        </button>
        {canMerge && (
          // Sprint 38 — two-click confirm. First click highlights the
          // button red ("Click again to merge"); second click commits.
          // Replaces a window.confirm() that asked the user to keep
          // straight which selection is "kept" vs "dropped" — the
          // tooltip below makes that explicit.
          <DeleteWithConfirm
            label="Merge — the second selected canonical is absorbed into the first"
            restingText={`Merge ${selectedArray.length} selected`}
            confirmingText="Click again to merge"
            onConfirm={() => {
              const [a, b] = selectedArray;
              merge.mutate({ keepId: a, dropId: b });
            }}
            className="px-3 py-2 text-xs font-semibold rounded border border-warn text-warn hover:bg-warn hover:text-white"
          />
        )}
        {selectedArray.length > 0 && !canMerge && (
          <span className="text-[11px] text-text-soft">
            Select 2 to merge ({selectedArray.length} selected)
          </span>
        )}
      </div>

      {lastRun && (
        <div className="mb-4 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded text-xs text-inflow">
          {lastRun}
        </div>
      )}

      {openId && detail.data && (
        <DetailView
          detail={detail.data}
          onClose={() => setOpenId(null)}
          onRename={(name) => rename.mutate({ id: detail.data!.id, name })}
          onDelete={() => destroy.mutate(detail.data!.id)}
        />
      )}

      {list.isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <SkelStat />
          <SkelStat />
          <SkelStat />
          <SkelStat />
        </div>
      )}
      {list.data?.length === 0 && (
        <div className="bg-card border border-border rounded-md p-6 text-center text-sm text-text-muted max-w-xl mx-auto">
          No canonical products yet. Upload receipts first (Receipts
          panel), then click <span className="font-mono">Run canonicalizer</span> —
          every receipt item gets matched to a canonical identity
          automatically. The canonicalizer is conservative; it groups
          variants of the same product across merchants but won't
          merge ambiguous matches.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {list.data?.map((c) => (
          <CanonicalCard
            key={c.id}
            c={c}
            selected={selectedIds.has(c.id)}
            onOpen={() => setOpenId(c.id)}
            onSelect={() => toggleSelect(c.id)}
          />
        ))}
      </div>

      <p className="mt-4 text-[11px] text-text-soft">
        The canonicalizer is conservative — it would rather create two redundant canonical products
        than wrongly merge two different ones. If you spot over-fragmentation, select two cards and
        hit "Merge". The "merge" link re-points every receipt item + pattern from the dropped row to
        the kept one, so historical data stays consistent.
      </p>
    </div>
  );
}
