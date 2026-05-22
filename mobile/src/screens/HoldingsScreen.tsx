/**
 * Holdings (investments) — mobile screen.
 *
 * Mirrors the web HoldingsPanel: portfolio overview + allocation +
 * top holdings list. Pure-View bar chart for allocation slices (no
 * SVG dep). Long-press a row to refresh/recompute price.
 *
 * Phone-first treatment:
 *   • Hero: total value + unrealized gain/loss
 *   • Allocation: horizontal stacked bar with security_type slices
 *   • All holdings list (sorted by current value desc)
 */
import React from "react";
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

import { api, fmtCents, type AllocationSlice, type HoldingDetail } from "../api/client";
import { C, cardStyle, headerStyles } from "../theme";
import SyncFreshnessChip from "../components/SyncFreshness";

const TYPE_LABEL: Record<string, string> = {
  equity: "Equity",
  etf: "ETF",
  mutual_fund: "Mut. fund",
  crypto: "Crypto",
  bond: "Bond",
  other: "Other",
};

const TYPE_TONE: Record<string, string> = {
  equity: "#0b2a4a",
  etf: "#1e40af",
  mutual_fund: "#0d9488",
  crypto: "#a16207",
  bond: "#7c3aed",
  other: "#64748b",
};

function StackedAllocBar({ slices }: { slices: AllocationSlice[] }) {
  // Render a single horizontal bar with slice widths proportional to pct.
  const total = slices.reduce((s, x) => s + x.pct, 0) || 1;
  return (
    <View style={styles.allocBarOuter}>
      <View style={styles.allocBarInner}>
        {slices.map((s, i) => {
          const widthPct = (s.pct / total) * 100;
          return (
            <View
              key={s.security_type + i}
              style={{
                flexBasis: `${widthPct}%`,
                backgroundColor: TYPE_TONE[s.security_type] ?? C.brand,
              }}
            />
          );
        })}
      </View>
      <View style={styles.allocLegend}>
        {slices.map((s, i) => (
          <View key={s.security_type + i} style={styles.legendItem}>
            <View
              style={[
                styles.legendDot,
                { backgroundColor: TYPE_TONE[s.security_type] ?? C.brand },
              ]}
            />
            <Text style={styles.legendText}>
              {TYPE_LABEL[s.security_type] ?? s.security_type} · {s.pct.toFixed(1)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function HoldingCard({ h }: { h: HoldingDetail }) {
  const gain = h.unrealized_gain_cents;
  const tone = gain == null ? C.textMuted : gain >= 0 ? C.inflow : C.outflow;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <View style={styles.tickerRow}>
            {h.security_ticker && (
              <Text style={styles.ticker}>{h.security_ticker}</Text>
            )}
            <Text style={styles.typePill}>{TYPE_LABEL[h.security_type] ?? h.security_type}</Text>
          </View>
          <Text style={styles.secName} numberOfLines={1}>{h.security_name}</Text>
          <Text style={styles.acctName} numberOfLines={1}>{h.account_name}</Text>
        </View>
        <View style={styles.valueCol}>
          <Text style={styles.valueText}>{fmtCents(h.current_value_cents)}</Text>
          <Text style={styles.qtyText}>
            {h.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })} sh
          </Text>
          {gain != null && (
            <Text style={[styles.gainText, { color: tone }]}>
              {gain >= 0 ? "+" : ""}{fmtCents(gain)}
              {h.unrealized_gain_pct != null
                ? ` (${h.unrealized_gain_pct >= 0 ? "+" : ""}${h.unrealized_gain_pct.toFixed(1)}%)`
                : ""}
            </Text>
          )}
        </View>
      </View>
    </View>
  );
}

export default function HoldingsScreen() {
  const portfolioQ = useQuery({ queryKey: ["portfolio"], queryFn: () => api.portfolio() });
  const holdingsQ = useQuery({ queryKey: ["holdings"], queryFn: () => api.listHoldings() });

  if (portfolioQ.isLoading || holdingsQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  const p = portfolioQ.data;
  const gainTone =
    (p?.total_unrealized_gain_cents ?? 0) >= 0 ? C.inflow : C.outflow;

  const sortedHoldings = [...(holdingsQ.data ?? [])].sort(
    (a, b) => b.current_value_cents - a.current_value_cents,
  );

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Holdings</Text>
        <Text style={headerStyles.headerSub}>
          {p?.holdings_count ?? 0} positions across {p?.accounts_count ?? 0} accounts
        </Text>
      </View>

      <FlatList
        data={sortedHoldings}
        keyExtractor={(h) => String(h.id)}
        renderItem={({ item }) => <HoldingCard h={item} />}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={portfolioQ.isFetching || holdingsQ.isFetching}
            onRefresh={() => {
              portfolioQ.refetch();
              holdingsQ.refetch();
            }}
            tintColor={C.brand}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.chipRow}>
              <SyncFreshnessChip syncedAt={p?.as_of ?? null} label="Plaid prices" />
            </View>
            <View style={[cardStyle.card, styles.heroCard]}>
              <Text style={styles.heroLabel}>Portfolio value</Text>
              <Text style={styles.heroValue}>{fmtCents(p?.total_value_cents ?? 0)}</Text>
              <Text style={[styles.heroGain, { color: gainTone }]}>
                {(p?.total_unrealized_gain_cents ?? 0) >= 0 ? "+" : ""}
                {fmtCents(p?.total_unrealized_gain_cents ?? 0)} (
                {(p?.total_unrealized_gain_pct ?? 0) >= 0 ? "+" : ""}
                {(p?.total_unrealized_gain_pct ?? 0).toFixed(2)}%) unrealized
              </Text>
              <Text style={styles.heroHint}>
                Cost basis: {fmtCents(p?.total_cost_basis_cents ?? 0)}
              </Text>
            </View>

            {p && p.allocation_by_type.length > 0 && (
              <View style={[cardStyle.card]}>
                <Text style={styles.sectionTitle}>Allocation</Text>
                <StackedAllocBar slices={p.allocation_by_type} />
              </View>
            )}

            <Text style={styles.listLabel}>All holdings</Text>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.hint}>
              No holdings tracked yet. Connect a brokerage via Plaid (Investments product) to populate.
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
  chipRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 4 },
  heroCard: { marginBottom: 12 },
  heroLabel: { color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  heroValue: { color: C.brand, fontSize: 28, fontWeight: "700", marginTop: 4 },
  heroGain: { fontSize: 13, fontWeight: "700", marginTop: 6 },
  heroHint: { color: C.textSoft, fontSize: 11, marginTop: 4 },

  sectionTitle: { color: C.text, fontSize: 13, fontWeight: "700", marginBottom: 8 },
  allocBarOuter: { },
  allocBarInner: {
    height: 16,
    flexDirection: "row",
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: C.borderSoft,
  },
  allocLegend: { flexDirection: "row", flexWrap: "wrap", marginTop: 10 },
  legendItem: { flexDirection: "row", alignItems: "center", marginRight: 12, marginBottom: 4 },
  legendDot: { width: 10, height: 10, borderRadius: 2, marginRight: 4 },
  legendText: { color: C.textMuted, fontSize: 11 },

  listLabel: {
    color: C.textMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 6,
  },

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
  tickerRow: { flexDirection: "row", alignItems: "center", marginBottom: 4 },
  ticker: { color: C.brand, fontSize: 14, fontWeight: "700", marginRight: 6 },
  typePill: {
    color: C.textMuted,
    fontSize: 9,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    backgroundColor: C.borderSoft,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: "hidden",
  },
  secName: { color: C.text, fontSize: 12 },
  acctName: { color: C.textSoft, fontSize: 11, marginTop: 2 },

  valueCol: { alignItems: "flex-end" },
  valueText: { color: C.text, fontSize: 14, fontWeight: "700" },
  qtyText: { color: C.textSoft, fontSize: 10, marginTop: 2 },
  gainText: { fontSize: 11, fontWeight: "700", marginTop: 4 },
});
