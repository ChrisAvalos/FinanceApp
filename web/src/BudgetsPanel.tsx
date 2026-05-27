import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  fmtMonthLong,
  fmtMonthShort,
  currentMonthStart,
  shiftMonthStart,
  type BudgetRollupRow,
  type BudgetStatus,
  type BudgetTemplateResult,
  type Category,
} from "./api/client";
// DonutChart, paletteColor, DonutSlice are imported by BudgetVisualization
// internally — BudgetsPanel no longer references them directly since the
// retirement of BudgetDonuts (FU-5, 2026-05-13).
import BudgetVisualization from "./components/BudgetVisualization";
import TopSpendingCard from "./components/TopSpendingCard";
import BudgetHero, {
  BudgetStatStrip,
  WealthPulseCard,
  GoalPaceCard,
  MonthEndSweepCard,
  type GoalPaceData,
} from "./components/BudgetHero";
import AssignmentLedgerCard from "./components/AssignmentLedger";
import RecurringBillsCard from "./components/RecurringBillsCard";
import CategoryReparentBoard from "./components/CategoryReparentBoard";
import EomBreakdownCard from "./components/EomBreakdownCard";
import BudgetMathCard from "./components/BudgetMathCard";
import ProjectionChart from "./components/ProjectionChart";
import { useAnimatedProjection } from "./components/useAnimatedProjection";
import {
  CelebrationToastStack,
  useCelebrate,
} from "./components/CelebrationToast";
import type { BudgetRecommendation } from "./api/client";

/* ------------------------------------------------------------------ */
/*  Status → color                                                    */
/* ------------------------------------------------------------------ */

const STATUS_BADGE: Record<BudgetStatus, string> = {
  on_track: "bg-emerald-50 text-inflow",
  warning:  "bg-amber-50 text-warn",
  over:     "bg-red-50 text-outflow",
};

const STATUS_LABEL: Record<BudgetStatus, string> = {
  on_track: "On track",
  warning:  "Pacing hot",
  over:     "Over",
};

function barColor(status: BudgetStatus): string {
  if (status === "over") return "bg-outflow";
  if (status === "warning") return "bg-warn";
  return "bg-inflow";
}

/* ------------------------------------------------------------------ */
/*  Progress row                                                       */
/* ------------------------------------------------------------------ */

function ProgressBar({ pct, status }: { pct: number; status: BudgetStatus }) {
  // Cap the visible fill at 100% but keep the raw pct for the label so we
  // can still see "115%" when you've blown past the cap.
  const fill = Math.min(100, pct);
  return (
    <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all ${barColor(status)}`}
        style={{ width: `${fill}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Editable amount cell                                               */
/* ------------------------------------------------------------------ */

function BudgetAmountCell({
  row,
  onSave,
}: {
  row: BudgetRollupRow;
  onSave: (amount_cents: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(
    (row.budget_cents / 100).toFixed(0)
  );

  if (!editing) {
    return (
      <button
        onClick={() => {
          setDraft((row.budget_cents / 100).toFixed(0));
          setEditing(true);
        }}
        className="text-sm font-semibold text-text hover:text-brand"
        title="Click to edit"
      >
        {fmtCents(row.budget_cents)}
      </button>
    );
  }
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const dollars = parseFloat(draft);
        if (!Number.isNaN(dollars) && dollars >= 0) {
          onSave(Math.round(dollars * 100));
        }
        setEditing(false);
      }}
    >
      <span className="text-text-soft text-sm">$</span>
      <input
        autoFocus
        type="number"
        min={0}
        step={1}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setEditing(false)}
        className="w-20 px-1.5 py-0.5 text-sm border border-border rounded focus:outline-none focus:border-brand"
      />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Add-budget form                                                    */
/* ------------------------------------------------------------------ */

function AddBudgetForm({
  unbudgeted,
  allCategories,
  onAdd,
}: {
  unbudgeted: BudgetRollupRow[];
  allCategories: Category[];
  onAdd: (category_id: number, amount_cents: number) => void;
}) {
  // Prefer a category that already has unbudgeted spending — the obvious
  // "you already spent here, want to cap it?" suggestion.
  const unbudgetedIds = new Set(
    unbudgeted.map((u) => u.category_id).filter((id): id is number => id > 0)
  );
  const preferred = allCategories.filter((c) => unbudgetedIds.has(c.id));
  const others = allCategories.filter((c) => !unbudgetedIds.has(c.id));

  const [catId, setCatId] = useState<number>(
    preferred[0]?.id ?? others[0]?.id ?? 0
  );
  const [dollars, setDollars] = useState<string>("");

  return (
    <form
      className="flex items-center gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        const v = parseFloat(dollars);
        if (!catId || Number.isNaN(v) || v < 0) return;
        onAdd(catId, Math.round(v * 100));
        setDollars("");
      }}
    >
      <select
        value={catId}
        onChange={(e) => setCatId(Number(e.target.value))}
        className="px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand bg-card"
        aria-label="Pick a category to add a budget for"
      >
        {preferred.length > 0 && (
          <optgroup label="Unbudgeted (you already spend here)">
            {preferred.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Other categories">
          {others.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      </select>
      <span className="text-text-soft">$</span>
      <input
        type="number"
        min={0}
        step={1}
        value={dollars}
        onChange={(e) => setDollars(e.target.value)}
        placeholder="Monthly cap"
        className="w-28 px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand"
      />
      <button
        type="submit"
        className="px-3 py-1 bg-brand text-white text-xs font-semibold rounded hover:bg-brand-navy disabled:opacity-50"
        disabled={!catId || !dollars}
      >
        Add budget
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Template result banner                                             */
/* ------------------------------------------------------------------ */

const ACTION_LABEL: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  skipped_existing: "Skipped (already set)",
  skipped_low_avg: "Skipped (low avg)",
};

const ACTION_BADGE: Record<string, string> = {
  created: "bg-emerald-50 text-inflow",
  updated: "bg-blue-50 text-brand",
  skipped_existing: "bg-gray-100 text-text-muted",
  skipped_low_avg: "bg-gray-100 text-text-muted",
};

function TemplateResultBanner({
  result,
  onDismiss,
}: {
  result: BudgetTemplateResult;
  onDismiss: () => void;
}) {
  const [showRows, setShowRows] = useState(false);

  // Headline: copy and fill have different framing.
  const isCopy = result.source_month_start !== null;
  const headline = isCopy
    ? `Copied from ${fmtMonthShort(result.source_month_start as string)} → ${fmtMonthShort(result.target_month_start)}`
    : `Filled ${fmtMonthShort(result.target_month_start)} from ${result.lookback_months ?? 3}-mo average`;

  // If nothing happened, give a softer message rather than "0 created" — the
  // most common cause is that all categories already had budgets and the user
  // didn't pass overwrite=true.
  const nothingHappened =
    result.created === 0 && result.updated === 0;

  return (
    <div className="mb-5 rounded-md border border-brand-light bg-blue-50/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="text-sm font-semibold text-brand-deep">
            {headline}
          </div>
          <div className="text-xs text-text-muted mt-0.5 tabular-nums">
            {result.created} created
            {result.updated > 0 && ` · ${result.updated} updated`}
            {result.skipped > 0 && ` · ${result.skipped} skipped`}
            {nothingHappened && (
              <span className="ml-2 text-text-soft italic">
                — existing budgets were preserved. Toggle overwrite to replace
                them.
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {result.rows.length > 0 && (
            <button
              onClick={() => setShowRows((s) => !s)}
              className="text-xs text-brand hover:text-brand-navy font-semibold"
            >
              {showRows ? "Hide details" : "Show details"}
            </button>
          )}
          <button
            onClick={onDismiss}
            className="w-6 h-6 flex items-center justify-center text-text-muted hover:text-text rounded"
            title="Dismiss"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      </div>

      {showRows && result.rows.length > 0 && (
        <div className="mt-3 max-h-56 overflow-y-auto border-t border-border pt-2">
          <table className="w-full text-xs">
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.category_id} className="border-b border-border last:border-0">
                  <td className="py-1.5 pr-2 font-medium text-text">
                    {r.category_name}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-text-muted w-24">
                    {fmtCents(r.amount_cents)}
                  </td>
                  <td className="py-1.5 text-right w-44">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${
                        ACTION_BADGE[r.action] ?? "bg-gray-100 text-text-muted"
                      }`}
                    >
                      {ACTION_LABEL[r.action] ?? r.action}
                    </span>
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

/* ------------------------------------------------------------------ */
/*  G-3 — Projection chart + headline insights                          */
/* ------------------------------------------------------------------ */

/**
 * BudgetProjection — pulls /api/budgets/project and renders:
 *   * Three headline figures (3mo / 12mo / 24mo end-state net worth)
 *   * The multi-line projection chart (G-3)
 *   * A "broke by" / "saving rate" insight chip
 *
 * Status-quo only for now. Sprint G-6 will add the slider state +
 * pass `category_overrides` so the chart updates live.
 */
function BudgetProjection({
  overrides,
  goalContributions,
  onReset,
  celebrate,
}: {
  overrides: Record<number, number> | null;
  goalContributions: Record<number, number>;
  onReset?: () => void;
  celebrate: ReturnType<typeof useCelebrate>["celebrate"];
}) {
  const totalGoalContrib = Object.values(goalContributions).reduce((s, v) => s + v, 0);
  const hasOverrides =
    (overrides != null && Object.keys(overrides).length > 0) ||
    totalGoalContrib > 0;
  const projection = useQuery({
    queryKey: [
      "budgetProjection",
      JSON.stringify(overrides ?? {}),
      JSON.stringify(goalContributions),
    ],
    queryFn: () =>
      api.budgetProject({
        months: 24,
        category_overrides: overrides ?? undefined,
        goal_contributions: goalContributions,
        include_baseline: true,
      }),
    staleTime: 5 * 60 * 1000,
  });

  const data = projection.data;
  // Sprint G-9 — animate the scenario + baseline series over ~280ms
  // when the user drags a slider or applies a recommendation. The
  // headline cards + chart paths read from these animated arrays so
  // everything stays visually synchronized during the transition.
  const animatedScenario = useAnimatedProjection(data?.scenario_points);
  const animatedBaseline = useAnimatedProjection(data?.baseline_points);
  const headlines = useMemo(() => {
    if (!data) return null;
    const pts = animatedScenario.length > 0 ? animatedScenario : data.scenario_points;
    const at = (m: number) => pts.find((p) => p.month_index === m);
    // Sprint J-fix — also compute optimistic equivalents so the headline
    // cards can show a range. When optimistic_points is null (rare),
    // we fall back to scenario for both lines and visually they collapse.
    const optPts = data.optimistic_points ?? null;
    const optAt = (m: number) =>
      optPts?.find((p) => p.month_index === m) ?? null;
    const optOutflow = data.monthly_outflow_cents_optimistic ?? null;
    return {
      m3: at(3)?.net_cents ?? 0,
      m12: at(12)?.net_cents ?? 0,
      m24: at(24)?.net_cents ?? 0,
      m3_opt: optAt(3)?.net_cents ?? null,
      m12_opt: optAt(12)?.net_cents ?? null,
      m24_opt: optAt(24)?.net_cents ?? null,
      // Find first month where net goes negative in the SCENARIO (conservative).
      brokeMonth: pts.find((p) => p.month_index > 0 && p.net_cents < 0)?.month_index ?? null,
      // Same for optimistic — if even the optimistic case goes negative,
      // that's a stronger warning to surface.
      optBrokeMonth:
        optPts?.find((p) => p.month_index > 0 && p.net_cents < 0)?.month_index ?? null,
      monthlyNetFlow:
        (data.monthly_income_cents - data.monthly_outflow_cents_scenario),
      monthlyNetFlowOpt:
        optOutflow != null
          ? data.monthly_income_cents - optOutflow
          : null,
    };
  }, [data, animatedScenario]);

  // Sprint G-10 — fire a celebration when the scenario crosses from
  // "going negative within 24mo" to "stays positive through 24mo."
  //
  // Why we read from the SETTLED (non-animated) data, not animatedScenario:
  // during the 280ms ease, the net_cents value passes through zero on
  // its way from -$15K to +$2K. We don't want to fire mid-animation —
  // we want to fire when the *target* state is positive, regardless of
  // which interpolation frame we're on. So we hook the underlying
  // data.scenario_points + monthly_outflow_cents_scenario (both settled).
  const lastFlipState = useRef<"positive" | "negative" | null>(null);
  useEffect(() => {
    if (!data) return;
    // Compute the FINAL-state brokeMonth from the underlying scenario.
    const finalBroke = data.scenario_points.find(
      (p) => p.month_index > 0 && p.net_cents < 0,
    )?.month_index ?? null;
    const isPositive = finalBroke === null;
    const prev = lastFlipState.current;
    if (prev === "negative" && isPositive) {
      // Celebrate the flip. Use a custom kind + headline so it's
      // visually distinct from the cancel-sub / unclaimed-paid
      // celebrations the rest of the app fires.
      const monthlySaved = Math.max(
        0,
        data.monthly_income_cents - data.monthly_outflow_cents_scenario,
      );
      celebrate({
        kind: "custom",
        label: "Budget scenario",
        oneTimeCents: monthlySaved > 0 ? monthlySaved * 12 : undefined,
        headline:
          "Nice — that scenario keeps you positive through 2 years.",
      });
    }
    lastFlipState.current = isPositive ? "positive" : "negative";
  }, [data, celebrate]);

  if (projection.isLoading) {
    return (
      <div className="bg-card border border-border rounded-md shadow-card p-5 mb-6">
        <h3 className="text-sm font-semibold text-text">Projection</h3>
        <p className="text-xs text-text-muted mt-3">Computing projection…</p>
      </div>
    );
  }
  if (projection.isError || !data || !headlines) {
    return (
      <div className="bg-card border border-border rounded-md shadow-card p-5 mb-6">
        <h3 className="text-sm font-semibold text-text">Projection</h3>
        <p className="text-xs text-outflow mt-3">
          Couldn't load projection. The endpoint needs at least one budgeted
          category or three months of transaction history to run.
        </p>
      </div>
    );
  }

  const isAheadOfBaseline = data.scenario_vs_baseline_net_cents > 0;
  const isBehindBaseline = data.scenario_vs_baseline_net_cents < 0;

  return (
    <div className="bg-card border border-border rounded-md shadow-card p-5 mb-6">
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text">
            Net worth — projected
          </h3>
          <p className="text-[11px] text-text-soft mt-0.5">
            Assumes your typical{" "}
            <span title="Recurring Livio payroll, 90-day average. Future months use this rather than this month's expected total ($7,240) — there are no landed paychecks for a month that hasn't happened yet. Windfalls are excluded so they aren't projected as recurring income.">
              ${(data.monthly_income_cents / 100).toFixed(0)}/mo recurring income
            </span>
            {data.monthly_outflow_cents_optimistic != null &&
            data.monthly_outflow_cents_optimistic !== data.monthly_outflow_cents_scenario ? (
              <>
                {" "}· outflow ranges from{" "}
                <span title="Pace-aware EOM extrapolation of this month — committed bills as one-shot, variable extrapolated by pace.">
                  ${(data.monthly_outflow_cents_optimistic / 100).toFixed(0)}/mo (current pace)
                </span>
                {" "}to{" "}
                <span title="90-day rolling outflow average — inflated by rent-timing artifacts and elevated past-month spending.">
                  ${(data.monthly_outflow_cents_scenario / 100).toFixed(0)}/mo (90-day avg)
                </span>
              </>
            ) : (
              <>
                {", "}${(data.monthly_outflow_cents_scenario / 100).toFixed(0)}/mo outflow
              </>
            )}
            ,{" "}and a{" "}
            <span title="Post-inflation real return — the same default the FIRE projection panel uses, so the two projections agree.">
              {(data.investment_apy * 100).toFixed(0)}% real annual return
            </span>{" "}
            on investments. Drag the sliders below to model what-ifs.
          </p>
          {/* Sprint J-fix3 — starting-balance breakdown so the user
              can see exactly which accounts feed the projection. Linked
              from the user question "is it using my actual savings?". */}
          <p className="text-[10px] text-text-muted mt-1 tabular-nums leading-relaxed">
            <span className="font-semibold uppercase tracking-wider">Starting net worth:</span>{" "}
            <span
              className={data.starting_net_cents >= 0 ? "text-text font-semibold" : "text-outflow font-semibold"}
              title="Sum of all linked Checking + Savings + Investment account balances, minus credit-card and loan liabilities."
            >
              {fmtCents(data.starting_net_cents)}
            </span>
            {" "}
            <span className="text-text-soft">
              ( Checking {fmtCents(data.starting_checking_cents)}
              {" · "}Savings {fmtCents(data.starting_savings_cents)}
              {" · "}Investments {fmtCents(data.starting_investment_cents)}
              {" · "}Liabilities −{fmtCents(data.liability_cents)} )
            </span>
            {" "}
            <span
              className="text-text-soft italic"
              title="Holdings (stocks, ETFs, mutual fund shares tracked separately from cash balances) are not currently included in the projection's starting balance. If you have meaningful holdings on the Holdings panel, the real starting net worth is higher than shown."
            >
              · holdings not included
            </span>
          </p>
        </div>
        {/* Scenario delta chip — only shown when overrides differ from baseline. */}
        <div className="flex items-center gap-2">
          {(isAheadOfBaseline || isBehindBaseline) && (
            <div
              className={`px-3 py-1.5 rounded-md text-xs font-semibold ${
                isAheadOfBaseline
                  ? "bg-emerald-50 text-inflow border border-inflow/30"
                  : "bg-red-50 text-outflow border border-outflow/30"
              }`}
            >
              {isAheadOfBaseline ? "+" : "−"}
              {fmtCents(Math.abs(data.scenario_vs_baseline_net_cents))} vs status quo
            </div>
          )}
          {hasOverrides && onReset && (
            <button
              onClick={onReset}
              className="px-3 py-1.5 text-xs font-semibold text-text-muted hover:text-text border border-border rounded-md hover:border-text-muted transition-colors"
              title="Clear all applied recommendations and slider overrides"
            >
              Reset to status quo
            </button>
          )}
        </div>
      </div>

      {/* Headline figures: 3mo / 12mo / 24mo.
          Sprint J-fix — each card shows both projections as a range
          when optimistic_points are available. The optimistic number
          leads (more honest, less rent-timing-inflated) with the
          conservative number as a sub-line for context. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
        <ProjectionHeadlineCard
          label="3 months"
          valueCents={headlines.m3}
          optimisticCents={headlines.m3_opt}
          startCents={data.starting_net_cents}
        />
        <ProjectionHeadlineCard
          label="12 months"
          valueCents={headlines.m12}
          optimisticCents={headlines.m12_opt}
          startCents={data.starting_net_cents}
        />
        <ProjectionHeadlineCard
          label="24 months"
          valueCents={headlines.m24}
          optimisticCents={headlines.m24_opt}
          startCents={data.starting_net_cents}
          // Sprint J-fix2 — explain why growth is slow/fast on the
          // longest-horizon card. The optimistic monthly net flow is
          // the most relevant number here because it's what compounds.
          explainerMonthlyNetFlow={
            headlines.monthlyNetFlowOpt ?? headlines.monthlyNetFlow
          }
        />
      </div>

      {/* Negative-trajectory warning. Sprint J-fix — range-aware:
          - If the OPTIMISTIC case stays positive, the warning is the
            milder "Conservative case projects negative" framing.
          - If BOTH cases project negative, escalate to the strong
            "Even the optimistic case goes negative" framing.
          - If only the conservative case is negative and we have no
            optimistic comparison, fall back to legacy phrasing.
       */}
      {headlines.brokeMonth != null && headlines.monthlyNetFlow < 0 && (
        <div
          className={`mb-4 rounded-md border px-4 py-3 flex items-start gap-3 ${
            headlines.optBrokeMonth != null
              ? "bg-red-50 border-outflow/30"
              : "bg-amber-50 border-warn/40"
          }`}
        >
          <span className="text-lg leading-none" aria-hidden="true">
            {headlines.optBrokeMonth != null ? "🚨" : "⚠️"}
          </span>
          <div className="flex-1">
            <div
              className={`text-sm font-semibold ${
                headlines.optBrokeMonth != null ? "text-outflow" : "text-warn"
              }`}
            >
              {headlines.optBrokeMonth != null ? (
                <>
                  Heads up — your net worth trends negative either way. At
                  this month's pace it crosses zero around month{" "}
                  {headlines.optBrokeMonth}
                  {headlines.optBrokeMonth >= 12
                    ? ` (${(headlines.optBrokeMonth / 12).toFixed(1)} years)`
                    : ` (${headlines.optBrokeMonth} months)`}
                  ; on your 90-day-average spending, around month{" "}
                  {headlines.brokeMonth}.
                </>
              ) : headlines.monthlyNetFlowOpt != null &&
                headlines.monthlyNetFlowOpt >= 0 ? (
                <>
                  Your 90-day-average spending trends negative — it crosses
                  zero around month {headlines.brokeMonth}. At this month's
                  actual pace you're closer to breakeven.
                </>
              ) : (
                <>
                  Heads up — at this pace you'll go negative around month{" "}
                  {headlines.brokeMonth}{" "}
                  ({headlines.brokeMonth >= 12
                    ? `${(headlines.brokeMonth / 12).toFixed(1)} years`
                    : `${headlines.brokeMonth} months`}
                  ).
                </>
              )}
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              Monthly net flow is{" "}
              <span className="text-outflow font-semibold">
                {fmtCents(headlines.monthlyNetFlow)}
              </span>
              . Cut ~{fmtCents(Math.abs(headlines.monthlyNetFlow))}/mo or earn
              that much more to break even. The recommendations below have
              specific suggestions.
            </div>
          </div>
        </div>
      )}

      {/* Chart — receives the animated arrays so the line transition
          matches the headline-card transition pixel-for-millisecond. */}
      <div className="overflow-x-auto">
        <ProjectionChart
          scenario={animatedScenario.length > 0 ? animatedScenario : data.scenario_points}
          baseline={animatedBaseline.length > 0 ? animatedBaseline : data.baseline_points}
          optimistic={data.optimistic_points ?? null}
          width={720}
          height={320}
        />
      </div>
    </div>
  );
}

function ProjectionHeadlineCard({
  label,
  valueCents,
  optimisticCents,
  startCents,
  explainerMonthlyNetFlow,
}: {
  label: string;
  /** Conservative case (90-day rolling outflow). */
  valueCents: number;
  /** Sprint J-fix — optimistic case (pace-aware EOM math). When null,
   *  the card collapses to a single number (legacy behavior). */
  optimisticCents?: number | null;
  startCents: number;
  /** Sprint J-fix2 — when provided, the card shows a one-liner under
   *  the numbers explaining the implied growth rate. Set this on the
   *  24mo card so users don't wonder why a flat line is, well, flat. */
  explainerMonthlyNetFlow?: number | null;
}) {
  const hasRange =
    optimisticCents != null && optimisticCents !== valueCents;
  // When we have a range, the LEAD number is the optimistic (more
  // honest forward-look) with conservative below. Both cards still
  // color-code by their own sign.
  const primary = hasRange ? optimisticCents! : valueCents;
  const secondary = hasRange ? valueCents : null;

  const primaryNeg = primary < 0;
  const secondaryNeg = secondary != null && secondary < 0;
  const primaryDelta = primary - startCents;
  const primaryDeltaPos = primaryDelta > 0;

  // Overall card tone: red only if BOTH cases project negative; amber
  // if only the conservative is negative; otherwise neutral.
  const bothNeg = primaryNeg && (secondary != null ? secondaryNeg : true);
  const onlyConservativeNeg =
    !primaryNeg && secondary != null && secondaryNeg;
  const cardBorderBg = bothNeg
    ? "border-outflow/30 bg-red-50/40"
    : onlyConservativeNeg
    ? "border-warn/30 bg-amber-50/30"
    : "border-border bg-bg/30";

  return (
    <div className={`p-3 rounded-md border ${cardBorderBg}`}>
      <div className="text-[11px] text-text-muted uppercase tracking-wide font-semibold">
        In {label}
      </div>
      <div
        className={`text-2xl font-semibold tabular-nums mt-1 ${
          primaryNeg ? "text-outflow" : "text-text"
        }`}
        title={hasRange ? "Projected from this month's spending pace" : undefined}
      >
        {fmtCents(primary)}
      </div>
      {hasRange ? (
        <>
          <div className="text-[10px] text-text-soft mt-0.5 uppercase tracking-wide">
            at this month's pace
          </div>
          <div
            className={`text-[12px] tabular-nums mt-1 font-semibold ${
              secondaryNeg ? "text-outflow/80" : "text-text"
            }`}
            title="The other line — your 90-day-average spending projected forward."
          >
            {fmtCents(secondary!)}{" "}
            <span className="text-[10px] font-normal text-text-soft uppercase tracking-wide">
              on 90-day average
            </span>
          </div>
        </>
      ) : (
        <div className="text-[11px] tabular-nums mt-1">
          <span className={primaryDeltaPos ? "text-inflow" : "text-outflow"}>
            {primaryDeltaPos ? "+" : "−"}
            {fmtCents(Math.abs(primaryDelta))}
          </span>
          <span className="text-text-soft"> vs today</span>
        </div>
      )}

      {/* Sprint J-fix2 — explainer for slow/fast growth. Renders only
          when explainerMonthlyNetFlow is provided (typically just the
          24mo card). Helps the user understand WHY a flat optimistic
          line is flat instead of being mysterious about it. */}
      {explainerMonthlyNetFlow != null && (
        (() => {
          const flow = explainerMonthlyNetFlow;
          const abs = Math.abs(flow);
          let text: string;
          let cls: string;
          if (flow < -100_00) {
            text = `Net worth shrinking because you're burning ~${fmtCents(abs)}/mo. The recommendations below can flip this.`;
            cls = "text-outflow";
          } else if (flow < 100_00) {
            text = `Slow growth because you're saving only ~${fmtCents(abs)}/mo at this pace. Use the sliders below to model cuts and watch this number climb.`;
            cls = "text-text-soft";
          } else if (flow < 1000_00) {
            text = `Saving ~${fmtCents(abs)}/mo at this pace. Steady but not aggressive — sliders below let you model bigger cuts.`;
            cls = "text-text-soft";
          } else {
            text = `Strong pace — saving ~${fmtCents(abs)}/mo. This is what compounds into the 24-month number.`;
            cls = "text-inflow";
          }
          return (
            <div
              className={`text-[10px] mt-2 pt-2 border-t border-border/70 leading-snug ${cls}`}
            >
              {text}
            </div>
          );
        })()
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  G-6 — What-if category sliders                                      */
/* ------------------------------------------------------------------ */

/**
 * Per-category sliders that let the user fine-tune the projection
 * scenario beyond what the smart recommendations cover. Each slider:
 *
 *   - Anchors at the category's status-quo monthly spend (rolling avg)
 *   - Ranges from $0 up to 2× the rolling avg
 *   - Shows the current budget cap as a small tick marker
 *   - Shows the delta vs status quo in real time
 *
 * Slider state changes are debounced (200ms) before being lifted into
 * the parent's whatIfOverrides — without that, dragging would fire
 * a dozen API calls per second.
 */
function WhatIfSliders({
  categories,
  goals,
  overrides,
  onChange,
  goalContributions,
  onGoalContributionsChange,
}: {
  categories: import("./api/client").CategoryBaseline[];
  goals: import("./api/client").GoalBaseline[];
  overrides: Record<number, number> | null;
  onChange: (next: Record<number, number> | null) => void;
  goalContributions: Record<number, number>;
  onGoalContributionsChange: (next: Record<number, number>) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  // Local draft state so dragging is snappy. Pushed up to the parent
  // via a debounced effect so the API doesn't get hammered.
  const [draft, setDraft] = useState<Record<number, number>>(overrides ?? {});
  // G-11 — per-goal contribution drafts. Mirrors the parent's
  // goalContributions map but with the dragging-snappy local state.
  const [goalDraft, setGoalDraft] = useState<Record<number, number>>(goalContributions);

  // Keep local in sync when the parent state changes (e.g. user
  // clicked Reset or applied a recommendation).
  useEffect(() => {
    setDraft(overrides ?? {});
  }, [overrides]);
  useEffect(() => {
    setGoalDraft(goalContributions);
  }, [goalContributions]);

  // Debounced push. 200ms is fast enough to feel live, slow enough
  // to not spam the project endpoint while the user is dragging.
  useEffect(() => {
    const t = setTimeout(() => {
      const cleaned: Record<number, number> = {};
      for (const c of categories) {
        if (draft[c.id] !== undefined && draft[c.id] !== c.monthly_cents) {
          cleaned[c.id] = draft[c.id];
        }
      }
      const next = Object.keys(cleaned).length > 0 ? cleaned : null;
      onChange(next);
    }, 200);
    return () => clearTimeout(t);
  }, [draft, categories, onChange]);

  // G-11 — debounced goal-contribution push.
  useEffect(() => {
    const t = setTimeout(() => {
      // Drop zero entries so the projection request stays clean.
      const cleaned: Record<number, number> = {};
      for (const [k, v] of Object.entries(goalDraft)) {
        if (v > 0) cleaned[Number(k)] = v;
      }
      // Stable identity check to avoid infinite loop if both maps empty.
      const sameKeys =
        Object.keys(cleaned).length === Object.keys(goalContributions).length &&
        Object.keys(cleaned).every(
          (k) => goalContributions[Number(k)] === cleaned[Number(k)],
        );
      if (!sameKeys) onGoalContributionsChange(cleaned);
    }, 200);
    return () => clearTimeout(t);
  }, [goalDraft, goalContributions, onGoalContributionsChange]);

  if (categories.length === 0 && goals.length === 0) {
    return null;
  }

  // Top 12 by spend by default — long tail expands.
  const visible = showAll ? categories : categories.slice(0, 12);

  return (
    <div className="bg-card border border-border rounded-md shadow-card p-5 mb-6">
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text">What-if sliders</h3>
          <p className="text-[11px] text-text-soft mt-0.5">
            Drag any category to model a different spending level. The projection
            chart above updates in real time. Sliders start at your 3-month average;
            the dot is your current budget cap.
          </p>
        </div>
      </div>

      {/* G-11 — per-goal contribution sliders. One slider per active
          goal so the user can fund multiple goals at once and see how
          they compose in the projection. If they have no Goals set up,
          we show nothing here — sliders without goals would be a
          floating "monthly auto-invest" with no purpose. */}
      {goals.length > 0 && (
        <div className="mb-5 p-4 bg-emerald-50/40 border border-inflow/20 rounded-md">
          <div className="flex items-baseline justify-between mb-3">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wide text-inflow">
                Goal funding
              </span>
              <div className="text-xs text-text-muted mt-0.5">
                Each month, sweep these amounts from checking → investments. Each goal funds independently. Compounds at 7%.
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wide text-text-soft">Total</div>
              <div className="text-base font-semibold text-inflow tabular-nums">
                {fmtCents(
                  Object.values(goalDraft).reduce((s, v) => s + v, 0),
                )}/mo
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
            {goals.map((g) => (
              <GoalSliderRow
                key={g.id}
                goal={g}
                value={goalDraft[g.id] ?? 0}
                onChange={(v) =>
                  setGoalDraft((d) => ({ ...d, [g.id]: v }))
                }
                onReset={() =>
                  setGoalDraft((d) => {
                    const next = { ...d };
                    delete next[g.id];
                    return next;
                  })
                }
              />
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
        {visible.map((cat) => (
          <SliderRow
            key={cat.id}
            category={cat}
            value={draft[cat.id] ?? cat.monthly_cents}
            onChange={(v) =>
              setDraft((d) => ({ ...d, [cat.id]: v }))
            }
            onReset={() =>
              setDraft((d) => {
                const next = { ...d };
                delete next[cat.id];
                return next;
              })
            }
          />
        ))}
      </div>

      {categories.length > 12 && (
        <button
          onClick={() => setShowAll((s) => !s)}
          className="mt-3 text-xs text-brand-navy hover:underline font-semibold"
        >
          {showAll
            ? "Show top 12 only"
            : `Show all ${categories.length} categories →`}
        </button>
      )}
    </div>
  );
}

function GoalSliderRow({
  goal,
  value,
  onChange,
  onReset,
}: {
  goal: import("./api/client").GoalBaseline;
  value: number;
  onChange: (cents: number) => void;
  onReset: () => void;
}) {
  // Range: $0 .. 1.5× needed-monthly (the cap the rec engine computes).
  // Capping at 1.5× means a user can over-fund to hit the goal faster.
  const maxCents = Math.max(goal.needed_monthly_cents * 1.5, 50000);
  const stepCents = Math.max(500, Math.floor(maxCents / 100));
  const isOverridden = value > 0;
  // Position of the "needed to hit on time" marker.
  const neededPct = goal.needed_monthly_cents > 0
    ? Math.min(100, (goal.needed_monthly_cents / maxCents) * 100)
    : null;
  // Computed: at the current contribution, how long until the goal is
  // fully funded? Useful "you'd hit this by..." copy.
  const gap = goal.target_amount_cents - goal.current_amount_cents;
  const monthsToHit = value > 0 ? Math.ceil(gap / value) : null;
  return (
    <div className="text-sm">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-medium text-text truncate" title={goal.name}>
            {goal.name}
          </span>
          {isOverridden && (
            <button
              onClick={onReset}
              className="text-[10px] text-text-soft hover:text-text-muted underline"
              title="Set this goal back to $0/mo"
            >
              clear
            </button>
          )}
        </div>
        <span className="tabular-nums text-text font-semibold">
          {fmtCents(value)}
          <span className="text-text-soft text-[11px] font-normal">/mo</span>
        </span>
      </div>
      <div className="relative">
        <input
          type="range"
          min={0}
          max={maxCents}
          step={stepCents}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className={`w-full ${value >= goal.needed_monthly_cents ? "accent-inflow" : isOverridden ? "accent-warn" : "accent-brand"}`}
          aria-label={`${goal.name} monthly contribution slider`}
        />
        {neededPct !== null && (
          <div
            className="absolute top-0 -mt-0.5 w-1.5 h-3 bg-inflow rounded-sm pointer-events-none"
            style={{ left: `${neededPct}%`, transform: "translateX(-50%)" }}
            title={`Needed to hit on time: ${fmtCents(goal.needed_monthly_cents)}/mo`}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="flex justify-between text-[10px] text-text-soft tabular-nums mt-0.5">
        <span>
          Need {fmtCents(goal.needed_monthly_cents)}/mo
          {goal.months_left ? ` to hit ${goal.target_date ?? "target"} (${goal.months_left}mo)` : ""}
        </span>
        <span className={monthsToHit && monthsToHit <= (goal.months_left ?? Infinity) ? "text-inflow font-semibold" : ""}>
          {monthsToHit !== null && monthsToHit !== Infinity
            ? `Hits target in ${monthsToHit}mo`
            : "—"}
        </span>
      </div>
    </div>
  );
}

function SliderRow({
  category,
  value,
  onChange,
  onReset,
}: {
  category: import("./api/client").CategoryBaseline;
  value: number;
  onChange: (cents: number) => void;
  onReset: () => void;
}) {
  // Range: $0 .. 2x rolling avg, snapped to $5 increments for usability.
  const maxCents = Math.max(category.monthly_cents * 2, 10000);
  const stepCents = Math.max(500, Math.floor(maxCents / 100)); // ~100 steps
  const delta = value - category.monthly_cents;
  const isCut = delta < 0;
  const isOverridden = value !== category.monthly_cents;
  // Position of the budget-cap marker as a fraction of the slider track.
  const capPct = category.budget_cap_cents > 0
    ? Math.min(100, (category.budget_cap_cents / maxCents) * 100)
    : null;

  return (
    <div className="text-sm">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-medium text-text truncate" title={category.name}>
            {category.name}
          </span>
          {isOverridden && (
            <button
              onClick={onReset}
              className="text-[10px] text-text-soft hover:text-text-muted underline"
              title="Reset this category to status quo"
            >
              reset
            </button>
          )}
        </div>
        <span className="tabular-nums text-text font-semibold">
          {fmtCents(value)}
          <span className="text-text-soft text-[11px] font-normal">/mo</span>
        </span>
      </div>
      <div className="relative">
        <input
          type="range"
          min={0}
          max={maxCents}
          step={stepCents}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className={`w-full ${isCut ? "accent-inflow" : isOverridden ? "accent-warn" : "accent-brand"}`}
          aria-label={`${category.name} monthly spend slider`}
        />
        {/* Budget cap marker — small dot at the cap position. */}
        {capPct !== null && (
          <div
            className="absolute top-0 -mt-0.5 w-1.5 h-3 bg-text-muted rounded-sm pointer-events-none"
            style={{ left: `${capPct}%`, transform: "translateX(-50%)" }}
            title={`Your cap: ${fmtCents(category.budget_cap_cents)}`}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="flex justify-between text-[10px] text-text-soft tabular-nums mt-0.5">
        <span>
          Status quo: {fmtCents(category.monthly_cents)}
        </span>
        <span className={isCut ? "text-inflow font-semibold" : delta > 0 ? "text-outflow" : ""}>
          {delta !== 0 && (
            <>
              {isCut ? "−" : "+"}
              {fmtCents(Math.abs(delta))}/mo
            </>
          )}
        </span>
      </div>
    </div>
  );
}

/** Thin wrapper that fetches the projection (which contains the
 *  per-category baseline) and hands the categories to the slider grid.
 *  Kept separate from the BudgetProjection rendering so the slider's
 *  draft state doesn't trigger a re-render of the chart on every drag.
 */
function WhatIfSlidersFromAPI(props: {
  overrides: Record<number, number> | null;
  onChange: (next: Record<number, number> | null) => void;
  goalContributions: Record<number, number>;
  onGoalContributionsChange: (next: Record<number, number>) => void;
}) {
  // Status-quo projection request — we only need the categories + goals lists.
  const q = useQuery({
    queryKey: ["budgetProjectionCategories"],
    queryFn: () =>
      api.budgetProject({ months: 1, include_baseline: false }),
    staleTime: 5 * 60 * 1000,
  });
  if (q.isLoading || !q.data) return null;
  if (q.data.categories.length === 0 && (q.data.goals ?? []).length === 0) return null;
  return (
    <WhatIfSliders
      categories={q.data.categories}
      goals={q.data.goals ?? []}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  G-5 — Smart recommendation cards                                    */
/* ------------------------------------------------------------------ */

const REC_KIND_META: Record<
  string,
  { label: string; icon: string; bg: string; text: string; border: string }
> = {
  overspend: {
    label: "Overspend",
    icon: "✂️",
    bg: "bg-amber-50/60",
    text: "text-warn",
    border: "border-warn/30",
  },
  goal: {
    label: "Goal",
    icon: "🎯",
    bg: "bg-blue-50/60",
    text: "text-brand-navy",
    border: "border-brand/30",
  },
  bundle_dup: {
    label: "Already bundled",
    icon: "🪢",
    bg: "bg-purple-50/60",
    text: "text-purple-700",
    border: "border-purple-300",
  },
  // G-12 — receipt-driven cross-store-swap recommendation.
  store_swap: {
    label: "Switch stores",
    icon: "🛒",
    bg: "bg-cyan-50/60",
    text: "text-cyan-800",
    border: "border-cyan-300",
  },
  yield_shift: {
    label: "Free yield",
    icon: "📈",
    bg: "bg-emerald-50/60",
    text: "text-inflow",
    border: "border-inflow/30",
  },
};

function BudgetRecommendations({
  onApply,
  appliedKeys,
}: {
  onApply: (rec: BudgetRecommendation) => void;
  appliedKeys: Set<string>;
}) {
  const recs = useQuery({
    queryKey: ["budgetRecommendations"],
    queryFn: api.budgetRecommendations,
    staleTime: 5 * 60 * 1000,
  });

  if (recs.isLoading) {
    return (
      <div className="bg-card border border-border rounded-md shadow-card p-5 mb-6">
        <h3 className="text-sm font-semibold text-text">Smart recommendations</h3>
        <p className="text-xs text-text-muted mt-3">Analyzing your spend patterns…</p>
      </div>
    );
  }
  if (recs.isError || !recs.data) {
    return null;
  }
  const data = recs.data;
  if (data.recommendations.length === 0) {
    return (
      <div className="bg-card border border-border rounded-md shadow-card p-5 mb-6">
        <h3 className="text-sm font-semibold text-text">Smart recommendations</h3>
        <p className="text-xs text-text-muted mt-3">
          You're tracking close to your budgets — no high-impact moves to flag right now.
          Categories climb back into this list if rolling spend exceeds your cap.
        </p>
      </div>
    );
  }

  // Limit to the top 6 recs by default — the long tail of low-impact
  // suggestions can be expanded.
  const [showAll, setShowAll] = [false, () => {}]; // placeholder; will be a state hook below

  return (
    <BudgetRecommendationsList
      data={data}
      onApply={onApply}
      appliedKeys={appliedKeys}
    />
  );
}

/** Inner stateful component so the parent stays simple. */
function BudgetRecommendationsList({
  data,
  onApply,
  appliedKeys,
}: {
  data: { recommendations: BudgetRecommendation[]; total_potential_monthly_savings_cents: number; total_potential_annual_savings_cents: number };
  onApply: (rec: BudgetRecommendation) => void;
  appliedKeys: Set<string>;
}) {
  const [showAll, setShowAll] = useState(false);
  const total = data.recommendations.length;
  const visible = showAll ? data.recommendations : data.recommendations.slice(0, 6);

  return (
    <div className="bg-card border border-border rounded-md shadow-card p-5 mb-6">
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text">Smart recommendations</h3>
          <p className="text-[11px] text-text-soft mt-0.5">
            Top moves to free up monthly cash, ranked by impact. Click{" "}
            <span className="font-semibold text-brand-navy">Apply to scenario</span>{" "}
            to model the change in the projection chart above.
          </p>
        </div>
        {data.total_potential_monthly_savings_cents > 0 && (
          <div className="text-right">
            <div className="text-[10px] text-text-soft uppercase tracking-wide">
              All recs combined
            </div>
            <div className="text-base font-semibold text-inflow tabular-nums">
              up to {fmtCents(data.total_potential_monthly_savings_cents)}/mo
            </div>
            <div className="text-[11px] text-text-muted tabular-nums">
              ≈ {fmtCents(data.total_potential_annual_savings_cents)}/yr
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {visible.map((rec, i) => {
          const meta = REC_KIND_META[rec.kind] ?? REC_KIND_META.overspend;
          const recKey = `${rec.kind}-${rec.title}`;
          const isApplied = appliedKeys.has(recKey);
          const canApply = rec.apply != null;
          return (
            <div
              key={recKey}
              className={`p-3 rounded-md border ${meta.border} ${meta.bg} flex items-start gap-3`}
            >
              <div
                className={`text-2xl leading-none flex-shrink-0`}
                aria-hidden="true"
              >
                {meta.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-2 mb-1">
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wide ${meta.text}`}
                  >
                    {meta.label}
                  </span>
                  <span className="text-sm font-semibold text-inflow tabular-nums">
                    {fmtCents(rec.expected_monthly_impact_cents)}/mo
                  </span>
                </div>
                <div className="text-sm font-semibold text-text leading-tight">
                  {rec.title}
                </div>
                <div className="text-[11px] text-text-muted mt-1 leading-relaxed">
                  {rec.body}
                </div>
                {canApply && (
                  <button
                    onClick={() => onApply(rec)}
                    disabled={isApplied}
                    className={`mt-2 px-3 py-1 text-xs font-semibold rounded border transition-colors ${
                      isApplied
                        ? "border-inflow bg-inflow text-white cursor-default"
                        : "border-brand text-brand-navy hover:bg-brand hover:text-white"
                    }`}
                  >
                    {isApplied ? "✓ Applied to scenario" : "Apply to scenario →"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {total > 6 && (
        <button
          onClick={() => setShowAll((s) => !s)}
          className="mt-3 text-xs text-brand-navy hover:underline font-semibold"
        >
          {showAll ? `Show top 6 only` : `Show all ${total} recommendations →`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// BudgetDonuts retired 2026-05-13 (FU-5).
// Replaced by BudgetVisualization (4-view toggle + drawer click-through).
// See `web/src/components/BudgetVisualization.tsx`.
// ---------------------------------------------------------------------

/* ------------------------------------------------------------------ */
/*  Panel                                                              */
/* ------------------------------------------------------------------ */

export default function BudgetsPanel() {
  const qc = useQueryClient();
  const [monthStart, setMonthStart] = useState<string>(currentMonthStart());
  const [lastTemplateResult, setLastTemplateResult] =
    useState<BudgetTemplateResult | null>(null);
  // Sprint M-5 — drag-and-drop "Manage categories" modal.
  const [reparentOpen, setReparentOpen] = useState(false);
  // Wave G — what-if override state. Keyed by category_id; values
  // are NEW monthly cents that replace the baseline for that category
  // in the projection's outflow math. G-6 sliders + G-5 recs both
  // mutate this. Initial null means "status quo, no overrides".
  const [whatIfOverrides, setWhatIfOverrides] =
    useState<Record<number, number> | null>(null);
  // G-11 — per-goal monthly contribution. Replaces the single-slider
  // model from G-6. Map of goal_id → monthly_cents. Multiple goal recs
  // compose because each sets its own goal_id; the projector sums them.
  const [goalContributions, setGoalContributions] = useState<Record<number, number>>({});
  // Track which recommendation cards the user has applied so the UI
  // can show ✓ on them. Keyed by `${kind}-${title}` since recs don't
  // currently carry stable IDs.
  const [appliedRecKeys, setAppliedRecKeys] = useState<Set<string>>(new Set());
  // Sprint G-10 — celebration toasts for scenario-positive flip + other
  // "found money" moments. Mounted at the panel root.
  const celebrate = useCelebrate();

  function handleApplyRec(rec: BudgetRecommendation) {
    const recKey = `${rec.kind}-${rec.title}`;
    if (rec.apply) {
      // Category cuts merge into the override map.
      if (Object.keys(rec.apply.category_overrides).length > 0) {
        setWhatIfOverrides((prev) => ({
          ...(prev ?? {}),
          ...rec.apply!.category_overrides,
        }));
      }
      // G-11 — goal recs merge into the per-goal contribution map.
      // Multiple goal recs compose; each one only sets its own goal_id.
      if (rec.apply.goal_contributions && Object.keys(rec.apply.goal_contributions).length > 0) {
        setGoalContributions((prev) => ({
          ...prev,
          ...rec.apply!.goal_contributions,
        }));
      }
    }
    setAppliedRecKeys((prev) => {
      const next = new Set(prev);
      next.add(recKey);
      return next;
    });
  }
  function resetScenario() {
    setWhatIfOverrides(null);
    setGoalContributions({});
    setAppliedRecKeys(new Set());
  }

  const rollup = useQuery({
    queryKey: ["budgetRollup", monthStart],
    queryFn: () => api.budgetRollup(monthStart),
  });
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  // Sprint I — goals feed the GoalPaceCard. Only active ones matter for pacing.
  const goals = useQuery({
    queryKey: ["goals", "active"],
    queryFn: () => api.listGoals({ status: "active" as never }),
  });
  // Sprint L — zero-based assignment ledger. Independent fetch (the
  // backend reads from the same source data but reshapes it into the
  // assignment view). Loads in parallel with the rollup.
  const ledger = useQuery({
    queryKey: ["assignmentLedger", monthStart],
    queryFn: () => api.budgetAssignmentLedger(monthStart),
  });

  const upsert = useMutation({
    mutationFn: api.upsertBudget,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["budgetRollup", monthStart] });
      qc.invalidateQueries({ queryKey: ["budgets"] });
    },
  });
  const destroy = useMutation({
    mutationFn: api.deleteBudget,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["budgetRollup", monthStart] });
    },
  });
  const copyFromPrior = useMutation({
    mutationFn: api.budgetCopyFromPrior,
    onSuccess: (result) => {
      setLastTemplateResult(result);
      qc.invalidateQueries({ queryKey: ["budgetRollup", monthStart] });
      qc.invalidateQueries({ queryKey: ["budgets"] });
    },
  });
  const fillFromAvg = useMutation({
    mutationFn: api.budgetFillFromAverage,
    onSuccess: (result) => {
      setLastTemplateResult(result);
      qc.invalidateQueries({ queryKey: ["budgetRollup", monthStart] });
      qc.invalidateQueries({ queryKey: ["budgets"] });
    },
  });
  const templateBusy = copyFromPrior.isPending || fillFromAvg.isPending;

  const data = rollup.data;
  const rawRows = data?.rows ?? [];
  const unbudgeted = data?.unbudgeted_spending ?? [];

  // Sprint H-3 — synthesize a Savings row from the auto-detected
  // transfers (savings_actual_cents) + goals' monthly targets
  // (savings_goal_target_cents). Use sentinel category_id = -1 so it
  // sorts and renders like any other row in the visualization, but
  // skip it from the bottom Category-budgets table which is
  // backend-CRUD-driven.
  const rows = useMemo(() => {
    if (!data) return rawRows;
    const target = data.savings_goal_target_cents ?? 0;
    const actual = data.savings_actual_cents ?? 0;
    if (target === 0 && actual === 0) return rawRows;
    const synthetic: BudgetRollupRow = {
      category_id: -1,
      category_name: "Savings",
      budget_cents: target > 0 ? target : Math.max(actual, 1),
      actual_outflow_cents: actual,
      remaining_cents: (target > 0 ? target : actual) - actual,
      pct_used:
        target > 0 ? Math.round((actual / target) * 1000) / 10 : 100,
      status:
        target === 0 || actual >= target
          ? "on_track"
          : actual < target * (data.pace ?? 0)
          ? "warning"
          : "on_track",
      effective_budget_cents: target > 0 ? target : Math.max(actual, 1),
      rollover_in_cents: 0,
    };
    return [...rawRows, synthetic];
  }, [data, rawRows]);

  const pct = useMemo(() => {
    if (!data || data.total_budget_cents <= 0) return 0;
    return (data.total_actual_cents / data.total_budget_cents) * 100;
  }, [data]);

  const paceLabel = data ? `${Math.round(data.pace * 100)}% through month` : "";

  // What the overall bar color should be, based on aggregate pacing.
  const overallStatus: BudgetStatus = useMemo(() => {
    if (!data) return "on_track";
    if (data.total_actual_cents > data.total_budget_cents) return "over";
    const used = data.total_budget_cents > 0
      ? data.total_actual_cents / data.total_budget_cents
      : 0;
    if (data.pace > 0 && used / data.pace >= 1.2 && used >= 0.5) return "warning";
    return "on_track";
  }, [data]);

  return (
    <div>
      {/* ---- Month picker + summary ---- */}
      <div className="bg-card border border-border rounded-md shadow-card p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMonthStart(shiftMonthStart(monthStart, -1))}
              className="w-8 h-8 border border-border rounded text-text-muted hover:border-brand hover:text-brand transition-colors"
              title="Previous month"
            >
              ←
            </button>
            <div className="min-w-[10rem] text-center">
              <div className="text-xs text-text-muted uppercase tracking-wide">
                Budget for
              </div>
              <div className="text-lg font-semibold text-text">
                {fmtMonthLong(monthStart)}
              </div>
            </div>
            <button
              onClick={() => setMonthStart(shiftMonthStart(monthStart, 1))}
              className="w-8 h-8 border border-border rounded text-text-muted hover:border-brand hover:text-brand transition-colors"
              title="Next month"
            >
              →
            </button>
            <button
              onClick={() => setMonthStart(currentMonthStart())}
              className="ml-2 text-xs text-brand hover:text-brand-navy font-semibold"
            >
              This month
            </button>
          </div>
          <div className="text-xs text-text-muted">{paceLabel}</div>
        </div>

        {/* Templates row — one-click setup so the user doesn't have to enter
            every category from scratch each month. */}
        <div className="flex flex-wrap items-center gap-2 mb-5 pb-5 border-b border-border">
          <span className="text-[11px] text-text-muted uppercase tracking-wide font-semibold mr-1">
            Templates
          </span>
          <button
            onClick={() =>
              copyFromPrior.mutate({
                target_month_start: monthStart,
                overwrite: false,
              })
            }
            disabled={templateBusy}
            title={`Copy budgets from ${fmtMonthShort(shiftMonthStart(monthStart, -1))} into ${fmtMonthShort(monthStart)}. Existing budgets are preserved.`}
            className="px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
          >
            ← Copy from {fmtMonthShort(shiftMonthStart(monthStart, -1))}
          </button>
          <button
            onClick={() =>
              fillFromAvg.mutate({
                target_month_start: monthStart,
                lookback_months: 3,
                round_up_to_cents: 2_500,
                overwrite: false,
                min_avg_cents: 500,
              })
            }
            disabled={templateBusy}
            title="Average the last 3 months of category spending and pre-fill caps, rounded up to the nearest $25."
            className="px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors disabled:opacity-50"
          >
            Fill from 3-mo average
          </button>
          {/* Sprint M-5 — drag-and-drop category re-parenter */}
          <button
            type="button"
            onClick={() => setReparentOpen(true)}
            title="Open the drag-and-drop board to re-group categories. Useful if you'd rather see, say, Coffee under Food instead of where it's currently grouped."
            className="px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors"
          >
            Manage categories ⇄
          </button>
          {templateBusy && (
            <span className="text-xs text-text-muted">Working…</span>
          )}
          <span className="ml-auto text-[11px] text-text-soft">
            Templates skip categories you've already set — your existing
            budgets stay safe.
          </span>
        </div>

        {/* Result toast — surfaces what the template just did. */}
        {lastTemplateResult && (
          <TemplateResultBanner
            result={lastTemplateResult}
            onDismiss={() => setLastTemplateResult(null)}
          />
        )}

        {/* When the user hasn't set ANY budgets for the current period yet,
            the four-stat hero reads $0/$0/$0/$X — visually inert. Swap to a
            single prominent CTA card that nudges them toward the templates
            (which are right above) instead. */}
        {(data?.total_budget_cents ?? 0) === 0 ? (
          <div className="bg-gradient-to-r from-brand/8 to-inflow/8 border border-brand/30 rounded-md p-5 mb-5 flex items-start gap-4">
            <div className="text-3xl">🎯</div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-text">
                Set up your first budget for {fmtMonthShort(monthStart)}
              </h3>
              <p className="text-xs text-text-muted mt-1 max-w-2xl">
                Pick a template above (Copy from prior / Fill from 3-mo
                average) for a one-click start, or scroll to{" "}
                <span className="font-mono">Unbudgeted spending</span> below
                and click <span className="font-mono">Budget this →</span> on
                the categories that matter to you.
              </p>
              <div className="mt-2 text-[11px] text-text-soft tabular-nums">
                Unbudgeted outflow so far this month:{" "}
                <span className="text-outflow font-semibold">
                  {fmtCents(
                    unbudgeted.reduce((acc, u) => acc + u.actual_outflow_cents, 0)
                  )}
                </span>
              </div>
            </div>
          </div>
        ) : (
          // Sprint I — BudgetHero + BudgetStatStrip replace the 5-card grid.
          // Anchor metric is "Safe to spend this month" with a built-in
          // QuickSpendSimulator. See BudgetHero.tsx for the math story.
          data && (
            <>
              {/* Sprint J-2 — month-end sweep reminder (last week of month
                  with safe-to-spend > $50). Sits above the hero so the
                  CTA is the first thing the user sees on month-end days. */}
              <MonthEndSweepCard
                data={data}
                monthStart={monthStart}
                goals={(goals.data ?? []) as unknown as GoalPaceData[]}
              />
              <BudgetHero data={data} monthStart={monthStart} />
              <BudgetStatStrip data={data} />
              {/* Budget-math breakdown — collapsible "where do Safe to
                  Spend and Available Cash come from" explainer, with both
                  formulas as waterfalls and the bills line itemized. */}
              <BudgetMathCard data={data} />
              {/* EOM breakdown — collapsible "where does the negative
                  projection come from" explainer. Sits right under the
                  StatStrip so it's adjacent to the EOM Projection card
                  that prompts the question. */}
              <EomBreakdownCard data={data} />
              {/* Sprint O-2 — recurring bills table. Sits ABOVE The Plan
                  so the user reads bills → plan → projection top-to-bottom:
                  "here's what I'm locked into → here's the plan for what's
                  left → here's where it lands EOM." */}
              <RecurringBillsCard rollup={data} />
              {/* Sprint L — zero-based assignment ledger. Sits between
                  the stat strip ("what's happening") and the projection
                  ("where it's heading"). Reads as "what's the plan" → so
                  the user sees commitments → drift → outcome top-to-bottom. */}
              {ledger.data && <AssignmentLedgerCard data={ledger.data} />}
            </>
          )
        )}

        {/* Sprint I — aggregate progress bar moved INTO BudgetHero, where
            it sits directly under the anchor metric. Old standalone bar
            removed. */}
      </div>

      {/* ---- G-3: 24-month projection with what-if overlay ---- */}
      <BudgetProjection
        overrides={whatIfOverrides}
        goalContributions={goalContributions}
        onReset={resetScenario}
        celebrate={celebrate.celebrate}
      />

      {/* ---- Sprint I: Wealth Pulse + Goal Pace cards (strategic framing,
              "am I building wealth?" + "when can I afford X?") ---- */}
      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-6">
          <WealthPulseCard data={data} />
          <GoalPaceCard
            goals={(goals.data ?? []) as unknown as GoalPaceData[]}
            currentSavingsActualCents={
              (data.savings_actual_cents ?? 0) > 0
                ? (data.savings_actual_cents ?? 0)
                : (data.savings_goal_target_cents ?? 0) // optimistic — assume on pace if no actual yet
            }
          />
        </div>
      )}

      {/* ---- G-5: Smart recommendations ---- */}
      <BudgetRecommendations
        onApply={handleApplyRec}
        appliedKeys={appliedRecKeys}
      />

      {/* ---- G-6 + G-11: What-if sliders w/ multi-goal contribution ---- */}
      <WhatIfSlidersFromAPI
        overrides={whatIfOverrides}
        onChange={setWhatIfOverrides}
        goalContributions={goalContributions}
        onGoalContributionsChange={setGoalContributions}
      />

      {/* ---- H-4b: Top 5 spending this month (above the viz so the
              user gets the answer to "where's my money going" before
              they scan the chart) ---- */}
      {data && (rows.length > 0 || unbudgeted.length > 0) && (
        <TopSpendingCard
          rows={rows}
          unbudgeted={unbudgeted}
          totalSpent={data.total_actual_cents}
          momCompare={data.mom_compare}
        />
      )}

      {/* ---- G-1 / G-16: Donut + Bars + Treemap + Sunburst with
              click-through CategoryDrawer.  Replaces the old two-donut
              block — same data, four visualizations swipe-able with
              chip toggle / arrow keys / touch swipe.
              H-4a: MoM chips wired through to every legend row. ---- */}
      {data && (rows.length > 0 || unbudgeted.length > 0) && (
        <BudgetVisualization
          rows={rows}
          unbudgeted={unbudgeted}
          totalBudget={data.real_budget_cents ?? data.total_budget_cents}
          totalSpent={data.total_actual_cents}
          monthStart={monthStart}
          momCompare={data.mom_compare}
          rentAttributedTxIds={data.rent_attributed_tx_ids ?? []}
        />
      )}

      {/* ---- Budget rows ---- */}
      <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 bg-hover border-b border-border">
          <h3 className="text-sm font-semibold text-text">Category budgets</h3>
          {cats.data && (
            <AddBudgetForm
              unbudgeted={unbudgeted}
              allCategories={cats.data}
              onAdd={(category_id, amount_cents) =>
                upsert.mutate({
                  category_id,
                  month_start: monthStart,
                  amount_cents,
                })
              }
            />
          )}
        </div>
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left w-1/4">Category</th>
              <th className="px-4 py-2 text-right w-1/12">Budget</th>
              <th className="px-4 py-2 text-right w-1/12">Spent</th>
              <th className="px-4 py-2 text-right w-1/12">Remaining</th>
              <th className="px-4 py-2 text-left">Progress</th>
              <th className="px-4 py-2 text-left w-1/12">Status</th>
              {/* Sprint G — axe best-practice: empty <th> flagged. Add an SR-only
                  label so screen readers announce the actions column. */}
              <th className="px-4 py-2 w-1/12">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rollup.isLoading && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-text-muted text-sm">
                  Loading…
                </td>
              </tr>
            )}
            {rollup.data && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-text-muted text-sm">
                  No budgets set for {fmtMonthLong(monthStart)}. Add one above —
                  start with whatever shows up in Unbudgeted spending below.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const rolloverIn = r.rollover_in_cents ?? 0;
              const effective = r.effective_budget_cents ?? r.budget_cents;
              return (
              <tr key={r.category_id} className="border-b border-border last:border-0 hover:bg-hover">
                <td className="px-4 py-3 text-sm font-medium">
                  <div className="flex items-center gap-2">
                    <span>{r.category_name}</span>
                    {rolloverIn !== 0 && (
                      <span
                        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-brand-light text-brand"
                        title={
                          rolloverIn > 0
                            ? `+${fmtCents(rolloverIn)} carried in from prior months`
                            : `${fmtCents(rolloverIn)} deficit carried in from prior months`
                        }
                      >
                        ↻ rollover
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  <BudgetAmountCell
                    row={r}
                    onSave={(amount_cents) =>
                      upsert.mutate({
                        category_id: r.category_id,
                        month_start: monthStart,
                        amount_cents,
                      })
                    }
                  />
                  {rolloverIn !== 0 && (
                    <>
                      <div
                        className={`text-[10px] mt-0.5 tabular-nums ${rolloverIn > 0 ? "text-inflow" : "text-outflow"}`}
                      >
                        {rolloverIn > 0 ? "+" : "−"}
                        {fmtCents(Math.abs(rolloverIn))} rolled in
                      </div>
                      <div className="text-[10px] text-text-muted mt-0.5 tabular-nums">
                        effective: {fmtCents(effective)}
                      </div>
                    </>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-sm text-outflow font-semibold">
                  {fmtCents(r.actual_outflow_cents)}
                </td>
                <td
                  className={`px-4 py-3 text-right tabular-nums text-sm font-semibold ${
                    r.remaining_cents >= 0 ? "text-inflow" : "text-outflow"
                  }`}
                >
                  {fmtCents(r.remaining_cents)}
                </td>
                <td className="px-4 py-3 w-1/4">
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <ProgressBar pct={r.pct_used} status={r.status} />
                    </div>
                    <span className="text-[11px] text-text-muted tabular-nums w-10 text-right">
                      {r.pct_used.toFixed(0)}%
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${STATUS_BADGE[r.status]}`}
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  {/* We need the Budget row's id to delete, not the rollup row.
                      For now we fetch the budget row via a separate call if
                      the user clicks delete — keeps the rollup response slim.
                      TODO: surface budget_id in BudgetRollupRow so this is one click. */}
                  <button
                    onClick={async () => {
                      const list = await api.listBudgets(monthStart);
                      const b = list.find((x) => x.category_id === r.category_id);
                      if (b) destroy.mutate(b.id);
                    }}
                    className="text-xs text-text-muted hover:text-outflow"
                    title="Remove this budget"
                  >
                    Remove
                  </button>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ---- Unbudgeted spending (blind spots) ---- */}
      {unbudgeted.length > 0 && (
        <div className="mt-6 bg-card border border-border rounded-md shadow-card overflow-hidden">
          <div className="px-4 py-3 bg-hover border-b border-border">
            <h3 className="text-sm font-semibold text-text">
              Unbudgeted spending
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              Categories with money going out but no cap — blind spots.
              Click <em>Add budget</em> above to set a cap, or ignore if
              these are intentionally un-policed.
            </p>
          </div>
          <table className="w-full">
            <tbody>
              {unbudgeted.map((u) => (
                <tr
                  key={u.category_id}
                  className="border-b border-border last:border-0 hover:bg-hover"
                >
                  <td className="px-4 py-3 text-sm font-medium">
                    {u.category_name}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-sm text-outflow font-semibold w-32">
                    {fmtCents(u.actual_outflow_cents)}
                  </td>
                  <td className="px-4 py-3 text-right w-32">
                    {u.category_id > 0 ? (
                      <button
                        onClick={() => {
                          // Default the cap at roughly-current-spend rounded
                          // up to the nearest $25 — a sensible starting point
                          // the user can edit after creation.
                          const ceil25 =
                            Math.ceil(u.actual_outflow_cents / 2500) * 2500;
                          upsert.mutate({
                            category_id: u.category_id,
                            month_start: monthStart,
                            amount_cents: Math.max(ceil25, 2500),
                          });
                        }}
                        className="text-xs text-brand hover:text-brand-navy font-semibold"
                      >
                        Budget this →
                      </button>
                    ) : (
                      <span className="text-xs text-text-soft">
                        Uncategorized
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* G-10 — celebration toast stack for scenario-positive flip. */}
      <CelebrationToastStack events={celebrate.events} />
      {/* Sprint M-5 — drag-and-drop re-parent board */}
      {reparentOpen && (
        <CategoryReparentBoard onClose={() => setReparentOpen(false)} />
      )}
    </div>
  );
}
