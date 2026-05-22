/**
 * BudgetSunburst — Sprint G-16d.
 *
 * A two-ring sunburst: the inner ring is parent GROUPS (derived
 * from category names — see `_groupFor`) and the outer ring is
 * the individual categories. Each outer slice is colored from the
 * Wong palette like the donut; each inner slice is a saturated
 * blend of its children's colors so the parent "owns" its kids
 * visually.
 *
 * Why a sunburst (when we already have donut/bar/treemap)
 * -------------------------------------------------------
 * Spending naturally has a two-level hierarchy: "Food" (groceries,
 * restaurants, snacks) vs "Software" (Adobe, Notion, Figma) vs
 * "Housing" (rent, utilities, internet). The donut flattens this;
 * the sunburst makes the parent groupings visible without forcing
 * the user to manage explicit hierarchy in the database. We derive
 * parents heuristically from name substrings (see _groupFor).
 *
 * Click handling
 * --------------
 * Clicking an OUTER slice opens the category drawer (same as the
 * donut). Clicking an INNER slice opens a multi-category drawer
 * — categoryId: null + a custom "Food (all 3 categories)" label
 * + a parent-aggregated total. The drawer treats null as "show
 * all transactions in this month" — for now we pass the parent
 * label so the user understands the drill-down even if it shows
 * all-tx (a future refinement could filter to the parent's set).
 *
 * Geometry
 * --------
 * Same `_arcPath` / polar coordinate helpers as DonutChart, just
 * generalized to two concentric rings.
 */
import { useMemo, useState } from "react";
import { fmtCents } from "../api/client";

export interface SunburstLeaf {
  category_id: number;
  name: string;
  value: number;             // > 0
  color: string;
  isOverspend?: boolean;
}

export interface BudgetSunburstProps {
  leaves: SunburstLeaf[];
  size?: number;
  /** Click outer = single category, click inner = aggregate parent. */
  onCategoryClick?: (leaf: SunburstLeaf) => void;
  onGroupClick?: (groupName: string, leaves: SunburstLeaf[]) => void;
}

/* ---------------- Geometry ---------------- */

function _polar(cx: number, cy: number, r: number, angleRad: number): [number, number] {
  return [cx + r * Math.cos(angleRad - Math.PI / 2), cy + r * Math.sin(angleRad - Math.PI / 2)];
}

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

/* ---------------- Parent-group derivation ---------------- */

/**
 * Heuristic name → group mapping. We don't have a parent-category
 * column in the DB so we derive groupings from substrings. Keep
 * the list short and obvious; categories that don't match any
 * group fall back to "Other."
 */
const GROUP_RULES: { group: string; patterns: RegExp[] }[] = [
  { group: "Food",         patterns: [/grocer/i, /restaurant/i, /coffee/i, /food/i, /snack/i, /dining/i, /bar/i] },
  { group: "Housing",      patterns: [/rent/i, /mortgage/i, /utilit/i, /internet/i, /electric/i, /water/i, /gas (bill|util)/i] },
  { group: "Transport",    patterns: [/gas$/i, /fuel/i, /uber/i, /lyft/i, /transit/i, /parking/i, /auto/i, /car/i] },
  { group: "Software",     patterns: [/software/i, /saas/i, /subscription/i, /streaming/i, /netflix/i, /spotify/i, /youtube/i] },
  { group: "Shopping",     patterns: [/shopping/i, /amazon/i, /retail/i, /clothing/i, /apparel/i] },
  { group: "Health",       patterns: [/health/i, /medical/i, /pharmacy/i, /dental/i, /gym/i, /fitness/i] },
  { group: "Entertainment",patterns: [/entertain/i, /movie/i, /concert/i, /hobby/i, /game/i] },
  { group: "Travel",       patterns: [/travel/i, /hotel/i, /airline/i, /flight/i, /airbnb/i] },
  { group: "Finance",      patterns: [/fee/i, /interest/i, /insurance/i, /tax/i, /loan/i] },
];

function _groupFor(name: string): string {
  for (const rule of GROUP_RULES) {
    for (const p of rule.patterns) {
      if (p.test(name)) return rule.group;
    }
  }
  return "Other";
}

/* ---------------- Color blending (parent ring) ---------------- */

function _blendHexes(hexes: string[]): string {
  if (hexes.length === 0) return "#999999";
  let r = 0, g = 0, b = 0;
  for (const h of hexes) {
    const m = h.replace("#", "");
    if (m.length !== 6) continue;
    r += parseInt(m.slice(0, 2), 16);
    g += parseInt(m.slice(2, 4), 16);
    b += parseInt(m.slice(4, 6), 16);
  }
  r = Math.round(r / hexes.length);
  g = Math.round(g / hexes.length);
  b = Math.round(b / hexes.length);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function _contrastTextColor(hex: string): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) return "#ffffff";
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return L > 0.6 ? "#1f2937" : "#ffffff";
}

/* ---------------- Component ---------------- */

export default function BudgetSunburst({
  leaves,
  size = 360,
  onCategoryClick,
  onGroupClick,
}: BudgetSunburstProps) {
  const [hoveredLeaf, setHoveredLeaf] = useState<number | null>(null);
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);

  // Build group structure: { group: SunburstLeaf[] } and total.
  const { groups, total } = useMemo(() => {
    const positive = leaves.filter((l) => l.value > 0);
    const t = positive.reduce((s, l) => s + l.value, 0);
    const map = new Map<string, SunburstLeaf[]>();
    for (const l of positive) {
      const g = _groupFor(l.name);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(l);
    }
    // Sort groups by descending total spend, and leaves within a group same.
    const sorted = [...map.entries()]
      .map(([g, ls]) => ({
        group: g,
        leaves: ls.sort((a, b) => b.value - a.value),
        total: ls.reduce((s, l) => s + l.value, 0),
      }))
      .sort((a, b) => b.total - a.total);
    return { groups: sorted, total: t };
  }, [leaves]);

  if (groups.length === 0 || total === 0) {
    return (
      <div
        className="flex items-center justify-center text-text-soft text-sm italic"
        style={{ width: size, height: size }}
        role="img"
        aria-label="No data"
      >
        No data
      </div>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 4;
  const rInner = rOuter * 0.32;          // hole in middle (for the total)
  const rRingSplit = rInner + (rOuter - rInner) * 0.42; // inner ring ends here, outer starts

  // Lay out group arcs (inner ring), then leaf arcs within each.
  let cursor = 0;
  const groupArcs: {
    group: string;
    leaves: SunburstLeaf[];
    color: string;
    start: number;
    end: number;
    total: number;
  }[] = [];
  const leafArcs: {
    leaf: SunburstLeaf;
    group: string;
    color: string;
    start: number;
    end: number;
  }[] = [];

  for (const g of groups) {
    const groupStart = cursor;
    const groupFrac = g.total / total;
    const groupEnd = cursor + groupFrac * 2 * Math.PI;

    // Inside the group arc, sub-allocate to each leaf.
    let inner = groupStart;
    for (const l of g.leaves) {
      const leafFrac = l.value / total;
      const leafEnd = inner + leafFrac * 2 * Math.PI;
      leafArcs.push({
        leaf: l,
        group: g.group,
        color: l.color,
        start: inner,
        end: groups.length === 1 && g.leaves.length === 1 ? leafEnd - 1e-3 : leafEnd,
      });
      inner = leafEnd;
    }

    groupArcs.push({
      group: g.group,
      leaves: g.leaves,
      color: _blendHexes(g.leaves.map((l) => l.color)),
      start: groupStart,
      end: groups.length === 1 ? groupEnd - 1e-3 : groupEnd,
      total: g.total,
    });
    cursor = groupEnd;
  }

  return (
    <div
      className="relative inline-block"
      role="img"
      aria-label={`Sunburst of ${leaves.length} categories grouped into ${groups.length} parents, totalling ${fmtCents(total)}. Click outer slice for a category, inner slice for a group.`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Inner ring — parent groups */}
        {groupArcs.map((g) => {
          const isHovered = hoveredGroup === g.group;
          const r = isHovered ? rRingSplit + 2 : rRingSplit;
          return (
            <path
              key={`grp-${g.group}`}
              d={_arcPath(cx, cy, r, rInner, g.start, g.end)}
              fill={g.color}
              stroke="#ffffff"
              strokeWidth={1}
              onMouseEnter={() => setHoveredGroup(g.group)}
              onMouseLeave={() => setHoveredGroup(null)}
              onClick={() => onGroupClick?.(g.group, g.leaves)}
              style={{
                cursor: onGroupClick ? "pointer" : "default",
                transition: "d 120ms ease",
              }}
            >
              <title>
                {g.group} — {fmtCents(g.total)} ({((g.total / total) * 100).toFixed(1)}%)
              </title>
            </path>
          );
        })}

        {/* Outer ring — leaf categories */}
        {leafArcs.map((a) => {
          const isHovered = hoveredLeaf === a.leaf.category_id;
          const r = isHovered ? rOuter + 3 : rOuter;
          return (
            <path
              key={`leaf-${a.leaf.category_id}`}
              d={_arcPath(cx, cy, r, rRingSplit, a.start, a.end)}
              fill={a.color}
              stroke={a.leaf.isOverspend ? "#c2161e" : "#ffffff"}
              strokeWidth={a.leaf.isOverspend ? 2 : 1}
              onMouseEnter={() => setHoveredLeaf(a.leaf.category_id)}
              onMouseLeave={() => setHoveredLeaf(null)}
              onClick={() => onCategoryClick?.(a.leaf)}
              style={{
                cursor: onCategoryClick ? "pointer" : "default",
                transition: "d 120ms ease",
              }}
            >
              <title>
                {a.leaf.name} — {fmtCents(a.leaf.value)} ({((a.leaf.value / total) * 100).toFixed(1)}%)
              </title>
            </path>
          );
        })}

        {/* Center label — total */}
        <text
          x={cx}
          y={cy - 4}
          textAnchor="middle"
          className="fill-text-muted"
          style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}
        >
          Total
        </text>
        <text
          x={cx}
          y={cy + 14}
          textAnchor="middle"
          className="fill-text"
          style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
        >
          {fmtCents(total)}
        </text>
      </svg>

      {/* Floating tooltip — group OR leaf */}
      {(hoveredLeaf !== null || hoveredGroup !== null) &&
        (() => {
          if (hoveredLeaf !== null) {
            const arc = leafArcs.find((a) => a.leaf.category_id === hoveredLeaf);
            if (!arc) return null;
            const mid = (arc.start + arc.end) / 2;
            const [tx, ty] = _polar(cx, cy, rOuter + 12, mid);
            return (
              <div
                className="pointer-events-none absolute z-10 px-2.5 py-1.5 rounded-md bg-text text-white text-xs font-semibold shadow-lg whitespace-nowrap"
                style={{ left: tx, top: ty, transform: "translate(-50%, -50%)" }}
                role="status"
              >
                <div>{arc.leaf.name}</div>
                <div className="text-[10px] font-normal opacity-90 tabular-nums">
                  {fmtCents(arc.leaf.value)} · {((arc.leaf.value / total) * 100).toFixed(1)}% · in {arc.group}
                </div>
              </div>
            );
          }
          if (hoveredGroup !== null) {
            const g = groupArcs.find((x) => x.group === hoveredGroup);
            if (!g) return null;
            const mid = (g.start + g.end) / 2;
            const [tx, ty] = _polar(cx, cy, (rInner + rRingSplit) / 2 + 6, mid);
            const fg = _contrastTextColor(g.color);
            return (
              <div
                className="pointer-events-none absolute z-10 px-2.5 py-1.5 rounded-md shadow-lg whitespace-nowrap text-xs font-semibold"
                style={{
                  left: tx, top: ty, transform: "translate(-50%, -50%)",
                  backgroundColor: g.color, color: fg,
                }}
                role="status"
              >
                <div>{g.group}</div>
                <div className="text-[10px] font-normal opacity-90 tabular-nums">
                  {fmtCents(g.total)} · {((g.total / total) * 100).toFixed(1)}% · {g.leaves.length} categor{g.leaves.length === 1 ? "y" : "ies"}
                </div>
              </div>
            );
          }
          return null;
        })()}
    </div>
  );
}
