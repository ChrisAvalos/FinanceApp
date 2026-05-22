/**
 * Unclaimed property — mobile screen.
 *
 * Mirrors the web UnclaimedPanel: a "money you forgot about" inbox.
 * Phone-first treatment:
 *   • Hero card: pending estimated total + collected total
 *   • Status filter chips (Found / Claimed / Paid / Rejected / Dismissed)
 *   • State chip row (top states by count)
 *   • Per-record cards with "Mark Claimed" / "Mark Paid" inline actions
 *   • "Search tips" expander at the bottom for the federal/state lookup links
 */
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
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
  type UnclaimedRecord,
  type UnclaimedStatus,
} from "../api/client";
import { C, cardStyle, headerStyles } from "../theme";

const STATUS_TABS: { key: UnclaimedStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "found", label: "Found" },
  { key: "claimed", label: "Claimed" },
  { key: "paid", label: "Paid" },
  { key: "rejected", label: "Rejected" },
  { key: "dismissed", label: "Skipped" },
];

function StatusBadge({ status }: { status: UnclaimedStatus }) {
  const cfg: Record<UnclaimedStatus, { label: string; bg: string; fg: string }> = {
    found: { label: "Found", bg: "#dbeafe", fg: "#1e40af" },
    claimed: { label: "Claimed", bg: "#fef3c7", fg: "#92400e" },
    paid: { label: "Paid", bg: "#d1fae5", fg: "#065f46" },
    rejected: { label: "Rejected", bg: "#fee2e2", fg: "#991b1b" },
    dismissed: { label: "Skipped", bg: "#e2e8f0", fg: "#475569" },
  };
  const c = cfg[status];
  return (
    <View style={[styles.pill, { backgroundColor: c.bg }]}>
      <Text style={[styles.pillText, { color: c.fg }]}>{c.label}</Text>
    </View>
  );
}

function RecordCard({
  rec,
  onUpdate,
}: {
  rec: UnclaimedRecord;
  onUpdate: (next: UnclaimedStatus) => void;
}) {
  const canClaim = rec.status === "found";
  const canPay = rec.status === "claimed";

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <View style={styles.metaRow}>
            <StatusBadge status={rec.status} />
            <Text style={styles.stateText}>{rec.state}</Text>
            {rec.property_type && (
              <Text style={styles.kindText}>{rec.property_type}</Text>
            )}
          </View>
          <Text style={styles.holderText} numberOfLines={2}>
            {rec.holder_name || rec.owner_name}
          </Text>
          {rec.last_known_address && (
            <Text style={styles.addressText} numberOfLines={1}>
              {rec.last_known_address}
            </Text>
          )}
        </View>
        {rec.estimated_value_cents != null && (
          <Text style={styles.amountText}>{fmtCents(rec.estimated_value_cents)}</Text>
        )}
      </View>

      {rec.actual_payout_cents != null && (
        <Text style={styles.actualText}>
          Received: <Text style={styles.actualMoney}>{fmtCents(rec.actual_payout_cents)}</Text>
        </Text>
      )}

      <View style={styles.actionRow}>
        {rec.claim_url && (
          <Pressable
            onPress={() => rec.claim_url && Linking.openURL(rec.claim_url)}
            style={({ pressed }) => [styles.actionBtnPrimary, pressed && styles.pressedDim]}
          >
            <Text style={styles.actionBtnPrimaryText}>Open claim ↗</Text>
          </Pressable>
        )}
        {canClaim && (
          <Pressable
            onPress={() => onUpdate("claimed")}
            style={({ pressed }) => [styles.actionBtn, pressed && styles.pressedDim]}
          >
            <Text style={styles.actionBtnText}>Mark filed</Text>
          </Pressable>
        )}
        {canPay && (
          <Pressable
            onPress={() => onUpdate("paid")}
            style={({ pressed }) => [styles.actionBtn, pressed && styles.pressedDim]}
          >
            <Text style={styles.actionBtnText}>Mark paid</Text>
          </Pressable>
        )}
        {(rec.status === "found" || rec.status === "claimed") && (
          <Pressable
            onPress={() => onUpdate("dismissed")}
            style={({ pressed }) => [styles.actionBtnGhost, pressed && styles.pressedDim]}
          >
            <Text style={styles.actionBtnGhostText}>Skip</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export default function UnclaimedScreen() {
  const [statusIdx, setStatusIdx] = useState(0); // "all"
  const [stateFilter, setStateFilter] = useState<string | null>(null);
  const [showTips, setShowTips] = useState(false);
  const qc = useQueryClient();

  const statsQ = useQuery({ queryKey: ["unclaimedStats"], queryFn: () => api.unclaimedStats() });
  const tipsQ = useQuery({
    queryKey: ["unclaimedSearchTips"],
    queryFn: () => api.unclaimedSearchTips(),
    enabled: showTips,
  });
  const recordsQ = useQuery({
    queryKey: ["unclaimed", "all"],
    queryFn: () => api.listUnclaimed({ limit: 200 }),
  });

  const updateMut = useMutation({
    mutationFn: (vars: { id: number; status: UnclaimedStatus }) =>
      api.updateUnclaimedStatus(vars.id, vars.status),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["unclaimed"] });
      qc.invalidateQueries({ queryKey: ["unclaimedStats"] });
    },
  });

  const stats = statsQ.data;

  // State filter chips: derive top states from records.
  const stateOpts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of recordsQ.data ?? []) counts[r.state] = (counts[r.state] ?? 0) + 1;
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([s]) => s);
  }, [recordsQ.data]);

  const filtered = useMemo(() => {
    let rows = recordsQ.data ?? [];
    const statusKey = STATUS_TABS[statusIdx].key;
    if (statusKey !== "all") rows = rows.filter((r) => r.status === statusKey);
    if (stateFilter) rows = rows.filter((r) => r.state === stateFilter);
    return rows;
  }, [recordsQ.data, statusIdx, stateFilter]);

  if (recordsQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Unclaimed property</Text>
        <Text style={headerStyles.headerSub}>
          {stats?.total_count ?? 0} records · {stats?.paid_count ?? 0} paid
        </Text>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(r) => String(r.id)}
        renderItem={({ item }) => (
          <RecordCard
            rec={item}
            onUpdate={(next) => updateMut.mutate({ id: item.id, status: next })}
          />
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={recordsQ.isFetching || statsQ.isFetching}
            onRefresh={() => {
              recordsQ.refetch();
              statsQ.refetch();
            }}
            tintColor={C.brand}
          />
        }
        ListHeaderComponent={
          <View>
            {/* Hero stats */}
            <View style={[cardStyle.card, styles.heroCard]}>
              <Text style={styles.heroLabel}>Estimated pending</Text>
              <Text style={styles.heroValue}>
                {fmtCents(stats?.estimated_pending_cents ?? 0)}
              </Text>
              <Text style={styles.heroHint}>
                Already collected: {fmtCents(stats?.actual_collected_cents ?? 0)}
              </Text>
            </View>

            {/* Status tabs */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chipRowContent}
            >
              {STATUS_TABS.map((t, i) => {
                const active = i === statusIdx;
                return (
                  <Text
                    key={t.key}
                    onPress={() => setStatusIdx(i)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    {t.label}
                  </Text>
                );
              })}
            </ScrollView>

            {/* State filter (only if we have multiple states) */}
            {stateOpts.length > 1 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRowContent}
              >
                <Text
                  onPress={() => setStateFilter(null)}
                  style={[styles.chip, !stateFilter && styles.chipActive]}
                >
                  All states
                </Text>
                {stateOpts.map((s) => (
                  <Text
                    key={s}
                    onPress={() => setStateFilter(s)}
                    style={[styles.chip, stateFilter === s && styles.chipActive]}
                  >
                    {s}
                  </Text>
                ))}
              </ScrollView>
            )}

            <Pressable onPress={() => setShowTips((v) => !v)} style={styles.tipsToggle}>
              <Text style={styles.tipsToggleText}>
                {showTips ? "▾ Hide search tips" : "▸ Show search tips"}
              </Text>
            </Pressable>

            {showTips && tipsQ.data && (
              <View style={[cardStyle.card, styles.tipsCard]}>
                <Text style={styles.tipsIntro}>{tipsQ.data.intro}</Text>
                <Text style={styles.tipsHeading}>Federal</Text>
                {tipsQ.data.federal_resources.map((r) => (
                  <Pressable
                    key={r.url}
                    onPress={() => Linking.openURL(r.url)}
                    style={styles.linkRow}
                  >
                    <Text style={styles.linkName}>{r.name}</Text>
                    <Text style={styles.linkWhat}>{r.what}</Text>
                  </Pressable>
                ))}
                {tipsQ.data.state_resources.length > 0 && (
                  <>
                    <Text style={styles.tipsHeading}>State</Text>
                    {tipsQ.data.state_resources.map((r) => (
                      <Pressable
                        key={r.url}
                        onPress={() => Linking.openURL(r.url)}
                        style={styles.linkRow}
                      >
                        <Text style={styles.linkName}>
                          {r.state} — {r.name}
                        </Text>
                      </Pressable>
                    ))}
                  </>
                )}
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.hint}>
              No records match this filter. Try widening the status / state.
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
  heroLabel: {
    color: C.textMuted,
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  heroValue: { color: C.brand, fontSize: 28, fontWeight: "700", marginTop: 4 },
  heroHint: { color: C.textSoft, fontSize: 12, marginTop: 4 },

  chipRowContent: { paddingVertical: 4 },
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
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginBottom: 6 },
  pill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 6,
  },
  pillText: { fontSize: 10, fontWeight: "700" },
  stateText: { color: C.textMuted, fontSize: 11, fontWeight: "600", marginRight: 6 },
  kindText: { color: C.textSoft, fontSize: 11, fontStyle: "italic" },

  holderText: { color: C.text, fontSize: 13, fontWeight: "600" },
  addressText: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  amountText: { color: C.brand, fontSize: 15, fontWeight: "700" },
  actualText: { color: C.textMuted, fontSize: 11, marginTop: 6 },
  actualMoney: { color: C.inflow, fontWeight: "700" },

  actionRow: { flexDirection: "row", flexWrap: "wrap", marginTop: 10 },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: C.brandLight,
    borderWidth: 1,
    borderColor: C.brand,
    marginRight: 6,
    marginBottom: 4,
  },
  actionBtnText: { color: C.brand, fontSize: 11, fontWeight: "700" },
  actionBtnPrimary: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: C.brand,
    marginRight: 6,
    marginBottom: 4,
  },
  actionBtnPrimaryText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  actionBtnGhost: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: C.border,
    marginRight: 6,
    marginBottom: 4,
  },
  actionBtnGhostText: { color: C.textMuted, fontSize: 11, fontWeight: "700" },
  pressedDim: { opacity: 0.6 },

  tipsToggle: { paddingVertical: 8, alignItems: "center" },
  tipsToggleText: { color: C.brand, fontSize: 12, fontWeight: "600" },
  tipsCard: { marginBottom: 12 },
  tipsIntro: { color: C.text, fontSize: 12, marginBottom: 10, lineHeight: 18 },
  tipsHeading: {
    color: C.textMuted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 4,
  },
  linkRow: { paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.borderSoft },
  linkName: { color: C.brand, fontSize: 12, fontWeight: "600" },
  linkWhat: { color: C.textSoft, fontSize: 11, marginTop: 2 },
});
