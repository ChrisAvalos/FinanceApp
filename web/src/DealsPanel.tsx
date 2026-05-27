/**
 * Deals panel — Phase 10 Slice D.
 *
 * Three sections:
 *   1. Active deals (computed from PriceObservations).
 *   2. Manual price-entry form — pick a recurring pattern, enter
 *      merchant + price; the deal detector picks it up automatically
 *      on the next render.
 *   3. Recent observations table — every PriceObservation from the
 *      last 90 days.
 *
 * Plus a scraper-status strip at the top showing which stores are
 * auth-bootstrapped vs missing. Mirrors the Offers panel's banner.
 *
 * The "Scan now" button fans out across configured scrapers (today
 * all stubs return auth_missing). Manual entry is the always-works
 * path until per-store auth bootstrapping ships.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type DealOpportunity,
  type DealScrapeResult,
  type PriceObservation,
  type RecurringPurchase,
} from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
import PanelError from "./components/PanelError";

/* ------------------------------------------------------------------ */
/*  Scraper status strip                                                */
/* ------------------------------------------------------------------ */

function ScraperStatusStrip() {
  const status = useQuery({
    queryKey: ["dealScraperStatus"],
    queryFn: api.dealScraperStatus,
  });
  if (!status.data) return null;
  return (
    <div className="bg-card border border-border rounded-md shadow-card mb-5">
      <div className="px-4 py-2 border-b border-border bg-slate-50">
        <h3 className="text-sm font-semibold text-text">Scraper readiness</h3>
        <p className="text-[11px] text-text-soft">
          Each store needs a one-time auth bootstrap before scraping starts. Until then, log prices manually below — the deal detector treats both paths identically.
        </p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 p-3">
        {status.data.map((s) => (
          <div key={s.name} className="flex items-center gap-2 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                s.auth_missing ? "bg-warn" : "bg-inflow"
              }`}
            />
            <span className="font-semibold text-text capitalize">{s.name.replace("_", " ")}</span>
            <span className="text-text-muted">
              {s.auth_missing ? "needs auth" : "ready"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Deal card                                                           */
/* ------------------------------------------------------------------ */

function DealCard({ d }: { d: DealOpportunity }) {
  return (
    <div className="border border-border rounded-md p-4 bg-card hover:shadow-card-hover">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-1.5 py-0.5 rounded-sm bg-pink-50 text-pink-700 text-[10px] font-semibold uppercase tracking-wide">
              {d.deal_merchant}
            </span>
            <h4 className="text-sm font-semibold text-text">{d.pattern_name}</h4>
          </div>
          <div className="text-xs text-text-muted mt-1">
            {fmtCents(d.deal_price_cents)} at {d.deal_merchant}
            <span className="ml-2 text-text-soft">
              vs your usual {fmtCents(d.baseline_cents)}
              {d.pattern_merchant && ` at ${d.pattern_merchant}`}
            </span>
          </div>
          <div className="text-[11px] text-text-soft mt-1">
            Seen {d.observed_at}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-base font-semibold tabular-nums text-warn">
            -{fmtCents(d.savings_cents)}
          </div>
          <div className="text-[11px] text-warn">
            {Math.round(d.savings_pct * 100)}% off
          </div>
          {d.annual_savings_cents != null && (
            <div className="text-[11px] text-text-soft mt-1">
              ~{fmtCents(d.annual_savings_cents)}/yr if you switch
            </div>
          )}
        </div>
      </div>
      {d.product_url && (
        <div className="mt-3">
          <a
            href={d.product_url}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white"
          >
            See deal →
          </a>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Manual observation entry                                            */
/* ------------------------------------------------------------------ */

function ManualEntryForm({
  patterns,
  onSaved,
}: {
  patterns: RecurringPurchase[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    pattern_id: "",
    merchant: "",
    price_dollars: "",
    observed_at: new Date().toISOString().slice(0, 10),
    product_url: "",
    notes: "",
    in_stock: true,
  });
  const create = useMutation({
    mutationFn: api.createDealObservation,
    onSuccess: () => {
      onSaved();
      setOpen(false);
      setForm({ ...form, merchant: "", price_dollars: "", product_url: "", notes: "" });
    },
  });

  if (patterns.length === 0) {
    // Sprint 33 — richer empty state with a 3-step setup path and
    // dollar-tease, replacing the prior wall-of-text sentence that
    // mentioned three other panels by name without explaining why.
    return (
      <div className="bg-card border border-border rounded-md shadow-card p-6">
        <div className="flex items-start gap-4">
          <div className="text-3xl leading-none flex-shrink-0" aria-hidden="true">
            🏷️
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-text">
              Get alerts when the same item is cheaper at another store
            </div>
            <div className="text-xs text-text-muted mt-1 leading-relaxed max-w-2xl">
              We watch your typical-buy list (Costco TP, La Croix, Tide pods,
              etc.) for ≥15% price drops at Target / Walmart / Amazon Fresh /
              Kroger. The deal fires here AND lands on{" "}
              <span className="text-text">Money on the Table</span> with the
              annualized savings. Most households see 2–5 actionable swaps a
              month.
            </div>
            <ol className="text-xs text-text-muted mt-3 space-y-1.5">
              <li className="flex items-start gap-2">
                <span className="text-text-soft tabular-nums w-3">1.</span>
                <span>
                  Upload 3+ receipts on the{" "}
                  <button
                    onClick={() => {
                      window.location.hash = "#receipts";
                    }}
                    className="text-brand hover:underline font-medium"
                  >
                    Receipts panel
                  </button>{" "}
                  so we can build your typical-buy list.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-text-soft tabular-nums w-3">2.</span>
                <span>
                  Hit <span className="font-mono bg-hover px-1 py-0.5 rounded text-[11px]">Detect now</span>{" "}
                  on the{" "}
                  <button
                    onClick={() => {
                      window.location.hash = "#shopping-patterns";
                    }}
                    className="text-brand hover:underline font-medium"
                  >
                    Shopping panel
                  </button>{" "}
                  — the detector groups items by canonical product and pins
                  per-unit typical price.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-text-soft tabular-nums w-3">3.</span>
                <span>
                  Bootstrap a store scraper (Walmart is ready by default; other
                  stores need a one-time auth — see the readiness strip above).
                </span>
              </li>
            </ol>
            <div className="text-[11px] text-text-soft mt-3 italic">
              Once those are done, this panel auto-populates with live price
              observations and a per-item "save $X by switching" recommendation.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 text-sm font-semibold rounded bg-brand text-white hover:bg-brand-navy"
      >
        + Log a price observation
      </button>
    );
  }

  return (
    <form
      className="border border-border rounded-md bg-card p-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const cents = Math.round(parseFloat(form.price_dollars) * 100);
        const pid = Number(form.pattern_id);
        if (!pid || Number.isNaN(cents) || cents <= 0 || !form.merchant.trim()) return;
        create.mutate({
          recurring_purchase_id: pid,
          merchant: form.merchant.trim(),
          price_cents: cents,
          observed_at: form.observed_at,
          in_stock: form.in_stock,
          product_url: form.product_url.trim() || undefined,
          notes: form.notes.trim() || undefined,
        });
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold">Log a price observation</h4>
        <button type="button" onClick={() => setOpen(false)} className="text-text-muted" aria-label="Close">×</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <label>
          <span className="block mb-1 font-semibold uppercase text-[10px]">Item *</span>
          <select
            value={form.pattern_id}
            onChange={(e) => setForm({ ...form, pattern_id: e.target.value })}
            className="w-full px-2 py-1.5 border border-border rounded bg-card"
            required
          >
            <option value="">Pick a tracked item…</option>
            {patterns.map((p) => (
              <option key={p.id} value={p.id}>
                {p.canonical_name}
                {p.primary_merchant && ` (usually ${p.primary_merchant})`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="block mb-1 font-semibold uppercase text-[10px]">Merchant *</span>
          <input
            value={form.merchant}
            onChange={(e) => setForm({ ...form, merchant: e.target.value })}
            placeholder="Walmart / Target / etc."
            className="w-full px-2 py-1.5 border border-border rounded"
            required
          />
        </label>
        <label>
          <span className="block mb-1 font-semibold uppercase text-[10px]">Price ($) *</span>
          <input
            type="number"
            step={0.01}
            value={form.price_dollars}
            onChange={(e) => setForm({ ...form, price_dollars: e.target.value })}
            className="w-full px-2 py-1.5 border border-border rounded"
            required
          />
        </label>
        <label>
          <span className="block mb-1 font-semibold uppercase text-[10px]">Date</span>
          <input
            type="date"
            value={form.observed_at}
            onChange={(e) => setForm({ ...form, observed_at: e.target.value })}
            className="w-full px-2 py-1.5 border border-border rounded"
          />
        </label>
        <label className="md:col-span-2">
          <span className="block mb-1 font-semibold uppercase text-[10px]">Product URL (optional)</span>
          <input
            type="url"
            value={form.product_url}
            onChange={(e) => setForm({ ...form, product_url: e.target.value })}
            placeholder="https://..."
            className="w-full px-2 py-1.5 border border-border rounded"
          />
        </label>
        <label className="md:col-span-2">
          <span className="block mb-1 font-semibold uppercase text-[10px]">Notes</span>
          <input
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="ad week, in-store only, etc."
            className="w-full px-2 py-1.5 border border-border rounded"
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={form.in_stock}
            onChange={(e) => setForm({ ...form, in_stock: e.target.checked })}
          />
          <span>In stock</span>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={create.isPending}
          className="px-3 py-1.5 text-sm font-semibold rounded bg-brand text-white disabled:opacity-50"
        >
          {create.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 text-sm text-text-muted">
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Observations table                                                  */
/* ------------------------------------------------------------------ */

function ObservationsTable({
  observations,
  patterns,
  onDelete,
}: {
  observations: PriceObservation[];
  patterns: RecurringPurchase[];
  onDelete: (id: number) => void;
}) {
  const patternById = useMemo(
    () => Object.fromEntries(patterns.map((p) => [p.id, p])),
    [patterns],
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-hover border-b border-border">
          <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
            <th className="px-3 py-2 text-left">Date</th>
            <th className="px-3 py-2 text-left">Item</th>
            <th className="px-3 py-2 text-left">Merchant</th>
            <th className="px-3 py-2 text-right">Price</th>
            <th className="px-3 py-2 text-left">Source</th>
            <th className="px-3 py-2 text-left">Stock</th>
            <th className="px-3 py-2 text-right"></th>
          </tr>
        </thead>
        <tbody>
          {observations.length === 0 && (
            <tr>
              <td colSpan={7} className="p-6 text-center text-sm text-text-muted">
                No observations yet. Log one above or run "Scan now" once a scraper is auth-ready.
              </td>
            </tr>
          )}
          {observations.map((o) => {
            const p = patternById[o.recurring_purchase_id];
            return (
              <tr key={o.id} className="border-b border-border last:border-0 hover:bg-hover">
                <td className="px-3 py-2 text-xs text-text-muted whitespace-nowrap">{o.observed_at}</td>
                <td className="px-3 py-2 text-sm">{p?.canonical_name || `#${o.recurring_purchase_id}`}</td>
                <td className="px-3 py-2 text-sm">{o.merchant}</td>
                <td className="px-3 py-2 text-right text-sm tabular-nums font-semibold">{fmtCents(o.price_cents)}</td>
                <td className="px-3 py-2 text-[11px] text-text-soft">{o.source}</td>
                <td className="px-3 py-2 text-[11px]">
                  {o.in_stock ? (
                    <span className="text-inflow">in stock</span>
                  ) : (
                    <span className="text-outflow">out</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    // Sprint 38 — direct delete; row vanishes on
                    // next list refresh. Native confirm() removed.
                    onClick={() => onDelete(o.id)}
                    className="text-[11px] text-text-muted hover:text-outflow"
                  >
                    Del
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */

export default function DealsPanel() {
  const qc = useQueryClient();
  const deals = useQuery({ queryKey: ["deals"], queryFn: () => api.listDeals() });
  const patterns = useQuery({
    queryKey: ["recurringPurchasesActive"],
    queryFn: () => api.listRecurringPurchases({ status: "active" }),
  });
  const observations = useQuery({
    queryKey: ["dealObservations"],
    queryFn: () => api.listDealObservations({ limit: 200 }),
  });
  const [lastScrape, setLastScrape] = useState<DealScrapeResult | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["deals"] });
    qc.invalidateQueries({ queryKey: ["dealObservations"] });
    qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
  };
  const scan = useMutation({
    mutationFn: api.scanDeals,
    onSuccess: (r) => {
      setLastScrape(r);
      invalidate();
    },
  });
  const destroy = useMutation({
    mutationFn: api.deleteDealObservation,
    onSuccess: invalidate,
  });

  const totalAnnualSavings = useMemo(
    () => (deals.data ?? []).reduce((s, d) => s + (d.annual_savings_cents ?? 0), 0),
    [deals.data],
  );

  if (deals.isError) {
    return <PanelError title="Couldn't load deals." error={deals.error} onRetry={() => deals.refetch()} />;
  }

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip
          syncedAt={deals.dataUpdatedAt > 0 ? new Date(deals.dataUpdatedAt).toISOString() : null}
          label="Last fetched"
        />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-5">
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Active deals</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-warn">{deals.data?.length ?? 0}</div>
          <div className="text-[11px] text-text-soft mt-0.5">≥15% below your typical</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Annual savings if you switch</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-warn">{fmtCents(totalAnnualSavings)}</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Observations logged</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">{observations.data?.length ?? 0}</div>
        </div>
      </div>

      <ScraperStatusStrip />

      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => scan.mutate()}
          disabled={scan.isPending}
          className="px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-brand hover:text-brand disabled:opacity-50"
          title="Run all configured scrapers (today most return auth-missing)"
        >
          {scan.isPending ? "Scanning…" : "Scan now"}
        </button>
        <ManualEntryForm patterns={patterns.data ?? []} onSaved={invalidate} />
      </div>

      {lastScrape && (
        <div className="bg-card border border-border rounded-md shadow-card mb-5 px-4 py-3 text-xs">
          <div className="font-semibold mb-1">
            Scrape finished — {lastScrape.total_observations_created} new observation{lastScrape.total_observations_created === 1 ? "" : "s"} across {lastScrape.patterns_scanned} pattern{lastScrape.patterns_scanned === 1 ? "" : "s"}.
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {lastScrape.summaries.map((s) => (
              <div key={s.name} className="flex items-center justify-between text-text-muted">
                <span className="font-semibold capitalize">{s.name.replace("_", " ")}</span>
                <span className="tabular-nums">
                  {s.auth_missing ? "auth missing" : `${s.rows_created}/${s.queries_attempted}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active deals */}
      {deals.data && deals.data.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-text mb-2">Active deals</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {deals.data.map((d, i) => (
              <DealCard key={`${d.pattern_id}-${d.deal_merchant}-${i}`} d={d} />
            ))}
          </div>
        </div>
      )}

      {/* Observations table */}
      <div className="bg-card border border-border rounded-md shadow-card">
        <div className="px-4 py-2 border-b border-border bg-slate-50">
          <h3 className="text-sm font-semibold text-text">Recent observations</h3>
          <p className="text-[11px] text-text-soft">
            Both manual entries and scraper hits land here — same table, same downstream deal logic.
          </p>
        </div>
        <ObservationsTable
          observations={observations.data ?? []}
          patterns={patterns.data ?? []}
          onDelete={(id) => destroy.mutate(id)}
        />
      </div>

      <p className="mt-3 text-[11px] text-text-soft">
        Deals trigger when an observation is ≥15% below your typical price for that item. The "Annual savings"
        figure projects the per-trip savings × purchase frequency. New deals also show up in <span className="font-semibold">Money on the table</span> under the "Cross-store deal" source kind.
      </p>
    </div>
  );
}
