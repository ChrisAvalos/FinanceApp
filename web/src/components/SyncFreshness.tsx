/**
 * SyncFreshnessChip — show how recently a data source was synced.
 *
 * Why this exists: every panel that surfaces external-source data
 * (Plaid balances, scraped credit scores, FRED rates, scraped offers)
 * is implicitly making a freshness claim. "Synced N min ago" makes
 * that claim explicit and helps users decide whether to trust the
 * number or trigger a re-sync. Trust-dimension hygiene.
 *
 * Tiers (driven by minutes-since-sync):
 *   ≤ 60 min   → green  "Synced N min ago"
 *   ≤ 24h      → muted  "Synced N hours ago" / "Synced today"
 *   ≤ 7 days   → amber  "Synced N days ago"
 *   > 7 days   → red    "Stale — last synced N days ago"
 *
 * Pass either an ISO timestamp string (`syncedAt`) or null/undefined
 * (renders a neutral "Never synced" chip). The chip keeps its own
 * useEffect-tick so it auto-refreshes every minute without the
 * parent re-rendering — the wall-clock matters here, not React state.
 */
import { useEffect, useState } from "react";

interface SyncFreshnessChipProps {
  /** ISO timestamp of the last successful sync, or null/undefined. */
  syncedAt: string | null | undefined;
  /** Override the source name in the label, e.g. "Plaid", "FRED",
   *  "SmartCredit". Defaults to "Synced". */
  label?: string;
  /** Tighter visual when shown next to a hero number. Default false
   *  renders a full pill; true renders a smaller inline tag. */
  compact?: boolean;
}

function formatRelative(iso: string): { text: string; tone: "green" | "muted" | "amber" | "red" } {
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
  return { text: `Stale — last synced ${daysSince}d ago`, tone: "red" };
}

export default function SyncFreshnessChip({
  syncedAt,
  label,
  compact = false,
}: SyncFreshnessChipProps) {
  // Tick once a minute so "Synced 5 min ago" → "Synced 6 min ago" without
  // the parent needing to refetch. Cleared on unmount.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!syncedAt) {
    return (
      <span
        className={`inline-flex items-center gap-1 ${compact ? "text-[10px]" : "text-[11px]"} text-text-soft`}
        title="No sync recorded yet"
      >
        <span aria-hidden="true">○</span>
        Never synced
      </span>
    );
  }

  const { text, tone } = formatRelative(syncedAt);
  const labelText = label ? text.replace("Synced", `${label} synced`) : text;
  const toneClass = {
    green: "text-emerald-700",
    muted: "text-text-soft",
    amber: "text-amber-700",
    red: "text-rose-700 font-semibold",
  }[tone];
  const dotChar = {
    green: "●",
    muted: "●",
    amber: "●",
    red: "●",
  }[tone];
  const dotColor = {
    green: "text-emerald-500",
    muted: "text-slate-400",
    amber: "text-amber-500",
    red: "text-rose-500",
  }[tone];

  // The full ISO timestamp goes in the title attr for hover-precision.
  // tabular-nums keeps the digits aligned so "5m" and "55m" don't dance
  // when the text updates in place every minute.
  return (
    <span
      className={`inline-flex items-center gap-1 ${compact ? "text-[10px]" : "text-[11px]"} ${toneClass} tabular-nums`}
      title={`Last sync: ${new Date(syncedAt).toLocaleString()}`}
      aria-label={`${labelText}. Last sync at ${new Date(syncedAt).toLocaleString()}.`}
    >
      <span className={dotColor} aria-hidden="true">
        {dotChar}
      </span>
      {labelText}
    </span>
  );
}
