/**
 * DonutChart — Wave G, Sprint G-1.
 *
 * Why pure SVG (no recharts / chart.js / d3)
 * ------------------------------------------
 * The app has zero chart deps shipping today, and the chart we need
 * here is a single donut. Pulling in a 100KB chart library to render
 * a few SVG arcs is overkill, and a hand-rolled SVG donut gives us
 * full control over Tailwind theming, hover states, and a11y labels.
 *
 * What this renders
 * -----------------
 * A donut chart with `slices` as the data, a configurable inner-/outer-
 * radius gap, and an optional center label. Each slice has a category
 * name, a value, a color, and an optional click handler.
 *
 * Hover behavior
 * --------------
 * Hovering a slice expands its outer radius by 4px and surfaces a
 * tooltip with `name`, formatted value, and percent. The tooltip
 * follows the slice's midpoint so it doesn't jump under the cursor.
 *
 * Accessibility
 * -------------
 * The whole donut has `role="img"` with an aria-label summarizing the
 * data (the table of values is exposed below the chart in the panel —
 * the chart itself is decorative). Each slice has its own `<title>`
 * fallback for tooltips so screen-reader users can navigate the SVG.
 */
import { useState } from "react";

export interface DonutSlice {
  key: string;             // stable id (e.g. category_id) for React key
  name: string;            // display name
  value: number;           // unsigned numeric — must be ≥ 0
  color: string;           // CSS color (hex or tailwind-friendly var)
  isOverspend?: boolean;   // ring this slice with an outline if overspending
}

export interface DonutChartProps {
  slices: DonutSlice[];
  /** Total to display in the center. If omitted, uses the slice sum. */
  centerValue?: number;
  /** Top label above the value, e.g. "Spent" or "Budget". */
  centerTopLabel?: string;
  /** Bottom label below the value, e.g. "this month". */
  centerBottomLabel?: string;
  /** Format the value for the center label. Default: `value.toFixed(0)`. */
  formatValue?: (cents: number) => string;
  /** Optional accessible description that summarizes the chart contents. */
  ariaLabel?: string;
  /** Pixel size. Defaults to 220 — fits two-up in a 480px column. */
  size?: number;
  /** How much of the radius is the donut ring (0..1). Default 0.42 = thick. */
  ringFraction?: number;
  /** Override the empty-state copy when slices is []. */
  emptyMessage?: string;
  /** Click a slice → drill into that category. Sprint G-16. */
  onSliceClick?: (slice: DonutSlice) => void;
  /** Click the center label → drill into all categories. Sprint G-16. */
  onCenterClick?: () => void;
}

const DEFAULT_SIZE = 220;
const DEFAULT_RING = 0.42;

/* ---------------- Geometry helpers ---------------- */

function _polar(cx: number, cy: number, r: number, angleRad: number): [number, number] {
  // 0 rad points to 3 o'clock; we want 0 → 12 o'clock so subtract π/2.
  return [cx + r * Math.cos(angleRad - Math.PI / 2), cy + r * Math.sin(angleRad - Math.PI / 2)];
}

/**
 * Build an SVG path for an annular sector (donut slice).
 *
 * Two arcs (outer ccw, inner cw) plus two radial lines that connect
 * them. The `large-arc-flag` (1) trips on for slices > 50% so they
 * render correctly. The `sweep-flag` direction is opposite on the
 * inner arc so the path traces a closed ring section, not a bow tie.
 */
function _arcPath(
  cx: number, cy: number,
  rOuter: number, rInner: number,
  startRad: number, endRad: number,
): string {
  const [x0, y0] = _polar(cx, cy, rOuter, startRad);
  const [x1, y1] = _polar(cx, cy, rOuter, endRad);
  const [x2, y2] = _polar(cx, cy, rInner, endRad);
  const [x3, y3] = _polar(cx, cy, rInner, startRad);
  const large = endRad - startRad > Math.PI ? 1 : 0;
  return [
    `M ${x0} ${y0}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1} ${y1}`,
    `L ${x2} ${y2}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${x3} ${y3}`,
    "Z",
  ].join(" ");
}

function _defaultFmt(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  if (abs >= 100_000_00) return `${sign}$${(abs / 100_000_00).toFixed(1)}M`;
  if (abs >= 1000_00) return `${sign}$${(abs / 1000_00).toFixed(1)}K`;
  return `${sign}$${(abs / 100).toFixed(0)}`;
}

/* ---------------- Component ---------------- */

export default function DonutChart({
  slices,
  centerValue,
  centerTopLabel,
  centerBottomLabel,
  formatValue = _defaultFmt,
  ariaLabel,
  size = DEFAULT_SIZE,
  ringFraction = DEFAULT_RING,
  emptyMessage = "No data",
  onSliceClick,
  onCenterClick,
}: DonutChartProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  // Filter out zero-value slices so they don't take up legend space.
  const visible = slices.filter((s) => s.value > 0);
  const total = visible.reduce((s, x) => s + x.value, 0);
  const displayCenter = centerValue ?? total;

  if (visible.length === 0 || total === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center"
        style={{ width: size, height: size }}
        role="img"
        aria-label={ariaLabel ?? emptyMessage}
      >
        <div className="text-text-soft text-sm italic">{emptyMessage}</div>
      </div>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const rOuter = (size / 2) - 4;             // 4px margin so hover-grow doesn't clip
  const rOuterHover = rOuter + 3;            // grow on hover
  const rInner = rOuter * (1 - ringFraction);

  // Cumulative angle pointer — radians.
  let cursor = 0;
  const arcs = visible.map((slice) => {
    const fraction = slice.value / total;
    const start = cursor;
    const end = cursor + fraction * 2 * Math.PI;
    cursor = end;
    // For 100%-single-slice donuts, a single-arc full circle would
    // degenerate to a zero-length path; clamp to "almost full" so it
    // still renders.
    const safeEnd = visible.length === 1 ? end - 1e-3 : end;
    return {
      key: slice.key,
      name: slice.name,
      value: slice.value,
      color: slice.color,
      isOverspend: slice.isOverspend,
      fraction,
      start,
      end: safeEnd,
      midRad: (start + safeEnd) / 2,
    };
  });

  return (
    <div className="relative inline-block">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={
          ariaLabel ??
          `${visible.length} categories totalling ${formatValue(total)}`
        }
      >
        {arcs.map((arc) => {
          const isHovered = hovered === arc.key;
          const r = isHovered ? rOuterHover : rOuter;
          const clickable = !!onSliceClick;
          // Find the original slice for the click callback (arcs lose the
          // `key` field reference but the visible array maps 1:1 by index).
          const originalSlice = visible.find((s) => s.key === arc.key);
          return (
            <path
              key={arc.key}
              d={_arcPath(cx, cy, r, rInner, arc.start, arc.end)}
              fill={arc.color}
              stroke={arc.isOverspend ? "#c2161e" : "#ffffff"}
              strokeWidth={arc.isOverspend ? 2 : 1}
              onMouseEnter={() => setHovered(arc.key)}
              onMouseLeave={() => setHovered(null)}
              onClick={
                clickable && originalSlice
                  ? () => onSliceClick!(originalSlice)
                  : undefined
              }
              style={{
                transition: "d 120ms ease, stroke-width 120ms ease",
                cursor: clickable ? "pointer" : "default",
              }}
              role={clickable ? "button" : undefined}
              aria-label={
                clickable
                  ? `${arc.name}: ${formatValue(arc.value)}, ${(arc.fraction * 100).toFixed(1)}%. Click to see transactions.`
                  : undefined
              }
            >
              <title>
                {arc.name} — {formatValue(arc.value)} ({(arc.fraction * 100).toFixed(1)}%){clickable ? " · click to drill in" : ""}
              </title>
            </path>
          );
        })}
        {/* Center labels — keep these AFTER the arcs so they stay on top.
            When onCenterClick is set we wrap them in a clickable group +
            transparent disk so the entire center hole is hot. */}
        <g
          onClick={onCenterClick}
          style={{ cursor: onCenterClick ? "pointer" : "default" }}
          role={onCenterClick ? "button" : undefined}
          aria-label={
            onCenterClick
              ? `Total ${formatValue(displayCenter)}. Click to see all transactions.`
              : undefined
          }
        >
          {/* Transparent hit target covers the donut hole so the whole
              center is clickable, not just the text rasters. */}
          {onCenterClick && (
            <circle cx={cx} cy={cy} r={rInner} fill="transparent">
              <title>Click for all transactions</title>
            </circle>
          )}
          {centerTopLabel && (
            <text
              x={cx}
              y={cy - 16}
              textAnchor="middle"
              className="fill-text-muted"
              style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}
            >
              {centerTopLabel}
            </text>
          )}
          <text
            x={cx}
            y={cy + 6}
            textAnchor="middle"
            className="fill-text"
            style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
          >
            {formatValue(displayCenter)}
          </text>
          {centerBottomLabel && (
            <text
              x={cx}
              y={cy + 24}
              textAnchor="middle"
              className="fill-text-soft"
              style={{ fontSize: 11 }}
            >
              {centerBottomLabel}
            </text>
          )}
        </g>
      </svg>

      {/* Floating tooltip on hover — positioned over the slice midpoint so
          it doesn't jump as the cursor moves within the slice. */}
      {hovered &&
        (() => {
          const arc = arcs.find((a) => a.key === hovered);
          if (!arc) return null;
          // Midpoint on the OUTER edge so the tooltip sits at the
          // tip of the slice. Bump up by 8px so it's clearly above.
          const [tx, ty] = _polar(cx, cy, rOuter + 12, arc.midRad);
          return (
            <div
              className="pointer-events-none absolute z-10 px-2.5 py-1.5 rounded-md bg-text text-white text-xs font-semibold shadow-lg whitespace-nowrap"
              style={{
                left: tx,
                top: ty,
                transform: "translate(-50%, -50%)",
              }}
              role="status"
            >
              <div>{arc.name}</div>
              <div className="text-[10px] font-normal opacity-90 tabular-nums">
                {formatValue(arc.value)} · {(arc.fraction * 100).toFixed(1)}%
              </div>
            </div>
          );
        })()}
    </div>
  );
}

/* ---------------- Color palette ---------------- */

/**
 * Colorblind-friendly categorical palette (Wong 2011, adapted slightly
 * for darker hues so they pass WCAG AA against white when used as
 * background swatches in the legend). 10 stops; the chart cycles if you
 * have more categories than this. The first six are the high-contrast
 * starters; later entries are lighter accents.
 */
export const DONUT_PALETTE: string[] = [
  "#0072B2", // blue
  "#D55E00", // vermilion
  "#009E73", // bluish green
  "#CC79A7", // reddish purple
  "#56B4E9", // sky blue
  "#E69F00", // orange
  "#F0E442", // yellow (use sparingly — pairs only with white text)
  "#7B3F00", // brown
  "#000000", // black
  "#999999", // mid-gray (catch-all "Other")
];

export function paletteColor(idx: number): string {
  return DONUT_PALETTE[idx % DONUT_PALETTE.length];
}
