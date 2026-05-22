import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Card-benefits / use-it-or-lose-it credits panel — Phase 8.3.
 *
 * Most premium cards (Sapphire Reserve, Amex Platinum, etc.) bundle
 * annual credits — Uber, Saks, airline fee, dining, streaming. Most
 * users redeem ~30% of them. Net-after-fee math reveals whether the
 * card is *actually* paying for itself.
 *
 * The endpoint already does the math; the panel just renders one row
 * per card, ranked by net-after-fee desc, with a per-benefit breakdown
 * underneath each card.
 */
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents } from "./api/client";
import EmptyState from "./components/EmptyState";
import PanelError from "./components/PanelError";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelStat } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";
function NetTone({ cents }) {
    const tone = cents >= 0 ? "text-inflow" : "text-outflow";
    return (_jsxs("span", { className: `tabular-nums font-semibold ${tone}`, children: [cents >= 0 ? "+" : "", fmtCents(cents)] }));
}
function CardRow({ row }) {
    const net = row.net_after_fee_cents;
    return (_jsxs("div", { className: "border border-border rounded-md p-4 bg-card hover:shadow-card-hover", children: [_jsxs("div", { className: "flex items-start justify-between gap-3 mb-3", children: [_jsxs("div", { children: [_jsx("h4", { className: "text-sm font-semibold text-text", children: row.account_name }), _jsx("div", { className: "text-xs text-text-muted", children: row.profile_name })] }), _jsxs("div", { className: "text-right", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Net / yr" }), _jsx("div", { className: "text-lg", children: _jsx(NetTone, { cents: net }) })] })] }), _jsxs("div", { className: "grid grid-cols-3 gap-3 text-xs mb-3 pb-3 border-b border-border", children: [_jsxs("div", { children: [_jsx("div", { className: "text-text-muted", children: "Annual fee" }), _jsx("div", { className: "text-text font-semibold tabular-nums", children: fmtCents(-row.annual_fee_cents) })] }), _jsxs("div", { children: [_jsx("div", { className: "text-text-muted", children: "Credit value" }), _jsx("div", { className: "text-inflow font-semibold tabular-nums", children: fmtCents(row.total_credit_value_cents) })] }), _jsxs("div", { children: [_jsx("div", { className: "text-text-muted", children: "Benefits" }), _jsx("div", { className: "text-text font-semibold tabular-nums", children: row.benefits.length })] })] }), _jsx("ul", { className: "space-y-1.5 text-xs", children: row.benefits.map((b, i) => (_jsxs("li", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("span", { className: "font-semibold text-text", children: b.name }), b.cadence && _jsxs("span", { className: "ml-1 text-text-soft", children: ["\u00B7 ", b.cadence] }), b.notes && _jsx("p", { className: "text-text-muted text-[11px] line-clamp-1", children: b.notes })] }), _jsx("span", { className: "tabular-nums text-inflow font-semibold", children: fmtCents(b.value_cents) }), b.activation_url && (_jsx("a", { href: b.activation_url, target: "_blank", rel: "noopener noreferrer", className: "text-brand hover:underline", children: "Activate" }))] }, i))) })] }));
}
export default function BenefitsPanel() {
    const report = useQuery({ queryKey: ["cardBenefits"], queryFn: api.cardBenefits });
    if (report.isLoading) {
        // Layout-shaped skeleton — hero row of 4 stats, then a few card-row
        // shells while the catalog match runs.
        return (_jsxs("div", { children: [_jsx(SkelHeroRow, { count: 4 }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: [_jsx(SkelStat, {}), _jsx(SkelStat, {}), _jsx(SkelStat, {}), _jsx(SkelStat, {})] })] }));
    }
    if (report.isError) {
        return (_jsx(PanelError, { title: "Couldn't load card benefits.", error: report.error, onRetry: () => report.refetch() }));
    }
    if (!report.data || report.data.rows.length === 0) {
        const unmatched = report.data?.unmatched_card_ids?.length ?? 0;
        return (_jsx(EmptyState, { emoji: "\uD83E\uDEAA", title: "No premium-card benefits configured", body: _jsxs(_Fragment, { children: ["We match Plaid account names against a catalog of premium cards (Sapphire Reserve, Amex Platinum, Capital One Venture X, etc.). Plaid often returns generic names like \"CREDIT CARD\" \u2014 when that happens we can't match.", unmatched > 0 && (_jsxs("div", { className: "mt-2", children: [_jsxs("strong", { children: [unmatched, " card", unmatched === 1 ? "" : "s"] }), " ", "unmatched. Open Bank connections, click Details on the card row, and confirm the institution + last-4 digits \u2014 then request a catalog add if your card isn't covered yet."] }))] }), ctaLabel: "Open Bank connections \u2192", ctaHref: "#connections" }));
    }
    const sorted = [...report.data.rows].sort((a, b) => b.net_after_fee_cents - a.net_after_fee_cents);
    return (_jsxs("div", { children: [_jsx("div", { className: "flex justify-end mb-2", children: _jsx(SyncFreshnessChip, { syncedAt: report.data.as_of, label: "Catalog refreshed" }) }), _jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Total credit value" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-inflow", children: _jsx(CountUp, { value: report.data.total_face_value_cents, format: fmtCents }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "If you use every credit" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Total annual fees" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-outflow", children: _jsx(CountUp, { value: -report.data.total_annual_fee_cents, format: fmtCents }) })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Net after fees" }), _jsx("div", { className: "text-2xl mt-1", children: _jsx(NetTone, { cents: report.data.net_potential_cents }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "If fully utilized" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Cards in catalog" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: _jsx(CountUp, { value: report.data.rows.length, format: (n) => String(Math.round(n)) }) }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: [report.data.unmatched_card_ids.length, " unmatched"] })] })] }), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: sorted.map((r) => _jsx(CardRow, { row: r }, r.account_id)) }), _jsx("p", { className: "mt-3 text-[11px] text-text-soft", children: "Net-after-fee assumes you actually use every credit. Most people use ~30% \u2014 calibrate each row against your real redemption rate before deciding to keep, downgrade, or cancel." })] }));
}
