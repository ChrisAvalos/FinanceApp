/**
 * Daily Money Moves — the top-of-app action surface.
 *
 * Companion to MoneyOnTablePanel. Same upstream data, but ruthlessly
 * sliced and prioritized for the question Chris asks every morning:
 * "what's the best 5–20 minutes I could spend on my money RIGHT NOW?"
 *
 * Backend (/api/money-on-table/today) blends $/minute with a 7-day
 * urgency boost so an expiring class-action with $50 + 5 min effort
 * leapfrogs a $200 card-benefit you have all year to claim. Top-N
 * (default 5) come back, the rest stays in the full Money-on-table
 * panel for when the user wants the long list.
 *
 * Design intent:
 *   - One screen of hero + 3-7 cards. No tables.
 *   - Every card answers: what is it, how much, how long, where do I go.
 *   - Urgent items get a red dot and float. The bias is do-the-easiest-
 *     biggest-thing-first; expiring stuff just jumps the queue.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type DailyMove,
  type DailyMoveActionRecord,
} from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
import PanelError from "./components/PanelError";

/* Source-kind glyph + nav target. Mirrors MoneyOnTablePanel's
 * SOURCE_KIND_META but trimmed to what we need on a per-row card.
 * The href values are URL hashes that App.tsx's hash-based router
 * will pick up — clicking "Open" from this panel will navigate to
 * the corresponding deep panel. */
const KIND_INFO: Record<string, { emoji: string; href: string; label: string }> = {
  unclaimed_property: { emoji: "💸", href: "#unclaimed", label: "Unclaimed" },
  class_action: { emoji: "⚖️", href: "#claims", label: "Class action" },
  regulatory_redress: { emoji: "🏛️", href: "#redress", label: "CFPB / AG" },
  card_benefit: { emoji: "🪪", href: "#benefits", label: "Card benefit" },
  yield_arb: { emoji: "🏧", href: "#yield", label: "Yield arb" },
  sub_cancel: { emoji: "🚫", href: "#subscriptions", label: "Cancel" },
  cross_store_deal: { emoji: "🏷️", href: "#deals", label: "Deal" },
  receipt_coupon: { emoji: "🎟️", href: "#receipts", label: "Coupon" },
  bank_bonus: { emoji: "🏦", href: "#money-on-table", label: "Bank bonus" },
  brokerage_bonus: { emoji: "📈", href: "#money-on-table", label: "Brokerage bonus" },
  passive_check: { emoji: "🔍", href: "#money-on-table", label: "Passive check" },
  offer: { emoji: "🎁", href: "#offers", label: "Card offer" },
};

function kindMeta(kind: string) {
  return (
    KIND_INFO[kind] ?? {
      emoji: "💰",
      href: "#money-on-table",
      label: kind.replace(/_/g, " "),
    }
  );
}

/* Format minutes as a pill. Round to user-readable bins so the UI
 * doesn't show "6 min" / "7 min" / "8 min" — just a few buckets. */
function fmtMinutes(m: number): string {
  if (m <= 1) return "1 min";
  if (m <= 5) return "5 min";
  if (m <= 15) return "15 min";
  if (m <= 30) return "30 min";
  if (m <= 60) return "1 hr";
  return `${Math.round(m / 60)} hr`;
}

/* Format $/minute as a punchy badge. We compute from the raw
 * value_per_minute_cents instead of the ranked priority_score so the
 * UI shows real dollars-per-minute the user can reason about. */
function fmtDollarsPerMin(cents: number | null): string {
  if (!cents) return "—";
  const dpm = cents / 100;
  if (dpm >= 100) return `$${Math.round(dpm)}/min`;
  if (dpm >= 10) return `$${dpm.toFixed(1)}/min`;
  if (dpm >= 1) return `$${dpm.toFixed(2)}/min`;
  return `${(dpm * 100).toFixed(0)}¢/min`;
}

function fmtDeadline(iso: string | null, days: number | null): string | null {
  if (!iso) return null;
  if (days === null) return null;
  if (days < 0) return "expired";
  if (days === 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  if (days <= 7) return `expires in ${days}d`;
  return `expires ${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/* ------------------------------------------------------------------ */
/*  Hero + move-card subcomponents                                     */
/* ------------------------------------------------------------------ */

/** Visual category for the streak chip — drives the flame intensity
 *  and copy. Tiered so a single-day streak doesn't render with the
 *  same blast of color as a 30-day one. */
function streakCopy(currentDays: number, longestDays: number): {
  label: string;
  emoji: string;
  bg: string;
  text: string;
  sub: string;
} | null {
  if (currentDays <= 0) {
    // Lapsed streak — encourage rather than gamify.
    if (longestDays >= 3) {
      return {
        label: "Streak ended",
        emoji: "💤",
        bg: "bg-slate-100",
        text: "text-slate-600",
        sub: `Best was ${longestDays} day${longestDays === 1 ? "" : "s"} — start a new run`,
      };
    }
    return null; // never started — don't clutter the hero
  }
  // Active streak. Tier the visual based on length.
  const isBest = currentDays >= longestDays && currentDays > 1;
  let bg = "bg-amber-100";
  let text = "text-amber-800";
  let emoji = "🔥";
  if (currentDays >= 30) {
    bg = "bg-rose-100";
    text = "text-rose-700";
  } else if (currentDays >= 7) {
    bg = "bg-amber-100";
    text = "text-amber-800";
  } else {
    bg = "bg-emerald-50";
    text = "text-emerald-700";
    emoji = "✨";
  }
  const sub = isBest
    ? "All-time best — keep going"
    : `Best: ${longestDays} day${longestDays === 1 ? "" : "s"}`;
  return {
    label: `${currentDays}-day streak`,
    emoji,
    bg,
    text,
    sub,
  };
}

function Hero({
  headline,
  totalCents,
  totalMinutes,
  urgentCount,
  currentStreak,
  longestStreak,
  asOf,
  onRefresh,
  refreshing,
}: {
  headline: string;
  totalCents: number;
  totalMinutes: number;
  urgentCount: number;
  currentStreak: number;
  longestStreak: number;
  /** ISO timestamp of the report — drives the SyncFreshnessChip. */
  asOf: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const streak = streakCopy(currentStreak, longestStreak);
  return (
    <div className="bg-card border border-border rounded-md shadow-card p-6 mb-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-xs text-text-muted uppercase tracking-wide font-semibold">
              Today's queue
            </div>
            {streak && (
              <span
                className={`px-2 py-0.5 rounded-full text-[11px] font-semibold inline-flex items-center gap-1 ${streak.bg} ${streak.text}`}
                title={streak.sub}
              >
                <span className="text-sm leading-none">{streak.emoji}</span>
                {streak.label}
              </span>
            )}
            <SyncFreshnessChip syncedAt={asOf} />
          </div>
          <div className="text-xl font-semibold text-text mt-1 leading-snug">
            {headline}
          </div>
          {totalCents > 0 && (
            <div className="flex items-baseline gap-4 mt-3">
              <div>
                <div className="text-[11px] text-text-muted uppercase tracking-wide">
                  Potential
                </div>
                <div className="text-2xl font-semibold text-inflow tabular-nums">
                  {fmtCents(totalCents)}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-text-muted uppercase tracking-wide">
                  Time to clear
                </div>
                <div className="text-2xl font-semibold text-text tabular-nums">
                  {totalMinutes} min
                </div>
              </div>
              {urgentCount > 0 && (
                <div>
                  <div className="text-[11px] text-text-muted uppercase tracking-wide">
                    Urgent
                  </div>
                  <div className="text-2xl font-semibold text-outflow tabular-nums">
                    {urgentCount}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-brand hover:text-brand disabled:opacity-50 shrink-0"
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}

function MoveCard({
  move,
  rank,
  onAction,
  isActioning,
}: {
  move: DailyMove;
  rank: number;
  onAction: (action: "done" | "snoozed" | "dismissed", snoozeDays?: number) => void;
  isActioning: boolean;
}) {
  const meta = kindMeta(move.source_kind);
  const deadlineLabel = fmtDeadline(move.deadline, move.urgency_days);
  return (
    <div
      className={`bg-card border rounded-md shadow-card p-4 mb-3 hover:border-brand transition-colors ${
        move.is_urgent ? "border-outflow/40" : "border-border"
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Rank pill */}
        <div className="shrink-0 flex flex-col items-center pt-0.5">
          <div className="w-6 h-6 rounded-full bg-brand-light text-brand text-xs font-bold flex items-center justify-center tabular-nums">
            {rank}
          </div>
          <div className="text-2xl mt-1.5 leading-none">{meta.emoji}</div>
        </div>

        {/* Title + description */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-text">{move.title}</span>
            <span className="text-[10px] text-text-muted uppercase tracking-wide">
              {meta.label}
            </span>
            {move.is_urgent && deadlineLabel && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-red-50 text-outflow">
                <span className="w-1.5 h-1.5 rounded-full bg-outflow" /> {deadlineLabel}
              </span>
            )}
            {!move.is_urgent && deadlineLabel && (
              <span className="text-[10px] text-text-soft">· {deadlineLabel}</span>
            )}
          </div>
          <div className="text-xs text-text-muted mt-1 line-clamp-2">
            {move.description}
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {move.estimated_cents != null && move.estimated_cents > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-inflow font-semibold tabular-nums">
                {fmtCents(move.estimated_cents)}
              </span>
            )}
            <span className="text-xs text-text-muted tabular-nums">
              ⏱ {fmtMinutes(move.effort_minutes)}
            </span>
            {move.value_per_minute_cents != null && move.value_per_minute_cents > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-inflow text-[10px] font-semibold tabular-nums">
                {fmtDollarsPerMin(move.value_per_minute_cents)}
              </span>
            )}
            {move.confidence < 0.5 && (
              <span className="text-[10px] text-text-soft italic">
                low confidence — verify
              </span>
            )}
          </div>
        </div>

        {/* CTA + action buttons */}
        <div className="shrink-0 flex flex-col gap-1.5 items-stretch">
          {move.action_url ? (
            <a
              href={move.action_url}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-1.5 text-xs font-semibold text-white bg-brand rounded hover:bg-brand-navy whitespace-nowrap text-center"
            >
              {move.action_label || "Open"} ↗
            </a>
          ) : (
            <a
              href={meta.href}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-brand rounded hover:bg-brand-navy whitespace-nowrap text-center"
            >
              {move.action_label || "Open"}
            </a>
          )}
          <div className="flex gap-1">
            <button
              onClick={() => onAction("done")}
              disabled={isActioning}
              className="flex-1 px-2 py-1 text-[11px] font-semibold border border-border text-text-muted rounded hover:border-inflow hover:text-inflow disabled:opacity-50"
              title="I did this — remove from queue forever"
            >
              ✓ Done
            </button>
            <button
              onClick={() => onAction("snoozed", 7)}
              disabled={isActioning}
              className="flex-1 px-2 py-1 text-[11px] font-semibold border border-border text-text-muted rounded hover:border-warn hover:text-warn disabled:opacity-50"
              title="Hide for 7 days"
            >
              💤 7d
            </button>
            <button
              onClick={() => onAction("dismissed")}
              disabled={isActioning}
              className="px-2 py-1 text-[11px] font-semibold border border-border text-text-muted rounded hover:border-outflow hover:text-outflow disabled:opacity-50"
              title="Don't show me again"
            >
              ✕
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */

export default function DailyMovesPanel() {
  const qc = useQueryClient();
  const report = useQuery({
    queryKey: ["dailyMoves"],
    queryFn: () => api.dailyMoves(7), // grab a few extra so urgent items don't get cut off
  });

  // Memoize so we don't re-derive on unrelated re-renders.
  const data = report.data;
  const sortedMoves = useMemo(() => data?.moves ?? [], [data]);

  // POST to /today/action — the queue refetches and the actioned item
  // disappears. Using TanStack mutation so we get isPending state for
  // disabling the buttons during the round-trip.
  const action = useMutation({
    mutationFn: (vars: {
      move: DailyMove;
      action: "done" | "snoozed" | "dismissed";
      snooze_days?: number;
    }) =>
      api.dailyMoveAction({
        source_kind: vars.move.source_kind,
        source_id: vars.move.source_id ?? null,
        // For catalog items (no source_id) hash the title server-side;
        // we send the title as source_key so it matches _action_key().
        source_key: vars.move.source_id == null ? vars.move.title : null,
        action: vars.action,
        snooze_days: vars.snooze_days ?? null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dailyMoves"] });
      qc.invalidateQueries({ queryKey: ["dailyMoveActions"] });
      qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
    },
  });

  // Recently-actioned items — drives the "Done / snoozed" footer with
  // undo affordances. Cached for 30s so refreshing dailyMoves doesn't
  // also hammer this list.
  const recent = useQuery({
    queryKey: ["dailyMoveActions"],
    queryFn: () => api.dailyMoveActions(14),
    staleTime: 30_000,
  });
  const undo = useMutation({
    mutationFn: (rec: DailyMoveActionRecord) =>
      api.dailyMoveUndo(rec.source_kind, rec.source_id, rec.source_key),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dailyMoves"] });
      qc.invalidateQueries({ queryKey: ["dailyMoveActions"] });
      qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
    },
  });

  const refresh = () => {
    // Refresh BOTH dailyMoves and the upstream moneyOnTable so the
    // sidebar badge stays in sync. Cheap because money-on-table
    // computation is local and fast.
    qc.invalidateQueries({ queryKey: ["dailyMoves"] });
    qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
  };

  if (report.isLoading) {
    return (
      <div className="bg-card border border-border rounded-md shadow-card p-8 text-center text-text-muted text-sm">
        Computing today's moves…
      </div>
    );
  }
  if (report.isError) {
    return <PanelError title="Couldn't load Daily moves." error={report.error} onRetry={() => report.refetch()} />;
  }
  if (!data) return null;

  return (
    <div>
      <Hero
        headline={data.headline}
        totalCents={data.total_potential_cents}
        totalMinutes={data.total_minutes}
        urgentCount={data.urgent_count}
        currentStreak={data.current_streak_days}
        longestStreak={data.longest_streak_days}
        asOf={data.as_of}
        onRefresh={refresh}
        refreshing={report.isFetching}
      />

      {sortedMoves.length === 0 ? (
        <div className="bg-card border border-border rounded-md shadow-card p-8 text-center">
          <div className="text-3xl mb-2">🎉</div>
          <div className="text-sm font-semibold text-text">Inbox zero on money moves</div>
          <div className="text-xs text-text-muted mt-1">
            No high-value actions detected right now. Sync your accounts or run
            the offer scrapers to surface fresh ones.
          </div>
        </div>
      ) : (
        <div>
          {sortedMoves.map((move, i) => (
            <MoveCard
              key={`${move.source_kind}-${move.source_id ?? i}`}
              move={move}
              rank={i + 1}
              onAction={(act, snoozeDays) =>
                action.mutate({ move, action: act, snooze_days: snoozeDays })
              }
              isActioning={action.isPending}
            />
          ))}

          {data.items_remaining > 0 && (
            <div className="text-xs text-text-muted text-center mt-4">
              <a
                href="#money-on-table"
                className="hover:text-brand underline-offset-2 hover:underline"
              >
                {data.items_remaining} more in the full Money-on-the-table view →
              </a>
            </div>
          )}
        </div>
      )}

      {/* Recently actioned — lets the user undo a stray tap from earlier */}
      {recent.data && recent.data.length > 0 && (
        <div className="bg-card border border-border rounded-md shadow-card mt-6 p-4">
          <div className="flex items-center justify-between mb-2">
            <div>
              <div className="text-xs font-semibold text-text-muted uppercase tracking-wide">
                Recently actioned
              </div>
              <div className="text-[11px] text-text-soft">
                Last 14 days · click undo to bring it back
              </div>
            </div>
            <span className="text-[11px] text-text-soft">
              {recent.data.length} {recent.data.length === 1 ? "item" : "items"}
            </span>
          </div>
          <div className="divide-y divide-border">
            {recent.data.slice(0, 10).map((rec) => {
              const label =
                rec.source_key ??
                `${rec.source_kind}#${rec.source_id ?? "?"}`;
              const actionTone =
                rec.action === "done"
                  ? "text-inflow"
                  : rec.action === "snoozed"
                    ? "text-warn"
                    : "text-text-muted";
              const dateStr = new Date(rec.actioned_at).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              });
              const isUndoing =
                undo.isPending && undo.variables?.id === rec.id;
              return (
                <div
                  key={rec.id}
                  className="flex items-center gap-3 py-2 text-xs"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-text truncate">
                      {label}
                    </div>
                    <div className="text-text-soft text-[10px]">
                      <span className={`uppercase font-semibold ${actionTone}`}>
                        {rec.action}
                      </span>
                      {rec.action === "snoozed" && rec.snoozed_until && (
                        <> · until {rec.snoozed_until}</>
                      )}
                      {" · "}{dateStr}
                    </div>
                  </div>
                  <button
                    onClick={() => undo.mutate(rec)}
                    disabled={isUndoing}
                    className="text-[11px] text-brand hover:text-brand-navy font-semibold disabled:opacity-50 whitespace-nowrap"
                  >
                    {isUndoing ? "Undoing…" : "Undo"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
