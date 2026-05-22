/**
 * Investment holdings panel — Phase 9.1.
 *
 * Empower-style portfolio view: total value, unrealized gain, allocation
 * by security type, top holdings table. Manual entry only for now;
 * Plaid investments sync uses the same shape.
 */
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents, type HoldingDetail } from "./api/client";
import EmptyState from "./components/EmptyState";
import PanelError from "./components/PanelError";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelTableRow } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";

function GainCell({ cents, pct }: { cents: number | null; pct: number | null }) {
  if (cents == null) return <span className="text-text-soft">—</span>;
  const tone = cents >= 0 ? "text-inflow" : "text-outflow";
  return (
    <span className={`tabular-nums font-semibold ${tone}`}>
      {cents >= 0 ? "+" : ""}{fmtCents(cents)}
      {pct != null && <span className="ml-1 text-[11px]">({pct >= 0 ? "+" : ""}{pct.toFixed(1)}%)</span>}
    </span>
  );
}

function HoldingRow({ h }: { h: HoldingDetail }) {
  return (
    <tr className="border-b border-border last:border-0 hover:bg-hover">
      <td className="px-4 py-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="font-mono font-semibold text-text">{h.security_ticker || "—"}</span>
          <span className="text-text-muted text-xs truncate">{h.security_name}</span>
        </div>
      </td>
      <td className="px-4 py-2 text-xs text-text-muted">{h.security_type}</td>
      <td className="px-4 py-2 text-right text-sm tabular-nums">{h.quantity.toFixed(4)}</td>
      <td className="px-4 py-2 text-right text-sm tabular-nums">
        {h.latest_price_cents != null ? fmtCents(h.latest_price_cents) : "—"}
      </td>
      <td className="px-4 py-2 text-right text-sm tabular-nums font-semibold">{fmtCents(h.current_value_cents)}</td>
      <td className="px-4 py-2 text-right text-sm">
        <GainCell cents={h.unrealized_gain_cents} pct={h.unrealized_gain_pct} />
      </td>
    </tr>
  );
}

export default function HoldingsPanel() {
  const portfolio = useQuery({ queryKey: ["portfolio"], queryFn: api.portfolio });

  if (portfolio.isLoading) {
    // Layout-shaped skeleton instead of a generic spinner — the page
    // stays stable when data arrives and the user can read what's
    // about to fill in.
    return (
      <div>
        <SkelHeroRow count={4} />
        <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
          <div className="px-4 py-2 border-b border-border bg-slate-50">
            <h3 className="text-sm font-semibold text-text">Top holdings</h3>
          </div>
          <table className="w-full">
            <tbody>
              {Array.from({ length: 6 }).map((_, i) => (
                <SkelTableRow key={i} cols={6} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  if (portfolio.isError) {
    return (
      <PanelError
        title="Couldn't load portfolio."
        error={portfolio.error}
        onRetry={() => portfolio.refetch()}
      />
    );
  }

  if (!portfolio.data || portfolio.data.holdings_count === 0) {
    return (
      <div className="space-y-5">
        <EmptyState
          emoji="🏦"
          title="No holdings yet"
          body={
            <>
              Holdings populate automatically once your brokerage is linked via
              Plaid <span className="font-mono">investments</span>. If your
              Plaid app hasn't been approved for that product yet, link your
              brokerage from Bank connections — Plaid grants the product when
              both the institution supports it AND your app is approved.
            </>
          }
          ctaLabel="Open Bank connections →"
          ctaHref="#connections"
        />

        {/* Sprint 39 — preview tile now leads with a high-contrast
            "DEMO DATA" stamp + an explicit "not yours" sentence so
            the round numbers can't be misread as the user's actual
            portfolio. The audit flagged the prior version as too easy
            to skim past, which would have damaged trust.

            Implementation note: numbers are deliberately round
            ($248,500 / 14 holdings) so even without the stamp, no
            one's real brokerage looks exactly like this. The stamp
            is belt-and-suspenders. */}
        <div className="bg-gradient-to-br from-brand/5 to-inflow/5 border-2 border-dashed border-brand/30 rounded-md p-5 relative overflow-hidden">
          <div className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-wider bg-warn text-white rounded px-2 py-1 shadow-sm">
            Demo data
          </div>
          <h3 className="text-sm font-semibold text-text mb-1">
            Once your brokerage is linked, you'll see…
          </h3>
          <p className="text-xs text-text-muted mb-1">
            Total value, unrealized gain, allocation by type, and a per-position
            table with live Plaid prices. Refreshes whenever you sync.
          </p>
          <p className="text-[11px] text-warn font-medium mb-4">
            The numbers below are illustrative — not your accounts.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="bg-card border border-border rounded-md p-3">
              <div className="text-[10px] text-text-muted uppercase tracking-wide">Total value</div>
              <div className="text-lg font-semibold tabular-nums mt-0.5 text-text">$248,500</div>
            </div>
            <div className="bg-card border border-border rounded-md p-3">
              <div className="text-[10px] text-text-muted uppercase tracking-wide">Cost basis</div>
              <div className="text-lg font-semibold tabular-nums mt-0.5 text-text">$192,140</div>
            </div>
            <div className="bg-card border border-border rounded-md p-3">
              <div className="text-[10px] text-text-muted uppercase tracking-wide">Unrealized gain</div>
              <div className="text-lg font-semibold tabular-nums mt-0.5 text-inflow">+$56,360 <span className="text-xs">(+29.3%)</span></div>
            </div>
            <div className="bg-card border border-border rounded-md p-3">
              <div className="text-[10px] text-text-muted uppercase tracking-wide">Holdings</div>
              <div className="text-lg font-semibold tabular-nums mt-0.5 text-text">14</div>
              <div className="text-[10px] text-text-soft">2 accounts</div>
            </div>
          </div>
          <div className="bg-card border border-border rounded-md p-3 space-y-1.5">
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted w-20">equity</span>
              <div className="flex-1 h-1.5 bg-hover rounded overflow-hidden">
                <div className="h-full bg-brand" style={{ width: "62%" }} />
              </div>
              <span className="text-xs tabular-nums text-text-muted w-10 text-right">62%</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted w-20">etf</span>
              <div className="flex-1 h-1.5 bg-hover rounded overflow-hidden">
                <div className="h-full bg-brand" style={{ width: "28%" }} />
              </div>
              <span className="text-xs tabular-nums text-text-muted w-10 text-right">28%</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-text-muted w-20">crypto</span>
              <div className="flex-1 h-1.5 bg-hover rounded overflow-hidden">
                <div className="h-full bg-brand" style={{ width: "10%" }} />
              </div>
              <span className="text-xs tabular-nums text-text-muted w-10 text-right">10%</span>
            </div>
          </div>
        </div>
      </div>
    );
  }
  const p = portfolio.data;
  // Plain-language greeting: "Your portfolio is up $X (+Y%)" or "down".
  // Lowers the cognitive load on the gain numbers — the user shouldn't
  // have to remember whether green-vs-red means "I made money".
  const gainCents = p.total_unrealized_gain_cents ?? 0;
  const gainPct = p.total_unrealized_gain_pct ?? 0;
  const direction = gainCents >= 0 ? "up" : "down";
  const directionTone = gainCents >= 0 ? "text-inflow" : "text-outflow";

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip syncedAt={p.as_of} label="Plaid prices" />
      </div>
      <div className="bg-card border border-border rounded-md shadow-card mb-5 p-5">
        <h2 className="text-2xl font-semibold text-text leading-snug">
          Hi Chris{" "}
          <span aria-hidden="true">👋</span>
          <span className="block mt-1 text-text-muted text-base font-normal">
            Your portfolio is{" "}
            <span className={`${directionTone} font-semibold`}>
              {direction} {fmtCents(Math.abs(gainCents))}
            </span>
            {" "}
            <span className="text-text-soft">
              ({gainPct >= 0 ? "+" : ""}{gainPct.toFixed(1)}% lifetime)
            </span>
            .
          </span>
        </h2>
        <div className="text-[11px] text-text-soft mt-2">
          Across {p.holdings_count} position{p.holdings_count === 1 ? "" : "s"} in {p.accounts_count} account{p.accounts_count === 1 ? "" : "s"}.
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Total value</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
            <CountUp value={p.total_value_cents} format={fmtCents} />
          </div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Cost basis</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
            <CountUp value={p.total_cost_basis_cents} format={fmtCents} />
          </div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Unrealized gain</div>
          <div className="text-2xl mt-1">
            <GainCell cents={p.total_unrealized_gain_cents} pct={p.total_unrealized_gain_pct} />
          </div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Holdings</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
            <CountUp value={p.holdings_count} format={(n) => String(Math.round(n))} />
          </div>
          <div className="text-[11px] text-text-soft mt-0.5">{p.accounts_count} account{p.accounts_count === 1 ? "" : "s"}</div>
        </div>
      </div>

      {p.allocation_by_type.length > 0 && (
        <div className="bg-card border border-border rounded-md shadow-card mb-5 p-4">
          <h3 className="text-sm font-semibold text-text mb-3">Allocation by type</h3>
          <div className="space-y-2">
            {p.allocation_by_type.map((s) => (
              <div key={s.security_type} className="flex items-center gap-3">
                <span className="text-xs text-text-muted w-24 capitalize">{s.security_type}</span>
                <div className="flex-1 h-2 bg-hover rounded overflow-hidden">
                  <div className="h-full bg-brand" style={{ width: `${Math.min(100, s.pct)}%` }} />
                </div>
                <span className="text-xs tabular-nums text-text font-semibold w-24 text-right">
                  {fmtCents(s.total_value_cents)}
                </span>
                <span className="text-xs tabular-nums text-text-muted w-12 text-right">{s.pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
        <div className="px-4 py-2 border-b border-border bg-slate-50">
          <h3 className="text-sm font-semibold text-text">Top holdings</h3>
        </div>
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left">Security</th>
              <th className="px-4 py-2 text-left">Type</th>
              <th className="px-4 py-2 text-right">Qty</th>
              <th className="px-4 py-2 text-right">Price</th>
              <th className="px-4 py-2 text-right">Value</th>
              <th className="px-4 py-2 text-right">Gain</th>
            </tr>
          </thead>
          <tbody>
            {p.top_holdings.map((h) => <HoldingRow key={h.id} h={h} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
