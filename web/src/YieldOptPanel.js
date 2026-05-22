import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Yield-arbitrage panel — Phase 8.4.
 *
 * Per-account analysis: how much you'd earn moving idle cash to a
 * top HYSA or T-bill. Each card shows current $/yr, the best
 * available alternative, and the dollar delta. Rows are split
 * into "qualifies for arb" (worth doing) vs "already optimal /
 * too small to bother."
 */
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents } from "./api/client";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelStat } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";
function ProductRow({ p }) {
    return (_jsxs("li", { className: "flex items-center justify-between gap-3 py-1.5 border-b border-border last:border-0 text-xs", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "font-semibold text-text", children: p.name }), _jsxs("span", { className: "text-text-muted", children: [p.apy_pct.toFixed(2), "% APY"] }), p.fdic_insured && _jsx("span", { className: "text-[10px] text-inflow font-semibold", children: "FDIC" })] }), p.notes && _jsx("p", { className: "text-text-soft text-[11px] line-clamp-1", children: p.notes })] }), _jsxs("div", { className: "text-right", children: [_jsx("div", { className: "tabular-nums text-text", children: fmtCents(p.yearly_earnings_at_balance_cents) }), _jsxs("div", { className: "text-[11px] text-inflow font-semibold tabular-nums", children: ["+", fmtCents(p.delta_vs_current_cents)] })] }), _jsx("a", { href: p.open_url, target: "_blank", rel: "noopener noreferrer", className: "text-brand text-xs hover:underline whitespace-nowrap", children: "Open \u2192" })] }));
}
function AccountCard({ a }) {
    const cls = a.qualifies_for_arb ? "border-warn" : "border-border";
    return (_jsxs("div", { className: `border-2 ${cls} rounded-md p-4 bg-card`, children: [_jsxs("div", { className: "flex items-start justify-between gap-3 mb-3", children: [_jsxs("div", { children: [_jsx("h4", { className: "text-sm font-semibold text-text", children: a.account.account_name }), _jsxs("div", { className: "text-xs text-text-muted", children: [fmtCents(a.account.balance_cents), " earning ", a.account.current_apy_pct.toFixed(2), "% (~", fmtCents(a.account.current_yearly_earnings_cents), "/yr)"] })] }), _jsxs("div", { className: "text-right", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Best delta" }), _jsxs("div", { className: `text-lg font-semibold tabular-nums ${a.qualifies_for_arb ? "text-warn" : "text-text-soft"}`, children: ["+", fmtCents(a.best_yearly_delta_cents), "/yr"] })] })] }), a.hysa_alternatives.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: "text-[10px] uppercase tracking-wide font-semibold text-text-muted mb-1", children: "HYSA options" }), _jsx("ul", { className: "mb-2", children: a.hysa_alternatives.map((p) => (_jsx(ProductRow, { p: p }, p.name))) })] })), a.tbill_alternatives.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: "text-[10px] uppercase tracking-wide font-semibold text-text-muted mb-1", children: "T-bill options" }), _jsx("ul", { children: a.tbill_alternatives.map((p) => (_jsx(ProductRow, { p: p }, p.name))) })] }))] }));
}
export default function YieldOptPanel() {
    const report = useQuery({ queryKey: ["yieldArb"], queryFn: api.yieldArbReport });
    if (report.isLoading) {
        // Hero skeleton + a couple of account-card skeletons. Beats a
        // generic "Loading…" — the page stays stable when data lands.
        return (_jsxs("div", { children: [_jsx(SkelHeroRow, { count: 3 }), _jsxs("div", { className: "grid grid-cols-1 gap-3", children: [_jsx(SkelStat, {}), _jsx(SkelStat, {})] })] }));
    }
    if (!report.data || report.data.accounts.length === 0) {
        return (_jsx("div", { className: "bg-card border border-border rounded-md p-6 text-center text-sm text-text-muted max-w-md mx-auto", children: "No liquid accounts found. Connect a checking or savings account via Plaid \u2014 yield-arb only fires on accounts holding \u2265 $1,000 in cash." }));
    }
    const qualifying = report.data.accounts.filter((a) => a.qualifies_for_arb);
    const sub_optimal = report.data.accounts.filter((a) => !a.qualifies_for_arb);
    return (_jsxs("div", { children: [_jsx("div", { className: "flex justify-end mb-2", children: _jsx(SyncFreshnessChip, { syncedAt: report.data.as_of, label: "FRED rates pulled" }) }), _jsxs("div", { className: "grid grid-cols-2 md:grid-cols-3 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Idle balance" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: _jsx(CountUp, { value: report.data.total_idle_balance_cents, format: fmtCents }) })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Potential gain \u00B7 1yr" }), _jsxs("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-warn", children: ["+", _jsx(CountUp, { value: report.data.total_yearly_potential_delta_cents, format: fmtCents })] }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "If you move qualifying balances" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Accounts" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: _jsx(CountUp, { value: report.data.accounts.length, format: (n) => String(Math.round(n)) }) }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: [qualifying.length, " qualify \u00B7 ", sub_optimal.length, " already optimal/small"] })] })] }), _jsx("div", { className: "mb-5 px-4 py-3 bg-brand-deep text-white rounded-md text-sm leading-relaxed", children: report.data.summary_text }), qualifying.length > 0 && (_jsxs(_Fragment, { children: [_jsx("h3", { className: "text-sm font-semibold text-warn uppercase tracking-wide mb-2", children: "Worth moving" }), _jsx("div", { className: "grid grid-cols-1 gap-3 mb-5", children: qualifying.map((a) => _jsx(AccountCard, { a: a }, a.account.account_id)) })] })), sub_optimal.length > 0 && (_jsxs(_Fragment, { children: [_jsx("h3", { className: "text-sm font-semibold text-text-muted uppercase tracking-wide mb-2", children: "Already optimal or too small to bother" }), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: sub_optimal.map((a) => _jsx(AccountCard, { a: a }, a.account.account_id)) })] }))] }));
}
