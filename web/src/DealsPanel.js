import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Deals panel — Phase 10 Slice D.
 *
 * Three sections:
 *   1. Active deals (computed from PriceObservations).
 *   2. Manual price-entry form — pick a recurring pattern, enter
 *      merchant + price; the deal detector picks it up automatically
 *      on the next render.
 *   3. Recent observations table — every PriceObservation from the
 *      last 90 days.
 *
 * Plus a scraper-status strip at the top showing which stores are
 * auth-bootstrapped vs missing. Mirrors the Offers panel's banner.
 *
 * The "Scan now" button fans out across configured scrapers (today
 * all stubs return auth_missing). Manual entry is the always-works
 * path until per-store auth bootstrapping ships.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
/* ------------------------------------------------------------------ */
/*  Scraper status strip                                                */
/* ------------------------------------------------------------------ */
function ScraperStatusStrip() {
    const status = useQuery({
        queryKey: ["dealScraperStatus"],
        queryFn: api.dealScraperStatus,
    });
    if (!status.data)
        return null;
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-5", children: [_jsxs("div", { className: "px-4 py-2 border-b border-border bg-slate-50", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Scraper readiness" }), _jsx("p", { className: "text-[11px] text-text-soft", children: "Each store needs a one-time auth bootstrap before scraping starts. Until then, log prices manually below \u2014 the deal detector treats both paths identically." })] }), _jsx("div", { className: "grid grid-cols-2 md:grid-cols-5 gap-2 p-3", children: status.data.map((s) => (_jsxs("div", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: `w-2 h-2 rounded-full ${s.auth_missing ? "bg-warn" : "bg-inflow"}` }), _jsx("span", { className: "font-semibold text-text capitalize", children: s.name.replace("_", " ") }), _jsx("span", { className: "text-text-muted", children: s.auth_missing ? "needs auth" : "ready" })] }, s.name))) })] }));
}
/* ------------------------------------------------------------------ */
/*  Deal card                                                           */
/* ------------------------------------------------------------------ */
function DealCard({ d }) {
    return (_jsxs("div", { className: "border border-border rounded-md p-4 bg-card hover:shadow-card-hover", children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "px-1.5 py-0.5 rounded-sm bg-pink-50 text-pink-700 text-[10px] font-semibold uppercase tracking-wide", children: d.deal_merchant }), _jsx("h4", { className: "text-sm font-semibold text-text", children: d.pattern_name })] }), _jsxs("div", { className: "text-xs text-text-muted mt-1", children: [fmtCents(d.deal_price_cents), " at ", d.deal_merchant, _jsxs("span", { className: "ml-2 text-text-soft", children: ["vs your usual ", fmtCents(d.baseline_cents), d.pattern_merchant && ` at ${d.pattern_merchant}`] })] }), _jsxs("div", { className: "text-[11px] text-text-soft mt-1", children: ["Seen ", d.observed_at] })] }), _jsxs("div", { className: "text-right shrink-0", children: [_jsxs("div", { className: "text-base font-semibold tabular-nums text-warn", children: ["-", fmtCents(d.savings_cents)] }), _jsxs("div", { className: "text-[11px] text-warn", children: [Math.round(d.savings_pct * 100), "% off"] }), d.annual_savings_cents != null && (_jsxs("div", { className: "text-[11px] text-text-soft mt-1", children: ["~", fmtCents(d.annual_savings_cents), "/yr if you switch"] }))] })] }), d.product_url && (_jsx("div", { className: "mt-3", children: _jsx("a", { href: d.product_url, target: "_blank", rel: "noopener noreferrer", className: "px-3 py-1.5 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white", children: "See deal \u2192" }) }))] }));
}
/* ------------------------------------------------------------------ */
/*  Manual observation entry                                            */
/* ------------------------------------------------------------------ */
function ManualEntryForm({ patterns, onSaved, }) {
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState({
        pattern_id: "",
        merchant: "",
        price_dollars: "",
        observed_at: new Date().toISOString().slice(0, 10),
        product_url: "",
        notes: "",
        in_stock: true,
    });
    const create = useMutation({
        mutationFn: api.createDealObservation,
        onSuccess: () => {
            onSaved();
            setOpen(false);
            setForm({ ...form, merchant: "", price_dollars: "", product_url: "", notes: "" });
        },
    });
    if (patterns.length === 0) {
        return (_jsx("div", { className: "bg-card border border-border rounded-md p-4 text-sm text-text-muted", children: "No recurring purchases detected yet. Upload receipts on the Receipts panel + run \"Detect now\" on the Shopping panel to start tracking patterns. Manual price entry only works for items the app already knows you buy." }));
    }
    if (!open) {
        return (_jsx("button", { onClick: () => setOpen(true), className: "px-4 py-2 text-sm font-semibold rounded bg-brand text-white hover:bg-brand-navy", children: "+ Log a price observation" }));
    }
    return (_jsxs("form", { className: "border border-border rounded-md bg-card p-4 space-y-3", onSubmit: (e) => {
            e.preventDefault();
            const cents = Math.round(parseFloat(form.price_dollars) * 100);
            const pid = Number(form.pattern_id);
            if (!pid || Number.isNaN(cents) || cents <= 0 || !form.merchant.trim())
                return;
            create.mutate({
                recurring_purchase_id: pid,
                merchant: form.merchant.trim(),
                price_cents: cents,
                observed_at: form.observed_at,
                in_stock: form.in_stock,
                product_url: form.product_url.trim() || undefined,
                notes: form.notes.trim() || undefined,
            });
        }, children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsx("h4", { className: "text-sm font-semibold", children: "Log a price observation" }), _jsx("button", { type: "button", onClick: () => setOpen(false), className: "text-text-muted", children: "\u00D7" })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3 text-xs", children: [_jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Item *" }), _jsxs("select", { value: form.pattern_id, onChange: (e) => setForm({ ...form, pattern_id: e.target.value }), className: "w-full px-2 py-1.5 border border-border rounded bg-card", required: true, children: [_jsx("option", { value: "", children: "Pick a tracked item\u2026" }), patterns.map((p) => (_jsxs("option", { value: p.id, children: [p.canonical_name, p.primary_merchant && ` (usually ${p.primary_merchant})`] }, p.id)))] })] }), _jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Merchant *" }), _jsx("input", { value: form.merchant, onChange: (e) => setForm({ ...form, merchant: e.target.value }), placeholder: "Walmart / Target / etc.", className: "w-full px-2 py-1.5 border border-border rounded", required: true })] }), _jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Price ($) *" }), _jsx("input", { type: "number", step: 0.01, value: form.price_dollars, onChange: (e) => setForm({ ...form, price_dollars: e.target.value }), className: "w-full px-2 py-1.5 border border-border rounded", required: true })] }), _jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Date" }), _jsx("input", { type: "date", value: form.observed_at, onChange: (e) => setForm({ ...form, observed_at: e.target.value }), className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { className: "md:col-span-2", children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Product URL (optional)" }), _jsx("input", { type: "url", value: form.product_url, onChange: (e) => setForm({ ...form, product_url: e.target.value }), placeholder: "https://...", className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { className: "md:col-span-2", children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Notes" }), _jsx("input", { value: form.notes, onChange: (e) => setForm({ ...form, notes: e.target.value }), placeholder: "ad week, in-store only, etc.", className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("input", { type: "checkbox", checked: form.in_stock, onChange: (e) => setForm({ ...form, in_stock: e.target.checked }) }), _jsx("span", { children: "In stock" })] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("button", { type: "submit", disabled: create.isPending, className: "px-3 py-1.5 text-sm font-semibold rounded bg-brand text-white disabled:opacity-50", children: create.isPending ? "Saving…" : "Save" }), _jsx("button", { type: "button", onClick: () => setOpen(false), className: "px-3 py-1.5 text-sm text-text-muted", children: "Cancel" })] })] }));
}
/* ------------------------------------------------------------------ */
/*  Observations table                                                  */
/* ------------------------------------------------------------------ */
function ObservationsTable({ observations, patterns, onDelete, }) {
    const patternById = useMemo(() => Object.fromEntries(patterns.map((p) => [p.id, p])), [patterns]);
    return (_jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-3 py-2 text-left", children: "Date" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Item" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Merchant" }), _jsx("th", { className: "px-3 py-2 text-right", children: "Price" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Source" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Stock" }), _jsx("th", { className: "px-3 py-2 text-right" })] }) }), _jsxs("tbody", { children: [observations.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "p-6 text-center text-sm text-text-muted", children: "No observations yet. Log one above or run \"Scan now\" once a scraper is auth-ready." }) })), observations.map((o) => {
                            const p = patternById[o.recurring_purchase_id];
                            return (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-3 py-2 text-xs text-text-muted whitespace-nowrap", children: o.observed_at }), _jsx("td", { className: "px-3 py-2 text-sm", children: p?.canonical_name || `#${o.recurring_purchase_id}` }), _jsx("td", { className: "px-3 py-2 text-sm", children: o.merchant }), _jsx("td", { className: "px-3 py-2 text-right text-sm tabular-nums font-semibold", children: fmtCents(o.price_cents) }), _jsx("td", { className: "px-3 py-2 text-[11px] text-text-soft", children: o.source }), _jsx("td", { className: "px-3 py-2 text-[11px]", children: o.in_stock ? (_jsx("span", { className: "text-inflow", children: "in stock" })) : (_jsx("span", { className: "text-outflow", children: "out" })) }), _jsx("td", { className: "px-3 py-2 text-right", children: _jsx("button", { onClick: () => { if (confirm("Delete observation?"))
                                                onDelete(o.id); }, className: "text-[11px] text-text-muted hover:text-outflow", children: "Del" }) })] }, o.id));
                        })] })] }) }));
}
/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */
export default function DealsPanel() {
    const qc = useQueryClient();
    const deals = useQuery({ queryKey: ["deals"], queryFn: () => api.listDeals() });
    const patterns = useQuery({
        queryKey: ["recurringPurchasesActive"],
        queryFn: () => api.listRecurringPurchases({ status: "active" }),
    });
    const observations = useQuery({
        queryKey: ["dealObservations"],
        queryFn: () => api.listDealObservations({ limit: 200 }),
    });
    const [lastScrape, setLastScrape] = useState(null);
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ["deals"] });
        qc.invalidateQueries({ queryKey: ["dealObservations"] });
        qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
    };
    const scan = useMutation({
        mutationFn: api.scanDeals,
        onSuccess: (r) => {
            setLastScrape(r);
            invalidate();
        },
    });
    const destroy = useMutation({
        mutationFn: api.deleteDealObservation,
        onSuccess: invalidate,
    });
    const totalAnnualSavings = useMemo(() => (deals.data ?? []).reduce((s, d) => s + (d.annual_savings_cents ?? 0), 0), [deals.data]);
    return (_jsxs("div", { children: [_jsxs("div", { className: "grid grid-cols-2 md:grid-cols-3 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Active deals" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-warn", children: deals.data?.length ?? 0 }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "\u226515% below your typical" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Annual savings if you switch" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-warn", children: fmtCents(totalAnnualSavings) })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Observations logged" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: observations.data?.length ?? 0 })] })] }), _jsx(ScraperStatusStrip, {}), _jsxs("div", { className: "flex items-center gap-3 mb-4", children: [_jsx("button", { onClick: () => scan.mutate(), disabled: scan.isPending, className: "px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-brand hover:text-brand disabled:opacity-50", title: "Run all configured scrapers (today most return auth-missing)", children: scan.isPending ? "Scanning…" : "Scan now" }), _jsx(ManualEntryForm, { patterns: patterns.data ?? [], onSaved: invalidate })] }), lastScrape && (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-5 px-4 py-3 text-xs", children: [_jsxs("div", { className: "font-semibold mb-1", children: ["Scrape finished \u2014 ", lastScrape.total_observations_created, " new observation", lastScrape.total_observations_created === 1 ? "" : "s", " across ", lastScrape.patterns_scanned, " pattern", lastScrape.patterns_scanned === 1 ? "" : "s", "."] }), _jsx("div", { className: "grid grid-cols-2 md:grid-cols-5 gap-2", children: lastScrape.summaries.map((s) => (_jsxs("div", { className: "flex items-center justify-between text-text-muted", children: [_jsx("span", { className: "font-semibold capitalize", children: s.name.replace("_", " ") }), _jsx("span", { className: "tabular-nums", children: s.auth_missing ? "auth missing" : `${s.rows_created}/${s.queries_attempted}` })] }, s.name))) })] })), deals.data && deals.data.length > 0 && (_jsxs("div", { className: "mb-6", children: [_jsx("h3", { className: "text-sm font-semibold text-text mb-2", children: "Active deals" }), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: deals.data.map((d, i) => (_jsx(DealCard, { d: d }, `${d.pattern_id}-${d.deal_merchant}-${i}`))) })] })), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card", children: [_jsxs("div", { className: "px-4 py-2 border-b border-border bg-slate-50", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Recent observations" }), _jsx("p", { className: "text-[11px] text-text-soft", children: "Both manual entries and scraper hits land here \u2014 same table, same downstream deal logic." })] }), _jsx(ObservationsTable, { observations: observations.data ?? [], patterns: patterns.data ?? [], onDelete: (id) => destroy.mutate(id) })] }), _jsxs("p", { className: "mt-3 text-[11px] text-text-soft", children: ["Deals trigger when an observation is \u226515% below your typical price for that item. The \"Annual savings\" figure projects the per-trip savings \u00D7 purchase frequency. New deals also show up in ", _jsx("span", { className: "font-semibold", children: "Money on the table" }), " under the \"Cross-store deal\" source kind."] })] }));
}
