/**
 * Per-merchant deep-dive panel — Phase 7.5.
 *
 * Lookup a merchant by description, see lifetime spend, monthly
 * breakdown, recent transactions, related subscription (if any),
 * and any active offers targeting that merchant.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents } from "./api/client";
import CountUp from "./components/CountUp";
import { SkelLine, SkelStat } from "./components/Skeleton";

export default function MerchantPanel() {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["merchantDetail", active],
    queryFn: () => (active ? api.merchantDetail(active) : null),
    enabled: !!active,
  });

  // Sprint 25 — top-merchants browse list. Always loaded so the panel
  // is useful BEFORE the user knows what to type. Filter runs live as
  // the user edits the search box (debounce isn't needed at <100 rows;
  // the backend caps at 50 and matches via substring tokens).
  const browse = useQuery({
    queryKey: ["merchantList", query.trim()],
    queryFn: () =>
      api.listMerchants({
        search: query.trim() || undefined,
        limit: 50,
      }),
    staleTime: 60 * 1000,
  });

  return (
    <div>
      <form
        className="bg-card border border-border rounded-md shadow-card mb-5 p-4 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) setActive(query.trim());
        }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Merchant description (e.g. "TARTINE BAKERY", "AMAZON.COM")'
          className="flex-1 px-3 py-2 border border-border rounded text-sm"
        />
        <button type="submit" disabled={!query.trim()} className="px-4 py-2 text-sm font-semibold rounded bg-brand text-white disabled:opacity-50">
          Look up
        </button>
      </form>

      {/* Error branch — the API raises 404 when no transactions match the
          exact normalized description, so most "no result" cases land here. */}
      {detail.isError && (
        <div className="bg-card border border-border rounded-md shadow-card p-6 text-center text-sm max-w-xl mx-auto">
          <div className="text-2xl mb-1">🔎</div>
          <div className="text-text-muted">
            No transactions found for{" "}
            <span className="font-mono font-semibold text-text">
              {active}
            </span>
            .
          </div>
          <div className="text-[11px] text-text-soft mt-2">
            The lookup is exact — the description must match (uppercase,
            full prefix). Try copying the description directly from a
            transaction row in the Transactions panel.
          </div>
        </div>
      )}

      {/* Defensive belt-and-suspenders branch: covers the rare case where
          active is set, the query has settled (not loading, not errored)
          but data came back null/empty for some reason — shouldn't happen
          per the API contract, but better than rendering a blank page. */}
      {active && !detail.isLoading && !detail.isError && !detail.data && (
        <div className="bg-card border border-border rounded-md shadow-card p-6 text-center text-sm max-w-xl mx-auto">
          <div className="text-2xl mb-1">🔎</div>
          <div className="text-text-muted">
            No data returned for{" "}
            <span className="font-mono font-semibold text-text">
              {active}
            </span>
            . Try a different merchant description.
          </div>
        </div>
      )}

      {/* Skeleton while the detail query resolves — matches the eventual
          card shape (header strip + 4 stats + monthly bars) so the page
          doesn't shift when data lands. */}
      {active && detail.isLoading && (
        <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-slate-50 space-y-2">
            <SkelLine width="40%" height="h-4" />
            <SkelLine width="55%" height="h-2" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 border-b border-border">
            <SkelStat />
            <SkelStat />
            <SkelStat />
            <SkelStat />
          </div>
          <div className="p-4 space-y-2">
            <SkelLine width="30%" height="h-2" />
            {Array.from({ length: 4 }).map((_, i) => (
              <SkelLine key={i} width="90%" height="h-3" />
            ))}
          </div>
        </div>
      )}

      {detail.data && (
        <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-slate-50">
            <h3 className="text-base font-semibold text-text">{detail.data.display_name}</h3>
            <div className="text-xs text-text-muted mt-0.5">
              {detail.data.transactions} txns · first {detail.data.first_seen} → last {detail.data.last_seen}
              {detail.data.primary_category && ` · ${detail.data.primary_category}`}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 border-b border-border">
            <AnimatedStat label="Lifetime spend" cents={detail.data.lifetime_spend_cents} />
            <AnimatedStat label="Avg per visit" cents={detail.data.avg_per_visit_cents} />
            <AnimatedStat label="Median per visit" cents={detail.data.median_per_visit_cents} />
            <Stat label="Visits" value={String(detail.data.transactions)} />
          </div>
          {detail.data.related_subscription && (
            <div className="px-4 py-3 border-b border-border bg-emerald-50">
              <div className="text-xs font-semibold text-inflow uppercase tracking-wide">Related subscription</div>
              <div className="text-sm text-text mt-1">
                {detail.data.related_subscription.name} · {detail.data.related_subscription.subscription_type} ·
                {detail.data.related_subscription.last_amount_cents != null && ` ${fmtCents(detail.data.related_subscription.last_amount_cents)}`}
              </div>
            </div>
          )}
          {detail.data.related_offers.length > 0 && (
            <div className="px-4 py-3 border-b border-border bg-amber-50">
              <div className="text-xs font-semibold text-warn uppercase tracking-wide">Active offers</div>
              <ul className="text-sm text-text mt-1 space-y-0.5">
                {detail.data.related_offers.map((o) => (
                  <li key={o.id}>• {o.title} ({o.source})</li>
                ))}
              </ul>
            </div>
          )}
          {detail.data.monthly_breakdown.length > 0 && (
            <div className="p-4 border-b border-border">
              <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Monthly breakdown</div>
              <div className="space-y-1">
                {detail.data.monthly_breakdown.map((m) => {
                  const max = Math.max(...detail.data!.monthly_breakdown.map((x) => x.total_cents));
                  return (
                    <div key={m.month_start} className="flex items-center gap-2 text-xs">
                      <span className="text-text-muted w-20">{m.month_start.slice(0, 7)}</span>
                      <div className="flex-1 h-2 bg-hover rounded overflow-hidden">
                        <div className="h-full bg-brand" style={{ width: `${(m.total_cents / max) * 100}%` }} />
                      </div>
                      <span className="tabular-nums w-20 text-right">{fmtCents(m.total_cents)}</span>
                      <span className="tabular-nums w-12 text-right text-text-muted">{m.txn_count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="p-4">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Recent transactions</div>
            <table className="w-full">
              <tbody>
                {detail.data.recent_transactions.map((t) => (
                  <tr key={t.id} className="border-b border-border last:border-0">
                    <td className="py-1.5 text-xs text-text-muted">{t.posted_date}</td>
                    <td className="py-1.5 text-xs">{t.description_raw}</td>
                    <td className="py-1.5 text-right text-sm tabular-nums font-semibold text-outflow">{fmtCents(t.amount_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!active && (
        <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-slate-50 flex items-baseline justify-between">
            <div>
              <div className="text-sm font-semibold text-text">
                Top merchants
              </div>
              <div className="text-[11px] text-text-muted mt-0.5">
                {query.trim()
                  ? `Filtered to ${browse.data?.merchants.length ?? 0} matches`
                  : "Last 24 months · click any row for the deep-dive"}
              </div>
            </div>
            {browse.data && (
              <div className="text-[11px] text-text-muted tabular-nums">
                {browse.data.merchants.length} shown
              </div>
            )}
          </div>
          {browse.isLoading && (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <SkelLine key={i} width="90%" height="h-3" />
              ))}
            </div>
          )}
          {browse.data && browse.data.merchants.length === 0 && (
            <div className="p-6 text-center text-sm text-text-muted">
              {query.trim() ? (
                <>
                  No merchants match{" "}
                  <span className="font-mono text-text">"{query}"</span>.
                  Try fewer characters, or click "Look up" to do a strict
                  detail lookup with the exact string.
                </>
              ) : (
                "No merchants found in the last 24 months."
              )}
            </div>
          )}
          {browse.data && browse.data.merchants.length > 0 && (
            <table className="w-full">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-text-muted border-b border-border">
                  <th className="text-left px-4 py-2 font-semibold">Merchant</th>
                  <th className="text-left px-2 py-2 font-semibold">Category</th>
                  <th className="text-right px-2 py-2 font-semibold">Lifetime</th>
                  <th className="text-right px-2 py-2 font-semibold">Visits</th>
                  <th className="text-right px-4 py-2 font-semibold">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {browse.data.merchants.map((m) => (
                  <tr
                    key={m.description}
                    className="border-b border-border last:border-0 hover:bg-hover cursor-pointer"
                    onClick={() => setActive(m.description)}
                  >
                    <td className="px-4 py-2 text-sm font-medium text-text">
                      {m.display_name}
                    </td>
                    <td className="px-2 py-2 text-xs text-text-muted">
                      {m.primary_category_name ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-sm tabular-nums text-right text-outflow">
                      {fmtCents(-m.lifetime_spend_cents)}
                    </td>
                    <td className="px-2 py-2 text-sm tabular-nums text-right text-text-muted">
                      {m.txn_count}
                    </td>
                    <td className="px-4 py-2 text-xs text-text-muted text-right">
                      {m.last_seen ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-text-muted uppercase tracking-wide">{label}</div>
      <div className="text-lg font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

/** Stat card that animates the cents value via CountUp when the
 *  underlying merchant changes. Kept separate from the plain Stat
 *  helper so int-typed cells (Visits) skip the animation. */
function AnimatedStat({ label, cents }: { label: string; cents: number }) {
  return (
    <div>
      <div className="text-xs text-text-muted uppercase tracking-wide">{label}</div>
      <div className="text-lg font-semibold tabular-nums mt-0.5">
        <CountUp value={cents} format={fmtCents} />
      </div>
    </div>
  );
}
