/**
 * Net-worth attribution — mobile screen.
 *
 * Phone-friendly version of the web AttributionPanel. Renders one
 * row per month showing income/spending/debt-paydown/other and
 * lets you tap a row to expand its top-spending-categories drill-in.
 *
 * No bar chart on mobile — column real-estate is already tight, and
 * the numbers tell the story. The web has the visual.
 */
import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import { api, fmtCents, type AttributionMonth } from "../api/client";
import { C, cardStyle, headerStyles } from "../theme";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtSigned(c: number): string {
  if (c === 0) return "$0";
  return `${c > 0 ? "+" : "−"}${fmtCents(Math.abs(c))}`;
}

/* ------------------------------------------------------------------ */
/*  Per-month row                                                      */
/* ------------------------------------------------------------------ */

function MonthRow({
  month,
  expanded,
  onToggle,
}: {
  month: AttributionMonth;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isIncomplete = month.delta_cents === null;
  const deltaPositive = (month.delta_cents ?? 0) >= 0;

  return (
    <View>
      <Pressable onPress={onToggle} style={styles.row}>
        <View style={styles.rowMain}>
          <Text style={styles.rowLabel}>{month.month_label}</Text>
          {!isIncomplete && (
            <Text
              style={[
                styles.rowDelta,
                deltaPositive ? { color: C.inflow } : { color: C.outflow },
              ]}
            >
              Δ {fmtSigned(month.delta_cents ?? 0)}
            </Text>
          )}
          {isIncomplete && (
            <Text style={styles.rowIncomplete}>no snapshot</Text>
          )}
        </View>

        <View style={styles.rowSubLine}>
          <Text style={styles.rowSubText}>
            <Text style={{ color: C.inflow }}>+{fmtCents(month.income_cents)}</Text>
            {"  "}
            <Text style={{ color: C.outflow }}>−{fmtCents(month.spending_cents)}</Text>
            {month.debt_paydown_cents !== 0 && (
              <>
                {"  debt "}
                <Text style={{ color: "#7c3aed" }}>
                  {fmtSigned(month.debt_paydown_cents)}
                </Text>
              </>
            )}
            {month.other_cents !== null && (
              <>
                {"  other "}
                <Text
                  style={{
                    color: month.other_cents >= 0 ? "#7c3aed" : C.warn,
                  }}
                >
                  {fmtSigned(month.other_cents)}
                </Text>
              </>
            )}
          </Text>
          <Text style={styles.rowExpand}>{expanded ? "▾" : "▸"}</Text>
        </View>
      </Pressable>

      {expanded && month.top_spending_categories.length > 0 && (
        <View style={styles.drillin}>
          <Text style={styles.drillinTitle}>Top spending categories</Text>
          {month.top_spending_categories.map((c) => (
            <View key={c.name} style={styles.drillinRow}>
              <Text style={styles.drillinKey} numberOfLines={1}>
                {c.name}{" "}
                <Text style={{ color: C.textSoft }}>({c.txn_count})</Text>
              </Text>
              <Text style={[styles.drillinVal, { color: C.outflow }]}>
                {fmtCents(c.cents)}
              </Text>
            </View>
          ))}
          {month.nw_start_cents !== null && month.nw_end_cents !== null && (
            <Text style={styles.drillinNote}>
              NW: {fmtCents(month.nw_start_cents)} → {fmtCents(month.nw_end_cents)}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Main screen                                                        */
/* ------------------------------------------------------------------ */

export default function AttributionScreen() {
  const [months, setMonths] = useState(12);
  const [expanded, setExpanded] = useState<string | null>(null);

  const report = useQuery({
    queryKey: ["netWorthAttribution", months],
    queryFn: () => api.netWorthAttribution(months),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={report.isFetching}
          onRefresh={() => report.refetch()}
          tintColor={C.brand}
        />
      }
    >
      <Text style={headerStyles.h1}>Attribution</Text>
      <Text style={headerStyles.sub}>
        Why did net worth change each month?
      </Text>

      {/* Summary card */}
      {report.data?.summary_text && (
        <View style={[cardStyle.card, { marginTop: 8 }]}>
          <Text style={styles.summaryText}>{report.data.summary_text}</Text>
        </View>
      )}

      {/* Window selector */}
      <View style={styles.windowRow}>
        {[6, 12, 24, 36].map((n) => (
          <Pressable
            key={n}
            onPress={() => setMonths(n)}
            style={[
              styles.windowBtn,
              months === n && styles.windowBtnActive,
            ]}
          >
            <Text
              style={[
                styles.windowBtnText,
                months === n && styles.windowBtnTextActive,
              ]}
            >
              {n} mo
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Per-month list */}
      <View style={[cardStyle.card, { padding: 0, marginTop: 12 }]}>
        {report.isLoading ? (
          <View style={styles.spinner}>
            <ActivityIndicator color={C.brand} />
          </View>
        ) : report.data && report.data.months.length === 0 ? (
          <Text style={styles.muted}>No data yet.</Text>
        ) : (
          [...(report.data?.months ?? [])]
            .reverse()
            .map((m) => (
              <MonthRow
                key={m.month_start}
                month={m}
                expanded={expanded === m.month_start}
                onToggle={() =>
                  setExpanded((prev) =>
                    prev === m.month_start ? null : m.month_start,
                  )
                }
              />
            ))
        )}
      </View>

      <Text style={styles.footnote}>
        "Other" is the residual after cash flow — market gains, interest, or
        manual adjustments. Months without snapshot data show cash flow only.
      </Text>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles                                                             */
/* ------------------------------------------------------------------ */

const styles = StyleSheet.create({
  scroll: { backgroundColor: C.bg, flex: 1 },
  content: { padding: 16, paddingBottom: 80 },
  spinner: { padding: 36, alignItems: "center" },
  muted: { color: C.textMuted, textAlign: "center", padding: 24 },

  summaryText: { color: C.text, fontSize: 13, lineHeight: 19 },

  windowRow: {
    flexDirection: "row",
    gap: 6,
    marginTop: 12,
  },
  windowBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
    alignItems: "center",
  },
  windowBtnActive: {
    backgroundColor: C.brand,
    borderColor: C.brand,
  },
  windowBtnText: { color: C.textMuted, fontSize: 11, fontWeight: "600" },
  windowBtnTextActive: { color: "#fff" },

  row: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  rowMain: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  rowLabel: { color: C.text, fontSize: 14, fontWeight: "700" },
  rowDelta: { fontSize: 14, fontWeight: "700", fontVariant: ["tabular-nums"] },
  rowIncomplete: {
    color: C.textSoft,
    fontSize: 11,
    fontStyle: "italic",
  },
  rowSubLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 4,
  },
  rowSubText: {
    color: C.textMuted,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
    flex: 1,
  },
  rowExpand: { color: C.textSoft, fontSize: 14, marginLeft: 8 },

  drillin: {
    backgroundColor: C.hover,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  drillinTitle: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  drillinRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  drillinKey: { color: C.text, fontSize: 12, flex: 1 },
  drillinVal: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  drillinNote: {
    marginTop: 6,
    color: C.textSoft,
    fontSize: 10,
    fontStyle: "italic",
  },

  footnote: {
    color: C.textSoft,
    fontSize: 11,
    marginTop: 16,
    textAlign: "center",
    fontStyle: "italic",
  },
});
