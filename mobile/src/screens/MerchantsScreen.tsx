/**
 * Merchant deep-dive — mobile screen.
 *
 * Mirrors the web MerchantsPanel: a "where am I bleeding money?" view.
 * Shows the merchant rollup list (top spend by merchant), tap to see
 * the detail (monthly trend bars, recent txns, related sub).
 *
 * Phone-first treatment:
 *   • Merchant rollup list (sorted by lifetime spend)
 *   • Tap → modal-like detail view with monthly bar chart + txns
 */
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
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
  type MerchantDetail,
  type MerchantMonthlySpend,
  type MerchantRollupRow,
} from "../api/client";
import { C, cardStyle, fmtShortDate, headerStyles } from "../theme";

function MonthlyBars({ months }: { months: MerchantMonthlySpend[] }) {
  // Tail to last 12 months for compactness on phone.
  const trail = months.slice(-12);
  const max = Math.max(...trail.map((m) => m.total_cents), 1);
  return (
    <View style={styles.barsRow}>
      {trail.map((m) => {
        const h = (m.total_cents / max) * 60;
        return (
          <View key={m.month_start} style={styles.barCell}>
            <View style={[styles.bar, { height: Math.max(h, 2), backgroundColor: C.brand }]} />
            <Text style={styles.barLabel}>{m.month_start.slice(5, 7)}</Text>
          </View>
        );
      })}
    </View>
  );
}

function MerchantDetailView({
  merchantKey,
  onClose,
}: {
  merchantKey: string | null;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ["merchantDetail", merchantKey],
    queryFn: () => api.merchantDetail(merchantKey!),
    enabled: !!merchantKey,
  });
  return (
    <Modal
      visible={!!merchantKey}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <View style={styles.modalScreen}>
        <View style={[headerStyles.header, styles.modalHeader]}>
          <View style={{ flex: 1 }}>
            <Text style={headerStyles.headerTitle} numberOfLines={1}>
              {q.data?.display_name ?? merchantKey ?? ""}
            </Text>
            {q.data && (
              <Text style={headerStyles.headerSub}>
                {q.data.transactions} txns · {fmtCents(q.data.lifetime_spend_cents)} lifetime
              </Text>
            )}
          </View>
          <Pressable onPress={onClose} style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.6 }]}>
            <Text style={styles.closeBtnText}>Close</Text>
          </Pressable>
        </View>

        {q.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={C.brand} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.modalContent}>
            {q.data && (
              <View>
                <View style={styles.statGrid}>
                  <View style={[cardStyle.card, styles.statCell]}>
                    <Text style={styles.statLabel}>Avg / visit</Text>
                    <Text style={styles.statValue}>{fmtCents(q.data.avg_per_visit_cents)}</Text>
                  </View>
                  <View style={[cardStyle.card, styles.statCell]}>
                    <Text style={styles.statLabel}>Median / visit</Text>
                    <Text style={styles.statValue}>{fmtCents(q.data.median_per_visit_cents)}</Text>
                  </View>
                </View>
                <View style={[cardStyle.card]}>
                  <Text style={styles.metaText}>
                    First seen: {fmtShortDate(q.data.first_seen)} · Last: {fmtShortDate(q.data.last_seen)}
                    {q.data.primary_category ? ` · ${q.data.primary_category}` : ""}
                  </Text>
                </View>

                {q.data.monthly_breakdown.length > 0 && (
                  <View style={[cardStyle.card]}>
                    <Text style={styles.sectionTitle}>Monthly trend</Text>
                    <MonthlyBars months={q.data.monthly_breakdown} />
                  </View>
                )}

                {q.data.related_subscription && (
                  <View style={[cardStyle.card, styles.subBox]}>
                    <Text style={styles.subLabel}>Linked subscription</Text>
                    <Text style={styles.subName}>{q.data.related_subscription.name}</Text>
                    <Text style={styles.subMeta}>
                      {q.data.related_subscription.subscription_type} ·{" "}
                      {q.data.related_subscription.status}
                      {q.data.related_subscription.last_amount_cents != null
                        ? ` · ${fmtCents(q.data.related_subscription.last_amount_cents)}`
                        : ""}
                    </Text>
                  </View>
                )}

                {q.data.recent_transactions.length > 0 && (
                  <View style={[cardStyle.card]}>
                    <Text style={styles.sectionTitle}>Recent transactions</Text>
                    {q.data.recent_transactions.slice(0, 25).map((t) => (
                      <View key={t.id} style={styles.txnRow}>
                        <Text style={styles.txnDate}>{fmtShortDate(t.posted_date)}</Text>
                        <Text style={styles.txnDesc} numberOfLines={1}>{t.description_raw}</Text>
                        <Text style={styles.txnAmount}>{fmtCents(t.amount_cents)}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function RollupCard({
  row,
  onTap,
}: {
  row: MerchantRollupRow;
  onTap: () => void;
}) {
  return (
    <Pressable onPress={onTap} style={({ pressed }) => [styles.card, pressed && { opacity: 0.6 }]}>
      <View style={styles.cardLeft}>
        <Text style={styles.merchantName} numberOfLines={1}>{row.display_name}</Text>
        <Text style={styles.merchantMeta}>
          {row.transaction_count} txns · {fmtCents(row.median_per_visit_cents)} typ
          {row.primary_category_name ? ` · ${row.primary_category_name}` : ""}
        </Text>
      </View>
      <View style={styles.totalCol}>
        <Text style={styles.totalText}>{fmtCents(row.total_lifetime_cents)}</Text>
        <Text style={styles.monthlyText}>{fmtCents(row.monthly_avg_cents)}/mo avg</Text>
      </View>
    </Pressable>
  );
}

export default function MerchantsScreen() {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["merchantRollup"],
    queryFn: () => api.merchantRollup(365, 3),
  });

  const sorted = useMemo(
    () => [...(q.data ?? [])].sort((a, b) => b.total_lifetime_cents - a.total_lifetime_cents),
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
        <Text style={headerStyles.headerTitle}>Merchants</Text>
        <Text style={headerStyles.headerSub}>
          {sorted.length} merchants · last 365 days · tap to deep-dive
        </Text>
      </View>

      <FlatList
        data={sorted}
        keyExtractor={(r) => r.merchant_key}
        renderItem={({ item }) => (
          <RollupCard row={item} onTap={() => setOpenKey(item.merchant_key)} />
        )}
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
              No merchant rollup yet. Sync some transactions to populate.
            </Text>
          </View>
        }
      />

      <MerchantDetailView merchantKey={openKey} onClose={() => setOpenKey(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  empty: { padding: 24, alignItems: "center" },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center" },

  listContent: { padding: 16, paddingBottom: 32 },

  card: {
    backgroundColor: C.card,
    padding: 12,
    borderRadius: 8,
    marginBottom: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    flexDirection: "row",
    alignItems: "center",
  },
  cardLeft: { flex: 1, paddingRight: 8 },
  merchantName: { color: C.text, fontSize: 13, fontWeight: "600" },
  merchantMeta: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  totalCol: { alignItems: "flex-end" },
  totalText: { color: C.brand, fontSize: 14, fontWeight: "700" },
  monthlyText: { color: C.textSoft, fontSize: 10, marginTop: 2 },

  // Modal styles
  modalScreen: { flex: 1, backgroundColor: C.bg },
  modalHeader: { flexDirection: "row", alignItems: "center" },
  modalContent: { padding: 16, paddingBottom: 32 },
  closeBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "rgba(255,255,255,0.2)",
    borderRadius: 4,
  },
  closeBtnText: { color: "#fff", fontSize: 12, fontWeight: "600" },

  statGrid: { flexDirection: "row", gap: 8, marginBottom: 0 },
  statCell: { flex: 1 },
  statLabel: {
    color: C.textMuted,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statValue: { color: C.text, fontSize: 16, fontWeight: "700", marginTop: 4 },
  metaText: { color: C.textMuted, fontSize: 11 },
  sectionTitle: { color: C.text, fontSize: 13, fontWeight: "700", marginBottom: 8 },

  barsRow: { flexDirection: "row", alignItems: "flex-end", height: 80 },
  barCell: { flex: 1, alignItems: "center", marginHorizontal: 1 },
  bar: { width: "70%", borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  barLabel: { color: C.textSoft, fontSize: 8, marginTop: 4 },

  subBox: { backgroundColor: C.brandLight },
  subLabel: { color: C.brand, fontSize: 10, textTransform: "uppercase", fontWeight: "700", letterSpacing: 0.5 },
  subName: { color: C.text, fontSize: 14, fontWeight: "700", marginTop: 4 },
  subMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },

  txnRow: {
    flexDirection: "row",
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.borderSoft,
    alignItems: "center",
  },
  txnDate: { color: C.textMuted, fontSize: 11, width: 50 },
  txnDesc: { flex: 1, color: C.text, fontSize: 12 },
  txnAmount: { color: C.outflow, fontSize: 12, fontWeight: "700" },
});
