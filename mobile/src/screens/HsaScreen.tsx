/**
 * HSA receipt bank — mobile screen.
 *
 * Mirrors the web HsaPanel. The strategy: log eligible medical expenses
 * but DON'T reimburse — let the HSA grow tax-free for decades, then
 * reimburse later (no time limit on reimbursement under IRS rules).
 *
 * Phone-first treatment:
 *   • Hero: saved total (uncashed receipts) + 30yr-projection-at-7%
 *   • Per-receipt cards with "Mark reimbursed" inline action
 *   • Status filter chips
 */
import React, { useState } from "react";
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

import { api, fmtCents, type HsaReceipt, type HsaReceiptStatus } from "../api/client";
import { C, cardStyle, fmtShortDate, headerStyles } from "../theme";

const STATUS_TABS: { key: HsaReceiptStatus | "all"; label: string }[] = [
  { key: "saved", label: "Saved" },
  { key: "reimbursed", label: "Reimbursed" },
  { key: "voided", label: "Voided" },
  { key: "all", label: "All" },
];

function StatusBadge({ status }: { status: HsaReceiptStatus }) {
  const cfg: Record<HsaReceiptStatus, { label: string; bg: string; fg: string }> = {
    saved: { label: "Saved", bg: "#dbeafe", fg: "#1e40af" },
    reimbursed: { label: "Reimbursed", bg: "#d1fae5", fg: "#065f46" },
    voided: { label: "Voided", bg: "#e2e8f0", fg: "#475569" },
  };
  const c = cfg[status];
  return (
    <View style={[styles.pill, { backgroundColor: c.bg }]}>
      <Text style={[styles.pillText, { color: c.fg }]}>{c.label}</Text>
    </View>
  );
}

function ReceiptCard({
  r,
  onReimburse,
}: {
  r: HsaReceipt;
  onReimburse: () => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <View style={styles.metaRow}>
            <StatusBadge status={r.status} />
            <Text style={styles.dateText}>{fmtShortDate(r.expense_date)}</Text>
            {r.expense_category && (
              <Text style={styles.catText}>{r.expense_category}</Text>
            )}
          </View>
          <Text style={styles.descText} numberOfLines={2}>{r.description}</Text>
          {r.provider_name && (
            <Text style={styles.providerText} numberOfLines={1}>{r.provider_name}</Text>
          )}
        </View>
        <Text style={styles.amountText}>{fmtCents(r.amount_cents)}</Text>
      </View>
      {r.status === "saved" && (
        <View style={styles.actionRow}>
          <Pressable
            onPress={onReimburse}
            style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.actionBtnText}>Mark reimbursed</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

export default function HsaScreen() {
  const [statusIdx, setStatusIdx] = useState(0); // saved
  const qc = useQueryClient();

  const summaryQ = useQuery({ queryKey: ["hsaSummary"], queryFn: () => api.hsaSummary() });
  const receiptsQ = useQuery({
    queryKey: ["hsaReceipts", STATUS_TABS[statusIdx].key],
    queryFn: () => {
      const k = STATUS_TABS[statusIdx].key;
      return k === "all" ? api.listHsaReceipts() : api.listHsaReceipts(k);
    },
  });

  const reimburseMut = useMutation({
    mutationFn: (id: number) => api.reimburseHsaReceipt(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hsaReceipts"] });
      qc.invalidateQueries({ queryKey: ["hsaSummary"] });
    },
  });

  if (summaryQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  const s = summaryQ.data;

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>HSA receipts</Text>
        <Text style={headerStyles.headerSub}>
          Save now, reimburse decades later · {s?.total_receipts ?? 0} receipts
        </Text>
      </View>

      <FlatList
        data={receiptsQ.data ?? []}
        keyExtractor={(r) => String(r.id)}
        renderItem={({ item }) => (
          <ReceiptCard r={item} onReimburse={() => reimburseMut.mutate(item.id)} />
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={receiptsQ.isFetching || summaryQ.isFetching}
            onRefresh={() => {
              receiptsQ.refetch();
              summaryQ.refetch();
            }}
            tintColor={C.brand}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={[cardStyle.card, styles.heroCard]}>
              <Text style={styles.heroLabel}>Saved (eligible to reimburse)</Text>
              <Text style={styles.heroValue}>{fmtCents(s?.saved_total_cents ?? 0)}</Text>
              <Text style={styles.heroHint}>
                {s?.saved_count ?? 0} receipts · {fmtCents(s?.reimbursed_total_cents ?? 0)} reimbursed lifetime
              </Text>
            </View>

            <View style={[cardStyle.card, styles.projCard]}>
              <Text style={styles.projLabel}>Projected at 30yr / 7%</Text>
              <Text style={styles.projValue}>{fmtCents(s?.projected_at_30yr_7pct_cents ?? 0)}</Text>
              <Text style={styles.projHint}>
                If you let the HSA grow that long before reimbursing.
              </Text>
              {s?.summary_text && <Text style={styles.summaryText}>{s.summary_text}</Text>}
            </View>

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
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.hint}>
              No HSA receipts in this filter. Add eligible medical expenses on the web app to start logging.
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

  heroCard: { marginBottom: 8 },
  heroLabel: { color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  heroValue: { color: C.brand, fontSize: 26, fontWeight: "700", marginTop: 4 },
  heroHint: { color: C.textSoft, fontSize: 12, marginTop: 4 },

  projCard: { backgroundColor: C.brandLight, marginBottom: 12 },
  projLabel: { color: C.brand, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: "700" },
  projValue: { color: C.brand, fontSize: 22, fontWeight: "700", marginTop: 4 },
  projHint: { color: C.textMuted, fontSize: 11, marginTop: 4 },
  summaryText: { color: C.text, fontSize: 12, marginTop: 8, lineHeight: 18 },

  chipRowContent: { paddingVertical: 4, marginBottom: 6 },
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
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginBottom: 4 },
  pill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginRight: 6 },
  pillText: { fontSize: 10, fontWeight: "700" },
  dateText: { color: C.textMuted, fontSize: 11, marginRight: 6 },
  catText: { color: C.textSoft, fontSize: 11, fontStyle: "italic" },

  descText: { color: C.text, fontSize: 13, fontWeight: "600", marginTop: 2 },
  providerText: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  amountText: { color: C.brand, fontSize: 14, fontWeight: "700" },

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
});
