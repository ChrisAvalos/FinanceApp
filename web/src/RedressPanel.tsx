/**
 * Regulatory-redress panel — Phase 8.5.
 *
 * Companion to LegalClaimsPanel (class actions) — this surface
 * tracks government-enforcement orders (CFPB / FTC / state-AG)
 * where the user may be eligible based on their transaction
 * history. The /match-spend endpoint cross-references the catalog
 * against Plaid-imported transactions and tells you which cases
 * are likely worth filing.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type RedressMatch,
  type KnownRedress,
  type RedressRecord,
  type RedressStatus,
} from "./api/client";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelStat } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";
import PanelError from "./components/PanelError";

function MatchCard({ m, onLog }: { m: RedressMatch; onLog: () => void }) {
  const c = m.catalog_entry;
  return (
    <div className="border border-border rounded-md p-4 bg-card hover:shadow-card-hover">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-1.5 py-0.5 rounded-sm bg-violet-50 text-violet-700 text-[10px] font-semibold uppercase tracking-wide">
              {c.agency}
            </span>
            <h4 className="text-sm font-semibold text-text">{c.company_name}</h4>
            {m.already_logged && (
              <span className="text-[10px] text-inflow font-semibold">✓ logged</span>
            )}
          </div>
          <div className="text-xs text-text mt-1 font-semibold">{c.title}</div>
          <p className="text-xs text-text-muted mt-1 line-clamp-3">{c.eligibility_description}</p>
          <div className="text-[11px] text-text-soft mt-2">
            {m.matched_transactions} matched txn{m.matched_transactions === 1 ? "" : "s"} · spend {fmtCents(m.matched_total_spend_cents)}
          </div>
          {m.sample_descriptions.length > 0 && (
            <div className="text-[11px] text-text-soft italic mt-1 truncate">
              e.g. {m.sample_descriptions.slice(0, 2).join(" · ")}
            </div>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-base font-semibold tabular-nums text-text">
            {c.estimated_per_user_cents ? fmtCents(c.estimated_per_user_cents) : "—"}
          </div>
          <div className="text-[11px] text-text-soft">est. per user</div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3">
        {c.claim_url && (
          <a href={c.claim_url} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white">
            Check eligibility →
          </a>
        )}
        {!m.already_logged && (
          <button
            onClick={onLog}
            className="px-3 py-1.5 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy"
          >
            Log as candidate
          </button>
        )}
      </div>
    </div>
  );
}

function CatalogCard({ c }: { c: KnownRedress }) {
  return (
    <div className="border border-border rounded-md p-3 bg-card">
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded-sm bg-violet-50 text-violet-700 text-[10px] font-semibold uppercase tracking-wide">
          {c.agency}
        </span>
        <h5 className="text-xs font-semibold text-text">{c.company_name}</h5>
      </div>
      <p className="text-[11px] text-text-muted mt-1 line-clamp-2">{c.title}</p>
      <div className="flex items-center justify-between text-[11px] mt-2">
        <span className="text-text-soft">
          {c.estimated_per_user_cents ? `~${fmtCents(c.estimated_per_user_cents)}/user` : "Per user TBD"}
        </span>
        {c.claim_url && (
          <a href={c.claim_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Open</a>
        )}
      </div>
    </div>
  );
}

function RedressRecordRow({
  r,
  onTransition,
  onDelete,
}: {
  r: RedressRecord;
  onTransition: (status: RedressStatus, payout?: number) => void;
  onDelete: () => void;
}) {
  const [paidDraft, setPaidDraft] = useState("");
  return (
    <div className="border border-border rounded-md p-3 bg-card">
      <div className="flex items-start justify-between">
        <div>
          <h5 className="text-sm font-semibold text-text">{r.company_name}</h5>
          <div className="text-xs text-text-muted">{r.title}</div>
          <div className="text-[11px] text-text-soft mt-0.5">
            {r.agency} · status {r.status}
          </div>
        </div>
        <div className="text-right">
          {r.actual_payout_cents != null ? (
            <span className="text-inflow font-semibold tabular-nums">{fmtCents(r.actual_payout_cents)}</span>
          ) : (
            r.estimated_per_user_cents && <span className="text-text-muted tabular-nums">~{fmtCents(r.estimated_per_user_cents)}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        {r.claim_url && (
          <a href={r.claim_url} target="_blank" rel="noopener noreferrer" className="text-xs text-brand hover:underline">
            Claim URL ↗
          </a>
        )}
        {r.status === "candidate" || r.status === "eligible" ? (
          <button onClick={() => onTransition("pending_filed")} className="px-2 py-1 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy">
            Mark filed
          </button>
        ) : null}
        {r.status === "pending_filed" && (
          <form className="flex items-center gap-1.5" onSubmit={(e) => {
            e.preventDefault();
            const v = parseFloat(paidDraft);
            if (Number.isNaN(v) || v < 0) return;
            onTransition("paid", Math.round(v * 100));
            setPaidDraft("");
          }}>
            <span className="text-xs text-text-muted">$</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={paidDraft}
              onChange={(e) => setPaidDraft(e.target.value)}
              className="w-20 px-2 py-1 text-xs border border-border rounded"
            />
            <button type="submit" disabled={!paidDraft} className="px-2 py-1 text-xs font-semibold rounded bg-inflow text-white disabled:opacity-40">Mark paid</button>
          </form>
        )}
        <button onClick={() => { if (confirm("Delete?")) onDelete(); }} className="ml-auto text-xs text-text-muted hover:text-outflow">Delete</button>
      </div>
    </div>
  );
}

export default function RedressPanel() {
  const qc = useQueryClient();
  const matches = useQuery({ queryKey: ["redressMatches"], queryFn: () => api.redressMatchSpend() });
  const known = useQuery({ queryKey: ["redressKnown"], queryFn: api.redressKnown });
  const tracked = useQuery({ queryKey: ["redressTracked"], queryFn: api.listRedress });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["redressMatches"] });
    qc.invalidateQueries({ queryKey: ["redressTracked"] });
    qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
  };
  const create = useMutation({ mutationFn: api.createRedress, onSuccess: invalidate });
  const transition = useMutation({
    mutationFn: ({ id, status, payout }: { id: number; status: RedressStatus; payout?: number }) =>
      api.updateRedressStatus(id, status, payout),
    onSuccess: invalidate,
  });
  const destroy = useMutation({ mutationFn: api.deleteRedress, onSuccess: invalidate });

  const totalEst = matches.data?.total_estimated_cents ?? 0;
  const matchCount = matches.data?.matches.length ?? 0;
  const paidTotal = (tracked.data ?? [])
    .filter((r) => r.status === "paid")
    .reduce((s, r) => s + (r.actual_payout_cents ?? 0), 0);

  // Skeleton hero on first load — three queries fire in parallel here
  // (matches + known catalog + tracked records), so we use the
  // matches.isLoading state as the umbrella signal since that's the
  // most expensive query.
  const heroLoading = matches.isLoading || known.isLoading || tracked.isLoading;

  if (matches.isError) {
    return <PanelError title="Couldn't load redress matches." error={matches.error} onRetry={() => matches.refetch()} />;
  }

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip
          syncedAt={matches.dataUpdatedAt > 0 ? new Date(matches.dataUpdatedAt).toISOString() : null}
          label="Last fetched"
        />
      </div>
      {heroLoading ? (
        <SkelHeroRow count={4} />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Likely eligible</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-warn">
              <CountUp value={totalEst} format={fmtCents} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">{matchCount} catalog matches</div>
          </div>
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Catalog size</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
              <CountUp value={known.data?.length ?? 0} format={(n) => String(Math.round(n))} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">Active orders we track</div>
          </div>
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Tracked</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
              <CountUp value={tracked.data?.length ?? 0} format={(n) => String(Math.round(n))} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">In your follow-up list</div>
          </div>
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Paid out</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-inflow">
              <CountUp value={paidTotal} format={fmtCents} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">Lifetime collected</div>
          </div>
        </div>
      )}

      {/* Spend-matched candidates */}
      <h3 className="text-sm font-semibold text-text uppercase tracking-wide mb-2">
        Likely eligible — matched against your transactions
      </h3>
      {matches.isLoading ? (
        // Match-card skeleton grid mirrors the eventual layout so the
        // page doesn't shift when the matcher returns.
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
          <SkelStat />
          <SkelStat />
          <SkelStat />
          <SkelStat />
        </div>
      ) : matchCount === 0 ? (
        <div className="bg-card border border-border rounded-md p-6 text-center text-sm text-text-muted mb-5 max-w-xl mx-auto">
          No catalog companies matched your last 2 years of
          transactions. Connect Plaid to get coverage — without
          transactions, the matcher has nothing to compare your spend
          history against. Most CFPB redress is mailed automatically
          when you qualify, but the action-required orders only
          surface here.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
          {matches.data!.matches.map((m, i) => (
            <MatchCard
              key={`${m.catalog_entry.company_name}:${i}`}
              m={m}
              onLog={() =>
                create.mutate({
                  agency: m.catalog_entry.agency,
                  company_name: m.catalog_entry.company_name,
                  title: m.catalog_entry.title,
                  eligibility_description: m.catalog_entry.eligibility_description,
                  claim_url: m.catalog_entry.claim_url,
                  estimated_per_user_cents: m.catalog_entry.estimated_per_user_cents,
                })
              }
            />
          ))}
        </div>
      )}

      {/* Tracked records */}
      {tracked.data && tracked.data.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-text uppercase tracking-wide mb-2 mt-4">Your tracked redress</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
            {tracked.data.map((r) => (
              <RedressRecordRow
                key={r.id}
                r={r}
                onTransition={(status, payout) => transition.mutate({ id: r.id, status, payout })}
                onDelete={() => destroy.mutate(r.id)}
              />
            ))}
          </div>
        </>
      )}

      {/* Full catalog browse */}
      {known.data && known.data.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-2">
            Full catalog ({known.data.length} active orders)
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {known.data.map((c, i) => <CatalogCard key={`${c.company_name}:${i}`} c={c} />)}
          </div>
        </>
      )}

      <p className="mt-4 text-[11px] text-text-soft">
        Most CFPB redress is automatic — the agency mails checks. The catalog also includes orders that
        require user action; those are the ones surfaced as matched candidates above.
      </p>
    </div>
  );
}
