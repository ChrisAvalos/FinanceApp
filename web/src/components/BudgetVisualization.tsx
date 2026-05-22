/**
 * BudgetVisualization — Sprint G-16e.
 *
 * The "at a glance" budget block: replaces the old BudgetDonuts
 * with a swipeable 4-way view (donut · bars · treemap · sunburst)
 * and click-through to CategoryDrawer.
 *
 * Why 4 views? The user wants the donut for the visual punch but
 * the donut hides small slivers — bars give every category equal
 * legibility, treemap shows distribution by area without sliver
 * loss, and sunburst exposes a parent-grouping the database
 * doesn't natively store. Each view answers a different question.
 *
 * Navigation
 * ----------
 *   - Chip-group toggle (Donut · Bars · Treemap · Sunburst)
 *   - Left/Right arrow keys when the block has focus
 *   - Horizontal touch swipe on the body
 *
 * Click-through
 * -------------
 * Every clickable surface (donut slice, donut center, bar row,
 * treemap cell, sunburst slice OR ring, legend row) calls
 * `openCategory()` or `openAllCategories()` to mount the drawer.
 *
 * Drawer state lives HERE (not BudgetsPanel) so the four viz
 * components can all share it without prop-drilling.
 */
import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import {
  fmtCents,
  type BudgetRollupRow,
} from "../api/client";
import DonutChart, {
  paletteColor,
  type DonutSlice,
} from "./DonutChart";
import BudgetBarChart, { type BudgetBarRow } from "./BudgetBarChart";
import BudgetTreemap, { type TreemapCell } from "./BudgetTreemap";
import BudgetSunburst, { type SunburstLeaf } from "./BudgetSunburst";
import CategoryDrawer from "./CategoryDrawer";
import MoMChip from "./MoMChip";

type ViewKind = "donut" | "bars" | "treemap" | "sunburst";

const VIEW_ORDER: ViewKind[] = ["donut", "bars", "treemap", "sunburst"];
const VIEW_LABEL: Record<ViewKind, string> = {
  donut: "Donut",
  bars: "Bars",
  treemap: "Treemap",
  sunburst: "Sunburst",
};
const VIEW_BLURB: Record<ViewKind, string> = {
  donut: "Two donuts side by side — budget on the left, spent on the right. Same color = same category.",
  bars: "One row per category — every category gets a legible bar, no slivers.",
  treemap: "Cells sized by spend — biggest categories visually dominate but every category is still clickable.",
  sunburst: "Two rings — inner ring groups categories (Food, Housing, etc.), outer ring shows individual categories.",
};

export interface BudgetVisualizationProps {
  rows: BudgetRollupRow[];
  unbudgeted: BudgetRollupRow[];
  totalBudget: number;
  totalSpent: number;
  /** ISO YYYY-MM-DD of the displayed month — used to fetch drawer txns. */
  monthStart: string;
  /** Sprint H-4a — {cat_id: [this_month_cents, three_mo_avg_cents]} */
  momCompare?: Record<string, [number, number]>;
  /** Sprint M follow-up — IDs of prior-month-end txns that this month's
   *  rent-attribution heuristic has borrowed forward. Forwarded to the
   *  CategoryDrawer so opening the Rent row shows the Apr 30 Zelle that
   *  posted outside May's date range. */
  rentAttributedTxIds?: number[];
}

export default function BudgetVisualization({
  rows,
  unbudgeted,
  totalBudget,
  totalSpent,
  monthStart,
  momCompare,
  rentAttributedTxIds,
}: BudgetVisualizationProps) {
  const [view, setView] = useState<ViewKind>("donut");

  /* -------- Sprint M-3: drill-down state --------
   * `null` = top level (rows aggregated by parent_id = super-groups).
   * Number = drilled into that parent; rows show only its children.
   * The breadcrumb at the top toggles back to null on click. */
  const [drillIntoParentId, setDrillIntoParentId] = useState<number | null>(null);
  const [drillIntoParentName, setDrillIntoParentName] = useState<string>("");

  /* -------- Drawer state -------- */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerCategoryId, setDrawerCategoryId] = useState<number | null>(null);
  // FU-4 — multi-category drill (sunburst group click). When non-empty,
  // the drawer fetches transactions matching ANY of these category ids.
  const [drawerCategoryIds, setDrawerCategoryIds] = useState<number[]>([]);
  const [drawerCategoryName, setDrawerCategoryName] = useState<string>("");
  const [drawerSwatch, setDrawerSwatch] = useState<string | undefined>();
  const [drawerSpent, setDrawerSpent] = useState<number | undefined>();
  const [drawerBudget, setDrawerBudget] = useState<number | undefined>();

  // Sprint Chat-citations (2026-05-14): when the user clicks a category
  // chip in the AI chat answer, ChatPanel stashes the target in
  // sessionStorage and navigates to #budgets. Pick that up on mount
  // and open the drawer for the cited category.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("pendingCategoryDrawer");
      if (!raw) return;
      sessionStorage.removeItem("pendingCategoryDrawer");
      const parsed = JSON.parse(raw) as {
        category_id?: number;
        name?: string;
      };
      if (parsed.category_id && parsed.name) {
        setDrawerCategoryId(parsed.category_id);
        setDrawerCategoryIds([]);
        setDrawerCategoryName(parsed.name);
        setDrawerSwatch(undefined);
        setDrawerSpent(undefined);
        setDrawerBudget(undefined);
        setDrawerOpen(true);
      }
    } catch {
      // sessionStorage / JSON parse can throw; just ignore.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCategory = useCallback(
    (params: {
      category_id: number;
      name: string;
      color?: string;
      spent_cents?: number;
      budget_cents?: number;
    }) => {
      setDrawerCategoryId(params.category_id);
      setDrawerCategoryIds([]);
      setDrawerCategoryName(params.name);
      setDrawerSwatch(params.color);
      setDrawerSpent(params.spent_cents);
      setDrawerBudget(params.budget_cents);
      setDrawerOpen(true);
    },
    [],
  );

  const openAllCategories = useCallback(
    (label: string = "All spending this month") => {
      setDrawerCategoryId(null);
      setDrawerCategoryIds([]);
      setDrawerCategoryName(label);
      setDrawerSwatch(undefined);
      setDrawerSpent(totalSpent);
      setDrawerBudget(totalBudget);
      setDrawerOpen(true);
    },
    [totalSpent, totalBudget],
  );

  /* -------- Sprint M-3: effective rows for current drill state --------
   *
   * At top level (drillIntoParentId === null), aggregate leaf rows by
   * parent_id. Each parent becomes a synthetic "row" whose budget/actual
   * are the sum of its children, and whose category_id is the PARENT id.
   * Leaf rows without a parent_id stay as-is (no aggregation).
   *
   * At drilled level, filter to only rows whose parent_id matches the
   * drill target. Cleanest mental model: same data shape, fewer rows.
   *
   * `effectiveRowKind` tracks whether each row is a "parent aggregate"
   * (clicking drills in) or a "leaf" (clicking opens the drawer).
   */
  const { effectiveRows, effectiveUnbudgeted, parentChildCounts } = useMemo(() => {
    // Sprint M follow-up (2026-05-14): exclude catchall categories from
    // the donut/bars/treemap visualizations. Transfer, Credit Card
    // Payment, Investment Contribution, Uncategorized are internal
    // money movement — counting them as "spending" makes Financial
    // dominate the donut at $6,550 even though almost nothing is
    // actually being SPENT there. We want the chart to show where
    // money is going for real, not where it's moving between accounts.
    const noCatchallRows = rows.filter((r) => !r.is_catchall);
    const noCatchallUnbudgeted = unbudgeted.filter((u) => !u.is_catchall);

    if (drillIntoParentId !== null) {
      // Drilled — show only this parent's children (excluding catchalls).
      return {
        effectiveRows: noCatchallRows.filter((r) => r.parent_id === drillIntoParentId),
        effectiveUnbudgeted: noCatchallUnbudgeted.filter(
          (u) => u.parent_id === drillIntoParentId,
        ),
        parentChildCounts: new Map<number, number>(),
      };
    }
    // Top level — aggregate by parent_id when present.
    type Agg = {
      category_id: number;
      category_name: string;
      budget_cents: number;
      actual_outflow_cents: number;
      remaining_cents: number;
      pct_used: number;
      status: typeof rows[0]["status"];
      child_count: number;
      parent_id: null;
      parent_name: null;
      _isAggregate: true;
    };
    const byParent = new Map<number, Agg>();
    const standalone: typeof rows = [];

    for (const r of noCatchallRows) {
      if (r.parent_id != null && r.parent_name != null) {
        const pid = r.parent_id;
        const ex = byParent.get(pid);
        if (ex) {
          ex.budget_cents += r.budget_cents;
          ex.actual_outflow_cents += r.actual_outflow_cents;
          ex.remaining_cents += r.remaining_cents;
          ex.child_count += 1;
        } else {
          byParent.set(pid, {
            category_id: pid,
            category_name: r.parent_name,
            budget_cents: r.budget_cents,
            actual_outflow_cents: r.actual_outflow_cents,
            remaining_cents: r.remaining_cents,
            pct_used: 0,
            status: r.status,
            child_count: 1,
            parent_id: null,
            parent_name: null,
            _isAggregate: true,
          });
        }
      } else {
        standalone.push(r);
      }
    }

    // Same aggregation for unbudgeted rows.
    type AggU = (typeof unbudgeted)[0] & { child_count: number; _isAggregate: true };
    const byParentU = new Map<number, AggU>();
    const standaloneU: typeof unbudgeted = [];
    for (const u of noCatchallUnbudgeted) {
      if (u.parent_id != null && u.parent_name != null) {
        const pid = u.parent_id;
        const ex = byParentU.get(pid);
        if (ex) {
          ex.actual_outflow_cents += u.actual_outflow_cents;
          ex.remaining_cents += u.remaining_cents;
          ex.child_count += 1;
        } else {
          byParentU.set(pid, {
            ...u,
            category_id: pid,
            category_name: u.parent_name,
            child_count: 1,
            _isAggregate: true,
          });
        }
      } else {
        standaloneU.push(u);
      }
    }

    // Finalize pct_used for budgeted aggregates.
    const aggsRows = Array.from(byParent.values()).map((a) => ({
      ...a,
      pct_used:
        a.budget_cents > 0
          ? Math.round((a.actual_outflow_cents / a.budget_cents) * 1000) / 10
          : 0,
    })) as unknown as typeof rows;

    const childCounts = new Map<number, number>();
    for (const a of byParent.values()) childCounts.set(a.category_id, a.child_count);
    for (const a of byParentU.values())
      childCounts.set(
        a.category_id,
        (childCounts.get(a.category_id) ?? 0) + a.child_count,
      );

    return {
      effectiveRows: [...aggsRows, ...standalone],
      effectiveUnbudgeted: [
        ...(Array.from(byParentU.values()) as unknown as typeof unbudgeted),
        ...standaloneU,
      ],
      parentChildCounts: childCounts,
    };
  }, [rows, unbudgeted, drillIntoParentId]);

  /* -------- Color assignment (same logic the old BudgetDonuts used) -------- */
  const colorByCat = useMemo(() => {
    const combined = new Map<number, { name: string; total: number }>();
    for (const r of effectiveRows) {
      combined.set(r.category_id, {
        name: r.category_name,
        total: r.budget_cents + r.actual_outflow_cents,
      });
    }
    for (const u of effectiveUnbudgeted) {
      const existing = combined.get(u.category_id);
      if (existing) existing.total += u.actual_outflow_cents;
      else
        combined.set(u.category_id, {
          name: u.category_name,
          total: u.actual_outflow_cents,
        });
    }
    const sorted = [...combined.entries()].sort(
      (a, b) => b[1].total - a[1].total,
    );
    const map = new Map<number, string>();
    sorted.forEach(([id], idx) => {
      map.set(id, paletteColor(idx));
    });
    return map;
  }, [effectiveRows, effectiveUnbudgeted]);

  /* -------- Data shapes per view -------- */

  // Donut: budget vs spent (two donuts, same as before).
  // Uses effectiveRows so at top level we get super-group aggregates,
  // and when drilled we only see that parent's children.
  const budgetSlices: DonutSlice[] = useMemo(
    () =>
      effectiveRows
        .filter((r) => r.budget_cents > 0)
        .sort((a, b) => b.budget_cents - a.budget_cents)
        .map((r) => ({
          key: `b-${r.category_id}`,
          name: r.category_name,
          value: r.budget_cents,
          color: colorByCat.get(r.category_id) ?? "#999",
        })),
    [effectiveRows, colorByCat],
  );

  const spentSlices: DonutSlice[] = useMemo(() => {
    const all = [
      ...effectiveRows
        .filter((r) => r.actual_outflow_cents > 0)
        .map((r) => ({
          key: `s-${r.category_id}`,
          name: r.category_name,
          value: r.actual_outflow_cents,
          color: colorByCat.get(r.category_id) ?? "#999",
          isOverspend:
            r.budget_cents > 0 && r.actual_outflow_cents > r.budget_cents,
        })),
      ...effectiveUnbudgeted
        .filter((u) => u.actual_outflow_cents > 0)
        .map((u) => ({
          key: `s-unbudgeted-${u.category_id}`,
          name: `${u.category_name} (unbudgeted)`,
          value: u.actual_outflow_cents,
          color: "#cbd2dc",
        })),
    ];
    return all.sort((a, b) => b.value - a.value);
  }, [effectiveRows, effectiveUnbudgeted, colorByCat]);

  // Bars + legend rows: one entry per category, with both budget + spent.
  const flatRows: BudgetBarRow[] = useMemo(() => {
    const byId = new Map<number, BudgetBarRow>();
    for (const r of effectiveRows) {
      byId.set(r.category_id, {
        category_id: r.category_id,
        name: r.category_name,
        budget_cents: r.budget_cents,
        spent_cents: r.actual_outflow_cents,
        color: colorByCat.get(r.category_id) ?? "#999",
      });
    }
    for (const u of effectiveUnbudgeted) {
      const existing = byId.get(u.category_id);
      if (existing) {
        existing.spent_cents += u.actual_outflow_cents;
      } else {
        byId.set(u.category_id, {
          category_id: u.category_id,
          name: u.category_name,
          budget_cents: 0,
          spent_cents: u.actual_outflow_cents,
          color: "#cbd2dc",
          isUnbudgeted: true,
        });
      }
    }
    return [...byId.values()].filter(
      (r) => r.budget_cents > 0 || r.spent_cents > 0,
    );
  }, [effectiveRows, effectiveUnbudgeted, colorByCat]);

  // Treemap cells — actual SPENT only (the question is "where did it go").
  const treemapCells: TreemapCell[] = useMemo(
    () =>
      flatRows
        .filter((r) => r.spent_cents > 0)
        .map((r) => ({
          category_id: r.category_id,
          name: r.name,
          value: r.spent_cents,
          color: r.color,
          isOverspend:
            r.budget_cents > 0 && r.spent_cents > r.budget_cents,
          isUnbudgeted: r.isUnbudgeted,
        })),
    [flatRows],
  );

  // Sunburst leaves — same as treemap cells (spent only).
  const sunburstLeaves: SunburstLeaf[] = useMemo(
    () =>
      flatRows
        .filter((r) => r.spent_cents > 0)
        .map((r) => ({
          category_id: r.category_id,
          name: r.name,
          value: r.spent_cents,
          color: r.color,
          isOverspend:
            r.budget_cents > 0 && r.spent_cents > r.budget_cents,
        })),
    [flatRows],
  );

  /* -------- Adapters: click → drill OR openCategory --------
   * Sprint M-3: at top level, clicking a wedge that's a parent
   * aggregate drills into it. Otherwise (drilled level, or leaf with
   * no children) clicking opens the CategoryDrawer.
   */
  const _maybeDrill = useCallback(
    (id: number, name: string): boolean => {
      if (drillIntoParentId !== null) return false; // already drilled, no further nesting
      const childCount = parentChildCounts.get(id) ?? 0;
      if (childCount <= 1) return false; // singleton "groups" don't deserve a drill
      setDrillIntoParentId(id);
      setDrillIntoParentName(name);
      return true;
    },
    [drillIntoParentId, parentChildCounts],
  );

  const onDonutSliceClick = useCallback(
    (slice: DonutSlice) => {
      // Slice key is `b-${id}`, `s-${id}`, or `s-unbudgeted-${id}` —
      // we want the trailing digit run.
      const m = slice.key.match(/(\d+)$/);
      if (!m) return;
      const id = parseInt(m[1], 10);
      const cleanName = slice.name.replace(/\s*\(unbudgeted\)\s*$/i, "");
      if (_maybeDrill(id, cleanName)) return;
      const row = flatRows.find((r) => r.category_id === id);
      openCategory({
        category_id: id,
        name: row?.name ?? cleanName,
        color: row?.color ?? slice.color,
        spent_cents: row?.spent_cents,
        budget_cents: row?.budget_cents,
      });
    },
    [openCategory, flatRows, _maybeDrill],
  );

  const onBarRowClick = useCallback(
    (row: BudgetBarRow) => {
      if (_maybeDrill(row.category_id, row.name)) return;
      openCategory({
        category_id: row.category_id,
        name: row.name,
        color: row.color,
        spent_cents: row.spent_cents,
        budget_cents: row.budget_cents,
      });
    },
    [openCategory, _maybeDrill],
  );

  const onTreemapClick = useCallback(
    (cell: TreemapCell) => {
      if (_maybeDrill(cell.category_id, cell.name)) return;
      const row = flatRows.find((r) => r.category_id === cell.category_id);
      openCategory({
        category_id: cell.category_id,
        name: cell.name,
        color: cell.color,
        spent_cents: row?.spent_cents,
        budget_cents: row?.budget_cents,
      });
    },
    [openCategory, flatRows, _maybeDrill],
  );

  const onSunburstLeafClick = useCallback(
    (leaf: SunburstLeaf) => {
      const row = flatRows.find((r) => r.category_id === leaf.category_id);
      openCategory({
        category_id: leaf.category_id,
        name: leaf.name,
        color: leaf.color,
        spent_cents: row?.spent_cents,
        budget_cents: row?.budget_cents,
      });
    },
    [openCategory, flatRows],
  );

  const onSunburstGroupClick = useCallback(
    (groupName: string, leaves: SunburstLeaf[]) => {
      // FU-4 — true multi-category drill via category_ids[] param. Drawer
      // fetches txns matching ANY of the group's category ids, not the
      // whole month. Header still labels the group + count.
      const total = leaves.reduce((s, l) => s + l.value, 0);
      const ids = leaves.map((l) => l.category_id);
      setDrawerCategoryId(null);
      setDrawerCategoryIds(ids);
      setDrawerCategoryName(
        `${groupName} (${leaves.length} categor${leaves.length === 1 ? "y" : "ies"})`,
      );
      setDrawerSwatch(undefined);
      setDrawerSpent(total);
      setDrawerBudget(undefined);
      setDrawerOpen(true);
    },
    [],
  );

  /* -------- View navigation: keyboard + swipe -------- */
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Tracked container width so the treemap can fill horizontally on
  // wide layouts. ResizeObserver fires on initial paint + responsive
  // viewport changes; on browsers without RO we fall back to a sane
  // default (1200px is roughly the panel's max).
  const [containerWidth, setContainerWidth] = useState<number>(1200);
  useEffect(() => {
    if (!rootRef.current) return;
    const el = rootRef.current;
    setContainerWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const advance = useCallback((dir: 1 | -1) => {
    setView((v) => {
      const i = VIEW_ORDER.indexOf(v);
      const next = (i + dir + VIEW_ORDER.length) % VIEW_ORDER.length;
      return VIEW_ORDER[next];
    });
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    function onKey(e: KeyboardEvent) {
      // Only react when focus is inside our block, not somewhere else.
      if (!el || !el.contains(document.activeElement)) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        advance(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        advance(-1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance]);

  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  }
  function onTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current == null || touchStartY.current == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    touchStartX.current = null;
    touchStartY.current = null;
    // Require: 60+ px horizontal AND mostly horizontal (>2x dy) so a
    // vertical scroll gesture doesn't accidentally change views.
    if (Math.abs(dx) < 60) return;
    if (Math.abs(dx) < Math.abs(dy) * 2) return;
    advance(dx < 0 ? 1 : -1);
  }

  /* -------- Legend (always visible, click-to-open) -------- */
  const legendRows = useMemo(
    () =>
      [...flatRows]
        .sort(
          (a, b) =>
            (b.budget_cents + b.spent_cents) -
            (a.budget_cents + a.spent_cents),
        )
        .slice(0, 12),
    [flatRows],
  );

  if (flatRows.length === 0) return null;

  return (
    <div
      ref={rootRef}
      className="bg-card border border-border rounded-md shadow-card p-5 mb-6"
      tabIndex={0}
      aria-label="Budget visualization. Use left and right arrow keys to switch between views."
    >
      {/* Sprint M-3 — drill breadcrumb. Shows current location in the
          hierarchy; clicking "All categories" returns to super-group
          rollup. Only renders when drilled. */}
      {drillIntoParentId !== null && (
        <div className="flex items-center gap-2 mb-3 text-xs">
          <button
            type="button"
            onClick={() => {
              setDrillIntoParentId(null);
              setDrillIntoParentName("");
            }}
            className="inline-flex items-center gap-1 text-brand hover:underline focus:outline-none focus:underline"
          >
            <span aria-hidden>←</span>
            All categories
          </button>
          <span aria-hidden className="text-text-muted">/</span>
          <span className="font-semibold text-text">{drillIntoParentName}</span>
          <span className="text-text-muted">
            · {effectiveRows.length + effectiveUnbudgeted.length} children
          </span>
        </div>
      )}

      {/* Header + chip toggle */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-text">
            {drillIntoParentId !== null
              ? `${drillIntoParentName} — breakdown`
              : "Budget vs spending — at a glance"}
          </h3>
          <p className="text-[11px] text-text-soft mt-0.5">
            {drillIntoParentId !== null
              ? "Tap any wedge to see its transactions, or click the breadcrumb above to go back."
              : (
                <>
                  {VIEW_BLURB[view]}{" "}
                  <span className="text-text-muted">
                    · Tap a group wedge to drill into its categories.
                  </span>
                </>
              )}
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Visualization style"
          className="inline-flex rounded-md border border-border bg-hover/40 p-0.5"
        >
          {VIEW_ORDER.map((v) => {
            const active = v === view;
            return (
              <button
                key={v}
                role="tab"
                aria-selected={active}
                onClick={() => setView(v)}
                className={`px-3 py-1 text-[11px] font-semibold uppercase tracking-wide rounded transition-colors ${
                  active
                    ? "bg-brand text-white shadow-sm"
                    : "text-text-muted hover:text-text hover:bg-card/50"
                }`}
              >
                {VIEW_LABEL[v]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Swipe-able body. The 4 views are mounted exclusively (one at a
          time) — a CSS slide-transform would feel nicer but the donut +
          sunburst rely on layout for arc paths, and animating them
          mid-render produces jank. A short fade is cheaper and stays
          smooth at 60fps. */}
      <div
        className="min-h-[260px]"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div
          key={view}
          className="animate-in fade-in duration-200"
          aria-live="polite"
        >
          {view === "donut" && (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-6 items-center">
              <div className="flex flex-col items-center">
                <DonutChart
                  slices={budgetSlices}
                  size={580}
                  centerTopLabel="Budget"
                  centerValue={totalBudget}
                  centerBottomLabel={`${budgetSlices.length} categor${budgetSlices.length === 1 ? "y" : "ies"}`}
                  formatValue={fmtCents}
                  ariaLabel={`Budget allocation across ${budgetSlices.length} categories totalling ${fmtCents(totalBudget)}`}
                  emptyMessage="No budgets set yet"
                  onSliceClick={onDonutSliceClick}
                  onCenterClick={() =>
                    openAllCategories("All budgeted categories this month")
                  }
                />
              </div>
              <div className="flex flex-col items-center">
                <DonutChart
                  slices={spentSlices}
                  size={580}
                  centerTopLabel="Spent"
                  centerValue={totalSpent}
                  centerBottomLabel={`${spentSlices.length} categor${spentSlices.length === 1 ? "y" : "ies"}`}
                  formatValue={fmtCents}
                  ariaLabel={`Actual spend across ${spentSlices.length} categories totalling ${fmtCents(totalSpent)}`}
                  emptyMessage="No spending yet"
                  onSliceClick={onDonutSliceClick}
                  onCenterClick={() =>
                    openAllCategories("All spending this month")
                  }
                />
              </div>
            </div>
          )}

          {view === "bars" && (
            <BudgetBarChart
              rows={flatRows}
              totalSpent={totalSpent}
              onCategoryClick={onBarRowClick}
            />
          )}

          {view === "treemap" && (
            <div className="flex justify-center">
              <BudgetTreemap
                cells={treemapCells}
                width={Math.max(320, containerWidth - 40)}
                height={420}
                onCategoryClick={onTreemapClick}
              />
            </div>
          )}

          {view === "sunburst" && (
            <div className="flex justify-center">
              <BudgetSunburst
                leaves={sunburstLeaves}
                size={360}
                onCategoryClick={onSunburstLeafClick}
                onGroupClick={onSunburstGroupClick}
              />
            </div>
          )}
        </div>
      </div>

      {/* Legend — always visible below all views. Rows are click-to-open
          so even when you're in donut view you can drill in from the
          textual list. */}
      <div className="mt-5 pt-4 border-t border-border">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted mb-2">
          Categories — click a row to see transactions
        </div>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          {legendRows.map((r) => {
            const over =
              r.budget_cents > 0 && r.spent_cents > r.budget_cents;
            return (
              <li key={r.category_id}>
                <button
                  type="button"
                  onClick={() => onBarRowClick(r)}
                  className="w-full flex items-center justify-between gap-2 px-1 py-1.5 text-left rounded hover:bg-hover focus:outline-none focus:bg-hover focus:ring-2 focus:ring-brand/30 transition-colors"
                  aria-label={`${r.name}: ${fmtCents(r.spent_cents)} spent${r.budget_cents > 0 ? ` of ${fmtCents(r.budget_cents)} budget` : ""}. Click for transactions.`}
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span
                      aria-hidden="true"
                      className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                      style={{ backgroundColor: r.color }}
                    />
                    <span className="text-xs text-text truncate">
                      {r.name}
                    </span>
                    {r.isUnbudgeted && (
                      <span className="ml-1 inline-block px-1 py-0.5 rounded-sm bg-gray-100 text-text-muted text-[9px] font-semibold uppercase tracking-wide flex-shrink-0">
                        unbudgeted
                      </span>
                    )}
                    {momCompare?.[String(r.category_id)] && (
                      <MoMChip
                        current_cents={momCompare[String(r.category_id)][0]}
                        avg_cents={momCompare[String(r.category_id)][1]}
                      />
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div
                      className={`text-xs tabular-nums font-semibold ${
                        over ? "text-outflow" : "text-text"
                      }`}
                    >
                      {fmtCents(r.spent_cents)}
                    </div>
                    {r.budget_cents > 0 && (
                      <div className="text-[10px] text-text-soft tabular-nums">
                        of {fmtCents(r.budget_cents)}
                      </div>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Drawer (mounted at panel-level so click from any view works) */}
      <CategoryDrawer
        open={drawerOpen}
        categoryId={drawerCategoryId}
        categoryIds={drawerCategoryIds}
        categoryName={drawerCategoryName}
        monthStart={monthStart}
        swatchColor={drawerSwatch}
        totalSpentCents={drawerSpent}
        totalBudgetCents={drawerBudget}
        /* Pass rent-attributed prior-month txn IDs only when the user is
           opening a Rent/Mortgage/Housing drawer. Otherwise irrelevant
           and might spuriously include the Apr 30 Zelle in unrelated
           categories. Name-based match keeps it simple. */
        extraTxIds={
          rentAttributedTxIds && /rent|mortgage|housing/i.test(drawerCategoryName)
            ? rentAttributedTxIds
            : undefined
        }
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
