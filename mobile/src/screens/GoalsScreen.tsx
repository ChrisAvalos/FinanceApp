/**
 * Goals — mobile screen.
 *
 * Three sections:
 *   • Surplus snapshot card — historical 90d + forecast 30d surplus
 *   • Goals list with progress bars per goal
 *   • Top-3 suggestions (cancel sub / allocate to goal)
 *
 * Phone use-case is "where am I on my goals + what should I do next?"
 * — both answered in one screen without navigation depth.
 */
import React from "react";
import {
  ActivityIndicator,
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
  type Goal,
  type Suggestion,
} from "../api/client";
import { C, cardStyle, fmtRelativeDate, headerStyles } from "../theme";

function GoalRow({ g }: { g: Goal }) {
  const pct = g.target_amount_cents > 0
    ? Math.min(100, (g.current_amount_cents / g.target_amount_cents) * 100)
    : 0;
  const remaining = Math.max(0, g.target_amount_cents - g.current_amount_cents);
  const tone = pct >= 100 ? C.inflow : pct >= 50 ? C.brandAccent : C.textMuted;

  return (
    <View style={styles.goalRow}>
      <View style={styles.goalHeader}>
        <Text style={styles.goalName} numberOfLines={1}>{g.name}</Text>
        <Text style={[styles.goalPct, { color: tone }]}>{pct.toFixed(0)}%</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%`, backgroundColor: tone }]} />
      </View>
      <View style={styles.goalFooter}>
        <Text style={styles.goalAmount}>
          {fmtCents(g.current_amount_cents)} of {fmtCents(g.target_amount_cents)}
        </Text>
        <Text style={styles.goalRemaining}>
          {pct >= 100
            ? "✓ Achieved"
            : `${fmtCents(remaining)} to go${g.target_date ? ` · by ${fmtRelativeDate(g.target_date)}` : ""}`}
        </Text>
      </View>
      <Text style={styles.goalMeta}>
        {g.kind.replace(/_/g, " ")} · priority {g.priority}
      </Text>
    </View>
  );
}

function SuggestionRow({ s }: { s: Suggestion }) {
  const tone = s.kind.startsWith("debt") ? C.outflow : C.warn;
  return (
    <View style={styles.suggestion}>
      <View style={styles.suggestionRow}>
        <View style={styles.suggestionMain}>
          <Text style={styles.suggestionTitle}>{s.title}</Text>
          <Text style={styles.suggestionBody} numberOfLines={2}>{s.body}</Text>
        </View>
        <View style={styles.suggestionRight}>
          <Text style={[styles.suggestionAmount, { color: tone }]}>
            {fmtCents(s.estimated_savings_cents)}
          </Text>
          <Text style={styles.suggestionConf}>
            {Math.round(s.confidence * 100)}% conf
          </Text>
        </View>
      </View>
    </View>
  );
}

export default function GoalsScreen() {
  const goals = useQuery({ queryKey: ["goals"], queryFn: api.listGoals });
  const surplus = useQuery({ queryKey: ["surplus"], queryFn: api.surplus });
  const suggestions = useQuery({ queryKey: ["suggestions"], queryFn: api.suggestions });

  const refetchAll = () => {
    goals.refetch();
    surplus.refetch();
    suggestions.refetch();
  };

  if (goals.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }
  if (goals.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Couldn't load</Text>
        <Text style={styles.errorBody}>{(goals.error as Error).message}</Text>
      </View>
    );
  }

  const activeGoals = (goals.data ?? []).filter((g) => g.status === "active");
  const sortedGoals = activeGoals.slice().sort((a, b) => a.priority - b.priority);
  const allSuggestions: Suggestion[] = [
    ...(suggestions.data?.allocations ?? []),
    ...(suggestions.data?.cancellations ?? []),
    ...(suggestions.data?.debt_strategies ?? []),
  ]
    .sort((a, b) => b.estimated_savings_cents - a.estimated_savings_cents)
    .slice(0, 5);

  const histSurplus = surplus.data?.historical?.surplus_cents ?? 0;
  const fcstSurplus = surplus.data?.forecast?.surplus_cents ?? 0;

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Goals & savings</Text>
        <Text style={headerStyles.headerSub}>
          {activeGoals.length} active · {allSuggestions.length} suggestion{allSuggestions.length === 1 ? "" : "s"}
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={goals.isFetching || surplus.isFetching || suggestions.isFetching}
            onRefresh={refetchAll}
            tintColor={C.brand}
          />
        }
      >
        {/* Surplus snapshot */}
        <View style={[cardStyle.card, styles.hero]}>
          <Text style={styles.heroLabel}>Surplus to allocate</Text>
          <Text style={styles.heroAmount}>
            {fmtCents(Math.max(histSurplus, fcstSurplus))}
          </Text>
          <View style={styles.heroSplit}>
            <View style={styles.heroSlice}>
              <Text style={styles.heroSliceLabel}>Historical (90d)</Text>
              <Text style={styles.heroSliceValue}>{fmtCents(histSurplus)}</Text>
            </View>
            <View style={styles.heroSliceDivider} />
            <View style={styles.heroSlice}>
              <Text style={styles.heroSliceLabel}>Forecast (30d)</Text>
              <Text style={styles.heroSliceValue}>{fmtCents(fcstSurplus)}</Text>
            </View>
          </View>
        </View>

        {/* Goals list */}
        {sortedGoals.length > 0 ? (
          <View style={cardStyle.card}>
            <Text style={styles.sectionTitle}>Active goals</Text>
            {sortedGoals.map((g) => <GoalRow key={g.id} g={g} />)}
          </View>
        ) : (
          <View style={cardStyle.card}>
            <Text style={styles.hint}>
              No active goals. Create one in the web app to start tracking progress.
            </Text>
          </View>
        )}

        {/* Suggestions */}
        {allSuggestions.length > 0 && (
          <View style={cardStyle.card}>
            <Text style={styles.sectionTitle}>Suggested next moves</Text>
            <Text style={styles.sectionHint}>
              Ranked by estimated savings — every recommendation includes before/after math
            </Text>
            {allSuggestions.map((s, i) => <SuggestionRow key={`${s.kind}-${i}`} s={s} />)}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center" },
  errorTitle: { color: C.outflow, fontSize: 16, fontWeight: "600" },
  errorBody: { color: C.text, marginTop: 8, fontSize: 12, textAlign: "center" },
  content: { padding: 16, paddingBottom: 32 },

  hero: { backgroundColor: C.brand, marginBottom: 12 },
  heroLabel: { color: C.brandLight, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 },
  heroAmount: { color: "#fff", fontSize: 32, fontWeight: "700", marginTop: 4 },
  heroSplit: { flexDirection: "row", marginTop: 12 },
  heroSlice: { flex: 1 },
  heroSliceDivider: { width: StyleSheet.hairlineWidth, backgroundColor: "rgba(255,255,255,0.2)", marginHorizontal: 8 },
  heroSliceLabel: { color: C.brandLight, fontSize: 11 },
  heroSliceValue: { color: "#fff", fontSize: 16, fontWeight: "600", marginTop: 2 },

  sectionTitle: { color: C.text, fontSize: 14, fontWeight: "600", marginBottom: 4 },
  sectionHint: { color: C.textSoft, fontSize: 11, marginBottom: 12 },

  goalRow: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  goalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  goalName: { color: C.text, fontSize: 14, fontWeight: "500", flex: 1, paddingRight: 8 },
  goalPct: { fontSize: 13, fontWeight: "700" },
  progressTrack: { height: 6, backgroundColor: C.borderSoft, borderRadius: 3, marginTop: 8, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: 3 },
  goalFooter: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  goalAmount: { color: C.textMuted, fontSize: 12 },
  goalRemaining: { color: C.text, fontSize: 12, fontWeight: "500" },
  goalMeta: { color: C.textSoft, fontSize: 11, marginTop: 4, textTransform: "capitalize" },

  suggestion: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  suggestionRow: { flexDirection: "row" },
  suggestionMain: { flex: 1, paddingRight: 8 },
  suggestionTitle: { color: C.text, fontSize: 13, fontWeight: "600" },
  suggestionBody: { color: C.textMuted, fontSize: 11, marginTop: 2, lineHeight: 16 },
  suggestionRight: { alignItems: "flex-end" },
  suggestionAmount: { fontSize: 14, fontWeight: "700" },
  suggestionConf: { color: C.textSoft, fontSize: 10, marginTop: 2 },
});
