import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api/client";
import { loadPlaidLink } from "./plaidLink";
import SyncFreshnessChip from "./components/SyncFreshness";
/* ------------------------------------------------------------------ */
/*  Status badge                                                       */
/* ------------------------------------------------------------------ */
const ITEM_STATUS_BADGE = {
    good: "bg-emerald-50 text-inflow",
    login_required: "bg-amber-50 text-warn",
    error: "bg-red-50 text-outflow",
};
/* Friendly per-product chip styling. The product list comes from
 * Plaid's billed_products; we color the high-signal ones differently
 * so the user can eyeball which connections are pulling balances vs.
 * brokerage holdings vs. APR data without reading. */
const PRODUCT_CHIP_STYLE = {
    transactions: "bg-slate-100 text-text-muted",
    investments: "bg-violet-50 text-violet-700",
    liabilities: "bg-amber-50 text-amber-700",
    auth: "bg-slate-100 text-text-muted",
    identity: "bg-slate-100 text-text-muted",
};
function fmtDateTime(iso) {
    if (!iso)
        return "never";
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}
function ProductChips({ csv }) {
    if (!csv)
        return _jsx("span", { className: "text-text-soft", children: "\u2014" });
    const products = csv.split(",").map((s) => s.trim()).filter(Boolean);
    if (products.length === 0)
        return _jsx("span", { className: "text-text-soft", children: "\u2014" });
    return (_jsx("div", { className: "flex flex-wrap gap-1", children: products.map((p) => (_jsx("span", { className: `inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${PRODUCT_CHIP_STYLE[p] ?? "bg-slate-100 text-text-muted"}`, children: p }, p))) }));
}
/* ------------------------------------------------------------------ */
/*  Card-benefits manual picker — inline per credit-card account.      */
/*  Plaid often returns generic "CREDIT CARD" as the account name      */
/*  which the auto-matcher in benefits/service.py can't bind to the    */
/*  YAML catalog. This picker lets the user say "this is my Sapphire   */
/*  Reserve" once, and the benefits panel populates from then on.      */
/* ------------------------------------------------------------------ */
function CardProfilePicker({ account }) {
    const qc = useQueryClient();
    const profiles = useQuery({
        queryKey: ["cardProfiles"],
        queryFn: api.cardProfiles,
        staleTime: 60_000,
    });
    const setOverride = useMutation({
        mutationFn: (profileName) => api.setCardProfileOverride(account.id, profileName),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["plaidItems"] });
            qc.invalidateQueries({ queryKey: ["accounts"] });
            qc.invalidateQueries({ queryKey: ["cardBenefits"] });
        },
    });
    const current = account.card_profile_override ?? "";
    return (_jsxs("div", { className: "flex items-center gap-2 text-xs", children: [_jsx("span", { className: "text-text-soft whitespace-nowrap", children: "What card is this?" }), _jsxs("select", { value: current, disabled: setOverride.isPending, onChange: (e) => {
                    const v = e.target.value;
                    setOverride.mutate(v === "" ? null : v);
                }, className: "px-2 py-1 border border-border rounded bg-card text-xs max-w-[260px]", children: [_jsx("option", { value: "", children: "Auto-match (default)" }), (profiles.data ?? []).map((p) => (_jsxs("option", { value: p.name, children: [p.name, " \u2014 $", (p.annual_fee_cents / 100).toFixed(0), " fee \u00B7 $", (p.total_credit_value_cents / 100).toFixed(0), " credits"] }, p.name)))] }), setOverride.isPending && (_jsx("span", { className: "text-text-soft", children: "Saving\u2026" })), setOverride.data && !setOverride.isPending && (_jsx("span", { className: "text-inflow", children: "\u2713" }))] }));
}
/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */
export default function ConnectionsPanel() {
    const qc = useQueryClient();
    const [linkError, setLinkError] = useState(null);
    const [linkBusy, setLinkBusy] = useState(false);
    // Per-row Details toggle. Plaid item IDs and institution IDs are
    // useful for debugging but pure noise for daily use — hide by default.
    const [expanded, setExpanded] = useState(new Set());
    const toggleExpanded = (id) => setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id))
            next.delete(id);
        else
            next.add(id);
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
        mutationFn: (id) => api.plaidSyncItem(id),
        onSuccess: () => qc.invalidateQueries(),
    });
    const syncAll = useMutation({
        mutationFn: api.plaidSyncAll,
        onSuccess: () => qc.invalidateQueries(),
    });
    const deleteItem = useMutation({
        mutationFn: (id) => api.plaidDeleteItem(id),
        onSuccess: () => qc.invalidateQueries({ queryKey: ["plaidItems"] }),
    });
    const exchange = useMutation({
        mutationFn: (public_token) => api.plaidExchange(public_token),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["plaidItems"] });
            qc.invalidateQueries({ queryKey: ["transactions"] });
            qc.invalidateQueries({ queryKey: ["summary"] });
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
                    if (err)
                        setLinkError(String(err?.display_message ?? err));
                    setLinkBusy(false);
                },
            });
            handler.open();
            // Link runs async — once user finishes, onSuccess triggers exchange.
            // onExit handles both cancel + error.
        }
        catch (exc) {
            setLinkError(exc instanceof Error ? exc.message : String(exc));
            setLinkBusy(false);
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
        }
        catch (exc) {
            setLinkError(exc instanceof Error ? exc.message : String(exc));
        }
        finally {
            setLinkBusy(false);
        }
    }
    /* ------------- Not configured state ---------------- */
    if (status.data && !status.data.configured) {
        return (_jsx("div", { className: "bg-card border border-border rounded-md shadow-card p-6", children: _jsxs("div", { className: "flex items-start gap-3", children: [_jsx("div", { className: "w-9 h-9 rounded-full bg-brand-light flex items-center justify-center text-brand font-bold", children: "P" }), _jsxs("div", { className: "flex-1", children: [_jsx("div", { className: "text-sm font-semibold text-text", children: "Connect a bank via Plaid" }), _jsxs("div", { className: "text-xs text-text-muted mt-1", children: ["Plaid credentials aren't configured yet. Add", " ", _jsx("code", { className: "text-brand", children: "PLAID_CLIENT_ID" }), " and", " ", _jsx("code", { className: "text-brand", children: "PLAID_SECRET" }), " to", " ", _jsx("code", { className: "text-brand", children: "backend/.env" }), ", then restart the API. You can grab sandbox keys at", " ", _jsx("a", { className: "text-brand hover:text-brand-navy underline", href: "https://dashboard.plaid.com/signup", target: "_blank", rel: "noreferrer", children: "dashboard.plaid.com" }), "."] }), _jsxs("div", { className: "text-[11px] text-text-soft mt-2", children: ["Env: ", _jsx("span", { className: "font-mono", children: status.data.env }), " \u00B7 client_id:", " ", status.data.client_id_present ? "✓" : "—", " \u00B7 secret:", " ", status.data.secret_present ? "✓" : "—"] })] })] }) }));
    }
    const connected = items.data ?? [];
    const isSandbox = status.data?.env === "sandbox";
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsxs("div", { className: "flex items-center justify-between px-5 py-4 border-b border-border bg-hover", children: [_jsxs("div", { children: [_jsx("div", { className: "text-sm font-semibold text-text", children: "Bank connections via Plaid" }), _jsxs("div", { className: "text-xs text-text-muted mt-0.5", children: [isSandbox && (_jsx("span", { className: "inline-block mr-2 px-2 py-0.5 bg-amber-50 text-warn font-semibold uppercase tracking-wide text-[10px] rounded", children: "sandbox" })), connected.length === 0
                                        ? "Connect a checking or credit card to pull real transactions."
                                        : `${connected.length} connection${connected.length === 1 ? "" : "s"}`, schedule.data?.enabled && schedule.data.running && (_jsxs("span", { className: "ml-2 text-text-soft", children: ["\u00B7 auto-refresh every ", schedule.data.interval_hours, "h", schedule.data.next_run_time && (_jsxs(_Fragment, { children: [" \u00B7 next ", fmtDateTime(schedule.data.next_run_time)] }))] }))] })] }), _jsxs("div", { className: "flex items-center gap-2", children: [connected.length > 0 && (_jsx("button", { onClick: () => syncAll.mutate(), disabled: syncAll.isPending, className: "px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors disabled:opacity-60", children: syncAll.isPending ? "Syncing…" : "Sync all" })), isSandbox && (_jsx("button", { onClick: onSandboxConnect, disabled: linkBusy || exchange.isPending, className: "px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors disabled:opacity-60", title: "Skip Plaid Link \u2014 sandbox only", children: exchange.isPending ? "Linking…" : "Sandbox quick-connect" })), _jsx("button", { onClick: onConnectBank, disabled: linkBusy || exchange.isPending, className: "px-4 py-2 bg-brand text-white text-sm font-semibold rounded-md hover:bg-brand-navy transition-colors disabled:opacity-60 disabled:cursor-not-allowed", children: linkBusy ? "Opening Plaid…" : "Connect a bank" })] })] }), linkError && (_jsx("div", { className: "px-5 py-3 bg-red-50 text-outflow text-xs border-b border-border", children: linkError })), connected.length === 0 ? (_jsx("div", { className: "p-8 text-center text-text-muted text-sm", children: "No bank connections yet." })) : (_jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left", children: "Institution" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Status" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Products" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Last sync" }), _jsx("th", { className: "px-4 py-2 text-right" })] }) }), _jsx("tbody", { children: connected.map((it) => {
                            const isOpen = expanded.has(it.id);
                            return (_jsxs(Fragment, { children: [_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsxs("td", { className: "px-4 py-3 text-sm", children: [_jsx("div", { className: "font-medium", children: it.institution_name ?? it.plaid_institution_id ?? "Unknown" }), _jsx("button", { onClick: () => toggleExpanded(it.id), className: "text-[11px] text-text-soft hover:text-brand mt-0.5", children: isOpen ? "▾ Hide details" : "▸ Details" })] }), _jsxs("td", { className: "px-4 py-3", children: [_jsx("span", { className: `inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${ITEM_STATUS_BADGE[it.status]}`, children: it.status === "login_required" ? "relink" : it.status }), it.last_error && (_jsx("div", { className: "text-[11px] text-outflow mt-1 max-w-xs truncate", children: it.last_error }))] }), _jsx("td", { className: "px-4 py-3", children: _jsx(ProductChips, { csv: it.granted_products ?? null }) }), _jsx("td", { className: "px-4 py-3 text-xs", children: _jsx(SyncFreshnessChip, { syncedAt: it.last_synced_at }) }), _jsxs("td", { className: "px-4 py-3 text-right whitespace-nowrap", children: [_jsx("button", { onClick: () => syncItem.mutate(it.id), className: "text-xs text-brand hover:text-brand-navy font-semibold", disabled: syncItem.isPending, children: syncItem.isPending && syncItem.variables === it.id ? "Syncing…" : "Sync" }), _jsx("button", { onClick: () => {
                                                            // Cascade-delete is now real (see DELETE /plaid/items/{id}
                                                            // in plaid.py). Keep the warning copy in sync with what
                                                            // actually happens, otherwise the UI lies to the user.
                                                            if (confirm(`Remove ${it.institution_name ?? "this connection"}?\n\nThis will delete the connection AND every account, transaction, and balance snapshot tied to it. Subscriptions, offers, and goals that referenced these accounts will be unlinked but kept.\n\nThis cannot be undone.`)) {
                                                                deleteItem.mutate(it.id);
                                                            }
                                                        }, className: "text-xs text-text-muted hover:text-outflow font-semibold ml-3", children: "Remove" })] })] }), isOpen && (_jsx("tr", { className: "bg-slate-50 border-b border-border", children: _jsxs("td", { colSpan: 5, className: "px-6 py-3", children: [(() => {
                                                    const cardsForItem = (accounts.data ?? []).filter((a) => a.account_type === "credit_card" &&
                                                        // PlaidItem<->Account joinage isn't on the items
                                                        // payload, so we use institution_id as a proxy
                                                        // (one institution = one item in practice; if
                                                        // the user re-links the same bank it gets a new
                                                        // institution row in our DB).
                                                        a.institution_id === it.institution_id);
                                                    if (cardsForItem.length === 0)
                                                        return null;
                                                    return (_jsxs("div", { className: "mb-3 border-b border-border pb-3 space-y-2", children: [_jsx("div", { className: "text-[11px] font-semibold text-text uppercase tracking-wide", children: "Credit cards on this connection" }), cardsForItem.map((card) => (_jsxs("div", { className: "flex flex-wrap items-center gap-3", children: [_jsxs("div", { className: "text-xs text-text-muted", children: [_jsx("span", { className: "font-semibold text-text", children: card.name }), card.mask && (_jsxs("span", { className: "ml-1 font-mono text-text-soft", children: ["\u00B7\u00B7\u00B7\u00B7", card.mask] }))] }), _jsx(CardProfilePicker, { account: card })] }, card.id))), _jsx("div", { className: "text-[10px] text-text-soft", children: "Plaid often returns generic \"CREDIT CARD\" names that the benefits matcher can't bind. Pick the actual card here to populate the Card benefits panel and Money found cohort." })] }));
                                                })(), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 text-[11px] text-text-muted", children: [_jsxs("div", { children: [_jsx("span", { className: "text-text-soft", children: "Plaid institution ID:" }), " ", _jsx("span", { className: "font-mono", children: it.plaid_institution_id ?? "—" })] }), _jsxs("div", { children: [_jsx("span", { className: "text-text-soft", children: "Plaid item ID:" }), " ", _jsx("span", { className: "font-mono", children: it.plaid_item_id })] }), _jsxs("div", { children: [_jsx("span", { className: "text-text-soft", children: "Internal item #:" }), " ", _jsx("span", { className: "font-mono", children: it.id })] }), _jsxs("div", { children: [_jsx("span", { className: "text-text-soft", children: "Internal institution #:" }), " ", _jsx("span", { className: "font-mono", children: it.institution_id })] })] })] }) }))] }, it.id));
                        }) })] }))] }));
}
