import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { api, fmtCents, } from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
/* Source-kind glyph + nav target. Mirrors MoneyOnTablePanel's
 * SOURCE_KIND_META but trimmed to what we need on a per-row card.
 * The href values are URL hashes that App.tsx's hash-based router
 * will pick up — clicking "Open" from this panel will navigate to
 * the corresponding deep panel. */
const KIND_INFO = {
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
function kindMeta(kind) {
    return (KIND_INFO[kind] ?? {
        emoji: "💰",
        href: "#money-on-table",
        label: kind.replace(/_/g, " "),
    });
}
/* Format minutes as a pill. Round to user-readable bins so the UI
 * doesn't show "6 min" / "7 min" / "8 min" — just a few buckets. */
function fmtMinutes(m) {
    if (m <= 1)
        return "1 min";
    if (m <= 5)
        return "5 min";
    if (m <= 15)
        return "15 min";
    if (m <= 30)
        return "30 min";
    if (m <= 60)
        return "1 hr";
    return `${Math.round(m / 60)} hr`;
}
/* Format $/minute as a punchy badge. We compute from the raw
 * value_per_minute_cents instead of the ranked priority_score so the
 * UI shows real dollars-per-minute the user can reason about. */
function fmtDollarsPerMin(cents) {
    if (!cents)
        return "—";
    const dpm = cents / 100;
    if (dpm >= 100)
        return `$${Math.round(dpm)}/min`;
    if (dpm >= 10)
        return `$${dpm.toFixed(1)}/min`;
    if (dpm >= 1)
        return `$${dpm.toFixed(2)}/min`;
    return `${(dpm * 100).toFixed(0)}¢/min`;
}
function fmtDeadline(iso, days) {
    if (!iso)
        return null;
    if (days === null)
        return null;
    if (days < 0)
        return "expired";
    if (days === 0)
        return "expires today";
    if (days === 1)
        return "expires tomorrow";
    if (days <= 7)
        return `expires in ${days}d`;
    return `expires ${new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}
/* ------------------------------------------------------------------ */
/*  Hero + move-card subcomponents                                     */
/* ------------------------------------------------------------------ */
/** Visual category for the streak chip — drives the flame intensity
 *  and copy. Tiered so a single-day streak doesn't render with the
 *  same blast of color as a 30-day one. */
function streakCopy(currentDays, longestDays) {
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
    }
    else if (currentDays >= 7) {
        bg = "bg-amber-100";
        text = "text-amber-800";
    }
    else {
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
function Hero({ headline, totalCents, totalMinutes, urgentCount, currentStreak, longestStreak, asOf, onRefresh, refreshing, }) {
    const streak = streakCopy(currentStreak, longestStreak);
    return (_jsx("div", { className: "bg-card border border-border rounded-md shadow-card p-6 mb-5", children: _jsxs("div", { className: "flex items-start justify-between gap-4", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide font-semibold", children: "Today's queue" }), streak && (_jsxs("span", { className: `px-2 py-0.5 rounded-full text-[11px] font-semibold inline-flex items-center gap-1 ${streak.bg} ${streak.text}`, title: streak.sub, children: [_jsx("span", { className: "text-sm leading-none", children: streak.emoji }), streak.label] })), _jsx(SyncFreshnessChip, { syncedAt: asOf })] }), _jsx("div", { className: "text-xl font-semibold text-text mt-1 leading-snug", children: headline }), totalCents > 0 && (_jsxs("div", { className: "flex items-baseline gap-4 mt-3", children: [_jsxs("div", { children: [_jsx("div", { className: "text-[11px] text-text-muted uppercase tracking-wide", children: "Potential" }), _jsx("div", { className: "text-2xl font-semibold text-inflow tabular-nums", children: fmtCents(totalCents) })] }), _jsxs("div", { children: [_jsx("div", { className: "text-[11px] text-text-muted uppercase tracking-wide", children: "Time to clear" }), _jsxs("div", { className: "text-2xl font-semibold text-text tabular-nums", children: [totalMinutes, " min"] })] }), urgentCount > 0 && (_jsxs("div", { children: [_jsx("div", { className: "text-[11px] text-text-muted uppercase tracking-wide", children: "Urgent" }), _jsx("div", { className: "text-2xl font-semibold text-outflow tabular-nums", children: urgentCount })] }))] }))] }), _jsx("button", { onClick: onRefresh, disabled: refreshing, className: "px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-brand hover:text-brand disabled:opacity-50 shrink-0", children: refreshing ? "Refreshing…" : "Refresh" })] }) }));
}
function MoveCard({ move, rank, onAction, isActioning, }) {
    const meta = kindMeta(move.source_kind);
    const deadlineLabel = fmtDeadline(move.deadline, move.urgency_days);
    return (_jsx("div", { className: `bg-card border rounded-md shadow-card p-4 mb-3 hover:border-brand transition-colors ${move.is_urgent ? "border-outflow/40" : "border-border"}`, children: _jsxs("div", { className: "flex items-start gap-3", children: [_jsxs("div", { className: "shrink-0 flex flex-col items-center pt-0.5", children: [_jsx("div", { className: "w-6 h-6 rounded-full bg-brand-light text-brand text-xs font-bold flex items-center justify-center tabular-nums", children: rank }), _jsx("div", { className: "text-2xl mt-1.5 leading-none", children: meta.emoji })] }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "text-sm font-semibold text-text", children: move.title }), _jsx("span", { className: "text-[10px] text-text-muted uppercase tracking-wide", children: meta.label }), move.is_urgent && deadlineLabel && (_jsxs("span", { className: "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-red-50 text-outflow", children: [_jsx("span", { className: "w-1.5 h-1.5 rounded-full bg-outflow" }), " ", deadlineLabel] })), !move.is_urgent && deadlineLabel && (_jsxs("span", { className: "text-[10px] text-text-soft", children: ["\u00B7 ", deadlineLabel] }))] }), _jsx("div", { className: "text-xs text-text-muted mt-1 line-clamp-2", children: move.description }), _jsxs("div", { className: "flex items-center gap-3 mt-2 flex-wrap", children: [move.estimated_cents != null && move.estimated_cents > 0 && (_jsx("span", { className: "inline-flex items-center gap-1 text-xs text-inflow font-semibold tabular-nums", children: fmtCents(move.estimated_cents) })), _jsxs("span", { className: "text-xs text-text-muted tabular-nums", children: ["\u23F1 ", fmtMinutes(move.effort_minutes)] }), move.value_per_minute_cents != null && move.value_per_minute_cents > 0 && (_jsx("span", { className: "px-1.5 py-0.5 rounded bg-emerald-50 text-inflow text-[10px] font-semibold tabular-nums", children: fmtDollarsPerMin(move.value_per_minute_cents) })), move.confidence < 0.5 && (_jsx("span", { className: "text-[10px] text-text-soft italic", children: "low confidence \u2014 verify" }))] })] }), _jsxs("div", { className: "shrink-0 flex flex-col gap-1.5 items-stretch", children: [move.action_url ? (_jsxs("a", { href: move.action_url, target: "_blank", rel: "noreferrer", className: "px-3 py-1.5 text-xs font-semibold text-white bg-brand rounded hover:bg-brand-navy whitespace-nowrap text-center", children: [move.action_label || "Open", " \u2197"] })) : (_jsx("a", { href: meta.href, className: "px-3 py-1.5 text-xs font-semibold text-white bg-brand rounded hover:bg-brand-navy whitespace-nowrap text-center", children: move.action_label || "Open" })), _jsxs("div", { className: "flex gap-1", children: [_jsx("button", { onClick: () => onAction("done"), disabled: isActioning, className: "flex-1 px-2 py-1 text-[11px] font-semibold border border-border text-text-muted rounded hover:border-inflow hover:text-inflow disabled:opacity-50", title: "I did this \u2014 remove from queue forever", children: "\u2713 Done" }), _jsx("button", { onClick: () => onAction("snoozed", 7), disabled: isActioning, className: "flex-1 px-2 py-1 text-[11px] font-semibold border border-border text-text-muted rounded hover:border-warn hover:text-warn disabled:opacity-50", title: "Hide for 7 days", children: "\uD83D\uDCA4 7d" }), _jsx("button", { onClick: () => onAction("dismissed"), disabled: isActioning, className: "px-2 py-1 text-[11px] font-semibold border border-border text-text-muted rounded hover:border-outflow hover:text-outflow disabled:opacity-50", title: "Don't show me again", children: "\u2715" })] })] })] }) }));
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
        mutationFn: (vars) => api.dailyMoveAction({
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
        mutationFn: (rec) => api.dailyMoveUndo(rec.source_kind, rec.source_id, rec.source_key),
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
        return (_jsx("div", { className: "bg-card border border-border rounded-md shadow-card p-8 text-center text-text-muted text-sm", children: "Computing today's moves\u2026" }));
    }
    if (report.isError) {
        return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-6 text-sm", children: [_jsx("div", { className: "text-outflow font-semibold mb-2", children: "Couldn't load daily moves" }), _jsx("div", { className: "text-text-muted text-xs", children: String(report.error?.message ?? report.error) })] }));
    }
    if (!data)
        return null;
    return (_jsxs("div", { children: [_jsx(Hero, { headline: data.headline, totalCents: data.total_potential_cents, totalMinutes: data.total_minutes, urgentCount: data.urgent_count, currentStreak: data.current_streak_days, longestStreak: data.longest_streak_days, asOf: data.as_of, onRefresh: refresh, refreshing: report.isFetching }), sortedMoves.length === 0 ? (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-8 text-center", children: [_jsx("div", { className: "text-3xl mb-2", children: "\uD83C\uDF89" }), _jsx("div", { className: "text-sm font-semibold text-text", children: "Inbox zero on money moves" }), _jsx("div", { className: "text-xs text-text-muted mt-1", children: "No high-value actions detected right now. Sync your accounts or run the offer scrapers to surface fresh ones." })] })) : (_jsxs("div", { children: [sortedMoves.map((move, i) => (_jsx(MoveCard, { move: move, rank: i + 1, onAction: (act, snoozeDays) => action.mutate({ move, action: act, snooze_days: snoozeDays }), isActioning: action.isPending }, `${move.source_kind}-${move.source_id ?? i}`))), data.items_remaining > 0 && (_jsx("div", { className: "text-xs text-text-muted text-center mt-4", children: _jsxs("a", { href: "#money-on-table", className: "hover:text-brand underline-offset-2 hover:underline", children: [data.items_remaining, " more in the full Money-on-the-table view \u2192"] }) }))] })), recent.data && recent.data.length > 0 && (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mt-6 p-4", children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs font-semibold text-text-muted uppercase tracking-wide", children: "Recently actioned" }), _jsx("div", { className: "text-[11px] text-text-soft", children: "Last 14 days \u00B7 click undo to bring it back" })] }), _jsxs("span", { className: "text-[11px] text-text-soft", children: [recent.data.length, " ", recent.data.length === 1 ? "item" : "items"] })] }), _jsx("div", { className: "divide-y divide-border", children: recent.data.slice(0, 10).map((rec) => {
                            const label = rec.source_key ??
                                `${rec.source_kind}#${rec.source_id ?? "?"}`;
                            const actionTone = rec.action === "done"
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
                            const isUndoing = undo.isPending && undo.variables?.id === rec.id;
                            return (_jsxs("div", { className: "flex items-center gap-3 py-2 text-xs", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: "font-medium text-text truncate", children: label }), _jsxs("div", { className: "text-text-soft text-[10px]", children: [_jsx("span", { className: `uppercase font-semibold ${actionTone}`, children: rec.action }), rec.action === "snoozed" && rec.snoozed_until && (_jsxs(_Fragment, { children: [" \u00B7 until ", rec.snoozed_until] })), " · ", dateStr] })] }), _jsx("button", { onClick: () => undo.mutate(rec), disabled: isUndoing, className: "text-[11px] text-brand hover:text-brand-navy font-semibold disabled:opacity-50 whitespace-nowrap", children: isUndoing ? "Undoing…" : "Undo" })] }, rec.id));
                        }) })] }))] }));
}
