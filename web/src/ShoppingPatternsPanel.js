import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Shopping patterns — Phase 10 Slice B.
 *
 * Two complementary views surfaced as tabs:
 *
 *   "Item-level patterns" — rows from the receipt-fed detector.
 *     Each row is "you buy Charmin every 6 weeks at Costco for $19.99".
 *     Empty until the user uploads a few receipts.
 *
 *   "Merchant rollup" — Plaid-fed monthly-spend snapshot per merchant.
 *     Empty until Plaid is connected. No DB writes; computed on demand.
 *
 * Both lean on the same insight: which of your spending is *predictable*
 * vs. ad-hoc? Predictable spend is a budgeting opportunity (e.g. "this is
 * your $180/mo Costco baseline; budget around it"); item-level
 * predictable is a deal-hunting opportunity (Slice D will scrape stores
 * for these specific items).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelTableRow } from "./components/Skeleton";
/* ------------------------------------------------------------------ */
/*  Status badge                                                        */
/* ------------------------------------------------------------------ */
function StatusBadge({ s }) {
    const map = {
        active: { label: "Active", cls: "bg-emerald-50 text-inflow" },
        inactive: { label: "Stale", cls: "bg-amber-50 text-warn" },
        dismissed: { label: "Dismissed", cls: "bg-slate-100 text-text-soft" },
    };
    const m = map[s];
    return _jsx("span", { className: `px-1.5 py-0.5 rounded-sm ${m.cls} text-[10px] font-semibold uppercase tracking-wide`, children: m.label });
}
function ConfidencePill({ c }) {
    let cls = "bg-slate-100 text-text-muted";
    let label = "low";
    if (c >= 0.75) {
        cls = "bg-emerald-50 text-inflow";
        label = "high";
    }
    else if (c >= 0.5) {
        cls = "bg-sky-50 text-sky-700";
        label = "medium";
    }
    return (_jsx("span", { className: `px-1.5 py-0.5 rounded-sm ${cls} text-[10px] font-semibold uppercase tracking-wide`, title: `${Math.round(c * 100)}% confidence`, children: label }));
}
function fmtRelDate(iso) {
    if (!iso)
        return "—";
    const d = new Date(iso);
    const days = Math.round((Date.now() - d.getTime()) / (24 * 3600 * 1000));
    if (days < 0)
        return `in ${-days}d`;
    if (days === 0)
        return "today";
    if (days === 1)
        return "yesterday";
    if (days < 30)
        return `${days}d ago`;
    if (days < 365)
        return `${Math.round(days / 30)}mo ago`;
    return `${(days / 365).toFixed(1)}y ago`;
}
/* ------------------------------------------------------------------ */
/*  Pattern row (item-level)                                            */
/* ------------------------------------------------------------------ */
function PatternRow({ r, onPatch, onDelete, }) {
    const [editing, setEditing] = useState(false);
    const [draftName, setDraftName] = useState(r.canonical_name);
    return (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-3 py-2", children: _jsx(StatusBadge, { s: r.status }) }), _jsx("td", { className: "px-3 py-2", children: editing ? (_jsxs("form", { className: "flex items-center gap-1", onSubmit: (e) => {
                        e.preventDefault();
                        if (draftName.trim() && draftName !== r.canonical_name) {
                            onPatch({ canonical_name: draftName.trim() });
                        }
                        setEditing(false);
                    }, children: [_jsx("input", { autoFocus: true, value: draftName, onChange: (e) => setDraftName(e.target.value), className: "px-2 py-1 text-sm border border-border rounded w-full" }), _jsx("button", { type: "submit", className: "text-xs text-brand font-semibold", children: "Save" })] })) : (_jsxs("button", { onClick: () => setEditing(true), className: "text-left w-full", children: [_jsx("div", { className: "text-sm font-semibold text-text", children: r.canonical_name }), r.name_locked && _jsx("span", { className: "text-[10px] text-text-soft", children: "(renamed)" })] })) }), _jsx("td", { className: "px-3 py-2 text-xs text-text-muted", children: r.primary_merchant || "—" }), _jsx("td", { className: "px-3 py-2 text-xs text-text-muted", children: r.category || "—" }), _jsxs("td", { className: "px-3 py-2 text-xs", children: [_jsx("div", { className: "text-text", children: r.cadence_label || (r.cadence_days ? `every ${r.cadence_days}d` : "—") }), _jsxs("div", { className: "text-text-soft", children: [r.occurrence_count, "x logged"] })] }), _jsx("td", { className: "px-3 py-2 text-right text-sm tabular-nums", children: r.typical_line_total_cents != null ? fmtCents(r.typical_line_total_cents) : "—" }), _jsx("td", { className: "px-3 py-2 text-right text-sm tabular-nums font-semibold text-warn", children: r.annualized_cost_cents != null ? fmtCents(r.annualized_cost_cents) : "—" }), _jsxs("td", { className: "px-3 py-2 text-xs text-text-muted whitespace-nowrap", children: [fmtRelDate(r.last_purchased_at), r.next_expected_at && (_jsxs("div", { className: "text-text-soft", children: ["next ~", fmtRelDate(r.next_expected_at)] }))] }), _jsx("td", { className: "px-3 py-2", children: _jsx(ConfidencePill, { c: r.confidence_score }) }), _jsxs("td", { className: "px-3 py-2 text-right", children: [r.status !== "dismissed" && (_jsx("button", { onClick: () => onPatch({ status: "dismissed" }), className: "text-[11px] text-text-muted hover:text-outflow", children: "Dismiss" })), r.status === "dismissed" && (_jsx("button", { onClick: () => onPatch({ status: "active" }), className: "text-[11px] text-brand hover:underline", children: "Restore" })), _jsx("button", { onClick: () => { if (confirm(`Delete "${r.canonical_name}"?`))
                            onDelete(); }, className: "ml-2 text-[11px] text-text-muted hover:text-outflow", children: "Del" })] })] }));
}
/* ------------------------------------------------------------------ */
/*  Merchant rollup row                                                 */
/* ------------------------------------------------------------------ */
function MerchantRow({ r }) {
    return (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsxs("td", { className: "px-3 py-2", children: [_jsx("div", { className: "text-sm font-semibold text-text", children: r.display_name }), _jsx("div", { className: "text-[11px] text-text-soft font-mono", children: r.merchant_key })] }), _jsx("td", { className: "px-3 py-2 text-xs text-text-muted", children: r.primary_category_name || "—" }), _jsx("td", { className: "px-3 py-2 text-right text-sm tabular-nums font-semibold text-warn", children: fmtCents(r.monthly_avg_cents) }), _jsx("td", { className: "px-3 py-2 text-right text-sm tabular-nums", children: fmtCents(r.median_per_visit_cents) }), _jsx("td", { className: "px-3 py-2 text-right text-sm tabular-nums", children: r.transaction_count }), _jsx("td", { className: "px-3 py-2 text-xs text-text-muted", children: r.cadence_days ? `every ${r.cadence_days}d` : "—" }), _jsx("td", { className: "px-3 py-2 text-xs text-text-muted", children: fmtRelDate(r.last_seen) }), _jsx("td", { className: "px-3 py-2 text-right text-sm tabular-nums", children: fmtCents(r.total_lifetime_cents) })] }));
}
export default function ShoppingPatternsPanel() {
    const qc = useQueryClient();
    const [tab, setTab] = useState("items");
    const [showDismissed, setShowDismissed] = useState(false);
    const patterns = useQuery({ queryKey: ["recurringPurchases"], queryFn: () => api.listRecurringPurchases() });
    const rollup = useQuery({ queryKey: ["merchantRollup"], queryFn: () => api.merchantRollup(365) });
    const invalidate = () => qc.invalidateQueries({ queryKey: ["recurringPurchases"] });
    const detect = useMutation({
        mutationFn: api.detectRecurringPurchases,
        onSuccess: invalidate,
    });
    const patch = useMutation({
        mutationFn: ({ id, p }) => api.patchRecurringPurchase(id, p),
        onSuccess: invalidate,
    });
    const destroy = useMutation({
        mutationFn: api.deleteRecurringPurchase,
        onSuccess: invalidate,
    });
    const visiblePatterns = useMemo(() => {
        const all = patterns.data ?? [];
        return showDismissed ? all : all.filter((p) => p.status !== "dismissed");
    }, [patterns.data, showDismissed]);
    const totalAnnualized = useMemo(() => visiblePatterns
        .filter((p) => p.status === "active")
        .reduce((s, p) => s + (p.annualized_cost_cents ?? 0), 0), [visiblePatterns]);
    const totalMonthly = useMemo(() => (rollup.data ?? []).reduce((s, r) => s + r.monthly_avg_cents, 0), [rollup.data]);
    const heroLoading = patterns.isLoading || rollup.isLoading;
    const activePatternCount = patterns.data?.filter((p) => p.status === "active").length ?? 0;
    return (_jsxs("div", { children: [heroLoading ? (_jsx(SkelHeroRow, { count: 4 })) : (_jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Recurring items" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: _jsx(CountUp, { value: activePatternCount, format: (n) => String(Math.round(n)) }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "From receipt history" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Annualized item spend" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-warn", children: _jsx(CountUp, { value: totalAnnualized, format: fmtCents }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "Sum across active patterns" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Tracked merchants" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: _jsx(CountUp, { value: rollup.data?.length ?? 0, format: (n) => String(Math.round(n)) }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "From Plaid history (last 12mo)" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Combined avg/month" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-warn", children: _jsx(CountUp, { value: totalMonthly, format: fmtCents }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "Sum of per-merchant 30-day averages (relative scale)" })] })] })), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-3", children: [_jsxs("div", { className: "flex items-center justify-between border-b border-border", children: [_jsxs("div", { className: "flex", children: [_jsx(TabBtn, { active: tab === "items", onClick: () => setTab("items"), label: "Item-level patterns", count: patterns.data?.filter((p) => p.status === "active").length ?? 0 }), _jsx(TabBtn, { active: tab === "merchants", onClick: () => setTab("merchants"), label: "Merchant rollup", count: rollup.data?.length ?? 0 })] }), _jsx("div", { className: "flex items-center gap-2 px-3 py-2", children: tab === "items" && (_jsxs(_Fragment, { children: [_jsxs("label", { className: "flex items-center gap-1.5 text-xs text-text-muted", children: [_jsx("input", { type: "checkbox", checked: showDismissed, onChange: (e) => setShowDismissed(e.target.checked) }), _jsx("span", { children: "Show dismissed" })] }), _jsx("button", { onClick: () => detect.mutate(), disabled: detect.isPending, className: "px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-brand hover:text-brand disabled:opacity-50", title: "Re-run the receipt-item detector + persist patterns", children: detect.isPending ? "Detecting…" : "Detect now" })] })) })] }), tab === "items" && (_jsx(ItemsTable, { patterns: visiblePatterns, isLoading: patterns.isLoading, onPatch: (id, p) => patch.mutate({ id, p }), onDelete: (id) => destroy.mutate(id) })), tab === "merchants" && (_jsx(MerchantsTable, { rows: rollup.data ?? [], isLoading: rollup.isLoading }))] }), _jsx("p", { className: "text-[11px] text-text-soft", children: "Item-level patterns come from receipts you've uploaded. Merchant rollup comes from your Plaid transaction history. Both feed Slice D \u2014 store-specific deal scrapers will watch the items + merchants you actually buy from for price drops." })] }));
}
function TabBtn({ active, onClick, label, count }) {
    return (_jsxs("button", { onClick: onClick, className: `px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap transition-colors ${active ? "text-brand border-b-2 border-brand -mb-px" : "text-text-muted border-b-2 border-transparent hover:text-text"}`, children: [label, _jsx("span", { className: `ml-1.5 inline-block px-1.5 py-0.5 rounded-full text-[10px] tabular-nums ${active ? "bg-brand text-white" : "bg-hover text-text-muted"}`, children: count })] }));
}
function ItemsTable({ patterns, isLoading, onPatch, onDelete, }) {
    return (_jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-3 py-2 text-left", children: "Status" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Item" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Merchant" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Category" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Cadence" }), _jsx("th", { className: "px-3 py-2 text-right", children: "Per trip" }), _jsx("th", { className: "px-3 py-2 text-right", children: "Annual" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Last / Next" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Conf." }), _jsx("th", { className: "px-3 py-2 text-right" })] }) }), _jsxs("tbody", { children: [isLoading && Array.from({ length: 5 }).map((_, i) => _jsx(SkelTableRow, { cols: 10 }, i)), patterns.length === 0 && !isLoading && (_jsx("tr", { children: _jsxs("td", { colSpan: 10, className: "p-8 text-center text-sm text-text-muted max-w-md mx-auto", children: ["No recurring purchases detected yet. Upload \u2265 3 receipts with the same items spanning ~45 days, then hit", " ", _jsx("span", { className: "font-mono", children: "Detect now" }), ". The detector groups items by canonical product across receipts and only surfaces ones it sees you buy on a cadence."] }) })), patterns.map((p) => (_jsx(PatternRow, { r: p, onPatch: (patch) => onPatch(p.id, patch), onDelete: () => onDelete(p.id) }, p.id)))] })] }) }));
}
function MerchantsTable({ rows, isLoading }) {
    return (_jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-3 py-2 text-left", children: "Merchant" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Category" }), _jsx("th", { className: "px-3 py-2 text-right", children: "$/mo avg" }), _jsx("th", { className: "px-3 py-2 text-right", children: "Med/visit" }), _jsx("th", { className: "px-3 py-2 text-right", children: "Visits" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Cadence" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Last" }), _jsx("th", { className: "px-3 py-2 text-right", children: "Lifetime" })] }) }), _jsxs("tbody", { children: [isLoading && Array.from({ length: 5 }).map((_, i) => _jsx(SkelTableRow, { cols: 8 }, i)), rows.length === 0 && !isLoading && (_jsx("tr", { children: _jsx("td", { colSpan: 8, className: "p-8 text-center text-sm text-text-muted max-w-md mx-auto", children: "No merchants tracked. Connect Plaid + sync transactions first \u2014 the rollup needs \u2265 3 visits per merchant within the last year to qualify, so a merchant only appears once you have a real pattern there." }) })), rows.map((r) => _jsx(MerchantRow, { r: r }, r.merchant_key))] })] }) }));
}
