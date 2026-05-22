/**
 * RecurringBillsCard - Sprint O-2.
 *
 * "Fixed monthly bills" - the at-a-glance table the user asked for
 * showing every recurring obligation with three columns:
 *
 *   1. Amount       (monthlyized: a quarterly bill shows as /mo too)
 *   2. Bank desc    (literal description as it appears in transactions)
 *   3. What it is   (merchant name + category)
 *
 * Sorted by monthly equivalent descending so the biggest obligations
 * surface first.
 *
 * Footer math:
 *   Income (expected this month) - Total fixed bills = "Discretionary"
 *   - the pool the user has to split between variable budgets and
 *   extra savings. The user hypothesized "i can probably save way more
 *   than 400/month" - this number is what confirms or refutes that.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type AdoptRecurringResponse,
  type BudgetRollup,
} from "../api/client";

export interface RecurringBillsCardProps {
  /** Pulled from the budget rollup so the discretionary math stays in
   *  sync with the hero. */
  rollup: BudgetRollup;
}

/** Show first N rows by default; the rest fold under a "show all" toggle.
 *  Most users have ~10-15 recurring bills; surfacing 8 keeps the card
 *  short enough that the discretionary footer stays above the fold. */
const COLLAPSED_LIMIT = 8;

export default function RecurringBillsCard({ rollup }: RecurringBillsCardProps) {
  const [showAll, setShowAll] = useState(false);
  const [showVariable, setShowVariable] = useState(false);

  const q = useQuery({
    queryKey: ["recurringBills"],
    queryFn: api.recurringBills,
    staleTime: 5 * 60 * 1000,   // recurrence is stable; refresh every 5min
  });

  // Sprint P — adopt detected bills into The Plan. The mutation takes a
  // list of category ids (the per-row "Budget →" button) or null (the
  // "Budget all" bulk action). On success The Plan's Committed group and
  // the rollup both hold new caps, so invalidate them to refresh live.
  const queryClient = useQueryClient();
  const [adoptResult, setAdoptResult] = useState<AdoptRecurringResponse | null>(
    null,
  );
  const adopt = useMutation({
    mutationFn: (categoryIds: number[] | null) =>
      api.adoptRecurringBills({
        month_start: rollup.month_start,
        category_ids: categoryIds,
      }),
    onSuccess: (res) => {
      setAdoptResult(res);
      queryClient.invalidateQueries({ queryKey: ["assignmentLedger"] });
      queryClient.invalidateQueries({ queryKey: ["budgetRollup"] });
      queryClient.invalidateQueries({ queryKey: ["budgets"] });
    },
  });

  if (q.isLoading) {
    return (
      <div className="rounded-md border border-border shadow-card p-6 mb-5 bg-card">
        <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-2">
          Fixed monthly bills
        </div>
        <div className="text-sm text-text-soft">Detecting recurring outflows…</div>
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="rounded-md border border-border shadow-card p-6 mb-5 bg-card">
        <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted mb-2">
          Fixed monthly bills
        </div>
        <div className="text-sm text-outflow">
          Couldn’t load recurring bills — refresh the page or check the backend log.
        </div>
      </div>
    );
  }

  const {
    bills,
    total_monthly_cents,
    variable_recurring,
    total_variable_monthly_cents,
  } = q.data;
  const visibleBills = showAll ? bills : bills.slice(0, COLLAPSED_LIMIT);
  const hiddenCount = Math.max(0, bills.length - COLLAPSED_LIMIT);

  // Discretionary pool: what's left after the savings goal AND the
  // fixed bills come out. Anything positive is splittable between
  // variable categories (groceries, gas, fun) and extra savings.
  const incomeExpected = rollup.month_income_expected_total_cents ?? 0;
  const savingsGoal = rollup.savings_goal_target_cents ?? 0;
  const discretionary = incomeExpected - total_monthly_cents - savingsGoal;
  const discretionaryTone =
    discretionary < 0 ? "text-outflow" : "text-inflow";

  return (
    <div className="rounded-md border border-border shadow-card p-5 mb-5 bg-card">
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
          Fixed monthly bills
        </div>
        <div className="text-[10px] text-text-soft tabular-nums">
          {bills.length} bill{bills.length === 1 ? "" : "s"} · last 180 days
        </div>
      </div>
      <p className="text-[11px] text-text-soft mb-3 leading-snug">
        Every outflow that repeats on a steady cadence — rent, utilities,
        subscriptions, student loans, insurance — <em>detected from your
        transaction history</em>. Amounts shown as per-month equivalents.
        This is a different number than The Plan's "Committed" total
        below (the caps you've budgeted), so the two won't match.
      </p>

      {/* Sprint P — one-click adopt: turn detected bills into Plan
          budget lines so the Committed total reflects the obligations. */}
      {bills.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <button
            type="button"
            onClick={() => adopt.mutate(null)}
            disabled={adopt.isPending}
            className="text-[11px] font-semibold px-2.5 py-1 rounded border border-brand/40 text-brand hover:bg-brand/5 disabled:opacity-50 transition-colors"
          >
            {adopt.isPending ? "Budgeting…" : "Budget all detected bills →"}
          </button>
          <span className="text-[10px] text-text-soft">
            Adds each to The Plan's Committed group — raises a cap only
            when it's below the detected amount, never lowers one.
          </span>
        </div>
      )}
      {adoptResult && (
        <div className="mb-3 rounded-md border border-inflow/30 bg-emerald-50/60 px-3 py-2 text-[11px] text-text">
          {adoptResult.total_added_cents > 0 ? (
            <>
              ✓ Budgeted{" "}
              <strong>{fmtCents(adoptResult.total_added_cents)}</strong>{" "}
              of detected bills into The Plan
              {(() => {
                const changed = adoptResult.categories.filter((c) => c.changed);
                if (changed.length === 1) return ` — ${changed[0].category_name}`;
                if (changed.length > 1) return ` across ${changed.length} categories`;
                return "";
              })()}
              . See the Committed group in The Plan below.
            </>
          ) : (
            <>✓ Already covered — The Plan's caps already meet these bills.</>
          )}
        </div>
      )}

      {bills.length === 0 ? (
        <div className="text-sm text-text-soft py-3">
          No recurring outflows detected yet. Once a merchant appears
          3+ times at similar amounts, it’ll show up here.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-wider text-text-muted">
                <th className="text-left font-semibold py-1.5 w-20">Amount</th>
                <th className="text-left font-semibold py-1.5">Bank description</th>
                <th className="text-left font-semibold py-1.5">What it is</th>
                <th className="text-left font-semibold py-1.5">Category</th>
                <th className="text-right font-semibold py-1.5 w-16">Cadence</th>
                <th className="text-right font-semibold py-1.5 w-20">Plan</th>
              </tr>
            </thead>
            <tbody>
              {visibleBills.map((b) => (
                <tr
                  key={b.key}
                  className="border-b border-border/50 hover:bg-hover transition-colors"
                >
                  <td className="py-1.5 font-semibold text-text">
                    {fmtCents(b.monthly_equivalent_cents)}
                    {b.cadence !== "monthly" && (
                      <span className="ml-1 text-[9px] text-text-soft">
                        /mo
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-text-muted font-mono text-[10px] truncate max-w-[180px]" title={b.description_raw}>
                    {b.description_raw}
                  </td>
                  <td className="py-1.5 text-text">
                    {b.merchant_name ?? (
                      <span className="text-text-soft italic">unmatched</span>
                    )}
                  </td>
                  <td className="py-1.5 text-text-muted">
                    {b.category_name ?? (
                      <span className="text-text-soft italic">uncategorized</span>
                    )}
                  </td>
                  <td className="py-1.5 text-right text-[10px] text-text-soft uppercase tracking-wider">
                    {b.cadence}
                  </td>
                  <td className="py-1.5 text-right">
                    {b.category_id != null ? (
                      <button
                        type="button"
                        onClick={() => adopt.mutate([b.category_id as number])}
                        disabled={adopt.isPending}
                        className="text-[10px] font-semibold text-brand hover:underline disabled:opacity-50 whitespace-nowrap"
                        title={`Budget ${b.category_name ?? "this category"} in The Plan to cover its detected bills`}
                      >
                        Budget →
                      </button>
                    ) : (
                      <span
                        className="text-[10px] text-text-soft"
                        title="Categorize this bill first (Categorize panel) before it can be budgeted."
                      >
                        —
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="mt-2 text-[11px] text-brand hover:underline tabular-nums"
            >
              {showAll
                ? `Show top ${COLLAPSED_LIMIT} only`
                : `Show ${hiddenCount} more bill${hiddenCount === 1 ? "" : "s"} →`}
            </button>
          )}
        </div>
      )}

      {/* Discretionary-pool footer math — this is the "income minus
          necessities" headline the user asked for. */}
      <div className="mt-4 pt-3 border-t border-border space-y-1 text-[12px] tabular-nums">
        <div className="flex justify-between text-text-soft">
          <span>Expected income this month</span>
          <span className="text-text font-semibold">
            {fmtCents(incomeExpected)}
          </span>
        </div>
        <div className="flex justify-between text-text-soft">
          <span>− Fixed monthly bills</span>
          <span className="text-outflow">−{fmtCents(total_monthly_cents)}</span>
        </div>
        <div className="flex justify-between text-text-soft">
          <span>− Savings goal</span>
          <span className="text-outflow">−{fmtCents(savingsGoal)}</span>
        </div>
        <div className="flex justify-between border-t border-border pt-1.5 mt-1.5 text-[13px]">
          <span className="font-bold text-text">Discretionary pool</span>
          <span className={`font-bold ${discretionaryTone}`}>
            {discretionary >= 0 ? "+" : "−"}
            {fmtCents(Math.abs(discretionary))}
          </span>
        </div>
        <p className="text-[10px] text-text-soft leading-snug mt-1.5">
          {discretionary >= 0 ? (
            <>
              That’s your envelope for groceries, gas, restaurants, fun —
              plus any extra savings. If you can underspend the variable
              side, the difference is bonus savings on top of the{" "}
              {fmtCents(savingsGoal)} goal.
            </>
          ) : (
            <>
              Fixed obligations exceed your expected income this month.
              Trim a bill (subscriptions panel) or revisit the savings
              goal.
            </>
          )}
        </p>
      </div>

      {/* Variable-recurring disclosure — habitual spending that repeats
          on a rhythm (coffee, gas, groceries) but ISN'T a fixed
          obligation. Surfaced separately so the user sees the pattern,
          but deliberately kept OUT of the fixed-bills total above so
          the discretionary math stays honest. */}
      {variable_recurring.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border">
          <button
            onClick={() => setShowVariable(!showVariable)}
            className="w-full flex items-baseline justify-between gap-2 text-[11px] text-text-soft hover:text-text transition-colors"
          >
            <span>
              {showVariable ? "▾" : "▸"} {variable_recurring.length} recurring
              variable pattern{variable_recurring.length === 1 ? "" : "s"}{" "}
              <span className="text-text-muted">
                (coffee, gas, groceries — not fixed bills)
              </span>
            </span>
            <span className="tabular-nums flex-shrink-0">
              ≈{fmtCents(total_variable_monthly_cents)}/mo
            </span>
          </button>
          {showVariable && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs tabular-nums">
                <tbody>
                  {variable_recurring.map((b) => (
                    <tr
                      key={b.key}
                      className="border-b border-border/40 last:border-0"
                    >
                      <td className="py-1 font-semibold text-text w-20">
                        {fmtCents(b.monthly_equivalent_cents)}
                        <span className="ml-1 text-[9px] text-text-soft">
                          /mo
                        </span>
                      </td>
                      <td className="py-1 text-text">
                        {b.merchant_name ?? b.description_raw}
                      </td>
                      <td className="py-1 text-text-muted">
                        {b.category_name ?? "—"}
                      </td>
                      <td className="py-1 text-right text-[10px] text-text-soft uppercase tracking-wider">
                        {b.cadence}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[10px] text-text-soft leading-snug mt-1.5">
                These recur on a rhythm but the amount swings or the
                category is discretionary — budget for them under variable
                spending, don’t treat them as locked-in bills.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
