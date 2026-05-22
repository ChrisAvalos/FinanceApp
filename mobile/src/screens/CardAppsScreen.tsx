/**
 * Card applications (5/24, sign-up bonuses) — mobile screen.
 *
 * Mirrors the web CardAppsPanel: track Chase 5/24, Amex lifetime,
 * sign-up bonus minimum spend progress.
 *
 * Phone-first treatment:
 *   • Chase 5/24 hero card with under/over status
 *   • Status filter chips
 *   • Per-application cards with min-spend progress bar + bonus deadline
 *   • Compressed Amex lifetime list at the bottom
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
  type CardApplication,
  type CardApplicationStatus,
} from "../api/client";
import { C, cardStyle, fmtRelativeDate, headerStyles } from "../theme";

const STATUS_TABS: { key: CardApplicationStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "planning", label: "Planning" },
  { key: "applied", label: "Applied" },
  { key: "approved", label: "Approved" },
  { key: "spending", label: "Spending" },
  { key: "bonus_earned", label: "Earned" },
  { key: "bonus_posted", label: "Posted" },
  { key: "denied", label: "Denied" },
];

const STATUS_COLORS: Record<CardApplicationStatus, string> = {
  planning: "#94a3b8",
  applied: "#1e40af",
  approved: "#0d9488",
  denied: "#b91c1c",
  spending: "#b45309",
  bonus_earned: "#15803d",
  bonus_posted: "#15803d",
  closed: "#475569",
  cancelled: "#475569",
};

function MinSpendBar({ app }: { app: CardApplication }) {
  if (!app.minimum_spend_cents) return null;
  const pct = Math.min(1, app.spend_to_date_cents / app.minimum_spend_cents);
  const tone =
    pct >= 1 ? C.inflow : pct >= 0.5 ? C.warn : C.brandAccent;
  return (
    <View style={styles.barWrap}>
      <View style={styles.barRow}>
        <Text style={styles.barLabel}>
          {fmtCents(app.spend_to_date_cents)} / {fmtCents(app.minimum_spend_cents)}
        </Text>
        <Text style={[styles.barLabel, { color: tone, fontWeight: "700" }]}>
          {Math.round(pct * 100)}%
        </Text>
      </View>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${pct * 100}%`, backgroundColor: tone }]} />
      </View>
      {app.minimum_spend_deadline && (
        <Text style={styles.barHint}>
          Deadline: {fmtRelativeDate(app.minimum_spend_deadline)}
        </Text>
      )}
    </View>
  );
}

function ApplicationCard({
  app,
  onUpdate,
}: {
  app: CardApplication;
  onUpdate: (next: CardApplicationStatus) => void;
}) {
  const tone = STATUS_COLORS[app.status] ?? C.textMuted;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <View style={styles.titleRow}>
            <View style={[styles.statusPill, { backgroundColor: tone + "22", borderColor: tone }]}>
              <Text style={[styles.statusText, { color: tone }]}>
                {app.status.replace("_", " ")}
              </Text>
            </View>
            <Text style={styles.issuerText}>{app.issuer}</Text>
            {app.counts_toward_5_24 && (
              <Text style={styles.tag524}>5/24</Text>
            )}
          </View>
          <Text style={styles.cardName} numberOfLines={2}>{app.card_name}</Text>
          <Text style={styles.bonusText}>
            {app.bonus_value_cents != null
              ? `Bonus: ${fmtCents(app.bonus_value_cents)}`
              : app.bonus_points
              ? `Bonus: ${app.bonus_points.toLocaleString()} pts`
              : "Bonus: —"}
            {app.annual_fee_cents
              ? ` · AF ${fmtCents(app.annual_fee_cents)}${app.first_year_fee_waived ? " (Y1 waived)" : ""}`
              : " · No AF"}
          </Text>
        </View>
      </View>

      <MinSpendBar app={app} />

      <View style={styles.actionRow}>
        {app.status === "planning" && (
          <Pressable
            onPress={() => onUpdate("applied")}
            style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.actionBtnText}>Mark applied</Text>
          </Pressable>
        )}
        {app.status === "applied" && (
          <Pressable
            onPress={() => onUpdate("approved")}
            style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.actionBtnText}>Mark approved</Text>
          </Pressable>
        )}
        {app.status === "approved" && (
          <Pressable
            onPress={() => onUpdate("spending")}
            style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.actionBtnText}>Start spending</Text>
          </Pressable>
        )}
        {app.status === "spending" && (
          <Pressable
            onPress={() => onUpdate("bonus_earned")}
            style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.actionBtnText}>Bonus earned</Text>
          </Pressable>
        )}
        {app.status === "bonus_earned" && (
          <Pressable
            onPress={() => onUpdate("bonus_posted")}
            style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.actionBtnText}>Bonus posted</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export default function CardAppsScreen() {
  const [statusIdx, setStatusIdx] = useState(0); // all
  const qc = useQueryClient();

  const eligQ = useQuery({
    queryKey: ["cardAppsEligibility"],
    queryFn: () => api.cardApplicationsEligibility(),
  });
  const appsQ = useQuery({
    queryKey: ["cardApps"],
    queryFn: () => api.listCardApplications({}),
  });

  const updateMut = useMutation({
    mutationFn: (vars: { id: number; status: CardApplicationStatus }) =>
      api.updateCardApplicationStatus(vars.id, vars.status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cardApps"] }),
  });

  const filtered = useMemo(() => {
    const k = STATUS_TABS[statusIdx].key;
    if (k === "all") return appsQ.data ?? [];
    return (appsQ.data ?? []).filter((a) => a.status === k);
  }, [appsQ.data, statusIdx]);

  if (appsQ.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }

  const c524 = eligQ.data?.chase_5_24;

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Card applications</Text>
        <Text style={headerStyles.headerSub}>
          {appsQ.data?.length ?? 0} tracked · 5/24 + sign-up bonuses
        </Text>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(a) => String(a.id)}
        renderItem={({ item }) => (
          <ApplicationCard
            app={item}
            onUpdate={(next) => updateMut.mutate({ id: item.id, status: next })}
          />
        )}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={appsQ.isFetching || eligQ.isFetching}
            onRefresh={() => {
              appsQ.refetch();
              eligQ.refetch();
            }}
            tintColor={C.brand}
          />
        }
        ListHeaderComponent={
          <View>
            {c524 && (
              <View style={[cardStyle.card, styles.heroCard]}>
                <Text style={styles.heroLabel}>Chase 5/24</Text>
                <Text
                  style={[
                    styles.heroValue,
                    { color: c524.is_under_5_24 ? C.inflow : C.outflow },
                  ]}
                >
                  {c524.cards_opened_in_window} / 5
                </Text>
                <Text style={styles.heroHint}>
                  {c524.is_under_5_24 ? "Under — Chase will likely approve" : "Over — Chase will likely auto-deny"}
                </Text>
                {c524.cards.length > 0 && (
                  <View style={styles.cardsList}>
                    {c524.cards.slice(0, 5).map((c, i) => (
                      <Text key={i} style={styles.cardsListItem}>
                        • {c.card_name} ({c.issuer})
                      </Text>
                    ))}
                  </View>
                )}
              </View>
            )}

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
              No applications match this filter. Add new ones via the web app.
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
  cardsList: { marginTop: 10 },
  cardsListItem: { color: C.textMuted, fontSize: 11, lineHeight: 18 },

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
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start" },
  cardLeft: { flex: 1 },
  titleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginBottom: 4 },
  statusPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    marginRight: 6,
  },
  statusText: { fontSize: 10, fontWeight: "700", textTransform: "capitalize" },
  issuerText: { color: C.textMuted, fontSize: 11, fontWeight: "600", marginRight: 6 },
  tag524: {
    color: "#92400e",
    backgroundColor: "#fef3c7",
    fontSize: 9,
    fontWeight: "700",
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    overflow: "hidden",
  },
  cardName: { color: C.text, fontSize: 14, fontWeight: "700", marginTop: 4 },
  bonusText: { color: C.textMuted, fontSize: 11, marginTop: 4 },

  barWrap: { marginTop: 10 },
  barRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  barLabel: { color: C.textMuted, fontSize: 11 },
  barTrack: { height: 6, backgroundColor: C.borderSoft, borderRadius: 3, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 3 },
  barHint: { color: C.textSoft, fontSize: 10, marginTop: 4 },

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
});
