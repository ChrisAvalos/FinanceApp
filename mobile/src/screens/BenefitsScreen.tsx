/**
 * Card benefits — mobile screen.
 *
 * Mirrors the web BenefitsPanel: surfaces use-it-or-lose-it credits
 * across premium credit cards (Amex Platinum, Sapphire Reserve, etc.)
 * Phone-first treatment:
 *   • Hero card: net potential = total credits - total annual fees
 *   • Per-card cards listing benefit lines with $ value + cadence
 *   • Activation links open in browser
 */
import React from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import { api, fmtCents, type CardBenefitRow } from "../api/client";
import { C, cardStyle, headerStyles } from "../theme";

function CardBenefitsCard({ row }: { row: CardBenefitRow }) {
  const net = row.net_after_fee_cents;
  const netTone = net > 0 ? C.inflow : net < 0 ? C.outflow : C.textMuted;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.cardName}>{row.account_name}</Text>
          <Text style={styles.cardProfile}>{row.profile_name}</Text>
        </View>
        <View style={styles.netCol}>
          <Text style={styles.netLabel}>Net / yr</Text>
          <Text style={[styles.netValue, { color: netTone }]}>
            {net >= 0 ? "+" : ""}{fmtCents(net)}
          </Text>
        </View>
      </View>

      <View style={styles.feeRow}>
        <Text style={styles.feeLabel}>Annual fee</Text>
        <Text style={styles.feeValue}>{fmtCents(row.annual_fee_cents)}</Text>
        <Text style={styles.feeSeparator}>·</Text>
        <Text style={styles.feeLabel}>Credits</Text>
        <Text style={[styles.feeValue, { color: C.inflow }]}>
          {fmtCents(row.total_credit_value_cents)}
        </Text>
      </View>

      <View style={styles.benefitsList}>
        {row.benefits.map((b, i) => (
          <View key={`${row.account_id}-${i}`} style={styles.benefitRow}>
            <View style={styles.benefitLeft}>
              <Text style={styles.benefitName}>{b.name}</Text>
              {(b.cadence || b.notes) && (
                <Text style={styles.benefitMeta}>
                  {b.cadence ? b.cadence : ""}
                  {b.cadence && b.notes ? " · " : ""}
                  {b.notes ?? ""}
                </Text>
              )}
            </View>
            <View style={styles.benefitRight}>
              <Text style={styles.benefitValue}>{fmtCents(b.value_cents)}</Text>
              {b.activation_url && (
                <Pressable
                  onPress={() => Linking.openURL(b.activation_url!)}
                  style={({ pressed }) => [styles.actLink, pressed && { opacity: 0.5 }]}
                >
                  <Text style={styles.actLinkText}>Activate ↗</Text>
                </Pressable>
              )}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

export default function BenefitsScreen() {
  const q = useQuery({ queryKey: ["cardBenefits"], queryFn: () => api.cardBenefits() });

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  const r = q.data;
  const netTone = (r?.net_potential_cents ?? 0) > 0 ? C.inflow : C.outflow;

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Card benefits</Text>
        <Text style={headerStyles.headerSub}>
          {r?.rows.length ?? 0} cards tracked · use-it-or-lose-it credits
        </Text>
      </View>

      <FlatList
        data={r?.rows ?? []}
        keyExtractor={(row) => String(row.account_id)}
        renderItem={({ item }) => <CardBenefitsCard row={item} />}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={q.isFetching}
            onRefresh={() => q.refetch()}
            tintColor={C.brand}
          />
        }
        ListHeaderComponent={
          <View style={[cardStyle.card, styles.heroCard]}>
            <Text style={styles.heroLabel}>Net potential / year</Text>
            <Text style={[styles.heroValue, { color: netTone }]}>
              {(r?.net_potential_cents ?? 0) >= 0 ? "+" : ""}
              {fmtCents(r?.net_potential_cents ?? 0)}
            </Text>
            <View style={styles.heroSplit}>
              <View style={styles.heroSplitHalf}>
                <Text style={styles.heroSubLabel}>Face value</Text>
                <Text style={styles.heroSubValue}>{fmtCents(r?.total_face_value_cents ?? 0)}</Text>
              </View>
              <View style={styles.heroDivider} />
              <View style={styles.heroSplitHalf}>
                <Text style={styles.heroSubLabel}>Annual fees</Text>
                <Text style={[styles.heroSubValue, { color: C.outflow }]}>
                  {fmtCents(r?.total_annual_fee_cents ?? 0)}
                </Text>
              </View>
            </View>
            {r && r.unmatched_card_ids.length > 0 && (
              <Text style={styles.heroHint}>
                {r.unmatched_card_ids.length} card{r.unmatched_card_ids.length === 1 ? "" : "s"} not matched to a profile yet
              </Text>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.hint}>
              No matching cards yet. Add an Amex Platinum / Sapphire Reserve / etc. to surface annual credits.
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

  heroCard: { marginBottom: 12 },
  heroLabel: { color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  heroValue: { fontSize: 28, fontWeight: "700", marginTop: 4 },
  heroSplit: { flexDirection: "row", marginTop: 12 },
  heroSplitHalf: { flex: 1 },
  heroDivider: { width: StyleSheet.hairlineWidth, backgroundColor: C.border, marginHorizontal: 8 },
  heroSubLabel: { color: C.textSoft, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  heroSubValue: { color: C.text, fontSize: 14, fontWeight: "700", marginTop: 2 },
  heroHint: { color: C.warn, fontSize: 11, marginTop: 10 },

  card: {
    backgroundColor: C.card,
    padding: 12,
    borderRadius: 8,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start" },
  cardLeft: { flex: 1 },
  cardName: { color: C.text, fontSize: 14, fontWeight: "700" },
  cardProfile: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  netCol: { alignItems: "flex-end" },
  netLabel: { color: C.textSoft, fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 },
  netValue: { fontSize: 16, fontWeight: "700", marginTop: 2 },

  feeRow: {
    flexDirection: "row",
    alignItems: "baseline",
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.borderSoft,
    flexWrap: "wrap",
  },
  feeLabel: { color: C.textSoft, fontSize: 11, marginRight: 4 },
  feeValue: { color: C.text, fontSize: 12, fontWeight: "700" },
  feeSeparator: { color: C.textSoft, fontSize: 11, marginHorizontal: 8 },

  benefitsList: { marginTop: 8 },
  benefitRow: {
    flexDirection: "row",
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.borderSoft,
  },
  benefitLeft: { flex: 1, paddingRight: 8 },
  benefitName: { color: C.text, fontSize: 12, fontWeight: "600" },
  benefitMeta: { color: C.textSoft, fontSize: 10, marginTop: 2 },
  benefitRight: { alignItems: "flex-end" },
  benefitValue: { color: C.inflow, fontSize: 13, fontWeight: "700" },
  actLink: { marginTop: 4 },
  actLinkText: { color: C.brand, fontSize: 10, fontWeight: "600" },
});
