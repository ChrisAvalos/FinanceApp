/**
 * BudgetMathCard — "Where do Safe-to-Spend and Available Cash come from?"
 *
 * Two numbers users kept confusing — they're large, they're different,
 * and nothing said why. This card spells out BOTH as plain waterfalls
 * so the gap between them is never a mystery:
 *
 *   Safe to Spend   = May income − savings goal − spent − bills due
 *   Available Cash  = Chase checking balance − bills due
 *
 * They differ because they start from different anchors — one from
 * this month's income, the other from the actual bank balance. The
 * "bills still due" line is itemized (it reconciles exactly to
 * committed_remaining: non-catchall, non-discretionary capped rows that
 * still have budget left).
 *
 * Mirrors EomBreakdownCard's collapsible-card pattern.
 */
import { useState } from "react";
import { fmtCents, type BudgetRollup } from "../api/client";

interface Props {
  data: BudgetRollup;
}

export default function BudgetMathCard({ data }: Props) {
  const [open, setOpen] = useState(false);
  const [billsOpen, setBillsOpen] = useState(false);

  // ---- Safe to Spend components ----
  // Income here is the month's expected total (what safe_to_spend is
  // anchored on), falling back to the recurring average pre-migration.
  const income =
    (data.month_income_expected_total_cents ?? 0) > 0
      ? (data.month_income_expected_total_cents ?? 0)
      : (data.recurring_income_cents ?? 0);
  const savingsGoal = data.savings_goal_target_cents ?? 0;
  const committedActual = data.committed_actual_cents ?? 0;
  const variableActual = data.variable_actual_cents ?? 0;
  const committedRemaining = data.committed_remaining_cents ?? 0;
  const safeToSpend = data.safe_to_spend_cents ?? 0;

  // ---- Available Cash components ----
  const liquid = data.liquid_balance_cents ?? 0;
  const availableCash = data.available_cash_cents ?? 0;

  // ---- Itemize "bills still due" (= committed_remaining) ----
  // Backend: sum over rows that are non-catchall AND non-discretionary,
  // of max(0, cap − actual). Replicated here so the list reconciles to
  // the cent.
  const billItems = (data.rows ?? [])
    .map((r) => ({
      name: r.category_name,
      remaining: (r.budget_cents ?? 0) - (r.actual_outflow_cents ?? 0),
      isCatchall: r.is_catchall ?? false,
      isDiscretionary: r.is_discretionary ?? false,
    }))
    .filter((r) => !r.isCatchall && !r.isDiscretionary && r.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);

  // Reconciliation check — surfaces if the UI drifts from the backend.
  const billsSum = billItems.reduce((s, b) => s + b.remaining, 0);
  const billsReconcile = Math.abs(billsSum - committedRemaining) < 100;

  const gap = availableCash - safeToSpend;

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
            Where do Safe to Spend and Available Cash come from?
          </h3>
          <p className="text-[11px] text-text-soft mt-0.5">
            Both numbers, written out as formulas — so the gap between
            <span className="font-semibold text-text"> {fmtCents(safeToSpend)}</span>{" "}
            and
            <span className="font-semibold text-text"> {fmtCents(availableCash)}</span>{" "}
            makes sense.
          </p>
        </div>
        <span aria-hidden className="text-sm text-text-muted ml-3">
          {open ? "▾" : "▸"}
        </span>
      </button>

      {open && (
        <div className="px-5 pb-5 pt-1 border-t border-border space-y-5">
          {/* ---- Safe to Spend waterfall ---- */}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1 mt-3">
              Safe to Spend — a this-month budget number
            </div>
            <table className="w-full text-sm">
              <tbody>
                <WRow
                  label="May income"
                  hint="What you'll earn this month — paychecks landed plus any still expected."
                  value={income}
                />
                <WRow
                  label="Savings goal"
                  hint="Set aside first, before discretionary spending."
                  value={-savingsGoal}
                />
                <WRow
                  label="Committed bills paid so far"
                  hint="Spent this month in non-discretionary categories (rent, utilities, insurance)."
                  value={-committedActual}
                />
                <WRow
                  label="Variable spending so far"
                  hint="Spent this month on discretionary categories (groceries, restaurants, fun)."
                  value={-variableActual}
                />
                <WRow
                  label="Committed bills still due"
                  hint="Budgeted bills not yet paid before month-end (itemized below)."
                  value={-committedRemaining}
                />
                <TotalRow label="Safe to spend" value={safeToSpend} />
              </tbody>
            </table>
          </div>

          {/* ---- Available Cash waterfall ---- */}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1">
              Available Cash — a bank-account number
            </div>
            <table className="w-full text-sm">
              <tbody>
                <WRow
                  label="Chase checking balance"
                  hint="What's literally in your checking account right now."
                  value={liquid}
                />
                {/* Bills-due row, expandable to the itemized list. */}
                <tr className="border-b border-border/50">
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      onClick={() => setBillsOpen((v) => !v)}
                      className="text-left text-sm text-brand hover:underline focus:outline-none"
                      aria-expanded={billsOpen}
                    >
                      {billsOpen ? "▾" : "▸"} Bills still due before month-end
                    </button>
                    <div className="text-[11px] text-text-soft leading-relaxed mt-0.5">
                      Click to see which bills. Same number subtracted in
                      Safe to Spend above.
                    </div>
                  </td>
                  <td className="py-2 text-right font-semibold tabular-nums whitespace-nowrap align-top text-outflow">
                    −{fmtCents(committedRemaining)}
                  </td>
                </tr>
                {billsOpen && (
                  <tr>
                    <td colSpan={2} className="pb-2">
                      <div className="ml-4 border-l-2 border-border pl-3 py-1">
                        {billItems.length === 0 ? (
                          <div className="text-[11px] text-text-soft py-1">
                            No committed bills outstanding — every budgeted
                            bill for this month is already paid.
                          </div>
                        ) : (
                          <table className="w-full text-[12px] tabular-nums">
                            <tbody>
                              {billItems.map((b) => (
                                <tr
                                  key={b.name}
                                  className="border-b border-border/40 last:border-0"
                                >
                                  <td className="py-1 text-text">{b.name}</td>
                                  <td className="py-1 text-right text-outflow">
                                    −{fmtCents(b.remaining)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        <div className="text-[10px] text-text-soft mt-1.5 leading-relaxed">
                          Each is a budgeted (committed) category with cap
                          left unspent — the unpaid remainder is treated as
                          still due this month.
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                <TotalRow label="Available cash" value={availableCash} />
              </tbody>
            </table>
          </div>

          {/* ---- Why they differ ---- */}
          <div className="bg-bg/40 border border-border rounded-md p-3 text-[12px] text-text-soft leading-relaxed">
            <span className="font-semibold text-text">Why the gap.</span>{" "}
            They start from different places. Safe to Spend starts from{" "}
            <span className="font-semibold">this month's income</span>;
            Available Cash starts from your{" "}
            <span className="font-semibold">actual checking balance</span>.
            Your checking holds{" "}
            <span className="font-semibold tabular-nums">{fmtCents(gap)}</span>{" "}
            more than "May income left after savings and spending" — that
            extra is money carried into May from before, which the monthly
            budget deliberately doesn't count as this month's to spend.
          </div>

          {!billsReconcile && (
            <div className="text-[10px] text-text-muted italic">
              Note: itemized bills ({fmtCents(billsSum)}) don't match the
              official total ({fmtCents(committedRemaining)}) — the backend
              formula may have changed; please flag this.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One waterfall line: label + hint on the left, signed amount right. */
function WRow({
  label,
  hint,
  value,
}: {
  label: string;
  hint: string;
  value: number;
}) {
  const negative = value < 0;
  return (
    <tr className="border-b border-border/50">
      <td className="py-2 pr-3">
        <div className="text-sm text-text">{label}</div>
        <div className="text-[11px] text-text-soft leading-relaxed mt-0.5">
          {hint}
        </div>
      </td>
      <td
        className={`py-2 text-right font-semibold tabular-nums whitespace-nowrap align-top ${
          negative ? "text-outflow" : "text-inflow"
        }`}
      >
        {negative ? "−" : "+"}
        {fmtCents(Math.abs(value))}
      </td>
    </tr>
  );
}

/** The "= result" row at the bottom of a waterfall. */
function TotalRow({ label, value }: { label: string; value: number }) {
  const negative = value < 0;
  return (
    <tr className="border-t-2 border-border">
      <td className="pt-3 font-bold text-text">= {label}</td>
      <td
        className={`pt-3 text-right text-base font-bold tabular-nums ${
          negative ? "text-outflow" : "text-text"
        }`}
      >
        {negative ? "−" : ""}
        {fmtCents(Math.abs(value))}
      </td>
    </tr>
  );
}
