/**
 * Shopping patterns (recurring purchases) — mobile screen.
 *
 * Mirrors the web ShoppingPatternsPanel: surfaces things you re-buy
 * regularly (groceries, household supplies, etc.) detected from
 * receipt line items.
 *
 * Phone-first treatment:
 *   • Status filter chips (Active / Inactive / Dismissed)
 *   • Per-pattern cards with cadence label, typical price, next-expected
 *   • Tap a pattern → mark dismissed (mute it)
 */
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  api,
  fmtCents,
  type RecurringPurchase,
  type RecurringPurchaseStatus,
} from "../api/client";
import { C, fmtRelativeDate, fmtShortDate, headerStyles } from "../theme";

const STATUS_TABS: { key: RecurringPurchaseStatus; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "inactive", label: "Stale" },
  { key: "dismissed", label: "Skipped" },
];

function PatternCard({
  p,
  onDismiss,
  onRevive,
}: {
  p: RecurringPurchase;
  onDismiss: () => void;
  onRevive: () => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.name} numberOfLines={2}>{p.canonical_name}</Text>
          <Text style={styles.metaLine}>
            {p.primary_merchant ? `${p.primary_merchant} · ` : ""}
            {p.cadence_label || "—"}
            {p.occurrence_count ? ` · ${p.occurrence_count} buys` : ""}
            {p.category ? ` · ${p.category}` : ""}
          </Text>
        </View>
        <View style={styles.priceCol}>
          {p.typical_line_total_cents != null && (
            <Text style={styles.priceText}>{fmtCents(p.typical_line_total_cents)}</Text>
          )}
          {p.annualized_cost_cents != null && (
            <Text style={styles.annualText}>
              {fmtCents(p.annualized_cost_cents)}/yr
            </Text>
          )}
        </View>
      </View>

      <View style={styles.statsRow}>
        {p.last_purchased_at && (
          <Text style={styles.stat}>
            Last: <Text style={styles.statBold}>{fmtShortDate(p.last_purchased_at)}</Text>
          </Text>
        )}
        {p.next_expected_at && (
          <Text style={styles.stat}>
            Next: <Text style={styles.statBold}>{fmtRelativeDate(p.next_expected_at)}</Text>
          </Text>
        )}
        {p.confidence_score > 0 && (
          <Text style={styles.stat}>
            Conf: <Text style={styles.statBold}>{(p.confidence_score * 100).toFixed(0)}%</Text>
          </Text>
        )}
      </View>

      <View style={styles.actionRow}>
        {p.status === "active" || p.status === "inactive" ? (
          <Pressable
            onPress={onDismiss}
            style={({ pressed }) => [styles.actionBtnGhost, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.actionBtnGhostText}>Skip</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={onRevive}
            style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.actionBtnText}>Revive</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export default function ShoppingPatternsScreen() {
  const [statusIdx, setStatusIdx] = useState(0); // active
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["recurringPurchases", STATUS_TABS[statusIdx].key],
    queryFn: () =>
      api.listRecurringPurchasesFull({ status: STATUS_TABS[statusIdx].key }),
  });

  const patchMut = useMutation({
    mutationFn: (vars: { id: number; status: RecurringPurchaseStatus }) =>
      api.patchRecurringPurchase(vars.id, { status: vars.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurringPurchases"] }),
  });

  const sorted = useMemo(
    () =>
      [...(q.data ?? [])].sort(
        (a, b) =>
          (b.annualized_cost_cents ?? 0) - (a.annualized_cost_cents ?? 0),
      ),
    [q.data],
  );

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
        <Text style={headerStyles.headerTitle}>Shopping patterns</Text>
        <Text style={headerStyles.headerSub}>
          {sorted.length} {STATUS_TABS[statusIdx].label.toLowerCase()} patterns
        </Text>
      </View>

      <FlatList
        data={sorted}
        keyExtractor={(p) => String(p.id)}
        renderItem={({ item }) => (
          <PatternCard
            p={item}
            onDismiss={() => patchMut.mutate({ id: item.id, status: "dismissed" })}
            onRevive={() => patchMut.mutate({ id: item.id, status: "active" })}
          />
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={q.isFetching}
            onRefresh={() => q.refetch()}
            tintColor={C.brand}
          />
        }
        ListHeaderComponent={
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRowContent}
          >
            {STATUS_TABS.map((t, i) => (
              <Text
                key={t.key}
                onPress={() => setStatusIdx(i)}
                style={[styles.chip, i === statusIdx && styles.chipActive]}
              >
                {t.label}
              </Text>
            ))}
          </ScrollView>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.hint}>
              No patterns in this filter. Add receipts on the web to detect recurring buys.
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

  listContent: { padding: 16, paddingBottom: 32 },

  chipRowContent: { paddingVertical: 4, marginBottom: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    color: C.text,
    fontSize: 12,
    fontWeight: "600",
    overflow: "hidden",
    marginRight: 6,
  },
  chipActive: { backgroundColor: C.brand, borderColor: C.brand, color: "#fff" },

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
  name: { color: C.text, fontSize: 13, fontWeight: "700" },
  metaLine: { color: C.textSoft, fontSize: 11, marginTop: 4 },

  priceCol: { alignItems: "flex-end" },
  priceText: { color: C.brand, fontSize: 14, fontWeight: "700" },
  annualText: { color: C.textSoft, fontSize: 10, marginTop: 2 },

  statsRow: { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },
  stat: { color: C.textMuted, fontSize: 11, marginRight: 12 },
  statBold: { color: C.text, fontWeight: "700" },

  actionRow: { flexDirection: "row", marginTop: 8 },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: C.brandLight,
    borderWidth: 1,
    borderColor: C.brand,
  },
  actionBtnText: { color: C.brand, fontSize: 11, fontWeight: "700" },
  actionBtnGhost: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: C.border,
  },
  actionBtnGhostText: { color: C.textMuted, fontSize: 11, fontWeight: "700" },
});
