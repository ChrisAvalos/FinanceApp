/**
 * Yield-arbitrage panel — Phase 8.4.
 *
 * Per-account analysis: how much you'd earn moving idle cash to a
 * top HYSA or T-bill. Each card shows current $/yr, the best
 * available alternative, and the dollar delta. Rows are split
 * into "qualifies for arb" (worth doing) vs "already optimal /
 * too small to bother."
 */
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents, type YieldArbAccount, type YieldArbProduct } from "./api/client";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelStat } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";
import PanelError from "./components/PanelError";

function ProductRow({ p }: { p: YieldArbProduct }) {
  return (
    <li className="flex items-center justify-between gap-3 py-1.5 border-b border-border last:border-0 text-xs">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-text">{p.name}</span>
          <span className="text-text-muted">{p.apy_pct.toFixed(2)}% APY</span>
          {p.fdic_insured && <span className="text-[10px] text-inflow font-semibold">FDIC</span>}
        </div>
        {p.notes && <p className="text-text-soft text-[11px] line-clamp-1">{p.notes}</p>}
      </div>
      <div className="text-right">
        <div className="tabular-nums text-text">{fmtCents(p.yearly_earnings_at_balance_cents)}</div>
        <div className="text-[11px] text-inflow font-semibold tabular-nums">
          +{fmtCents(p.delta_vs_current_cents)}
        </div>
      </div>
      <a href={p.open_url} target="_blank" rel="noopener noreferrer" className="text-brand text-xs hover:underline whitespace-nowrap">
        Open →
      </a>
    </li>
  );
}

function AccountCard({ a }: { a: YieldArbAccount }) {
  const cls = a.qualifies_for_arb ? "border-warn" : "border-border";
  return (
    <div className={`border-2 ${cls} rounded-md p-4 bg-card`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h4 className="text-sm font-semibold text-text">{a.account.account_name}</h4>
          <div className="text-xs text-text-muted">
            {fmtCents(a.account.balance_cents)} earning {a.account.current_apy_pct.toFixed(2)}% (~{fmtCents(a.account.current_yearly_earnings_cents)}/yr)
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-text-muted uppercase tracking-wide">Best delta</div>
          <div className={`text-lg font-semibold tabular-nums ${a.qualifies_for_arb ? "text-warn" : "text-text-soft"}`}>
            +{fmtCents(a.best_yearly_delta_cents)}/yr
          </div>
        </div>
      </div>
      {a.hysa_alternatives.length > 0 && (
        <>
          <div className="text-[10px] uppercase tracking-wide font-semibold text-text-muted mb-1">HYSA options</div>
          <ul className="mb-2">
            {a.hysa_alternatives.map((p) => (
              <ProductRow key={p.name} p={p} />
            ))}
          </ul>
        </>
      )}
      {a.tbill_alternatives.length > 0 && (
        <>
          <div className="text-[10px] uppercase tracking-wide font-semibold text-text-muted mb-1">T-bill options</div>
          <ul>
            {a.tbill_alternatives.map((p) => (
              <ProductRow key={p.name} p={p} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default function YieldOptPanel() {
  const report = useQuery({ queryKey: ["yieldArb"], queryFn: api.yieldArbReport });

  if (report.isLoading) {
    // Hero skeleton + a couple of account-card skeletons. Beats a
    // generic "Loading…" — the page stays stable when data lands.
    return (
      <div>
        <SkelHeroRow count={3} />
        <div className="grid grid-cols-1 gap-3">
          <SkelStat />
          <SkelStat />
        </div>
      </div>
    );
  }
  if (report.isError) {
    return <PanelError title="Couldn't load yield-arbitrage report." error={report.error} onRetry={() => report.refetch()} />;
  }
  if (!report.data || report.data.accounts.length === 0) {
    return (
      <div className="bg-card border border-border rounded-md p-6 text-center text-sm text-text-muted max-w-md mx-auto">
        No liquid accounts found. Connect a checking or savings
        account via Plaid — yield-arb only fires on accounts holding
        ≥ $1,000 in cash.
      </div>
    );
  }

  const qualifying = report.data.accounts.filter((a) => a.qualifies_for_arb);
  const sub_optimal = report.data.accounts.filter((a) => !a.qualifies_for_arb);

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip syncedAt={report.data.as_of} label="FRED rates pulled" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-5">
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Idle balance</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
            <CountUp value={report.data.total_idle_balance_cents} format={fmtCents} />
          </div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Potential gain · 1yr</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-warn">
            +<CountUp value={report.data.total_yearly_potential_delta_cents} format={fmtCents} />
          </div>
          <div className="text-[11px] text-text-soft mt-0.5">If you move qualifying balances</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Accounts</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
            <CountUp value={report.data.accounts.length} format={(n) => String(Math.round(n))} />
          </div>
          <div className="text-[11px] text-text-soft mt-0.5">
            {qualifying.length} qualify · {sub_optimal.length} already optimal/small
          </div>
        </div>
      </div>

      <div className="mb-5 px-4 py-3 bg-brand-deep text-white rounded-md text-sm leading-relaxed">
        {report.data.summary_text}
      </div>

      {qualifying.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-warn uppercase tracking-wide mb-2">Worth moving</h3>
          <div className="grid grid-cols-1 gap-3 mb-5">
            {qualifying.map((a) => <AccountCard key={a.account.account_id} a={a} />)}
          </div>
        </>
      )}

      {sub_optimal.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-2">
            Already optimal or too small to bother
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {sub_optimal.map((a) => <AccountCard key={a.account.account_id} a={a} />)}
          </div>
        </>
      )}
    </div>
  );
}
