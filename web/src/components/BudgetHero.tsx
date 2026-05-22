/**
 * BudgetHero — Sprint I, the "budget at a glance" replacement.
 *
 * Replaces the prior 5-card Income/Budgeted/Spent/Remaining/Unbudgeted
 * headline row. The user told us this panel needs to "drive my monthly
 * financial decisions," so the design is:
 *
 *   1. ONE huge anchor number — "Money I can still safely spend this month"
 *   2. A QuickSpendSimulator directly under it for daily yes/no decisions
 *   3. A 4-card StatStrip for context (Income / Saved / Spent / EOM)
 *   4. WealthPulse + GoalPace cards for strategic framing
 *
 * The math is in the backend (`BudgetRollupResponse.safe_to_spend_cents`)
 * and fixes the prior +$417 trust hole by:
 *   - Using `real_actual` (matches `real_budget`'s catchall exclusion)
 *   - Subtracting unbudgeted spend explicitly
 *   - Subtracting committed bills not-yet-paid
 *   - Subtracting the savings goal
 *
 * If you grep this file from a future session: the entire monthly
 * decision-making story lives in <BudgetHero/>. Don't edit blindly.
 */
import type React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, type BudgetRollup } from "../api/client";
import MoMChip from "./MoMChip";

/** Render an ISO date string like "May 15" — used for the next-payday
 *  hint on the Available Cash card. */
function formatShortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ============================================================== */
/*  BudgetHero (anchor card + simulator under)                     */
/* ============================================================== */

export interface BudgetHeroProps {
  data: BudgetRollup;
  monthStart: string;
}

function _daysInMonth(monthStartISO: string): number {
  const [y, m] = monthStartISO.split("-").map((s) => Number(s));
  // m is 1-indexed in our ISO format; Date.UTC m is 0-indexed.
  // Day 0 of next month = last day of this month.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function _daysRemaining(monthStartISO: string, pace: number): number {
  const total = _daysInMonth(monthStartISO);
  return Math.max(0, Math.round(total * (1 - pace)));
}

export default function BudgetHero({ data, monthStart }: BudgetHeroProps) {
  const safe = data.safe_to_spend_cents ?? 0;
  const daysLeft = _daysRemaining(monthStart, data.pace);
  const perDay = daysLeft > 0 ? safe / daysLeft : safe;

  // Sprint O-3: the caption income must match the backend's
  // `income_for_safe` exactly — month-expected total, falling back to
  // the 90-day recurring average only when the new field is absent.
  // Showing `recurring_income_cents` here while safe_to_spend was
  // computed from the expected total made the hero contradict itself
  // ($7,159 caption under a $7,240-funded bar).
  const heroIncomeCents =
    (data.month_income_expected_total_cents ?? 0) > 0
      ? (data.month_income_expected_total_cents ?? 0)
      : (data.recurring_income_cents ?? 0);

  // Color logic
  // - Green: safe > 10% of total committed_caps_total (substantial headroom)
  // - Yellow: safe is positive but small
  // - Red: safe is negative or near zero
  const totalCaps = data.committed_caps_total_cents ?? 1;
  const safePct = safe / Math.max(totalCaps, 100_00);
  let tone: "green" | "yellow" | "red";
  if (safe <= 0) tone = "red";
  else if (safePct >= 0.1) tone = "green";
  else tone = "yellow";

  const toneColor =
    tone === "green"
      ? "text-inflow"
      : tone === "red"
      ? "text-outflow"
      : "text-warn";
  const toneBg =
    tone === "green"
      ? "bg-emerald-50/60"
      : tone === "red"
      ? "bg-red-50/60"
      : "bg-amber-50/60";

  return (
    <div
      className={`rounded-md border border-border shadow-card p-6 mb-5 ${toneBg}`}
    >
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-3">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Safe to spend this month
          </div>
          <div
            className={`text-5xl font-bold tabular-nums mt-1 ${toneColor}`}
            title="Recurring income, minus savings goal, minus everything already spent this month, minus bills still due before month-end."
          >
            {fmtCents(safe)}
          </div>
        </div>
        <div className="text-right text-[11px] text-text-soft tabular-nums">
          <div className="font-semibold text-text">
            {daysLeft} day{daysLeft === 1 ? "" : "s"} left
          </div>
          {/* Sprint O-1 (2026-05-15): the prior version did
              `Math.max(0, ...)` here, which clamped the daily rate to
              $0 whenever the user was already over budget. Result was
              a contradiction — hero showed "-$67" but daily said "$0
              to stay on track". Now we show the real per-day number
              even when negative, and switch the label so it reads
              naturally ("over per day" vs "to stay on track"). */}
          {perDay >= 0 ? (
            <div className="mt-0.5">
              ≈ {fmtCents(Math.round(perDay))} / day to stay on track
            </div>
          ) : (
            <div className="mt-0.5 text-outflow">
              {fmtCents(Math.round(perDay))} / day already over
            </div>
          )}
        </div>
      </div>

      {/* Pace bar — same visual language as the prior bar but underneath
          the hero so you can see WHERE in the month you are. */}
      <div className="relative">
        <div className="w-full h-1.5 bg-text/10 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${
              tone === "green"
                ? "bg-inflow"
                : tone === "red"
                ? "bg-outflow"
                : "bg-warn"
            }`}
            style={{ width: `${data.pace * 100}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-text-soft mt-1 tabular-nums">
          <span>{(data.pace * 100).toFixed(0)}% through month</span>
          <span>
            Income: {fmtCents(heroIncomeCents)} ·
            Savings goal: {fmtCents(data.savings_goal_target_cents ?? 0)}
          </span>
        </div>
      </div>

      {/* Quick spend simulator — right under the anchor, max prominence */}
      <QuickSpendSimulator safe={safe} tone={tone} daysLeft={daysLeft} />
    </div>
  );
}

/* ============================================================== */
/*  QuickSpendSimulator                                            */
/* ============================================================== */

function QuickSpendSimulator({
  safe,
  daysLeft,
}: {
  safe: number;
  tone: "green" | "yellow" | "red";
  daysLeft: number;
}) {
  const [draft, setDraft] = useState<string>("");
  const amount = useMemo(() => {
    const n = parseFloat(draft);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.round(n * 100); // cents
  }, [draft]);

  const after = safe - amount;
  const perDayAfter = daysLeft > 0 ? after / daysLeft : after;

  let verdict: { label: string; cls: string } | null = null;
  if (amount > 0) {
    if (after < 0) {
      verdict = {
        label: `❌ Over budget — you'd be ${fmtCents(Math.abs(after))} short by month end`,
        cls: "text-outflow",
      };
    } else if (after / Math.max(safe, 1) < 0.2) {
      verdict = {
        label: `⚠️ Tight — only ${fmtCents(after)} (${fmtCents(Math.max(0, Math.round(perDayAfter)))}/day) would remain`,
        cls: "text-warn",
      };
    } else {
      verdict = {
        label: `✓ Comfortable — ${fmtCents(after)} (${fmtCents(Math.max(0, Math.round(perDayAfter)))}/day) would remain`,
        cls: "text-inflow",
      };
    }
  }

  return (
    <div className="mt-5 pt-4 border-t border-border/70">
      <label className="flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
        <span className="font-semibold uppercase tracking-wider">
          What if I spent
        </span>
        <span className="text-text-soft">$</span>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          placeholder="0.00"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="px-2 py-1 text-sm font-semibold tabular-nums border border-border rounded w-28 focus:outline-none focus:border-brand bg-card"
          aria-label="Hypothetical purchase amount to simulate"
        />
        <span className="text-text-soft">today?</span>
        {verdict && (
          <span className={`text-[11px] font-semibold ${verdict.cls}`}>
            {verdict.label}
          </span>
        )}
      </label>
    </div>
  );
}

/* ============================================================== */
/*  StatStrip — 4 supporting cards under the hero                  */
/* ============================================================== */

export function BudgetStatStrip({ data }: { data: BudgetRollup }) {
  const incomeSoFar = data.monthly_income_cents
    ? Math.round((data.monthly_income_cents ?? 0) * (data.pace ?? 1))
    : 0;
  const eomNet = data.eom_projected_net_flow_cents ?? 0;
  const trailingNet = data.trailing_3mo_net_flow_cents ?? 0;
  const variableSpent =
    (data.real_actual_cents ?? 0) +
    (data.unbudgeted_actual_cents ?? 0) -
    (data.committed_caps_total_cents ?? 0); // approximation, see formula below
  // The clean variable-spent number is total_actual MINUS committed_actual,
  // but we don't have committed_actual directly on the response. Use
  // (real_actual - committed_caps_total_estimate) as a rough fallback —
  // it's not exact when committed bills exceed their cap.

  // Sprint O-1 (2026-05-15): the Income card now answers "what will I
  // make in May?" instead of "what's the 90-day trailing average?". The
  // primary number is the expected MONTH total (landed + still-expected
  // paychecks). The subtitle shows the breakdown — "$X landed of $Y · next
  // paycheck May 30" — so at a glance you see both the goal and where
  // you currently are in the month.
  //
  // Sprint O-1 follow-up: also surface "other income" (Brigit, Labaton,
  // settlement payouts) as a "+$X bonus" line so the user sees their
  // TOTAL money-in. We deliberately keep it OUT of the primary number
  // because windfalls aren't expected to recur and would over-promise
  // future paydays.
  const monthExpected = data.month_income_expected_total_cents ?? 0;
  const monthLanded = data.month_income_landed_cents ?? 0;
  const monthOther = data.month_other_income_landed_cents ?? 0;
  const nextPaydayForIncome = data.next_expected_paycheck_date ?? null;

  // Fallback only when backend hasn't migrated yet (returns 0 for the
  // new fields). Then we use the 90-day-avg the old logic relied on.
  const incomePrimaryCents =
    monthExpected > 0 ? monthExpected : (data.recurring_income_cents ?? 0);

  // Subtitle text: prefer the new "$X landed of $Y · next May 30" wording
  // when the new fields are present, otherwise keep the legacy "last
  // paycheck N days ago" line.
  const paycheckCents = data.latest_paycheck_cents ?? null;
  const paycheckDaysAgo = data.latest_paycheck_days_ago ?? null;
  let incomeSubtitle: string;
  if (monthExpected > 0) {
    const parts: string[] = [
      `${fmtCents(monthLanded)} landed of ${fmtCents(monthExpected)}`,
    ];
    if (nextPaydayForIncome) {
      parts.push(`next ${formatShortDate(nextPaydayForIncome)}`);
    } else if (monthLanded >= monthExpected) {
      parts.push("all in for the month");
    }
    if (monthOther > 0) {
      parts.push(`+${fmtCents(monthOther)} other income`);
    }
    incomeSubtitle = parts.join(" · ");
  } else if (paycheckCents != null && paycheckDaysAgo != null) {
    incomeSubtitle =
      paycheckDaysAgo === 0
        ? `Last paycheck: ${fmtCents(paycheckCents)} today`
        : paycheckDaysAgo === 1
          ? `Last paycheck: ${fmtCents(paycheckCents)} yesterday`
          : `Last paycheck: ${fmtCents(paycheckCents)} · ${paycheckDaysAgo}d ago`;
  } else {
    incomeSubtitle = `${fmtCents(incomeSoFar)} expected so far`;
  }

  // Wave 5 fix H — "Available cash" — closes WF 8.
  // Forward-looking: checking + expected income − bills due.
  const available = data.available_cash_cents ?? 0;
  const liquid = data.liquid_balance_cents ?? 0;
  const committedDue = (data.committed_remaining_cents ?? 0);
  const expectedIncome = (data.expected_remaining_income_cents ?? 0);
  const nextPayday = data.next_expected_paycheck_date ?? null;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
      <StatCard
        label="Income ↗"
        primary={fmtCents(incomePrimaryCents)}
        secondary={incomeSubtitle}
        tone="neutral"
      />
      <StatCard
        label="Available cash 💵"
        primary={fmtCents(available)}
        secondaryNode={(() => {
          // Components: checking + expected paychecks − bills due.
          const parts: string[] = [`${fmtCents(liquid)} checking`];
          if (expectedIncome > 0) {
            const paydayHint = nextPayday
              ? ` ${formatShortDate(nextPayday)}`
              : "";
            parts.push(
              `+${fmtCents(expectedIncome)} paycheck${paydayHint}`,
            );
          }
          if (committedDue > 0) {
            parts.push(`−${fmtCents(committedDue)} bills`);
          }
          return (
            <span className="block leading-snug">{parts.join(" · ")}</span>
          );
        })()}
        tone={available > 50_000 ? "good" : available > 0 ? "neutral" : "bad"}
      />
      <StatCard
        label="Saved 💰"
        primary={`${fmtCents(data.savings_actual_etrade_cents ?? data.savings_actual_cents ?? 0)} / ${fmtCents(data.savings_goal_target_cents ?? 0)}`}
        // Sprint K-3 — when bonus savings exist (Albert auto-pulls,
        // brokerage growth), surface them as a small secondary line so
        // the user sees their TOTAL saving rate, not just goal-bound.
        secondaryNode={
          (() => {
            const eTrade = data.savings_actual_etrade_cents ?? 0;
            const other = data.savings_actual_other_cents ?? 0;
            const goal = data.savings_goal_target_cents ?? 0;
            const onPace = eTrade >= goal && goal > 0;
            const goalNote = goal > 0
              ? onPace
                ? "eTrade goal hit ✓"
                : "eTrade behind"
              : "no goal set";
            if (other > 0) {
              return (
                <span>
                  {goalNote}{" "}
                  <span className="text-inflow font-semibold">
                    · +{fmtCents(other)} bonus
                  </span>
                </span>
              );
            }
            return <span>{goalNote}</span>;
          })()
        }
        tone={
          (data.savings_actual_etrade_cents ?? data.savings_actual_cents ?? 0) >=
          (data.savings_goal_target_cents ?? 0)
            ? "good"
            : "warn"
        }
      />
      <StatCard
        label="Variable spent 🛍️"
        primary={fmtCents(Math.max(0, variableSpent))}
        secondaryNode={
          <span className="inline-flex items-center gap-1">
            vs 3-mo avg
            <MoMChip
              current_cents={Math.max(0, variableSpent)}
              avg_cents={Math.abs(trailingNet)}
              hideWhenZero={false}
            />
          </span>
        }
        tone="neutral"
      />
      <StatCard
        label="EOM projection 🎯"
        primary={`${eomNet >= 0 ? "+" : ""}${fmtCents(eomNet)}`}
        secondary={
          eomNet >= 0
            ? "You'd end the month net positive"
            : "You'd end the month burning savings"
        }
        tone={eomNet >= 0 ? "good" : "bad"}
      />
    </div>
  );
}

function StatCard({
  label,
  primary,
  secondary,
  secondaryNode,
  tone,
}: {
  label: string;
  primary: string;
  secondary?: string;
  secondaryNode?: React.ReactNode;
  tone: "good" | "bad" | "warn" | "neutral";
}) {
  const cls =
    tone === "good"
      ? "text-inflow"
      : tone === "bad"
      ? "text-outflow"
      : tone === "warn"
      ? "text-warn"
      : "text-text";
  return (
    <div className="bg-card border border-border rounded-md p-3 shadow-card">
      <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <div className={`text-xl font-bold tabular-nums mt-1 ${cls}`}>
        {primary}
      </div>
      <div className="text-[10px] text-text-soft mt-0.5">
        {secondaryNode ?? secondary}
      </div>
    </div>
  );
}

/* ============================================================== */
/*  WealthPulseCard — building or burning wealth?                  */
/* ============================================================== */

export function WealthPulseCard({ data }: { data: BudgetRollup }) {
  const eomNet = data.eom_projected_net_flow_cents ?? 0;
  const trailing = data.trailing_3mo_net_flow_cents ?? 0;
  const delta = eomNet - trailing;
  const building = eomNet > 0;

  // Avoid divide-by-zero / silly chips when trailing is small.
  const pct = trailing !== 0 ? Math.round((delta / Math.abs(trailing)) * 100) : 0;

  return (
    <div className="bg-card border border-border rounded-md p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1">
            Wealth pulse 💪
          </div>
          <div
            className={`text-lg font-bold ${building ? "text-inflow" : "text-outflow"}`}
          >
            {building ? "Building wealth" : "Burning savings"}
          </div>
          <div className="text-[11px] text-text-soft mt-1 leading-relaxed">
            On pace to {building ? "save" : "burn"}{" "}
            <span className="font-semibold text-text tabular-nums">
              {fmtCents(Math.abs(eomNet))}/mo
            </span>{" "}
            this month.
            <br />
            Trailing 3-mo avg:{" "}
            <span className="font-semibold tabular-nums">
              {trailing >= 0 ? "+" : ""}
              {fmtCents(trailing)}/mo
            </span>
            {trailing !== 0 && (
              <span className="ml-1">
                {" "}
                · {delta >= 0 ? "+" : ""}
                {pct}% vs your typical
              </span>
            )}
            .
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================== */
/*  GoalPaceCard — when can I afford X?                            */
/* ============================================================== */

export interface GoalPaceData {
  id: number;
  name: string;
  target_amount_cents: number;
  current_amount_cents: number;
  // Wave 5 fix A: optional server-derived "true progress" — when a goal
  // is linked to an account, this reflects the account balance. Used in
  // preference to current_amount_cents for the on-track math so the card
  // doesn't claim "$0 saved" when there's $400 sitting in the linked
  // savings account.
  effective_current_amount_cents?: number | null;
  target_date: string | null;
}

/* ============================================================== */
/*  MonthEndSweepCard — Sprint J-2                                 */
/* ============================================================== */

/**
 * Reminder card that appears when:
 *   - days_remaining <= 5 (last week of the month)
 *   - safe_to_spend > $50 (worth sweeping)
 *
 * Offers a one-click action to log the remaining safe-to-spend as a
 * GoalContribution against the primary active goal. We can't actually
 * MOVE the money for Chris (Plaid is read-only), but logging the
 * contribution updates the Savings synth row and the Goal Pace card.
 * The user still has to physically transfer it via their bank app.
 */
export interface MonthEndSweepCardProps {
  data: BudgetRollup;
  monthStart: string;
  goals: GoalPaceData[];
}

export function MonthEndSweepCard({
  data,
  monthStart,
  goals,
}: MonthEndSweepCardProps) {
  const qc = useQueryClient();
  const safe = data.safe_to_spend_cents ?? 0;
  const daysLeft = _daysRemaining(monthStart, data.pace);

  // Only show in the last week, and only when there's meaningful
  // surplus to sweep.
  const visible = daysLeft <= 7 && safe >= 50_00;

  // Pick the highest-priority active goal as the sweep target.
  const targetGoal = goals[0] ?? null;

  const contributeM = useMutation({
    mutationFn: () => {
      if (!targetGoal) throw new Error("no goal to contribute to");
      return api.contributeToGoal(targetGoal.id, {
        amount_cents: safe,
        contributed_at: new Date().toISOString().slice(0, 10),
        source: "manual" as never,
        notes: `Month-end sweep of safe-to-spend surplus (Sprint J-2)`,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["budgetRollup"] });
      qc.invalidateQueries({ queryKey: ["goals"] });
    },
  });

  if (!visible || !targetGoal) return null;

  return (
    <div className="bg-gradient-to-r from-inflow/8 to-brand/8 border border-inflow/30 rounded-md p-4 mb-3 shadow-card">
      <div className="flex items-start gap-3">
        <div className="text-3xl flex-shrink-0">🧹</div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-text">
            Month-end sweep
          </h3>
          <p className="text-xs text-text-soft mt-1 leading-relaxed">
            You have <span className="font-semibold tabular-nums text-inflow">{fmtCents(safe)}</span> of
            safe-to-spend left and only <span className="font-semibold">{daysLeft} day{daysLeft === 1 ? "" : "s"}</span> until
            month-end. Want to log this as a contribution to <span className="font-semibold">{targetGoal.name}</span>?
            You'll still need to transfer the money via your bank — we just record it here so it counts toward your goal pace.
          </p>
          {contributeM.isError && (
            <div className="text-[11px] text-outflow mt-1">
              Something went wrong. Try again or log it manually in Savings &amp; goals.
            </div>
          )}
          {contributeM.isSuccess && (
            <div className="text-[11px] text-inflow mt-1 font-semibold">
              ✓ Logged. Now go transfer {fmtCents(safe)} to {targetGoal.name}.
            </div>
          )}
        </div>
        {!contributeM.isSuccess && (
          <button
            onClick={() => contributeM.mutate()}
            disabled={contributeM.isPending}
            className="text-xs font-semibold px-3 py-1.5 bg-inflow text-white rounded shadow-sm hover:bg-inflow/90 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          >
            {contributeM.isPending
              ? "Logging…"
              : `Log ${fmtCents(safe)} as saved`}
          </button>
        )}
      </div>
    </div>
  );
}

export function GoalPaceCard({
  goals,
  currentSavingsActualCents,
}: {
  goals: GoalPaceData[];
  currentSavingsActualCents: number;
}) {
  // Wave 5 fix A: prefer effective_current (account balance) over the
  // cached contribution sum. The helper picks effective if defined.
  const _progress = (g: GoalPaceData) =>
    g.effective_current_amount_cents != null
      ? g.effective_current_amount_cents
      : g.current_amount_cents || 0;

  // No goals → nothing useful to project.
  const active = goals.filter((g) => g.target_amount_cents > _progress(g));
  if (active.length === 0) {
    return (
      <div className="bg-card border border-border rounded-md p-4 shadow-card">
        <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-1">
          Goal pace 🏁
        </div>
        <div className="text-sm text-text-soft">
          No active goals. Add one in Savings &amp; goals to track when you'll hit it.
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card border border-border rounded-md p-4 shadow-card">
      <div className="text-[10px] font-bold uppercase tracking-wider text-text-muted mb-2">
        Goal pace 🏁
      </div>
      <ul className="space-y-2">
        {active.map((g) => {
          const gap = g.target_amount_cents - _progress(g);
          // At current monthly savings rate, how many months until target?
          const pace = Math.max(currentSavingsActualCents, 1); // avoid div-by-0
          const monthsAtPace = Math.ceil(gap / pace);
          const eta = new Date();
          eta.setMonth(eta.getMonth() + monthsAtPace);
          const etaStr = eta.toLocaleDateString(undefined, {
            month: "short",
            year: "numeric",
          });

          // How far off goal date is from the original deadline?
          let onTime = "";
          let needed = "";
          if (g.target_date) {
            const targetDate = new Date(g.target_date);
            const monthsToTarget =
              (targetDate.getFullYear() - new Date().getFullYear()) * 12 +
              (targetDate.getMonth() - new Date().getMonth());
            const monthsLate = monthsAtPace - monthsToTarget;
            if (monthsLate > 1) {
              onTime = ` (${monthsLate}mo late)`;
              const neededMonthly = Math.ceil(gap / Math.max(1, monthsToTarget));
              const extraPerMo = neededMonthly - pace;
              if (extraPerMo > 0) {
                needed = `Need +${fmtCents(extraPerMo)}/mo more to hit on-time.`;
              }
            } else if (monthsLate < -1) {
              onTime = ` (${Math.abs(monthsLate)}mo early)`;
            } else {
              onTime = " (on track)";
            }
          }

          return (
            <li key={g.id} className="text-[12px]">
              <div className="font-semibold text-text truncate">{g.name}</div>
              <div className="text-text-soft mt-0.5 leading-snug">
                At {fmtCents(pace)}/mo, hits{" "}
                <span className="font-semibold tabular-nums">
                  {fmtCents(g.target_amount_cents)}
                </span>{" "}
                target by{" "}
                <span className="font-semibold">{etaStr}</span>
                <span className="text-text-muted">{onTime}</span>.
                {needed && (
                  <div className="text-warn text-[11px] mt-0.5">{needed}</div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
