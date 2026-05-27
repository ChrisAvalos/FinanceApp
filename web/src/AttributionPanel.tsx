/**
 * Net-worth attribution — Smart Feature #4.
 *
 * For each month in the last N, decomposes the change in net worth
 * into income, spending, and "other" (market gains/losses, interest
 * accrued, debt interest charged, manual balance adjustments).
 *
 * The shape of the answer is one row per month with a horizontal
 * bar chart showing the components, plus an expandable drill-in
 * surfacing the top spending categories that drove the outflow side.
 *
 * Months without NW snapshots at both endpoints render with a muted
 * "incomplete" label — cash flow is still computable from
 * transactions, but we can't separate market gains from the residual
 * without a starting balance.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents, type AttributionMonth } from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
import PanelError from "./components/PanelError";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtSignedCents(c: number): string {
  if (c === 0) return "$0";
  return `${c > 0 ? "+" : "−"}${fmtCents(Math.abs(c))}`;
}

/** Compact dollar string for the bar-segment labels. Skips decimals. */
function fmtCompact(cents: number): string {
  const dollars = Math.round(cents / 100);
  if (Math.abs(dollars) >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (Math.abs(dollars) >= 1_000) return `$${(dollars / 1000).toFixed(dollars >= 10_000 ? 0 : 1)}K`;
  return `$${dollars}`;
}

/* ------------------------------------------------------------------ */
/*  Per-month row with bar chart                                       */
/* ------------------------------------------------------------------ */

function MonthRow({
  month,
  maxAbs,
  expanded,
  onToggle,
}: {
  month: AttributionMonth;
  maxAbs: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  // Bar widths as % of the row's available width (split into two halves
  // around a centered zero — left for spending, right for income).
  const halfWidth = 50; // each half gets 50% of the available bar lane
  const incomePct = maxAbs > 0 ? (month.income_cents / maxAbs) * halfWidth : 0;
  const spendingPct = maxAbs > 0 ? (month.spending_cents / maxAbs) * halfWidth : 0;
  const otherPct =
    maxAbs > 0 && month.other_cents != null
      ? (Math.abs(month.other_cents) / maxAbs) * halfWidth
      : 0;
  const otherIsPositive = (month.other_cents ?? 0) >= 0;

  const isIncomplete = month.delta_cents === null;

  return (
    <div className={`border-b border-border last:border-0 ${expanded ? "bg-hover" : ""}`}>
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 hover:bg-hover transition-colors"
      >
        <div className="flex items-center gap-4">
          {/* Month label */}
          <div className="w-20 shrink-0">
            <div className="text-sm font-semibold text-text">
              {month.month_label}
            </div>
            <div className="text-[10px] text-text-soft">
              {expanded ? "▾" : "▸"} drill in
            </div>
          </div>

          {/* Bar lane — fixed width container with center axis */}
          <div className="flex-1 min-w-0 relative h-7">
            {/* Center axis */}
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border" />

            {/* Spending bar — extends left from center */}
            {month.spending_cents > 0 && (
              <div
                className="absolute right-1/2 top-1 bottom-1 bg-red-200 rounded-l flex items-center justify-end pr-1"
                style={{ width: `${spendingPct}%` }}
                title={`Spending: ${fmtCents(month.spending_cents)}`}
              >
                {spendingPct > 8 && (
                  // Sprint 50 — text-outflow on bg-red-200 was 4.23:1
                  // (fails AA for 10px). Tailwind's red-900 (#7f1d1d) gives
                  // 7.6:1 on the same bg without losing the red semantic.
                  <span className="text-[10px] text-red-900 font-semibold tabular-nums">
                    {fmtCompact(month.spending_cents)}
                  </span>
                )}
              </div>
            )}

            {/* Income bar — extends right from center */}
            {month.income_cents > 0 && (
              <div
                className="absolute left-1/2 top-1 bottom-1 bg-emerald-200 rounded-r flex items-center justify-start pl-1"
                style={{ width: `${incomePct}%` }}
                title={`Income: ${fmtCents(month.income_cents)}`}
              >
                {incomePct > 8 && (
                  // Sprint 50 — text-inflow on bg-emerald-200 was 4.49:1
                  // (just under AA). emerald-900 (#064e3b) hits 7.4:1
                  // and reads as the same green semantic.
                  <span className="text-[10px] text-emerald-900 font-semibold tabular-nums">
                    {fmtCompact(month.income_cents)}
                  </span>
                )}
              </div>
            )}

            {/* "Other" overlay — small dot/marker beyond the income bar
                showing market gains/losses. Right side if positive,
                left side if negative. */}
            {otherPct > 0 && month.other_cents != null && (
              <div
                className={`absolute top-1.5 bottom-1.5 rounded ${
                  otherIsPositive ? "bg-violet-300" : "bg-amber-300"
                }`}
                style={{
                  ...(otherIsPositive
                    ? { left: `calc(50% + ${incomePct}%)` }
                    : { right: `calc(50% + ${spendingPct}%)` }),
                  width: `${otherPct}%`,
                }}
                title={`Other (market/interest): ${fmtSignedCents(
                  month.other_cents,
                )}`}
              />
            )}
          </div>

          {/* Stats column */}
          <div className="w-36 shrink-0 text-right">
            {isIncomplete ? (
              <>
                <div className="text-[11px] text-text-soft italic">
                  no snapshot
                </div>
                <div className="text-xs text-text-muted tabular-nums">
                  cash flow: {fmtSignedCents(month.net_cash_flow_cents)}
                </div>
              </>
            ) : (
              <>
                <div
                  className={`text-sm font-semibold tabular-nums ${
                    (month.delta_cents ?? 0) >= 0 ? "text-inflow" : "text-outflow"
                  }`}
                >
                  Δ {fmtSignedCents(month.delta_cents ?? 0)}
                </div>
                <div className="text-[10px] text-text-soft tabular-nums leading-tight">
                  cash {fmtSignedCents(month.net_cash_flow_cents)}
                  {month.debt_paydown_cents !== 0 && (
                    <>
                      {" · debt "}
                      <span className="text-violet-700">
                        {fmtSignedCents(month.debt_paydown_cents)}
                      </span>
                    </>
                  )}
                  <br />
                  other {fmtSignedCents(month.other_cents ?? 0)}
                </div>
              </>
            )}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 pl-24">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-xs text-text-muted">
            <div>
              <span className="text-text-soft">Income:</span>{" "}
              <span className="text-inflow tabular-nums">
                +{fmtCents(month.income_cents)}
              </span>
            </div>
            <div>
              <span className="text-text-soft">Spending:</span>{" "}
              <span className="text-outflow tabular-nums">
                −{fmtCents(month.spending_cents)}
              </span>
              <span className="text-text-soft text-[10px] ml-1">
                (excl. transfers)
              </span>
            </div>
            {month.debt_paydown_cents !== 0 && (
              <div className="md:col-span-2">
                <span className="text-text-soft">
                  Debt paydown (transfer rows, net):
                </span>{" "}
                <span
                  className={`tabular-nums ${
                    month.debt_paydown_cents > 0
                      ? "text-violet-700"
                      : "text-warn"
                  }`}
                >
                  {fmtSignedCents(month.debt_paydown_cents)}
                </span>
                <div className="text-[10px] text-text-soft mt-0.5">
                  Positive = net debt reduction. When this is non-zero, one side
                  of a transfer (e.g., the credit-card account) isn't linked.
                </div>
              </div>
            )}
            {month.nw_start_cents != null && (
              <div>
                <span className="text-text-soft">NW at month start:</span>{" "}
                <span className="tabular-nums">
                  {fmtCents(month.nw_start_cents)}
                </span>
              </div>
            )}
            {month.nw_end_cents != null && (
              <div>
                <span className="text-text-soft">NW at month end:</span>{" "}
                <span className="tabular-nums">
                  {fmtCents(month.nw_end_cents)}
                </span>
              </div>
            )}
            {month.other_cents != null && (
              <div className="md:col-span-2">
                <span className="text-text-soft">
                  Other (market gains, interest, manual adjustments):
                </span>{" "}
                <span
                  className={`tabular-nums ${
                    month.other_cents >= 0 ? "text-violet-700" : "text-warn"
                  }`}
                >
                  {fmtSignedCents(month.other_cents)}
                </span>
              </div>
            )}
          </div>

          {month.top_spending_categories.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wide text-text-soft mb-1">
                Top spending categories
              </div>
              <div className="space-y-0.5">
                {month.top_spending_categories.map((c) => (
                  <div
                    key={c.name}
                    className="flex justify-between text-xs text-text"
                  >
                    <span>
                      {c.name}{" "}
                      <span className="text-text-soft">({c.txn_count})</span>
                    </span>
                    <span className="text-outflow tabular-nums">
                      {fmtCents(c.cents)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */

export default function AttributionPanel() {
  const [months, setMonths] = useState(12);
  const [expanded, setExpanded] = useState<string | null>(null);

  const report = useQuery({
    queryKey: ["netWorthAttribution", months],
    queryFn: () => api.netWorthAttribution(months),
    staleTime: 5 * 60 * 1000,
  });

  // Compute the max-absolute value across all rows so bar widths are
  // comparable across the full range. Use the larger of income, spending,
  // or |other| in any month to anchor the scale.
  const maxAbs = useMemo(() => {
    if (!report.data) return 1;
    let m = 0;
    for (const row of report.data.months) {
      m = Math.max(
        m,
        row.income_cents,
        row.spending_cents,
        Math.abs(row.other_cents ?? 0),
      );
    }
    return m || 1;
  }, [report.data]);

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip syncedAt={report.data?.generated_at ?? null} label="Attribution computed" />
      </div>
      {/* Hero / summary */}
      <div className="bg-card border border-border rounded-md shadow-card p-5 mb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="text-xs text-text-muted uppercase tracking-wide font-semibold">
              Why did net worth change?
            </div>
            <div className="text-base text-text mt-2 leading-snug">
              {report.data?.summary_text || "Loading attribution…"}
            </div>
          </div>
          <select
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            className="px-2 py-1 text-xs border border-border rounded bg-card shrink-0"
          >
            <option value={6}>Last 6 months</option>
            <option value={12}>Last 12 months</option>
            <option value={24}>Last 24 months</option>
            <option value={36}>Last 36 months</option>
          </select>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-4 mt-4 text-[11px] text-text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 bg-emerald-200 rounded-sm" />
            Income
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 bg-red-200 rounded-sm" />
            Spending
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 bg-violet-300 rounded-sm" />
            Market gains / other (positive)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-3 h-3 bg-amber-300 rounded-sm" />
            Market losses / interest charged
          </span>
        </div>
      </div>

      {/* Per-month list */}
      <div
        className="bg-card border border-border rounded-md shadow-card overflow-hidden"
        role="img"
        aria-label="Attribution: monthly net-worth delta breakdown"
      >
        {report.isLoading ? (
          <div className="p-12 text-center text-text-muted text-sm">
            Computing attribution…
          </div>
        ) : report.isError ? (
          <div className="p-6">
            <PanelError title="Couldn't load Attribution." error={report.error} onRetry={() => report.refetch()} compact />
          </div>
        ) : report.data && report.data.months.length === 0 ? (
          <div className="p-12 text-center text-text-muted text-sm">
            No data yet.
          </div>
        ) : (
          // Reverse so newest is on top. Filter out months that are fully
          // empty (no snapshot AND zero cash flow AND no top categories) —
          // they clutter the list with rows that say literally nothing.
          // Surface a footer count so users know they were collapsed.
          (() => {
            const all = [...(report.data?.months ?? [])].reverse();
            const empty = all.filter(
              (m) =>
                m.delta_cents == null &&
                m.net_cash_flow_cents === 0 &&
                (m.top_spending_categories?.length ?? 0) === 0,
            );
            const visible = all.filter(
              (m) =>
                !(
                  m.delta_cents == null &&
                  m.net_cash_flow_cents === 0 &&
                  (m.top_spending_categories?.length ?? 0) === 0
                ),
            );
            return (
              <>
                {visible.map((m) => (
                  <MonthRow
                    key={m.month_start}
                    month={m}
                    maxAbs={maxAbs}
                    expanded={expanded === m.month_start}
                    onToggle={() =>
                      setExpanded((prev) =>
                        prev === m.month_start ? null : m.month_start,
                      )
                    }
                  />
                ))}
                {empty.length > 0 && (
                  <div className="px-4 py-2.5 text-[11px] text-text-soft border-t border-border bg-hover/40">
                    {empty.length} earlier month{empty.length === 1 ? "" : "s"} hidden — no activity recorded.
                  </div>
                )}
              </>
            );
          })()
        )}
      </div>

      <div className="text-[11px] text-text-soft mt-3">
        "Other" is the residual after cash flow — market gains, interest accrued,
        debt interest charged, or manual balance adjustments. Months without snapshot
        data at both endpoints show cash flow only.
      </div>
    </div>
  );
}
