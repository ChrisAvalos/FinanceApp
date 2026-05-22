/**
 * Spending heatmap — mobile screen.
 *
 * Calendar grid one View-per-day, colored by daily outflow. Uses
 * pure Views (no SVG dep) — each cell is a tiny square sized to
 * fit the screen width when arranged 7 deep × N weeks wide.
 *
 * Phone-first treatment:
 *   • Stat cards: busiest dow / quietest dow / weekend-vs-weekday
 *   • Window chips (30d / 90d / 180d / 1y)
 *   • Calendar grid with shade ramp legend
 */
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import { api, fmtCents, type HeatmapDay } from "../api/client";
import { C, cardStyle, headerStyles } from "../theme";

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function shadeFor(cents: number, max: number): string {
  if (cents === 0) return "#f1f5f9";
  const ratio = Math.min(1, cents / Math.max(max, 1));
  if (ratio < 0.2) return "#a7f3d0";
  if (ratio < 0.4) return "#6ee7b7";
  if (ratio < 0.6) return "#34d399";
  if (ratio < 0.8) return "#10b981";
  return "#047857";
}

function HeatGrid({ days }: { days: HeatmapDay[] }) {
  const max = Math.max(...days.map((d) => d.total_outflow_cents), 1);

  // Group into weeks. Each row = 7 cells (Mon-Sun). Pad start of first
  // week and end of last week with nulls so the grid is rectangular.
  const weeks = useMemo(() => {
    const out: (HeatmapDay | null)[][] = [];
    let current: (HeatmapDay | null)[] = new Array(7).fill(null);
    let firstWeek = true;
    for (const d of days) {
      if (firstWeek) {
        current[d.day_of_week] = d;
        if (d.day_of_week === 6) {
          out.push(current);
          current = new Array(7).fill(null);
          firstWeek = false;
        }
      } else {
        current[d.day_of_week] = d;
        if (d.day_of_week === 6) {
          out.push(current);
          current = new Array(7).fill(null);
        }
      }
    }
    if (current.some((c) => c)) out.push(current);
    return out;
  }, [days]);

  return (
    <View style={styles.grid}>
      <View style={styles.dayLabels}>
        {DOW_LABELS.map((l) => (
          <Text key={l} style={styles.dayLabel}>{l[0]}</Text>
        ))}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.weeksRow}>
          {weeks.map((w, wi) => (
            <View key={wi} style={styles.weekColumn}>
              {w.map((d, di) =>
                d ? (
                  <View
                    key={di}
                    style={[
                      styles.cell,
                      { backgroundColor: shadeFor(d.total_outflow_cents, max) },
                    ]}
                  />
                ) : (
                  <View key={di} style={styles.cellEmpty} />
                ),
              )}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const WINDOW_CHIPS: { label: string; days: number }[] = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "180d", days: 180 },
  { label: "1y", days: 365 },
];

export default function HeatmapScreen() {
  const [windowIdx, setWindowIdx] = useState(1); // 90d default

  const days = WINDOW_CHIPS[windowIdx].days;
  const q = useQuery({
    queryKey: ["heatmap", days],
    queryFn: () => api.heatmapDaily(days),
  });

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  const stats = q.data?.stats;
  const busiestDow = stats ? DOW_LABELS[stats.busiest_day_of_week] : "—";
  const quietestDow = stats ? DOW_LABELS[stats.quietest_day_of_week] : "—";

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Spending heatmap</Text>
        <Text style={headerStyles.headerSub}>
          {stats?.days_with_spend ?? 0} of {stats?.total_days ?? 0} days had spend
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
        {/* Stats */}
        <View style={styles.statRow}>
          <View style={[cardStyle.card, styles.statCard]}>
            <Text style={styles.statLabel}>Busiest day</Text>
            <Text style={styles.statValue}>{busiestDow}</Text>
            <Text style={styles.statHint}>avg {fmtCents(stats?.busiest_dow_avg_cents ?? 0)}</Text>
          </View>
          <View style={[cardStyle.card, styles.statCard]}>
            <Text style={styles.statLabel}>Biggest day</Text>
            <Text style={styles.statValue}>{fmtCents(stats?.biggest_single_day_cents ?? 0)}</Text>
            <Text style={styles.statHint}>{stats?.biggest_single_day || "—"}</Text>
          </View>
        </View>

        <View style={[cardStyle.card, styles.weekendRow]}>
          <View style={styles.weekendHalf}>
            <Text style={styles.statLabel}>Weekday avg</Text>
            <Text style={styles.statValue}>{fmtCents(stats?.weekday_avg_cents ?? 0)}</Text>
          </View>
          <View style={styles.weekendDivider} />
          <View style={styles.weekendHalf}>
            <Text style={styles.statLabel}>Weekend avg</Text>
            <Text style={styles.statValue}>{fmtCents(stats?.weekend_avg_cents ?? 0)}</Text>
          </View>
        </View>

        {/* Window chips */}
        <View style={styles.chipRow}>
          {WINDOW_CHIPS.map((opt, i) => {
            const isActive = i === windowIdx;
            return (
              <Text
                key={opt.label}
                onPress={() => setWindowIdx(i)}
                style={[styles.chip, isActive && styles.chipActive]}
              >
                {opt.label}
              </Text>
            );
          })}
        </View>

        {/* Heatmap grid */}
        <View style={cardStyle.card}>
          <Text style={styles.sectionTitle}>Daily spend grid</Text>
          <HeatGrid days={q.data?.days ?? []} />
          {/* Legend */}
          <View style={styles.legendRow}>
            <Text style={styles.legendLabel}>Less</Text>
            {[0, 1, 2, 3, 4, 5].map((step) => {
              const colors = ["#f1f5f9", "#a7f3d0", "#6ee7b7", "#34d399", "#10b981", "#047857"];
              return <View key={step} style={[styles.legendCell, { backgroundColor: colors[step] }]} />;
            })}
            <Text style={styles.legendLabel}>More</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const CELL_SIZE = 14;
const CELL_GAP = 2;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  content: { padding: 16, paddingBottom: 32 },

  statRow: { flexDirection: "row", marginBottom: 4 },
  statCard: { flex: 1, marginHorizontal: 4, marginBottom: 12 },
  statLabel: { color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  statValue: { color: C.text, fontSize: 18, fontWeight: "700", marginTop: 4 },
  statHint: { color: C.textSoft, fontSize: 11, marginTop: 4 },
  weekendRow: { flexDirection: "row" },
  weekendHalf: { flex: 1 },
  weekendDivider: { width: StyleSheet.hairlineWidth, backgroundColor: C.border, marginHorizontal: 8 },

  chipRow: { flexDirection: "row", marginBottom: 12 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
    marginRight: 8,
    color: C.text,
    fontSize: 12,
    fontWeight: "600",
    overflow: "hidden",
  },
  chipActive: { backgroundColor: C.brand, borderColor: C.brand, color: "#fff" },

  sectionTitle: { color: C.text, fontSize: 14, fontWeight: "600", marginBottom: 12 },

  grid: { flexDirection: "row" },
  dayLabels: { marginRight: 4, justifyContent: "space-around" },
  dayLabel: { color: C.textSoft, fontSize: 9, height: CELL_SIZE + CELL_GAP, lineHeight: CELL_SIZE + CELL_GAP },
  weeksRow: { flexDirection: "row" },
  weekColumn: { marginRight: CELL_GAP },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    marginBottom: CELL_GAP,
    borderRadius: 2,
  },
  cellEmpty: { width: CELL_SIZE, height: CELL_SIZE, marginBottom: CELL_GAP },

  legendRow: { flexDirection: "row", alignItems: "center", marginTop: 12, justifyContent: "flex-end" },
  legendLabel: { color: C.textSoft, fontSize: 10, marginHorizontal: 4 },
  legendCell: { width: 12, height: 12, marginHorizontal: 2, borderRadius: 2 },
});
