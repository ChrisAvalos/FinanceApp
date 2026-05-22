/**
 * Net Worth — mobile screen.
 *
 * Three sections:
 *   • Hero card with net worth headline + 30d/1y delta pills
 *   • Assets / Liabilities split (two cards side-by-side)
 *   • Breakdown table by account_type
 *
 * Sparkline of historical net worth deferred to a follow-up — phone
 * SVG via react-native-svg adds a dep. The deltas already convey the
 * trend signal that matters most.
 */
import React from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQuery } from "@tanstack/react-query";

import { api, fmtCents } from "../api/client";
import { C, cardStyle, headerStyles } from "../theme";
import SyncFreshnessChip from "../components/SyncFreshness";

function DeltaPill({
  cents,
  label,
}: {
  cents: number | null | undefined;
  label: string;
}) {
  if (cents == null) {
    return (
      <View style={styles.deltaWrap}>
        <Text style={styles.deltaLabel}>{label}</Text>
        <Text style={styles.deltaPlaceholder}>—</Text>
      </View>
    );
  }
  const tone = cents >= 0 ? C.inflow : C.outflow;
  const sign = cents >= 0 ? "+" : "";
  return (
    <View style={styles.deltaWrap}>
      <Text style={styles.deltaLabel}>{label}</Text>
      <Text style={[styles.deltaValue, { color: tone }]}>
        {sign}{fmtCents(cents)}
      </Text>
    </View>
  );
}

export default function NetWorthScreen() {
  const summary = useQuery({ queryKey: ["netWorth"], queryFn: api.netWorth });
  const history = useQuery({
    queryKey: ["netWorthHistory", 365],
    queryFn: () => api.netWorthHistory(365),
  });

  const refetchAll = () => {
    summary.refetch();
    history.refetch();
  };

  if (summary.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }
  if (summary.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Couldn't load</Text>
        <Text style={styles.errorBody}>{(summary.error as Error).message}</Text>
      </View>
    );
  }

  const s = summary.data;
  const breakdown = (s?.breakdown ?? [])
    .slice()
    .sort((a, b) => Math.abs(b.total_cents) - Math.abs(a.total_cents));

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Net worth</Text>
        <Text style={headerStyles.headerSub}>
          As of {s?.as_of ?? "—"}
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={summary.isFetching || history.isFetching}
            onRefresh={refetchAll}
            tintColor={C.brand}
          />
        }
      >
        <View style={styles.chipRow}>
          <SyncFreshnessChip syncedAt={s?.as_of ?? null} label="Snapshot" />
        </View>
        {/* Hero */}
        <View style={[cardStyle.card, styles.hero]}>
          <Text style={styles.heroLabel}>Net worth</Text>
          <Text style={styles.heroAmount}>
            {fmtCents(s?.net_cents ?? 0)}
          </Text>
          <View style={styles.deltaRow}>
            <DeltaPill cents={history.data?.delta_30d_cents ?? null} label="Δ 30d" />
            <View style={styles.deltaSep} />
            <DeltaPill cents={history.data?.delta_1y_cents ?? null} label="Δ 1y" />
          </View>
        </View>

        {/* Assets / Liabilities */}
        <View style={styles.splitRow}>
          <View style={[cardStyle.card, styles.splitCard]}>
            <Text style={styles.splitLabel}>Assets</Text>
            <Text style={[styles.splitAmount, { color: C.inflow }]}>
              {fmtCents(s?.assets_cents ?? 0)}
            </Text>
            {s?.accounts_with_no_balance ? (
              <Text style={styles.splitHint}>
                {s.accounts_with_no_balance} account{s.accounts_with_no_balance === 1 ? "" : "s"} missing balance
              </Text>
            ) : (
              <Text style={styles.splitHint}>All accounts reporting</Text>
            )}
          </View>
          <View style={[cardStyle.card, styles.splitCard]}>
            <Text style={styles.splitLabel}>Liabilities</Text>
            <Text style={[styles.splitAmount, { color: C.outflow }]}>
              {fmtCents(-(s?.liabilities_cents ?? 0))}
            </Text>
          </View>
        </View>

        {/* Breakdown */}
        {breakdown.length > 0 && (
          <View style={cardStyle.card}>
            <Text style={styles.sectionTitle}>Breakdown by account type</Text>
            {breakdown.map((b, i) => (
              <View
                key={`${b.account_type}-${i}`}
                style={[
                  styles.breakdownRow,
                  i < breakdown.length - 1 && styles.breakdownRowBorder,
                ]}
              >
                <View style={styles.breakdownLeft}>
                  <Text style={styles.breakdownType}>{b.account_type}</Text>
                  <Text style={styles.breakdownKind}>
                    {b.kind} · {b.accounts} account{b.accounts === 1 ? "" : "s"}
                  </Text>
                </View>
                <Text
                  style={[
                    styles.breakdownAmount,
                    { color: b.kind === "asset" ? C.inflow : C.outflow },
                  ]}
                >
                  {fmtCents(b.kind === "asset" ? b.total_cents : -b.total_cents)}
                </Text>
              </View>
            ))}
          </View>
        )}

        {history.data?.series && history.data.series.length > 0 && (
          <View style={cardStyle.card}>
            <Text style={styles.sectionTitle}>History</Text>
            <Text style={styles.historyHint}>
              {history.data.series.length} snapshot{history.data.series.length === 1 ? "" : "s"} between{" "}
              {history.data.earliest} and {history.data.latest}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  errorTitle: { color: C.outflow, fontSize: 16, fontWeight: "600" },
  errorBody: { color: C.text, marginTop: 8, fontSize: 12, textAlign: "center" },
  content: { padding: 16, paddingBottom: 32 },
  chipRow: { flexDirection: "row", justifyContent: "flex-end", marginBottom: 4 },

  hero: { backgroundColor: C.brand, marginBottom: 12 },
  heroLabel: { color: C.brandLight, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 },
  heroAmount: { color: "#fff", fontSize: 36, fontWeight: "700", marginTop: 4 },
  deltaRow: { flexDirection: "row", marginTop: 16, alignItems: "center" },
  deltaSep: { width: 16 },
  deltaWrap: { flex: 1 },
  deltaLabel: { color: C.brandLight, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  deltaValue: { fontSize: 16, fontWeight: "600", marginTop: 2 },
  deltaPlaceholder: { color: "#fff", fontSize: 16, marginTop: 2 },

  splitRow: { flexDirection: "row", marginBottom: 4 },
  splitCard: { flex: 1, marginHorizontal: 4, marginBottom: 12 },
  splitLabel: { color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  splitAmount: { fontSize: 22, fontWeight: "700", marginTop: 4 },
  splitHint: { color: C.textSoft, fontSize: 11, marginTop: 4 },

  sectionTitle: { color: C.text, fontSize: 14, fontWeight: "600", marginBottom: 8 },
  breakdownRow: {
    flexDirection: "row",
    paddingVertical: 10,
    alignItems: "center",
  },
  breakdownRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.borderSoft },
  breakdownLeft: { flex: 1 },
  breakdownType: { color: C.text, fontSize: 13, fontWeight: "500", textTransform: "capitalize" },
  breakdownKind: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  breakdownAmount: { fontSize: 14, fontWeight: "600" },

  historyHint: { color: C.textSoft, fontSize: 12 },
});
