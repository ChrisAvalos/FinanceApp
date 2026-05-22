import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { api, fmtCents, } from "./api/client";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelStat } from "./components/Skeleton";
function MatchCard({ m, onLog }) {
    const c = m.catalog_entry;
    return (_jsxs("div", { className: "border border-border rounded-md p-4 bg-card hover:shadow-card-hover", children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "px-1.5 py-0.5 rounded-sm bg-violet-50 text-violet-700 text-[10px] font-semibold uppercase tracking-wide", children: c.agency }), _jsx("h4", { className: "text-sm font-semibold text-text", children: c.company_name }), m.already_logged && (_jsx("span", { className: "text-[10px] text-inflow font-semibold", children: "\u2713 logged" }))] }), _jsx("div", { className: "text-xs text-text mt-1 font-semibold", children: c.title }), _jsx("p", { className: "text-xs text-text-muted mt-1 line-clamp-3", children: c.eligibility_description }), _jsxs("div", { className: "text-[11px] text-text-soft mt-2", children: [m.matched_transactions, " matched txn", m.matched_transactions === 1 ? "" : "s", " \u00B7 spend ", fmtCents(m.matched_total_spend_cents)] }), m.sample_descriptions.length > 0 && (_jsxs("div", { className: "text-[11px] text-text-soft italic mt-1 truncate", children: ["e.g. ", m.sample_descriptions.slice(0, 2).join(" · ")] }))] }), _jsxs("div", { className: "text-right shrink-0", children: [_jsx("div", { className: "text-base font-semibold tabular-nums text-text", children: c.estimated_per_user_cents ? fmtCents(c.estimated_per_user_cents) : "—" }), _jsx("div", { className: "text-[11px] text-text-soft", children: "est. per user" })] })] }), _jsxs("div", { className: "flex items-center gap-2 mt-3", children: [c.claim_url && (_jsx("a", { href: c.claim_url, target: "_blank", rel: "noopener noreferrer", className: "px-3 py-1.5 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white", children: "Check eligibility \u2192" })), !m.already_logged && (_jsx("button", { onClick: onLog, className: "px-3 py-1.5 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy", children: "Log as candidate" }))] })] }));
}
function CatalogCard({ c }) {
    return (_jsxs("div", { className: "border border-border rounded-md p-3 bg-card", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "px-1.5 py-0.5 rounded-sm bg-violet-50 text-violet-700 text-[10px] font-semibold uppercase tracking-wide", children: c.agency }), _jsx("h5", { className: "text-xs font-semibold text-text", children: c.company_name })] }), _jsx("p", { className: "text-[11px] text-text-muted mt-1 line-clamp-2", children: c.title }), _jsxs("div", { className: "flex items-center justify-between text-[11px] mt-2", children: [_jsx("span", { className: "text-text-soft", children: c.estimated_per_user_cents ? `~${fmtCents(c.estimated_per_user_cents)}/user` : "Per user TBD" }), c.claim_url && (_jsx("a", { href: c.claim_url, target: "_blank", rel: "noopener noreferrer", className: "text-brand hover:underline", children: "Open" }))] })] }));
}
function RedressRecordRow({ r, onTransition, onDelete, }) {
    const [paidDraft, setPaidDraft] = useState("");
    return (_jsxs("div", { className: "border border-border rounded-md p-3 bg-card", children: [_jsxs("div", { className: "flex items-start justify-between", children: [_jsxs("div", { children: [_jsx("h5", { className: "text-sm font-semibold text-text", children: r.company_name }), _jsx("div", { className: "text-xs text-text-muted", children: r.title }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: [r.agency, " \u00B7 status ", r.status] })] }), _jsx("div", { className: "text-right", children: r.actual_payout_cents != null ? (_jsx("span", { className: "text-inflow font-semibold tabular-nums", children: fmtCents(r.actual_payout_cents) })) : (r.estimated_per_user_cents && _jsxs("span", { className: "text-text-muted tabular-nums", children: ["~", fmtCents(r.estimated_per_user_cents)] })) })] }), _jsxs("div", { className: "flex items-center gap-2 mt-2 flex-wrap", children: [r.claim_url && (_jsx("a", { href: r.claim_url, target: "_blank", rel: "noopener noreferrer", className: "text-xs text-brand hover:underline", children: "Claim URL \u2197" })), r.status === "candidate" || r.status === "eligible" ? (_jsx("button", { onClick: () => onTransition("pending_filed"), className: "px-2 py-1 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy", children: "Mark filed" })) : null, r.status === "pending_filed" && (_jsxs("form", { className: "flex items-center gap-1.5", onSubmit: (e) => {
                            e.preventDefault();
                            const v = parseFloat(paidDraft);
                            if (Number.isNaN(v) || v < 0)
                                return;
                            onTransition("paid", Math.round(v * 100));
                            setPaidDraft("");
                        }, children: [_jsx("span", { className: "text-xs text-text-muted", children: "$" }), _jsx("input", { type: "number", min: 0, step: 0.01, value: paidDraft, onChange: (e) => setPaidDraft(e.target.value), className: "w-20 px-2 py-1 text-xs border border-border rounded" }), _jsx("button", { type: "submit", disabled: !paidDraft, className: "px-2 py-1 text-xs font-semibold rounded bg-inflow text-white disabled:opacity-40", children: "Mark paid" })] })), _jsx("button", { onClick: () => { if (confirm("Delete?"))
                            onDelete(); }, className: "ml-auto text-xs text-text-muted hover:text-outflow", children: "Delete" })] })] }));
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
        mutationFn: ({ id, status, payout }) => api.updateRedressStatus(id, status, payout),
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
    return (_jsxs("div", { children: [heroLoading ? (_jsx(SkelHeroRow, { count: 4 })) : (_jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Likely eligible" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-warn", children: _jsx(CountUp, { value: totalEst, format: fmtCents }) }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: [matchCount, " catalog matches"] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Catalog size" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: _jsx(CountUp, { value: known.data?.length ?? 0, format: (n) => String(Math.round(n)) }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "Active orders we track" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Tracked" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: _jsx(CountUp, { value: tracked.data?.length ?? 0, format: (n) => String(Math.round(n)) }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "In your follow-up list" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Paid out" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-inflow", children: _jsx(CountUp, { value: paidTotal, format: fmtCents }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "Lifetime collected" })] })] })), _jsx("h3", { className: "text-sm font-semibold text-text uppercase tracking-wide mb-2", children: "Likely eligible \u2014 matched against your transactions" }), matches.isLoading ? (
            // Match-card skeleton grid mirrors the eventual layout so the
            // page doesn't shift when the matcher returns.
            _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3 mb-6", children: [_jsx(SkelStat, {}), _jsx(SkelStat, {}), _jsx(SkelStat, {}), _jsx(SkelStat, {})] })) : matchCount === 0 ? (_jsx("div", { className: "bg-card border border-border rounded-md p-6 text-center text-sm text-text-muted mb-5 max-w-xl mx-auto", children: "No catalog companies matched your last 2 years of transactions. Connect Plaid to get coverage \u2014 without transactions, the matcher has nothing to compare your spend history against. Most CFPB redress is mailed automatically when you qualify, but the action-required orders only surface here." })) : (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3 mb-6", children: matches.data.matches.map((m, i) => (_jsx(MatchCard, { m: m, onLog: () => create.mutate({
                        agency: m.catalog_entry.agency,
                        company_name: m.catalog_entry.company_name,
                        title: m.catalog_entry.title,
                        eligibility_description: m.catalog_entry.eligibility_description,
                        claim_url: m.catalog_entry.claim_url,
                        estimated_per_user_cents: m.catalog_entry.estimated_per_user_cents,
                    }) }, `${m.catalog_entry.company_name}:${i}`))) })), tracked.data && tracked.data.length > 0 && (_jsxs(_Fragment, { children: [_jsx("h3", { className: "text-sm font-semibold text-text uppercase tracking-wide mb-2 mt-4", children: "Your tracked redress" }), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3 mb-6", children: tracked.data.map((r) => (_jsx(RedressRecordRow, { r: r, onTransition: (status, payout) => transition.mutate({ id: r.id, status, payout }), onDelete: () => destroy.mutate(r.id) }, r.id))) })] })), known.data && known.data.length > 0 && (_jsxs(_Fragment, { children: [_jsxs("h3", { className: "text-sm font-semibold text-text-muted uppercase tracking-wide mb-2", children: ["Full catalog (", known.data.length, " active orders)"] }), _jsx("div", { className: "grid grid-cols-2 md:grid-cols-3 gap-2", children: known.data.map((c, i) => _jsx(CatalogCard, { c: c }, `${c.company_name}:${i}`)) })] })), _jsx("p", { className: "mt-4 text-[11px] text-text-soft", children: "Most CFPB redress is automatic \u2014 the agency mails checks. The catalog also includes orders that require user action; those are the ones surfaced as matched candidates above." })] }));
}
