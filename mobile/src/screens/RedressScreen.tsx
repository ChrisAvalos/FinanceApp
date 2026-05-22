/**
 * Regulatory redress — mobile screen.
 *
 * Mirrors the web RedressPanel: CFPB / state-AG settlements that match
 * the user's spending. Two modes:
 *   • Matches against your spend (RedressMatchReport) — the headline
 *   • Logged records (RedressRecord) — track filing → paid lifecycle
 */
import React, { useState } from "react";
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
  type RedressMatch,
  type RedressRecord,
  type RedressStatus,
} from "../api/client";
import { C, cardStyle, headerStyles } from "../theme";

type Tab = "matches" | "logged";

function MatchCard({ m }: { m: RedressMatch }) {
  const c = m.catalog_entry;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <View style={styles.metaRow}>
            <View style={[styles.pill, { backgroundColor: "#fef3c7" }]}>
              <Text style={[styles.pillText, { color: "#92400e" }]}>{c.agency}</Text>
            </View>
            <Text style={styles.companyText}>{c.company_name}</Text>
            {m.already_logged && (
              <View style={[styles.pill, { backgroundColor: "#d1fae5", marginLeft: 6 }]}>
                <Text style={[styles.pillText, { color: "#065f46" }]}>Logged</Text>
              </View>
            )}
          </View>
          <Text style={styles.titleText} numberOfLines={2}>{c.title}</Text>
          <Text style={styles.eligText} numberOfLines={3}>{c.eligibility_description}</Text>
          <Text style={styles.matchMeta}>
            {m.matched_transactions} txns matched · {fmtCents(m.matched_total_spend_cents)} spend
          </Text>
        </View>
        {c.estimated_per_user_cents != null && (
          <Text style={styles.amountText}>~{fmtCents(c.estimated_per_user_cents)}</Text>
        )}
      </View>

      {c.claim_url && (
        <Pressable
          onPress={() => Linking.openURL(c.claim_url!)}
          style={({ pressed }) => [styles.actionBtnPrimary, pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.actionBtnPrimaryText}>Open claim form ↗</Text>
        </Pressable>
      )}
    </View>
  );
}

function StatusBadge({ status }: { status: RedressStatus }) {
  const cfg: Record<RedressStatus, { label: string; bg: string; fg: string }> = {
    candidate: { label: "Candidate", bg: "#e2e8f0", fg: "#475569" },
    eligible: { label: "Eligible", bg: "#dbeafe", fg: "#1e40af" },
    pending_filed: { label: "Filed", bg: "#fef3c7", fg: "#92400e" },
    paid: { label: "Paid", bg: "#d1fae5", fg: "#065f46" },
    rejected: { label: "Rejected", bg: "#fee2e2", fg: "#991b1b" },
    dismissed: { label: "Skipped", bg: "#f1f5f9", fg: "#64748b" },
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
  rec: RedressRecord;
  onUpdate: (next: RedressStatus) => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <View style={styles.metaRow}>
            <StatusBadge status={rec.status} />
            <Text style={styles.companyText}>{rec.agency} · {rec.company_name}</Text>
          </View>
          <Text style={styles.titleText} numberOfLines={2}>{rec.title}</Text>
        </View>
        {(rec.actual_payout_cents ?? rec.estimated_per_user_cents) != null && (
          <Text style={styles.amountText}>
            {fmtCents(rec.actual_payout_cents ?? rec.estimated_per_user_cents ?? 0)}
          </Text>
        )}
      </View>

      <View style={styles.actionRow}>
        {rec.claim_url && (
          <Pressable
            onPress={() => Linking.openURL(rec.claim_url!)}
            style={({ pressed }) => [styles.actionBtnPrimary, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.actionBtnPrimaryText}>Open ↗</Text>
          </Pressable>
        )}
        {rec.status === "eligible" && (
          <Pressable
            onPress={() => onUpdate("pending_filed")}
            style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.actionBtnText}>Mark filed</Text>
          </Pressable>
        )}
        {rec.status === "pending_filed" && (
          <Pressable
            onPress={() => onUpdate("paid")}
            style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.actionBtnText}>Mark paid</Text>
          </Pressable>
        )}
        {(rec.status === "candidate" || rec.status === "eligible") && (
          <Pressable
            onPress={() => onUpdate("dismissed")}
            style={({ pressed }) => [styles.actionBtnGhost, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.actionBtnGhostText}>Skip</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export default function RedressScreen() {
  const [tab, setTab] = useState<Tab>("matches");
  const qc = useQueryClient();

  const matchQ = useQuery({
    queryKey: ["redressMatch"],
    queryFn: () => api.redressMatchSpend(730),
    enabled: tab === "matches",
  });
  const recordsQ = useQuery({
    queryKey: ["redressRecords"],
    queryFn: () => api.listRedress(),
    enabled: tab === "logged",
  });

  const updateMut = useMutation({
    mutationFn: (vars: { id: number; status: RedressStatus }) =>
      api.updateRedressStatus(vars.id, vars.status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["redressRecords"] }),
  });

  const isLoading = tab === "matches" ? matchQ.isLoading : recordsQ.isLoading;
  const isFetching = tab === "matches" ? matchQ.isFetching : recordsQ.isFetching;
  const refetch = () => (tab === "matches" ? matchQ.refetch() : recordsQ.refetch());

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Redress</Text>
        <Text style={headerStyles.headerSub}>
          {tab === "matches"
            ? `${matchQ.data?.matches.length ?? 0} matches in your spend`
            : `${recordsQ.data?.length ?? 0} logged records`}
        </Text>
      </View>

      <View style={styles.tabRow}>
        <Pressable
          onPress={() => setTab("matches")}
          style={[styles.tabBtn, tab === "matches" && styles.tabBtnActive]}
        >
          <Text style={[styles.tabBtnText, tab === "matches" && styles.tabBtnTextActive]}>
            Matches
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setTab("logged")}
          style={[styles.tabBtn, tab === "logged" && styles.tabBtnActive]}
        >
          <Text style={[styles.tabBtnText, tab === "logged" && styles.tabBtnTextActive]}>
            Logged
          </Text>
        </Pressable>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={C.brand} />
        </View>
      ) : tab === "matches" ? (
        <FlatList
          data={matchQ.data?.matches ?? []}
          keyExtractor={(m, i) => `${m.catalog_entry.company_name}-${i}`}
          renderItem={({ item }) => <MatchCard m={item} />}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor={C.brand} />
          }
          ListHeaderComponent={
            <View style={[cardStyle.card, styles.heroCard]}>
              <Text style={styles.heroLabel}>Estimated owed (matches)</Text>
              <Text style={styles.heroValue}>
                {fmtCents(matchQ.data?.total_estimated_cents ?? 0)}
              </Text>
              <Text style={styles.heroHint}>
                Based on transactions in the last 730 days
              </Text>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.hint}>
                No matches in your spend right now. New CFPB / state-AG cases get added regularly.
              </Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={recordsQ.data ?? []}
          keyExtractor={(r) => String(r.id)}
          renderItem={({ item }) => (
            <RecordCard
              rec={item}
              onUpdate={(next) => updateMut.mutate({ id: item.id, status: next })}
            />
          )}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={isFetching} onRefresh={refetch} tintColor={C.brand} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.hint}>
                Nothing logged yet. Switch to "Matches" to find redress that hits your spend.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  empty: { padding: 24, alignItems: "center" },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center" },

  tabRow: {
    flexDirection: "row",
    backgroundColor: C.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.borderSoft,
  },
  tabBtn: { flex: 1, paddingVertical: 10, alignItems: "center" },
  tabBtnActive: { borderBottomWidth: 2, borderBottomColor: C.brand },
  tabBtnText: { color: C.textMuted, fontSize: 12, fontWeight: "600" },
  tabBtnTextActive: { color: C.brand },

  listContent: { padding: 16, paddingBottom: 32 },
  heroCard: { marginBottom: 12 },
  heroLabel: { color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  heroValue: { color: C.brand, fontSize: 28, fontWeight: "700", marginTop: 4 },
  heroHint: { color: C.textSoft, fontSize: 12, marginTop: 4 },

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
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginBottom: 4 },
  pill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 6,
  },
  pillText: { fontSize: 10, fontWeight: "700" },
  companyText: { color: C.text, fontSize: 12, fontWeight: "600", flexShrink: 1 },
  titleText: { color: C.text, fontSize: 13, fontWeight: "600", marginTop: 4 },
  eligText: { color: C.textSoft, fontSize: 11, marginTop: 4, lineHeight: 16 },
  matchMeta: { color: C.textMuted, fontSize: 11, marginTop: 6, fontStyle: "italic" },
  amountText: { color: C.brand, fontSize: 14, fontWeight: "700" },

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
    alignSelf: "flex-start",
    marginTop: 8,
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
});
