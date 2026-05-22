/**
 * Anomaly / unusual transactions — mobile screen.
 *
 * Phone-first treatment:
 *   • Stat strip: anomalies count + window + threshold
 *   • Threshold chips (1.5σ / 2σ / 3σ / 4σ) in place of the web slider
 *   • Window chips (30d / 90d / 180d / 365d)
 *   • Per-anomaly cards with sigma badge + rationale
 *
 * Phone use-case: "did anything weird hit my card today?" — the
 * sorted-by-sigma list is the answer in one screen scroll.
 */
import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import { api, fmtCents, type AnomalyRow } from "../api/client";
import { C, fmtShortDate, headerStyles } from "../theme";

const WINDOW_CHIPS: { label: string; days: number }[] = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "180d", days: 180 },
  { label: "1y", days: 365 },
];

const SIGMA_CHIPS: { label: string; value: number }[] = [
  { label: "1.5σ", value: 1.5 },
  { label: "2σ", value: 2.0 },
  { label: "3σ", value: 3.0 },
  { label: "4σ", value: 4.0 },
];

function sigmaTone(s: number): string {
  if (s >= 5) return C.outflow;
  if (s >= 3.5) return C.warn;
  return C.brandAccent;
}

function AnomalyCard({ row }: { row: AnomalyRow }) {
  const tone = sigmaTone(row.sigma);
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <View style={styles.cardLabelRow}>
            <View style={[styles.sigmaPill, { backgroundColor: tone + "22", borderColor: tone }]}>
              <Text style={[styles.sigmaText, { color: tone }]}>
                {row.sigma.toFixed(1)}σ
              </Text>
            </View>
            <Text style={styles.dateText}>{fmtShortDate(row.posted_date)}</Text>
            {row.category_name && (
              <Text style={styles.categoryText}>{row.category_name}</Text>
            )}
          </View>
          <Text style={styles.descText} numberOfLines={2}>
            {row.description || "—"}
          </Text>
        </View>
        <Text style={styles.amountText}>{fmtCents(row.amount_cents)}</Text>
      </View>
      <Text style={styles.rationaleText}>{row.rationale}</Text>
    </View>
  );
}

function ChipRow<T extends { label: string }>({
  options,
  active,
  onPick,
}: {
  options: T[];
  active: number;
  onPick: (i: number) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.chipRowContent}
    >
      {options.map((opt, i) => {
        const isActive = i === active;
        return (
          <View key={opt.label} style={styles.chipWrap}>
            <Text
              onPress={() => onPick(i)}
              style={[styles.chip, isActive && styles.chipActive]}
            >
              {opt.label}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

export default function AnomalyScreen() {
  const [windowIdx, setWindowIdx] = useState(1); // 90d
  const [sigmaIdx, setSigmaIdx] = useState(2); // 3σ

  const days = WINDOW_CHIPS[windowIdx].days;
  const threshold = SIGMA_CHIPS[sigmaIdx].value;

  const q = useQuery({
    queryKey: ["anomalyScan", days, threshold],
    queryFn: () => api.anomalyScan(days, threshold),
  });

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Unusual transactions</Text>
        <Text style={headerStyles.headerSub}>
          {q.data?.anomalies.length ?? 0} flagged · {q.data?.transactions_scanned ?? 0} scanned
        </Text>
      </View>

      <View style={styles.toolbarCard}>
        <View style={styles.toolbarRow}>
          <Text style={styles.toolbarLabel}>Window</Text>
          <ChipRow options={WINDOW_CHIPS} active={windowIdx} onPick={setWindowIdx} />
        </View>
        <View style={styles.toolbarRow}>
          <Text style={styles.toolbarLabel}>Threshold</Text>
          <ChipRow options={SIGMA_CHIPS} active={sigmaIdx} onPick={setSigmaIdx} />
        </View>
      </View>

      <FlatList
        data={q.data?.anomalies ?? []}
        keyExtractor={(r) => String(r.transaction_id)}
        renderItem={({ item }) => <AnomalyCard row={item} />}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={q.isFetching}
            onRefresh={() => q.refetch()}
            tintColor={C.brand}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.hint}>
              No anomalies at this threshold. Try lowering σ to surface more.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  empty: { padding: 24, alignItems: "center" },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center" },

  toolbarCard: {
    backgroundColor: C.card,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  toolbarRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 4 },
  toolbarLabel: {
    color: C.textMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    width: 70,
  },
  chipRowContent: { paddingRight: 16 },
  chipWrap: { marginRight: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    color: C.text,
    fontSize: 12,
    fontWeight: "600",
    overflow: "hidden",
  },
  chipActive: {
    backgroundColor: C.brand,
    borderColor: C.brand,
    color: "#fff",
  },

  listContent: { padding: 16, paddingTop: 12 },
  card: {
    backgroundColor: C.card,
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start" },
  cardLeft: { flex: 1, paddingRight: 8 },
  cardLabelRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginBottom: 4 },
  sigmaPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    marginRight: 6,
  },
  sigmaText: { fontSize: 10, fontWeight: "700" },
  dateText: { color: C.textMuted, fontSize: 11, marginRight: 6 },
  categoryText: { color: C.textSoft, fontSize: 11, fontStyle: "italic" },
  descText: { color: C.text, fontSize: 13, fontWeight: "500", marginTop: 2 },
  amountText: { color: C.outflow, fontSize: 14, fontWeight: "700" },
  rationaleText: { color: C.textMuted, fontSize: 11, marginTop: 6, lineHeight: 16 },
});
