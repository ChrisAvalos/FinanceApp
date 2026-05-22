import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents, fmtMonthShort, } from "./api/client";
import { SkelHeroRow, SkelTableRow, SkelBlock } from "./components/Skeleton";
/* ------------------------------------------------------------------ */
/*  Category-share pie chart                                           */
/* ------------------------------------------------------------------ */
/**
 * Distinct slice colors. Cycled in order so categories at the same
 * rank across months keep stable colors. Beyond this list we fall
 * through to slate-400 ("other") — but with 12 entries we cover any
 * realistic category count for personal finance.
 *
 * Hex literals are used (not Tailwind class names) because we render
 * pies inside an inline SVG and `<path fill={...}>` needs a CSS color.
 */
const SLICE_COLORS = [
    "#10b981", // emerald-500
    "#3b82f6", // blue-500
    "#f59e0b", // amber-500
    "#ef4444", // rose/red-500
    "#8b5cf6", // violet-500
    "#14b8a6", // teal-500
    "#f97316", // orange-500
    "#ec4899", // pink-500
    "#6366f1", // indigo-500
    "#84cc16", // lime-500
    "#06b6d4", // cyan-500
    "#d946ef", // fuchsia-500
];
const OVERFLOW_COLOR = "#94a3b8"; // slate-400 — for the "Other" bucket
/** Build a single SVG arc path for one pie slice. cx/cy = center, r =
 *  radius. start/end are angles in radians, with 0 = 12 o'clock and
 *  positive = clockwise (matching how SVG renders rotations from -y). */
function describeSlice(cx, cy, r, start, end) {
    const startX = cx + r * Math.sin(start);
    const startY = cy - r * Math.cos(start);
    const endX = cx + r * Math.sin(end);
    const endY = cy - r * Math.cos(end);
    const largeArc = end - start > Math.PI ? 1 : 0;
    // Move to center, line out to slice start, arc to slice end, close back.
    return `M ${cx} ${cy} L ${startX} ${startY} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY} Z`;
}
/** One row of clickable pie slices. The selected month + selected
 *  slice are owned by the parent (CategorySharePie) so the drill-in
 *  panel below can sync its filter state. */
function PieSlices({ data, selectedCategoryId, onSliceClick, }) {
    const total = data.reduce((s, d) => s + d.cents, 0);
    if (total === 0) {
        return (_jsx("div", { className: "flex items-center justify-center w-[260px] h-[260px] text-sm text-text-soft", children: "No spend in this window." }));
    }
    let cum = 0;
    return (_jsx("svg", { viewBox: "0 0 220 220", width: 260, height: 260, "aria-label": "Spending by category", children: data.map((d) => {
            const start = (cum / total) * 2 * Math.PI;
            cum += d.cents;
            const end = (cum / total) * 2 * Math.PI;
            const isSelected = selectedCategoryId === d.category_id;
            // Selected slice gets a slight outward expansion via a larger
            // radius. We keep the math simple — same center, just bump r.
            const r = isSelected ? 100 : 95;
            const dim = selectedCategoryId !== "none" && !isSelected ? 0.35 : 1;
            const path = describeSlice(110, 110, r, start, end);
            const pct = ((d.cents / total) * 100).toFixed(1);
            return (_jsx("path", { d: path, fill: d.color, stroke: "white", strokeWidth: 2, opacity: dim, style: { cursor: "pointer", transition: "opacity 120ms ease, d 120ms ease" }, onClick: () => onSliceClick(d.category_id), children: _jsxs("title", { children: [d.category_name ?? "(uncategorized)", ": ", fmtCents(d.cents), " \u00B7 ", pct, "%"] }) }, String(d.category_id ?? "uncat")));
        }) }));
}
/** Aggregate the MoM data into a slice list for either a single month
 *  index or the cumulative window. Categories are ranked by descending
 *  cents; the long tail beyond SLICE_COLORS.length collapses into a
 *  single "Other" bucket so the chart never gets dozens of look-alike
 *  slivers. */
function buildSliceData(categories, monthIndex, monthsLength) {
    const totals = categories
        .map((c) => {
        const cents = monthIndex === "all"
            ? c.outflow_by_month_cents.reduce((s, v) => s + v, 0)
            : c.outflow_by_month_cents[monthIndex] ?? 0;
        return { category_id: c.category_id, category_name: c.category_name, cents };
    })
        .filter((c) => c.cents > 0)
        .sort((a, b) => b.cents - a.cents);
    // Suppress: avoid unused-var warning for monthsLength when "all".
    void monthsLength;
    if (totals.length <= SLICE_COLORS.length) {
        return totals.map((t, i) => ({ ...t, color: SLICE_COLORS[i] }));
    }
    const top = totals.slice(0, SLICE_COLORS.length - 1);
    const tail = totals.slice(SLICE_COLORS.length - 1);
    const otherCents = tail.reduce((s, t) => s + t.cents, 0);
    return [
        ...top.map((t, i) => ({ ...t, color: SLICE_COLORS[i] })),
        {
            category_id: null,
            category_name: `Other (${tail.length} categories)`,
            cents: otherCents,
            color: OVERFLOW_COLOR,
        },
    ];
}
/** YYYY-MM-01 → "May 26" for the month-picker pill labels. */
function fmtMonthPill(monthStart) {
    return fmtMonthShort(monthStart);
}
/** Determine a [start_date, end_date] window for the API filter when
 *  the user clicks a slice. "all" mode uses the full window from first
 *  month to last month; otherwise we use the selected month's range. */
function dateRangeFor(months, monthIndex) {
    if (months.length === 0)
        return null;
    if (monthIndex === "all") {
        const first = months[0].month_start;
        const last = months[months.length - 1].month_start;
        // Bump the end to the last day of the last month so the filter
        // includes transactions up to the panel's reporting cutoff.
        const lastDay = new Date(last);
        lastDay.setMonth(lastDay.getMonth() + 1);
        lastDay.setDate(0);
        return { start_date: first, end_date: lastDay.toISOString().slice(0, 10) };
    }
    const m = months[monthIndex];
    if (!m)
        return null;
    const startDate = m.month_start;
    const lastDay = new Date(startDate);
    lastDay.setMonth(lastDay.getMonth() + 1);
    lastDay.setDate(0);
    return { start_date: startDate, end_date: lastDay.toISOString().slice(0, 10) };
}
function CategorySharePie({ months, categories }) {
    // "all" = aggregate the whole window; number = a single month index.
    const [monthIndex, setMonthIndex] = useState("all");
    // category_id of the selected slice (or null for an uncategorized slice,
    // or "none" when nothing's selected — distinguishing null-the-id from
    // null-the-state matters here).
    const [selectedCat, setSelectedCat] = useState("none");
    const slices = useMemo(() => buildSliceData(categories, monthIndex, months.length), [categories, monthIndex, months.length]);
    const total = slices.reduce((s, d) => s + d.cents, 0);
    const range = dateRangeFor(months, monthIndex);
    // Drill-in transaction list — only fetches when the user has actually
    // clicked a slice. The catch-all "none" sentinel keeps the query off.
    const drillTxns = useQuery({
        queryKey: ["trendsPieDrill", monthIndex, selectedCat, range?.start_date, range?.end_date],
        queryFn: () => {
            if (selectedCat === "none" || !range)
                return Promise.resolve([]);
            return api.listTransactions({
                category_id: selectedCat ?? undefined,
                start_date: range.start_date,
                end_date: range.end_date,
                limit: 50,
            });
        },
        enabled: selectedCat !== "none" && !!range,
    });
    const selectedSlice = slices.find((s) => s.category_id === selectedCat);
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-5", children: [_jsxs("div", { className: "flex items-center justify-between flex-wrap gap-2 mb-3", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Category share \u2014 click a slice to drill in" }), _jsxs("span", { className: "text-xs text-text-muted tabular-nums", children: ["Total ", fmtCents(total)] })] }), _jsxs("div", { className: "flex items-center gap-1.5 flex-wrap mb-4", children: [_jsx("button", { onClick: () => {
                            setMonthIndex("all");
                            setSelectedCat("none");
                        }, className: `px-2.5 py-1 text-xs rounded-full border transition-colors ${monthIndex === "all"
                            ? "border-brand text-brand bg-brand/5 font-semibold"
                            : "border-border text-text-muted hover:border-text-muted"}`, children: "Overall" }), months.map((m, i) => (_jsx("button", { onClick: () => {
                            setMonthIndex(i);
                            setSelectedCat("none");
                        }, className: `px-2.5 py-1 text-xs rounded-full border transition-colors ${monthIndex === i
                            ? "border-brand text-brand bg-brand/5 font-semibold"
                            : "border-border text-text-muted hover:border-text-muted"}`, children: fmtMonthPill(m.month_start) }, m.month_start)))] }), _jsxs("div", { className: "flex items-start gap-6 flex-wrap", children: [_jsx(PieSlices, { data: slices, selectedCategoryId: selectedCat, onSliceClick: (cid) => setSelectedCat((prev) => (prev === cid ? "none" : cid)) }), _jsxs("div", { className: "flex-1 min-w-[260px] space-y-1", children: [slices.length === 0 && (_jsx("div", { className: "text-sm text-text-muted", children: "No spend in this window \u2014 pick a different month or run categorization." })), slices.map((s) => {
                                const pct = total > 0 ? ((s.cents / total) * 100).toFixed(1) : "0.0";
                                const isSelected = s.category_id === selectedCat;
                                return (_jsxs("button", { onClick: () => setSelectedCat((prev) => (prev === s.category_id ? "none" : s.category_id)), className: `w-full flex items-center gap-2 px-2 py-1 rounded text-left text-xs transition-colors ${isSelected ? "bg-hover" : "hover:bg-hover"}`, children: [_jsx("span", { className: "inline-block w-3 h-3 rounded-sm shrink-0", style: { background: s.color }, "aria-hidden": "true" }), _jsx("span", { className: `flex-1 truncate ${isSelected ? "font-semibold text-text" : "text-text-muted"}`, children: s.category_name ?? "(uncategorized)" }), _jsxs("span", { className: "tabular-nums text-text-soft", children: [pct, "%"] }), _jsx("span", { className: "tabular-nums text-text font-semibold w-20 text-right", children: fmtCents(s.cents) })] }, String(s.category_id ?? "uncat")));
                            })] })] }), selectedSlice && (_jsxs("div", { className: "mt-4 pt-4 border-t border-border", children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsxs("h4", { className: "text-sm font-semibold text-text", children: [_jsx("span", { className: "inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle", style: { background: selectedSlice.color } }), selectedSlice.category_name ?? "(uncategorized)", _jsxs("span", { className: "text-text-muted font-normal ml-2", children: ["\u00B7 ", monthIndex === "all" ? "All months" : fmtMonthPill(months[monthIndex].month_start), " · ", fmtCents(selectedSlice.cents)] })] }), _jsx("button", { onClick: () => setSelectedCat("none"), className: "text-xs text-text-muted hover:text-text", children: "Close \u00D7" })] }), drillTxns.isLoading && (_jsx("div", { className: "text-xs text-text-muted py-3", children: "Loading transactions\u2026" })), drillTxns.data && drillTxns.data.length === 0 && !drillTxns.isLoading && (_jsx("div", { className: "text-xs text-text-muted py-3 italic", children: "The slice value is from aggregated rollups; individual transactions weren't returned for this filter (the matcher uses category_id which can be null for the \"uncategorized\" slice \u2014 try a different slice or \"Overall\")." })), drillTxns.data && drillTxns.data.length > 0 && (_jsxs("div", { className: "overflow-x-auto -mx-2", children: [_jsxs("table", { className: "w-full text-xs", children: [_jsx("thead", { children: _jsxs("tr", { className: "text-text-muted uppercase tracking-wide text-[10px] font-semibold", children: [_jsx("th", { className: "px-2 py-1.5 text-left", children: "Date" }), _jsx("th", { className: "px-2 py-1.5 text-left", children: "Description" }), _jsx("th", { className: "px-2 py-1.5 text-right", children: "Amount" })] }) }), _jsx("tbody", { children: drillTxns.data.map((t) => (_jsxs("tr", { className: "border-t border-border hover:bg-hover", children: [_jsx("td", { className: "px-2 py-1.5 text-text-muted whitespace-nowrap", children: t.posted_date }), _jsx("td", { className: "px-2 py-1.5", children: t.description_raw }), _jsx("td", { className: `px-2 py-1.5 text-right tabular-nums font-semibold ${t.amount_cents < 0 ? "text-outflow" : "text-inflow"}`, children: fmtCents(t.amount_cents) })] }, t.id))) })] }), drillTxns.data.length === 50 && (_jsx("div", { className: "text-[11px] text-text-soft mt-2 italic", children: "Showing first 50 \u2014 open the Transactions panel for the full list with bulk actions." }))] }))] }))] }));
}
/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function trendLabel(pct) {
    if (pct == null)
        return { text: "—", cls: "text-text-soft" };
    if (Math.abs(pct) < 1)
        return { text: "flat", cls: "text-text-muted" };
    if (pct > 0)
        return { text: `+${pct.toFixed(1)}%`, cls: "text-outflow" };
    return { text: `${pct.toFixed(1)}%`, cls: "text-inflow" };
}
/* ------------------------------------------------------------------ */
/*  Mini bar chart — one row, N months                                 */
/* ------------------------------------------------------------------ */
function MiniBars({ series, maxAcross, }) {
    const max = Math.max(1, maxAcross);
    return (_jsx("div", { className: "flex items-end gap-0.5 h-8", children: series.map((v, i) => {
            const h = Math.max(2, (v / max) * 100);
            const latest = i === series.length - 1;
            return (_jsx("div", { className: `flex-1 rounded-sm ${latest ? "bg-brand" : "bg-brand/40"}`, style: { height: `${h}%` }, title: fmtCents(v) }, i));
        }) }));
}
/* ------------------------------------------------------------------ */
/*  Overall month totals chart                                         */
/* ------------------------------------------------------------------ */
function TotalsChart({ months }) {
    const max = Math.max(1, ...months.map((m) => m.outflow_cents));
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-5", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide mb-3", children: "Total outflow per month" }), _jsx("div", { className: "flex gap-3 h-32", children: months.map((m, i) => {
                    const h = (m.outflow_cents / max) * 100;
                    const latest = i === months.length - 1;
                    return (_jsxs("div", { className: "flex-1 flex flex-col items-center", children: [_jsx("div", { className: "w-full flex-1 flex items-end", children: _jsx("div", { className: `w-full rounded-t-sm ${latest ? "bg-brand" : "bg-brand/60"}`, style: { height: `${Math.max(2, h)}%` }, title: fmtCents(m.outflow_cents) }) }), _jsx("div", { className: "text-[10px] text-text-soft mt-1 tabular-nums", children: fmtMonthShort(m.month_start) }), _jsx("div", { className: "text-[10px] text-text font-semibold tabular-nums", children: fmtCents(m.outflow_cents) })] }, m.month_start));
                }) })] }));
}
/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */
const WINDOW_OPTIONS = [
    { label: "3 months", months: 3 },
    { label: "6 months", months: 6 },
    { label: "12 months", months: 12 },
];
/**
 * Percentage of the current calendar month that has elapsed.
 *
 * The "Latest vs. trailing avg" comparison is misleading on the 5th
 * of the month — partial-month outflow against full-month averages
 * makes everything look like a -83% drop. We surface this fraction
 * as an annotation so the user sees "Latest $592 (10% through month)"
 * and reads the % delta with appropriate context.
 */
function pctThroughCurrentMonth(now = new Date()) {
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    // Count today as fully consumed (a transaction posted today is in
    // the bucket already), so use day-of-month / total-days * 100 with
    // a +1 cap so the last day shows 100% rather than 96.7%.
    const dayOfMonth = now.getDate();
    return Math.min(100, Math.round((dayOfMonth / lastDay) * 100));
}
export default function TrendsPanel() {
    const [months, setMonths] = useState(6);
    const mom = useQuery({
        queryKey: ["mom", months],
        queryFn: () => api.monthOverMonth(months),
    });
    const monthsData = mom.data?.months ?? [];
    const categories = mom.data?.categories ?? [];
    const pctThroughMonth = pctThroughCurrentMonth();
    const isPartialMonth = pctThroughMonth < 100;
    // Biggest trend swings (absolute pct) — the "what's changing?" headline.
    const topSwings = useMemo(() => {
        return [...categories]
            .filter((c) => c.trend_pct_vs_avg != null && c.avg_outflow_cents > 500)
            .sort((a, b) => Math.abs(b.trend_pct_vs_avg ?? 0) - Math.abs(a.trend_pct_vs_avg ?? 0))
            .slice(0, 3);
    }, [categories]);
    return (_jsxs("div", { className: "space-y-6", children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("div", { children: _jsxs("p", { className: "text-xs text-text-muted", children: ["Outflow per category across the last ", months, " months. The rightmost bar in each row is the most recent (current) month \u2014 compare it against the average of the prior months to see what's moving."] }) }), _jsx("div", { className: "flex gap-1", children: WINDOW_OPTIONS.map((opt) => (_jsx("button", { onClick: () => setMonths(opt.months), className: `px-3 py-1.5 text-xs font-semibold rounded border transition-colors ${months === opt.months
                                ? "border-brand bg-brand text-white"
                                : "border-border bg-card text-text-muted hover:border-brand hover:text-brand"}`, children: opt.label }, opt.months))) })] }), mom.isLoading && (_jsxs(_Fragment, { children: [_jsx(SkelHeroRow, { count: 3 }), _jsx(SkelBlock, { h: "h-44", className: "rounded-md" })] })), topSwings.length > 0 && (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-4", children: topSwings.map((c) => {
                    const t = trendLabel(c.trend_pct_vs_avg);
                    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-4", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: c.category_name ?? "(uncategorized)" }), _jsxs("div", { className: "flex items-baseline gap-2 mt-1", children: [_jsx("span", { className: `text-2xl font-semibold ${t.cls}`, children: t.text }), _jsx("span", { className: "text-xs text-text-muted", children: "vs. trailing avg" })] }), _jsxs("div", { className: "text-xs text-text-soft mt-1", children: ["Latest", " ", _jsx("span", { className: "text-text font-semibold", children: fmtCents(c.outflow_by_month_cents.at(-1) ?? 0) }), " · ", "Avg ", fmtCents(c.avg_outflow_cents), isPartialMonth && (_jsxs("span", { className: "ml-1 italic text-text-soft", children: ["(", pctThroughMonth, "% through month)"] }))] })] }, `${c.category_id}-${c.category_name}`));
                }) })), monthsData.length > 0 && categories.length > 0 && (_jsx(CategorySharePie, { months: monthsData, categories: categories })), monthsData.length > 0 && _jsx(TotalsChart, { months: monthsData }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsxs("div", { className: "px-4 py-3 bg-hover border-b border-border", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "By category" }), _jsx("p", { className: "text-[11px] text-text-muted mt-0.5", children: "Biggest average spenders first. Click a row to see the numbers." })] }), _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left w-1/5", children: "Category" }), _jsxs("th", { className: "px-4 py-2 text-left w-1/3", children: [months, "-month trend"] }), _jsxs("th", { className: "px-4 py-2 text-right", children: ["Latest", isPartialMonth && (_jsxs("span", { className: "block text-[9px] font-normal italic text-text-soft normal-case", children: [pctThroughMonth, "% of month"] }))] }), _jsx("th", { className: "px-4 py-2 text-right", children: "Avg" }), _jsx("th", { className: "px-4 py-2 text-right", children: "vs. avg" })] }) }), _jsxs("tbody", { children: [mom.isLoading && Array.from({ length: 6 }).map((_, i) => (_jsx(SkelTableRow, { cols: 5 }, i))), mom.data && categories.length === 0 && (_jsx("tr", { children: _jsxs("td", { colSpan: 5, className: "p-8 text-center text-text-muted text-sm max-w-md mx-auto", children: ["No spending in the last ", months, " months. Either run categorization (most likely cause), import more transaction history, or pick a longer window above."] }) })), categories.map((c) => (_jsx(CategoryRow, { row: c }, `${c.category_id}-${c.category_name}`)))] })] })] })] }));
}
function CategoryRow({ row }) {
    const [open, setOpen] = useState(false);
    const t = trendLabel(row.trend_pct_vs_avg);
    const latest = row.outflow_by_month_cents.at(-1) ?? 0;
    const maxAcross = Math.max(...row.outflow_by_month_cents);
    return (_jsxs(_Fragment, { children: [_jsxs("tr", { onClick: () => setOpen((o) => !o), className: "border-b border-border last:border-0 hover:bg-hover cursor-pointer", children: [_jsx("td", { className: "px-4 py-3 text-sm font-medium", children: row.category_name ?? (_jsx("span", { className: "text-text-soft italic", children: "(uncategorized)" })) }), _jsx("td", { className: "px-4 py-3", children: _jsx(MiniBars, { series: row.outflow_by_month_cents, maxAcross: maxAcross }) }), _jsx("td", { className: "px-4 py-3 text-right tabular-nums text-sm font-semibold text-outflow", children: fmtCents(latest) }), _jsx("td", { className: "px-4 py-3 text-right tabular-nums text-sm text-text-muted", children: fmtCents(row.avg_outflow_cents) }), _jsx("td", { className: `px-4 py-3 text-right tabular-nums text-sm font-semibold ${t.cls}`, children: t.text })] }), open && (_jsx("tr", { className: "bg-hover/40", children: _jsx("td", { colSpan: 5, className: "px-4 py-3 text-xs text-text-muted", children: _jsx("div", { className: "flex gap-4 flex-wrap", children: row.outflow_by_month_cents.map((v, i) => (_jsxs("div", { className: "flex flex-col items-center min-w-[5rem]", children: [_jsxs("span", { className: "text-[10px] text-text-soft", children: ["#", i + 1] }), _jsx("span", { className: "tabular-nums font-semibold text-text", children: fmtCents(v) })] }, i))) }) }) }))] }));
}
