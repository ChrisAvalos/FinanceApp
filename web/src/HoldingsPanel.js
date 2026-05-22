import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Investment holdings panel — Phase 9.1.
 *
 * Empower-style portfolio view: total value, unrealized gain, allocation
 * by security type, top holdings table. Manual entry only for now;
 * Plaid investments sync uses the same shape.
 */
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents } from "./api/client";
import EmptyState from "./components/EmptyState";
import PanelError from "./components/PanelError";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelTableRow } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";
function GainCell({ cents, pct }) {
    if (cents == null)
        return _jsx("span", { className: "text-text-soft", children: "\u2014" });
    const tone = cents >= 0 ? "text-inflow" : "text-outflow";
    return (_jsxs("span", { className: `tabular-nums font-semibold ${tone}`, children: [cents >= 0 ? "+" : "", fmtCents(cents), pct != null && _jsxs("span", { className: "ml-1 text-[11px]", children: ["(", pct >= 0 ? "+" : "", pct.toFixed(1), "%)"] })] }));
}
function HoldingRow({ h }) {
    return (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-4 py-2 text-sm", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "font-mono font-semibold text-text", children: h.security_ticker || "—" }), _jsx("span", { className: "text-text-muted text-xs truncate", children: h.security_name })] }) }), _jsx("td", { className: "px-4 py-2 text-xs text-text-muted", children: h.security_type }), _jsx("td", { className: "px-4 py-2 text-right text-sm tabular-nums", children: h.quantity.toFixed(4) }), _jsx("td", { className: "px-4 py-2 text-right text-sm tabular-nums", children: h.latest_price_cents != null ? fmtCents(h.latest_price_cents) : "—" }), _jsx("td", { className: "px-4 py-2 text-right text-sm tabular-nums font-semibold", children: fmtCents(h.current_value_cents) }), _jsx("td", { className: "px-4 py-2 text-right text-sm", children: _jsx(GainCell, { cents: h.unrealized_gain_cents, pct: h.unrealized_gain_pct }) })] }));
}
export default function HoldingsPanel() {
    const portfolio = useQuery({ queryKey: ["portfolio"], queryFn: api.portfolio });
    if (portfolio.isLoading) {
        // Layout-shaped skeleton instead of a generic spinner — the page
        // stays stable when data arrives and the user can read what's
        // about to fill in.
        return (_jsxs("div", { children: [_jsx(SkelHeroRow, { count: 4 }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsx("div", { className: "px-4 py-2 border-b border-border bg-slate-50", children: _jsx("h3", { className: "text-sm font-semibold text-text", children: "Top holdings" }) }), _jsx("table", { className: "w-full", children: _jsx("tbody", { children: Array.from({ length: 6 }).map((_, i) => (_jsx(SkelTableRow, { cols: 6 }, i))) }) })] })] }));
    }
    if (portfolio.isError) {
        return (_jsx(PanelError, { title: "Couldn't load portfolio.", error: portfolio.error, onRetry: () => portfolio.refetch() }));
    }
    if (!portfolio.data || portfolio.data.holdings_count === 0) {
        return (_jsx(EmptyState, { emoji: "\uD83C\uDFE6", title: "No holdings yet", body: _jsxs(_Fragment, { children: ["Holdings populate automatically once your brokerage is linked via Plaid ", _jsx("span", { className: "font-mono", children: "investments" }), ". If your Plaid app hasn't been approved for that product yet, link your brokerage from Bank connections \u2014 Plaid grants the product when both the institution supports it AND your app is approved."] }), ctaLabel: "Open Bank connections \u2192", ctaHref: "#connections" }));
    }
    const p = portfolio.data;
    return (_jsxs("div", { children: [_jsx("div", { className: "flex justify-end mb-2", children: _jsx(SyncFreshnessChip, { syncedAt: p.as_of, label: "Plaid prices" }) }), _jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Total value" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: _jsx(CountUp, { value: p.total_value_cents, format: fmtCents }) })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Cost basis" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: _jsx(CountUp, { value: p.total_cost_basis_cents, format: fmtCents }) })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Unrealized gain" }), _jsx("div", { className: "text-2xl mt-1", children: _jsx(GainCell, { cents: p.total_unrealized_gain_cents, pct: p.total_unrealized_gain_pct }) })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Holdings" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: _jsx(CountUp, { value: p.holdings_count, format: (n) => String(Math.round(n)) }) }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: [p.accounts_count, " account", p.accounts_count === 1 ? "" : "s"] })] })] }), p.allocation_by_type.length > 0 && (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-5 p-4", children: [_jsx("h3", { className: "text-sm font-semibold text-text mb-3", children: "Allocation by type" }), _jsx("div", { className: "space-y-2", children: p.allocation_by_type.map((s) => (_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("span", { className: "text-xs text-text-muted w-24 capitalize", children: s.security_type }), _jsx("div", { className: "flex-1 h-2 bg-hover rounded overflow-hidden", children: _jsx("div", { className: "h-full bg-brand", style: { width: `${Math.min(100, s.pct)}%` } }) }), _jsx("span", { className: "text-xs tabular-nums text-text font-semibold w-24 text-right", children: fmtCents(s.total_value_cents) }), _jsxs("span", { className: "text-xs tabular-nums text-text-muted w-12 text-right", children: [s.pct.toFixed(1), "%"] })] }, s.security_type))) })] })), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsx("div", { className: "px-4 py-2 border-b border-border bg-slate-50", children: _jsx("h3", { className: "text-sm font-semibold text-text", children: "Top holdings" }) }), _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left", children: "Security" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Type" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Qty" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Price" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Value" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Gain" })] }) }), _jsx("tbody", { children: p.top_holdings.map((h) => _jsx(HoldingRow, { h: h }, h.id)) })] })] })] }));
}
