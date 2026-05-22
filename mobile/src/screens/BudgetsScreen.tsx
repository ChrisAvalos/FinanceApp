/**
 * Budgets — mobile screen.
 *
 * Current-month rollup with progress bars per category. Color-codes:
 *   • green  = on pace
 *   • amber  = burning faster than month is passing (off-pace warning)
 *   • red    = over budget already
 *
 * Includes the "unbudgeted spending" section at the bottom so Chris
 * sees blind spots — categories where he's spending but has no cap set.
 */
import React, { useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import {
  api,
  fmtCents,
  type BudgetRecommendation,
  type BudgetRollupRow,
  type BudgetStatus,
} from "../api/client";
import { C, cardStyle, currentMonthStart, headerStyles } from "../theme";
import ProjectionChart from "../components/ProjectionChart";
import WhatIfSliders from "../components/WhatIfSliders";
import {
  SafeToSpendHero,
  BudgetStatStrip as MobileBudgetStatStrip,
  MobileAssignmentLedger,
} from "../components/PlanUpgrade";

// Wave G mobile — categorical palette for the stacked-bar viz that
// stands in for the web donut chart. Same Wong colorblind-safe stops
// the web side uses, so a user toggling between platforms reads the
// same color for "Groceries" or "Restaurants".
const STACKED_BAR_PALETTE = [
  "#0072B2", "#D55E00", "#009E73", "#CC79A7",
  "#56B4E9", "#E69F00", "#7B3F00", "#000000",
  "#999999",
];

const REC_KIND_META: Record<string, { label: string; bg: string; fg: string; emoji: string }> = {
  overspend:   { label: "Overspend",       bg: "#fef3c7", fg: "#8b5a00", emoji: "✂️" },
  goal:        { label: "Goal",            bg: "#dbeafe", fg: "#0F4D8C", emoji: "🎯" },
  bundle_dup:  { label: "Already bundled", bg: "#ede9fe", fg: "#5b21b6", emoji: "🪢" },
  store_swap:  { label: "Switch stores",   bg: "#cffafe", fg: "#155e75", emoji: "🛒" },
  yield_shift: { label: "Free yield",      bg: "#d1fae5", fg: "#00754A", emoji: "📈" },
};

const STATUS_COLOR: Record<BudgetStatus, string> = {
  ok: C.inflow,
  watch: C.warn,
  over_pace: C.warn,
  over_budget: C.outflow,
};

const STATUS_LABEL: Record<BudgetStatus, string> = {
  ok: "On track",
  watch: "Watch",
  over_pace: "Off pace",
  over_budget: "Over",
};

function ProgressBar({ pct, status }: { pct: number; status: BudgetStatus }) {
  const clamped = Math.min(100, Math.max(0, pct));
  const tone = STATUS_COLOR[status];
  return (
    <View style={styles.progressTrack}>
      <View
        style={[
          styles.progressFill,
          { width: `${clamped}%`, backgroundColor: tone },
        ]}
      />
    </View>
  );
}

function BudgetRow({ row }: { row: BudgetRollupRow }) {
  // Rollover is only meaningful when the prior month had carry-forward.
  // effective_budget_cents may be 0 from older rollups predating the
  // rollover schema field — fall back to budget_cents in that case.
  const effective = row.effective_budget_cents || row.budget_cents;
  const hasRollover = (row.rollover_in_cents ?? 0) !== 0;
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <View style={styles.rowNameWrap}>
          <Text style={styles.rowName} numberOfLines={1}>
            {row.category_name}
          </Text>
          {hasRollover && (
            <View style={styles.rolloverBadge}>
              <Text style={styles.rolloverBadgeText}>↻ rollover</Text>
            </View>
          )}
        </View>
        <Text
          style={[
            styles.rowStatus,
            { color: STATUS_COLOR[row.status] },
          ]}
        >
          {STATUS_LABEL[row.status]}
        </Text>
      </View>
      <ProgressBar pct={row.pct_used} status={row.status} />
      <View style={styles.rowFooter}>
        <Text style={styles.rowAmount}>
          {fmtCents(row.actual_outflow_cents)} of {fmtCents(effective)}
        </Text>
        <Text
          style={[
            styles.rowRemaining,
            { color: row.remaining_cents < 0 ? C.outflow : C.textMuted },
          ]}
        >
          {row.remaining_cents < 0
            ? `${fmtCents(-row.remaining_cents)} over`
            : `${fmtCents(row.remaining_cents)} left`}
        </Text>
      </View>
      {hasRollover && (
        <Text
          style={[
            styles.rolloverDetail,
            { color: row.rollover_in_cents > 0 ? C.inflow : C.outflow },
          ]}
        >
          {row.rollover_in_cents > 0 ? "+" : "−"}
          {fmtCents(Math.abs(row.rollover_in_cents))} rolled in
          {" · "}
          base cap {fmtCents(row.budget_cents)}
        </Text>
      )}
      {row.projected_eom_cents != null && (
        <Text style={styles.projectionText}>
          At this pace: {fmtCents(row.projected_eom_cents)} by month-end
          {row.projected_overage_cents && row.projected_overage_cents > 0
            ? ` (${fmtCents(row.projected_overage_cents)} over)`
            : ""}
        </Text>
      )}
    </View>
  );
}

function UnbudgetedRow({ row }: { row: BudgetRollupRow }) {
  return (
    <View style={styles.unbudgetedRow}>
      <Text style={styles.rowName} numberOfLines={1}>
        {row.category_name}
      </Text>
      <Text style={styles.unbudgetedAmount}>
        {fmtCents(row.actual_outflow_cents)}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Wave G mobile — projection summary                                  */
/* ------------------------------------------------------------------ */

/**
 * BudgetProjectionCard — mobile counterpart to the web BudgetProjection.
 * Shows 3mo / 12mo / 24mo net-worth projection cards plus a warning
 * banner when the projected balance dips below zero. Skips the line
 * chart (no SVG dep available on mobile yet) — the stat cards carry
 * the actionable insight without the visualization.
 */
function BudgetProjectionCard({
  overrides,
  goalContributions,
}: {
  overrides: Record<number, number> | null;
  goalContributions: Record<number, number>;
}) {
  const screenWidth = Dimensions.get("window").width;
  // Inside a 16px-padded screen + 14px card padding → minus ~60px for
  // the chart's internal margins. Cap at 360 so on tablets the chart
  // doesn't stretch unreadably wide.
  const chartWidth = Math.min(360, screenWidth - 60);

  const q = useQuery({
    queryKey: [
      "budgetProjection-mobile",
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
  if (q.isLoading) {
    return (
      <View style={[cardStyle.card, { padding: 14, marginTop: 12 }]}>
        <Text style={projStyles.title}>Net worth — projected</Text>
        <Text style={projStyles.sub}>Computing projection…</Text>
      </View>
    );
  }
  if (q.isError || !q.data) return null;
  const d = q.data;
  const at = (m: number) => d.scenario_points.find((p) => p.month_index === m);
  const brokeMonth = d.scenario_points.find((p) => p.month_index > 0 && p.net_cents < 0)?.month_index ?? null;
  const monthlyNetFlow = d.monthly_income_cents - d.monthly_outflow_cents_scenario;
  return (
    <View style={[cardStyle.card, { padding: 14, marginTop: 12 }]}>
      <Text style={projStyles.title}>Net worth — projected</Text>
      <Text style={projStyles.sub}>
        ${(d.monthly_income_cents / 100).toFixed(0)}/mo income · ${(d.monthly_outflow_cents_baseline / 100).toFixed(0)}/mo outflow · {(d.investment_apy * 100).toFixed(0)}% APY
      </Text>
      <View style={projStyles.statRow}>
        <ProjStatCard label="In 3 months" valueCents={at(3)?.net_cents ?? 0} startCents={d.starting_net_cents} />
        <ProjStatCard label="In 12 months" valueCents={at(12)?.net_cents ?? 0} startCents={d.starting_net_cents} />
        <ProjStatCard label="In 24 months" valueCents={at(24)?.net_cents ?? 0} startCents={d.starting_net_cents} />
      </View>
      {brokeMonth !== null && monthlyNetFlow < 0 && (
        <View style={projStyles.warnBox}>
          <Text style={projStyles.warnIcon}>⚠️</Text>
          <View style={{ flex: 1 }}>
            <Text style={projStyles.warnTitle}>
              Heads up — projected to go negative around month {brokeMonth}
              {brokeMonth >= 12 ? ` (~${(brokeMonth / 12).toFixed(1)} yr)` : ""}.
            </Text>
            <Text style={projStyles.warnBody}>
              Monthly net flow is {fmtCents(monthlyNetFlow)}. Trim ~{fmtCents(Math.abs(monthlyNetFlow))}/mo or earn that much more to break even.
            </Text>
          </View>
        </View>
      )}
      {/* G-13 — line chart, ported from web. Tap to inspect a month. */}
      <View style={{ marginTop: 12, alignSelf: "center" }}>
        <ProjectionChart
          scenario={d.scenario_points}
          baseline={d.baseline_points}
          width={chartWidth}
          height={240}
        />
      </View>
    </View>
  );
}

function ProjStatCard({
  label,
  valueCents,
  startCents,
}: {
  label: string;
  valueCents: number;
  startCents: number;
}) {
  const delta = valueCents - startCents;
  const isNegative = valueCents < 0;
  return (
    <View
      style={[
        projStyles.statCard,
        isNegative && { backgroundColor: "rgba(194,22,30,0.06)", borderColor: "rgba(194,22,30,0.3)" },
      ]}
    >
      <Text style={projStyles.statLabel}>{label}</Text>
      <Text style={[projStyles.statValue, { color: isNegative ? C.outflow : C.text }]}>
        {fmtCents(valueCents)}
      </Text>
      <Text style={projStyles.statDelta}>
        <Text style={{ color: delta >= 0 ? C.inflow : C.outflow }}>
          {delta >= 0 ? "+" : "−"}
          {fmtCents(Math.abs(delta))}
        </Text>
        <Text style={{ color: C.textSoft }}> vs today</Text>
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Wave G mobile — stacked-bar viz (donut alternative)                 */
/* ------------------------------------------------------------------ */

/**
 * StackedBarViz — pure-RN visual of budget allocation by category.
 * Two stacked horizontal bars: top = BUDGET allocation, bottom =
 * ACTUAL spend. Same colors per category in both bars so the eye can
 * compare proportions at a glance. The donut equivalent on web shows
 * the same data; this is the visual we can build without
 * react-native-svg.
 */
function StackedBarViz({
  rows,
  unbudgeted,
  totalBudget,
  totalSpent,
}: {
  rows: BudgetRollupRow[];
  unbudgeted: BudgetRollupRow[];
  totalBudget: number;
  totalSpent: number;
}) {
  // Build color assignment in the same way the web side does — sort
  // categories by combined value descending so the biggest slice wins
  // the most distinctive palette stop.
  const colorByCat: Map<number, string> = (() => {
    const combined = new Map<number, number>();
    for (const r of rows) combined.set(r.category_id, r.budget_cents + r.actual_outflow_cents);
    for (const u of unbudgeted) {
      combined.set(u.category_id, (combined.get(u.category_id) ?? 0) + u.actual_outflow_cents);
    }
    const sorted = [...combined.entries()].sort((a, b) => b[1] - a[1]);
    const m = new Map<number, string>();
    sorted.forEach(([id], idx) => m.set(id, STACKED_BAR_PALETTE[idx % STACKED_BAR_PALETTE.length]));
    return m;
  })();

  const budgetSegs = rows
    .filter((r) => r.budget_cents > 0)
    .sort((a, b) => b.budget_cents - a.budget_cents);
  const spentSegs = [
    ...rows.filter((r) => r.actual_outflow_cents > 0).map((r) => ({
      id: r.category_id,
      name: r.category_name,
      value: r.actual_outflow_cents,
      isUnbudgeted: false,
    })),
    ...unbudgeted.filter((u) => u.actual_outflow_cents > 0).map((u) => ({
      id: u.category_id,
      name: `${u.category_name} (unbudgeted)`,
      value: u.actual_outflow_cents,
      isUnbudgeted: true,
    })),
  ].sort((a, b) => b.value - a.value);

  if (totalBudget === 0 && totalSpent === 0) return null;

  return (
    <View style={[cardStyle.card, { padding: 14, marginTop: 12 }]}>
      <Text style={projStyles.title}>Budget vs spending</Text>
      <Text style={projStyles.sub}>
        Same color = same category in both bars.
      </Text>

      {/* BUDGET bar */}
      <Text style={stackedStyles.barLabel}>
        Budget · {fmtCents(totalBudget)}
      </Text>
      <View style={stackedStyles.barTrack}>
        {budgetSegs.map((r) => (
          <View
            key={`b-${r.category_id}`}
            style={{
              backgroundColor: colorByCat.get(r.category_id) ?? "#999",
              width: `${(r.budget_cents / totalBudget) * 100}%`,
              height: "100%",
            }}
          />
        ))}
      </View>

      {/* SPENT bar */}
      <Text style={[stackedStyles.barLabel, { marginTop: 12 }]}>
        Spent · {fmtCents(totalSpent)}
      </Text>
      <View style={stackedStyles.barTrack}>
        {spentSegs.map((s) => (
          <View
            key={`s-${s.id}-${s.isUnbudgeted ? "u" : "b"}`}
            style={{
              backgroundColor: s.isUnbudgeted
                ? "#cbd2dc"
                : (colorByCat.get(s.id) ?? "#999"),
              width: `${(s.value / totalSpent) * 100}%`,
              height: "100%",
            }}
          />
        ))}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Wave G mobile — recommendation cards                                */
/* ------------------------------------------------------------------ */

function RecommendationsCard() {
  const q = useQuery({
    queryKey: ["budgetRecommendations-mobile"],
    queryFn: api.budgetRecommendations,
    staleTime: 5 * 60 * 1000,
  });
  if (q.isLoading) {
    return (
      <View style={[cardStyle.card, { padding: 14, marginTop: 12 }]}>
        <Text style={projStyles.title}>Smart recommendations</Text>
        <Text style={projStyles.sub}>Analyzing your spend patterns…</Text>
      </View>
    );
  }
  if (q.isError || !q.data || q.data.recommendations.length === 0) return null;
  const top = q.data.recommendations.slice(0, 5);
  return (
    <View style={[cardStyle.card, { padding: 14, marginTop: 12 }]}>
      <View style={recStyles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={projStyles.title}>Smart recommendations</Text>
          <Text style={projStyles.sub}>
            Top moves to free up monthly cash. Apply from the web app's slider scenario.
          </Text>
        </View>
        {q.data.total_potential_monthly_savings_cents > 0 && (
          <View style={{ alignItems: "flex-end" }}>
            <Text style={recStyles.totalLabel}>All recs combined</Text>
            <Text style={recStyles.totalValue}>
              up to {fmtCents(q.data.total_potential_monthly_savings_cents)}/mo
            </Text>
            <Text style={recStyles.totalYearly}>
              ≈ {fmtCents(q.data.total_potential_annual_savings_cents)}/yr
            </Text>
          </View>
        )}
      </View>
      <View style={{ marginTop: 12 }}>
        {top.map((rec) => (
          <RecCard key={`${rec.kind}-${rec.title}`} rec={rec} />
        ))}
      </View>
    </View>
  );
}

function RecCard({ rec }: { rec: BudgetRecommendation }) {
  const meta = REC_KIND_META[rec.kind] ?? REC_KIND_META.overspend;
  return (
    <View style={[recStyles.cardWrap, { backgroundColor: meta.bg }]}>
      <Text style={recStyles.emoji}>{meta.emoji}</Text>
      <View style={{ flex: 1, marginLeft: 8 }}>
        <View style={recStyles.cardHeader}>
          <Text style={[recStyles.kindLabel, { color: meta.fg }]}>
            {meta.label}
          </Text>
          <Text style={recStyles.impact}>
            {fmtCents(rec.expected_monthly_impact_cents)}/mo
          </Text>
        </View>
        <Text style={recStyles.cardTitle}>{rec.title}</Text>
        <Text style={recStyles.cardBody}>{rec.body}</Text>
      </View>
    </View>
  );
}

export default function BudgetsScreen() {
  const monthStart = currentMonthStart();
  // G-13 — what-if state at the screen level so sliders + chart share.
  const [overrides, setOverrides] = useState<Record<number, number> | null>(null);
  const [goalContributions, setGoalContributions] = useState<Record<number, number>>({});
  const hasOverrides =
    (overrides != null && Object.keys(overrides).length > 0) ||
    Object.keys(goalContributions).length > 0;
  function resetScenario() {
    setOverrides(null);
    setGoalContributions({});
  }
  // Categories + goals needed for the slider section. Fetch once.
  const inputsQuery = useQuery({
    queryKey: ["budgetProjectionInputs-mobile"],
    queryFn: () => api.budgetProject({ months: 1, include_baseline: false }),
    staleTime: 5 * 60 * 1000,
  });
  const q = useQuery({
    queryKey: ["budgetRollup", monthStart],
    queryFn: () => api.budgetRollup(monthStart),
  });

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }
  if (q.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Couldn't load</Text>
        <Text style={styles.errorBody}>{(q.error as Error).message}</Text>
      </View>
    );
  }

  const r = q.data;
  const pct = r ? Math.round(r.pace * 100) : 0;
  // Sum rollover-in across rows so the hero can show "+$X carried in"
  // when at least one budget has rollover. Helps Chris see at a glance
  // that this month's effective cap reflects last month's underspend.
  const totalRolloverIn = (r?.rows ?? []).reduce(
    (acc, row) => acc + (row.rollover_in_cents ?? 0),
    0,
  );

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Budgets</Text>
        <Text style={headerStyles.headerSub}>
          {r?.month_start ?? monthStart} · {pct}% of month elapsed
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={q.isFetching}
            onRefresh={() => q.refetch()}
            tintColor={C.brand}
          />
        }
      >
        {/* Sprint I mobile — Safe to spend hero (replaces the simple
            Total budgeted / Spent so far hero). The anchor metric for
            daily decisions. */}
        {r && <SafeToSpendHero data={r} monthStart={monthStart} />}

        {/* Sprint I+H+K mobile — 5-card StatStrip with Income / Available
            cash / Saved / Variable spent / EOM projection. Horizontal
            scroll on narrow screens. */}
        {r && <MobileBudgetStatStrip data={r} />}

        {/* Sprint L mobile — "The plan" assignment ledger (read-only).
            Tap groups to expand. Inline edit + rebalance modal are
            web-only for v1. */}
        <MobileAssignmentLedger monthStart={monthStart} />

        {totalRolloverIn !== 0 && (
          <View style={[cardStyle.card, { padding: 10, marginTop: 8 }]}>
            <Text style={{ color: C.textSoft, fontSize: 11 }}>
              {totalRolloverIn > 0 ? "+" : "−"}
              {fmtCents(Math.abs(totalRolloverIn))} carried in from prior months (rollover)
            </Text>
          </View>
        )}

        {/* Wave G — projection summary with full line chart (G-13). */}
        <BudgetProjectionCard
          overrides={overrides}
          goalContributions={goalContributions}
        />

        {/* G-13 — Reset button + what-if sliders. */}
        {hasOverrides && (
          <View style={styles.resetBar}>
            <Text style={styles.resetBarLabel}>Scenario active</Text>
            <Text style={styles.resetBarLink} onPress={resetScenario}>
              Reset to status quo
            </Text>
          </View>
        )}
        {inputsQuery.data && (
          (inputsQuery.data.categories.length > 0 || (inputsQuery.data.goals ?? []).length > 0) && (
            <View style={[cardStyle.card, { padding: 14, marginTop: 12 }]}>
              <Text style={projStyles.title}>What-if sliders</Text>
              <Text style={projStyles.sub}>
                Drag to model different spend levels. Chart updates above.
              </Text>
              <View style={{ marginTop: 12 }}>
                <WhatIfSliders
                  categories={inputsQuery.data.categories}
                  goals={inputsQuery.data.goals ?? []}
                  overrides={overrides}
                  onOverridesChange={setOverrides}
                  goalContributions={goalContributions}
                  onGoalContributionsChange={setGoalContributions}
                />
              </View>
            </View>
          )
        )}

        {/* Wave G — stacked-bar viz (donut alternative) */}
        {r && (r.rows.length > 0 || r.unbudgeted_spending.length > 0) && (
          <StackedBarViz
            rows={r.rows}
            unbudgeted={r.unbudgeted_spending}
            totalBudget={r.total_budget_cents}
            totalSpent={r.total_actual_cents}
          />
        )}

        {/* Wave G — smart recommendations */}
        <RecommendationsCard />

        {/* Per-category rows */}
        {r?.rows && r.rows.length > 0 ? (
          <View style={cardStyle.card}>
            <Text style={styles.sectionTitle}>By category</Text>
            {r.rows.map((row) => (
              <BudgetRow key={row.category_id} row={row} />
            ))}
          </View>
        ) : (
          <View style={cardStyle.card}>
            <Text style={styles.hint}>
              No budgets set for this month. Use the web app to copy from prior month or fill from average.
            </Text>
          </View>
        )}

        {/* Unbudgeted spending */}
        {r?.unbudgeted_spending && r.unbudgeted_spending.length > 0 && (
          <View style={cardStyle.card}>
            <Text style={styles.sectionTitle}>Unbudgeted spending</Text>
            <Text style={styles.sectionHint}>
              Categories you're spending in without a cap set
            </Text>
            {r.unbudgeted_spending.map((row) => (
              <UnbudgetedRow key={row.category_id} row={row} />
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// Wave G — projection card styles. Match the rest of the panel's
// card density / type scale.
const projStyles = StyleSheet.create({
  title: { color: C.text, fontSize: 14, fontWeight: "600" },
  sub: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  statRow: { flexDirection: "row", marginTop: 12, gap: 8 },
  statCard: {
    flex: 1,
    padding: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    backgroundColor: C.bg,
  },
  statLabel: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statValue: {
    fontSize: 16,
    fontWeight: "700",
    marginTop: 4,
  },
  statDelta: { fontSize: 10, marginTop: 2, fontVariantCaps: "all-small-caps" },
  warnBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginTop: 12,
    padding: 10,
    borderRadius: 6,
    backgroundColor: "rgba(194,22,30,0.06)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(194,22,30,0.3)",
  },
  warnIcon: { fontSize: 16, marginRight: 8 },
  warnTitle: { color: C.outflow, fontSize: 12, fontWeight: "700" },
  warnBody: { color: C.textMuted, fontSize: 11, marginTop: 2, lineHeight: 15 },
});

// Wave G — stacked-bar viz styles.
const stackedStyles = StyleSheet.create({
  barLabel: {
    color: C.textMuted,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 14,
    marginBottom: 4,
  },
  barTrack: {
    flexDirection: "row",
    height: 18,
    borderRadius: 4,
    overflow: "hidden",
    backgroundColor: C.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
});

// Wave G — recommendation card styles.
const recStyles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "flex-start" },
  totalLabel: {
    color: C.textSoft,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  totalValue: { color: C.inflow, fontSize: 13, fontWeight: "700", marginTop: 2 },
  totalYearly: { color: C.textMuted, fontSize: 11, marginTop: 1 },
  cardWrap: {
    flexDirection: "row",
    alignItems: "flex-start",
    padding: 10,
    borderRadius: 6,
    marginBottom: 8,
  },
  emoji: { fontSize: 22, lineHeight: 22 },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 2,
  },
  kindLabel: {
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  impact: { color: C.inflow, fontSize: 13, fontWeight: "700" },
  cardTitle: { color: C.text, fontSize: 13, fontWeight: "600", marginTop: 2 },
  cardBody: { color: C.textMuted, fontSize: 11, marginTop: 2, lineHeight: 15 },
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  errorTitle: { color: C.outflow, fontSize: 16, fontWeight: "600" },
  errorBody: { color: C.text, marginTop: 8, fontSize: 12, textAlign: "center" },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center" },
  resetBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 12,
    borderRadius: 6,
    backgroundColor: "rgba(17,122,202,0.10)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(17,122,202,0.3)",
  },
  resetBarLabel: { color: C.brand, fontSize: 12, fontWeight: "700" },
  resetBarLink: { color: C.brand, fontSize: 12, fontWeight: "600", textDecorationLine: "underline" },
  content: { padding: 16, paddingBottom: 32 },

  hero: { backgroundColor: C.brand, marginBottom: 12 },
  heroSplit: { flexDirection: "row" },
  heroSlice: { flex: 1, paddingHorizontal: 4 },
  heroLabel: { color: C.brandLight, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  heroAmount: { color: "#fff", fontSize: 22, fontWeight: "700", marginTop: 4 },
  heroPace: { color: C.brandLight, fontSize: 12, marginTop: 12 },
  heroRollover: { fontSize: 12, marginTop: 6, fontWeight: "600" },

  sectionTitle: { color: C.text, fontSize: 14, fontWeight: "600", marginBottom: 4 },
  sectionHint: { color: C.textSoft, fontSize: 11, marginBottom: 8 },

  row: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  rowHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowNameWrap: { flex: 1, paddingRight: 8, flexDirection: "row", alignItems: "center", gap: 6 },
  rowName: { color: C.text, fontSize: 14, fontWeight: "500", flexShrink: 1 },
  rowStatus: { fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  rolloverBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: C.brandLight,
  },
  rolloverBadgeText: { color: C.brand, fontSize: 9, fontWeight: "700" },
  rolloverDetail: { fontSize: 11, marginTop: 4, fontStyle: "italic" },
  progressTrack: { height: 6, backgroundColor: C.borderSoft, borderRadius: 3, marginTop: 8, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 3 },
  rowFooter: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  rowAmount: { color: C.textMuted, fontSize: 12 },
  rowRemaining: { fontSize: 12, fontWeight: "500" },
  projectionText: { color: C.textSoft, fontSize: 11, marginTop: 4, fontStyle: "italic" },

  unbudgetedRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  unbudgetedAmount: { color: C.outflow, fontSize: 13, fontWeight: "600" },
});
