/**
 * SyncFreshnessChip — mobile mirror of the web component.
 *
 * Same trust-dimension hygiene as web: every screen that surfaces
 * external-source data (Plaid balances, scraped offers, computed
 * aggregates) makes an implicit freshness claim. This chip makes it
 * explicit so the user knows when to trigger a re-sync.
 *
 * Tiers (driven by minutes-since-sync):
 *   ≤ 60 min   → green  "Synced N min ago"
 *   ≤ 24h      → muted  "Synced Nh ago"
 *   ≤ 7 days   → amber  "Synced Nd ago"
 *   > 7 days   → red    "Stale — last synced Nd ago"
 *
 * Pass either an ISO timestamp string or null/undefined; null renders a
 * neutral "Never synced" pill. The chip ticks itself once a minute via
 * setInterval so "Synced 5 min ago" → "Synced 6 min ago" without the
 * parent having to refetch — wall-clock matters here, not React state.
 */
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { C, FONT } from "../theme";

export type SyncFreshnessChipProps = {
  /** ISO timestamp of the last successful sync, or null/undefined. */
  syncedAt: string | null | undefined;
  /** Override the source name. Defaults to "Synced". */
  label?: string;
};

type Tone = "green" | "muted" | "amber" | "red";

function formatRelative(iso: string): { text: string; tone: Tone } {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return { text: "Synced —", tone: "muted" };
  const minSince = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minSince < 1) return { text: "Synced just now", tone: "green" };
  if (minSince < 60) return { text: `Synced ${minSince} min ago`, tone: "green" };
  const hSince = Math.round(minSince / 60);
  if (hSince < 24) return { text: `Synced ${hSince}h ago`, tone: "muted" };
  const daysSince = Math.round(hSince / 24);
  if (daysSince === 1) return { text: "Synced yesterday", tone: "muted" };
  if (daysSince <= 7) return { text: `Synced ${daysSince}d ago`, tone: "amber" };
  return { text: `Stale — ${daysSince}d ago`, tone: "red" };
}

const TONE_DOT: Record<Tone, string> = {
  green: "#10b981",
  muted: "#94a3b8",
  amber: "#f59e0b",
  red: "#dc2626",
};

const TONE_TEXT: Record<Tone, string> = {
  green: "#047857",
  muted: C.textMuted,
  amber: "#b45309",
  red: "#b91c1c",
};

export default function SyncFreshnessChip({
  syncedAt,
  label,
}: SyncFreshnessChipProps) {
  // Tick once a minute so the relative text updates in place. Web does
  // the same — wall-clock matters and we don't want the chip to lie
  // ("Synced 5 min ago" stuck on screen 30 minutes later).
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!syncedAt) {
    return (
      <View style={styles.wrap}>
        <View style={[styles.dot, { backgroundColor: TONE_DOT.muted }]} />
        <Text style={[styles.text, { color: TONE_TEXT.muted }]}>
          Never synced
        </Text>
      </View>
    );
  }

  const { text, tone } = formatRelative(syncedAt);
  const labelText = label ? text.replace("Synced", `${label} synced`) : text;
  return (
    <View style={styles.wrap}>
      <View style={[styles.dot, { backgroundColor: TONE_DOT[tone] }]} />
      <Text
        style={[
          styles.text,
          { color: TONE_TEXT[tone] },
          tone === "red" && styles.bold,
        ]}
      >
        {labelText}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  text: {
    fontSize: 11,
    lineHeight: 14,
    fontFamily: FONT.body,
    fontVariant: ["tabular-nums"],
  },
  bold: { fontWeight: "600" },
});
