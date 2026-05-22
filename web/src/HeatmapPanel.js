import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Spending heatmap — Phase 9.4.
 *
 * GitHub-style calendar grid: one cell per day, color-shaded by
 * outflow. Reveals the patterns most apps don't surface: weekend vs
 * weekday contrast, "dry-run" days, biggest spend day, etc.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents } from "./api/client";
import PanelError from "./components/PanelError";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelBlock } from "./components/Skeleton";
const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function shadeFor(cents, max) {
    if (cents === 0)
        return "bg-slate-100";
    const ratio = Math.min(1, cents / Math.max(max, 1));
    if (ratio < 0.2)
        return "bg-emerald-100";
    if (ratio < 0.4)
        return "bg-emerald-200";
    if (ratio < 0.6)
        return "bg-emerald-400";
    if (ratio < 0.8)
        return "bg-emerald-600";
    return "bg-emerald-800";
}
function Cell({ d, max }) {
    const tooltip = `${d.on_date}\n${fmtCents(d.total_outflow_cents)} out · ${d.txn_count} txn${d.txn_count === 1 ? "" : "s"}`;
    return (_jsx("div", { className: `w-3 h-3 rounded-sm ${shadeFor(d.total_outflow_cents, max)} hover:ring-2 hover:ring-brand`, title: tooltip }));
}
function HeatGrid({ days }) {
    // Group by week (Monday start). Each column = a week.
    const max = Math.max(...days.map((d) => d.total_outflow_cents), 1);
    const weeks = [];
    let current = new Array(7).fill(null);
    let firstWeek = true;
    for (const d of days) {
        if (firstWeek) {
            // Pad start of first week with nulls if it doesn't begin on Monday
            current[d.day_of_week] = d;
            if (d.day_of_week === 6) {
                weeks.push(current);
                current = new Array(7).fill(null);
                firstWeek = false;
            }
        }
        else {
            current[d.day_of_week] = d;
            if (d.day_of_week === 6) {
                weeks.push(current);
                current = new Array(7).fill(null);
            }
        }
    }
    if (current.some((c) => c))
        weeks.push(current);
    return (_jsxs("div", { className: "flex gap-1", children: [_jsx("div", { className: "flex flex-col gap-1 pr-1 text-[9px] text-text-soft", children: DOW_LABELS.map((l) => _jsx("div", { className: "h-3", children: l }, l)) }), _jsx("div", { className: "flex gap-1 overflow-x-auto pb-1", children: weeks.map((w, wi) => (_jsx("div", { className: "flex flex-col gap-1", children: w.map((d, di) => d ? _jsx(Cell, { d: d, max: max }, di) : _jsx("div", { className: "w-3 h-3" }, di)) }, wi))) })] }));
}
export default function HeatmapPanel() {
    const [days, setDays] = useState(90);
    const heat = useQuery({ queryKey: ["heatmap", days], queryFn: () => api.heatmapDaily(days) });
    const stats = heat.data?.stats;
    const busiestDow = useMemo(() => stats ? DOW_LABELS[stats.busiest_day_of_week] : "—", [stats]);
    const quietestDow = useMemo(() => stats ? DOW_LABELS[stats.quietest_day_of_week] : "—", [stats]);
    return (_jsxs("div", { children: [heat.isLoading ? (_jsx(SkelHeroRow, { count: 4 })) : (_jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Busiest day" }), _jsx("div", { className: "text-2xl font-semibold mt-1 text-text", children: busiestDow }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: ["avg ", _jsx(CountUp, { value: stats?.busiest_dow_avg_cents ?? 0, format: fmtCents })] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Quietest day" }), _jsx("div", { className: "text-2xl font-semibold mt-1 text-text", children: quietestDow }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: ["avg ", _jsx(CountUp, { value: stats?.quietest_dow_avg_cents ?? 0, format: fmtCents })] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Weekend vs weekday" }), _jsxs("div", { className: "text-base font-semibold mt-1 text-text tabular-nums", children: [_jsx(CountUp, { value: stats?.weekend_avg_cents ?? 0, format: fmtCents }), " /", " ", _jsx(CountUp, { value: stats?.weekday_avg_cents ?? 0, format: fmtCents })] }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "avg per day" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Biggest single day" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-warn", children: _jsx(CountUp, { value: stats?.biggest_single_day_cents ?? 0, format: fmtCents }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: stats?.biggest_single_day || "—" })] })] })), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-4", children: [_jsxs("div", { className: "flex items-center justify-between mb-3", children: [_jsxs("h3", { className: "text-sm font-semibold text-text", children: ["Daily spend \u00B7", " ", _jsxs("span", { className: "text-text-muted font-normal", children: [stats?.days_with_spend ?? 0, " of ", stats?.total_days ?? 0, " days had spend"] })] }), _jsxs("select", { value: days, onChange: (e) => setDays(Number(e.target.value)), className: "px-2 py-1 text-xs border border-border rounded bg-card", children: [_jsx("option", { value: 30, children: "30 days" }), _jsx("option", { value: 90, children: "90 days" }), _jsx("option", { value: 180, children: "180 days" }), _jsx("option", { value: 365, children: "1 year" })] })] }), heat.isLoading ? (
                    // A wide rectangular skeleton roughly the size of the
                    // heatmap grid — keeps page height stable while the days
                    // query resolves.
                    _jsx(SkelBlock, { h: "h-24", className: "rounded-md" })) : heat.isError ? (_jsx(PanelError, { title: "Couldn't load the heatmap.", error: heat.error, onRetry: () => heat.refetch(), compact: true })) : (_jsx(HeatGrid, { days: heat.data?.days ?? [] })), _jsxs("div", { className: "flex items-center justify-end gap-2 mt-3 text-[11px] text-text-soft", children: [_jsx("span", { children: "Less" }), _jsx("div", { className: "w-3 h-3 rounded-sm bg-slate-100" }), _jsx("div", { className: "w-3 h-3 rounded-sm bg-emerald-100" }), _jsx("div", { className: "w-3 h-3 rounded-sm bg-emerald-200" }), _jsx("div", { className: "w-3 h-3 rounded-sm bg-emerald-400" }), _jsx("div", { className: "w-3 h-3 rounded-sm bg-emerald-600" }), _jsx("div", { className: "w-3 h-3 rounded-sm bg-emerald-800" }), _jsx("span", { children: "More" })] })] })] }));
}
