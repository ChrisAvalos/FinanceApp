import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Cash-flow forecast panel — Phase 7.2.
 *
 * Rolling N-day forecast: subscriptions + bills + paychecks + a
 * starting balance. Surfaces "crunch days" where the running balance
 * would drop below a threshold so Chris can pre-empt overdrafts.
 *
 * Visual: per-day chart with a running-balance line and event pins
 * + a list of upcoming events.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents } from "./api/client";
import PanelLoading from "./components/PanelLoading";
import PanelError from "./components/PanelError";
function fmtShortDate(iso) {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function BalanceChart({ daily, crunchDays }) {
    if (daily.length === 0)
        return null;
    const balances = daily.map((d) => d.running_balance_cents);
    const min = Math.min(0, ...balances);
    const max = Math.max(...balances, 0);
    const range = max - min || 1;
    const w = 800;
    const h = 160;
    const padX = 30;
    const innerW = w - padX * 2;
    const innerH = h - 30;
    const points = daily.map((d, i) => {
        const x = padX + (i / (daily.length - 1)) * innerW;
        const y = 10 + innerH - ((d.running_balance_cents - min) / range) * innerH;
        return { x, y, d };
    });
    const line = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    // Zero line
    const zeroY = 10 + innerH - ((0 - min) / range) * innerH;
    const crunchSet = new Set(crunchDays);
    return (_jsxs("svg", { viewBox: `0 0 ${w} ${h}`, className: "w-full h-40", children: [_jsx("line", { x1: padX, y1: zeroY, x2: w - padX, y2: zeroY, stroke: "#cbd5e1", strokeDasharray: "3 3" }), _jsx("polyline", { points: line, fill: "none", stroke: "#2563eb", strokeWidth: "2" }), points.map((p) => {
                const isCrunch = crunchSet.has(p.d.on_date);
                if (!isCrunch)
                    return null;
                return (_jsx("circle", { cx: p.x, cy: p.y, r: "4", fill: "#dc2626" }, p.d.on_date));
            }), _jsx("text", { x: padX, y: 10, fontSize: "10", fill: "#64748b", children: fmtCents(max) }), _jsx("text", { x: padX, y: h - 10, fontSize: "10", fill: "#64748b", children: fmtCents(min) })] }));
}
function EventRow({ e }) {
    const isOutflow = e.amount_cents < 0;
    return (_jsxs("li", { className: "flex items-center justify-between gap-2 px-3 py-2 border-b border-border last:border-0 text-xs", children: [_jsx("span", { className: "text-text-muted whitespace-nowrap w-20", children: fmtShortDate(e.on_date) }), _jsx("span", { className: "px-1.5 py-0.5 rounded-sm bg-slate-50 text-text-muted text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap", children: e.kind }), _jsx("span", { className: "flex-1 truncate", children: e.label }), _jsxs("span", { className: `tabular-nums font-semibold ${isOutflow ? "text-outflow" : "text-inflow"}`, children: [isOutflow ? "" : "+", fmtCents(e.amount_cents)] })] }));
}
export default function CashFlowPanel() {
    const [days, setDays] = useState(30);
    const forecast = useQuery({
        queryKey: ["cashFlowForecast", days],
        queryFn: () => api.cashFlowForecast(days),
    });
    const sortedEvents = useMemo(() => {
        return (forecast.data?.events ?? []).slice().sort((a, b) => a.on_date.localeCompare(b.on_date));
    }, [forecast.data]);
    if (forecast.isLoading) {
        return _jsx(PanelLoading, { label: "Loading cash-flow forecast\u2026" });
    }
    if (forecast.isError) {
        return (_jsx(PanelError, { title: "Couldn't compute cash-flow forecast.", error: forecast.error, onRetry: () => forecast.refetch() }));
    }
    if (!forecast.data)
        return null;
    const f = forecast.data;
    const crunch = f.crunch_days.length;
    return (_jsxs("div", { children: [_jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Starting balance" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: fmtCents(f.starting_balance_cents) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "As of today" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Forecast events" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: f.events.length }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: ["Across ", f.window_start, " \u2192 ", f.window_end] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Paycheck cadence" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: f.paycheck_cadence_days ? `${f.paycheck_cadence_days}d` : "—" }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: f.paycheck_cadence_confidence > 0 ? `${Math.round(f.paycheck_cadence_confidence * 100)}% confident` : "Need more history" })] }), _jsxs("div", { className: `bg-card border-2 ${crunch > 0 ? "border-outflow" : "border-border"} rounded-md p-4 shadow-card`, children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Crunch days" }), _jsx("div", { className: `text-2xl font-semibold tabular-nums mt-1 ${crunch > 0 ? "text-outflow" : "text-inflow"}`, children: crunch }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: crunch > 0 ? "Balance dips below threshold" : "No projected dips" })] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-5", children: [_jsxs("div", { className: "flex items-center justify-between px-4 py-2 border-b border-border bg-slate-50", children: [_jsxs("h3", { className: "text-sm font-semibold text-text", children: ["Running balance \u00B7 next ", days, " days"] }), _jsxs("select", { value: days, onChange: (e) => setDays(Number(e.target.value)), className: "px-2 py-1 text-xs border border-border rounded bg-card", children: [_jsx("option", { value: 14, children: "14 days" }), _jsx("option", { value: 30, children: "30 days" }), _jsx("option", { value: 60, children: "60 days" }), _jsx("option", { value: 90, children: "90 days" }), _jsx("option", { value: 180, children: "180 days" })] })] }), _jsxs("div", { className: "p-4", children: [_jsx(BalanceChart, { daily: f.daily, crunchDays: f.crunch_days }), _jsx("div", { className: "text-[11px] text-text-soft mt-1", children: "Red dots = days the running balance is projected to dip below the crunch threshold." })] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card", children: [_jsx("div", { className: "px-4 py-2 border-b border-border bg-slate-50", children: _jsxs("h3", { className: "text-sm font-semibold text-text", children: ["Upcoming events (", sortedEvents.length, ")"] }) }), sortedEvents.length === 0 ? (_jsxs("div", { className: "p-6 text-center text-sm text-text-muted", children: ["No forecast events in this window.", _jsxs("div", { className: "text-xs text-text-soft mt-2", children: ["Forecast events come from confirmed subscriptions and detected recurring bills. Run subscription detection on the", " ", _jsx("a", { href: "#subscriptions", className: "text-brand hover:underline", children: "Subscriptions panel" }), " ", "to populate this view."] })] })) : (_jsx("ul", { children: sortedEvents.map((e, i) => _jsx(EventRow, { e: e }, i)) }))] })] }));
}
