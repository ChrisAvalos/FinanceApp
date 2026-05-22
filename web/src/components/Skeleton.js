import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function SkelBlock({ w = "w-full", h = "h-4", className = "", style }) {
    return (_jsx("div", { className: `bg-slate-200 rounded animate-pulse ${w} ${h} ${className}`, style: style }));
}
/** Text-line shimmer; default width 80% of parent. */
export function SkelLine({ width = "80%", height = "h-3", className = "", }) {
    return (_jsx("div", { className: `bg-slate-200 rounded animate-pulse ${height} ${className}`, style: { width } }));
}
/** A pre-shaped hero-stat card matching the panels' standard layout. */
export function SkelStat() {
    return (_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx(SkelLine, { width: "40%", height: "h-2", className: "mb-3" }), _jsx(SkelLine, { width: "60%", height: "h-7", className: "mb-2" }), _jsx(SkelLine, { width: "50%", height: "h-2" })] }));
}
/** Row of N hero stat cards (default 4) — drop-in for the standard
 *  4-card hero layout used on Overview / NetWorth / FIRE / MoT / etc. */
export function SkelHeroRow({ count = 4 }) {
    return (_jsx("div", { className: `grid grid-cols-2 md:grid-cols-${Math.min(count, 4)} gap-4 mb-5`, children: Array.from({ length: count }).map((_, i) => (_jsx(SkelStat, {}, i))) }));
}
/** A single row in a transaction-style table — defaults to 5 cols
 *  matching the main txns table (date / description / category /
 *  amount / source). */
export function SkelTableRow({ cols = 5, }) {
    // Variation in widths so the placeholder doesn't look mechanical.
    const widths = ["20%", "60%", "30%", "20%", "15%"];
    return (_jsx("tr", { className: "border-b border-border last:border-0", children: Array.from({ length: cols }).map((_, i) => (_jsx("td", { className: "px-4 py-3", children: _jsx(SkelLine, { width: widths[i % widths.length], height: "h-3" }) }, i))) }));
}
/** Shaped-like-a-list skeleton (e.g., for Money found cohort rows or
 *  Today's moves queue). Defaults to 5 rows. */
export function SkelListRows({ count = 5 }) {
    return (_jsx("div", { className: "bg-card border border-border rounded-md shadow-card divide-y divide-border", children: Array.from({ length: count }).map((_, i) => (_jsxs("div", { className: "flex items-center gap-3 px-4 py-3", children: [_jsx(SkelBlock, { w: "w-8", h: "h-8", className: "rounded-full" }), _jsxs("div", { className: "flex-1 space-y-1.5", children: [_jsx(SkelLine, { width: "60%", height: "h-3" }), _jsx(SkelLine, { width: "40%", height: "h-2" })] }), _jsx(SkelLine, { width: "80px", height: "h-3" })] }, i))) }));
}
