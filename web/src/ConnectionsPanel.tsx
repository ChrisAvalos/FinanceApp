import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Account, type PlaidItem } from "./api/client";
import { loadPlaidLink } from "./plaidLink";
import SyncFreshnessChip from "./components/SyncFreshness";

/* ------------------------------------------------------------------ */
/*  Status badge                                                       */
/* ------------------------------------------------------------------ */

const ITEM_STATUS_BADGE: Record<PlaidItem["status"], string> = {
  good: "bg-emerald-50 text-inflow",
  login_required: "bg-amber-50 text-warn",
  error: "bg-red-50 text-outflow",
};

/* Friendly per-product chip styling. The product list comes from
 * Plaid's billed_products; we color the high-signal ones differently
 * so the user can eyeball which connections are pulling balances vs.
 * brokerage holdings vs. APR data without reading. */
const PRODUCT_CHIP_STYLE: Record<string, string> = {
  transactions: "bg-slate-100 text-text-muted",
  investments: "bg-violet-50 text-violet-700",
  liabilities: "bg-amber-50 text-amber-700",
  auth: "bg-slate-100 text-text-muted",
  identity: "bg-slate-100 text-text-muted",
};

function fmtDateTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ProductChips({ csv }: { csv: string | null }) {
  if (!csv) return <span className="text-text-soft">—</span>;
  const products = csv.split(",").map((s) => s.trim()).filter(Boolean);
  if (products.length === 0) return <span className="text-text-soft">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {products.map((p) => (
        <span
          key={p}
          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${
            PRODUCT_CHIP_STYLE[p] ?? "bg-slate-100 text-text-muted"
          }`}
        >
          {p}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Card-benefits manual picker — inline per credit-card account.      */
/*  Plaid often returns generic "CREDIT CARD" as the account name      */
/*  which the auto-matcher in benefits/service.py can't bind to the    */
/*  YAML catalog. This picker lets the user say "this is my Sapphire   */
/*  Reserve" once, and the benefits panel populates from then on.      */
/* ------------------------------------------------------------------ */

function CardProfilePicker({ account }: { account: Account }) {
  const qc = useQueryClient();
  const profiles = useQuery({
    queryKey: ["cardProfiles"],
    queryFn: api.cardProfiles,
    staleTime: 60_000,
  });
  const setOverride = useMutation({
    mutationFn: (profileName: string | null) =>
      api.setCardProfileOverride(account.id, profileName),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plaidItems"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["cardBenefits"] });
    },
  });

  const current = account.card_profile_override ?? "";

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-text-soft whitespace-nowrap">What card is this?</span>
      <select
        value={current}
        disabled={setOverride.isPending}
        onChange={(e) => {
          const v = e.target.value;
          setOverride.mutate(v === "" ? null : v);
        }}
        className="px-2 py-1 border border-border rounded bg-card text-xs max-w-[260px]"
      >
        <option value="">Auto-match (default)</option>
        {(profiles.data ?? []).map((p) => (
          <option key={p.name} value={p.name}>
            {p.name} — ${(p.annual_fee_cents / 100).toFixed(0)} fee · ${(p.total_credit_value_cents / 100).toFixed(0)} credits
          </option>
        ))}
      </select>
      {setOverride.isPending && (
        <span className="text-text-soft">Saving…</span>
      )}
      {setOverride.data && !setOverride.isPending && (
        <span className="text-inflow">✓</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */

export default function ConnectionsPanel() {
  const qc = useQueryClient();
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  // Sprint 42 — id of the item currently mid-update-link, so we can
  // disable just that row's button (not all of them) while Plaid Link
  // is open.
  const [manageBusy, setManageBusy] = useState<number | null>(null);
  // Per-row Details toggle. Plaid item IDs and institution IDs are
  // useful for debugging but pure noise for daily use — hide by default.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const status = useQuery({ queryKey: ["plaidStatus"], queryFn: api.plaidStatus });
  const items = useQuery({
    queryKey: ["plaidItems"],
    queryFn: api.plaidListItems,
    // Refresh if user just connected/synced
    staleTime: 5_000,
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: api.listAccounts,
    staleTime: 5_000,
  });
  const schedule = useQuery({ queryKey: ["plaidSchedule"], queryFn: api.plaidSchedule });

  const syncItem = useMutation({
    mutationFn: (id: number) => api.plaidSyncItem(id),
    onSuccess: () => qc.invalidateQueries(),
  });
  const syncAll = useMutation({
    mutationFn: api.plaidSyncAll,
    onSuccess: () => qc.invalidateQueries(),
  });
  const deleteItem = useMutation({
    mutationFn: (id: number) => api.plaidDeleteItem(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["plaidItems"] }),
  });
  const exchange = useMutation({
    mutationFn: (public_token: string) => api.plaidExchange(public_token),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["plaidItems"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
  });
  // Sprint 43 — on-demand balance-scraper run (Albert Savings +
  // Investing for now). The result carries per-site outcome so the
  // UI can surface auth-state-missing as "run bootstrap" guidance.
  const [scrapeMsg, setScrapeMsg] = useState<string | null>(null);
  const scrapeBalances = useMutation({
    mutationFn: api.runBalanceScrapers,
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.balances_written > 0) {
        parts.push(
          `Wrote ${r.balances_written} balance${
            r.balances_written === 1 ? "" : "s"
          }`,
        );
      }
      if (r.accounts_created > 0) {
        parts.push(
          `created ${r.accounts_created} new account${
            r.accounts_created === 1 ? "" : "s"
          }`,
        );
      }
      if (r.sites_auth_missing.length > 0) {
        parts.push(
          `${r.sites_auth_missing.join(", ")} needs bootstrap — see scrapers/balances/bootstrap.py`,
        );
      }
      if (r.sites_failed.length > 0) {
        parts.push(
          `${r.sites_failed.length} site${
            r.sites_failed.length === 1 ? "" : "s"
          } failed`,
        );
      }
      setScrapeMsg(parts.length ? parts.join(" · ") : "No balances scraped.");
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["netWorth"] });
    },
    onError: (e: unknown) => {
      setScrapeMsg(
        `Scrape failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    },
  });

  async function onConnectBank() {
    setLinkError(null);
    setLinkBusy(true);
    try {
      const { link_token } = await api.plaidCreateLinkToken();
      const Plaid = await loadPlaidLink();
      const handler = Plaid.create({
        token: link_token,
        onSuccess: (publicToken) => {
          exchange.mutate(publicToken);
        },
        onExit: (err) => {
          if (err) setLinkError(String((err as { display_message?: string })?.display_message ?? err));
          setLinkBusy(false);
        },
      });
      handler.open();
      // Link runs async — once user finishes, onSuccess triggers exchange.
      // onExit handles both cancel + error.
    } catch (exc) {
      setLinkError(exc instanceof Error ? exc.message : String(exc));
      setLinkBusy(false);
    }
  }

  // Sprint 42 — re-open Plaid Link in UPDATE MODE for an existing
  // item. The user gets the account-selection screen pre-bound to
  // their existing Albert / Chase / E*TRADE connection so they can
  // tick the Savings / Investing / additional checking accounts they
  // missed the first time around. On Plaid's onSuccess we don't need
  // to call /exchange — the token is the same; we just trigger a
  // /sync to pull the newly-shared accounts via /accounts/get.
  async function onManageAccounts(itemId: number) {
    setLinkError(null);
    setManageBusy(itemId);
    try {
      const { link_token } = await api.plaidCreateUpdateLinkToken(itemId);
      const Plaid = await loadPlaidLink();
      const handler = Plaid.create({
        token: link_token,
        onSuccess: () => {
          // Trigger a sync so /accounts/get fires fresh and the new
          // accounts land in our DB. Don't await — the user can keep
          // using the panel while it runs.
          syncItem.mutate(itemId);
          setManageBusy(null);
        },
        onExit: (err) => {
          if (err) {
            setLinkError(
              String((err as { display_message?: string })?.display_message ?? err),
            );
          }
          setManageBusy(null);
        },
      });
      handler.open();
    } catch (exc) {
      setLinkError(exc instanceof Error ? exc.message : String(exc));
      setManageBusy(null);
    }
  }

  // Sandbox shortcut: mint a public_token server-side + exchange it, skipping
  // the Plaid Link UI entirely. Huge quality-of-life win for dev.
  async function onSandboxConnect() {
    setLinkError(null);
    setLinkBusy(true);
    try {
      const { public_token } = await api.plaidSandboxPublicToken();
      await exchange.mutateAsync(public_token);
    } catch (exc) {
      setLinkError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setLinkBusy(false);
    }
  }

  /* ------------- Not configured state ---------------- */
  if (status.data && !status.data.configured) {
    return (
      <div className="bg-card border border-border rounded-md shadow-card p-6">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-brand-light flex items-center justify-center text-brand font-bold">
            P
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-text">Connect a bank via Plaid</div>
            <div className="text-xs text-text-muted mt-1">
              Plaid credentials aren't configured yet. Add{" "}
              <code className="text-brand">PLAID_CLIENT_ID</code> and{" "}
              <code className="text-brand">PLAID_SECRET</code> to{" "}
              <code className="text-brand">backend/.env</code>, then restart the
              API. You can grab sandbox keys at{" "}
              <a
                className="text-brand hover:text-brand-navy underline"
                href="https://dashboard.plaid.com/signup"
                target="_blank"
                rel="noreferrer"
              >
                dashboard.plaid.com
              </a>
              .
            </div>
            <div className="text-[11px] text-text-soft mt-2">
              Env: <span className="font-mono">{status.data.env}</span> · client_id:{" "}
              {status.data.client_id_present ? "✓" : "—"} · secret:{" "}
              {status.data.secret_present ? "✓" : "—"}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const connected = items.data ?? [];
  const isSandbox = status.data?.env === "sandbox";

  return (
    <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
      {/* Connect row */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-hover">
        <div>
          <div className="text-sm font-semibold text-text">Bank connections via Plaid</div>
          <div className="text-xs text-text-muted mt-0.5">
            {isSandbox && (
              <span className="inline-block mr-2 px-2 py-0.5 bg-amber-50 text-warn font-semibold uppercase tracking-wide text-[10px] rounded">
                sandbox
              </span>
            )}
            {connected.length === 0
              ? "Connect a checking or credit card to pull real transactions."
              : `${connected.length} connection${connected.length === 1 ? "" : "s"}`}
            {schedule.data?.enabled && schedule.data.running && (
              <span className="ml-2 text-text-soft">
                · auto-refresh every {schedule.data.interval_hours}h
                {schedule.data.next_run_time && (
                  <> · next {fmtDateTime(schedule.data.next_run_time)}</>
                )}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {connected.length > 0 && (
            <button
              onClick={() => syncAll.mutate()}
              disabled={syncAll.isPending}
              className="px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors disabled:opacity-60"
            >
              {syncAll.isPending ? "Syncing…" : "Sync all"}
            </button>
          )}
          {/* Sprint 43 — trigger the supplemental balance scrapers
              (Albert Savings + Investing today). Lives next to Sync
              all because conceptually it's the same daily "refresh
              all bank data" action, just for the slice Plaid doesn't
              cover. Auth-missing surfaces via scrapeMsg below. */}
          <button
            onClick={() => scrapeBalances.mutate()}
            disabled={scrapeBalances.isPending}
            className="px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors disabled:opacity-60"
            title="Run the supplemental balance scrapers (Albert Savings + Investing). Run scrapers/balances/bootstrap.py once before the first use."
          >
            {scrapeBalances.isPending ? "Scraping…" : "Scrape balances"}
          </button>
          {isSandbox && (
            <button
              onClick={onSandboxConnect}
              disabled={linkBusy || exchange.isPending}
              className="px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors disabled:opacity-60"
              title="Skip Plaid Link — sandbox only"
            >
              {exchange.isPending ? "Linking…" : "Sandbox quick-connect"}
            </button>
          )}
          <button
            onClick={onConnectBank}
            disabled={linkBusy || exchange.isPending}
            className="px-4 py-2 bg-brand text-white text-sm font-semibold rounded-md hover:bg-brand-navy transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {linkBusy ? "Opening Plaid…" : "Connect a bank"}
          </button>
        </div>
      </div>

      {linkError && (
        <div className="px-5 py-3 bg-red-50 text-outflow text-xs border-b border-border">
          {linkError}
        </div>
      )}

      {/* Sprint 43 — balance-scraper result + dismiss button. Lives
          right below the header so the user immediately sees what
          happened (no balances, auth missing, etc.). */}
      {scrapeMsg && (
        <div className="px-5 py-2 bg-brand-light/40 text-xs border-b border-border flex items-center justify-between">
          <span className="text-text">{scrapeMsg}</span>
          <button
            onClick={() => setScrapeMsg(null)}
            className="text-text-soft hover:text-text"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Surface sync mutation errors so a 5xx doesn't look like a no-op.
          Without this, useMutation.error gets swallowed silently. */}
      {syncAll.isError && (
        <div className="px-5 py-3 bg-red-50 text-outflow text-xs border-b border-border">
          Sync all failed —{" "}
          {syncAll.error instanceof Error ? syncAll.error.message : String(syncAll.error)}
        </div>
      )}
      {syncItem.isError && (
        <div className="px-5 py-3 bg-red-50 text-outflow text-xs border-b border-border">
          Sync failed —{" "}
          {syncItem.error instanceof Error ? syncItem.error.message : String(syncItem.error)}
        </div>
      )}

      {/* Connected items list */}
      {connected.length === 0 ? (
        <div className="p-8 text-center text-text-muted text-sm">
          No bank connections yet.
        </div>
      ) : (
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left">Institution</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Products</th>
              <th className="px-4 py-2 text-left">Last sync</th>
              <th className="px-4 py-2 text-right" />
            </tr>
          </thead>
          <tbody>
            {connected.map((it) => {
              const isOpen = expanded.has(it.id);
              return (
                <Fragment key={it.id}>
                  <tr
                    className="border-b border-border last:border-0 hover:bg-hover"
                  >
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium">
                        {/* Prefer the friendly institution name (e.g. "Chase").
                            Fall back to Plaid's institution_id (e.g. "ins_56")
                            only when the name lookup hasn't run yet. */}
                        {it.institution_name ?? it.plaid_institution_id ?? "Unknown"}
                      </div>
                      <button
                        onClick={() => toggleExpanded(it.id)}
                        className="text-[11px] text-text-soft hover:text-brand mt-0.5"
                      >
                        {isOpen ? "▾ Hide details" : "▸ Details"}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${ITEM_STATUS_BADGE[it.status]}`}
                      >
                        {it.status === "login_required" ? "relink" : it.status}
                      </span>
                      {it.last_error && (
                        <div className="text-[11px] text-outflow mt-1 max-w-xs truncate">
                          {it.last_error}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <ProductChips csv={it.granted_products ?? null} />
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <SyncFreshnessChip syncedAt={it.last_synced_at} />
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        onClick={() => syncItem.mutate(it.id)}
                        className="text-xs text-brand hover:text-brand-navy font-semibold"
                        disabled={syncItem.isPending}
                      >
                        {syncItem.isPending && syncItem.variables === it.id ? "Syncing…" : "Sync"}
                      </button>
                      {/* Sprint 42 — Manage accounts: opens Plaid Link in
                          update mode so the user can re-pick which
                          accounts to share. Fixes the "I only linked
                          checking, where's my savings?" scenario without
                          forcing a full re-link. */}
                      <button
                        onClick={() => onManageAccounts(it.id)}
                        disabled={manageBusy === it.id}
                        className="text-xs text-brand hover:text-brand-navy font-semibold ml-3"
                        title="Re-open Plaid Link to add or remove accounts shared with this app"
                      >
                        {manageBusy === it.id ? "Opening…" : "Manage accounts"}
                      </button>
                      <button
                        onClick={() => {
                          // Cascade-delete is now real (see DELETE /plaid/items/{id}
                          // in plaid.py). Keep the warning copy in sync with what
                          // actually happens, otherwise the UI lies to the user.
                          if (
                            confirm(
                              `Remove ${
                                it.institution_name ?? "this connection"
                              }?\n\nThis will delete the connection AND every account, transaction, and balance snapshot tied to it. Subscriptions, offers, and goals that referenced these accounts will be unlinked but kept.\n\nThis cannot be undone.`,
                            )
                          ) {
                            deleteItem.mutate(it.id);
                          }
                        }}
                        className="text-xs text-text-muted hover:text-outflow font-semibold ml-3"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-slate-50 border-b border-border">
                      <td colSpan={5} className="px-6 py-3">
                        {/* Credit-card accounts under this Plaid Item — surface
                            a per-card "What card is this?" picker so the user
                            can manually bind a generic-named card to the
                            benefits catalog. Skip if no cards in this item. */}
                        {(() => {
                          const cardsForItem = (accounts.data ?? []).filter(
                            (a) =>
                              a.account_type === "credit_card" &&
                              // PlaidItem<->Account joinage isn't on the items
                              // payload, so we use institution_id as a proxy
                              // (one institution = one item in practice; if
                              // the user re-links the same bank it gets a new
                              // institution row in our DB).
                              a.institution_id === it.institution_id,
                          );
                          if (cardsForItem.length === 0) return null;
                          return (
                            <div className="mb-3 border-b border-border pb-3 space-y-2">
                              <div className="text-[11px] font-semibold text-text uppercase tracking-wide">
                                Credit cards on this connection
                              </div>
                              {cardsForItem.map((card) => (
                                <div key={card.id} className="flex flex-wrap items-center gap-3">
                                  <div className="text-xs text-text-muted">
                                    <span className="font-semibold text-text">{card.name}</span>
                                    {card.mask && (
                                      <span className="ml-1 font-mono text-text-soft">····{card.mask}</span>
                                    )}
                                  </div>
                                  <CardProfilePicker account={card} />
                                </div>
                              ))}
                              <div className="text-[10px] text-text-soft">
                                Plaid often returns generic "CREDIT CARD" names
                                that the benefits matcher can't bind. Pick the
                                actual card here to populate the Card benefits
                                panel and Money found cohort.
                              </div>
                            </div>
                          );
                        })()}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 text-[11px] text-text-muted">
                          <div>
                            <span className="text-text-soft">Plaid institution ID:</span>{" "}
                            <span className="font-mono">{it.plaid_institution_id ?? "—"}</span>
                          </div>
                          <div>
                            <span className="text-text-soft">Plaid item ID:</span>{" "}
                            <span className="font-mono">{it.plaid_item_id}</span>
                          </div>
                          <div>
                            <span className="text-text-soft">Internal item #:</span>{" "}
                            <span className="font-mono">{it.id}</span>
                          </div>
                          <div>
                            <span className="text-text-soft">Internal institution #:</span>{" "}
                            <span className="font-mono">{it.institution_id}</span>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
