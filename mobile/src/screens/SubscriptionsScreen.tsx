/**
 * Subscriptions — mobile screen.
 *
 * Phone-first cohort layout:
 *   • Stat strip: monthly cost / annual cost / count
 *   • Filter chips by status: All / Suspected / Confirmed / Cancelled
 *   • List of subs with confirm/dismiss inline
 *
 * Phone use-case is "spotted a charge — is this a real sub?" so the
 * confirm/dismiss path is the most-used button. We surface
 * price-change rows specially with a yellow flag.
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
  TextInput,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  api,
  fmtCents,
  type Subscription,
  type SubscriptionStatus,
} from "../api/client";
import { C, cardStyle, fmtRelativeDate, headerStyles } from "../theme";
import { emitSessionSavings } from "../components/sessionSavings";

type TabKey = "all" | "suspected" | "active" | "cancelled";

const TAB_DEFS: { key: TabKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "suspected", label: "Needs review" },
  { key: "active", label: "Confirmed" },
  { key: "cancelled", label: "Cancelled" },
];

function statusLabel(s: SubscriptionStatus): string {
  return s === "suspected" ? "Suspected" : s.charAt(0).toUpperCase() + s.slice(1);
}

function statusColor(s: SubscriptionStatus): string {
  switch (s) {
    case "active": return C.inflow;
    case "suspected": return C.warn;
    case "paused": return C.textMuted;
    case "cancelled":
    case "dismissed": return C.textSoft;
  }
}

/**
 * BundleOverlapBanner — mobile port (Sprint 27).
 *
 * Matches the web banner from Wave E: dollar-headline savings when
 * the detector finds a paid-twice perk (you have Peacock standalone
 * AND Xfinity Mobile that bundles it, etc.). Self-hides when empty.
 */
function BundleOverlapBanner() {
  const q = useQuery({
    queryKey: ["bundle-overlaps"],
    queryFn: () => api.bundleOverlaps(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  if (!q.data || q.data.overlaps.length === 0) return null;
  const total = q.data.total_annual_savings_cents;
  if (total <= 0) return null;
  const annualUsd = (total / 100).toFixed(0);
  const monthlyUsd = (total / 12 / 100).toFixed(0);
  const itemLabel = q.data.overlaps.length === 1 ? "duplicate" : "duplicates";
  const exemplars = q.data.overlaps
    .slice(0, 2)
    .map((o) => `${o.perk_label} (also in ${o.parent_label})`)
    .join(", ");
  return (
    <View style={styles.bannerWarn}>
      <Text style={styles.bannerCap}>
        You're paying twice — review {q.data.overlaps.length} {itemLabel}
      </Text>
      <Text style={styles.bannerHead}>
        Cancel duplicates to save ${annualUsd}/yr (~${monthlyUsd}/mo)
      </Text>
      <Text style={styles.bannerSub}>
        {exemplars}
        {q.data.overlaps.length > 2 && ` + ${q.data.overlaps.length - 2} more`}
      </Text>
    </View>
  );
}

/**
 * TrendAlertBanner — mobile port (Sprint 27).
 *
 * Alert mode (orange) when real Sprint 11 alerts fire; preview mode
 * (blue) showing top movers when there's nothing past threshold yet.
 * Mirrors the dual-state pattern from the web banner.
 */
function TrendAlertBanner() {
  const q = useQuery({
    queryKey: ["subscription-trends"],
    queryFn: () => api.subscriptionTrends(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  if (!q.data) return null;
  const isAlertMode = q.data.alerts.length > 0;
  const rows = isAlertMode ? q.data.alerts : q.data.top_movers;
  if (rows.length === 0) return null;
  const itemLabel = rows.length === 1 ? "subscription" : "subscriptions";
  const exemplars = rows
    .slice(0, 3)
    .map((a) => `${a.subscription_name} (+${a.growth_pct.toFixed(0)}%)`)
    .join(", ");
  if (isAlertMode) {
    const monthlyUsd = (q.data.total_monthly_delta_cents / 100).toFixed(0);
    return (
      <View style={styles.bannerWarn}>
        <Text style={styles.bannerCap}>
          Usage trending up on {rows.length} {itemLabel}
        </Text>
        <Text style={styles.bannerHead}>
          Recent monthly spend +${monthlyUsd}/mo vs trailing average
        </Text>
        <Text style={styles.bannerSub}>
          {exemplars}
          {rows.length > 3 && ` + ${rows.length - 3} more`}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.bannerInfo}>
      <Text style={styles.bannerInfoCap}>
        Trending up · {rows.length} {itemLabel}
      </Text>
      <Text style={styles.bannerInfoBody}>
        {exemplars}
        {rows.length > 3 && ` + ${rows.length - 3} more`}
      </Text>
    </View>
  );
}

function SubscriptionRow({
  sub,
  onConfirm,
  onDismiss,
  onCancel,
  onSetPrice,
  setPricePending,
}: {
  sub: Subscription;
  onConfirm: () => void;
  onDismiss: () => void;
  // Sprint 48 — cancel action for active subs. Distinct from dismiss
  // (which means "this isn't a real subscription") — cancel means
  // "real sub, I stopped paying for it", which is the path that
  // tallies into the session-savings counter.
  onCancel: () => void;
  // Sprint 48 — needs-price inline form. The parent submits the
  // monthly_cents value and refetches; the row only owns the draft
  // string for the input.
  onSetPrice: (monthlyCents: number) => void;
  setPricePending: boolean;
}) {
  const monthly =
    Math.abs(sub.last_amount_cents ?? sub.amount_cents) *
    (30 / Math.max(sub.cadence_days, 1));
  const isPriceChange =
    sub.prior_amount_cents != null && sub.last_amount_cents != null && sub.prior_amount_cents !== sub.last_amount_cents;
  // Sprint 48 — a sub is "needs price" if both signed-amount fields
  // are 0 / null. These rows come in from LLM-Gmail discovery (Sprint
  // 16) when the snippet didn't expose a dollar amount.
  const rawCents = Math.abs(sub.last_amount_cents ?? sub.amount_cents ?? 0);
  const needsPrice = rawCents === 0;
  const [priceDraft, setPriceDraft] = useState<string>("");

  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowName} numberOfLines={1}>{sub.name}</Text>
          <View style={[styles.statusPill, { borderColor: statusColor(sub.status) }]}>
            <Text style={[styles.statusText, { color: statusColor(sub.status) }]}>
              {statusLabel(sub.status)}
            </Text>
          </View>
        </View>
        <Text style={styles.rowMeta}>
          {fmtCents(Math.abs(sub.last_amount_cents ?? sub.amount_cents))}
          {sub.cadence_label ? ` · ${sub.cadence_label}` : ` · every ${sub.cadence_days}d`}
          {sub.next_expected_date ? ` · next ${fmtRelativeDate(sub.next_expected_date)}` : ""}
        </Text>
        {isPriceChange && (
          <Text style={styles.priceChangeText}>
            ⚠ Price change: {fmtCents(Math.abs(sub.prior_amount_cents!))} → {fmtCents(Math.abs(sub.last_amount_cents!))}
          </Text>
        )}
        {/* Sprint 48 — inline needs-price form. Only appears when the
            sub came in at $0 (LLM-Gmail discovery couldn't extract a
            dollar amount). The user types a dollar value; we submit
            in cents. Cleared on successful refetch via state reset on
            the next render after rawCents flips off zero. */}
        {needsPrice && (
          <View style={styles.needsPriceWrap}>
            <Text style={styles.needsPriceLabel}>
              Needs price — what do you actually pay?
            </Text>
            <View style={styles.needsPriceInputRow}>
              <Text style={styles.needsPricePrefix}>$</Text>
              <TextInput
                value={priceDraft}
                onChangeText={setPriceDraft}
                placeholder="0.00"
                placeholderTextColor={C.textSoft}
                keyboardType="decimal-pad"
                style={styles.needsPriceInput}
                editable={!setPricePending}
              />
              <Text style={styles.needsPriceSuffix}>/mo</Text>
              <Pressable
                onPress={() => {
                  const parsed = parseFloat(priceDraft.trim());
                  if (!Number.isFinite(parsed) || parsed <= 0) return;
                  const cents = Math.round(parsed * 100);
                  onSetPrice(cents);
                  setPriceDraft("");
                }}
                disabled={
                  setPricePending ||
                  priceDraft.trim() === "" ||
                  !Number.isFinite(parseFloat(priceDraft.trim())) ||
                  parseFloat(priceDraft.trim()) <= 0
                }
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnSetPrice,
                  pressed && { opacity: 0.7 },
                  (setPricePending ||
                    priceDraft.trim() === "" ||
                    !Number.isFinite(parseFloat(priceDraft.trim()))) && {
                    opacity: 0.4,
                  },
                ]}
              >
                <Text style={styles.btnSetPriceText}>Save</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.monthlyText}>{fmtCents(monthly)}/mo</Text>
        {sub.status === "suspected" && (
          <View style={styles.actionRow}>
            <Pressable
              onPress={onConfirm}
              style={({ pressed }) => [styles.btn, styles.btnConfirm, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.btnConfirmText}>Yes</Text>
            </Pressable>
            <Pressable
              onPress={onDismiss}
              style={({ pressed }) => [styles.btn, styles.btnDismiss, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.btnDismissText}>No</Text>
            </Pressable>
          </View>
        )}
        {/* Sprint 48 — Cancel button on active subs. Tapping it
            transitions the sub to "cancelled" and tallies the
            monthly-equivalent into the session-savings counter that
            powers the chip on Money on the Table. */}
        {sub.status === "active" && (
          <View style={styles.actionRow}>
            <Pressable
              onPress={onCancel}
              style={({ pressed }) => [styles.btn, styles.btnCancel, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.btnCancelText}>Cancel</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

export default function SubscriptionsScreen() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("suspected");

  const list = useQuery({ queryKey: ["subscriptions"], queryFn: () => api.listSubscriptions() });
  const stats = useQuery({ queryKey: ["subscriptionStats"], queryFn: api.subscriptionStats });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["subscriptions"] });
    qc.invalidateQueries({ queryKey: ["subscriptionStats"] });
  };
  const confirm = useMutation({ mutationFn: api.confirmSubscription, onSuccess: invalidate });
  const dismiss = useMutation({ mutationFn: api.dismissSubscription, onSuccess: invalidate });
  // Sprint 48 — cancel transition. Fires emitSessionSavings on the way
  // out so the Money-on-the-Table "Saved this session" chip ticks up
  // with the monthly-equivalent of whatever the user just killed.
  // Dismiss is intentionally NOT tallied: dismissing means "this isn't
  // a real sub", so there's no real savings — same gate the web uses.
  const cancelMut = useMutation({
    mutationFn: (id: number) => api.setSubscriptionStatus(id, "cancelled"),
    onSuccess: invalidate,
  });
  // Sprint 48 — needs-price submission. Backend takes unsigned monthly
  // cents and persists as a negative outflow on its end. On success
  // the list refetches and the row's needsPrice gate flips off, which
  // hides the inline form on the next render.
  const setPrice = useMutation({
    mutationFn: ({ id, monthly_cents }: { id: number; monthly_cents: number }) =>
      api.setSubscriptionPrice(id, monthly_cents),
    onSuccess: invalidate,
  });
  function _handleCancel(sub: Subscription) {
    const rawCents = Math.abs(sub.last_amount_cents ?? sub.amount_cents ?? 0);
    if (rawCents > 0) {
      // Normalize to per-month — annuals divide by 12, weeklies by 0.25.
      const monthlyCents = Math.round(
        rawCents * (30 / Math.max(sub.cadence_days ?? 30, 1)),
      );
      emitSessionSavings(monthlyCents);
    }
    cancelMut.mutate(sub.id);
  }

  const visible = useMemo(() => {
    const all = list.data ?? [];
    if (tab === "all") return all;
    return all.filter((s) => s.status === tab);
  }, [list.data, tab]);

  // Sprint 48 — count of $0-price subs across ALL statuses. Drives a
  // banner CTA above the stat strip so the user notices the problem
  // even when they're on a tab that doesn't contain those rows.
  const needsPriceCount = useMemo(() => {
    return (list.data ?? []).filter(
      (s) => Math.abs(s.last_amount_cents ?? s.amount_cents ?? 0) === 0,
    ).length;
  }, [list.data]);

  if (list.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={C.brand} />
      </View>
    );
  }
  if (list.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Couldn't load</Text>
        <Text style={styles.errorBody}>{(list.error as Error).message}</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Subscriptions</Text>
        <Text style={headerStyles.headerSub}>
          {fmtCents(Math.abs(stats.data?.monthly_cost_cents ?? 0))}/mo · {stats.data?.confirmed_count ?? 0} confirmed
        </Text>
      </View>

      <FlatList
        ListHeaderComponent={
          <View>
            {/* Sprint 27 — bundle + trend banners ported from web. Each
                self-hides when empty, so on a fresh account these add
                no visual noise. */}
            <View style={{ marginHorizontal: 16, marginTop: 16 }}>
              <BundleOverlapBanner />
              <TrendAlertBanner />
              {/* Sprint 48 — needs-price banner. Self-hides when none. */}
              {needsPriceCount > 0 && (
                <View style={styles.needsPriceBanner}>
                  <Text style={styles.needsPriceBannerCap}>
                    Needs price
                  </Text>
                  <Text style={styles.needsPriceBannerHead}>
                    {needsPriceCount} subscription
                    {needsPriceCount === 1 ? "" : "s"} {needsPriceCount === 1 ? "is" : "are"}{" "}
                    missing a monthly price
                  </Text>
                  <Text style={styles.needsPriceBannerSub}>
                    Tap any row below to fill in what you actually pay so the
                    forecast + savings math line up.
                  </Text>
                </View>
              )}
            </View>
            <View style={[cardStyle.card, styles.statRow, { marginHorizontal: 16, marginTop: 16 }]}>
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Monthly</Text>
                <Text style={styles.statValue}>
                  {fmtCents(Math.abs(stats.data?.monthly_cost_cents ?? 0))}
                </Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Annual</Text>
                <Text style={styles.statValue}>
                  {fmtCents(Math.abs(stats.data?.annual_cost_cents ?? 0))}
                </Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.stat}>
                <Text style={styles.statLabel}>Review</Text>
                <Text style={[styles.statValue, { color: C.warn }]}>
                  {stats.data?.needs_review_count ?? 0}
                </Text>
              </View>
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
                    <Text style={[styles.tabChipText, isActive && styles.tabChipTextActive]}>
                      {t.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        }
        data={visible}
        keyExtractor={(s) => String(s.id)}
        renderItem={({ item }) => (
          <SubscriptionRow
            sub={item}
            onConfirm={() => confirm.mutate(item.id)}
            onDismiss={() => dismiss.mutate(item.id)}
            onCancel={() => _handleCancel(item)}
            onSetPrice={(monthly_cents) =>
              setPrice.mutate({ id: item.id, monthly_cents })
            }
            setPricePending={setPrice.isPending}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        refreshControl={
          <RefreshControl
            refreshing={list.isFetching}
            onRefresh={() => { list.refetch(); stats.refetch(); }}
            tintColor={C.brand}
          />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.hint}>
              {tab === "suspected"
                ? "Nothing to review. Run 'Detect subscriptions' on the web app to find new ones."
                : `No ${tab} subscriptions.`}
            </Text>
          </View>
        }
        contentContainerStyle={visible.length === 0 ? styles.flexCenter : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center" },
  flexCenter: { flexGrow: 1 },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center" },
  errorTitle: { color: C.outflow, fontSize: 16, fontWeight: "600" },
  errorBody: { color: C.text, marginTop: 8, fontSize: 12, textAlign: "center" },

  // Sprint 27 — banner styles. Warn variant for actionable dollar-
  // headline banners (bundle overlap, real trend alerts); info variant
  // for calmer informational top-movers preview.
  bannerWarn: {
    backgroundColor: "#fef3c7",       // amber-100
    borderColor: "#f59e0b",           // amber-500 / C.warn
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  bannerCap: {
    color: "#b45309",                 // amber-700
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  bannerHead: {
    color: C.text,
    fontSize: 14,
    fontWeight: "600",
  },
  bannerSub: {
    color: C.textMuted,
    fontSize: 11,
    marginTop: 4,
  },
  bannerInfo: {
    backgroundColor: "#eff6ff",       // blue-50
    borderColor: "#93c5fd",           // blue-300
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 12,
  },
  bannerInfoCap: {
    color: "#1d4ed8",                 // blue-700
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  bannerInfoBody: {
    color: C.textMuted,
    fontSize: 12,
  },

  statRow: { flexDirection: "row", padding: 8 },
  stat: { flex: 1, padding: 4 },
  statDivider: { width: StyleSheet.hairlineWidth, backgroundColor: C.border, marginHorizontal: 4 },
  statLabel: { color: C.textMuted, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  statValue: { color: C.text, fontSize: 18, fontWeight: "700", marginTop: 4 },

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

  row: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: C.card,
  },
  rowMain: { flex: 1, paddingRight: 12 },
  rowHeader: { flexDirection: "row", alignItems: "center" },
  rowName: { color: C.text, fontSize: 14, fontWeight: "600", flex: 1, paddingRight: 8 },
  rowMeta: { color: C.textMuted, fontSize: 11, marginTop: 4 },
  priceChangeText: { color: C.warn, fontSize: 11, marginTop: 4, fontWeight: "500" },
  rowRight: { alignItems: "flex-end", justifyContent: "space-between" },
  monthlyText: { color: C.text, fontSize: 14, fontWeight: "600" },
  actionRow: { flexDirection: "row", marginTop: 8 },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
    marginLeft: 4,
  },
  btnConfirm: { backgroundColor: C.brand },
  btnConfirmText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  btnDismiss: { borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  btnDismissText: { color: C.textMuted, fontSize: 11, fontWeight: "700" },
  btnCancel: { borderWidth: 1, borderColor: C.outflow, backgroundColor: C.card },
  btnCancelText: { color: C.outflow, fontSize: 11, fontWeight: "700" },
  statusPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  statusText: { fontSize: 9, fontWeight: "700", textTransform: "uppercase" },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.borderSoft },

  // Sprint 48 — needs-price banner + inline form. Same tonal language
  // as the warn-banner (yellow) since these aren't errors, just
  // unfinished data that the user needs to fill in for the forecast
  // math to be correct.
  needsPriceBanner: {
    marginTop: 12,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "rgba(245,158,11,0.08)",
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.35)",
  },
  needsPriceBannerCap: {
    color: C.warn,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  needsPriceBannerHead: {
    color: C.text,
    fontSize: 14,
    fontWeight: "700",
    marginTop: 4,
  },
  needsPriceBannerSub: {
    color: C.textMuted,
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16,
  },
  needsPriceWrap: {
    marginTop: 8,
    padding: 8,
    borderRadius: 6,
    backgroundColor: "rgba(245,158,11,0.06)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(245,158,11,0.3)",
  },
  needsPriceLabel: {
    color: C.warn,
    fontSize: 11,
    fontWeight: "600",
  },
  needsPriceInputRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 6,
  },
  needsPricePrefix: { color: C.textMuted, fontSize: 14, marginRight: 4 },
  needsPriceInput: {
    flex: 1,
    backgroundColor: C.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    color: C.text,
    fontSize: 13,
  },
  needsPriceSuffix: {
    color: C.textMuted,
    fontSize: 12,
    marginHorizontal: 6,
  },
  btnSetPrice: { backgroundColor: C.warn, paddingHorizontal: 10 },
  btnSetPriceText: { color: "#fff", fontSize: 11, fontWeight: "700" },
});
