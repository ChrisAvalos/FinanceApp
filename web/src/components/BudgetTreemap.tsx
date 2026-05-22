/**
 * BudgetTreemap — Sprint G-16c.
 *
 * A squarified treemap (Bruls/Huijsen/van Wijk 2000) of category
 * spend. Each rectangle's area is proportional to amount, and the
 * algorithm minimizes aspect ratio so cells stay close to square.
 *
 * Why a treemap (when we already have a donut and a bar chart)
 * ------------------------------------------------------------
 * Donuts hide small slices in thin slivers. Bar charts give every
 * row equal visual weight, which makes "where the bulk of my money
 * went" harder to scan. A treemap is the right tool when you want
 * to answer "how is my spending DISTRIBUTED" at a glance — the
 * largest categories visually dominate, but every category still
 * gets a real, clickable rectangle.
 *
 * Algorithm — squarified
 * ----------------------
 * Greedily lay out rectangles in "strips" along the short edge of
 * the remaining area. For each candidate strip, compute the worst
 * aspect ratio it would produce; if adding the next item improves
 * (lowers) the worst ratio, add it; otherwise lock the current
 * strip and start a new one. Reference:
 * Bruls, M., Huijsen, K., & van Wijk, J. J. (2000)
 * "Squarified Treemaps", Proc. Joint Eurographics-IEEE TVCG.
 *
 * Click + hover
 * -------------
 * Each rectangle is its own button. Click → drawer. Hover → 4px
 * inset stroke + tooltip with name + amount + %.
 */
import { useMemo, useState } from "react";
import { fmtCents } from "../api/client";

export interface TreemapCell {
  category_id: number;
  name: string;
  value: number;            // > 0; sliver-out anything ≤ 0 before passing in
  color: string;
  isOverspend?: boolean;
  isUnbudgeted?: boolean;
}

export interface BudgetTreemapProps {
  cells: TreemapCell[];
  /** Pixel width to fill — match the donut size for visual parity. */
  width?: number;
  /** Pixel height. Default keeps it square-ish at full width. */
  height?: number;
  onCategoryClick?: (cell: TreemapCell) => void;
}

interface LaidOut extends TreemapCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified-treemap row + remaining-rect bookkeeping. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Worst aspect ratio of a strip of areas laid along the short edge
 * of `width`. Lower is better (closer to 1 = squares).
 */
function _worstRatio(areas: number[], width: number): number {
  if (areas.length === 0) return Infinity;
  let sum = 0, min = Infinity, max = 0;
  for (const a of areas) {
    sum += a;
    if (a < min) min = a;
    if (a > max) max = a;
  }
  const w2 = width * width;
  const s2 = sum * sum;
  return Math.max((w2 * max) / s2, s2 / (w2 * min));
}

/** Lay out a strip of areas along the short edge; advance the remaining rect. */
function _layoutStrip(areas: TreemapCell[], values: number[], rect: Rect, out: LaidOut[]): Rect {
  const short = Math.min(rect.w, rect.h);
  const sum = values.reduce((s, v) => s + v, 0);
  const stripThickness = sum / short;
  if (rect.w >= rect.h) {
    // Strip is vertical, occupying the LEFT `stripThickness` columns.
    let y = rect.y;
    for (let i = 0; i < areas.length; i++) {
      const h = values[i] / stripThickness;
      out.push({ ...areas[i], x: rect.x, y, w: stripThickness, h });
      y += h;
    }
    return { x: rect.x + stripThickness, y: rect.y, w: rect.w - stripThickness, h: rect.h };
  } else {
    // Strip is horizontal, occupying the TOP `stripThickness` rows.
    let x = rect.x;
    for (let i = 0; i < areas.length; i++) {
      const w = values[i] / stripThickness;
      out.push({ ...areas[i], x, y: rect.y, w, h: stripThickness });
      x += w;
    }
    return { x: rect.x, y: rect.y + stripThickness, w: rect.w, h: rect.h - stripThickness };
  }
}

/** Squarified treemap algorithm (Bruls et al. 2000). */
function _squarify(
  cells: TreemapCell[],
  containerW: number,
  containerH: number,
): LaidOut[] {
  const total = cells.reduce((s, c) => s + c.value, 0);
  if (total <= 0 || cells.length === 0) return [];

  // Scale values into pixel-area space.
  const scale = (containerW * containerH) / total;
  // Sort descending — biggest cells laid out first for stable visuals.
  const sortedCells = [...cells].sort((a, b) => b.value - a.value);
  const queue = sortedCells.map((c) => ({ cell: c, area: c.value * scale }));

  const out: LaidOut[] = [];
  let rect: Rect = { x: 0, y: 0, w: containerW, h: containerH };

  let stripCells: TreemapCell[] = [];
  let stripAreas: number[] = [];

  while (queue.length > 0) {
    const head = queue[0];
    const candidateAreas = [...stripAreas, head.area];
    const short = Math.min(rect.w, rect.h);
    const currentRatio = _worstRatio(stripAreas, short);
    const newRatio = _worstRatio(candidateAreas, short);

    if (stripAreas.length === 0 || newRatio <= currentRatio) {
      // Adding head improves the worst-aspect-ratio → keep adding.
      stripCells.push(head.cell);
      stripAreas.push(head.area);
      queue.shift();
    } else {
      // Lock the current strip and reset.
      rect = _layoutStrip(stripCells, stripAreas, rect, out);
      stripCells = [];
      stripAreas = [];
    }
  }
  // Flush the final strip.
  if (stripCells.length > 0) {
    _layoutStrip(stripCells, stripAreas, rect, out);
  }
  return out;
}

/** Pick a text color (black/white) for legibility on a given hex bg. */
function _contrastTextColor(hex: string): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) return "#ffffff";
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  // Relative luminance approximation.
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return L > 0.6 ? "#1f2937" : "#ffffff";
}

export default function BudgetTreemap({
  cells,
  width = 520,
  height = 360,
  onCategoryClick,
}: BudgetTreemapProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  const visible = useMemo(() => cells.filter((c) => c.value > 0), [cells]);
  const total = useMemo(
    () => visible.reduce((s, c) => s + c.value, 0),
    [visible],
  );
  const laidOut = useMemo(
    () => _squarify(visible, width, height),
    [visible, width, height],
  );

  if (visible.length === 0 || total === 0) {
    return (
      <div
        className="flex items-center justify-center text-text-soft text-sm italic"
        style={{ width, height }}
        role="img"
        aria-label="No data"
      >
        No data
      </div>
    );
  }

  return (
    <div
      className="relative"
      style={{ width, height }}
      role="img"
      aria-label={`Treemap of ${visible.length} categories totalling ${fmtCents(total)}. Click a cell to see transactions.`}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block"
      >
        {laidOut.map((cell) => {
          const isHovered = hovered === cell.category_id;
          const pct = (cell.value / total) * 100;
          const showLabel = cell.w > 60 && cell.h > 28;
          const showAmount = cell.w > 80 && cell.h > 42;
          const fg = _contrastTextColor(cell.color);
          return (
            <g
              key={cell.category_id}
              onMouseEnter={() => setHovered(cell.category_id)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => onCategoryClick?.(cell)}
              style={{ cursor: onCategoryClick ? "pointer" : "default" }}
            >
              <rect
                x={cell.x + 1}
                y={cell.y + 1}
                width={Math.max(0, cell.w - 2)}
                height={Math.max(0, cell.h - 2)}
                fill={cell.color}
                stroke={
                  cell.isOverspend
                    ? "#c2161e"
                    : isHovered
                    ? fg
                    : "#ffffff"
                }
                strokeWidth={
                  cell.isOverspend ? 2 : isHovered ? 2 : 1
                }
                style={{ transition: "stroke 120ms ease, stroke-width 120ms ease" }}
              >
                <title>
                  {cell.name} — {fmtCents(cell.value)} ({pct.toFixed(1)}%)
                </title>
              </rect>
              {showLabel && (
                <text
                  x={cell.x + 8}
                  y={cell.y + 18}
                  fill={fg}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    pointerEvents: "none",
                  }}
                >
                  {cell.name.length > Math.floor(cell.w / 7)
                    ? cell.name.slice(0, Math.floor(cell.w / 7) - 1) + "…"
                    : cell.name}
                </text>
              )}
              {showAmount && (
                <text
                  x={cell.x + 8}
                  y={cell.y + 34}
                  fill={fg}
                  style={{
                    fontSize: 10,
                    opacity: 0.9,
                    fontVariantNumeric: "tabular-nums",
                    pointerEvents: "none",
                  }}
                >
                  {fmtCents(cell.value)} · {pct.toFixed(0)}%
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Floating tooltip on hover — matches DonutChart's pattern */}
      {hovered !== null &&
        (() => {
          const c = laidOut.find((x) => x.category_id === hovered);
          if (!c) return null;
          const pct = (c.value / total) * 100;
          const tx = c.x + c.w / 2;
          const ty = c.y + c.h / 2;
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
              <div>{c.name}</div>
              <div className="text-[10px] font-normal opacity-90 tabular-nums">
                {fmtCents(c.value)} · {pct.toFixed(1)}%
              </div>
            </div>
          );
        })()}
    </div>
  );
}
