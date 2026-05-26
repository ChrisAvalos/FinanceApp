/**
 * Shopping patterns — Phase 10 Slice B.
 *
 * Two complementary views surfaced as tabs:
 *
 *   "Item-level patterns" — rows from the receipt-fed detector.
 *     Each row is "you buy Charmin every 6 weeks at Costco for $19.99".
 *     Empty until the user uploads a few receipts.
 *
 *   "Merchant rollup" — Plaid-fed monthly-spend snapshot per merchant.
 *     Empty until Plaid is connected. No DB writes; computed on demand.
 *
 * Both lean on the same insight: which of your spending is *predictable*
 * vs. ad-hoc? Predictable spend is a budgeting opportunity (e.g. "this is
 * your $180/mo Costco baseline; budget around it"); item-level
 * predictable is a deal-hunting opportunity (Slice D will scrape stores
 * for these specific items).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type MerchantRollupRow,
  type RecurringPurchase,
  type RecurringPurchaseStatus,
} from "./api/client";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelTableRow } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";
import PanelError from "./components/PanelError";

/* ------------------------------------------------------------------ */
/*  Status badge                                                        */
/* ------------------------------------------------------------------ */

function StatusBadge({ s }: { s: RecurringPurchaseStatus }) {
  const map: Record<RecurringPurchaseStatus, { label: string; cls: string }> = {
    active: { label: "Active", cls: "bg-emerald-50 text-inflow" },
    inactive: { label: "Stale", cls: "bg-amber-50 text-warn" },
    dismissed: { label: "Dismissed", cls: "bg-slate-100 text-text-soft" },
  };
  const m = map[s];
  return <span className={`px-1.5 py-0.5 rounded-sm ${m.cls} text-[10px] font-semibold uppercase tracking-wide`}>{m.label}</span>;
}

function ConfidencePill({ c }: { c: number }) {
  let cls = "bg-slate-100 text-text-muted";
  let label = "low";
  if (c >= 0.75) {
    cls = "bg-emerald-50 text-inflow";
    label = "high";
  } else if (c >= 0.5) {
    cls = "bg-sky-50 text-sky-700";
    label = "medium";
  }
  return (
    <span className={`px-1.5 py-0.5 rounded-sm ${cls} text-[10px] font-semibold uppercase tracking-wide`} title={`${Math.round(c * 100)}% confidence`}>
      {label}
    </span>
  );
}

function fmtRelDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const days = Math.round((Date.now() - d.getTime()) / (24 * 3600 * 1000));
  if (days < 0) return `in ${-days}d`;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

/* ------------------------------------------------------------------ */
/*  Pattern row (item-level)                                            */
/* ------------------------------------------------------------------ */

function PatternRow({
  r,
  onPatch,
  onDelete,
}: {
  r: RecurringPurchase;
  onPatch: (p: Partial<RecurringPurchase>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(r.canonical_name);

  return (
    <tr className="border-b border-border last:border-0 hover:bg-hover">
      <td className="px-3 py-2">
        <StatusBadge s={r.status} />
      </td>
      <td className="px-3 py-2">
        {editing ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (draftName.trim() && draftName !== r.canonical_name) {
                onPatch({ canonical_name: draftName.trim() });
              }
              setEditing(false);
            }}
          >
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              className="px-2 py-1 text-sm border border-border rounded w-full"
            />
            <button type="submit" className="text-xs text-brand font-semibold">Save</button>
          </form>
        ) : (
          <button onClick={() => setEditing(true)} className="text-left w-full">
            <div className="text-sm font-semibold text-text">{r.canonical_name}</div>
            {r.name_locked && <span className="text-[10px] text-text-soft">(renamed)</span>}
          </button>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-text-muted">
        {r.primary_merchant || "—"}
      </td>
      <td className="px-3 py-2 text-xs text-text-muted">
        {r.category || "—"}
      </td>
      <td className="px-3 py-2 text-xs">
        <div className="text-text">{r.cadence_label || (r.cadence_days ? `every ${r.cadence_days}d` : "—")}</div>
        <div className="text-text-soft">{r.occurrence_count}x logged</div>
      </td>
      <td className="px-3 py-2 text-right text-sm tabular-nums">
        {r.typical_line_total_cents != null ? fmtCents(r.typical_line_total_cents) : "—"}
      </td>
      <td className="px-3 py-2 text-right text-sm tabular-nums font-semibold text-warn">
        {r.annualized_cost_cents != null ? fmtCents(r.annualized_cost_cents) : "—"}
      </td>
      <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">
        {fmtRelDate(r.last_purchased_at)}
        {r.next_expected_at && (
          <div className="text-text-soft">next ~{fmtRelDate(r.next_expected_at)}</div>
        )}
      </td>
      <td className="px-3 py-2">
        <ConfidencePill c={r.confidence_score} />
      </td>
      <td className="px-3 py-2 text-right">
        {r.status !== "dismissed" && (
          <button onClick={() => onPatch({ status: "dismissed" })} className="text-[11px] text-text-muted hover:text-outflow">
            Dismiss
          </button>
        )}
        {r.status === "dismissed" && (
          <button onClick={() => onPatch({ status: "active" })} className="text-[11px] text-brand hover:underline">
            Restore
          </button>
        )}
        <button onClick={() => { if (confirm(`Delete "${r.canonical_name}"?`)) onDelete(); }} className="ml-2 text-[11px] text-text-muted hover:text-outflow">
          Del
        </button>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/*  Merchant rollup row                                                 */
/* ------------------------------------------------------------------ */

function MerchantRow({ r }: { r: MerchantRollupRow }) {
  return (
    <tr className="border-b border-border last:border-0 hover:bg-hover">
      <td className="px-3 py-2">
        <div className="text-sm font-semibold text-text">{r.display_name}</div>
        <div className="text-[11px] text-text-soft font-mono">{r.merchant_key}</div>
      </td>
      <td className="px-3 py-2 text-xs text-text-muted">{r.primary_category_name || "—"}</td>
      <td className="px-3 py-2 text-right text-sm tabular-nums font-semibold text-warn">
        {fmtCents(r.monthly_avg_cents)}
      </td>
      <td className="px-3 py-2 text-right text-sm tabular-nums">
        {fmtCents(r.median_per_visit_cents)}
      </td>
      <td className="px-3 py-2 text-right text-sm tabular-nums">
        {r.transaction_count}
      </td>
      <td className="px-3 py-2 text-xs text-text-muted">
        {r.cadence_days ? `every ${r.cadence_days}d` : "—"}
      </td>
      <td className="px-3 py-2 text-xs text-text-muted">
        {fmtRelDate(r.last_seen)}
      </td>
      <td className="px-3 py-2 text-right text-sm tabular-nums">
        {fmtCents(r.total_lifetime_cents)}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */

type TabKey = "items" | "merchants";

export default function ShoppingPatternsPanel() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("items");
  const [showDismissed, setShowDismissed] = useState(false);

  const patterns = useQuery({ queryKey: ["recurringPurchases"], queryFn: () => api.listRecurringPurchases() });
  const rollup = useQuery({ queryKey: ["merchantRollup"], queryFn: () => api.merchantRollup(365) });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["recurringPurchases"] });
  const detect = useMutation({
    mutationFn: api.detectRecurringPurchases,
    onSuccess: invalidate,
  });
  const patch = useMutation({
    mutationFn: ({ id, p }: { id: number; p: Partial<RecurringPurchase> }) =>
      api.patchRecurringPurchase(id, p),
    onSuccess: invalidate,
  });
  const destroy = useMutation({
    mutationFn: api.deleteRecurringPurchase,
    onSuccess: invalidate,
  });

  const visiblePatterns = useMemo(() => {
    const all = patterns.data ?? [];
    return showDismissed ? all : all.filter((p) => p.status !== "dismissed");
  }, [patterns.data, showDismissed]);

  const totalAnnualized = useMemo(
    () => visiblePatterns
      .filter((p) => p.status === "active")
      .reduce((s, p) => s + (p.annualized_cost_cents ?? 0), 0),
    [visiblePatterns],
  );

  const totalMonthly = useMemo(
    () => (rollup.data ?? []).reduce((s, r) => s + r.monthly_avg_cents, 0),
    [rollup.data],
  );

  const heroLoading = patterns.isLoading || rollup.isLoading;
  const activePatternCount = patterns.data?.filter((p) => p.status === "active").length ?? 0;

  if (patterns.isError) {
    return <PanelError title="Couldn't load shopping patterns." error={patterns.error} onRetry={() => patterns.refetch()} />;
  }

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip
          syncedAt={patterns.dataUpdatedAt > 0 ? new Date(patterns.dataUpdatedAt).toISOString() : null}
          label="Last fetched"
        />
      </div>
      {heroLoading ? (
        <SkelHeroRow count={4} />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Recurring items</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
              <CountUp value={activePatternCount} format={(n) => String(Math.round(n))} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">From receipt history</div>
          </div>
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Annualized item spend</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-warn">
              <CountUp value={totalAnnualized} format={fmtCents} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">Sum across active patterns</div>
          </div>
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Tracked merchants</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
              <CountUp value={rollup.data?.length ?? 0} format={(n) => String(Math.round(n))} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">From Plaid history (last 12mo)</div>
          </div>
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            {/* Renamed during D-2 cleanup. Was "Combined avg/month" which
                read like "your monthly spend on shopping" — but the
                value is the SUM of per-merchant 30-day-normalized
                averages, and a merchant's "average" can be inflated by
                rare big transactions, so the total runs ~3-5× higher
                than real monthly outflow (which is what Trends reports).
                Renaming makes the math honest; for an actual monthly
                outflow figure, look at Trends or Cash flow. */}
            <div className="text-xs text-text-muted uppercase tracking-wide">Sum of merchant rates</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-warn">
              <CountUp value={totalMonthly} format={fmtCents} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">
              Σ per-merchant 30d avg — relative ranking, not a real monthly spend
            </div>
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-md shadow-card mb-3">
        <div className="flex items-center justify-between border-b border-border">
          <div className="flex">
            <TabBtn active={tab === "items"} onClick={() => setTab("items")} label="Item-level patterns" count={patterns.data?.filter((p) => p.status === "active").length ?? 0} />
            <TabBtn active={tab === "merchants"} onClick={() => setTab("merchants")} label="Merchant rollup" count={rollup.data?.length ?? 0} />
          </div>
          <div className="flex items-center gap-2 px-3 py-2">
            {tab === "items" && (
              <>
                <label className="flex items-center gap-1.5 text-xs text-text-muted">
                  <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />
                  <span>Show dismissed</span>
                </label>
                <button
                  onClick={() => detect.mutate()}
                  disabled={detect.isPending}
                  className="px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-brand hover:text-brand disabled:opacity-50"
                  title="Re-run the receipt-item detector + persist patterns"
                >
                  {detect.isPending ? "Detecting…" : "Detect now"}
                </button>
              </>
            )}
          </div>
        </div>

        {tab === "items" && (
          <ItemsTable
            patterns={visiblePatterns}
            isLoading={patterns.isLoading}
            onPatch={(id, p) => patch.mutate({ id, p })}
            onDelete={(id) => destroy.mutate(id)}
          />
        )}
        {tab === "merchants" && (
          <MerchantsTable rows={rollup.data ?? []} isLoading={rollup.isLoading} />
        )}
      </div>

      <p className="text-[11px] text-text-soft">
        Item-level patterns come from receipts you've uploaded. Merchant rollup comes from your Plaid
        transaction history. Both feed Slice D — store-specific deal scrapers will watch the items + merchants
        you actually buy from for price drops.
      </p>
    </div>
  );
}

function TabBtn({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap transition-colors ${
        active ? "text-brand border-b-2 border-brand -mb-px" : "text-text-muted border-b-2 border-transparent hover:text-text"
      }`}
    >
      {label}
      <span className={`ml-1.5 inline-block px-1.5 py-0.5 rounded-full text-[10px] tabular-nums ${active ? "bg-brand text-white" : "bg-hover text-text-muted"}`}>
        {count}
      </span>
    </button>
  );
}

function ItemsTable({
  patterns,
  isLoading,
  onPatch,
  onDelete,
}: {
  patterns: RecurringPurchase[];
  isLoading: boolean;
  onPatch: (id: number, p: Partial<RecurringPurchase>) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-hover border-b border-border">
          <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-left">Item</th>
            <th className="px-3 py-2 text-left">Merchant</th>
            <th className="px-3 py-2 text-left">Category</th>
            <th className="px-3 py-2 text-left">Cadence</th>
            <th className="px-3 py-2 text-right">Per trip</th>
            <th className="px-3 py-2 text-right">Annual</th>
            <th className="px-3 py-2 text-left">Last / Next</th>
            <th className="px-3 py-2 text-left">Conf.</th>
            <th className="px-3 py-2 text-right"></th>
          </tr>
        </thead>
        <tbody>
          {isLoading && Array.from({ length: 5 }).map((_, i) => <SkelTableRow key={i} cols={10} />)}
          {patterns.length === 0 && !isLoading && (
            <tr><td colSpan={10} className="p-8 text-center text-sm text-text-muted max-w-md mx-auto">
              No recurring purchases detected yet. Upload ≥ 3 receipts
              with the same items spanning ~45 days, then hit{" "}
              <span className="font-mono">Detect now</span>. The
              detector groups items by canonical product across receipts
              and only surfaces ones it sees you buy on a cadence.
            </td></tr>
          )}
          {patterns.map((p) => (
            <PatternRow key={p.id} r={p} onPatch={(patch) => onPatch(p.id, patch)} onDelete={() => onDelete(p.id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MerchantsTable({ rows, isLoading }: { rows: MerchantRollupRow[]; isLoading: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-hover border-b border-border">
          <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
            <th className="px-3 py-2 text-left">Merchant</th>
            <th className="px-3 py-2 text-left">Category</th>
            <th className="px-3 py-2 text-right">$/mo avg</th>
            <th className="px-3 py-2 text-right">Med/visit</th>
            <th className="px-3 py-2 text-right">Visits</th>
            <th className="px-3 py-2 text-left">Cadence</th>
            <th className="px-3 py-2 text-left">Last</th>
            <th className="px-3 py-2 text-right">Lifetime</th>
          </tr>
        </thead>
        <tbody>
          {isLoading && Array.from({ length: 5 }).map((_, i) => <SkelTableRow key={i} cols={8} />)}
          {rows.length === 0 && !isLoading && (
            <tr><td colSpan={8} className="p-8 text-center text-sm text-text-muted max-w-md mx-auto">
              No merchants tracked. Connect Plaid + sync transactions
              first — the rollup needs ≥ 3 visits per merchant within
              the last year to qualify, so a merchant only appears
              once you have a real pattern there.
            </td></tr>
          )}
          {rows.map((r) => <MerchantRow key={r.merchant_key} r={r} />)}
        </tbody>
      </table>
    </div>
  );
}
