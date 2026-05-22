/**
 * TopSpendingCard — Sprint H-4b.
 *
 * A pinned summary card showing the top 5 categories by actual outflow
 * this month, with a small bar visualization. The "look at what you
 * spent" answer at a glance — sits between the projection chart and
 * the BudgetVisualization block.
 *
 * Why "top 5" and not "top 10" or "all"
 * -------------------------------------
 * In Chris's data the top 5 categories account for >60% of monthly
 * spend. Five is the magic number for "I can scan this in one read"
 * and matches how the Trends panel surfaces top movers. The full
 * breakdown stays accessible via the visualization views below.
 *
 * Click handling
 * --------------
 * Each row is a button — clicking opens the same CategoryDrawer the
 * visualization views use. Click handler is passed in by the parent
 * (BudgetsPanel) which owns the drawer state.
 */
import { useMemo } from "react";
import {
  fmtCents,
  type BudgetRollupRow,
} from "../api/client";
import { paletteColor } from "./DonutChart";
import MoMChip from "./MoMChip";

export interface TopSpendingCardProps {
  rows: BudgetRollupRow[];
  unbudgeted: BudgetRollupRow[];
  totalSpent: number;
  /** {cat_id: [this_month_cents, three_mo_avg_cents]} for the MoM chip. */
  momCompare?: Record<string, [number, number]>;
  /** Click row → open drawer. Optional. */
  onCategoryClick?: (params: {
    category_id: number;
    name: string;
    color: string;
    spent_cents: number;
    budget_cents: number;
  }) => void;
}

export default function TopSpendingCard({
  rows,
  unbudgeted,
  totalSpent,
  momCompare,
  onCategoryClick,
}: TopSpendingCardProps) {
  // Build the combined list and rank by spent desc. Same color
  // assignment as the donut so visuals stay consistent.
  const top5 = useMemo(() => {
    const combined = new Map<
      number,
      { name: string; spent: number; budget: number }
    >();
    for (const r of rows) {
      combined.set(r.category_id, {
        name: r.category_name,
        spent: r.actual_outflow_cents,
        budget: r.budget_cents,
      });
    }
    for (const u of unbudgeted) {
      const existing = combined.get(u.category_id);
      if (existing) existing.spent += u.actual_outflow_cents;
      else
        combined.set(u.category_id, {
          name: u.category_name,
          spent: u.actual_outflow_cents,
          budget: 0,
        });
    }
    // Use same combined-magnitude sort as donut color assignment so
    // colors stay consistent.
    const allSorted = [...combined.entries()].sort(
      (a, b) => b[1].spent + b[1].budget - (a[1].spent + a[1].budget),
    );
    const colorByCat = new Map<number, string>();
    allSorted.forEach(([id], idx) => {
      colorByCat.set(id, paletteColor(idx));
    });
    // Now sort by spent desc and take top 5.
    return [...combined.entries()]
      .sort((a, b) => b[1].spent - a[1].spent)
      .filter(([, v]) => v.spent > 0)
      .slice(0, 5)
      .map(([id, v]) => ({
        category_id: id,
        name: v.name,
        spent: v.spent,
        budget: v.budget,
        color: colorByCat.get(id) ?? "#999",
      }));
  }, [rows, unbudgeted]);

  if (top5.length === 0) return null;

  // Bar widths scale to the LARGEST top-5 spend so visual ranks are obvious.
  const maxSpent = top5[0].spent;

  // Wave 5 fix J — "Biggest leak" anchor. WF 4 in the audit found that
  // "biggest leak" is ambiguous: it can mean (a) the biggest *absolute*
  // spend (handled by the Top 5 list below) or (b) the biggest *overspend
  // vs cap*. We now answer (b) explicitly above the list so both
  // interpretations are visible at a glance instead of forcing the user
  // to figure out which view they need.
  const overCapRows = rows
    .filter((r) => r.budget_cents > 0 && r.actual_outflow_cents > r.budget_cents)
    .map((r) => ({
      ...r,
      over_cents: r.actual_outflow_cents - r.budget_cents,
      pct_over:
        Math.round(((r.actual_outflow_cents - r.budget_cents) / r.budget_cents) * 100),
    }))
    .sort((a, b) => b.over_cents - a.over_cents);
  const biggestLeak = overCapRows.length > 0 ? overCapRows[0] : null;

  return (
    <div className="bg-card border border-border rounded-md shadow-card p-5 mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-text">
            Top 5 spending this month
          </h3>
          <p className="text-[11px] text-text-soft mt-0.5">
            Where most of your money's going. Each row shows this month vs your 3-month average.
          </p>
        </div>
        <div className="text-[11px] text-text-soft tabular-nums">
          {top5.reduce((s, r) => s + r.spent, 0) > 0 && totalSpent > 0 && (
            <span>
              {(
                (top5.reduce((s, r) => s + r.spent, 0) / totalSpent) *
                100
              ).toFixed(0)}
              % of total
            </span>
          )}
        </div>
      </div>
      {biggestLeak ? (
        <button
          type="button"
          onClick={() =>
            onCategoryClick?.({
              category_id: biggestLeak.category_id,
              name: biggestLeak.category_name,
              color: "#dc2626",
              spent_cents: biggestLeak.actual_outflow_cents,
              budget_cents: biggestLeak.budget_cents,
            })
          }
          className="w-full text-left flex items-center gap-2 px-3 py-2 mb-3 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-400/40 transition-colors"
          aria-label={`Biggest budget leak: ${biggestLeak.category_name}, ${fmtCents(biggestLeak.over_cents)} over its cap (${biggestLeak.pct_over}% over). Click to see transactions.`}
        >
          <span aria-hidden className="text-base">⚠️</span>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wider text-outflow">
              Biggest leak this month
            </div>
            <div className="text-sm text-text">
              <span className="font-semibold">{biggestLeak.category_name}</span>{" "}
              is{" "}
              <span className="font-semibold tabular-nums text-outflow">
                {fmtCents(biggestLeak.over_cents)} over
              </span>{" "}
              its {fmtCents(biggestLeak.budget_cents)} cap
              {biggestLeak.pct_over > 0 ? ` (+${biggestLeak.pct_over}%)` : ""}.
            </div>
          </div>
          <span className="text-xs text-text-soft flex-shrink-0">View →</span>
        </button>
      ) : null}
      <ol className="space-y-2">
        {top5.map((r, idx) => {
          const mom = momCompare?.[String(r.category_id)] ?? [r.spent, 0];
          const pctOfBudget =
            r.budget > 0 ? Math.round((r.spent / r.budget) * 100) : null;
          return (
            <li key={r.category_id}>
              <button
                type="button"
                onClick={() =>
                  onCategoryClick?.({
                    category_id: r.category_id,
                    name: r.name,
                    color: r.color,
                    spent_cents: r.spent,
                    budget_cents: r.budget,
                  })
                }
                className="w-full text-left flex items-center gap-3 px-2 py-1.5 rounded hover:bg-hover focus:outline-none focus:bg-hover focus:ring-2 focus:ring-brand/30 transition-colors"
                aria-label={`#${idx + 1} ${r.name}: ${fmtCents(r.spent)} spent this month. Click to see transactions.`}
              >
                <div className="text-[11px] font-bold text-text-soft w-5 flex-shrink-0">
                  #{idx + 1}
                </div>
                <span
                  aria-hidden="true"
                  className="inline-block w-3 h-3 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: r.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-text truncate">
                      {r.name}
                    </span>
                    <MoMChip current_cents={mom[0]} avg_cents={mom[1]} />
                  </div>
                  <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${(r.spent / maxSpent) * 100}%`,
                        backgroundColor: r.color,
                      }}
                    />
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-semibold tabular-nums text-text">
                    {fmtCents(r.spent)}
                  </div>
                  <div className="text-[10px] text-text-soft tabular-nums">
                    {pctOfBudget != null ? `${pctOfBudget}% of cap` : "unbudgeted"}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
