/**
 * CategoryDrawer — Sprint G-16a.
 *
 * Slide-out right-side drawer that shows every transaction in a
 * given category for a given month. Used by the Budgets panel's
 * four visualizations (donut, bar, treemap, sunburst) + the legend
 * table — all of them call onCategoryClick and the parent mounts
 * <CategoryDrawer> with the selected category.
 *
 * Why a drawer (not a modal, not a route change)
 * ----------------------------------------------
 * The user is mid-scenario (sliders adjusted, recs applied) when they
 * click a category. A route change to `/transactions?category=X` would
 * lose that scenario state. A modal forces a center-of-screen focus
 * lock that breaks the "still see the budget context behind me"
 * peripheral-vision pattern. The right-side drawer:
 *   - Keeps the chart + sliders visible on the left while you read
 *     the transactions on the right.
 *   - ESC + click-outside both dismiss.
 *   - Re-clicking a different category swaps the contents without
 *     a close+reopen animation.
 *
 * Special case — categoryId === null
 * ----------------------------------
 * When the user clicks the donut CENTER label ("$2,632.70 SPENT"),
 * we want "all transactions this month" — not a single category.
 * Pass categoryId: null + a custom label to render that view.
 */
import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type Transaction,
} from "../api/client";

export interface CategoryDrawerProps {
  /** Open/close state. Parent owns this. */
  open: boolean;
  /** Category to show. `null` = "all transactions this month" (or use
   *  `categoryIds` for a multi-category filter — sunburst group drill). */
  categoryId: number | null;
  /** FU-4 — when set, fetches txns matching ANY of these category ids.
   *  Takes precedence over `categoryId`. Empty array falls back to
   *  `categoryId === null` behavior (all-month). */
  categoryIds?: number[];
  /** Display name for the header. e.g. "Groceries" or "All spending." */
  categoryName: string;
  /** Month boundary (ISO YYYY-MM-DD of first day). */
  monthStart: string;
  /** Optional color swatch — matches the donut/bar slice color. */
  swatchColor?: string;
  /** Optional totals shown in the header. */
  totalSpentCents?: number;
  totalBudgetCents?: number;
  /** Sprint M follow-up / Sprint N-7 DEPRECATED — extra transaction IDs
   *  to ALSO include. Used to surface rent-attributed prior-month-end
   *  txns. Sprint N-7 replaced this workaround with the backend
   *  `effective_month` param, which solves it structurally — the
   *  server now returns rent-shifted txns automatically. Prop is kept
   *  for callers that haven't migrated yet, but is silently ignored.
   *  Will be removed in a follow-up. */
  extraTxIds?: number[];
  /** Dismiss handler. */
  onClose: () => void;
}

// Sprint N-7: _monthEnd() was used to compute the inclusive end_date for
// the listTransactions call. Now that we pass `effective_month` instead,
// the server handles the date math (including rent-shift attribution)
// and we don't need this helper any more. Removed 2026-05-15.

function _fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function CategoryDrawer({
  open,
  categoryId,
  categoryIds,
  categoryName,
  monthStart,
  swatchColor,
  totalSpentCents,
  totalBudgetCents,
  extraTxIds,
  onClose,
}: CategoryDrawerProps) {
  // ESC key closes the drawer. Attached only when open is true so we
  // don't trap escape globally.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock background scroll while the drawer is open — same pattern
  // as a modal but only on the right portion. Without this, scrolling
  // inside the drawer can leak to the page.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Sprint N-7: switched from start_date/end_date to `effective_month`.
  // The backend now scans a wider window (prev-month day 25 → month end),
  // enriches the candidates, and returns only txns whose effective_month
  // matches. Rent-like txns posted on the last few days of the prior
  // month (Apr 30 Zelle for May rent) are now included AUTOMATICALLY,
  // and rent-like txns posted on the last few days of THIS month (May
  // 30 Zelle for June rent) are correctly excluded — no more
  // extraTxIds workaround.

  // FU-4 — when categoryIds[] is provided (sunburst group click), we
  // pass it as `category_ids` (comma-joined) so the server filters to
  // ANY of those ids. Otherwise behavior is unchanged.
  const idsKey =
    categoryIds && categoryIds.length > 0
      ? categoryIds.join(",")
      : null;
  // Sprint N-7: extraTxIds is silently ignored — kept in the props
  // signature for callers that haven't migrated. We still incorporate
  // it into the cache key so reopening with a different parent doesn't
  // serve stale data (defensive only — the value doesn't reach the
  // fetch).
  const _legacyExtraIdsKey =
    extraTxIds && extraTxIds.length > 0
      ? extraTxIds.join(",")
      : null;
  const txQuery = useQuery({
    queryKey: ["categoryDrawer", categoryId, idsKey, _legacyExtraIdsKey, monthStart],
    queryFn: () =>
      api.listTransactions({
        category_id:
          idsKey == null && categoryId != null ? categoryId : undefined,
        category_ids: idsKey ?? undefined,
        effective_month: monthStart, // YYYY-MM-DD; backend also accepts YYYY-MM
        limit: 500, // generous cap — most months are well under
      }),
    enabled: open,
    staleTime: 30 * 1000,
  });

  // Group transactions by date for the visual scan. Within a date,
  // sort by descending absolute amount so the biggest charges land
  // at the top of each day's cluster.
  const groupedByDate = useMemo(() => {
    const groups = new Map<string, Transaction[]>();
    for (const t of txQuery.data ?? []) {
      const k = t.posted_date;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(t);
    }
    // Sort each day's list and the days themselves.
    const sortedDays = [...groups.keys()].sort((a, b) => (a < b ? 1 : -1));
    return sortedDays.map((d) => ({
      date: d,
      transactions: (groups.get(d) ?? []).sort(
        (a, b) => Math.abs(b.amount_cents) - Math.abs(a.amount_cents),
      ),
    }));
  }, [txQuery.data]);

  const totalAbsCents = useMemo(() => {
    return (txQuery.data ?? []).reduce(
      (s, t) => s + (t.amount_cents < 0 ? Math.abs(t.amount_cents) : 0),
      0,
    );
  }, [txQuery.data]);

  if (!open) return null;

  return (
    <>
      {/* Click-outside backdrop. semi-transparent so the panel is still
          peripherally visible. */}
      <div
        className="fixed inset-0 z-40 bg-text/15 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Drawer panel — slides in from the right. Tailwind doesn't
          have keyframe utilities natively so we use a simple
          translate-x with transition-transform. Mounted only when
          open === true so initial render starts from the off-screen
          position. */}
      <div
        className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-[520px] bg-card border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200"
        role="dialog"
        aria-modal="true"
        aria-label={`Transactions in ${categoryName}`}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-3 flex-shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              {swatchColor && (
                <span
                  aria-hidden="true"
                  className="inline-block w-3 h-3 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: swatchColor }}
                />
              )}
              <h2 className="text-base font-semibold text-text truncate">
                {categoryName}
              </h2>
            </div>
            <div className="text-[11px] text-text-soft tabular-nums">
              {(txQuery.data?.length ?? 0)} transaction
              {(txQuery.data?.length ?? 0) === 1 ? "" : "s"}
              {" · "}
              {fmtCents(totalAbsCents)} total
              {totalBudgetCents != null && totalBudgetCents > 0 && (
                <>
                  {" of "}
                  {fmtCents(totalBudgetCents)} budgeted
                </>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center text-text-muted hover:text-text rounded transition-colors"
            title="Close (Esc)"
            aria-label="Close drawer"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        {/* tabIndex=0 makes the scrollable region keyboard-focusable so
            keyboard users can scroll it via arrow keys. WCAG 2.1.1
            (scrollable-region-focusable). */}
        <div className="flex-1 overflow-y-auto" tabIndex={0} role="region" aria-label="Transaction list">
          {txQuery.isLoading && (
            <div className="p-6 text-center text-text-muted text-sm">
              Loading transactions…
            </div>
          )}
          {!txQuery.isLoading && (txQuery.data?.length ?? 0) === 0 && (
            <div className="p-6 text-center text-text-muted text-sm">
              No transactions in {categoryName} this month.
            </div>
          )}
          {!txQuery.isLoading && groupedByDate.length > 0 && (
            <ul className="divide-y divide-border">
              {groupedByDate.map((day) => (
                <li key={day.date}>
                  <div className="px-5 py-1.5 bg-hover text-[10px] font-bold uppercase tracking-wider text-text-soft sticky top-0">
                    {_fmtDate(day.date)}
                  </div>
                  <ul>
                    {day.transactions.map((t) => (
                      <li
                        key={t.id}
                        className="px-5 py-2.5 flex items-start gap-3 border-t border-border first:border-t-0 hover:bg-hover transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-text truncate font-medium">
                            {t.description_clean || t.description_raw}
                          </div>
                          {t.source && (
                            <div className="text-[10px] text-text-soft uppercase tracking-wide mt-0.5">
                              {t.source}
                            </div>
                          )}
                        </div>
                        <div
                          className={`tabular-nums text-sm font-semibold shrink-0 ${
                            t.amount_cents < 0 ? "text-outflow" : "text-inflow"
                          }`}
                        >
                          {t.amount_cents < 0 ? "" : "+"}
                          {fmtCents(t.amount_cents)}
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer — minimal hint about how to dismiss + the budget
            context the user came from. */}
        <div className="px-5 py-2.5 border-t border-border text-[10px] text-text-soft flex items-center justify-between flex-shrink-0">
          <span>Press <kbd className="px-1 py-0.5 bg-hover border border-border rounded text-text-muted">Esc</kbd> to close</span>
          {totalSpentCents != null && totalBudgetCents != null && totalBudgetCents > 0 && (
            <span className="tabular-nums">
              {((totalSpentCents / totalBudgetCents) * 100).toFixed(0)}% of cap
            </span>
          )}
        </div>
      </div>
    </>
  );
}
