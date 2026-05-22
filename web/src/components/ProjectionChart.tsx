/**
 * ProjectionChart — Wave G, Sprint G-3.
 *
 * Multi-line SVG chart projecting savings / checking / investment /
 * net-worth balances out to 24 months. Pairs with /api/budgets/project.
 *
 * Why pure SVG (same as DonutChart)
 * ---------------------------------
 * Zero chart-library dependency, full control over Tailwind theming,
 * hover tooltips that match the rest of the app, and a stable API
 * that won't break on a chart-lib major version bump.
 *
 * Visual design
 * -------------
 * - X-axis: month index (0..N). Tick every 6 months with month-name
 *   labels (Today, +6mo, +12mo, +18mo, +24mo).
 * - Y-axis: dollar values, auto-ranged with a small headroom. Negative
 *   values dip below a dashed zero line — meant to be visible since
 *   "balance going negative" is the most important insight this chart
 *   delivers.
 * - Line per series. Scenario lines are SOLID, baseline lines are
 *   DASHED (so the user can see status quo vs the override scenario).
 *   When baseline === scenario, we draw one line per series to avoid
 *   visual noise.
 * - Net line is BOLDED and uses a darker tone so the eye lands on it
 *   first. Per-bucket lines are accent colors.
 *
 * Hover behavior
 * --------------
 * Mouse over → tooltip with exact values at that month. The hover
 * indicator is a vertical line + dots at each series intersection.
 */
import { useMemo, useState } from "react";
import type { ProjectionPoint } from "../api/client";
import { fmtCents } from "../api/client";

export interface ProjectionChartProps {
  /** Scenario series (what the user has dialed in). */
  scenario: ProjectionPoint[];
  /** Optional baseline series for status-quo overlay (conservative — uses
   *  90-day rolling outflow avg). */
  baseline?: ProjectionPoint[] | null;
  /** Sprint J-1a — optional optimistic overlay (pace-aware EOM
   *  extrapolation). When provided, renders alongside the conservative
   *  baseline as a "range" view. */
  optimistic?: ProjectionPoint[] | null;
  /** Chart width — defaults to fill container, but caller can pin. */
  width?: number;
  /** Chart height. */
  height?: number;
  /** Optional className passthrough for the outer wrapper. */
  className?: string;
}

// Series colors are picked to be:
//   - Distinct from each other and from the donut palette
//   - Reasonable on light AND dark accent backgrounds
//   - WCAG-AA compliant when used as 2px strokes on white
const SERIES_COLORS = {
  net:        { stroke: "#1b2430", label: "Net worth",    width: 3 },  // text-default
  checking:   { stroke: "#117aca", label: "Checking",     width: 2 },  // brand blue
  savings:    { stroke: "#00754a", label: "Savings",      width: 2 },  // inflow green
  investment: { stroke: "#7B3F00", label: "Investments",  width: 2 },  // brown (CB-safe)
} as const;

type SeriesKey = keyof typeof SERIES_COLORS;

const SERIES_KEYS: SeriesKey[] = ["net", "checking", "savings", "investment"];

function pointValue(p: ProjectionPoint, key: SeriesKey): number {
  switch (key) {
    case "net":        return p.net_cents;
    case "checking":   return p.checking_cents;
    case "savings":    return p.savings_cents;
    case "investment": return p.investment_cents;
  }
}

/* ---------------- Helpers ---------------- */

function _formatTick(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  if (abs >= 100_000_00) return `${sign}$${(abs / 100_000_00).toFixed(1)}M`;
  if (abs >= 1000_00) return `${sign}$${(abs / 1000_00).toFixed(0)}K`;
  return `${sign}$${(abs / 100).toFixed(0)}`;
}

function _formatMonth(idx: number): string {
  if (idx === 0) return "Today";
  if (idx === 12) return "1 yr";
  if (idx === 24) return "2 yr";
  if (idx % 12 === 0) return `${idx / 12} yr`;
  return `+${idx}mo`;
}

/* ---------------- Component ---------------- */

export default function ProjectionChart({
  scenario,
  baseline,
  optimistic,
  width = 720,
  height = 320,
  className,
}: ProjectionChartProps) {
  // Hovered month-index (null = no hover). Stored as the discrete month
  // index, not the pixel X, so the tooltip snaps to data points.
  // Note: animation is performed at the parent level (BudgetProjection
  // calls useAnimatedProjection on scenario_points) so headline cards
  // and chart stay synchronized. This component just renders whatever
  // it's given.
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Layout — leave margin for tick labels.
  const M = { top: 14, right: 64, bottom: 30, left: 60 };
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;

  // Compute min/max across all series in scenario + baseline + optimistic
  // so the Y axis is consistent regardless of override extremes.
  const { yMin, yMax, xMax } = useMemo(() => {
    const points: ProjectionPoint[] = [
      ...scenario,
      ...(baseline ?? []),
      ...(optimistic ?? []),
    ];
    if (points.length === 0) return { yMin: 0, yMax: 1, xMax: 1 };
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      for (const k of SERIES_KEYS) {
        const v = pointValue(p, k);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    // Pad ~10% headroom both directions. Always include zero so the
    // crossing point is visible.
    if (lo > 0) lo = 0;
    if (hi < 0) hi = 0;
    const range = hi - lo || 1;
    lo -= range * 0.1;
    hi += range * 0.1;
    return {
      yMin: lo,
      yMax: hi,
      xMax: Math.max(...points.map((p) => p.month_index)),
    };
  }, [scenario, baseline, optimistic]);

  // Coord transforms (cents → pixel).
  const xOf = (idx: number) => (idx / xMax) * innerW;
  const yOf = (v: number) =>
    innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // Build path strings per series.
  function _linePath(series: ProjectionPoint[], key: SeriesKey): string {
    if (series.length === 0) return "";
    const segs: string[] = [];
    for (let i = 0; i < series.length; i++) {
      const x = xOf(series[i].month_index);
      const y = yOf(pointValue(series[i], key));
      segs.push(`${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    return segs.join(" ");
  }

  // Whether scenario and baseline are identical — if so, skip the
  // dashed-overlay rendering (the dashes muddle a single-line chart).
  const hasBaselineOverlay = useMemo(() => {
    if (!baseline) return false;
    if (baseline.length !== scenario.length) return true;
    for (let i = 0; i < scenario.length; i++) {
      if (
        baseline[i].net_cents !== scenario[i].net_cents ||
        baseline[i].savings_cents !== scenario[i].savings_cents ||
        baseline[i].checking_cents !== scenario[i].checking_cents ||
        baseline[i].investment_cents !== scenario[i].investment_cents
      ) {
        return true;
      }
    }
    return false;
  }, [scenario, baseline]);

  // Tick generation. Y: round to "nice" intervals (multiples of 1/2/5 × 10^n)
  // so the labels read clean ($0, $5K, $10K, …) instead of $83, $4783, $9583.
  const yTicks = useMemo(() => {
    const range = yMax - yMin;
    // Aim for ~5 ticks. Compute raw step then snap to a nice multiple.
    const rawStep = range / 5;
    const exp = Math.pow(10, Math.floor(Math.log10(Math.max(Math.abs(rawStep), 1))));
    const mant = rawStep / exp;
    let niceMant: number;
    if (mant < 1.5) niceMant = 1;
    else if (mant < 3.5) niceMant = 2;
    else if (mant < 7.5) niceMant = 5;
    else niceMant = 10;
    const step = niceMant * exp;
    // Start at the nearest nice multiple at or below yMin.
    const tickLo = Math.ceil(yMin / step) * step;
    const ticks: number[] = [];
    for (let v = tickLo; v <= yMax + 1; v += step) {
      ticks.push(v);
    }
    // Always include $0 if the range straddles it — it's the most
    // important reference line on a balance-projection chart.
    if (yMin < 0 && yMax > 0 && !ticks.some((t) => Math.abs(t) < 1)) {
      ticks.push(0);
    }
    return ticks.sort((a, b) => a - b);
  }, [yMin, yMax]);
  const xTicks = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i <= xMax; i += 6) out.push(i);
    if (out[out.length - 1] !== xMax) out.push(xMax);
    return out;
  }, [xMax]);

  // Hover handling — translate mouse X into a month index.
  function _handleMouseMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const fraction = Math.max(0, Math.min(1, x / innerW));
    const idx = Math.round(fraction * xMax);
    setHoveredIdx(idx);
  }
  function _handleMouseLeave() {
    setHoveredIdx(null);
  }

  const hovered = hoveredIdx != null ? scenario.find((p) => p.month_index === hoveredIdx) : null;
  const hoveredBaseline = hoveredIdx != null && baseline
    ? baseline.find((p) => p.month_index === hoveredIdx)
    : null;

  return (
    <div className={className}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={
          scenario.length > 0
            ? `Projected net worth over ${scenario[scenario.length - 1].month_index} months. End-state ${fmtCents(scenario[scenario.length - 1].net_cents)}.`
            : "Empty projection"
        }
      >
        <g transform={`translate(${M.left} ${M.top})`}>
          {/* Background grid */}
          {yTicks.map((t, i) => (
            <g key={`yt-${i}`}>
              <line
                x1={0}
                x2={innerW}
                y1={yOf(t)}
                y2={yOf(t)}
                stroke="#e3e6eb"
                strokeWidth={1}
              />
              <text
                x={-8}
                y={yOf(t) + 4}
                textAnchor="end"
                className="fill-text-soft"
                style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}
              >
                {_formatTick(t)}
              </text>
            </g>
          ))}

          {/* Zero line — call out balance going negative. */}
          {yMin < 0 && yMax > 0 && (
            <line
              x1={0}
              x2={innerW}
              y1={yOf(0)}
              y2={yOf(0)}
              stroke="#c2161e"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
          )}

          {/* X-axis tick marks + labels */}
          {xTicks.map((tx) => (
            <g key={`xt-${tx}`}>
              <line
                x1={xOf(tx)}
                x2={xOf(tx)}
                y1={innerH}
                y2={innerH + 4}
                stroke="#5b6676"
              />
              <text
                x={xOf(tx)}
                y={innerH + 18}
                textAnchor="middle"
                className="fill-text-muted"
                style={{ fontSize: 11 }}
              >
                {_formatMonth(tx)}
              </text>
            </g>
          ))}

          {/* Baseline (dashed, conservative — 90-day rolling outflow). */}
          {hasBaselineOverlay && baseline && SERIES_KEYS.map((k) => (
            <path
              key={`bl-${k}`}
              d={_linePath(baseline, k)}
              fill="none"
              stroke={SERIES_COLORS[k].stroke}
              strokeWidth={SERIES_COLORS[k].width}
              strokeDasharray="5 4"
              opacity={0.45}
            />
          ))}

          {/* Sprint J-1a — optimistic (dotted, pace-aware EOM extrapolation
              of this month). Only drawn for the Net worth series to
              avoid line spaghetti on a chart that already has up to 4
              series + a baseline overlay. */}
          {optimistic && optimistic.length > 0 && (
            <path
              key="opt-net"
              d={_linePath(optimistic, "net")}
              fill="none"
              stroke="#117aca"
              strokeWidth={2}
              strokeDasharray="2 4"
              opacity={0.65}
            />
          )}

          {/* Scenario (solid) */}
          {SERIES_KEYS.map((k) => (
            <path
              key={`sc-${k}`}
              d={_linePath(scenario, k)}
              fill="none"
              stroke={SERIES_COLORS[k].stroke}
              strokeWidth={SERIES_COLORS[k].width}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* Hover indicator: vertical line + dots */}
          {hoveredIdx != null && hovered && (
            <g pointerEvents="none">
              <line
                x1={xOf(hoveredIdx)}
                x2={xOf(hoveredIdx)}
                y1={0}
                y2={innerH}
                stroke="#5b6676"
                strokeWidth={1}
                strokeDasharray="2 2"
              />
              {SERIES_KEYS.map((k) => (
                <circle
                  key={`hd-${k}`}
                  cx={xOf(hoveredIdx)}
                  cy={yOf(pointValue(hovered, k))}
                  r={4}
                  fill="#ffffff"
                  stroke={SERIES_COLORS[k].stroke}
                  strokeWidth={2}
                />
              ))}
            </g>
          )}

          {/* Mouse capture — invisible rect covering the plot area */}
          <rect
            x={0}
            y={0}
            width={innerW}
            height={innerH}
            fill="transparent"
            onMouseMove={_handleMouseMove}
            onMouseLeave={_handleMouseLeave}
            style={{ cursor: "crosshair" }}
          />
        </g>
      </svg>

      {/* Tooltip — positioned outside the SVG so it can use Tailwind tooltips */}
      {hoveredIdx != null && hovered && (
        <div className="mt-2 px-3 py-2 rounded-md bg-card border border-border shadow-card inline-block">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            {_formatMonth(hoveredIdx)}
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-1 text-xs tabular-nums">
            {SERIES_KEYS.map((k) => {
              const v = pointValue(hovered, k);
              const blV = hoveredBaseline ? pointValue(hoveredBaseline, k) : null;
              return (
                <div key={k} className="contents">
                  <div className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="inline-block w-2.5 h-2.5 rounded-sm"
                      style={{ backgroundColor: SERIES_COLORS[k].stroke }}
                    />
                    <span className="text-text-muted">{SERIES_COLORS[k].label}</span>
                  </div>
                  <div className="text-right">
                    <span className={v < 0 ? "text-outflow font-semibold" : "text-text font-semibold"}>
                      {fmtCents(v)}
                    </span>
                    {blV != null && blV !== v && (
                      <span className="ml-1.5 text-text-soft text-[10px]">
                        (was {fmtCents(blV)})
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
        {SERIES_KEYS.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block rounded-sm"
              style={{
                backgroundColor: SERIES_COLORS[k].stroke,
                width: 14,
                height: 3,
              }}
            />
            {SERIES_COLORS[k].label}
          </span>
        ))}
        {hasBaselineOverlay && (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block border-t-2"
              style={{ borderTop: "2px dashed #5b6676", width: 14 }}
            />
            <span title="Projects your 90-day-average spending forward (catchall transfers and card payments excluded).">
              Dashed = 90-day average
            </span>
          </span>
        )}
        {optimistic && optimistic.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block"
              style={{
                borderTop: "2px dotted #117aca",
                width: 14,
              }}
            />
            <span title="Projects this month's spending pace forward. Pair it with the 90-day-average line to read the range.">
              Dotted = this month's pace
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
