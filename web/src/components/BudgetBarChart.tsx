/**
 * BudgetBarChart — Sprint G-16b.
 *
 * Horizontal bar chart alternative to the donut. Solves the
 * "small-sliver" problem: every category gets its own row at a
 * legible height, so even a 1% category is a clickable target you
 * can read at a glance.
 *
 * Layout
 * ------
 * Each row is a single category. Inside the row we render TWO bars
 * stacked vertically (budget = pale, spent = saturated category
 * color) so the eye reads "actual vs plan" as the bars line up.
 * If the spent bar exceeds the budget the bar gets a thin red
 * outline (matches the donut's `isOverspend` ring).
 *
 * Sort order: by descending budget+spent so the biggest categories
 * land at the top.
 *
 * Why no chart-lib
 * ----------------
 * Same reason as DonutChart — pure CSS/Tailwind keeps the bundle
 * lean and gives full theme control. Each "bar" is just a div with
 * a percentage width.
 *
 * Click handling
 * --------------
 * The entire row is a button. Clicking surfaces `onCategoryClick`
 * with the category id + name + swatch color — the parent uses
 * those to mount CategoryDrawer.
 */
import { useMemo } from "react";
import { fmtCents } from "../api/client";

export interface BudgetBarRow {
  category_id: number;
  name: string;
  budget_cents: number;
  spent_cents: number;
  color: string;
  isUnbudgeted?: boolean;
}

export interface BudgetBarChartProps {
  rows: BudgetBarRow[];
  /** Total spent across all rows — drives the "% of total" hint. */
  totalSpent: number;
  /** Click a row → open the category drawer. */
  onCategoryClick?: (row: BudgetBarRow) => void;
}

export default function BudgetBarChart({
  rows,
  totalSpent,
  onCategoryClick,
}: BudgetBarChartProps) {
  // Sort by total magnitude (budget + spent) descending so biggest
  // categories rank highest. Visually consistent with the donut's
  // color assignment (which also sorts by combined magnitude).
  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          (b.budget_cents + b.spent_cents) -
          (a.budget_cents + a.spent_cents),
      ),
    [rows],
  );

  // Scale is the max of (budget, spent) across ALL rows. Using one
  // shared scale lets the user compare row magnitudes by length
  // (otherwise a $100 spend would visually equal a $5000 spend).
  const scale = useMemo(() => {
    let m = 0;
    for (const r of sorted) {
      if (r.budget_cents > m) m = r.budget_cents;
      if (r.spent_cents > m) m = r.spent_cents;
    }
    return m > 0 ? m : 1;
  }, [sorted]);

  if (sorted.length === 0) {
    return (
      <div className="text-text-soft text-sm italic py-6 text-center">
        No data
      </div>
    );
  }

  return (
    <div
      className="w-full"
      role="list"
      aria-label={`${sorted.length} categories, sorted by combined budget and spend`}
    >
      {sorted.map((row) => {
        const isOver =
          row.budget_cents > 0 && row.spent_cents > row.budget_cents;
        const pctOfTotal =
          totalSpent > 0 ? (row.spent_cents / totalSpent) * 100 : 0;
        const budgetW = (row.budget_cents / scale) * 100;
        const spentW = (row.spent_cents / scale) * 100;

        return (
          <button
            key={row.category_id}
            type="button"
            onClick={() => onCategoryClick?.(row)}
            className="w-full text-left px-3 py-2 border-b border-border last:border-0 hover:bg-hover transition-colors focus:outline-none focus:bg-hover focus:ring-2 focus:ring-brand/30 rounded-sm"
            role="listitem"
            aria-label={`${row.name}: spent ${fmtCents(
              row.spent_cents,
            )}${
              row.budget_cents > 0
                ? ` of ${fmtCents(row.budget_cents)} budget`
                : " (unbudgeted)"
            }${isOver ? ", over budget" : ""}. Click to see transactions.`}
          >
            {/* Top line — name + amounts */}
            <div className="flex items-center justify-between gap-3 mb-1">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span
                  aria-hidden="true"
                  className="inline-block w-3 h-3 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: row.color }}
                />
                <span className="text-sm font-medium text-text truncate">
                  {row.name}
                </span>
                {row.isUnbudgeted && (
                  <span className="ml-1 inline-block px-1 py-0.5 rounded-sm bg-gray-100 text-text-muted text-[9px] font-semibold uppercase tracking-wide flex-shrink-0">
                    unbudgeted
                  </span>
                )}
                {isOver && (
                  <span className="ml-1 inline-block px-1 py-0.5 rounded-sm bg-red-50 text-outflow text-[9px] font-semibold uppercase tracking-wide flex-shrink-0">
                    over
                  </span>
                )}
              </div>
              <div className="text-right flex-shrink-0">
                <div
                  className={`text-sm font-semibold tabular-nums ${
                    isOver ? "text-outflow" : "text-text"
                  }`}
                >
                  {fmtCents(row.spent_cents)}
                </div>
                <div className="text-[10px] text-text-soft tabular-nums">
                  {row.budget_cents > 0
                    ? `of ${fmtCents(row.budget_cents)}`
                    : `${pctOfTotal.toFixed(0)}% of total`}
                </div>
              </div>
            </div>

            {/* Bar stack — budget (pale, behind) + spent (color, in front).
                We render them as two rows so they're independently legible
                even when spent < budget OR spent > budget. */}
            <div className="space-y-1">
              {/* Budget row — only if a budget cap exists */}
              {row.budget_cents > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-[9px] text-text-soft uppercase tracking-wide w-12 flex-shrink-0">
                    Budget
                  </span>
                  <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${budgetW}%`,
                        backgroundColor: row.color,
                        opacity: 0.35,
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Spent row */}
              <div className="flex items-center gap-2">
                <span className="text-[9px] text-text-soft uppercase tracking-wide w-12 flex-shrink-0">
                  Spent
                </span>
                <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      isOver ? "ring-1 ring-outflow ring-inset" : ""
                    }`}
                    style={{
                      width: `${spentW}%`,
                      backgroundColor: row.color,
                    }}
                  />
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
