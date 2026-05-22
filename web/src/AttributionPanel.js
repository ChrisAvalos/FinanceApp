import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Net-worth attribution — Smart Feature #4.
 *
 * For each month in the last N, decomposes the change in net worth
 * into income, spending, and "other" (market gains/losses, interest
 * accrued, debt interest charged, manual balance adjustments).
 *
 * The shape of the answer is one row per month with a horizontal
 * bar chart showing the components, plus an expandable drill-in
 * surfacing the top spending categories that drove the outflow side.
 *
 * Months without NW snapshots at both endpoints render with a muted
 * "incomplete" label — cash flow is still computable from
 * transactions, but we can't separate market gains from the residual
 * without a starting balance.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents } from "./api/client";
/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function fmtSignedCents(c) {
    if (c === 0)
        return "$0";
    return `${c > 0 ? "+" : "−"}${fmtCents(Math.abs(c))}`;
}
/** Compact dollar string for the bar-segment labels. Skips decimals. */
function fmtCompact(cents) {
    const dollars = Math.round(cents / 100);
    if (Math.abs(dollars) >= 1_000_000)
        return `$${(dollars / 1_000_000).toFixed(1)}M`;
    if (Math.abs(dollars) >= 1_000)
        return `$${(dollars / 1000).toFixed(dollars >= 10_000 ? 0 : 1)}K`;
    return `$${dollars}`;
}
/* ------------------------------------------------------------------ */
/*  Per-month row with bar chart                                       */
/* ------------------------------------------------------------------ */
function MonthRow({ month, maxAbs, expanded, onToggle, }) {
    // Bar widths as % of the row's available width (split into two halves
    // around a centered zero — left for spending, right for income).
    const halfWidth = 50; // each half gets 50% of the available bar lane
    const incomePct = maxAbs > 0 ? (month.income_cents / maxAbs) * halfWidth : 0;
    const spendingPct = maxAbs > 0 ? (month.spending_cents / maxAbs) * halfWidth : 0;
    const otherPct = maxAbs > 0 && month.other_cents != null
        ? (Math.abs(month.other_cents) / maxAbs) * halfWidth
        : 0;
    const otherIsPositive = (month.other_cents ?? 0) >= 0;
    const isIncomplete = month.delta_cents === null;
    return (_jsxs("div", { className: `border-b border-border last:border-0 ${expanded ? "bg-hover" : ""}`, children: [_jsx("button", { onClick: onToggle, className: "w-full text-left px-4 py-3 hover:bg-hover transition-colors", children: _jsxs("div", { className: "flex items-center gap-4", children: [_jsxs("div", { className: "w-20 shrink-0", children: [_jsx("div", { className: "text-sm font-semibold text-text", children: month.month_label }), _jsxs("div", { className: "text-[10px] text-text-soft", children: [expanded ? "▾" : "▸", " drill in"] })] }), _jsxs("div", { className: "flex-1 min-w-0 relative h-7", children: [_jsx("div", { className: "absolute left-1/2 top-0 bottom-0 w-px bg-border" }), month.spending_cents > 0 && (_jsx("div", { className: "absolute right-1/2 top-1 bottom-1 bg-red-200 rounded-l flex items-center justify-end pr-1", style: { width: `${spendingPct}%` }, title: `Spending: ${fmtCents(month.spending_cents)}`, children: spendingPct > 8 && (_jsx("span", { className: "text-[10px] text-outflow font-semibold tabular-nums", children: fmtCompact(month.spending_cents) })) })), month.income_cents > 0 && (_jsx("div", { className: "absolute left-1/2 top-1 bottom-1 bg-emerald-200 rounded-r flex items-center justify-start pl-1", style: { width: `${incomePct}%` }, title: `Income: ${fmtCents(month.income_cents)}`, children: incomePct > 8 && (_jsx("span", { className: "text-[10px] text-inflow font-semibold tabular-nums", children: fmtCompact(month.income_cents) })) })), otherPct > 0 && month.other_cents != null && (_jsx("div", { className: `absolute top-1.5 bottom-1.5 rounded ${otherIsPositive ? "bg-violet-300" : "bg-amber-300"}`, style: {
                                        ...(otherIsPositive
                                            ? { left: `calc(50% + ${incomePct}%)` }
                                            : { right: `calc(50% + ${spendingPct}%)` }),
                                        width: `${otherPct}%`,
                                    }, title: `Other (market/interest): ${fmtSignedCents(month.other_cents)}` }))] }), _jsx("div", { className: "w-36 shrink-0 text-right", children: isIncomplete ? (_jsxs(_Fragment, { children: [_jsx("div", { className: "text-[11px] text-text-soft italic", children: "no snapshot" }), _jsxs("div", { className: "text-xs text-text-muted tabular-nums", children: ["cash flow: ", fmtSignedCents(month.net_cash_flow_cents)] })] })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: `text-sm font-semibold tabular-nums ${(month.delta_cents ?? 0) >= 0 ? "text-inflow" : "text-outflow"}`, children: ["\u0394 ", fmtSignedCents(month.delta_cents ?? 0)] }), _jsxs("div", { className: "text-[10px] text-text-soft tabular-nums leading-tight", children: ["cash ", fmtSignedCents(month.net_cash_flow_cents), month.debt_paydown_cents !== 0 && (_jsxs(_Fragment, { children: [" · debt ", _jsx("span", { className: "text-violet-700", children: fmtSignedCents(month.debt_paydown_cents) })] })), _jsx("br", {}), "other ", fmtSignedCents(month.other_cents ?? 0)] })] })) })] }) }), expanded && (_jsxs("div", { className: "px-4 pb-3 pl-24", children: [_jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-xs text-text-muted", children: [_jsxs("div", { children: [_jsx("span", { className: "text-text-soft", children: "Income:" }), " ", _jsxs("span", { className: "text-inflow tabular-nums", children: ["+", fmtCents(month.income_cents)] })] }), _jsxs("div", { children: [_jsx("span", { className: "text-text-soft", children: "Spending:" }), " ", _jsxs("span", { className: "text-outflow tabular-nums", children: ["\u2212", fmtCents(month.spending_cents)] }), _jsx("span", { className: "text-text-soft text-[10px] ml-1", children: "(excl. transfers)" })] }), month.debt_paydown_cents !== 0 && (_jsxs("div", { className: "md:col-span-2", children: [_jsx("span", { className: "text-text-soft", children: "Debt paydown (transfer rows, net):" }), " ", _jsx("span", { className: `tabular-nums ${month.debt_paydown_cents > 0
                                            ? "text-violet-700"
                                            : "text-warn"}`, children: fmtSignedCents(month.debt_paydown_cents) }), _jsx("div", { className: "text-[10px] text-text-soft mt-0.5", children: "Positive = net debt reduction. When this is non-zero, one side of a transfer (e.g., the credit-card account) isn't linked." })] })), month.nw_start_cents != null && (_jsxs("div", { children: [_jsx("span", { className: "text-text-soft", children: "NW at month start:" }), " ", _jsx("span", { className: "tabular-nums", children: fmtCents(month.nw_start_cents) })] })), month.nw_end_cents != null && (_jsxs("div", { children: [_jsx("span", { className: "text-text-soft", children: "NW at month end:" }), " ", _jsx("span", { className: "tabular-nums", children: fmtCents(month.nw_end_cents) })] })), month.other_cents != null && (_jsxs("div", { className: "md:col-span-2", children: [_jsx("span", { className: "text-text-soft", children: "Other (market gains, interest, manual adjustments):" }), " ", _jsx("span", { className: `tabular-nums ${month.other_cents >= 0 ? "text-violet-700" : "text-warn"}`, children: fmtSignedCents(month.other_cents) })] }))] }), month.top_spending_categories.length > 0 && (_jsxs("div", { className: "mt-3", children: [_jsx("div", { className: "text-[10px] uppercase tracking-wide text-text-soft mb-1", children: "Top spending categories" }), _jsx("div", { className: "space-y-0.5", children: month.top_spending_categories.map((c) => (_jsxs("div", { className: "flex justify-between text-xs text-text", children: [_jsxs("span", { children: [c.name, " ", _jsxs("span", { className: "text-text-soft", children: ["(", c.txn_count, ")"] })] }), _jsx("span", { className: "text-outflow tabular-nums", children: fmtCents(c.cents) })] }, c.name))) })] }))] }))] }));
}
/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */
export default function AttributionPanel() {
    const [months, setMonths] = useState(12);
    const [expanded, setExpanded] = useState(null);
    const report = useQuery({
        queryKey: ["netWorthAttribution", months],
        queryFn: () => api.netWorthAttribution(months),
        staleTime: 5 * 60 * 1000,
    });
    // Compute the max-absolute value across all rows so bar widths are
    // comparable across the full range. Use the larger of income, spending,
    // or |other| in any month to anchor the scale.
    const maxAbs = useMemo(() => {
        if (!report.data)
            return 1;
        let m = 0;
        for (const row of report.data.months) {
            m = Math.max(m, row.income_cents, row.spending_cents, Math.abs(row.other_cents ?? 0));
        }
        return m || 1;
    }, [report.data]);
    return (_jsxs("div", { children: [_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-5 mb-5", children: [_jsxs("div", { className: "flex items-start justify-between gap-4", children: [_jsxs("div", { className: "flex-1", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide font-semibold", children: "Why did net worth change?" }), _jsx("div", { className: "text-base text-text mt-2 leading-snug", children: report.data?.summary_text || "Loading attribution…" })] }), _jsxs("select", { value: months, onChange: (e) => setMonths(Number(e.target.value)), className: "px-2 py-1 text-xs border border-border rounded bg-card shrink-0", children: [_jsx("option", { value: 6, children: "Last 6 months" }), _jsx("option", { value: 12, children: "Last 12 months" }), _jsx("option", { value: 24, children: "Last 24 months" }), _jsx("option", { value: 36, children: "Last 36 months" })] })] }), _jsxs("div", { className: "flex flex-wrap items-center gap-4 mt-4 text-[11px] text-text-muted", children: [_jsxs("span", { className: "inline-flex items-center gap-1.5", children: [_jsx("span", { className: "w-3 h-3 bg-emerald-200 rounded-sm" }), "Income"] }), _jsxs("span", { className: "inline-flex items-center gap-1.5", children: [_jsx("span", { className: "w-3 h-3 bg-red-200 rounded-sm" }), "Spending"] }), _jsxs("span", { className: "inline-flex items-center gap-1.5", children: [_jsx("span", { className: "w-3 h-3 bg-violet-300 rounded-sm" }), "Market gains / other (positive)"] }), _jsxs("span", { className: "inline-flex items-center gap-1.5", children: [_jsx("span", { className: "w-3 h-3 bg-amber-300 rounded-sm" }), "Market losses / interest charged"] })] })] }), _jsx("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: report.isLoading ? (_jsx("div", { className: "p-12 text-center text-text-muted text-sm", children: "Computing attribution\u2026" })) : report.isError ? (_jsx("div", { className: "p-12 text-center text-outflow text-sm", children: "Couldn't load attribution." })) : report.data && report.data.months.length === 0 ? (_jsx("div", { className: "p-12 text-center text-text-muted text-sm", children: "No data yet." })) : (
                // Reverse so newest is on top. Filter out months that are fully
                // empty (no snapshot AND zero cash flow AND no top categories) —
                // they clutter the list with rows that say literally nothing.
                // Surface a footer count so users know they were collapsed.
                (() => {
                    const all = [...(report.data?.months ?? [])].reverse();
                    const empty = all.filter((m) => m.delta_cents == null &&
                        m.net_cash_flow_cents === 0 &&
                        (m.top_spending_categories?.length ?? 0) === 0);
                    const visible = all.filter((m) => !(m.delta_cents == null &&
                        m.net_cash_flow_cents === 0 &&
                        (m.top_spending_categories?.length ?? 0) === 0));
                    return (_jsxs(_Fragment, { children: [visible.map((m) => (_jsx(MonthRow, { month: m, maxAbs: maxAbs, expanded: expanded === m.month_start, onToggle: () => setExpanded((prev) => prev === m.month_start ? null : m.month_start) }, m.month_start))), empty.length > 0 && (_jsxs("div", { className: "px-4 py-2.5 text-[11px] text-text-soft border-t border-border bg-hover/40", children: [empty.length, " earlier month", empty.length === 1 ? "" : "s", " hidden \u2014 no activity recorded."] }))] }));
                })()) }), _jsx("div", { className: "text-[11px] text-text-soft mt-3", children: "\"Other\" is the residual after cash flow \u2014 market gains, interest accrued, debt interest charged, or manual balance adjustments. Months without snapshot data at both endpoints show cash flow only." })] }));
}
