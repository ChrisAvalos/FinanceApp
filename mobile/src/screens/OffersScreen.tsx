/**
 * Chase / Amex offers — mobile screen.
 *
 * Mirrors the web OffersPanel: shows the result of the most recent
 * Playwright scrape from Chase Offers + Amex Offers, ranked by
 * estimated value based on actual spend matches in the last 90 days.
 *
 * Phone-first treatment:
 *   • Hero: total estimated monthly value across matched offers
 *   • Per-offer cards with confidence + matched-spend rationale
 *   • "Scrape now" button (kicks off backend scrape — works only when
 *     laptop has session cookies set up)
 *   • Auth-missing notice if scrapers aren't authenticated
 */
import React, { useState } from "react";
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, fmtCents, type OfferMatch, type OfferScrapeSummary } from "../api/client";
import { C, cardStyle, fmtRelativeDate, headerStyles } from "../theme";

function formatReward(reward_type: string, bps: number | null): string {
  if (reward_type === "percent_back" && bps != null) return `${(bps / 100).toFixed(1)}% back`;
  if (reward_type === "fixed_cents" && bps != null) return fmtCents(bps);
  if (reward_type === "points" && bps != null) return `${bps.toLocaleString()} pts`;
  return reward_type.replace("_", " ");
}

function OfferCard({ m }: { m: OfferMatch }) {
  const o = m.offer;
  const tone = o.site_key.startsWith("chase") ? "#0b2a4a" : "#1a3a4a";
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardLeft}>
          <View style={styles.metaRow}>
            <View style={[styles.sitePill, { backgroundColor: tone + "22", borderColor: tone }]}>
              <Text style={[styles.siteText, { color: tone }]}>
                {o.site_key.toUpperCase()}
              </Text>
            </View>
            <Text style={styles.merchantText}>{o.merchant_name}</Text>
          </View>
          <Text style={styles.offerTitle} numberOfLines={2}>{o.title}</Text>
          <Text style={styles.rewardText}>
            {formatReward(o.reward_type, o.reward_value_bps)}
            {o.reward_cap_cents ? ` · cap ${fmtCents(o.reward_cap_cents)}` : ""}
            {o.minimum_spend_cents ? ` · min ${fmtCents(o.minimum_spend_cents)}` : ""}
          </Text>
          {o.expires_at && (
            <Text style={styles.expiresText}>Expires {fmtRelativeDate(o.expires_at)}</Text>
          )}
          <Text style={styles.rationaleText}>{m.rationale}</Text>
          <Text style={styles.matchMeta}>
            {m.matched_txn_count_90d} txns · {fmtCents(m.matched_spend_90d_cents)} matched spend (90d)
          </Text>
        </View>
        <View style={styles.valueCol}>
          <Text style={styles.valueText}>{fmtCents(m.estimated_monthly_value_cents)}</Text>
          <Text style={styles.valueLabel}>/mo est.</Text>
          <Text style={styles.confText}>
            {(m.confidence * 100).toFixed(0)}% conf
          </Text>
        </View>
      </View>
      {o.activation_url && (
        <Pressable
          onPress={() => Linking.openURL(o.activation_url!)}
          style={({ pressed }) => [styles.activateBtn, pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.activateBtnText}>Activate ↗</Text>
        </Pressable>
      )}
    </View>
  );
}

function ScrapeBanner({ summaries }: { summaries: OfferScrapeSummary[] | undefined }) {
  if (!summaries || summaries.length === 0) return null;
  const authMissing = summaries.filter((s) => s.auth_missing);
  if (authMissing.length === 0) return null;
  return (
    <View style={styles.warnBanner}>
      <Text style={styles.warnText}>
        {authMissing.map((s) => s.name).join(" · ")} need session cookies.
        Run from laptop: tools/scrape_offers.ps1 first.
      </Text>
    </View>
  );
}

export default function OffersScreen() {
  const [lastScrape, setLastScrape] = useState<OfferScrapeSummary[] | undefined>(undefined);
  const [matches, setMatches] = useState<OfferMatch[] | null>(null);
  const [totalEst, setTotalEst] = useState<number | null>(null);
  const qc = useQueryClient();

  const scrapeMut = useMutation({
    mutationFn: () => api.scrapeOffers(),
    onSuccess: (resp) => {
      setLastScrape(resp.summaries);
      setMatches(resp.matches);
      setTotalEst(resp.total_estimated_value_cents);
      qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
    },
  });

  const isLoading = scrapeMut.isPending;
  const hasRun = matches !== null;

  return (
    <View style={styles.screen}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.headerTitle}>Card offers</Text>
        <Text style={headerStyles.headerSub}>
          Chase + Amex offers matched against your spend
        </Text>
      </View>

      <FlatList
        data={matches ?? []}
        keyExtractor={(m, i) => `${m.offer.site_key}-${m.offer.merchant_name}-${i}`}
        renderItem={({ item }) => <OfferCard m={item} />}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={() => scrapeMut.mutate()}
            tintColor={C.brand}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={[cardStyle.card, styles.heroCard]}>
              <Text style={styles.heroLabel}>Estimated monthly value</Text>
              <Text style={styles.heroValue}>
                {totalEst != null ? fmtCents(totalEst) : "—"}
              </Text>
              <Text style={styles.heroHint}>
                {hasRun
                  ? `${matches?.length ?? 0} offers matched against your spend`
                  : "Tap Scrape to fetch fresh offers from Chase + Amex"}
              </Text>
              <Pressable
                onPress={() => scrapeMut.mutate()}
                disabled={isLoading}
                style={({ pressed }) => [
                  styles.scrapeBtn,
                  pressed && { opacity: 0.6 },
                  isLoading && { opacity: 0.4 },
                ]}
              >
                <Text style={styles.scrapeBtnText}>
                  {isLoading ? "Scraping…" : hasRun ? "Re-scrape" : "Scrape now"}
                </Text>
              </Pressable>
            </View>

            <ScrapeBanner summaries={lastScrape} />
          </View>
        }
        ListEmptyComponent={
          isLoading ? (
            <View style={styles.empty}>
              <ActivityIndicator size="small" color={C.brand} />
              <Text style={styles.hint}>Scraping Chase + Amex…</Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.hint}>
                {hasRun
                  ? "No matched offers right now. Try again in a few days — they rotate."
                  : "Run a scrape to get offers."}
              </Text>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  empty: { padding: 24, alignItems: "center" },
  hint: { color: C.textMuted, fontSize: 13, textAlign: "center", marginTop: 8 },

  listContent: { padding: 16, paddingBottom: 32 },

  heroCard: { marginBottom: 8 },
  heroLabel: { color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  heroValue: { color: C.brand, fontSize: 28, fontWeight: "700", marginTop: 4 },
  heroHint: { color: C.textSoft, fontSize: 12, marginTop: 4 },
  scrapeBtn: {
    marginTop: 12,
    backgroundColor: C.brand,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 4,
    alignSelf: "flex-start",
  },
  scrapeBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },

  warnBanner: {
    backgroundColor: "#fef3c7",
    borderColor: C.warn,
    borderWidth: 1,
    padding: 10,
    borderRadius: 6,
    marginBottom: 12,
  },
  warnText: { color: "#92400e", fontSize: 11 },

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
  sitePill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    marginRight: 6,
  },
  siteText: { fontSize: 9, fontWeight: "700" },
  merchantText: { color: C.text, fontSize: 12, fontWeight: "700" },
  offerTitle: { color: C.text, fontSize: 13, fontWeight: "600", marginTop: 4 },
  rewardText: { color: C.inflow, fontSize: 12, fontWeight: "700", marginTop: 4 },
  expiresText: { color: C.textSoft, fontSize: 11, marginTop: 2 },
  rationaleText: { color: C.textMuted, fontSize: 11, marginTop: 6, lineHeight: 16, fontStyle: "italic" },
  matchMeta: { color: C.textSoft, fontSize: 10, marginTop: 4 },

  valueCol: { alignItems: "flex-end" },
  valueText: { color: C.brand, fontSize: 14, fontWeight: "700" },
  valueLabel: { color: C.textSoft, fontSize: 9 },
  confText: { color: C.textMuted, fontSize: 10, marginTop: 4 },

  activateBtn: {
    marginTop: 8,
    backgroundColor: C.brandLight,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 4,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: C.brand,
  },
  activateBtnText: { color: C.brand, fontSize: 11, fontWeight: "700" },
});
