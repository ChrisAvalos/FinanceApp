/**
 * Money on the Table — mobile screen.
 *
 * The headline morning-check view. Phone-first layout:
 *   • Hero card with claimable + savings totals + summary line
 *   • Horizontal-scroll filter chips (cohort tabs from web)
 *   • Vertical-scroll opportunity list, ranked by $/min
 *
 * The chip + list combo replaces the web's two-axis tabs+filter UI —
 * a phone screen doesn't need both. Quick wins / Triage / All
 * matches the cohort grouping the user explicitly liked.
 */
import React, { useEffect, useMemo, useState } from "react";
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
import { useQuery } from "@tanstack/react-query";

import {
  api,
  fmtCents,
  type MoneyOnTableOpportunity,
  type MoneyOnTableReport,
} from "../api/client";
import {
  C,
  cardStyle,
  fmtRelativeDate,
  headerStyles,
} from "../theme";
import SyncFreshnessChip from "../components/SyncFreshness";
import {
  getSessionSavings,
  subscribeSessionSavings,
} from "../components/sessionSavings";

/* ------------------------------------------------------------------ */
/*  Cohort tabs — same partition logic as web                         */
/* ------------------------------------------------------------------ */

type TabKey = "quick" | "big" | "urgent" | "triage" | "all";

const TAB_DEFS: { key: TabKey; label: string }[] = [
  { key: "quick", label: "Quick wins" },
  { key: "big", label: "Big" },
  { key: "urgent", label: "Urgent" },
  { key: "triage", label: "Triage" },
  { key: "all", label: "All" },
];

function classifyTab(o: MoneyOnTableOpportunity): TabKey[] {
  const tabs: TabKey[] = ["all"];
  if (o.urgency_days != null && o.urgency_days >= 0 && o.urgency_days <= 30) {
    tabs.push("urgent");
  }
  if ((o.estimated_cents ?? 0) >= 50_000) tabs.push("big");
  if (o.effort_minutes <= 15) {
    const isCatalogLookup =
      o.source_kind === "passive_check" || o.source_kind === "regulatory_redress";
    const isConfidentMatch = o.confidence >= 0.6 && (o.estimated_cents ?? 0) > 0;
    if (isCatalogLookup || isConfidentMatch) tabs.push("quick");
  }
  if (o.source_kind === "passive_check" || o.confidence < 0.5) {
    tabs.push("triage");
  }
  return tabs;
}

/* ------------------------------------------------------------------ */
/*  Source-kind metadata                                              */
/* ------------------------------------------------------------------ */

const KIND_LABELS: Record<string, { label: string; bg: string; fg: string }> = {
  unclaimed_property: { label: "Unclaimed", bg: "#d1fae5", fg: "#065f46" },
  class_action: { label: "Class action", bg: "#fef3c7", fg: "#92400e" },
  regulatory_redress: { label: "CFPB/AG", bg: "#ede9fe", fg: "#5b21b6" },
  card_benefit: { label: "Card benefit", bg: "#dbeafe", fg: "#1e40af" },
  yield_arb: { label: "Yield arb", bg: "#e0e7ff", fg: "#3730a3" },
  sub_cancel: { label: "Sub-cancel", bg: "#ffe4e6", fg: "#9f1239" },
  bank_bonus: { label: "Bank bonus", bg: "#ccfbf1", fg: "#115e59" },
  brokerage_bonus: { label: "Brokerage", bg: "#cffafe", fg: "#155e75" },
  passive_check: { label: "Passive check", bg: "#e2e8f0", fg: "#334155" },
  receipt_coupon: { label: "Coupon", bg: "#ffedd5", fg: "#9a3412" },
  cross_store_deal: { label: "Deal", bg: "#fce7f3", fg: "#9d174d" },
};

function kindMeta(kind: string) {
  return (
    KIND_LABELS[kind] ?? {
      label: kind.replace(/_/g, " "),
      bg: "#e2e8f0",
      fg: "#334155",
    }
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtPerMinute(cents: number | null): string {
  if (cents == null || cents === 0) return "—";
  if (cents >= 100_00) return `$${Math.round(cents / 100).toLocaleString()}/min`;
  return `${(cents / 100).toFixed(2).replace(/\.00$/, "")}/min`;
}

function fmtEffort(min: number): string {
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

/* ------------------------------------------------------------------ */
/*  Hero card                                                          */
/* ------------------------------------------------------------------ */

function HeroCard({ report }: { report: MoneyOnTableReport | undefined }) {
  return (
    <View style={[cardStyle.card, styles.hero]}>
      <Text style={styles.heroLabel}>You've got up to</Text>
      <Text style={styles.heroAmount}>
        {fmtCents(report?.total_claimable_cents ?? 0)}
      </Text>
      <Text style={styles.heroSub}>
        + {fmtCents(report?.total_savings_cents ?? 0)} in recurring savings/yr
      </Text>
      {report?.summary_text ? (
        <Text style={styles.heroSummary}>{report.summary_text}</Text>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ */
/*  Opportunity row                                                    */
/* ------------------------------------------------------------------ */

function OpportunityRow({
  op,
  rank,
}: {
  op: MoneyOnTableOpportunity;
  rank: number;
}) {
  const meta = kindMeta(op.source_kind);
  const cents = op.estimated_cents;

  return (
    <Pressable
      onPress={() => {
        if (op.action_url) Linking.openURL(op.action_url).catch(() => {});
      }}
      style={({ pressed }) => [styles.opCard, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.opRow}>
        <View style={styles.opLeft}>
          <View style={styles.opLabelRow}>
            <Text style={styles.rankText}>#{rank}</Text>
            <View style={[styles.pill, { backgroundColor: meta.bg }]}>
              <Text style={[styles.pillText, { color: meta.fg }]}>{meta.label}</Text>
            </View>
          </View>
          <Text style={styles.opTitle} numberOfLines={2}>
            {op.title}
          </Text>
          {op.description ? (
            <Text style={styles.opDesc} numberOfLines={2}>
              {op.description}
            </Text>
          ) : null}
        </View>
        <View style={styles.opRight}>
          <Text style={styles.opAmount}>
            {cents != null ? fmtCents(cents) : "—"}
          </Text>
          <Text style={styles.opMeta}>
            {fmtEffort(op.effort_minutes)} ·{" "}
            <Text style={styles.opPerMin}>{fmtPerMinute(op.value_per_minute_cents)}</Text>
          </Text>
        </View>
      </View>
      <View style={styles.opFooter}>
        {op.deadline ? (
          <Text style={styles.opFooterText}>
            {(op.urgency_days ?? 0) <= 7 ? "⚠ " : ""}
            {fmtRelativeDate(op.deadline)}
          </Text>
        ) : (
          <Text style={styles.opFooterText}>No deadline</Text>
        )}
        <Text style={styles.opFooterText}>
          {Math.round(op.confidence * 100)}% confident
        </Text>
        {op.action_url ? (
          <Text style={styles.opActionText}>{op.action_label} →</Text>
        ) : (
          <Text style={styles.opFooterText}>{op.action_label}</Text>
        )}
      </View>
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/*  Screen                                                             */
/* ------------------------------------------------------------------ */

export default function MoneyOnTableScreen() {
  const [tab, setTab] = useState<TabKey>("quick");
  const q = useQuery({ queryKey: ["moneyOnTable"], queryFn: api.moneyOnTable });

  // Sprint 48 — "Saved this session" chip. Mirrors the web Sprint 41
  // implementation: a module-level counter ticks up every time the user
  // cancels a real subscription, and the chip self-hides until it's
  // non-zero so a fresh-launched app shows no visual noise.
  const [savedSessionCents, setSavedSessionCents] = useState<number>(
    getSessionSavings(),
  );
  useEffect(() => {
    const unsub = subscribeSessionSavings((total) =>
      setSavedSessionCents(total),
    );
    return unsub;
  }, []);

  const visible = useMemo(() => {
    const ops = q.data?.opportunities ?? [];
    return ops.filter((o) => classifyTab(o).includes(tab));
  }, [q.data, tab]);

  if (q.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }
  if (q.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Couldn't load</Text>
        <Text style={styles.errorBody}>{(q.error as Error).message}</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Money on the table</Text>
        <Text style={headerStyles.headerSub}>
          {q.data?.opportunities.length ?? 0} opportunities ranked by $/min
        </Text>
      </View>

      <FlatList
        ListHeaderComponent={
          <View>
            <View style={styles.chipRow}>
              <SyncFreshnessChip syncedAt={q.data?.as_of ?? null} label="Report" />
            </View>
            {/* Sprint 48 — Saved-this-session chip. Self-hides until
                the user cancels at least one real subscription. */}
            {savedSessionCents > 0 && (
              <View style={styles.savedChip}>
                <Text style={styles.savedChipIcon} aria-label="success">
                  ✓
                </Text>
                <Text style={styles.savedChipText}>
                  Saved this session:{" "}
                  <Text style={styles.savedChipNum}>
                    {fmtCents(savedSessionCents)}/mo
                  </Text>
                  <Text style={styles.savedChipSub}>
                    {" "}
                    · {fmtCents(savedSessionCents * 12)}/yr
                  </Text>
                </Text>
              </View>
            )}
            <View style={styles.heroWrap}>
              <HeroCard report={q.data} />
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tabRow}
            >
              {TAB_DEFS.map((t) => {
                const isActive = t.key === tab;
                return (
                  <Pressable
                    key={t.key}
                    onPress={() => setTab(t.key)}
                    style={[styles.tabChip, isActive && styles.tabChipActive]}
                  >
                    <Text
                      style={[
                        styles.tabChipText,
                        isActive && styles.tabChipTextActive,
                      ]}
                    >
                      {t.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        }
        data={visible}
        keyExtractor={(op, i) => `${op.source_kind}:${op.source_id}:${i}`}
        renderItem={({ item, index }) => (
          <OpportunityRow op={item} rank={index + 1} />
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
          <View style={styles.center}>
            <Text style={styles.hint}>
              No opportunities in this tab. Try a wider tab or connect Plaid + Gmail.
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
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center", marginTop: 12 },
  errorTitle: { color: C.outflow, fontSize: 16, fontWeight: "600" },
  errorBody: { color: C.text, marginTop: 8, fontSize: 12, textAlign: "center" },

  heroWrap: { paddingHorizontal: 16, paddingTop: 8 },
  chipRow: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 16, paddingTop: 8 },
  // Sprint 48 — "Saved this session" chip styling. Inflow-green border
  // + faint inflow-tinted background, pill shape, single-line copy.
  savedChip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.inflow,
    backgroundColor: "rgba(16,185,129,0.10)",
  },
  savedChipIcon: { color: C.inflow, fontSize: 12, fontWeight: "700", marginRight: 6 },
  savedChipText: { color: C.inflow, fontSize: 12, fontWeight: "600" },
  savedChipNum: { color: C.inflow, fontWeight: "700" },
  savedChipSub: { color: C.textMuted, fontWeight: "400" },
  hero: { backgroundColor: C.brand, marginBottom: 8 },
  heroLabel: { color: C.brandLight, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 },
  heroAmount: { color: "#fff", fontSize: 32, fontWeight: "700", marginTop: 4 },
  heroSub: { color: C.brandLight, fontSize: 13, marginTop: 4 },
  heroSummary: { color: "#fff", fontSize: 13, marginTop: 12, lineHeight: 19 },

  tabRow: { paddingHorizontal: 16, paddingVertical: 8 },
  tabChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
    marginRight: 8,
  },
  tabChipActive: { backgroundColor: C.brand, borderColor: C.brand },
  tabChipText: { fontSize: 12, color: C.text, fontWeight: "600" },
  tabChipTextActive: { color: "#fff" },

  listContent: { paddingBottom: 24 },
  opCard: {
    backgroundColor: C.card,
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 8,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  opRow: { flexDirection: "row", alignItems: "flex-start" },
  opLeft: { flex: 1, paddingRight: 8 },
  opLabelRow: { flexDirection: "row", alignItems: "center", marginBottom: 4 },
  rankText: { color: C.textSoft, fontSize: 11, fontFamily: "monospace", marginRight: 6 },
  pill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  pillText: { fontSize: 10, fontWeight: "700", textTransform: "uppercase" },
  opTitle: { color: C.text, fontSize: 14, fontWeight: "600" },
  opDesc: { color: C.textMuted, fontSize: 12, marginTop: 2, lineHeight: 17 },
  opRight: { alignItems: "flex-end" },
  opAmount: { color: C.text, fontSize: 16, fontWeight: "700" },
  opMeta: { color: C.textMuted, fontSize: 11, marginTop: 2 },
  opPerMin: { color: C.brandAccent, fontWeight: "600" },
  opFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.borderSoft,
  },
  opFooterText: { color: C.textSoft, fontSize: 11 },
  opActionText: { color: C.brandAccent, fontSize: 11, fontWeight: "600" },
});
