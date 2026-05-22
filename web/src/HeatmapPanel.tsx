/**
 * Spending heatmap — Phase 9.4.
 *
 * GitHub-style calendar grid: one cell per day, color-shaded by
 * outflow. Reveals the patterns most apps don't surface: weekend vs
 * weekday contrast, "dry-run" days, biggest spend day, etc.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents, type HeatmapDay } from "./api/client";
import PanelError from "./components/PanelError";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelBlock } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";

const DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function shadeFor(cents: number, max: number): string {
  if (cents === 0) return "bg-slate-100";
  const ratio = Math.min(1, cents / Math.max(max, 1));
  if (ratio < 0.2) return "bg-emerald-100";
  if (ratio < 0.4) return "bg-emerald-200";
  if (ratio < 0.6) return "bg-emerald-400";
  if (ratio < 0.8) return "bg-emerald-600";
  return "bg-emerald-800";
}

function Cell({ d, max }: { d: HeatmapDay; max: number }) {
  const tooltip = `${d.on_date}\n${fmtCents(d.total_outflow_cents)} out · ${d.txn_count} txn${d.txn_count === 1 ? "" : "s"}`;
  return (
    <div
      className={`w-3 h-3 rounded-sm ${shadeFor(d.total_outflow_cents, max)} hover:ring-2 hover:ring-brand`}
      title={tooltip}
    />
  );
}

function HeatGrid({ days }: { days: HeatmapDay[] }) {
  // Group by week (Monday start). Each column = a week.
  const max = Math.max(...days.map((d) => d.total_outflow_cents), 1);
  const weeks: (HeatmapDay | null)[][] = [];
  let current: (HeatmapDay | null)[] = new Array(7).fill(null);
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
    } else {
      current[d.day_of_week] = d;
      if (d.day_of_week === 6) {
        weeks.push(current);
        current = new Array(7).fill(null);
      }
    }
  }
  if (current.some((c) => c)) weeks.push(current);

  return (
    <div className="flex gap-1">
      <div className="flex flex-col gap-1 pr-1 text-[9px] text-text-soft">
        {DOW_LABELS.map((l) => <div key={l} className="h-3">{l}</div>)}
      </div>
      <div className="flex gap-1 overflow-x-auto pb-1">
        {weeks.map((w, wi) => (
          <div key={wi} className="flex flex-col gap-1">
            {w.map((d, di) => d ? <Cell key={di} d={d} max={max} /> : <div key={di} className="w-3 h-3" />)}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HeatmapPanel() {
  const [days, setDays] = useState(90);
  const heat = useQuery({ queryKey: ["heatmap", days], queryFn: () => api.heatmapDaily(days) });

  const stats = heat.data?.stats;
  const busiestDow = useMemo(() => stats ? DOW_LABELS[stats.busiest_day_of_week] : "—", [stats]);
  const quietestDow = useMemo(() => stats ? DOW_LABELS[stats.quietest_day_of_week] : "—", [stats]);

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip syncedAt={heat.data?.generated_at ?? null} label="Heatmap built" />
      </div>
      {heat.isLoading ? (
        <SkelHeroRow count={4} />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Busiest day</div>
            <div className="text-2xl font-semibold mt-1 text-text">{busiestDow}</div>
            <div className="text-[11px] text-text-soft mt-0.5">
              avg <CountUp value={stats?.busiest_dow_avg_cents ?? 0} format={fmtCents} />
            </div>
          </div>
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Quietest day</div>
            <div className="text-2xl font-semibold mt-1 text-text">{quietestDow}</div>
            <div className="text-[11px] text-text-soft mt-0.5">
              avg <CountUp value={stats?.quietest_dow_avg_cents ?? 0} format={fmtCents} />
            </div>
          </div>
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Weekend vs weekday</div>
            <div className="text-base font-semibold mt-1 text-text tabular-nums">
              <CountUp value={stats?.weekend_avg_cents ?? 0} format={fmtCents} /> /{" "}
              <CountUp value={stats?.weekday_avg_cents ?? 0} format={fmtCents} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">avg per day</div>
          </div>
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Biggest single day</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-warn">
              <CountUp value={stats?.biggest_single_day_cents ?? 0} format={fmtCents} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">{stats?.biggest_single_day || "—"}</div>
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-md shadow-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-text">
            Daily spend ·{" "}
            <span className="text-text-muted font-normal">
              {stats?.days_with_spend ?? 0} of {stats?.total_days ?? 0} days had spend
            </span>
          </h3>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="px-2 py-1 text-xs border border-border rounded bg-card">
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>1 year</option>
          </select>
        </div>
        {heat.isLoading ? (
          // A wide rectangular skeleton roughly the size of the
          // heatmap grid — keeps page height stable while the days
          // query resolves.
          <SkelBlock h="h-24" className="rounded-md" />
        ) : heat.isError ? (
          <PanelError
            title="Couldn't load the heatmap."
            error={heat.error}
            onRetry={() => heat.refetch()}
            compact
          />
        ) : (
          <HeatGrid days={heat.data?.days ?? []} />
        )}
        <div className="flex items-center justify-end gap-2 mt-3 text-[11px] text-text-soft">
          <span>Less</span>
          <div className="w-3 h-3 rounded-sm bg-slate-100" />
          <div className="w-3 h-3 rounded-sm bg-emerald-100" />
          <div className="w-3 h-3 rounded-sm bg-emerald-200" />
          <div className="w-3 h-3 rounded-sm bg-emerald-400" />
          <div className="w-3 h-3 rounded-sm bg-emerald-600" />
          <div className="w-3 h-3 rounded-sm bg-emerald-800" />
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
