import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Subscriptions panel — Phase B.
 *
 * Detected recurring outflows, grouped into typed buckets so Chris can see at
 * a glance:
 *   - what's confirmed vs auto-detected ("Needs review")
 *   - the monthly + annual cost broken down by category
 *   - which rows have a *price change* the detector or the T2 Gmail parser
 *     spotted (prior_amount_cents != last_amount_cents)
 *
 * Phase A had a single flat table inside App.tsx; this replaces it. The old
 * detector still exists; this UI surfaces all the new fields.
 *
 * Why a separate panel: the surplus engine (Phase D) consumes these rows.
 * Keeping confirm/dismiss state visible + easy reduces the chance Chris
 * forgets to triage them, which would silently degrade surplus math.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
const TABS = [
    { key: "all", label: "All", hint: "Every active or suspected sub" },
    { key: "needs_review", label: "Needs review", hint: "Suspected, or type=unknown — confirm/dismiss to clear" },
    { key: "price_changes", label: "Price changed", hint: "Last charge differs from the prior baseline" },
    { key: "streaming", label: "Streaming", hint: "Netflix, Spotify, etc." },
    { key: "saas", label: "SaaS", hint: "Adobe, ChatGPT, GitHub, etc." },
    { key: "news_media", label: "News", hint: "NYT, WSJ, Substack, etc." },
    { key: "utilities", label: "Utilities", hint: "PG&E, water, gas, trash" },
    { key: "internet", label: "Internet", hint: "Xfinity, Comcast, fiber" },
    { key: "telecom", label: "Telecom", hint: "Mobile carrier" },
    { key: "insurance", label: "Insurance", hint: "Auto, home, health premium" },
    { key: "fitness", label: "Fitness", hint: "Gym, Peloton, ClassPass" },
    { key: "storage", label: "Storage", hint: "iCloud, Dropbox, Public Storage" },
    { key: "gaming", label: "Gaming", hint: "Xbox Live, PS+, Nintendo" },
    { key: "other", label: "Other", hint: "Confirmed-recurring but uncategorized" },
    { key: "dismissed", label: "Dismissed", hint: "Marked not-a-subscription" },
];
/* ------------------------------------------------------------------ */
/*  Type & status badges                                              */
/* ------------------------------------------------------------------ */
const TYPE_BADGE = {
    streaming: { label: "Streaming", bg: "bg-rose-50", fg: "text-rose-700" },
    saas: { label: "SaaS", bg: "bg-indigo-50", fg: "text-indigo-700" },
    news_media: { label: "News", bg: "bg-orange-50", fg: "text-orange-700" },
    utilities: { label: "Utility", bg: "bg-yellow-50", fg: "text-yellow-700" },
    internet: { label: "Internet", bg: "bg-cyan-50", fg: "text-cyan-700" },
    telecom: { label: "Telecom", bg: "bg-sky-50", fg: "text-sky-700" },
    insurance: { label: "Insurance", bg: "bg-emerald-50", fg: "text-emerald-700" },
    fitness: { label: "Fitness", bg: "bg-lime-50", fg: "text-lime-700" },
    storage: { label: "Storage", bg: "bg-purple-50", fg: "text-purple-700" },
    gaming: { label: "Gaming", bg: "bg-fuchsia-50", fg: "text-fuchsia-700" },
    other: { label: "Other", bg: "bg-slate-100", fg: "text-text-muted" },
    unknown: { label: "?", bg: "bg-slate-100", fg: "text-text-muted" },
};
const STATUS_BADGE = {
    active: "bg-brand-light text-brand-navy",
    paused: "bg-amber-50 text-warn",
    suspected: "bg-amber-50 text-warn",
    cancelled: "bg-gray-100 text-text-muted line-through",
    dismissed: "bg-gray-100 text-text-muted",
};
function TypeBadge({ type }) {
    const cfg = TYPE_BADGE[type];
    return (_jsx("span", { className: `px-1.5 py-0.5 rounded-sm ${cfg.bg} ${cfg.fg} text-[10px] font-semibold uppercase tracking-wide`, children: cfg.label }));
}
function ConfidenceChip({ score }) {
    if (score == null)
        return null;
    const pct = Math.round(score * 100);
    const tone = pct >= 75
        ? "bg-emerald-50 text-inflow"
        : pct >= 50
            ? "bg-amber-50 text-warn"
            : "bg-slate-100 text-text-muted";
    return (_jsxs("span", { className: `ml-2 px-1.5 py-0.5 rounded-sm ${tone} text-[10px] font-semibold tracking-wide tabular-nums`, title: "Detector confidence (0\u2013100). Driven by occurrences \u00D7 amount stability \u00D7 cadence agreement.", children: [pct, "%"] }));
}
function CadenceLabel({ days, label }) {
    return (_jsxs("span", { className: "text-xs text-text-muted", children: [(label ?? "monthly").replace(/^./, (s) => s.toUpperCase()), " \u00B7 ", days, "d"] }));
}
/* ------------------------------------------------------------------ */
/*  Price change banner                                               */
/* ------------------------------------------------------------------ */
function PriceChangeBanner({ sub }) {
    if (sub.prior_amount_cents == null ||
        sub.last_amount_cents == null ||
        sub.prior_amount_cents === sub.last_amount_cents) {
        return null;
    }
    const direction = Math.abs(sub.last_amount_cents) > Math.abs(sub.prior_amount_cents)
        ? "increased"
        : "decreased";
    const tone = direction === "increased"
        ? "bg-rose-50 text-outflow"
        : "bg-emerald-50 text-inflow";
    const arrow = direction === "increased" ? "↑" : "↓";
    return (_jsxs("div", { className: `mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${tone}`, children: [_jsx("span", { children: arrow }), _jsxs("span", { children: ["Price ", direction, ": ", fmtCents(sub.prior_amount_cents), " \u2192", " ", fmtCents(sub.last_amount_cents)] }), sub.price_change_date && (_jsxs("span", { className: "text-text-soft ml-1", children: ["on ", new Date(sub.price_change_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })] }))] }));
}
/* ------------------------------------------------------------------ */
/*  Stats header                                                      */
/* ------------------------------------------------------------------ */
function StatsHeader({ stats }) {
    if (!stats) {
        return _jsx("div", { className: "text-text-muted text-sm", children: "Loading stats\u2026" });
    }
    const cards = [
        {
            label: "Monthly recurring",
            value: fmtCents(stats.monthly_cost_cents),
            sub: `${stats.total_count} active or suspected`,
            tone: "out",
        },
        {
            label: "Annual recurring",
            value: fmtCents(stats.annual_cost_cents),
            sub: `${stats.confirmed_count} confirmed`,
            tone: "out",
        },
        {
            label: "Needs review",
            value: String(stats.needs_review_count),
            sub: stats.needs_review_count > 0 ? "Confirm or dismiss" : "All clear",
            tone: stats.needs_review_count > 0 ? "warn" : undefined,
        },
        {
            label: "Price changes",
            value: String(stats.price_change_count),
            sub: stats.price_change_count > 0 ? "Recent changes detected" : "No drift",
            tone: stats.price_change_count > 0 ? "warn" : undefined,
        },
    ];
    return (_jsx("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-4", children: cards.map((c) => {
            const valueColor = c.tone === "out"
                ? "text-outflow"
                : c.tone === "warn"
                    ? "text-warn"
                    : c.tone === "in"
                        ? "text-inflow"
                        : "text-text";
            return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-4", children: [_jsx("div", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: c.label }), _jsx("div", { className: `text-2xl font-semibold mt-1 tabular-nums ${valueColor}`, children: c.value }), c.sub && (_jsx("div", { className: "text-text-soft text-xs mt-0.5", children: c.sub }))] }, c.label));
        }) }));
}
function SubRow({ sub, actions }) {
    return (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsxs("td", { className: "px-4 py-3", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "text-sm font-medium", children: sub.name }), _jsx(TypeBadge, { type: sub.subscription_type }), _jsx(ConfidenceChip, { score: sub.confidence_score }), sub.is_user_confirmed && (_jsx("span", { className: "text-[10px] font-semibold text-inflow uppercase tracking-wide", children: "\u2713 confirmed" })), sub.is_variable_amount && (_jsx("span", { className: "text-[10px] text-text-muted", title: "Variable-amount bill \u2014 minor wobble doesn't trigger price-change alerts.", children: "variable" }))] }), _jsx(PriceChangeBanner, { sub: sub })] }), _jsx("td", { className: "px-4 py-3", children: _jsx("span", { className: `inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${STATUS_BADGE[sub.status]}`, children: sub.status }) }), _jsxs("td", { className: "px-4 py-3", children: [_jsx(CadenceLabel, { days: sub.cadence_days, label: sub.cadence_label }), sub.n_occurrences != null && (_jsxs("div", { className: "text-[11px] text-text-soft", children: [sub.n_occurrences, "\u00D7 seen"] }))] }), _jsx("td", { className: "px-4 py-3 text-right tabular-nums text-sm font-semibold text-outflow", children: fmtCents(sub.amount_cents) }), _jsx("td", { className: "px-4 py-3 text-sm text-text-muted", children: sub.next_expected_date
                    ? new Date(sub.next_expected_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                    : "—" }), _jsxs("td", { className: "px-4 py-3 text-right whitespace-nowrap", children: [!sub.is_user_confirmed && sub.status !== "dismissed" && (_jsx("button", { onClick: () => actions.onConfirm(sub.id), className: "text-xs text-brand hover:text-brand-navy font-semibold ml-2", title: "Mark as a real subscription \u2014 counts toward surplus math", children: "Confirm" })), sub.subscription_type === "unknown" && (_jsxs("select", { className: "text-xs border border-border rounded px-1 py-0.5 ml-2 text-text-muted bg-card", value: "", onChange: (e) => e.target.value && actions.onSetType(sub.id, e.target.value), title: "Manually classify", children: [_jsx("option", { value: "", children: "Set type\u2026" }), _jsx("option", { value: "streaming", children: "Streaming" }), _jsx("option", { value: "saas", children: "SaaS" }), _jsx("option", { value: "news_media", children: "News" }), _jsx("option", { value: "utilities", children: "Utility" }), _jsx("option", { value: "internet", children: "Internet" }), _jsx("option", { value: "telecom", children: "Telecom" }), _jsx("option", { value: "insurance", children: "Insurance" }), _jsx("option", { value: "fitness", children: "Fitness" }), _jsx("option", { value: "storage", children: "Storage" }), _jsx("option", { value: "gaming", children: "Gaming" }), _jsx("option", { value: "other", children: "Other" })] })), _jsx("button", { onClick: () => actions.onCancel(sub.id), className: "text-xs text-text-muted hover:text-outflow font-semibold ml-3", title: "You cancelled this subscription", children: "Cancelled" }), _jsx("button", { onClick: () => actions.onDismiss(sub.id), className: "text-xs text-text-muted hover:text-text font-semibold ml-3", title: "Not a subscription \u2014 don't resurface", children: "Dismiss" }), _jsx("button", { onClick: () => actions.onDelete(sub.id), className: "text-xs text-text-soft hover:text-outflow ml-3", title: "Delete row", children: "\u2715" })] })] }));
}
/* ------------------------------------------------------------------ */
/*  Filtering                                                          */
/* ------------------------------------------------------------------ */
function filterByTab(rows, tab) {
    switch (tab) {
        case "all":
            return rows.filter((s) => s.status !== "dismissed");
        case "dismissed":
            return rows.filter((s) => s.status === "dismissed");
        case "needs_review":
            return rows.filter((s) => s.status !== "dismissed" &&
                (s.status === "suspected" || s.subscription_type === "unknown"));
        case "price_changes":
            return rows.filter((s) => s.prior_amount_cents != null &&
                s.last_amount_cents != null &&
                s.prior_amount_cents !== s.last_amount_cents);
        default:
            return rows.filter((s) => s.subscription_type === tab && s.status !== "dismissed");
    }
}
/* ------------------------------------------------------------------ */
/*  Panel                                                              */
/* ------------------------------------------------------------------ */
export default function SubscriptionsPanel() {
    const qc = useQueryClient();
    const [tab, setTab] = useState("all");
    const [applyResult, setApplyResult] = useState(null);
    const subs = useQuery({
        queryKey: ["subscriptions"],
        queryFn: () => api.listSubscriptions(),
    });
    const stats = useQuery({
        queryKey: ["subscription-stats"],
        queryFn: () => api.subscriptionStats(false),
    });
    const invalidate = () => Promise.all([
        qc.invalidateQueries({ queryKey: ["subscriptions"] }),
        qc.invalidateQueries({ queryKey: ["subscription-stats"] }),
    ]);
    const detect = useMutation({
        mutationFn: api.detectSubscriptions,
        onSuccess: invalidate,
    });
    const confirm = useMutation({
        mutationFn: api.confirmSubscription,
        onSuccess: invalidate,
    });
    const dismiss = useMutation({
        mutationFn: api.dismissSubscription,
        onSuccess: invalidate,
    });
    const setStatus = useMutation({
        mutationFn: ({ id, status }) => api.setSubscriptionStatus(id, status),
        onSuccess: invalidate,
    });
    const setType = useMutation({
        mutationFn: ({ id, type }) => api.setSubscriptionType(id, type),
        onSuccess: invalidate,
    });
    const del = useMutation({
        mutationFn: api.deleteSubscription,
        onSuccess: invalidate,
    });
    const applyPromos = useMutation({
        mutationFn: api.applySubscriptionPromos,
        onSuccess: (r) => {
            setApplyResult(`Scanned ${r.scanned} email${r.scanned === 1 ? "" : "s"} · ${r.price_changes_applied} price change${r.price_changes_applied === 1 ? "" : "s"} applied · ${r.promos_seen} promo${r.promos_seen === 1 ? "" : "s"} seen${r.unlinked ? ` · ${r.unlinked} unlinked` : ""}`);
            invalidate();
        },
        onError: () => setApplyResult("Failed to apply promo signals"),
    });
    const visible = useMemo(() => filterByTab(subs.data ?? [], tab), [subs.data, tab]);
    // Tab counts for the strip — only counts rows that the tab would show.
    const counts = useMemo(() => {
        const out = {};
        for (const t of TABS) {
            out[t.key] = filterByTab(subs.data ?? [], t.key).length;
        }
        return out;
    }, [subs.data]);
    const actions = {
        onConfirm: (id) => confirm.mutate(id),
        onDismiss: (id) => dismiss.mutate(id),
        onCancel: (id) => setStatus.mutate({ id, status: "cancelled" }),
        onSetType: (id, type) => setType.mutate({ id, type }),
        onDelete: (id) => {
            // Note: local `confirm` mutation shadows window.confirm — qualify it.
            if (window.confirm("Delete this subscription row?"))
                del.mutate(id);
        },
    };
    return (_jsxs("div", { children: [_jsx(StatsHeader, { stats: stats.data }), _jsxs("div", { className: "flex flex-wrap gap-1 mb-3", children: [TABS.map((t) => {
                        const count = counts[t.key] ?? 0;
                        const isActive = tab === t.key;
                        return (_jsxs("button", { onClick: () => setTab(t.key), title: t.hint, className: `px-3 py-1.5 rounded text-xs font-semibold border transition-colors ${isActive
                                ? "bg-brand text-white border-brand"
                                : "bg-card text-text-muted border-border hover:border-brand hover:text-brand"}`, children: [t.label, count > 0 && (_jsx("span", { className: `ml-1.5 tabular-nums ${isActive ? "text-white/80" : "text-text-soft"}`, children: count }))] }, t.key));
                    }), _jsx("div", { className: "flex-1" }), _jsx("button", { onClick: () => applyPromos.mutate(), disabled: applyPromos.isPending, className: "px-3 py-1.5 rounded text-xs font-semibold border border-border bg-card text-text-muted hover:border-brand hover:text-brand disabled:opacity-60", title: "Scan recent T2-parsed Gmail messages and apply promo / price-change signals", children: applyPromos.isPending ? "Applying…" : "Apply email signals" }), _jsx("button", { onClick: () => detect.mutate(), disabled: detect.isPending, className: "px-3 py-1.5 rounded text-xs font-semibold bg-brand text-white hover:bg-brand-navy disabled:opacity-60", children: detect.isPending ? "Detecting…" : "Re-detect" })] }), applyResult && (_jsx("div", { className: "mb-3 px-3 py-2 bg-brand-light/40 border border-brand-light rounded text-xs text-brand-navy", children: applyResult })), _jsx("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left", children: "Subscription" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Status" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Cadence" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Amount" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Next charge" }), _jsx("th", { className: "px-4 py-2 text-right" })] }) }), _jsxs("tbody", { children: [subs.isLoading && (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "p-8 text-center text-text-muted text-sm", children: "Loading\u2026" }) })), !subs.isLoading && visible.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "p-8 text-center text-text-muted text-sm", children: (subs.data ?? []).length === 0
                                            ? _jsxs(_Fragment, { children: ["No subscriptions detected yet. Click ", _jsx("em", { children: "Re-detect" }), "."] })
                                            : "Nothing in this bucket." }) })), visible.map((s) => (_jsx(SubRow, { sub: s, actions: actions }, s.id)))] })] }) })] }));
}
