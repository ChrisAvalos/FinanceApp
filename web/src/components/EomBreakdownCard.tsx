/**
 * EomBreakdownCard — "Where does the EOM projection come from?"
 *
 * The EOM Projection number combines four moving parts and the variable
 * component is a pace-extrapolation that surprises users mid-month. This
 * card makes the whole number auditable:
 *
 *   1. It splits what has ACTUALLY happened (income received, money
 *      already spent) from what the model only ASSUMES (unused committed
 *      budget + pace-projected day-to-day spend).
 *   2. It itemises the assumptions — every committed category with
 *      budget room left is listed by name, so "$437 still due" is no
 *      longer a black box.
 *   3. It surfaces the upcoming paycheck the rollup's effective-month
 *      math hides (the Cash Flow panel shows it; now this card does too).
 *   4. It shows the real credit-card debt taken on this month —
 *      charges minus payments — the concrete answer to "if I'm
 *      projected negative, how much of that is card debt?"
 *
 * Rebuilt 2026-05-20 after Chris flagged that the single projected
 * number wasn't trustworthy without seeing the expected transactions
 * behind it.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents, type BudgetRollup } from "../api/client";

interface Props {
  data: BudgetRollup;
}

/** "+$1,234.56" / "-$1,234.56" — explicit sign, fmtCents has none. */
function signed(cents: number): string {
  return (cents < 0 ? "−" : "+") + fmtCents(Math.abs(cents));
}

function fmtDate(iso: string): string {
  const parts = iso.split("-");
  const m = parts[1];
  const d = parts[2];
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return (months[Number(m) - 1] || m) + " " + Number(d);
}

export default function EomBreakdownCard({ data }: Props) {
  const [open, setOpen] = useState(false);

  // Itemised backing (upcoming paychecks + credit-card debt).
  const detail = useQuery({
    queryKey: ["eom-detail", data.month_start],
    queryFn: () => api.eomDetail(data.month_start),
  });

  // ---- The rollup's own EOM components (single source of truth) ----
  const income =
    data.month_income_expected_total_cents ??
    data.recurring_income_cents ??
    0;
  const committedActual = data.committed_actual_cents ?? 0;
  const variableActual = data.variable_actual_cents ?? 0;
  const committedRemaining = data.committed_remaining_cents ?? 0;
  const variableEom = data.variable_eom_estimate_cents ?? variableActual;
  const variableProjected = Math.max(0, variableEom - variableActual);
  const eomNet = data.eom_projected_net_flow_cents ?? 0;
  const pace = data.pace ?? 0;

  const spentSoFar = committedActual + variableActual;
  // Where you stand once the upcoming paycheck lands, before any further
  // spending. Uses the same full-month income the rollup's EOM math uses,
  // so this and the projected total reconcile exactly.
  const netSoFar = income - spentSoFar;
  const assumedFuture = committedRemaining + variableProjected;

  // Reconciliation guard — netSoFar - assumedFuture must equal eomNet.
  const reconciles = Math.abs(netSoFar - assumedFuture - eomNet) < 100;

  // ---- Itemise committed budget headroom from the rollup rows ----
  const committedHeadroom = (data.rows ?? [])
    .filter(
      (r) =>
        r.is_discretionary === false &&
        !r.is_catchall &&
        r.budget_cents - r.actual_outflow_cents > 0,
    )
    .map((r) => ({
      name: r.category_name,
      spent: r.actual_outflow_cents,
      cap: r.budget_cents,
      headroom: r.budget_cents - r.actual_outflow_cents,
    }))
    .sort((a, b) => b.headroom - a.headroom);

  // ---- Where the day-to-day spending has actually gone so far ----
  const variableSpendItems = [
    ...(data.rows ?? []).filter((r) => r.is_discretionary && !r.is_catchall),
    ...(data.unbudgeted_spending ?? []).filter((r) => !r.is_catchall),
  ]
    .map((r) => ({ name: r.category_name, spent: r.actual_outflow_cents }))
    .filter((r) => r.spent > 0)
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 6);

  const multiplier =
    variableActual > 0 ? (variableEom / variableActual).toFixed(2) : "—";

  const cc = detail.data?.credit_card ?? null;
  const expectedIncome = detail.data?.expected_income ?? [];
  const expectedIncomeTotal = expectedIncome.reduce(
    (s, e) => s + e.amount_cents,
    0,
  );
  const hasExpectedIncome = expectedIncome.length > 0;
  const incomeLanded = data.month_income_landed_cents ?? income;

  const isNegative = eomNet < 0;

  return (
    <div className="bg-card border border-border rounded-md shadow-card mb-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-hover focus:outline-none focus:bg-hover transition-colors"
        aria-expanded={open}
      >
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-text">
            Where does the month-end projection come from?
          </h3>
          <p className="text-[11px] text-text-soft mt-0.5">
            Every line behind the{" "}
            <span
              className={
                "font-semibold " +
                (isNegative ? "text-outflow" : "text-inflow")
              }
            >
              {signed(eomNet)}
            </span>{" "}
            projection: what is real, what is assumed, and the card debt
            behind it.
          </p>
        </div>
        <span aria-hidden className="text-sm text-text-muted ml-3">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="px-5 pb-5 pt-1 border-t border-border">
          {/* SECTION 1 - the projection, line by line */}
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-border/60">
                <td className="py-2">
                  <div className="font-semibold text-text">
                    Income this month
                  </div>
                  <div className="text-[11px] text-text-soft">
                    {hasExpectedIncome
                      ? fmtCents(incomeLanded) +
                        " landed · " +
                        fmtCents(Math.abs(expectedIncomeTotal)) +
                        " still expected (see below)"
                      : "Fully landed this month — every paycheck is in"}
                  </div>
                </td>
                <td className="py-2 text-right font-semibold tabular-nums text-inflow">
                  +{fmtCents(income)}
                </td>
              </tr>

              <tr>
                <td colSpan={2} className="pt-3 pb-1">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
                    What has actually happened
                  </div>
                </td>
              </tr>
              <Row
                label="Committed bills paid so far"
                hint="Rent, utilities, insurance, groceries, gas - money that has already left your accounts this month."
                value={-committedActual}
              />
              <Row
                label="Day-to-day spending so far"
                hint="Restaurants, shopping, entertainment, and the like - already spent this month."
                value={-variableActual}
              />

              <tr className="border-t border-border bg-inflow/5">
                <td className="py-2.5">
                  <div className="font-bold text-text">
                    Where you land before any further spending
                  </div>
                  <div className="text-[11px] text-text-soft">
                    {hasExpectedIncome
                      ? "Your full month income minus what you have actually spent. Once the expected paycheck lands, this is your real position — nothing here is a guess."
                      : "Your income for the month is fully in. This is your actual position right now — every dollar here has really moved."}
                  </div>
                </td>
                <td
                  className={
                    "py-2.5 text-right text-base font-bold tabular-nums " +
                    (netSoFar < 0 ? "text-outflow" : "text-inflow")
                  }
                >
                  {signed(netSoFar)}
                </td>
              </tr>

              <tr>
                <td colSpan={2} className="pt-3 pb-1">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
                    What the projection assumes from here
                  </div>
                </td>
              </tr>
              <Row
                label="Committed budgets not yet used"
                hint="The projection assumes you spend the rest of these committed budgets. Each one is listed below - you can judge which will really happen."
                value={-committedRemaining}
                highlight
              />
              {committedHeadroom.length > 0 && (
                <tr>
                  <td colSpan={2} className="pb-2">
                    <div className="ml-3 border-l-2 border-amber-200 pl-3 space-y-1">
                      {committedHeadroom.map((c) => (
                        <div
                          key={c.name}
                          className="flex items-baseline justify-between text-[11px]"
                        >
                          <span className="text-text-soft">
                            {c.name}
                            <span className="text-text-muted">
                              {" "}
                              - spent {fmtCents(c.spent)} of{" "}
                              {fmtCents(c.cap)}
                            </span>
                          </span>
                          <span className="tabular-nums text-text-muted">
                            {fmtCents(c.headroom)} assumed
                          </span>
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
              <Row
                label="Estimated day-to-day spending, rest of month"
                hint={
                  "A pure estimate - NOT scheduled transactions. You have spent " +
                  fmtCents(variableActual) +
                  " in the first " +
                  Math.round(pace * 100) +
                  "% of the month; the model stretches that to " +
                  fmtCents(variableEom) +
                  " for the full month (x" +
                  multiplier +
                  "). This line is the rest."
                }
                value={-variableProjected}
                highlight
              />

              <tr className="border-t-2 border-border">
                <td className="pt-3">
                  <div className="font-bold text-text">
                    Projected month-end net flow
                  </div>
                  <div className="text-[11px] text-text-soft">
                    Where you land before any further spending, minus the
                    two assumed lines above.
                  </div>
                </td>
                <td
                  className={
                    "pt-3 text-right text-base font-bold tabular-nums " +
                    (isNegative ? "text-outflow" : "text-inflow")
                  }
                >
                  {signed(eomNet)}
                </td>
              </tr>
            </tbody>
          </table>

          <div className="mt-4 bg-amber-50 border border-warn/30 rounded-md p-3 text-[12px]">
            <div className="font-semibold text-warn mb-1">
              {fmtCents(assumedFuture)} of this projection has not happened
            </div>
            <p className="text-text-soft leading-relaxed">
              {fmtCents(committedRemaining)} is unused room in your
              committed budgets, and {fmtCents(variableProjected)} is your
              current spending pace stretched to month-end. Not one dollar
              of it is a scheduled transaction. If you hold spending from
              here, your month-end number moves toward{" "}
              <span className="font-semibold text-text">
                {signed(netSoFar)}
              </span>
              .
            </p>
          </div>

          {/* SECTION 2 - expected income still to come */}
          <div className="mt-5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-2">
              Expected income still to come
            </div>
            {detail.isLoading ? (
              <div className="text-[11px] text-text-soft">Loading...</div>
            ) : expectedIncome.length === 0 ? (
              <div className="text-[11px] text-text-soft">
                No more paychecks expected before month-end.
              </div>
            ) : (
              <div className="space-y-1">
                {expectedIncome.map((e, i) => (
                  <div
                    key={e.on_date + "-" + i}
                    className="flex items-baseline justify-between text-sm border-b border-border/50 pb-1"
                  >
                    <span className="text-text">
                      <span className="text-text-muted tabular-nums mr-2">
                        {fmtDate(e.on_date)}
                      </span>
                      {e.label}
                    </span>
                    <span className="tabular-nums font-semibold text-inflow">
                      +{fmtCents(Math.abs(e.amount_cents))}
                    </span>
                  </div>
                ))}
                <p className="text-[11px] text-text-soft pt-1">
                  This paycheck is part of the {fmtCents(income)} income
                  the projection already counts.
                </p>
              </div>
            )}
          </div>

          {/* SECTION 3 - credit-card reality check */}
          <div className="mt-5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-2">
              Credit-card debt this month
            </div>
            {detail.isLoading ? (
              <div className="text-[11px] text-text-soft">Loading...</div>
            ) : !cc ? (
              <div className="text-[11px] text-text-soft">
                No credit-card account linked.
              </div>
            ) : (
              <div className="border border-border rounded-md overflow-hidden">
                <table className="w-full text-sm">
                  <tbody>
                    <tr className="border-b border-border/60">
                      <td className="px-3 py-2 text-text">
                        Charged to {cc.account_name} this month
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-outflow font-semibold">
                        {fmtCents(cc.charges_mtd_cents)}
                      </td>
                    </tr>
                    <tr className="border-b border-border/60">
                      <td className="px-3 py-2 text-text">
                        Payments made toward the card
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-inflow font-semibold">
                        {"−"}
                        {fmtCents(cc.payments_mtd_cents)}
                      </td>
                    </tr>
                    <tr className="border-b border-border bg-hover">
                      <td className="px-3 py-2 font-bold text-text">
                        New card debt taken on this month
                      </td>
                      <td
                        className={
                          "px-3 py-2 text-right tabular-nums font-bold " +
                          (cc.net_debt_change_mtd_cents > 0
                            ? "text-outflow"
                            : "text-inflow")
                        }
                      >
                        {cc.net_debt_change_mtd_cents > 0 ? "+" : ""}
                        {fmtCents(cc.net_debt_change_mtd_cents)}
                      </td>
                    </tr>
                    <tr>
                      <td className="px-3 py-2 text-text-soft text-[12px]">
                        Current balance owed
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-text-soft text-[12px]">
                        {fmtCents(cc.current_balance_cents)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            {cc && cc.net_debt_change_mtd_cents > 0 && (
              <p className="text-[11px] text-text-soft mt-2 leading-relaxed">
                You have put {fmtCents(cc.net_debt_change_mtd_cents)} more
                onto the card than you have paid off this month. A negative
                month-end projection typically lands here, as a growing
                card balance, so this is the concrete number to watch.
              </p>
            )}
          </div>

          {variableSpendItems.length > 0 && (
            <div className="mt-4 text-[11px] text-text-soft">
              <span className="font-semibold text-text-muted">
                Day-to-day spending so far:
              </span>{" "}
              {variableSpendItems
                .map((v) => v.name + " " + fmtCents(v.spent))
                .join(" · ")}
            </div>
          )}

          {!reconciles && (
            <div className="mt-3 text-[10px] text-text-muted italic">
              Note: the line items do not reconcile to the official
              projection ({signed(eomNet)}). The backend formula may have
              changed - please flag this.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  hint,
  value,
  highlight,
}: {
  label: string;
  hint: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <tr
      className={
        "border-b border-border/50 " + (highlight ? "bg-amber-50/40" : "")
      }
    >
      <td className="py-2 pr-3">
        <div className="text-sm text-text">{label}</div>
        <div className="text-[11px] text-text-soft leading-relaxed mt-0.5">
          {hint}
        </div>
      </td>
      <td
        className={
          "py-2 text-right font-semibold tabular-nums whitespace-nowrap align-top pt-2 " +
          (value < 0 ? "text-outflow" : "text-text")
        }
      >
        {value < 0 ? "−" : ""}
        {fmtCents(Math.abs(value))}
      </td>
    </tr>
  );
}
