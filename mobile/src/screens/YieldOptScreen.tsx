/**
 * Yield optimization — mobile screen.
 *
 * Mirrors the web YieldOptPanel: surfaces idle cash sitting in low-APY
 * checking/savings accounts that could be earning more in HYSA / T-bills.
 *
 * Phone-first treatment:
 *   • Hero: total idle balance + total potential extra yearly earnings
 *   • Per-account cards with current APY, best alternative, $ delta
 *   • Tap an alternative product → opens the signup URL
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

import { api, fmtCents, type YieldArbAccount, type YieldArbProduct } from "../api/client";
import { C, cardStyle, headerStyles } from "../theme";

function ProductRow({ p }: { p: YieldArbProduct }) {
  return (
    <Pressable
      onPress={() => p.open_url && Linking.openURL(p.open_url)}
      style={({ pressed }) => [styles.productRow, pressed && { opacity: 0.6 }]}
    >
      <View style={styles.productLeft}>
        <Text style={styles.productName}>{p.name}</Text>
        <Text style={styles.productMeta}>
          {p.apy_pct.toFixed(2)}% APY
          {p.fdic_insured ? " · FDIC" : ""}
          {p.minimum_cents ? ` · min ${fmtCents(p.minimum_cents)}` : ""}
        </Text>
        {p.notes && <Text style={styles.productNotes}>{p.notes}</Text>}
      </View>
      <View style={styles.productRight}>
        <Text style={styles.productDelta}>
          {p.delta_vs_current_cents >= 0 ? "+" : ""}
          {fmtCents(p.delta_vs_current_cents)}
        </Text>
        <Text style={styles.productDeltaLabel}>per year</Text>
      </View>
    </Pressable>
  );
}

function AccountCard({ acct }: { acct: YieldArbAccount }) {
  const a = acct.account;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <Text style={styles.acctName} numberOfLines={1}>{a.account_name}</Text>
          <Text style={styles.acctMeta}>
            {fmtCents(a.balance_cents)} @ {a.current_apy_pct.toFixed(2)}% — earning{" "}
            {fmtCents(a.current_yearly_earnings_cents)}/yr
          </Text>
        </View>
        {acct.qualifies_for_arb && (
          <View style={styles.arbBadge}>
            <Text style={styles.arbBadgeText}>
              +{fmtCents(acct.best_yearly_delta_cents)}
            </Text>
          </View>
        )}
      </View>

      {acct.hysa_alternatives.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>HYSA alternatives</Text>
          {acct.hysa_alternatives.slice(0, 3).map((p, i) => (
            <ProductRow key={`h-${i}`} p={p} />
          ))}
        </>
      )}
      {acct.tbill_alternatives.length > 0 && (
        <>
          <Text style={styles.sectionLabel}>T-bill alternatives</Text>
          {acct.tbill_alternatives.slice(0, 3).map((p, i) => (
            <ProductRow key={`t-${i}`} p={p} />
          ))}
        </>
      )}
    </View>
  );
}

export default function YieldOptScreen() {
  const q = useQuery({ queryKey: ["yieldArbReport"], queryFn: () => api.yieldArbReport() });

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  const r = q.data;

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Idle cash</Text>
        <Text style={headerStyles.headerSub}>
          {r?.accounts.length ?? 0} accounts · HYSA / T-bill arbitrage
        </Text>
      </View>

      <FlatList
        data={r?.accounts ?? []}
        keyExtractor={(a) => String(a.account.account_id)}
        renderItem={({ item }) => <AccountCard acct={item} />}
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
            <Text style={styles.heroLabel}>Potential extra / year</Text>
            <Text style={[styles.heroValue, { color: C.inflow }]}>
              +{fmtCents(r?.total_yearly_potential_delta_cents ?? 0)}
            </Text>
            <Text style={styles.heroHint}>
              On {fmtCents(r?.total_idle_balance_cents ?? 0)} of idle balance
            </Text>
            {r?.summary_text && <Text style={styles.summaryText}>{r.summary_text}</Text>}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.hint}>
              No qualifying low-yield accounts. Either you're already arbing or balances are too small.
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
  heroHint: { color: C.textSoft, fontSize: 12, marginTop: 4 },
  summaryText: { color: C.text, fontSize: 12, marginTop: 10, lineHeight: 18 },

  card: {
    backgroundColor: C.card,
    padding: 12,
    borderRadius: 8,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start" },
  cardLeft: { flex: 1, paddingRight: 8 },
  acctName: { color: C.text, fontSize: 14, fontWeight: "700" },
  acctMeta: { color: C.textSoft, fontSize: 11, marginTop: 4 },
  arbBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: "#dcfce7",
    borderWidth: 1,
    borderColor: C.inflow,
  },
  arbBadgeText: { color: C.inflow, fontSize: 11, fontWeight: "700" },

  sectionLabel: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 10,
    marginBottom: 4,
  },
  productRow: {
    flexDirection: "row",
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.borderSoft,
  },
  productLeft: { flex: 1, paddingRight: 8 },
  productName: { color: C.brand, fontSize: 12, fontWeight: "700" },
  productMeta: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  productNotes: { color: C.textSoft, fontSize: 10, marginTop: 2, fontStyle: "italic" },
  productRight: { alignItems: "flex-end" },
  productDelta: { color: C.inflow, fontSize: 13, fontWeight: "700" },
  productDeltaLabel: { color: C.textSoft, fontSize: 10 },
});
