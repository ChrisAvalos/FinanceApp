/**
 * Net-worth tracker panel — Phase 7.1.
 *
 * Top-of-page metric every personal-finance app surfaces, with a few
 * twists: per-account-type breakdown (so the user can see *where*
 * their net worth lives), a 30d/1y delta, and a sparkline pulled
 * from NetWorthSnapshot rows. Snapshots fire daily via the scheduler
 * — the "Take snapshot" button is the manual override after a balance
 * update.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, type Account, type NetWorthHistoryPoint } from "./api/client";
import CountUp from "./components/CountUp";
import SyncFreshnessChip from "./components/SyncFreshness";
import PanelError from "./components/PanelError";

/** "Chase · Sapphire Reserve" → returns the friendly composite label. */
function accountLabel(a: Account): string {
  return a.institution_name ? `${a.institution_name} · ${a.name}` : a.name;
}

/** Grouping helper — splits accounts into asset vs liability piles so
 * the "Accounts" card can show two clean lists instead of one mixed
 * stream. ``current_balance_cents`` sign is the source of truth: + for
 * assets, − for liabilities. Accounts with no balance yet bucket into
 * assets by default and surface as "—" in the UI. */
type AcctBucket = { label: "Assets" | "Liabilities"; accounts: Account[]; total: number };
function bucketAccounts(accounts: Account[]): AcctBucket[] {
  const assets: Account[] = [];
  const liabilities: Account[] = [];
  let assetSum = 0;
  let liabSum = 0;
  for (const a of accounts) {
    // Wave 5 verification fix (2026-05-14): when an account is flipped
    // inactive (e.g. closed/empty Stock Plan post Sprint D-fix), skip it
    // entirely so it doesn't render as a zombie "$0 · Synced 6h ago" row.
    // Inactive accounts stay visible in Connections for full transparency.
    if (a.is_active === false) continue;
    const cents = a.current_balance_cents ?? 0;
    const isLiability =
      a.account_type === "credit_card" ||
      a.account_type === "loan" ||
      a.account_type === "mortgage" ||
      cents < 0;
    if (isLiability) {
      liabilities.push(a);
      liabSum += cents;
    } else {
      assets.push(a);
      assetSum += cents;
    }
  }
  // Sort each bucket by abs(balance) desc so the biggest entries show first.
  const byAbs = (a: Account, b: Account) =>
    Math.abs(b.current_balance_cents ?? 0) - Math.abs(a.current_balance_cents ?? 0);
  assets.sort(byAbs);
  liabilities.sort(byAbs);
  return [
    { label: "Assets", accounts: assets, total: assetSum },
    { label: "Liabilities", accounts: liabilities, total: liabSum },
  ];
}

function Sparkline({ series }: { series: NetWorthHistoryPoint[] }) {
  // Below 3 points the chart is just a line between two dots — visually
  // indistinguishable from a bug. Show a calmer placeholder until we have
  // enough history for the trend to mean anything.
  if (series.length < 3) {
    const n = series.length;
    return (
      <div className="text-center py-10 px-4">
        <div className="text-3xl mb-2">📈</div>
        <div className="text-sm font-semibold text-text">
          {n === 0 ? "No snapshots yet" : `${n} snapshot${n === 1 ? "" : "s"} so far`}
        </div>
        <div className="text-xs text-text-muted mt-1 max-w-md mx-auto">
          The scheduler captures one snapshot per day. After about a week the chart
          becomes meaningful — until then, hit <span className="font-mono">Take snapshot</span>{" "}
          above to seed history manually.
        </div>
      </div>
    );
  }
  const min = Math.min(...series.map((p) => p.net_cents));
  const max = Math.max(...series.map((p) => p.net_cents));
  const range = max - min || 1;
  const w = 600;
  const h = 120;
  const points = series.map((p, i) => {
    const x = (i / (series.length - 1)) * w;
    const y = h - ((p.net_cents - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${h} ${points.join(" ")} ${w},${h}`;
  const line = points.join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-32">
      <polygon points={area} fill="rgba(37, 99, 235, 0.08)" />
      <polyline points={line} fill="none" stroke="#2563eb" strokeWidth="2" />
      <circle
        cx={(series.length - 1) / (series.length - 1) * w}
        cy={h - ((series[series.length - 1].net_cents - min) / range) * h}
        r="3"
        fill="#2563eb"
      />
    </svg>
  );
}

function DeltaPill({ cents, label }: { cents: number | null; label: string }) {
  if (cents == null) {
    return (
      <div className="text-xs text-text-soft">
        <div className="uppercase tracking-wide">{label}</div>
        <div className="text-text-muted">Need history</div>
      </div>
    );
  }
  const tone = cents >= 0 ? "text-inflow" : "text-outflow";
  return (
    <div className="text-xs">
      <div className="text-text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${tone}`}>
        {cents >= 0 ? "+" : ""}{fmtCents(cents)}
      </div>
    </div>
  );
}

export default function NetWorthPanel() {
  const qc = useQueryClient();
  const [days, setDays] = useState(365);
  const summary = useQuery({ queryKey: ["netWorth"], queryFn: api.netWorth });
  const history = useQuery({
    queryKey: ["netWorthHistory", days],
    queryFn: () => api.netWorthHistory(days),
  });
  // Per-account list — the "where exactly is my money?" view Chris asked
  // for. Loaded alongside the rollup so it stays in sync with the hero.
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
  const snapshot = useMutation({
    mutationFn: api.netWorthSnapshot,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["netWorth"] });
      qc.invalidateQueries({ queryKey: ["netWorthHistory"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  const breakdown = useMemo(() => {
    const rows = summary.data?.breakdown ?? [];
    return rows.slice().sort((a, b) => Math.abs(b.total_cents) - Math.abs(a.total_cents));
  }, [summary.data]);

  const accountBuckets = useMemo(
    () => bucketAccounts(accounts.data ?? []),
    [accounts.data],
  );

  if (summary.isError) {
    return <PanelError title="Couldn't load Net Worth." error={summary.error} onRetry={() => summary.refetch()} />;
  }

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
        <div className="bg-card border border-border rounded-md p-5 shadow-card md:col-span-1">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-text-muted uppercase tracking-wide">Net worth</div>
            {/* Use the most recent snapshot's as_of as the freshness anchor.
                If no snapshots have been taken yet, the chip falls through to
                its "Never synced" neutral state on its own. */}
            <SyncFreshnessChip
              syncedAt={summary.data?.as_of ?? null}
              label="Snapshot"
              compact
            />
          </div>
          <div className="text-3xl font-semibold tabular-nums mt-2 text-text">
            {/* Sprint 29 — pass nullable value so CountUp snaps to the
                first real number instead of animating 0 → real
                (which previously displayed nonsense intermediate $$$). */}
            <CountUp value={summary.data?.net_cents} format={fmtCents} />
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <DeltaPill cents={history.data?.delta_30d_cents ?? null} label="Δ 30d" />
            <DeltaPill cents={history.data?.delta_1y_cents ?? null} label="Δ 1y" />
          </div>
        </div>
        <div className="bg-card border border-border rounded-md p-5 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Assets</div>
          <div className="text-2xl font-semibold tabular-nums mt-2 text-inflow">
            <CountUp value={summary.data?.assets_cents} format={fmtCents} />
          </div>
          <div className="text-[11px] text-text-soft mt-0.5">
            {summary.data?.accounts_with_no_balance ? `${summary.data.accounts_with_no_balance} accounts missing balance` : "All accounts reporting"}
          </div>
        </div>
        <div className="bg-card border border-border rounded-md p-5 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Liabilities</div>
          <div className="text-2xl font-semibold tabular-nums mt-2 text-outflow">
            <CountUp
              value={
                summary.data?.liabilities_cents != null
                  ? -summary.data.liabilities_cents
                  : undefined
              }
              format={fmtCents}
            />
          </div>
        </div>
      </div>

      {/* ---- Per-account list — "where is my money?" view ---- */}
      {(accounts.data?.length ?? 0) > 0 && (
        <div className="bg-card border border-border rounded-md shadow-card mb-5 overflow-hidden">
          <div className="px-4 py-2 border-b border-border bg-slate-50 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text">Accounts</h3>
            <span className="text-[11px] text-text-muted">
              {accounts.data?.length ?? 0} linked
            </span>
          </div>
          <div className="divide-y divide-border">
            {accountBuckets.map((bucket) =>
              bucket.accounts.length === 0 ? null : (
                <div key={bucket.label}>
                  <div className="px-4 py-2 bg-hover flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                      {bucket.label}
                    </span>
                    <span
                      className={`text-xs font-semibold tabular-nums ${
                        bucket.label === "Assets" ? "text-inflow" : "text-outflow"
                      }`}
                    >
                      {bucket.label === "Liabilities"
                        ? `−${fmtCents(Math.abs(bucket.total))}`
                        : fmtCents(bucket.total)}
                    </span>
                  </div>
                  {bucket.accounts.map((a) => {
                    const cents = a.current_balance_cents;
                    const hasBalance = cents != null;
                    const tone =
                      bucket.label === "Liabilities" ? "text-outflow" : "text-text";
                    return (
                      <div
                        key={a.id}
                        className="px-4 py-2.5 flex items-center justify-between hover:bg-hover"
                      >
                        <div className="min-w-0 pr-3">
                          <div className="text-sm font-medium truncate">
                            {accountLabel(a)}
                            {a.mask ? (
                              <span className="text-text-soft font-mono ml-2 text-[11px]">
                                ····{a.mask}
                              </span>
                            ) : null}
                          </div>
                          <div className="text-[11px] text-text-muted capitalize flex items-center gap-2 flex-wrap">
                            <span>
                              {a.account_type.replace("_", " ")}
                              {a.credit_limit_cents
                                ? ` · limit ${fmtCents(a.credit_limit_cents)}`
                                : ""}
                            </span>
                            {/* Wave 5 fix F: freshness chip per account */}
                            {a.last_synced_at ? (
                              <SyncFreshnessChip
                                syncedAt={a.last_synced_at}
                                compact
                              />
                            ) : null}
                          </div>
                        </div>
                        <div className={`text-sm font-semibold tabular-nums ${tone}`}>
                          {hasBalance
                            ? bucket.label === "Liabilities"
                              ? `−${fmtCents(Math.abs(cents!))}`
                              : fmtCents(cents!)
                            : <span className="text-text-soft font-normal">—</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ),
            )}
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-md shadow-card mb-5 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text">Net worth over time</h3>
          <div className="flex items-center gap-2">
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="px-2 py-1 text-xs border border-border rounded bg-card"
            >
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
              <option value={1825}>5 years</option>
            </select>
            <button
              onClick={() => snapshot.mutate()}
              disabled={snapshot.isPending}
              className="px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-brand hover:text-brand disabled:opacity-50"
            >
              {snapshot.isPending ? "Saving…" : "Take snapshot"}
            </button>
          </div>
        </div>
        <Sparkline series={history.data?.series ?? []} />
        <div className="text-[11px] text-text-soft mt-2">
          {history.data?.earliest && history.data?.latest
            ? `${history.data.series.length} snapshots between ${history.data.earliest} and ${history.data.latest}`
            : "Snapshot scheduler runs daily — chart populates as snapshots accumulate."}
        </div>
      </div>

      {breakdown.length > 0 && (
        <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
          <div className="px-4 py-2 border-b border-border bg-slate-50">
            <h3 className="text-sm font-semibold text-text">Breakdown by account type</h3>
          </div>
          <table className="w-full">
            <thead className="bg-hover border-b border-border">
              <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
                <th className="px-4 py-2 text-left">Type</th>
                <th className="px-4 py-2 text-left">Kind</th>
                <th className="px-4 py-2 text-right">Accounts</th>
                <th className="px-4 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((b, i) => (
                <tr key={i} className="border-b border-border last:border-0 hover:bg-hover">
                  <td className="px-4 py-2 text-sm">{b.account_type}</td>
                  <td className="px-4 py-2 text-xs text-text-muted">{b.kind}</td>
                  <td className="px-4 py-2 text-right text-sm tabular-nums">{b.accounts}</td>
                  <td className={`px-4 py-2 text-right text-sm font-semibold tabular-nums ${b.kind === "asset" ? "text-inflow" : "text-outflow"}`}>
                    {fmtCents(b.kind === "asset" ? b.total_cents : -b.total_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
