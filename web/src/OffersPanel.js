import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Card Offers panel — redesigned 2026-05.
 *
 * Replaces the original transient "Scrape now" → render-results panel
 * with a persistent feed: on mount we read from GET /api/offers and
 * /api/offers/status so the user sees their current pipeline before
 * doing anything. The "Scrape now" button still works and appends to
 * (rather than replacing) what's on screen.
 *
 * Key lifts vs the old panel:
 *   • Persistent display from /api/offers (was: empty until first scrape)
 *   • Per-portal status strip with bootstrap command shown inline when
 *     auth_missing — exact PowerShell command Chris can copy-paste,
 *     no hunting in MANUAL_TASKS.md.
 *   • Filter chips by status + by portal, with running counts
 *   • Expiring-soon banner highlights offers within 7 days, since those
 *     are the ones with the smallest action window.
 *   • Activated state — "Mark activated" button writes to the backend;
 *     activated rows fade and drop to the bottom of the list.
 *   • Skeleton loading state instead of an empty box.
 *   • Hero summary: total, available, your activated count, $/mo at stake.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, fmtCents, } from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function fmtBps(bps) {
    if (bps == null)
        return "—";
    return `${(bps / 100).toFixed(1)}%`;
}
function expiryCopy(days) {
    if (days == null)
        return { text: "No expiry on file", tone: "muted" };
    if (days < 0)
        return { text: `Expired ${-days}d ago`, tone: "danger" };
    if (days === 0)
        return { text: "Expires today", tone: "danger" };
    if (days <= 3)
        return { text: `Expires in ${days}d`, tone: "danger" };
    if (days <= 7)
        return { text: `Expires in ${days}d`, tone: "warn" };
    if (days <= 30)
        return { text: `Expires in ${days}d`, tone: "soft" };
    return { text: `Expires in ${days}d`, tone: "muted" };
}
const STATUS_CONFIG = {
    available: { label: "Available", chipBg: "bg-emerald-100", chipText: "text-emerald-700" },
    activated: { label: "Activated", chipBg: "bg-sky-100", chipText: "text-sky-700" },
    redeemed: { label: "Redeemed", chipBg: "bg-violet-100", chipText: "text-violet-700" },
    expired: { label: "Expired", chipBg: "bg-slate-100", chipText: "text-slate-500" },
    dismissed: { label: "Dismissed", chipBg: "bg-slate-100", chipText: "text-slate-500" },
};
/* ------------------------------------------------------------------ */
/*  Skeleton loader                                                     */
/* ------------------------------------------------------------------ */
function OfferSkeletonGrid() {
    return (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: Array.from({ length: 6 }).map((_, i) => (_jsxs("div", { className: "border border-border rounded-md p-4 bg-card space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "h-4 w-12 bg-slate-200 rounded animate-pulse" }), _jsx("div", { className: "h-3 w-32 bg-slate-200 rounded animate-pulse" })] }), _jsx("div", { className: "h-3 w-3/4 bg-slate-200 rounded animate-pulse" }), _jsxs("div", { className: "flex items-center justify-between", children: [_jsx("div", { className: "h-3 w-20 bg-slate-200 rounded animate-pulse" }), _jsx("div", { className: "h-7 w-20 bg-slate-200 rounded animate-pulse" })] })] }, i))) }));
}
/* ------------------------------------------------------------------ */
/*  Offer card                                                          */
/* ------------------------------------------------------------------ */
function OfferCard({ o, onUpdateStatus, pendingStatus, }) {
    const exp = expiryCopy(o.expires_in_days);
    const expToneClass = exp.tone === "danger"
        ? "text-rose-600 font-semibold"
        : exp.tone === "warn"
            ? "text-amber-700"
            : exp.tone === "soft"
                ? "text-text-muted"
                : "text-text-soft";
    const statusCfg = STATUS_CONFIG[o.status];
    const dim = o.status !== "available";
    return (_jsxs("div", { className: `border border-border rounded-md p-4 bg-card hover:shadow-card-hover transition-opacity ${dim ? "opacity-65" : ""}`, children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "px-1.5 py-0.5 rounded-sm bg-slate-100 text-text text-[10px] font-semibold uppercase tracking-wide", children: o.source }), _jsx("span", { className: `px-1.5 py-0.5 rounded-sm text-[10px] font-semibold uppercase tracking-wide ${statusCfg.chipBg} ${statusCfg.chipText}`, children: statusCfg.label }), _jsx("h4", { className: "text-sm font-semibold text-text truncate", children: o.merchant_name || o.title })] }), _jsx("p", { className: "text-xs text-text-muted mt-1 line-clamp-2", children: o.title })] }), _jsxs("div", { className: "text-right shrink-0", children: [o.estimated_value_cents != null && o.estimated_value_cents > 0 && (_jsxs("div", { className: "text-base font-semibold tabular-nums text-warn", children: [fmtCents(o.estimated_value_cents), "/mo"] })), _jsxs("div", { className: "text-[11px] text-text-soft", children: [fmtBps(o.reward_value_bps), " ", o.reward_type, o.reward_cap_cents != null && ` · cap ${fmtCents(o.reward_cap_cents)}`] })] })] }), _jsxs("div", { className: "flex items-center justify-between gap-2 mt-3 text-xs", children: [_jsx("span", { className: expToneClass, children: exp.text }), _jsxs("div", { className: "flex items-center gap-2", children: [o.status === "available" && (_jsxs(_Fragment, { children: [_jsx("button", { onClick: () => onUpdateStatus(o.id, "dismissed"), disabled: pendingStatus === "dismissed", className: "px-2 py-1 text-[11px] text-text-muted hover:text-outflow disabled:opacity-50", title: "Hide this offer \u2014 won't appear in available list", children: "Dismiss" }), o.activation_url && (_jsx("a", { href: o.activation_url, target: "_blank", rel: "noopener noreferrer", onClick: () => onUpdateStatus(o.id, "activated"), className: "px-2 py-1 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white", children: "Activate \u2192" }))] })), o.status === "activated" && (_jsxs(_Fragment, { children: [_jsx("button", { onClick: () => onUpdateStatus(o.id, "available"), className: "px-2 py-1 text-[11px] text-text-muted hover:text-text", children: "Undo" }), _jsx("button", { onClick: () => onUpdateStatus(o.id, "redeemed"), disabled: pendingStatus === "redeemed", className: "px-2 py-1 text-xs font-semibold rounded border border-emerald-500 text-emerald-700 hover:bg-emerald-500 hover:text-white", children: "Mark redeemed" })] })), (o.status === "dismissed" || o.status === "expired") && (_jsx("button", { onClick: () => onUpdateStatus(o.id, "available"), className: "px-2 py-1 text-[11px] text-text-muted hover:text-text", children: "Restore" }))] })] })] }));
}
/* ------------------------------------------------------------------ */
/*  Status strip — per-portal readiness                                */
/* ------------------------------------------------------------------ */
/** localStorage key for portals the user has hidden (e.g. "I don't have
 *  an Amex card"). Stored as a JSON array of site_keys. Read on mount,
 *  written when the user clicks Hide / Show hidden. */
const HIDDEN_PORTALS_KEY = "offers.hiddenPortals";
function loadHiddenPortals() {
    try {
        const raw = localStorage.getItem(HIDDEN_PORTALS_KEY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
    }
    catch {
        return [];
    }
}
function saveHiddenPortals(keys) {
    try {
        localStorage.setItem(HIDDEN_PORTALS_KEY, JSON.stringify(keys));
    }
    catch {
        /* localStorage disabled — silently no-op rather than blow up */
    }
}
function StatusStrip() {
    const status = useQuery({
        queryKey: ["offersStatus"],
        queryFn: api.offersStatus,
    });
    // Hidden portals live in localStorage; we keep a state mirror so
    // the component re-renders when the user toggles visibility.
    const [hidden, setHidden] = useState(() => loadHiddenPortals());
    function hide(siteKey) {
        const next = Array.from(new Set([...hidden, siteKey]));
        setHidden(next);
        saveHiddenPortals(next);
    }
    function showAll() {
        setHidden([]);
        saveHiddenPortals([]);
    }
    if (status.isLoading) {
        return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-4 p-3", children: [_jsx("div", { className: "h-3 w-32 bg-slate-200 rounded animate-pulse mb-2" }), _jsx("div", { className: "h-3 w-2/3 bg-slate-200 rounded animate-pulse" })] }));
    }
    if (!status.data)
        return null;
    const visiblePortals = status.data.portals.filter((p) => !hidden.includes(p.site_key));
    // Edge case: if the user hides every portal, the strip would be a
    // bare header. Show a tiny "Show all" prompt instead.
    if (visiblePortals.length === 0) {
        return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-4 p-3 flex items-center gap-3 text-xs text-text-muted", children: [_jsx("span", { children: "All portals hidden." }), _jsx("button", { onClick: showAll, className: "text-brand hover:underline font-semibold", children: "Show all \u2192" })] }));
    }
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-4 p-3", children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Scraper readiness" }), hidden.length > 0 && (_jsxs("button", { onClick: showAll, className: "text-[11px] text-text-muted hover:text-brand", children: ["Show ", hidden.length, " hidden \u2192"] }))] }), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-2 text-xs", children: visiblePortals.map((p) => (_jsxs("div", { className: "flex flex-col gap-1 p-2 border border-border rounded bg-slate-50/40", children: [_jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsx("span", { className: "font-semibold text-text", children: p.name }), p.auth_state_present ? (_jsxs("span", { className: "text-emerald-700 text-[11px] font-semibold inline-flex items-center gap-1", children: [_jsx("span", { className: "inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" }), "Logged in", p.auth_state_age_days != null && ` (${p.auth_state_age_days}d ago)`] })) : (_jsxs("span", { className: "flex items-center gap-2", children: [_jsxs("span", { className: "text-rose-700 text-[11px] font-semibold inline-flex items-center gap-1", children: [_jsx("span", { className: "inline-block w-1.5 h-1.5 rounded-full bg-rose-500" }), "Auth missing"] }), _jsx("button", { onClick: () => hide(p.site_key), className: "text-[10px] text-text-soft hover:text-text-muted underline-offset-2 hover:underline", title: "Hide this portal \u2014 useful if you don't have an account", children: "I don't have this" })] }))] }), !p.auth_state_present && (
                        // Inline bootstrap guidance — copy-paste runnable, no
                        // hunting in MANUAL_TASKS.md. Click-to-copy makes it a
                        // one-keystroke flow.
                        _jsxs("div", { className: "text-[11px] text-text-muted", children: ["Run in your backend PowerShell (with venv active):", _jsx("code", { className: "block mt-1 bg-slate-100 text-slate-800 px-2 py-1 rounded font-mono select-all", children: p.bootstrap_command })] }))] }, p.site_key))) })] }));
}
/* ------------------------------------------------------------------ */
/*  Last scrape summary                                                 */
/* ------------------------------------------------------------------ */
function LastScrapeSummary({ result }) {
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-4 overflow-hidden", children: [_jsx("div", { className: "px-4 py-2 border-b border-border bg-emerald-50/40", children: _jsxs("h3", { className: "text-sm font-semibold text-text", children: ["Last scrape \u2014 ", result.matches.length, " matches \u00B7", " ", fmtCents(result.total_estimated_value_cents), " est/mo"] }) }), _jsx("div", { className: "px-4 py-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs", children: result.summaries.map((s) => (_jsxs("div", { className: "flex items-center justify-between gap-3 py-1", children: [_jsx("span", { className: "font-semibold text-text", children: s.name }), s.auth_missing ? (_jsx("span", { className: "text-warn font-semibold", children: "auth missing \u2014 re-login required" })) : s.error ? (_jsx("span", { className: "text-outflow truncate", title: s.error, children: s.error })) : (_jsxs("span", { className: "text-text-muted tabular-nums", children: [s.rows_seen, " seen \u00B7 ", s.rows_created, " new \u00B7 ", s.rows_updated, " updated"] }))] }, s.site_key))) })] }));
}
export default function OffersPanel() {
    const qc = useQueryClient();
    const [statusFilter, setStatusFilter] = useState("available");
    const [sourceFilter, setSourceFilter] = useState("all");
    const [expiryFilter, setExpiryFilter] = useState("any");
    const [lastScrape, setLastScrape] = useState(null);
    // Tracks which row's status update is in flight, so we can dim the
    // right buttons. Keyed by offer id.
    const [pendingMap, setPendingMap] = useState({});
    // Persistent list — fetched on mount, refetched on scrape success.
    const offers = useQuery({
        queryKey: ["offers", "all"],
        queryFn: () => api.listOffers(),
    });
    const status = useQuery({
        queryKey: ["offersStatus"],
        queryFn: api.offersStatus,
    });
    const scrape = useMutation({
        mutationFn: api.scrapeOffers,
        onSuccess: (r) => {
            setLastScrape(r);
            qc.invalidateQueries({ queryKey: ["offers"] });
            qc.invalidateQueries({ queryKey: ["offersStatus"] });
            qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
        },
    });
    const updateStatus = useMutation({
        mutationFn: ({ id, s }) => api.updateOfferStatus(id, s),
        onMutate: ({ id, s }) => {
            setPendingMap((m) => ({ ...m, [id]: s }));
        },
        onSettled: (_d, _e, vars) => {
            setPendingMap((m) => {
                const { [vars.id]: _drop, ...rest } = m;
                return rest;
            });
            qc.invalidateQueries({ queryKey: ["offers"] });
            qc.invalidateQueries({ queryKey: ["offersStatus"] });
        },
    });
    /* --- Derived view: apply filters client-side, since we already
     * fetched the full list. Filtering server-side would mean refetching
     * on every chip click. The list is small (rarely more than a few
     * dozen offers), so client-side is fine. --- */
    const all = offers.data ?? [];
    const filtered = all.filter((o) => {
        if (statusFilter !== "all" && o.status !== statusFilter)
            return false;
        if (sourceFilter !== "all" && o.source !== sourceFilter)
            return false;
        if (expiryFilter === "soon" &&
            (o.expires_in_days == null || o.expires_in_days < 0 || o.expires_in_days > 7))
            return false;
        return true;
    });
    // Counts for chip labels
    const counts = {
        all: all.length,
        available: 0,
        activated: 0,
        redeemed: 0,
        expired: 0,
        dismissed: 0,
    };
    for (const o of all)
        counts[o.status] += 1;
    const sourceCounts = {};
    for (const o of all)
        sourceCounts[o.source] = (sourceCounts[o.source] ?? 0) + 1;
    const expiringSoonCount = all.filter((o) => o.status === "available" &&
        o.expires_in_days != null &&
        o.expires_in_days >= 0 &&
        o.expires_in_days <= 7).length;
    const totalEstMonthly = all
        .filter((o) => o.status === "available")
        .reduce((sum, o) => sum + (o.estimated_value_cents ?? 0), 0);
    // Most-recent updated_at across all offers acts as our "last scrape"
    // anchor — there's no dedicated last_scraped_at on the OffersStatus
    // payload yet, but every scrape writes/updates rows, so the freshest
    // updated_at is a reliable proxy. Fed into the SyncFreshnessChip in
    // the hero so the user sees at a glance whether the pipeline is stale.
    const lastScrapeAt = all.length
        ? all.reduce((acc, o) => (o.updated_at > acc ? o.updated_at : acc), all[0].updated_at)
        : null;
    /* --- Empty-state copy varies by filter so it always tells the user
     * something useful — never just "Empty." --- */
    let emptyCopy = null;
    if (filtered.length === 0 && !offers.isLoading) {
        if (all.length === 0) {
            emptyCopy =
                "No offers in your library yet. Bootstrap a portal above (Chase or Amex) and hit Scrape now to pull live offers.";
        }
        else if (statusFilter === "available") {
            emptyCopy = "No available offers under this filter — try broadening below.";
        }
        else {
            emptyCopy = `No ${statusFilter} offers under this filter.`;
        }
    }
    return (_jsxs("div", { children: [_jsx(StatusStrip, {}), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-4 p-4 flex items-center gap-4 flex-wrap", children: [_jsxs("div", { className: "flex-1 min-w-[200px]", children: [_jsxs("div", { className: "flex items-center gap-3 flex-wrap", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Card offers pipeline" }), _jsx(SyncFreshnessChip, { syncedAt: lastScrapeAt, label: "Last scrape" })] }), _jsx("p", { className: "text-xs text-text-muted mt-0.5", children: status.data
                                    ? `${status.data.available_offers} available, ${status.data.activated_offers} activated, ${status.data.expiring_within_7_days} expiring within 7 days.`
                                    : "Loading status…" })] }), _jsxs("div", { className: "flex items-baseline gap-1 ml-auto", children: [_jsx("span", { className: "text-2xl font-semibold tabular-nums text-warn", children: fmtCents(totalEstMonthly) }), _jsx("span", { className: "text-xs text-text-muted", children: "est/mo on the table" })] }), _jsx("button", { onClick: () => scrape.mutate(), disabled: scrape.isPending, className: "px-4 py-2 text-sm font-semibold rounded bg-brand text-white hover:bg-brand-navy disabled:opacity-50", children: scrape.isPending ? "Scraping…" : "Scrape now" })] }), expiringSoonCount > 0 && expiryFilter !== "soon" && (_jsxs("div", { className: "bg-amber-50 border border-amber-200 rounded-md mb-4 p-3 flex items-center gap-3 text-sm text-amber-900", children: [_jsxs("span", { className: "font-semibold", children: ["\u23F3 ", expiringSoonCount, " expiring soon"] }), _jsx("span", { className: "text-xs", children: "Available offers within 7 days \u2014 activate before they're gone." }), _jsx("button", { onClick: () => {
                            setExpiryFilter("soon");
                            setStatusFilter("available");
                        }, className: "ml-auto px-3 py-1 text-xs font-semibold rounded border border-amber-400 text-amber-900 hover:bg-amber-100", children: "Show only these \u2192" })] })), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-4 p-3 space-y-2", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "text-[10px] uppercase font-semibold tracking-wide text-text-soft mr-1", children: "Status" }), ["all", "available", "activated", "redeemed", "expired", "dismissed"].map((s) => {
                                const active = statusFilter === s;
                                const n = counts[s];
                                return (_jsxs("button", { onClick: () => setStatusFilter(s), disabled: n === 0 && s !== "all" && !active, className: `px-2.5 py-1 text-xs rounded-full border capitalize transition-colors ${active
                                        ? "border-brand text-brand bg-brand/5 font-semibold"
                                        : "border-border text-text-muted hover:border-text-muted disabled:opacity-40 disabled:hover:border-border"}`, children: [s, " (", n, ")"] }, s));
                            })] }), _jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "text-[10px] uppercase font-semibold tracking-wide text-text-soft mr-1", children: "Portal" }), _jsx("button", { onClick: () => setSourceFilter("all"), className: `px-2.5 py-1 text-xs rounded-full border transition-colors ${sourceFilter === "all"
                                    ? "border-brand text-brand bg-brand/5 font-semibold"
                                    : "border-border text-text-muted hover:border-text-muted"}`, children: "All" }), Object.entries(sourceCounts).map(([src, n]) => (_jsxs("button", { onClick: () => setSourceFilter(src), className: `px-2.5 py-1 text-xs rounded-full border capitalize transition-colors ${sourceFilter === src
                                    ? "border-brand text-brand bg-brand/5 font-semibold"
                                    : "border-border text-text-muted hover:border-text-muted"}`, children: [src, " (", n, ")"] }, src))), _jsx("span", { className: "ml-auto text-[10px] uppercase font-semibold tracking-wide text-text-soft", children: "Expiry" }), _jsx("button", { onClick: () => setExpiryFilter("any"), className: `px-2.5 py-1 text-xs rounded-full border transition-colors ${expiryFilter === "any"
                                    ? "border-brand text-brand bg-brand/5 font-semibold"
                                    : "border-border text-text-muted hover:border-text-muted"}`, children: "Any" }), _jsxs("button", { onClick: () => setExpiryFilter("soon"), className: `px-2.5 py-1 text-xs rounded-full border transition-colors ${expiryFilter === "soon"
                                    ? "border-amber-400 text-amber-900 bg-amber-50 font-semibold"
                                    : "border-border text-text-muted hover:border-text-muted"}`, children: ["\u2264 7d (", expiringSoonCount, ")"] })] })] }), lastScrape && _jsx(LastScrapeSummary, { result: lastScrape }), offers.isLoading && _jsx(OfferSkeletonGrid, {}), !offers.isLoading && emptyCopy && (_jsx("div", { className: "bg-card border border-border rounded-md shadow-card p-6 text-center text-sm text-text-muted", children: emptyCopy })), !offers.isLoading && filtered.length > 0 && (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: filtered.map((o) => (_jsx(OfferCard, { o: o, onUpdateStatus: (id, s) => updateStatus.mutate({ id, s }), pendingStatus: pendingMap[o.id] ?? null }, o.id))) }))] }));
}
