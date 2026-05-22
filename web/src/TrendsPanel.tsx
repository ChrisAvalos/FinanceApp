import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  fmtMonthShort,
  type CategoryTrendRow,
  type MonthOutflowCell,
  type Transaction,
} from "./api/client";
import { SkelHeroRow, SkelTableRow, SkelBlock } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";

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
function describeSlice(cx: number, cy: number, r: number, start: number, end: number): string {
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
function PieSlices({
  data,
  selectedCategoryId,
  onSliceClick,
}: {
  data: { category_id: number | null; category_name: string | null; cents: number; color: string }[];
  selectedCategoryId: number | null | "none";
  onSliceClick: (categoryId: number | null) => void;
}) {
  const total = data.reduce((s, d) => s + d.cents, 0);
  if (total === 0) {
    return (
      <div className="flex items-center justify-center w-[260px] h-[260px] text-sm text-text-soft">
        No spend in this window.
      </div>
    );
  }

  let cum = 0;
  return (
    <svg viewBox="0 0 220 220" width={260} height={260} aria-label="Spending by category">
      {data.map((d) => {
        const start = (cum / total) * 2 * Math.PI;
        cum += d.cents;
        const end = (cum / total) * 2 * Math.PI;
        const isSelected = selectedCategoryId === d.category_id;
        // Selected slice gets a slight outward expansion via a larger
        // radius. We keep the math simple — same center, just bump r.
        const r = isSelected ? 100 : 95;
        const dim =
          selectedCategoryId !== "none" && !isSelected ? 0.35 : 1;
        const path = describeSlice(110, 110, r, start, end);
        const pct = ((d.cents / total) * 100).toFixed(1);
        return (
          <path
            key={String(d.category_id ?? "uncat")}
            d={path}
            fill={d.color}
            stroke="white"
            strokeWidth={2}
            opacity={dim}
            style={{ cursor: "pointer", transition: "opacity 120ms ease, d 120ms ease" }}
            onClick={() => onSliceClick(d.category_id)}
          >
            <title>
              {d.category_name ?? "(uncategorized)"}: {fmtCents(d.cents)} · {pct}%
            </title>
          </path>
        );
      })}
    </svg>
  );
}

/** Aggregate the MoM data into a slice list for either a single month
 *  index or the cumulative window. Categories are ranked by descending
 *  cents; the long tail beyond SLICE_COLORS.length collapses into a
 *  single "Other" bucket so the chart never gets dozens of look-alike
 *  slivers. */
function buildSliceData(
  categories: CategoryTrendRow[],
  monthIndex: number | "all",
  monthsLength: number,
): { category_id: number | null; category_name: string | null; cents: number; color: string }[] {
  const totals = categories
    .map((c) => {
      const cents =
        monthIndex === "all"
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
function fmtMonthPill(monthStart: string): string {
  return fmtMonthShort(monthStart);
}

/** Determine a [start_date, end_date] window for the API filter when
 *  the user clicks a slice. "all" mode uses the full window from first
 *  month to last month; otherwise we use the selected month's range. */
function dateRangeFor(months: MonthOutflowCell[], monthIndex: number | "all"): {
  start_date: string;
  end_date: string;
} | null {
  if (months.length === 0) return null;
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
  if (!m) return null;
  const startDate = m.month_start;
  const lastDay = new Date(startDate);
  lastDay.setMonth(lastDay.getMonth() + 1);
  lastDay.setDate(0);
  return { start_date: startDate, end_date: lastDay.toISOString().slice(0, 10) };
}

function CategorySharePie({ months, categories }: { months: MonthOutflowCell[]; categories: CategoryTrendRow[] }) {
  // "all" = aggregate the whole window; number = a single month index.
  const [monthIndex, setMonthIndex] = useState<number | "all">("all");
  // category_id of the selected slice (or null for an uncategorized slice,
  // or "none" when nothing's selected — distinguishing null-the-id from
  // null-the-state matters here).
  const [selectedCat, setSelectedCat] = useState<number | null | "none">("none");

  const slices = useMemo(
    () => buildSliceData(categories, monthIndex, months.length),
    [categories, monthIndex, months.length],
  );
  const total = slices.reduce((s, d) => s + d.cents, 0);

  const range = dateRangeFor(months, monthIndex);
  // Drill-in transaction list — only fetches when the user has actually
  // clicked a slice. The catch-all "none" sentinel keeps the query off.
  const drillTxns = useQuery({
    queryKey: ["trendsPieDrill", monthIndex, selectedCat, range?.start_date, range?.end_date],
    queryFn: () => {
      if (selectedCat === "none" || !range) return Promise.resolve([] as Transaction[]);
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

  return (
    <div className="bg-card border border-border rounded-md shadow-card p-5">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h3 className="text-sm font-semibold text-text">Category share — click a slice to drill in</h3>
        <span className="text-xs text-text-muted tabular-nums">
          Total {fmtCents(total)}
        </span>
      </div>

      {/* Month picker pills. "Overall" selected by default; clicking a
          month switches the pie to that single month's breakdown. */}
      <div className="flex items-center gap-1.5 flex-wrap mb-4">
        <button
          onClick={() => {
            setMonthIndex("all");
            setSelectedCat("none");
          }}
          className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
            monthIndex === "all"
              ? "border-brand text-brand-navy bg-brand/5 font-semibold"
              : "border-border text-text-muted hover:border-text-muted"
          }`}
        >
          Overall
        </button>
        {months.map((m, i) => (
          <button
            key={m.month_start}
            onClick={() => {
              setMonthIndex(i);
              setSelectedCat("none");
            }}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
              monthIndex === i
                ? "border-brand text-brand-navy bg-brand/5 font-semibold"
                : "border-border text-text-muted hover:border-text-muted"
            }`}
          >
            {fmtMonthPill(m.month_start)}
          </button>
        ))}
      </div>

      <div className="flex items-start gap-6 flex-wrap">
        {/* Pie itself */}
        <PieSlices
          data={slices}
          selectedCategoryId={selectedCat}
          onSliceClick={(cid) => setSelectedCat((prev) => (prev === cid ? "none" : cid))}
        />

        {/* Legend — also acts as a click target list. Mirrors the slice
            colors and amounts. Clicking a legend row toggles the slice
            selection just like clicking the slice itself. */}
        <div className="flex-1 min-w-[260px] space-y-1">
          {slices.length === 0 && (
            <div className="text-sm text-text-muted">
              No spend in this window — pick a different month or run
              categorization.
            </div>
          )}
          {slices.map((s) => {
            const pct = total > 0 ? ((s.cents / total) * 100).toFixed(1) : "0.0";
            const isSelected = s.category_id === selectedCat;
            return (
              <button
                key={String(s.category_id ?? "uncat")}
                onClick={() =>
                  setSelectedCat((prev) => (prev === s.category_id ? "none" : s.category_id))
                }
                className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left text-xs transition-colors ${
                  isSelected ? "bg-hover" : "hover:bg-hover"
                }`}
              >
                <span
                  className="inline-block w-3 h-3 rounded-sm shrink-0"
                  style={{ background: s.color }}
                  aria-hidden="true"
                />
                <span
                  className={`flex-1 truncate ${isSelected ? "font-semibold text-text" : "text-text-muted"}`}
                >
                  {s.category_name ?? "(uncategorized)"}
                </span>
                <span className="tabular-nums text-text-soft">{pct}%</span>
                <span className="tabular-nums text-text font-semibold w-20 text-right">
                  {fmtCents(s.cents)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Drill-in: transactions for the selected slice × selected month */}
      {selectedSlice && (
        <div className="mt-4 pt-4 border-t border-border">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-semibold text-text">
              <span
                className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle"
                style={{ background: selectedSlice.color }}
              />
              {selectedSlice.category_name ?? "(uncategorized)"}
              <span className="text-text-muted font-normal ml-2">
                · {monthIndex === "all" ? "All months" : fmtMonthPill(months[monthIndex].month_start)}
                {" · "}
                {fmtCents(selectedSlice.cents)}
              </span>
            </h4>
            <button
              onClick={() => setSelectedCat("none")}
              className="text-xs text-text-muted hover:text-text"
            >
              Close ×
            </button>
          </div>
          {drillTxns.isLoading && (
            <div className="text-xs text-text-muted py-3">Loading transactions…</div>
          )}
          {drillTxns.data && drillTxns.data.length === 0 && !drillTxns.isLoading && (
            <div className="text-xs text-text-muted py-3 italic">
              The slice value is from aggregated rollups; individual
              transactions weren't returned for this filter (the matcher
              uses category_id which can be null for the "uncategorized"
              slice — try a different slice or "Overall").
            </div>
          )}
          {drillTxns.data && drillTxns.data.length > 0 && (
            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-text-muted uppercase tracking-wide text-[10px] font-semibold">
                    <th className="px-2 py-1.5 text-left">Date</th>
                    <th className="px-2 py-1.5 text-left">Description</th>
                    <th className="px-2 py-1.5 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {drillTxns.data.map((t) => (
                    <tr key={t.id} className="border-t border-border hover:bg-hover">
                      <td className="px-2 py-1.5 text-text-muted whitespace-nowrap">
                        {t.posted_date}
                      </td>
                      <td className="px-2 py-1.5">{t.description_raw}</td>
                      <td
                        className={`px-2 py-1.5 text-right tabular-nums font-semibold ${
                          t.amount_cents < 0 ? "text-outflow" : "text-inflow"
                        }`}
                      >
                        {fmtCents(t.amount_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {drillTxns.data.length === 50 && (
                <div className="text-[11px] text-text-soft mt-2 italic">
                  Showing first 50 — open the Transactions panel for the full
                  list with bulk actions.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

// Sprint 36 — cap the displayed trend % at ±_TREND_DISPLAY_CAP. Even
// after the backend sample-size guard (≥ 3 txns), pro-rating partial
// in-progress months can produce +321% / +250% projections that look
// alarming next to a $20 average. Numbers above the cap render as
// "≥+200%" instead of the literal value — same color signal, same
// directional info, much less false-alarm.
const _TREND_DISPLAY_CAP = 200;

function trendLabel(pct: number | null): {
  text: string;
  cls: string;
} {
  if (pct == null) return { text: "—", cls: "text-text-soft" };
  if (Math.abs(pct) < 1) return { text: "flat", cls: "text-text-muted" };
  if (pct > _TREND_DISPLAY_CAP) {
    return { text: `≥+${_TREND_DISPLAY_CAP}%`, cls: "text-outflow" };
  }
  if (pct < -_TREND_DISPLAY_CAP) {
    return { text: `≤−${_TREND_DISPLAY_CAP}%`, cls: "text-inflow" };
  }
  if (pct > 0) return { text: `+${pct.toFixed(1)}%`, cls: "text-outflow" };
  return { text: `${pct.toFixed(1)}%`, cls: "text-inflow" };
}

/* ------------------------------------------------------------------ */
/*  Mini bar chart — one row, N months                                 */
/* ------------------------------------------------------------------ */

function MiniBars({
  series,
  maxAcross,
}: {
  series: number[];
  maxAcross: number; // max value across this row, so bars are self-scaled
}) {
  const max = Math.max(1, maxAcross);
  return (
    <div className="flex items-end gap-0.5 h-8">
      {series.map((v, i) => {
        const h = Math.max(2, (v / max) * 100);
        const latest = i === series.length - 1;
        return (
          <div
            key={i}
            className={`flex-1 rounded-sm ${latest ? "bg-brand" : "bg-brand/40"}`}
            style={{ height: `${h}%` }}
            title={fmtCents(v)}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Overall month totals chart                                         */
/* ------------------------------------------------------------------ */

function TotalsChart({ months }: { months: MonthOutflowCell[] }) {
  const max = Math.max(1, ...months.map((m) => m.outflow_cents));
  return (
    <div className="bg-card border border-border rounded-md shadow-card p-5">
      <div className="text-xs text-text-muted uppercase tracking-wide mb-3">
        Total outflow per month
      </div>
      {/* Outer container uses default items-stretch (NOT items-end!) so
          each column fills the 128px height. Each column itself is a
          flex-col where the bar wrapper grows (flex-1) and the text
          labels sit at the bottom. The bar wrapper has its own
          items-end to anchor the bar to the bottom of the available
          vertical space — that's where the visual "bar grows up from
          the bottom" behavior actually comes from. (Earlier `items-end`
          on the outer caused columns to shrink to text-only height,
          collapsing the inner flex-1 to 0px and rendering invisible bars.) */}
      <div className="flex gap-3 h-32">
        {months.map((m, i) => {
          const h = (m.outflow_cents / max) * 100;
          const latest = i === months.length - 1;
          return (
            <div key={m.month_start} className="flex-1 flex flex-col items-center">
              <div className="w-full flex-1 flex items-end">
                <div
                  className={`w-full rounded-t-sm ${latest ? "bg-brand" : "bg-brand/60"}`}
                  style={{ height: `${Math.max(2, h)}%` }}
                  title={fmtCents(m.outflow_cents)}
                />
              </div>
              <div className="text-[10px] text-text-soft mt-1 tabular-nums">
                {fmtMonthShort(m.month_start)}
              </div>
              <div className="text-[10px] text-text font-semibold tabular-nums">
                {fmtCents(m.outflow_cents)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */

const WINDOW_OPTIONS: { label: string; months: number }[] = [
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
function pctThroughCurrentMonth(now: Date = new Date()): number {
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  // Count today as fully consumed (a transaction posted today is in
  // the bucket already), so use day-of-month / total-days * 100 with
  // a +1 cap so the last day shows 100% rather than 96.7%.
  const dayOfMonth = now.getDate();
  return Math.min(100, Math.round((dayOfMonth / lastDay) * 100));
}

export default function TrendsPanel() {
  const [months, setMonths] = useState<number>(6);
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
      .sort(
        (a, b) =>
          Math.abs(b.trend_pct_vs_avg ?? 0) - Math.abs(a.trend_pct_vs_avg ?? 0)
      )
      .slice(0, 3);
  }, [categories]);

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <SyncFreshnessChip syncedAt={mom.data?.generated_at ?? null} label="Trend computed" />
      </div>
      {/* ---- Controls ---- */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-text-muted">
            Outflow per category across the last {months} months. The rightmost
            bar in each row is the most recent (current) month — compare it
            against the average of the prior months to see what's moving.
          </p>
        </div>
        <div className="flex gap-1">
          {WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.months}
              onClick={() => setMonths(opt.months)}
              className={`px-3 py-1.5 text-xs font-semibold rounded border transition-colors ${
                months === opt.months
                  ? "border-brand bg-brand text-white"
                  : "border-border bg-card text-text-muted hover:border-brand hover:text-brand"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* While the month-over-month query is in flight, render a
          shape-matched placeholder for the highlights row + chart so
          the page doesn't shift when data lands. */}
      {mom.isLoading && (
        <>
          <SkelHeroRow count={3} />
          <SkelBlock h="h-44" className="rounded-md" />
        </>
      )}

      {/* ---- Highlights ---- */}
      {topSwings.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {topSwings.map((c) => {
            const t = trendLabel(c.trend_pct_vs_avg);
            return (
              <div
                key={`${c.category_id}-${c.category_name}`}
                className="bg-card border border-border rounded-md shadow-card p-4"
              >
                <div className="text-xs text-text-muted uppercase tracking-wide">
                  {c.category_name ?? "(uncategorized)"}
                </div>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className={`text-2xl font-semibold ${t.cls}`}>
                    {t.text}
                  </span>
                  <span className="text-xs text-text-muted">vs. trailing avg</span>
                </div>
                <div className="text-xs text-text-soft mt-1">
                  Latest{" "}
                  <span className="text-text font-semibold">
                    {fmtCents(c.outflow_by_month_cents.at(-1) ?? 0)}
                  </span>
                  {" · "}
                  Avg {fmtCents(c.avg_outflow_cents)}
                  {isPartialMonth && (
                    <span className="ml-1 italic text-text-soft">
                      ({pctThroughMonth}% through month)
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ---- Category share pie ---- */}
      {monthsData.length > 0 && categories.length > 0 && (
        <CategorySharePie months={monthsData} categories={categories} />
      )}

      {/* ---- Totals chart ---- */}
      {monthsData.length > 0 && <TotalsChart months={monthsData} />}

      {/* ---- Per-category table ---- */}
      <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
        <div className="px-4 py-3 bg-hover border-b border-border">
          <h3 className="text-sm font-semibold text-text">By category</h3>
          <p className="text-[11px] text-text-muted mt-0.5">
            Biggest average spenders first. Click a row to see the numbers.
          </p>
        </div>
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left w-1/5">Category</th>
              <th className="px-4 py-2 text-left w-1/3">{months}-month trend</th>
              <th className="px-4 py-2 text-right">
                Latest
                {isPartialMonth && (
                  <span className="block text-[9px] font-normal italic text-text-soft normal-case">
                    {pctThroughMonth}% of month
                  </span>
                )}
              </th>
              <th className="px-4 py-2 text-right">Avg</th>
              <th className="px-4 py-2 text-right">vs. avg</th>
            </tr>
          </thead>
          <tbody>
            {mom.isLoading && Array.from({ length: 6 }).map((_, i) => (
              <SkelTableRow key={i} cols={5} />
            ))}
            {mom.data && categories.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-text-muted text-sm max-w-md mx-auto">
                  No spending in the last {months} months. Either run
                  categorization (most likely cause), import more
                  transaction history, or pick a longer window above.
                </td>
              </tr>
            )}
            {categories.map((c) => (
              <CategoryRow key={`${c.category_id}-${c.category_name}`} row={c} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CategoryRow({ row }: { row: CategoryTrendRow }) {
  const [open, setOpen] = useState(false);
  const t = trendLabel(row.trend_pct_vs_avg);
  const latest = row.outflow_by_month_cents.at(-1) ?? 0;
  const maxAcross = Math.max(...row.outflow_by_month_cents);
  return (
    <>
      <tr
        onClick={() => setOpen((o) => !o)}
        className="border-b border-border last:border-0 hover:bg-hover cursor-pointer"
      >
        <td className="px-4 py-3 text-sm font-medium">
          {row.category_name ?? (
            <span className="text-text-soft italic">(uncategorized)</span>
          )}
        </td>
        <td className="px-4 py-3">
          <MiniBars
            series={row.outflow_by_month_cents}
            maxAcross={maxAcross}
          />
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-sm font-semibold text-outflow">
          {fmtCents(latest)}
        </td>
        <td className="px-4 py-3 text-right tabular-nums text-sm text-text-muted">
          {fmtCents(row.avg_outflow_cents)}
        </td>
        <td
          className={`px-4 py-3 text-right tabular-nums text-sm font-semibold ${t.cls}`}
        >
          {t.text}
        </td>
      </tr>
      {open && (
        <tr className="bg-hover/40">
          <td colSpan={5} className="px-4 py-3 text-xs text-text-muted">
            <div className="flex gap-4 flex-wrap">
              {row.outflow_by_month_cents.map((v, i) => (
                <div key={i} className="flex flex-col items-center min-w-[5rem]">
                  <span className="text-[10px] text-text-soft">#{i + 1}</span>
                  <span className="tabular-nums font-semibold text-text">
                    {fmtCents(v)}
                  </span>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
