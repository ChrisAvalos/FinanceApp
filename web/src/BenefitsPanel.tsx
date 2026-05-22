/**
 * Card-benefits / use-it-or-lose-it credits panel — Phase 8.3.
 *
 * Most premium cards (Sapphire Reserve, Amex Platinum, etc.) bundle
 * annual credits — Uber, Saks, airline fee, dining, streaming. Most
 * users redeem ~30% of them. Net-after-fee math reveals whether the
 * card is *actually* paying for itself.
 *
 * The endpoint already does the math; the panel just renders one row
 * per card, ranked by net-after-fee desc, with a per-benefit breakdown
 * underneath each card.
 */
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents, type CardBenefitRow } from "./api/client";
import EmptyState from "./components/EmptyState";
import PanelError from "./components/PanelError";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelStat } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";

function NetTone({ cents }: { cents: number }) {
  const tone = cents >= 0 ? "text-inflow" : "text-outflow";
  return (
    <span className={`tabular-nums font-semibold ${tone}`}>
      {cents >= 0 ? "+" : ""}{fmtCents(cents)}
    </span>
  );
}

function CardRow({ row }: { row: CardBenefitRow }) {
  const net = row.net_after_fee_cents;
  return (
    <div className="border border-border rounded-md p-4 bg-card hover:shadow-card-hover">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h4 className="text-sm font-semibold text-text">{row.account_name}</h4>
          <div className="text-xs text-text-muted">{row.profile_name}</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-text-muted uppercase tracking-wide">Net / yr</div>
          <div className="text-lg"><NetTone cents={net} /></div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 text-xs mb-3 pb-3 border-b border-border">
        <div>
          <div className="text-text-muted">Annual fee</div>
          <div className="text-text font-semibold tabular-nums">{fmtCents(-row.annual_fee_cents)}</div>
        </div>
        <div>
          <div className="text-text-muted">Credit value</div>
          <div className="text-inflow font-semibold tabular-nums">{fmtCents(row.total_credit_value_cents)}</div>
        </div>
        <div>
          <div className="text-text-muted">Benefits</div>
          <div className="text-text font-semibold tabular-nums">{row.benefits.length}</div>
        </div>
      </div>
      <ul className="space-y-1.5 text-xs">
        {row.benefits.map((b, i) => (
          <li key={i} className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <span className="font-semibold text-text">{b.name}</span>
              {b.cadence && <span className="ml-1 text-text-soft">· {b.cadence}</span>}
              {b.notes && <p className="text-text-muted text-[11px] line-clamp-1">{b.notes}</p>}
            </div>
            <span className="tabular-nums text-inflow font-semibold">{fmtCents(b.value_cents)}</span>
            {b.activation_url && (
              <a href={b.activation_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                Activate
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function BenefitsPanel() {
  const report = useQuery({ queryKey: ["cardBenefits"], queryFn: api.cardBenefits });

  if (report.isLoading) {
    // Layout-shaped skeleton — hero row of 4 stats, then a few card-row
    // shells while the catalog match runs.
    return (
      <div>
        <SkelHeroRow count={4} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <SkelStat />
          <SkelStat />
          <SkelStat />
          <SkelStat />
        </div>
      </div>
    );
  }
  if (report.isError) {
    return (
      <PanelError
        title="Couldn't load card benefits."
        error={report.error}
        onRetry={() => report.refetch()}
      />
    );
  }
  if (!report.data || report.data.rows.length === 0) {
    const unmatched = report.data?.unmatched_card_ids?.length ?? 0;
    return (
      <EmptyState
        emoji="🪪"
        title="No premium-card benefits configured"
        body={
          <>
            We match Plaid account names against a catalog of premium
            cards (Sapphire Reserve, Amex Platinum, Capital One Venture
            X, etc.). Plaid often returns generic names like
            "CREDIT CARD" — when that happens we can't match.
            {unmatched > 0 && (
              <div className="mt-2">
                <strong>{unmatched} card{unmatched === 1 ? "" : "s"}</strong>{" "}
                unmatched. Open Bank connections, click Details on the
                card row, and confirm the institution + last-4 digits —
                then request a catalog add if your card isn't covered yet.
              </div>
            )}
          </>
        }
        ctaLabel="Open Bank connections →"
        ctaHref="#connections"
      />
    );
  }

  const sorted = [...report.data.rows].sort((a, b) => b.net_after_fee_cents - a.net_after_fee_cents);

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip syncedAt={report.data.as_of} label="Catalog refreshed" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Total credit value</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-inflow">
            <CountUp value={report.data.total_face_value_cents} format={fmtCents} />
          </div>
          <div className="text-[11px] text-text-soft mt-0.5">If you use every credit</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Total annual fees</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-outflow">
            <CountUp value={-report.data.total_annual_fee_cents} format={fmtCents} />
          </div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Net after fees</div>
          <div className="text-2xl mt-1"><NetTone cents={report.data.net_potential_cents} /></div>
          <div className="text-[11px] text-text-soft mt-0.5">If fully utilized</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Cards in catalog</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
            <CountUp value={report.data.rows.length} format={(n) => String(Math.round(n))} />
          </div>
          <div className="text-[11px] text-text-soft mt-0.5">
            {report.data.unmatched_card_ids.length} unmatched
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {sorted.map((r) => <CardRow key={r.account_id} row={r} />)}
      </div>

      <p className="mt-3 text-[11px] text-text-soft">
        Net-after-fee assumes you actually use every credit. Most people use ~30% — calibrate
        each row against your real redemption rate before deciding to keep, downgrade, or cancel.
      </p>
    </div>
  );
}
