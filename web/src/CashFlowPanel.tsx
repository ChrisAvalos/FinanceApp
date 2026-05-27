/**
 * Cash-flow forecast panel — Phase 7.2.
 *
 * Rolling N-day forecast: subscriptions + bills + paychecks + a
 * starting balance. Surfaces "crunch days" where the running balance
 * would drop below a threshold so Chris can pre-empt overdrafts.
 *
 * Visual: per-day chart with a running-balance line and event pins
 * + a list of upcoming events.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents, type DailyForecastPoint, type CashFlowEvent } from "./api/client";
import PanelLoading from "./components/PanelLoading";
import PanelError from "./components/PanelError";
import SyncFreshnessChip from "./components/SyncFreshness";

function fmtShortDate(iso: string): string {
  // Parse YYYY-MM-DD as a LOCAL date. `new Date("2026-05-29")` parses as
  // UTC midnight, which renders as the PREVIOUS day in US time zones —
  // every event date in this panel was showing a day early.
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function BalanceChart({ daily, crunchDays }: { daily: DailyForecastPoint[]; crunchDays: string[] }) {
  if (daily.length === 0) return null;
  const balances = daily.map((d) => d.running_balance_cents);
  const min = Math.min(0, ...balances);
  const max = Math.max(...balances, 0);
  const range = max - min || 1;
  const w = 800;
  const h = 160;
  const padX = 30;
  const innerW = w - padX * 2;
  const innerH = h - 30;

  const points = daily.map((d, i) => {
    const x = padX + (i / (daily.length - 1)) * innerW;
    const y = 10 + innerH - ((d.running_balance_cents - min) / range) * innerH;
    return { x, y, d };
  });
  const line = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  // Zero line
  const zeroY = 10 + innerH - ((0 - min) / range) * innerH;
  const crunchSet = new Set(crunchDays);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-40" role="img" aria-labelledby="cashflow-chart-title">
      <title id="cashflow-chart-title">Cash flow projection — running balance over next 30 days</title>
      <line x1={padX} y1={zeroY} x2={w - padX} y2={zeroY} stroke="#cbd5e1" strokeDasharray="3 3" />
      <polyline points={line} fill="none" stroke="#2563eb" strokeWidth="2" />
      {points.map((p) => {
        const isCrunch = crunchSet.has(p.d.on_date);
        if (!isCrunch) return null;
        return (
          <circle key={p.d.on_date} cx={p.x} cy={p.y} r="4" fill="#dc2626" />
        );
      })}
      <text x={padX} y={10} fontSize="10" fill="#64748b">{fmtCents(max)}</text>
      <text x={padX} y={h - 10} fontSize="10" fill="#64748b">{fmtCents(min)}</text>
    </svg>
  );
}

function EventRow({ e }: { e: CashFlowEvent }) {
  const isOutflow = e.amount_cents < 0;
  return (
    <li className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border last:border-0 text-xs">
      <span className="text-text-muted whitespace-nowrap w-20">{fmtShortDate(e.on_date)}</span>
      <span className="px-1.5 py-0.5 rounded-sm bg-slate-50 text-text-muted text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap">
        {e.kind}
      </span>
      <span className="flex-1 truncate">{e.label}</span>
      <span className={`tabular-nums font-semibold ${isOutflow ? "text-outflow" : "text-inflow"}`}>
        {isOutflow ? "" : "+"}{fmtCents(e.amount_cents)}
      </span>
    </li>
  );
}

export default function CashFlowPanel() {
  const [days, setDays] = useState(30);
  const forecast = useQuery({
    queryKey: ["cashFlowForecast", days],
    queryFn: () => api.cashFlowForecast(days),
  });

  const sortedEvents = useMemo(() => {
    return (forecast.data?.events ?? []).slice().sort((a, b) => a.on_date.localeCompare(b.on_date));
  }, [forecast.data]);

  if (forecast.isLoading) {
    return <PanelLoading label="Loading cash-flow forecast…" />;
  }
  if (forecast.isError) {
    return (
      <PanelError
        title="Couldn't compute cash-flow forecast."
        error={forecast.error}
        onRetry={() => forecast.refetch()}
      />
    );
  }
  if (!forecast.data) return null;

  const f = forecast.data;
  const crunch = f.crunch_days.length;

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip syncedAt={f.generated_at ?? null} label="Forecast computed" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Starting balance</div>
          <div
            className="text-2xl font-semibold tabular-nums mt-1 text-text"
            title="Every liquid account — checking + savings + cash. The Budgets panel's 'Available cash' is a narrower lens (checking only, since savings holds goal money), so the two won't match."
          >
            {fmtCents(f.starting_balance_cents)}
          </div>
          <div className="text-[11px] text-text-soft mt-0.5">
            Checking + savings · as of today
          </div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Forecast events</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">{f.events.length}</div>
          <div className="text-[11px] text-text-soft mt-0.5">Across {f.window_start} → {f.window_end}</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Paycheck cadence</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
            {f.paycheck_cadence_days ? `${f.paycheck_cadence_days}d` : "—"}
          </div>
          <div className="text-[11px] text-text-soft mt-0.5">
            {f.paycheck_cadence_confidence > 0 ? `${Math.round(f.paycheck_cadence_confidence * 100)}% confident` : "Need more history"}
          </div>
        </div>
        <div className={`bg-card border-2 ${crunch > 0 ? "border-outflow" : "border-border"} rounded-md p-4 shadow-card`}>
          <div className="text-xs text-text-muted uppercase tracking-wide">Crunch days</div>
          <div className={`text-2xl font-semibold tabular-nums mt-1 ${crunch > 0 ? "text-outflow" : "text-inflow"}`}>{crunch}</div>
          <div className="text-[11px] text-text-soft mt-0.5">
            {crunch > 0 ? "Balance dips below threshold" : "No projected dips"}
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-md shadow-card mb-5">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-slate-50">
          <h3 className="text-sm font-semibold text-text">Running balance · next {days} days</h3>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="px-2 py-1 text-xs border border-border rounded bg-card">
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
          </select>
        </div>
        <div className="p-4">
          <BalanceChart daily={f.daily} crunchDays={f.crunch_days} />
          <div className="text-[11px] text-text-soft mt-1">
            Red dots = days the running balance is projected to dip below the crunch threshold.
          </div>
          {f.variable_spend_monthly_cents ? (
            <div className="text-[11px] text-text-soft mt-1">
              Running balance also subtracts everyday variable spending —
              ~{fmtCents(f.variable_spend_monthly_cents)}/mo (~
              {fmtCents(f.variable_spend_daily_cents ?? 0)}/day), your 90-day
              average excluding the bills &amp; subscriptions listed below.
            </div>
          ) : null}
        </div>
      </div>

      <div className="bg-card border border-border rounded-md shadow-card">
        <div className="px-4 py-2 border-b border-border bg-slate-50">
          <h3 className="text-sm font-semibold text-text">Upcoming events ({sortedEvents.length})</h3>
        </div>
        {sortedEvents.length === 0 ? (
          <div className="p-6 text-center text-sm text-text-muted">
            No forecast events in this window.
            <div className="text-xs text-text-soft mt-2">
              Forecast events come from confirmed subscriptions and detected
              recurring bills. Run subscription detection on the{" "}
              <a href="#subscriptions" className="text-brand hover:underline">
                Subscriptions panel
              </a>{" "}
              to populate this view.
            </div>
          </div>
        ) : (
          <ul>
            {sortedEvents.map((e, i) => <EventRow key={i} e={e} />)}
          </ul>
        )}
      </div>

      {/* Sprint 40 — annual renewals beyond the 30-day forecast.
          Without this section the user can't see ESPN+ (Sep 12),
          Truthly (Jun 18), Settlemate (Jul 24) etc. coming up because
          they fall outside the rolling 30-day window. */}
      <ComingUpAnnuals />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ComingUpAnnuals — Sprint 40                                        */
/*  Annual subscription renewals 1–12 months out, sorted by date.      */
/*  Self-hides when there are zero annuals projected — most users      */
/*  without unmasked Apple/Google children won't have any.             */
/* ------------------------------------------------------------------ */

function ComingUpAnnuals() {
  const q = useQuery({
    queryKey: ["upcoming-annuals", 365],
    queryFn: () => api.upcomingAnnuals(365),
    staleTime: 5 * 60 * 1000,
  });
  if (!q.data || q.data.events.length === 0) return null;
  const total = q.data.total_outflow_cents;
  // Group events by month for scan-ability ("everything in June" >
  // "Truthly, then Settlemate, then ESPN+").
  const byMonth = new Map<string, typeof q.data.events>();
  for (const e of q.data.events) {
    // YYYY-MM key. Calendar locale defaults are fine here — the
    // backend already sorted by date asc so insertion order is right.
    const k = e.on_date.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k)!.push(e);
  }
  const monthLabel = (k: string) => {
    const [yyyy, mm] = k.split("-");
    const d = new Date(Number(yyyy), Number(mm) - 1, 1);
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  };
  return (
    <div className="bg-card border border-border rounded-md shadow-card mt-5">
      <div className="px-4 py-2 border-b border-border bg-slate-50 flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text">
            Coming up — annual renewals
          </h3>
          <p className="text-[11px] text-text-muted mt-0.5">
            Next 12 months · charges that aren't in the 30-day forecast yet
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs text-text-soft uppercase tracking-wide">
            12-mo total
          </div>
          <div className="text-base font-semibold text-warn tabular-nums">
            {fmtCents(-total)}
          </div>
        </div>
      </div>
      <div className="divide-y divide-border">
        {Array.from(byMonth.entries()).map(([month, events]) => (
          <div key={month}>
            <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-soft bg-card/40">
              {monthLabel(month)}
            </div>
            <ul>
              {events.map((e, i) => (
                <li
                  key={`${e.subscription_id ?? "?"}-${e.on_date}-${i}`}
                  className="px-4 py-2 flex items-center gap-3 border-t border-border first:border-t-0"
                >
                  <div className="text-xs text-text-muted tabular-nums w-16">
                    {fmtShortDate(e.on_date)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text truncate">{e.label}</div>
                    <div className="text-[11px] text-text-soft tabular-nums">
                      in {e.days_out} day{e.days_out === 1 ? "" : "s"}
                      {e.confidence < 0.7 && (
                        <span className="ml-2 text-warn">
                          · {Math.round(e.confidence * 100)}% confidence
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-sm tabular-nums font-semibold text-outflow">
                    {fmtCents(e.amount_cents)}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="px-4 py-2 text-[11px] text-text-soft italic border-t border-border bg-slate-50">
        Tip: pair this with the Subscriptions panel's "unmask" flow on
        Apple / Google children to surface every annual you actually pay.
      </div>
    </div>
  );
}
