/**
 * Trends — mobile screen.
 *
 * Per-category month-over-month outflow with biggest swings at the top.
 * Phone-first treatment:
 *   • Hero card with current-month vs avg total spend
 *   • Top swings list — categories with biggest absolute Δ vs trailing average
 *   • Sparkline-as-bars: 6 mini bars per category showing the trend visually
 */
import React, { useMemo } from "react";
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
  type CategoryTrendRow,
} from "../api/client";
import { C, cardStyle, headerStyles } from "../theme";
import SyncFreshnessChip from "../components/SyncFreshness";

function MiniBars({
  values,
  highlightLast,
}: {
  values: number[];
  highlightLast: boolean;
}) {
  if (values.length === 0) return null;
  const max = Math.max(...values, 1);
  return (
    <View style={styles.barsRow}>
      {values.map((v, i) => {
        const h = (v / max) * 24;
        const isLast = i === values.length - 1;
        return (
          <View key={i} style={styles.barWrap}>
            <View
              style={[
                styles.bar,
                {
                  height: Math.max(2, h),
                  backgroundColor: isLast && highlightLast ? C.brandAccent : C.brandLight,
                },
              ]}
            />
          </View>
        );
      })}
    </View>
  );
}

function CategoryRow({ row }: { row: CategoryTrendRow }) {
  const trendPct = row.trend_pct_vs_avg ?? 0;
  const tone = trendPct > 0 ? C.outflow : trendPct < 0 ? C.inflow : C.textMuted;
  const lastMonth = row.outflow_by_month_cents[row.outflow_by_month_cents.length - 1] ?? 0;
  return (
    <View style={styles.categoryRow}>
      <View style={styles.categoryHeader}>
        <Text style={styles.categoryName} numberOfLines={1}>
          {row.category_name ?? "Uncategorized"}
        </Text>
        <Text style={[styles.trendPct, { color: tone }]}>
          {trendPct > 0 ? "+" : ""}{trendPct.toFixed(0)}%
        </Text>
      </View>
      <View style={styles.barAndAmount}>
        <MiniBars values={row.outflow_by_month_cents} highlightLast={true} />
        <Text style={styles.lastMonthAmount}>{fmtCents(lastMonth)}</Text>
      </View>
      <Text style={styles.avgText}>
        Avg {fmtCents(row.avg_outflow_cents)} · last 6 months
      </Text>
    </View>
  );
}

export default function TrendsScreen() {
  const q = useQuery({ queryKey: ["mom", 6], queryFn: () => api.monthOverMonth(6) });

  const sortedCategories = useMemo(() => {
    if (!q.data) return [];
    return q.data.categories
      .filter((r) => r.avg_outflow_cents > 0)
      .slice()
      .sort((a, b) => {
        const ad = Math.abs(a.trend_pct_vs_avg ?? 0);
        const bd = Math.abs(b.trend_pct_vs_avg ?? 0);
        return bd - ad;
      });
  }, [q.data]);

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  const monthsTotal = (q.data?.months ?? []).map((m) => m.outflow_cents);
  const lastTotal = monthsTotal[monthsTotal.length - 1] ?? 0;
  const avgTotal = monthsTotal.length > 0
    ? Math.round(monthsTotal.reduce((s, v) => s + v, 0) / monthsTotal.length)
    : 0;
  const totalDelta = avgTotal > 0 ? Math.round(((lastTotal - avgTotal) / avgTotal) * 100) : 0;

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Spending trends</Text>
        <Text style={headerStyles.headerSub}>
          Month-over-month · last 6 months
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
        <View style={styles.chipRow}>
          <SyncFreshnessChip syncedAt={q.data?.generated_at ?? null} label="Trend computed" />
        </View>
        {/* Hero — current vs avg */}
        <View style={[cardStyle.card, styles.hero]}>
          <Text style={styles.heroLabel}>Current month</Text>
          <Text style={styles.heroAmount}>{fmtCents(lastTotal)}</Text>
          <Text style={styles.heroSub}>
            Avg {fmtCents(avgTotal)} · {totalDelta > 0 ? "+" : ""}{totalDelta}% vs trailing avg
          </Text>
          <View style={styles.heroChartRow}>
            <MiniBars values={monthsTotal} highlightLast={true} />
          </View>
        </View>

        {/* Category trend list */}
        {sortedCategories.length === 0 ? (
          <View style={cardStyle.card}>
            <Text style={styles.hint}>
              No category trend data yet. Connect Plaid + sync transactions, then come back here.
            </Text>
          </View>
        ) : (
          <View style={cardStyle.card}>
            <Text style={styles.sectionTitle}>By category — biggest swings first</Text>
            {sortedCategories.map((row) => (
              <CategoryRow key={row.category_id ?? row.category_name ?? "unknown"} row={row} />
            ))}
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
  content: { padding: 16, paddingBottom: 32 },
  chipRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 4 },

  hero: { backgroundColor: C.brand, marginBottom: 12 },
  heroLabel: { color: C.brandLight, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 },
  heroAmount: { color: "#fff", fontSize: 32, fontWeight: "700", marginTop: 4 },
  heroSub: { color: C.brandLight, fontSize: 12, marginTop: 4 },
  heroChartRow: { marginTop: 12 },

  sectionTitle: { color: C.text, fontSize: 14, fontWeight: "600", marginBottom: 12 },

  categoryRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  categoryHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  categoryName: { color: C.text, fontSize: 13, fontWeight: "500", flex: 1, paddingRight: 8 },
  trendPct: { fontSize: 13, fontWeight: "700" },
  barAndAmount: { flexDirection: "row", alignItems: "flex-end", marginTop: 8 },
  lastMonthAmount: { color: C.text, fontSize: 12, fontWeight: "600", marginLeft: 8 },
  avgText: { color: C.textSoft, fontSize: 11, marginTop: 4 },

  barsRow: { flexDirection: "row", height: 24, alignItems: "flex-end", flex: 1 },
  barWrap: { flex: 1, justifyContent: "flex-end", marginRight: 2 },
  bar: { width: "100%", borderRadius: 1 },
});
