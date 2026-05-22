import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * FIRE / retirement projection — Smart Feature #2.
 *
 * Monte Carlo simulator with adjustable sliders. Backend runs 5,000
 * trials per request; we debounce the slider changes 250ms so the
 * user can drag freely without firing a request per pixel.
 *
 * The chart is a fan plot — five percentile bands (P10/25/50/75/90)
 * filled with progressively-darker brand color. The horizontal FIRE
 * target line is overlaid so the eye can see exactly when each band
 * crosses it. Done in inline SVG (same approach as NetWorthPanel) to
 * keep the dep graph small — no recharts/d3 needed.
 *
 * Default seed values are pulled from /api/fire/defaults (current net
 * worth, recent savings rate, last-12-month spend) so the panel works
 * out-of-the-box for users with linked accounts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
/* ------------------------------------------------------------------ */
/*  Tiny utilities                                                     */
/* ------------------------------------------------------------------ */
/** "$1.2M" / "$340K" / "$8,400" — no decimals on the big millions; one
 * decimal on hundreds-of-thousands so the chart axis numbers don't
 * collapse to "$1M / $1M / $2M". */
function fmtCompact(cents) {
    const dollars = cents / 100;
    if (Math.abs(dollars) >= 1_000_000) {
        return `$${(dollars / 1_000_000).toFixed(dollars >= 10_000_000 ? 0 : 1)}M`;
    }
    if (Math.abs(dollars) >= 1_000) {
        return `$${(dollars / 1000).toFixed(dollars >= 10_000 ? 0 : 1)}K`;
    }
    return `$${Math.round(dollars).toLocaleString()}`;
}
/** Debounce a value — used so we don't fire a Monte Carlo run on every
 * pixel as the user drags a slider. 250ms is the sweet spot between
 * "interactive" and "thrashing the backend". */
function useDebounced(value, delayMs) {
    const [out, setOut] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setOut(value), delayMs);
        return () => clearTimeout(t);
    }, [value, delayMs]);
    return out;
}
/* ------------------------------------------------------------------ */
/*  Fan chart — pure inline SVG                                        */
/* ------------------------------------------------------------------ */
function FanChart({ years, fireNumber, retirementAge, medianHitAge, }) {
    if (years.length < 2) {
        return (_jsx("div", { className: "text-xs text-text-soft text-center py-12", children: "Not enough projection data to plot." }));
    }
    // SVG canvas. Wide aspect for time-series readability.
    const W = 880;
    const H = 320;
    const PAD_L = 60; // y-axis labels
    const PAD_R = 12;
    const PAD_T = 12;
    const PAD_B = 28; // x-axis labels
    // Y range — encompass the highest p90 with a little headroom; floor
    // at 0 so the area below the x-axis isn't wasted on the empty
    // negative half-plane (we clip negatives in the simulator).
    const maxY = Math.max(fireNumber, ...years.map((y) => y.p90_cents)) * 1.05;
    const yScale = (cents) => PAD_T + (H - PAD_T - PAD_B) * (1 - cents / maxY);
    const xScale = (i) => PAD_L + ((W - PAD_L - PAD_R) * i) / (years.length - 1);
    // Build path strings for the upper and lower edges of each band.
    // Each band is an SVG <polygon>: trace upper edge L→R, then lower
    // edge R→L, close.
    function bandPath(upper, lower) {
        const upperPts = years.map((y, i) => `${xScale(i)},${yScale(y[upper])}`);
        const lowerPts = years
            .map((y, i) => `${xScale(i)},${yScale(y[lower])}`)
            .reverse();
        return [...upperPts, ...lowerPts].join(" ");
    }
    const linePath = (key) => years.map((y, i) => `${xScale(i)},${yScale(y[key])}`).join(" ");
    // X-axis ticks — label every ~10 years so it's readable.
    const xTicks = [];
    for (let i = 0; i < years.length; i++) {
        if (years[i].age % 10 === 0)
            xTicks.push(i);
    }
    if (xTicks.length === 0 || xTicks[xTicks.length - 1] !== years.length - 1) {
        xTicks.push(years.length - 1);
    }
    // Y-axis ticks — 5 evenly-spaced lines.
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxY);
    const fireY = yScale(fireNumber);
    const retirementIdx = years.findIndex((y) => y.age === retirementAge);
    const retirementX = retirementIdx >= 0 ? xScale(retirementIdx) : null;
    const medianHitIdx = medianHitAge !== null ? years.findIndex((y) => y.age === medianHitAge) : -1;
    const medianHitX = medianHitIdx >= 0 ? xScale(medianHitIdx) : null;
    return (_jsxs("svg", { viewBox: `0 0 ${W} ${H}`, className: "w-full h-80", children: [yTicks.map((v) => (_jsxs("g", { children: [_jsx("line", { x1: PAD_L, y1: yScale(v), x2: W - PAD_R, y2: yScale(v), stroke: "#e2e8f0", strokeWidth: "1", strokeDasharray: v === 0 ? "0" : "3 3" }), _jsx("text", { x: PAD_L - 6, y: yScale(v) + 4, textAnchor: "end", fontSize: "10", fill: "#64748b", children: fmtCompact(v) })] }, v))), _jsx("line", { x1: PAD_L, y1: H - PAD_B, x2: W - PAD_R, y2: H - PAD_B, stroke: "#cbd5e1", strokeWidth: "1" }), xTicks.map((i) => (_jsx("text", { x: xScale(i), y: H - PAD_B + 16, textAnchor: "middle", fontSize: "10", fill: "#64748b", children: years[i].age }, i))), _jsx("polygon", { points: bandPath("p90_cents", "p10_cents"), fill: "rgba(37, 99, 235, 0.10)" }), _jsx("polygon", { points: bandPath("p75_cents", "p25_cents"), fill: "rgba(37, 99, 235, 0.18)" }), _jsx("polyline", { points: linePath("p50_cents"), fill: "none", stroke: "#2563eb", strokeWidth: "2.5" }), _jsx("line", { x1: PAD_L, y1: fireY, x2: W - PAD_R, y2: fireY, stroke: "#16a34a", strokeWidth: "1.5", strokeDasharray: "6 4" }), _jsxs("text", { x: W - PAD_R - 6, y: fireY - 5, textAnchor: "end", fontSize: "10", fontWeight: "600", fill: "#16a34a", children: ["FIRE: ", fmtCompact(fireNumber)] }), retirementX !== null && (_jsxs("g", { children: [_jsx("line", { x1: retirementX, y1: PAD_T, x2: retirementX, y2: H - PAD_B, stroke: "#94a3b8", strokeWidth: "1", strokeDasharray: "2 4" }), _jsxs("text", { x: retirementX + 4, y: PAD_T + 11, fontSize: "10", fontWeight: "600", fill: "#475569", children: ["retire @ ", retirementAge] })] })), medianHitX !== null && (_jsxs("g", { children: [_jsx("circle", { cx: medianHitX, cy: fireY, r: "5", fill: "#16a34a" }), _jsx("circle", { cx: medianHitX, cy: fireY, r: "9", fill: "none", stroke: "#16a34a", strokeOpacity: "0.4", strokeWidth: "2" })] }))] }));
}
/** Hover layer for FanChart. Tracks the mouse, snaps to the nearest
 *  year, and renders a crosshair line + a tooltip showing age,
 *  calendar year (when known), and the percentile values at that x.
 *
 *  Lives outside the SVG so the tooltip can reflow with HTML — SVG
 *  text doesn't wrap. The crosshair line IS rendered via SVG (a thin
 *  absolutely-positioned overlay <svg>) so it lines up pixel-perfectly
 *  with the chart underneath.
 */
function FanChartHover({ years, fireNumber, }) {
    const containerRef = useRef(null);
    const [hoverIdx, setHoverIdx] = useState(null);
    if (years.length < 2)
        return null;
    // Mirror the chart's coordinate constants so our snapping is exact.
    // Keep these in sync with FanChart's PAD_*/W constants above.
    const W = 880;
    const PAD_L = 60;
    const PAD_R = 12;
    function onMouseMove(e) {
        if (!containerRef.current)
            return;
        const rect = containerRef.current.getBoundingClientRect();
        const xPx = e.clientX - rect.left;
        // Convert from pixel x to viewBox x (the SVG scales with width).
        const vbX = (xPx / rect.width) * W;
        if (vbX < PAD_L || vbX > W - PAD_R) {
            setHoverIdx(null);
            return;
        }
        const ratio = (vbX - PAD_L) / (W - PAD_L - PAD_R);
        const idx = Math.round(ratio * (years.length - 1));
        if (idx >= 0 && idx < years.length)
            setHoverIdx(idx);
    }
    function onMouseLeave() {
        setHoverIdx(null);
    }
    const hover = hoverIdx !== null ? years[hoverIdx] : null;
    // Compute viewbox coords for the crosshair when hovered. We keep the
    // same xScale math as FanChart for pixel parity.
    const xScale = (i) => PAD_L + ((W - PAD_L - PAD_R) * i) / (years.length - 1);
    const crosshairVbX = hoverIdx !== null ? xScale(hoverIdx) : null;
    // Tooltip horizontal placement, in % of container — so it tracks
    // alongside the crosshair and flips to the left when near the right
    // edge to avoid going off screen.
    const tooltipPctLeft = crosshairVbX !== null ? (crosshairVbX / W) * 100 : 0;
    const flipLeft = tooltipPctLeft > 70;
    return (_jsxs("div", { ref: containerRef, className: "absolute inset-0", onMouseMove: onMouseMove, onMouseLeave: onMouseLeave, style: { cursor: hover ? "crosshair" : "default" }, children: [crosshairVbX !== null && (_jsxs("svg", { viewBox: `0 0 ${W} 320`, className: "w-full h-full absolute inset-0 pointer-events-none", preserveAspectRatio: "none", children: [_jsx("line", { x1: crosshairVbX, y1: 12, x2: crosshairVbX, y2: 292, stroke: "#0f172a", strokeOpacity: "0.35", strokeWidth: "1", strokeDasharray: "3 3" }), _jsx("circle", { cx: crosshairVbX, cy: 12 +
                            (320 - 12 - 28) *
                                (1 -
                                    (hover?.p50_cents ?? 0) /
                                        (Math.max(fireNumber, ...years.map((y) => y.p90_cents)) *
                                            1.05)), r: "4", fill: "#117ACA", stroke: "white", strokeWidth: "1.5" })] })), hover && (_jsxs("div", { className: "absolute top-2 z-10 bg-card border border-border rounded-md shadow-card px-3 py-2 text-xs whitespace-nowrap", style: flipLeft
                    ? { right: `${100 - tooltipPctLeft}%`, marginRight: 8 }
                    : { left: `${tooltipPctLeft}%`, marginLeft: 8 }, children: [_jsxs("div", { className: "font-semibold text-text mb-1", children: ["Age ", hover.age] }), _jsxs("div", { className: "space-y-0.5 tabular-nums", children: [_jsxs("div", { className: "flex justify-between gap-3", children: [_jsx("span", { className: "text-text-soft", children: "P90 (best)" }), _jsx("span", { className: "text-text", children: fmtCents(hover.p90_cents) })] }), _jsxs("div", { className: "flex justify-between gap-3", children: [_jsx("span", { className: "text-text-soft", children: "Median" }), _jsx("span", { className: "text-brand font-semibold", children: fmtCents(hover.p50_cents) })] }), _jsxs("div", { className: "flex justify-between gap-3", children: [_jsx("span", { className: "text-text-soft", children: "P10 (worst)" }), _jsx("span", { className: "text-text", children: fmtCents(hover.p10_cents) })] })] }), hover.p50_cents >= fireNumber && (_jsx("div", { className: "mt-1 text-[10px] text-inflow font-semibold", children: "\u2713 Past FIRE number at the median" }))] }))] }));
}
/* ------------------------------------------------------------------ */
/*  Slider rows                                                        */
/* ------------------------------------------------------------------ */
function SliderRow({ label, value, min, max, step, onChange, format, hint, }) {
    return (_jsxs("div", { className: "mb-3", children: [_jsxs("div", { className: "flex items-baseline justify-between mb-1", children: [_jsx("label", { className: "text-xs font-semibold text-text-muted uppercase tracking-wide", children: label }), _jsx("span", { className: "text-sm font-semibold text-text tabular-nums", children: format(value) })] }), _jsx("input", { type: "range", min: min, max: max, step: step, value: value, onChange: (e) => onChange(Number(e.target.value)), className: "w-full accent-brand" }), hint && _jsx("div", { className: "text-[10px] text-text-soft mt-0.5", children: hint })] }));
}
/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */
export default function FirePanel() {
    // Pull defaults from the server so the page renders something
    // useful before the user touches a single slider.
    const defaults = useQuery({
        queryKey: ["fireDefaults"],
        queryFn: api.fireDefaults,
        staleTime: 5 * 60 * 1000,
        retry: false,
    });
    // Slider state — initialized to fixed sane values, then overridden
    // by /defaults once it lands. Local state means the slider is
    // responsive while the projection query debounces underneath.
    const [currentAge, setCurrentAge] = useState(32);
    const [retirementAge, setRetirementAge] = useState(55);
    const [startingCents, setStartingCents] = useState(50_000_00);
    const [monthlySavings, setMonthlySavings] = useState(2_000_00);
    const [annualSpending, setAnnualSpending] = useState(60_000_00);
    const [meanReturn, setMeanReturn] = useState(5.0);
    const [stdDev, setStdDev] = useState(15.0);
    // simulation_mode toggle. "normal" is fast IID Gaussian; "historical"
    // bootstraps real S&P sequences and surfaces sequence-of-returns risk.
    const [simulationMode, setSimulationMode] = useState("normal");
    // Optional pinned start year for historical mode — null means "random
    // bootstrap" (the default). Setting a year collapses the bands to a
    // single deterministic walk; useful for retire-into-1973 stress test.
    const [pinnedYear, setPinnedYear] = useState(null);
    // When defaults arrive, splice them in — but only if the user
    // hasn't moved a slider yet. We track this with a flag rather than
    // comparing values because legitimately matching values shouldn't
    // be treated as user-moved.
    const [touched, setTouched] = useState(false);
    useEffect(() => {
        if (defaults.data && !touched) {
            setStartingCents(defaults.data.starting_cents);
            setMonthlySavings(defaults.data.monthly_savings_cents);
            setAnnualSpending(defaults.data.annual_spending_cents);
        }
    }, [defaults.data, touched]);
    // Wrapper that marks "touched" so the autoload only happens once.
    const wrap = (fn) => (v) => {
        setTouched(true);
        fn(v);
    };
    // Debounce inputs so dragging the slider doesn't fire 60 simulations.
    const dCurrentAge = useDebounced(currentAge, 250);
    const dRetirementAge = useDebounced(retirementAge, 250);
    const dStartingCents = useDebounced(startingCents, 250);
    const dMonthlySavings = useDebounced(monthlySavings, 250);
    const dAnnualSpending = useDebounced(annualSpending, 250);
    const dMeanReturn = useDebounced(meanReturn, 250);
    const dStdDev = useDebounced(stdDev, 250);
    const dSimulationMode = useDebounced(simulationMode, 250);
    const dPinnedYear = useDebounced(pinnedYear, 250);
    const proj = useQuery({
        queryKey: [
            "fireProjection",
            dCurrentAge,
            dRetirementAge,
            dStartingCents,
            dMonthlySavings,
            dAnnualSpending,
            dMeanReturn,
            dStdDev,
            dSimulationMode,
            dPinnedYear,
        ],
        queryFn: () => api.fireProjection({
            current_age: dCurrentAge,
            target_retirement_age: dRetirementAge,
            starting_cents: dStartingCents,
            monthly_savings_cents: dMonthlySavings,
            annual_spending_cents: dAnnualSpending,
            mean_return_pct: dMeanReturn,
            std_dev_pct: dStdDev,
            // When pinned, 1 trial is enough (it's deterministic); otherwise
            // 5K for stable bands. Saves a bit of CPU on stress-test mode.
            n_trials: dPinnedYear !== null && dSimulationMode === "historical" ? 200 : 5_000,
            simulation_mode: dSimulationMode,
            historical_start_year: dSimulationMode === "historical" ? dPinnedYear : null,
        }),
        staleTime: 60_000,
        retry: false,
        // Keep prior data showing while the new request is in flight, so
        // the chart doesn't flicker to "Loading..." every time a slider
        // moves. Prior data is always close enough to be useful.
        placeholderData: (prev) => prev,
    });
    const data = proj.data;
    // Compute summary stats from data for the hero card.
    const fireNumber = data?.fire_number_cents ?? 0;
    const successProb = data?.success_probability_pct ?? null;
    const targetProb = data?.prob_hit_target_by_retirement_pct ?? null;
    const medianHitAge = data?.median_hit_age ?? null;
    const swr = data?.safe_withdrawal_rate_pct ?? null;
    const realizedMean = data?.realized_mean_return_pct ?? null;
    const yearsAhead = useMemo(() => Math.max(0, retirementAge - currentAge), [
        retirementAge,
        currentAge,
    ]);
    return (_jsxs("div", { children: [_jsxs("div", { className: "grid grid-cols-1 md:grid-cols-4 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-5 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "FIRE number (4% rule)" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-2 text-text", children: fmtCompact(fireNumber) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "25\u00D7 annual spending" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-5 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Median hit age" }), _jsx("div", { className: `text-2xl font-semibold tabular-nums mt-2 ${medianHitAge && medianHitAge <= retirementAge
                                    ? "text-inflow"
                                    : medianHitAge
                                        ? "text-warn"
                                        : "text-outflow"}`, children: medianHitAge ?? "—" }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: medianHitAge && medianHitAge <= retirementAge
                                    ? `${retirementAge - medianHitAge} yrs ahead of plan`
                                    : medianHitAge
                                        ? `${medianHitAge - retirementAge} yrs behind plan`
                                        : "Doesn't hit by simulation end" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-5 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Hit-target prob." }), _jsx("div", { className: `text-2xl font-semibold tabular-nums mt-2 ${targetProb === null
                                    ? "text-text-soft"
                                    : targetProb >= 75
                                        ? "text-inflow"
                                        : targetProb >= 50
                                            ? "text-warn"
                                            : "text-outflow"}`, children: targetProb === null ? "—" : `${targetProb.toFixed(0)}%` }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: ["of trials at FIRE by age ", retirementAge] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-5 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Safe withdrawal" }), _jsx("div", { className: `text-2xl font-semibold tabular-nums mt-2 ${swr === null
                                    ? "text-text-soft"
                                    : swr >= 4.0
                                        ? "text-inflow"
                                        : swr >= 3.0
                                            ? "text-warn"
                                            : "text-outflow"}`, children: swr === null ? "—" : `${swr.toFixed(2)}%` }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: successProb !== null
                                    ? `${successProb.toFixed(0)}% money lasts to age ${data?.years[data.years.length - 1].age ?? 95}`
                                    : "95%-survival rate" })] })] }), _jsxs("div", { className: "grid grid-cols-1 lg:grid-cols-3 gap-4 mb-5", children: [_jsxs("div", { className: "lg:col-span-2 bg-card border border-border rounded-md shadow-card p-5", children: [_jsxs("div", { className: "flex items-baseline justify-between mb-3", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Projected portfolio (real $)" }), _jsx("div", { className: "text-[11px] text-text-soft", children: "5K trials \u00B7 bands: 10/25/50/75/90 percentile" })] }), data ? (_jsxs("div", { className: "relative", children: [_jsx(FanChart, { years: data.years, fireNumber: fireNumber, retirementAge: retirementAge, medianHitAge: medianHitAge }), _jsx(FanChartHover, { years: data.years, fireNumber: fireNumber })] })) : proj.isLoading ? (_jsx("div", { className: "text-xs text-text-soft text-center py-12", children: "Running 5,000 trials\u2026" })) : (_jsx("div", { className: "text-xs text-outflow text-center py-12", children: String(proj.error?.message ?? "Failed to run simulation") })), data?.summary_text && (_jsx("div", { className: "text-xs text-text-muted mt-3 italic leading-snug", children: data.summary_text }))] }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-5", children: [_jsx("h3", { className: "text-sm font-semibold text-text mb-3", children: "Assumptions" }), _jsxs("div", { className: "mb-4", children: [_jsx("label", { className: "text-[10px] font-semibold text-text-muted uppercase tracking-wide block mb-1", children: "Simulation mode" }), _jsxs("div", { className: "flex border border-border rounded overflow-hidden text-xs", children: [_jsx("button", { onClick: () => setSimulationMode("normal"), className: `flex-1 px-2 py-1.5 transition-colors ${simulationMode === "normal"
                                                    ? "bg-brand text-white font-semibold"
                                                    : "bg-card text-text-muted hover:bg-hover"}`, children: "Gaussian" }), _jsx("button", { onClick: () => setSimulationMode("historical"), className: `flex-1 px-2 py-1.5 transition-colors border-l border-border ${simulationMode === "historical"
                                                    ? "bg-brand text-white font-semibold"
                                                    : "bg-card text-text-muted hover:bg-hover"}`, children: "Historical S&P" })] }), _jsx("div", { className: "text-[10px] text-text-soft mt-1 leading-snug", children: simulationMode === "normal"
                                            ? "IID Gaussian draws — fast; ignores sequence-of-returns risk."
                                            : `Bootstrap real S&P returns 1928–2023. Models sequence-of-returns risk.${realizedMean !== null
                                                ? ` Realized mean: ${realizedMean.toFixed(2)}%/yr.`
                                                : ""}` })] }), simulationMode === "historical" && (_jsxs("div", { className: "mb-4 -mt-1", children: [_jsx("label", { className: "text-[10px] font-semibold text-text-muted uppercase tracking-wide block mb-1", children: "Pinned start year (stress test)" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("select", { value: pinnedYear ?? "", onChange: (e) => {
                                                    const v = e.target.value;
                                                    setPinnedYear(v === "" ? null : Number(v));
                                                }, className: "flex-1 px-2 py-1 text-xs border border-border rounded bg-card", children: [_jsx("option", { value: "", children: "\u2014 random bootstrap (default) \u2014" }), _jsxs("optgroup", { label: "Famous bad sequences", children: [_jsx("option", { value: 1929, children: "1929 \u2014 Great Depression" }), _jsx("option", { value: 1966, children: "1966 \u2014 Lost decade for stocks" }), _jsx("option", { value: 1973, children: "1973 \u2014 '70s stagflation" }), _jsx("option", { value: 2000, children: "2000 \u2014 Dot-com bust" }), _jsx("option", { value: 2008, children: "2008 \u2014 GFC" })] }), _jsxs("optgroup", { label: "Famous good sequences", children: [_jsx("option", { value: 1949, children: "1949 \u2014 Post-WWII boom" }), _jsx("option", { value: 1982, children: "1982 \u2014 Reagan bull" }), _jsx("option", { value: 1995, children: "1995 \u2014 Late-90s tech" }), _jsx("option", { value: 2009, children: "2009 \u2014 Post-GFC recovery" })] })] }), pinnedYear !== null && (_jsx("button", { onClick: () => setPinnedYear(null), className: "text-[11px] text-text-soft hover:text-brand", children: "Clear" }))] }), _jsx("div", { className: "text-[10px] text-text-soft mt-1 leading-snug", children: pinnedYear === null
                                            ? "Random sampling across all years. Bands show distribution."
                                            : `Every trial walks forward from ${pinnedYear}. Bands collapse — this is the deterministic path.` })] })), _jsx(SliderRow, { label: "Current age", value: currentAge, min: 18, max: 80, step: 1, onChange: wrap(setCurrentAge), format: (v) => `${v} yrs` }), _jsx(SliderRow, { label: "Target retirement age", value: retirementAge, min: Math.max(currentAge + 1, 19), max: 85, step: 1, onChange: wrap(setRetirementAge), format: (v) => `${v} yrs`, hint: `${yearsAhead} years to accumulate` }), _jsx(SliderRow, { label: "Starting net worth", value: startingCents, min: 0, max: 5_000_000_00, step: 1_000_00, onChange: wrap(setStartingCents), format: fmtCompact, hint: !touched && defaults.data
                                    ? "auto-derived from your accounts — drag to override"
                                    : undefined }), _jsx(SliderRow, { label: "Monthly savings", value: monthlySavings, min: 0, max: 50_000_00, step: 100_00, onChange: wrap(setMonthlySavings), format: (v) => `${fmtCents(v)}/mo`, hint: !touched && defaults.data
                                    ? "from recent (income − spending) / 6"
                                    : `${fmtCents(monthlySavings * 12)}/yr` }), _jsx(SliderRow, { label: "Annual spending in retirement", value: annualSpending, min: 12_000_00, max: 300_000_00, step: 1_000_00, onChange: wrap(setAnnualSpending), format: fmtCompact, hint: `FIRE target = ${fmtCompact(annualSpending * 25)}` }), _jsx(SliderRow, { label: "Real return (post-inflation)", value: meanReturn, min: 1.0, max: 10.0, step: 0.1, onChange: wrap(setMeanReturn), format: (v) => `${v.toFixed(1)}%`, hint: "historical S&P 500 \u2248 5% real" }), _jsx(SliderRow, { label: "Volatility (std. dev.)", value: stdDev, min: 1.0, max: 30.0, step: 0.5, onChange: wrap(setStdDev), format: (v) => `${v.toFixed(1)}%`, hint: "historical equity vol \u2248 15%" }), touched && defaults.data && (_jsx("button", { onClick: () => {
                                    setStartingCents(defaults.data.starting_cents);
                                    setMonthlySavings(defaults.data.monthly_savings_cents);
                                    setAnnualSpending(defaults.data.annual_spending_cents);
                                    setTouched(false);
                                }, className: "text-xs text-brand hover:text-brand-navy mt-1", children: "Reset to my actual data" }))] })] })] }));
}
