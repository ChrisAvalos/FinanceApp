/**
 * Card Offers panel — redesigned 2026-05.
 *
 * Replaces the original transient "Scrape now" → render-results panel
 * with a persistent feed: on mount we read from GET /api/offers and
 * /api/offers/status so the user sees their current pipeline before
 * doing anything. The "Scrape now" button still works and appends to
 * (rather than replacing) what's on screen.
 *
 * Key lifts vs the old panel:
 *   • Persistent display from /api/offers (was: empty until first scrape)
 *   • Per-portal status strip with bootstrap command shown inline when
 *     auth_missing — exact PowerShell command Chris can copy-paste,
 *     no hunting in MANUAL_TASKS.md.
 *   • Filter chips by status + by portal, with running counts
 *   • Expiring-soon banner highlights offers within 7 days, since those
 *     are the ones with the smallest action window.
 *   • Activated state — "Mark activated" button writes to the backend;
 *     activated rows fade and drop to the bottom of the list.
 *   • Skeleton loading state instead of an empty box.
 *   • Hero summary: total, available, your activated count, $/mo at stake.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  api,
  fmtCents,
  type OfferScrapeResponse,
  type OfferStatus,
  type PersistedOffer,
} from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
import PanelError from "./components/PanelError";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtBps(bps: number | null): string {
  if (bps == null) return "—";
  return `${(bps / 100).toFixed(1)}%`;
}

function expiryCopy(days: number | null): {
  text: string;
  tone: "soft" | "warn" | "danger" | "muted";
} {
  if (days == null) return { text: "No expiry on file", tone: "muted" };
  if (days < 0) return { text: `Expired ${-days}d ago`, tone: "danger" };
  if (days === 0) return { text: "Expires today", tone: "danger" };
  if (days <= 3) return { text: `Expires in ${days}d`, tone: "danger" };
  if (days <= 7) return { text: `Expires in ${days}d`, tone: "warn" };
  if (days <= 30) return { text: `Expires in ${days}d`, tone: "soft" };
  return { text: `Expires in ${days}d`, tone: "muted" };
}

const STATUS_CONFIG: Record<
  OfferStatus,
  { label: string; chipBg: string; chipText: string }
> = {
  available: { label: "Available", chipBg: "bg-emerald-100", chipText: "text-emerald-700" },
  activated: { label: "Activated", chipBg: "bg-sky-100", chipText: "text-sky-700" },
  redeemed: { label: "Redeemed", chipBg: "bg-violet-100", chipText: "text-violet-700" },
  expired: { label: "Expired", chipBg: "bg-slate-100", chipText: "text-slate-500" },
  dismissed: { label: "Dismissed", chipBg: "bg-slate-100", chipText: "text-slate-500" },
};

/* ------------------------------------------------------------------ */
/*  Skeleton loader                                                     */
/* ------------------------------------------------------------------ */

function OfferSkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="border border-border rounded-md p-4 bg-card space-y-3"
        >
          <div className="flex items-center gap-2">
            <div className="h-4 w-12 bg-slate-200 rounded animate-pulse" />
            <div className="h-3 w-32 bg-slate-200 rounded animate-pulse" />
          </div>
          <div className="h-3 w-3/4 bg-slate-200 rounded animate-pulse" />
          <div className="flex items-center justify-between">
            <div className="h-3 w-20 bg-slate-200 rounded animate-pulse" />
            <div className="h-7 w-20 bg-slate-200 rounded animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Offer card                                                          */
/* ------------------------------------------------------------------ */

function OfferCard({
  o,
  onUpdateStatus,
  pendingStatus,
}: {
  o: PersistedOffer;
  onUpdateStatus: (id: number, status: OfferStatus) => void;
  pendingStatus: OfferStatus | null;
}) {
  const exp = expiryCopy(o.expires_in_days);
  const expToneClass =
    exp.tone === "danger"
      ? "text-rose-600 font-semibold"
      : exp.tone === "warn"
        ? "text-amber-700"
        : exp.tone === "soft"
          ? "text-text-muted"
          : "text-text-soft";
  const statusCfg = STATUS_CONFIG[o.status];
  const dim = o.status !== "available";

  return (
    <div
      className={`border border-border rounded-md p-4 bg-card hover:shadow-card-hover transition-opacity ${
        dim ? "opacity-65" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-1.5 py-0.5 rounded-sm bg-slate-100 text-text text-[10px] font-semibold uppercase tracking-wide">
              {o.source}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded-sm text-[10px] font-semibold uppercase tracking-wide ${statusCfg.chipBg} ${statusCfg.chipText}`}
            >
              {statusCfg.label}
            </span>
            <h4 className="text-sm font-semibold text-text truncate">
              {o.merchant_name || o.title}
            </h4>
          </div>
          <p className="text-xs text-text-muted mt-1 line-clamp-2">{o.title}</p>
        </div>
        <div className="text-right shrink-0">
          {o.estimated_value_cents != null && o.estimated_value_cents > 0 && (
            <div className="text-base font-semibold tabular-nums text-warn">
              {fmtCents(o.estimated_value_cents)}/mo
            </div>
          )}
          <div className="text-[11px] text-text-soft">
            {fmtBps(o.reward_value_bps)} {o.reward_type}
            {o.reward_cap_cents != null && ` · cap ${fmtCents(o.reward_cap_cents)}`}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 mt-3 text-xs">
        <span className={expToneClass}>{exp.text}</span>
        <div className="flex items-center gap-2">
          {/* Activate flow:
              - For available offers, show "Activate →" which deep-links
                to the portal AND optimistically marks the offer activated
                (the user usually has to click Activate on the portal too,
                but our "activated" state means "I've seen this offer and
                I intend to use it" — close enough for tracking).
              - For activated, offer "Mark redeemed" once the bonus posts. */}
          {o.status === "available" && (
            <>
              <button
                onClick={() => onUpdateStatus(o.id, "dismissed")}
                disabled={pendingStatus === "dismissed"}
                className="px-2 py-1 text-[11px] text-text-muted hover:text-outflow disabled:opacity-50"
                title="Hide this offer — won't appear in available list"
              >
                Dismiss
              </button>
              {o.activation_url && (
                <a
                  href={o.activation_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => onUpdateStatus(o.id, "activated")}
                  className="px-2 py-1 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white"
                >
                  Activate →
                </a>
              )}
            </>
          )}
          {o.status === "activated" && (
            <>
              <button
                onClick={() => onUpdateStatus(o.id, "available")}
                className="px-2 py-1 text-[11px] text-text-muted hover:text-text"
              >
                Undo
              </button>
              <button
                onClick={() => onUpdateStatus(o.id, "redeemed")}
                disabled={pendingStatus === "redeemed"}
                className="px-2 py-1 text-xs font-semibold rounded border border-emerald-500 text-emerald-700 hover:bg-emerald-500 hover:text-white"
              >
                Mark redeemed
              </button>
            </>
          )}
          {(o.status === "dismissed" || o.status === "expired") && (
            <button
              onClick={() => onUpdateStatus(o.id, "available")}
              className="px-2 py-1 text-[11px] text-text-muted hover:text-text"
            >
              Restore
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Status strip — per-portal readiness                                */
/* ------------------------------------------------------------------ */

/** localStorage key for portals the user has hidden (e.g. "I don't have
 *  an Amex card"). Stored as a JSON array of site_keys. Read on mount,
 *  written when the user clicks Hide / Show hidden. */
const HIDDEN_PORTALS_KEY = "offers.hiddenPortals";

function loadHiddenPortals(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_PORTALS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function saveHiddenPortals(keys: string[]) {
  try {
    localStorage.setItem(HIDDEN_PORTALS_KEY, JSON.stringify(keys));
  } catch {
    /* localStorage disabled — silently no-op rather than blow up */
  }
}

function StatusStrip() {
  const status = useQuery({
    queryKey: ["offersStatus"],
    queryFn: api.offersStatus,
  });
  // Hidden portals live in localStorage; we keep a state mirror so
  // the component re-renders when the user toggles visibility.
  const [hidden, setHidden] = useState<string[]>(() => loadHiddenPortals());

  function hide(siteKey: string) {
    const next = Array.from(new Set([...hidden, siteKey]));
    setHidden(next);
    saveHiddenPortals(next);
  }
  function showAll() {
    setHidden([]);
    saveHiddenPortals([]);
  }

  if (status.isLoading) {
    return (
      <div className="bg-card border border-border rounded-md shadow-card mb-4 p-3">
        <div className="h-3 w-32 bg-slate-200 rounded animate-pulse mb-2" />
        <div className="h-3 w-2/3 bg-slate-200 rounded animate-pulse" />
      </div>
    );
  }
  if (!status.data) return null;
  const visiblePortals = status.data.portals.filter(
    (p) => !hidden.includes(p.site_key),
  );
  // Edge case: if the user hides every portal, the strip would be a
  // bare header. Show a tiny "Show all" prompt instead.
  if (visiblePortals.length === 0) {
    return (
      <div className="bg-card border border-border rounded-md shadow-card mb-4 p-3 flex items-center gap-3 text-xs text-text-muted">
        <span>All portals hidden.</span>
        <button
          onClick={showAll}
          className="text-brand hover:underline font-semibold"
        >
          Show all →
        </button>
      </div>
    );
  }
  return (
    <div className="bg-card border border-border rounded-md shadow-card mb-4 p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-text">Scraper readiness</h3>
        {hidden.length > 0 && (
          <button
            onClick={showAll}
            className="text-[11px] text-text-muted hover:text-brand"
          >
            Show {hidden.length} hidden →
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
        {visiblePortals.map((p) => (
          <div
            key={p.site_key}
            className="flex flex-col gap-1 p-2 border border-border rounded bg-slate-50/40"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold text-text">{p.name}</span>
              {p.auth_state_present ? (
                <span className="text-emerald-700 text-[11px] font-semibold inline-flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  Logged in
                  {p.auth_state_age_days != null && ` (${p.auth_state_age_days}d ago)`}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="text-rose-700 text-[11px] font-semibold inline-flex items-center gap-1">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500" />
                    Auth missing
                  </span>
                  <button
                    onClick={() => hide(p.site_key)}
                    className="text-[10px] text-text-soft hover:text-text-muted underline-offset-2 hover:underline"
                    title="Hide this portal — useful if you don't have an account"
                  >
                    I don't have this
                  </button>
                </span>
              )}
            </div>
            {!p.auth_state_present && (
              // Inline bootstrap guidance — copy-paste runnable, no
              // hunting in MANUAL_TASKS.md. Click-to-copy makes it a
              // one-keystroke flow.
              <div className="text-[11px] text-text-muted">
                Run in your backend PowerShell (with venv active):
                <code className="block mt-1 bg-slate-100 text-slate-800 px-2 py-1 rounded font-mono select-all">
                  {p.bootstrap_command}
                </code>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Last scrape summary                                                 */
/* ------------------------------------------------------------------ */

function LastScrapeSummary({ result }: { result: OfferScrapeResponse }) {
  return (
    <div className="bg-card border border-border rounded-md shadow-card mb-4 overflow-hidden">
      <div className="px-4 py-2 border-b border-border bg-emerald-50/40">
        <h3 className="text-sm font-semibold text-text">
          Last scrape — {result.matches.length} matches ·{" "}
          {fmtCents(result.total_estimated_value_cents)} est/mo
        </h3>
      </div>
      <div className="px-4 py-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
        {result.summaries.map((s) => (
          <div
            key={s.site_key}
            className="flex items-center justify-between gap-3 py-1"
          >
            <span className="font-semibold text-text">{s.name}</span>
            {s.auth_missing ? (
              <span className="text-warn font-semibold">
                auth missing — re-login required
              </span>
            ) : s.error ? (
              <span className="text-outflow truncate" title={s.error}>
                {s.error}
              </span>
            ) : (
              <span className="text-text-muted tabular-nums">
                {s.rows_seen} seen · {s.rows_created} new · {s.rows_updated} updated
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */

type StatusFilter = OfferStatus | "all";
type SourceFilter = string | "all"; // "chase", "amex", "all"
type ExpiryFilter = "any" | "soon"; // "soon" = within 7 days

export default function OffersPanel() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("available");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [expiryFilter, setExpiryFilter] = useState<ExpiryFilter>("any");
  const [lastScrape, setLastScrape] = useState<OfferScrapeResponse | null>(null);
  // Tracks which row's status update is in flight, so we can dim the
  // right buttons. Keyed by offer id.
  const [pendingMap, setPendingMap] = useState<Record<number, OfferStatus>>({});

  // Persistent list — fetched on mount, refetched on scrape success.
  const offers = useQuery({
    queryKey: ["offers", "all"],
    queryFn: () => api.listOffers(),
  });
  const status = useQuery({
    queryKey: ["offersStatus"],
    queryFn: api.offersStatus,
  });

  const scrape = useMutation({
    mutationFn: api.scrapeOffers,
    onSuccess: (r) => {
      setLastScrape(r);
      qc.invalidateQueries({ queryKey: ["offers"] });
      qc.invalidateQueries({ queryKey: ["offersStatus"] });
      qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
    },
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, s }: { id: number; s: OfferStatus }) =>
      api.updateOfferStatus(id, s),
    onMutate: ({ id, s }) => {
      setPendingMap((m) => ({ ...m, [id]: s }));
    },
    onSettled: (_d, _e, vars) => {
      setPendingMap((m) => {
        const { [vars.id]: _drop, ...rest } = m;
        return rest;
      });
      qc.invalidateQueries({ queryKey: ["offers"] });
      qc.invalidateQueries({ queryKey: ["offersStatus"] });
    },
  });

  /* --- Derived view: apply filters client-side, since we already
   * fetched the full list. Filtering server-side would mean refetching
   * on every chip click. The list is small (rarely more than a few
   * dozen offers), so client-side is fine. --- */
  const all = offers.data ?? [];
  const filtered = all.filter((o) => {
    if (statusFilter !== "all" && o.status !== statusFilter) return false;
    if (sourceFilter !== "all" && o.source !== sourceFilter) return false;
    if (
      expiryFilter === "soon" &&
      (o.expires_in_days == null || o.expires_in_days < 0 || o.expires_in_days > 7)
    )
      return false;
    return true;
  });

  // Counts for chip labels
  const counts: Record<StatusFilter, number> = {
    all: all.length,
    available: 0,
    activated: 0,
    redeemed: 0,
    expired: 0,
    dismissed: 0,
  };
  for (const o of all) counts[o.status] += 1;
  const sourceCounts: Record<string, number> = {};
  for (const o of all) sourceCounts[o.source] = (sourceCounts[o.source] ?? 0) + 1;
  const expiringSoonCount = all.filter(
    (o) =>
      o.status === "available" &&
      o.expires_in_days != null &&
      o.expires_in_days >= 0 &&
      o.expires_in_days <= 7,
  ).length;
  const totalEstMonthly = all
    .filter((o) => o.status === "available")
    .reduce((sum, o) => sum + (o.estimated_value_cents ?? 0), 0);

  // Most-recent updated_at across all offers acts as our "last scrape"
  // anchor — there's no dedicated last_scraped_at on the OffersStatus
  // payload yet, but every scrape writes/updates rows, so the freshest
  // updated_at is a reliable proxy. Fed into the SyncFreshnessChip in
  // the hero so the user sees at a glance whether the pipeline is stale.
  const lastScrapeAt: string | null = all.length
    ? all.reduce<string>((acc, o) => (o.updated_at > acc ? o.updated_at : acc), all[0].updated_at)
    : null;

  /* --- Empty-state copy varies by filter so it always tells the user
   * something useful — never just "Empty." Sprint 33 — when the
   * pipeline is empty AND no portal is bootstrapped, we render a
   * richer EmptyState component below; this string only handles the
   * narrower "library has rows but the current filter empties them"
   * case. --- */
  let emptyCopy: string | null = null;
  if (filtered.length === 0 && !offers.isLoading && all.length > 0) {
    if (statusFilter === "available") {
      emptyCopy = "No available offers under this filter — try broadening below.";
    } else {
      emptyCopy = `No ${statusFilter} offers under this filter.`;
    }
  }
  // Whether to render the full "let's get you set up" empty-state card.
  const showFirstRunEmpty =
    !offers.isLoading && all.length === 0 && status.data != null;

  if (offers.isError) {
    return <PanelError title="Couldn't load offers." error={offers.error} onRetry={() => offers.refetch()} />;
  }

  return (
    <div>
      <StatusStrip />

      {/* Hero summary + scrape control */}
      <div className="bg-card border border-border rounded-md shadow-card mb-4 p-4 flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center gap-3 flex-wrap">
            <h3 className="text-sm font-semibold text-text">Card offers pipeline</h3>
            <SyncFreshnessChip syncedAt={lastScrapeAt} label="Last scrape" />
          </div>
          <p className="text-xs text-text-muted mt-0.5">
            {status.data
              ? `${status.data.available_offers} available, ${status.data.activated_offers} activated, ${status.data.expiring_within_7_days} expiring within 7 days.`
              : "Loading status…"}
          </p>
        </div>
        <div className="flex items-baseline gap-1 ml-auto">
          <span className="text-2xl font-semibold tabular-nums text-warn">
            {fmtCents(totalEstMonthly)}
          </span>
          <span className="text-xs text-text-muted">est/mo on the table</span>
        </div>
        <button
          onClick={() => scrape.mutate()}
          disabled={scrape.isPending}
          className="px-4 py-2 text-sm font-semibold rounded bg-brand text-white hover:bg-brand-navy disabled:opacity-50"
        >
          {scrape.isPending ? "Scraping…" : "Scrape now"}
        </button>
      </div>

      {/* Expiring-soon banner — only shown when there's at least one
          and we're not already filtered to "soon", to avoid redundancy */}
      {expiringSoonCount > 0 && expiryFilter !== "soon" && (
        <div className="bg-amber-50 border border-amber-200 rounded-md mb-4 p-3 flex items-center gap-3 text-sm text-amber-900">
          <span className="font-semibold">⏳ {expiringSoonCount} expiring soon</span>
          <span className="text-xs">
            Available offers within 7 days — activate before they're gone.
          </span>
          <button
            onClick={() => {
              setExpiryFilter("soon");
              setStatusFilter("available");
            }}
            className="ml-auto px-3 py-1 text-xs font-semibold rounded border border-amber-400 text-amber-900 hover:bg-amber-100"
          >
            Show only these →
          </button>
        </div>
      )}

      {/* Filter chips. Two rows: status + source. Each chip shows count
          to give users a sense of pipeline volume without scrolling. */}
      <div className="bg-card border border-border rounded-md shadow-card mb-4 p-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase font-semibold tracking-wide text-text-soft mr-1">
            Status
          </span>
          {(
            ["all", "available", "activated", "redeemed", "expired", "dismissed"] as StatusFilter[]
          ).map((s) => {
            const active = statusFilter === s;
            const n = counts[s];
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                disabled={n === 0 && s !== "all" && !active}
                className={`px-2.5 py-1 text-xs rounded-full border capitalize transition-colors ${
                  active
                    ? "border-brand text-brand-navy bg-brand/5 font-semibold"
                    : "border-border text-text-muted hover:border-text-muted disabled:opacity-40 disabled:hover:border-border"
                }`}
              >
                {s} ({n})
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase font-semibold tracking-wide text-text-soft mr-1">
            Portal
          </span>
          <button
            onClick={() => setSourceFilter("all")}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
              sourceFilter === "all"
                ? "border-brand text-brand-navy bg-brand/5 font-semibold"
                : "border-border text-text-muted hover:border-text-muted"
            }`}
          >
            All
          </button>
          {Object.entries(sourceCounts).map(([src, n]) => (
            <button
              key={src}
              onClick={() => setSourceFilter(src)}
              className={`px-2.5 py-1 text-xs rounded-full border capitalize transition-colors ${
                sourceFilter === src
                  ? "border-brand text-brand-navy bg-brand/5 font-semibold"
                  : "border-border text-text-muted hover:border-text-muted"
              }`}
            >
              {src} ({n})
            </button>
          ))}
          <span className="ml-auto text-[10px] uppercase font-semibold tracking-wide text-text-soft">
            Expiry
          </span>
          <button
            onClick={() => setExpiryFilter("any")}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
              expiryFilter === "any"
                ? "border-brand text-brand-navy bg-brand/5 font-semibold"
                : "border-border text-text-muted hover:border-text-muted"
            }`}
          >
            Any
          </button>
          <button
            onClick={() => setExpiryFilter("soon")}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
              expiryFilter === "soon"
                ? "border-amber-400 text-amber-900 bg-amber-50 font-semibold"
                : "border-border text-text-muted hover:border-text-muted"
            }`}
          >
            ≤ 7d ({expiringSoonCount})
          </button>
        </div>
      </div>

      {/* Last-scrape result, if present this session */}
      {lastScrape && <LastScrapeSummary result={lastScrape} />}

      {/* Main grid */}
      {offers.isLoading && <OfferSkeletonGrid />}
      {showFirstRunEmpty && (
        // Sprint 33 — first-run empty state with a clear two-step
        // setup path. Beats the prior single-sentence "Bootstrap a
        // portal above" which made the user hunt for the form.
        <div className="bg-card border border-border rounded-md shadow-card p-6">
          <div className="flex items-start gap-4">
            <div
              className="text-3xl leading-none flex-shrink-0"
              aria-hidden="true"
            >
              🎁
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-text">
                Pull live offers from your card portals
              </div>
              <div className="text-xs text-text-muted mt-1 leading-relaxed max-w-2xl">
                Chase Offers and Amex Offers list 5–30 active promos per card per
                month — bonus points on dining, statement credits at specific
                merchants, etc. We scrape both, surface them here, and rank by{" "}
                <span className="text-text">estimated $/month on the table</span>.
                Most users find $20–$80/mo they would have missed.
              </div>
              <ol className="text-xs text-text-muted mt-3 space-y-1.5">
                <li className="flex items-start gap-2">
                  <span className="text-text-soft tabular-nums w-3">1.</span>
                  <span>
                    {status.data?.portals.some((p) => p.auth_state_present) ? (
                      <>
                        <span className="text-inflow font-semibold">
                          ✓ {status.data!.portals
                            .filter((p) => p.auth_state_present)
                            .map((p) => p.name)
                            .join(" + ")}{" "}
                          ready
                        </span>{" "}
                        — bootstrap is done. Hit Scrape now to pull live offers.
                      </>
                    ) : (
                      <>
                        <span className="font-semibold text-text">
                          Bootstrap a portal.
                        </span>{" "}
                        Run the bootstrap command in the readiness strip above for
                        either Chase or Amex (one-time, ~30 seconds per portal).
                      </>
                    )}
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-text-soft tabular-nums w-3">2.</span>
                  <span>
                    Hit{" "}
                    <span className="font-mono bg-hover px-1 py-0.5 rounded text-[11px]">
                      Scrape now
                    </span>{" "}
                    above. We'll pull the latest, dedupe what you've already
                    activated, and rank what's left by est. $/month.
                  </span>
                </li>
              </ol>
              <div className="text-[11px] text-text-soft mt-3 italic">
                Offers expire fast (typically 4–8 weeks). Re-scrape weekly to
                keep the pipeline current.
              </div>
            </div>
          </div>
        </div>
      )}
      {!offers.isLoading && emptyCopy && (
        <div className="bg-card border border-border rounded-md shadow-card p-6 text-center text-sm text-text-muted">
          {emptyCopy}
        </div>
      )}
      {!offers.isLoading && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {filtered.map((o) => (
            <OfferCard
              key={o.id}
              o={o}
              onUpdateStatus={(id, s) => updateStatus.mutate({ id, s })}
              pendingStatus={pendingMap[o.id] ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );
}
