/**
 * Tax-time export — mobile screen.
 *
 * Mirrors the web TaxPanel: rolls up the year's transactions into
 * IRS-shaped buckets (charitable_donations, medical, business_expense,
 * etc.). Phone is read-only; for the actual CSV export, tap the link
 * to open the URL on a desktop browser.
 *
 * Phone-first treatment:
 *   • Year picker chip row
 *   • Hero: grand total outflow + inflow + untagged
 *   • Per-bucket cards (sorted by total)
 *   • "Untagged top categories" expander to surface gap categories
 */
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import { api, fmtCents, type TaxBucketRollup } from "../api/client";
import { C, cardStyle, headerStyles } from "../theme";

const BUCKET_LABELS: Record<string, string> = {
  charitable_donations: "Charitable donations",
  medical: "Medical expenses",
  business_expense: "Business expenses",
  state_local_tax: "State / local tax",
  property_tax: "Property tax",
  mortgage_interest: "Mortgage interest",
  student_loan_interest: "Student loan interest",
  investment_advisory: "Investment / advisory",
  hsa_contribution: "HSA contribution",
  ira_contribution: "IRA contribution",
};

function bucketLabel(slug: string): string {
  return BUCKET_LABELS[slug] ?? slug.replace(/_/g, " ");
}

function BucketCard({ b }: { b: TaxBucketRollup }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardLeft}>
        <Text style={styles.bucketName}>{bucketLabel(b.bucket)}</Text>
        <Text style={styles.bucketMeta}>{b.txn_count} transactions</Text>
      </View>
      <Text style={styles.bucketTotal}>{fmtCents(b.total_cents)}</Text>
    </View>
  );
}

export default function TaxScreen() {
  const currentYear = new Date().getFullYear();
  // Year picker: this year + 4 prior
  const yearOpts = useMemo(() => {
    const out: number[] = [];
    for (let y = currentYear; y >= currentYear - 4; y -= 1) out.push(y);
    return out;
  }, [currentYear]);
  const [year, setYear] = useState(currentYear);
  const [showUntagged, setShowUntagged] = useState(false);

  const q = useQuery({
    queryKey: ["taxReport", year],
    queryFn: () => api.taxReport(year),
  });

  const buckets = useMemo(
    () =>
      [...(q.data?.by_bucket ?? [])].sort((a, b) => b.total_cents - a.total_cents),
    [q.data],
  );

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  const r = q.data;
  const csvUrl = api.taxExportCsvUrl(year);

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Tax export · {year}</Text>
        <Text style={headerStyles.headerSub}>
          {r?.by_bucket.length ?? 0} buckets · {r?.untagged_txn_count ?? 0} untagged txns
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
        {/* Year chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRowContent}
        >
          {yearOpts.map((y) => (
            <Text
              key={y}
              onPress={() => setYear(y)}
              style={[styles.chip, y === year && styles.chipActive]}
            >
              {y}
            </Text>
          ))}
        </ScrollView>

        {/* Hero stats */}
        <View style={[cardStyle.card, styles.heroCard]}>
          <View style={styles.heroSplit}>
            <View style={styles.heroSplitHalf}>
              <Text style={styles.heroLabel}>Grand outflow</Text>
              <Text style={[styles.heroValue, { color: C.outflow }]}>
                {fmtCents(r?.grand_total_outflow_cents ?? 0)}
              </Text>
            </View>
            <View style={styles.heroDivider} />
            <View style={styles.heroSplitHalf}>
              <Text style={styles.heroLabel}>Grand inflow</Text>
              <Text style={[styles.heroValue, { color: C.inflow }]}>
                {fmtCents(r?.grand_total_inflow_cents ?? 0)}
              </Text>
            </View>
          </View>
          {(r?.untagged_total_cents ?? 0) > 0 && (
            <Text style={styles.heroHint}>
              Untagged: {fmtCents(r?.untagged_total_cents ?? 0)} across {r?.untagged_txn_count ?? 0} txns
            </Text>
          )}
          <Pressable
            onPress={() => Linking.openURL(csvUrl)}
            style={({ pressed }) => [styles.exportBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.exportBtnText}>Open CSV export ↗</Text>
          </Pressable>
        </View>

        {/* Bucket cards */}
        <Text style={styles.listLabel}>By tax bucket</Text>
        {buckets.length === 0 ? (
          <Text style={styles.empty}>
            No buckets matched. Tag transactions with `giving.charitable`, `medical.*`, etc. to populate.
          </Text>
        ) : (
          buckets.map((b) => <BucketCard key={b.bucket} b={b} />)
        )}

        {/* Untagged categories expander */}
        {r && r.untagged_top_categories.length > 0 && (
          <View>
            <Pressable
              onPress={() => setShowUntagged((v) => !v)}
              style={styles.expanderRow}
            >
              <Text style={styles.expanderText}>
                {showUntagged ? "▾" : "▸"} Top untagged categories ({r.untagged_top_categories.length})
              </Text>
            </Pressable>
            {showUntagged && (
              <View style={[cardStyle.card]}>
                {r.untagged_top_categories.slice(0, 12).map(([cat, cents]) => (
                  <View key={cat} style={styles.untaggedRow}>
                    <Text style={styles.untaggedCat}>{cat}</Text>
                    <Text style={styles.untaggedAmount}>{fmtCents(cents)}</Text>
                  </View>
                ))}
                <Text style={styles.untaggedHint}>
                  These categories aren't tagged into any tax bucket. Edit category metadata to opt them in.
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  content: { padding: 16, paddingBottom: 32 },
  empty: { color: C.textMuted, fontSize: 13, textAlign: "center", padding: 24 },

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

  heroCard: { marginBottom: 12 },
  heroSplit: { flexDirection: "row" },
  heroSplitHalf: { flex: 1 },
  heroDivider: { width: StyleSheet.hairlineWidth, backgroundColor: C.border, marginHorizontal: 8 },
  heroLabel: { color: C.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  heroValue: { fontSize: 18, fontWeight: "700", marginTop: 4 },
  heroHint: { color: C.textSoft, fontSize: 11, marginTop: 8 },
  exportBtn: {
    marginTop: 12,
    backgroundColor: C.brand,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 4,
    alignSelf: "flex-start",
  },
  exportBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },

  listLabel: {
    color: C.textMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  card: {
    backgroundColor: C.card,
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    flexDirection: "row",
    alignItems: "center",
  },
  cardLeft: { flex: 1, paddingRight: 8 },
  bucketName: { color: C.text, fontSize: 13, fontWeight: "700" },
  bucketMeta: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  bucketTotal: { color: C.brand, fontSize: 14, fontWeight: "700" },

  expanderRow: { paddingVertical: 8, alignItems: "center" },
  expanderText: { color: C.brand, fontSize: 12, fontWeight: "600" },
  untaggedRow: {
    flexDirection: "row",
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  untaggedCat: { flex: 1, color: C.text, fontSize: 12 },
  untaggedAmount: { color: C.textMuted, fontSize: 12, fontWeight: "600" },
  untaggedHint: { color: C.textSoft, fontSize: 11, marginTop: 8, fontStyle: "italic" },
});
