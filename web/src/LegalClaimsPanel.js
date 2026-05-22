import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Class-action settlements panel — Phase F + Settlemate redesign.
 *
 * Top-half:
 *   • Hero card with personalized "You've got up to $X in pending payouts"
 *     across the user's selected state. The headline number is the sum of
 *     estimated payouts on live, available, in-state claims.
 *   • State filter chips: "All states · Nationwide (124) · CA (31) · FL (22) · ..."
 *     ranked by count desc. Defaults to "All" so the firehose is visible
 *     until Chris narrows.
 *   • Status pills: All · No proof · Needs proof · Filed · Paid · Archive.
 *
 * Bottom-half:
 *   • "Top matches, ranked" — a curated 3-card lane filtered to high-value
 *     no-proof claims that match the selected state. The Settlemate equivalent
 *     of the personalized "Your top matches" hero.
 *   • "Other claims" — the firehose of everything else, grid-laid-out.
 *
 * Card redesign:
 *   • Logo via Clearbit (free, no auth) when we can guess the company domain.
 *   • "Up to $X" / "TBD" framing instead of "$X" / "—".
 *   • Per-card "Potentially Eligible" status pill when we have payout estimate.
 *   • Proof badge inline with company name, smaller and quieter.
 *   • "File claim →" CTA prominent at the bottom.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
/* ------------------------------------------------------------------ */
/*  US state metadata                                                   */
/* ------------------------------------------------------------------ */
const STATE_NAMES = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
    CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "DC", FL: "Florida",
    GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana",
    IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine",
    MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
    MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
    NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
    NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
    OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
    SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
    VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
    WY: "Wyoming",
};
const TAB_DEFS = [
    { key: "no_proof", label: "No proof", hint: "Just name + address — coffee-break filing" },
    { key: "needs_proof", label: "Needs proof", hint: "Receipts / docs required" },
    { key: "unknown", label: "Triage", hint: "Scraper couldn't tell — read + classify in one click" },
    { key: "filed", label: "Filed", hint: "Waiting for payout" },
    { key: "paid", label: "Paid", hint: "Money received" },
    { key: "archive", label: "Archive", hint: "Dismissed + expired" },
];
function partitionByTab(claims) {
    const out = {
        no_proof: [], needs_proof: [], unknown: [], filed: [], paid: [], archive: [],
    };
    for (const c of claims) {
        if (c.status === "paid")
            out.paid.push(c);
        else if (c.status === "claimed")
            out.filed.push(c);
        else if (c.status === "dismissed" || c.is_expired)
            out.archive.push(c);
        else if (c.proof_status === "required")
            out.needs_proof.push(c);
        else if (c.proof_status === "unknown")
            out.unknown.push(c);
        else
            out.no_proof.push(c);
    }
    return out;
}
/* ------------------------------------------------------------------ */
/*  Logo guess via Clearbit                                             */
/* ------------------------------------------------------------------ */
/**
 * Best-effort guess at a company logo URL. Settlemate uses logos heavily
 * in their card design; we can't reach their data feed, but Clearbit's
 * free logo API resolves a domain to a 128px PNG. We don't know the
 * domain a priori — just guess from the company name.
 *
 * The guess is intentionally simple: take the first non-trivial word of
 * the claim name, strip non-alphanumerics, append .com. If the URL 404s,
 * the <img onError> handler hides the slot and we fall back to initials.
 */
function guessLogoUrl(claim) {
    // Look for a domain in the source URL first — usually just the
    // aggregator (topclassactions.com), but worth checking.
    // Otherwise, derive from the first word of the claim name.
    const name = claim.name || "";
    const lead = name
        .split(/[\s\-:,]+/)
        .find((w) => w.length >= 3 && /^[a-z]/i.test(w));
    if (!lead)
        return null;
    const slug = lead.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (!slug || slug.length < 3)
        return null;
    return `https://logo.clearbit.com/${slug}.com`;
}
function CompanyLogo({ claim }) {
    const url = guessLogoUrl(claim);
    const initials = (claim.name || "?")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase();
    const [failed, setFailed] = useState(false);
    if (!url || failed) {
        return (_jsx("div", { className: "w-10 h-10 rounded bg-slate-100 text-text-muted flex items-center justify-center font-bold text-xs shrink-0", children: initials || "?" }));
    }
    return (_jsx("img", { src: url, alt: claim.name, className: "w-10 h-10 rounded bg-slate-50 object-contain shrink-0", onError: () => setFailed(true) }));
}
/* ------------------------------------------------------------------ */
/*  Payout / deadline framing                                           */
/* ------------------------------------------------------------------ */
function PayoutLabel({ cents }) {
    if (cents == null || cents <= 0) {
        return _jsx("span", { className: "text-text-soft tabular-nums", children: "TBD" });
    }
    return (_jsxs("span", { className: "tabular-nums text-text", children: ["Up to ", _jsx("span", { className: "font-semibold", children: fmtCents(cents) })] }));
}
function DeadlineLabel({ claim }) {
    if (!claim.claim_deadline)
        return _jsx("span", { className: "text-text-soft", children: "No deadline" });
    const d = claim.days_until_deadline ?? 0;
    if (claim.is_expired) {
        return _jsxs("span", { className: "text-outflow font-semibold", children: ["Expired ", Math.abs(d), "d ago"] });
    }
    let cls = "text-text-muted";
    if (d <= 7)
        cls = "text-outflow font-semibold";
    else if (d <= 30)
        cls = "text-warn font-semibold";
    return _jsxs("span", { className: cls, children: [d, "d left"] });
}
/* ------------------------------------------------------------------ */
/*  Proof + eligibility badges                                          */
/* ------------------------------------------------------------------ */
function ProofBadge({ status }) {
    const cfg = {
        not_required: { label: "✓ No Proof", cls: "bg-emerald-50 text-inflow", title: "Just name + address — quick to file" },
        required: { label: "Proof Required", cls: "bg-sky-50 text-sky-700", title: "Receipts or documentation required" },
        unknown: { label: "?", cls: "bg-slate-100 text-text-muted", title: "Triage required — open the source URL to determine" },
    };
    const c = cfg[status];
    return (_jsx("span", { className: `px-2 py-0.5 rounded-full ${c.cls} text-[11px] font-semibold`, title: c.title, children: c.label }));
}
function EligibilityPill({ claim: _claim }) {
    // Settlemate shows "Potentially Eligible" with a bar-chart icon. Mirror
    // that vibe — we don't have personalized eligibility data yet, so this
    // is a soft "you might be" signal. When we wire the merchant matcher,
    // we can promote it to "Eligible" with green if their transactions match.
    return (_jsxs("span", { className: "inline-flex items-center gap-1 text-[11px] text-warn", children: [_jsxs("svg", { viewBox: "0 0 16 16", className: "w-3 h-3", fill: "currentColor", children: [_jsx("rect", { x: "2", y: "9", width: "3", height: "5" }), _jsx("rect", { x: "6.5", y: "6", width: "3", height: "8" }), _jsx("rect", { x: "11", y: "3", width: "3", height: "11" })] }), _jsx("span", { children: "Potentially Eligible" })] }));
}
function StateBadge({ state }) {
    if (state === "nationwide") {
        return _jsx("span", { className: "text-[11px] text-text-soft", children: "Nationwide" });
    }
    // Up to 3 codes shown inline; longer lists become "+N more"
    const codes = state.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const head = codes.slice(0, 3).join(" · ");
    const extra = codes.length > 3 ? ` +${codes.length - 3}` : "";
    return (_jsxs("span", { className: "text-[11px] text-text-muted font-semibold", title: codes.map((c) => STATE_NAMES[c] || c).join(", "), children: [head, extra] }));
}
/* ------------------------------------------------------------------ */
/*  Hero card                                                           */
/* ------------------------------------------------------------------ */
function Hero({ claims, state }) {
    const liveAvailable = claims.filter((c) => c.status === "available" && !c.is_expired);
    const total = liveAvailable.reduce((s, c) => s + (c.estimated_payout_cents ?? 0), 0);
    const stateLabel = state === "" ? "across every state" :
        state === "nationwide" ? "in nationwide settlements" :
            `in ${STATE_NAMES[state] || state} + nationwide settlements`;
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-5 p-5", children: [_jsxs("h2", { className: "text-2xl font-semibold text-text leading-snug", children: ["Hello Chris", " ", _jsx("span", { "aria-hidden": "true", children: "\uD83D\uDC4B" }), _jsxs("span", { className: "block mt-1 text-text-muted text-base font-normal", children: ["You've got up to", " ", _jsx("span", { className: "text-text font-semibold", children: fmtCents(total) }), " ", "in pending payouts ", stateLabel, "."] })] }), _jsxs("div", { className: "text-[11px] text-text-soft mt-2", children: ["Across ", liveAvailable.length, " live, in-window claim", liveAvailable.length === 1 ? "" : "s", "."] })] }));
}
/* ------------------------------------------------------------------ */
/*  State filter chip row                                               */
/* ------------------------------------------------------------------ */
function StateChips({ active, onPick, counts, }) {
    // Sort: All-states first, Nationwide second, then states by count desc.
    const stateEntries = Object.entries(counts)
        .filter(([k]) => k !== "nationwide")
        .sort((a, b) => b[1] - a[1]);
    const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
    return (_jsxs("div", { className: "flex items-center gap-2 overflow-x-auto whitespace-nowrap pb-2 mb-3", children: [_jsx(Chip, { active: active === "", onClick: () => onPick(""), label: "All", count: totalCount }), _jsx(Chip, { active: active === "nationwide", onClick: () => onPick("nationwide"), label: "Nationwide", count: counts["nationwide"] ?? 0 }), stateEntries.map(([code, n]) => (_jsx(Chip, { active: active === code, onClick: () => onPick(code), label: STATE_NAMES[code] || code, count: n }, code)))] }));
}
function Chip({ active, onClick, label, count, }) {
    const cls = active
        ? "bg-text text-white border-text"
        : "bg-card text-text border-border hover:border-text/40";
    return (_jsxs("button", { onClick: onClick, className: `px-3 py-1.5 rounded-full border text-xs font-semibold whitespace-nowrap ${cls}`, children: [label, " ", _jsxs("span", { className: "opacity-70 ml-1 tabular-nums", children: ["(", count, ")"] })] }));
}
/* ------------------------------------------------------------------ */
/*  Claim card                                                          */
/* ------------------------------------------------------------------ */
function ClaimCard({ claim, onUpdate, onDelete, }) {
    const [paidDraft, setPaidDraft] = useState("");
    const isAvailable = claim.status === "available" && !claim.is_expired;
    const isClaimed = claim.status === "claimed";
    const isPaid = claim.status === "paid";
    const isUnknownProof = claim.proof_status === "unknown";
    return (_jsxs("div", { className: "border border-border rounded-md p-4 bg-card hover:shadow-card-hover transition-shadow", children: [_jsxs("div", { className: "flex items-start gap-3", children: [_jsx(CompanyLogo, { claim: claim }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-start justify-between gap-2", children: [_jsx("h4", { className: "text-sm font-semibold text-text leading-snug pr-2", children: claim.name }), _jsx(ProofBadge, { status: claim.proof_status })] }), _jsx("div", { className: "text-base mt-1", children: _jsx(PayoutLabel, { cents: claim.estimated_payout_cents }) }), _jsxs("div", { className: "flex items-center justify-between gap-2 mt-2", children: [_jsx(EligibilityPill, { claim: claim }), _jsx(DeadlineLabel, { claim: claim })] }), _jsxs("div", { className: "flex items-center gap-2 mt-1", children: [_jsx(StateBadge, { state: claim.state_eligibility }), claim.source && claim.source !== "manual" && (_jsxs("span", { className: "text-[10px] text-text-soft uppercase tracking-wide", children: ["via ", claim.source.replace(/^scraper:/, "")] }))] })] })] }), isUnknownProof && isAvailable && (_jsxs("div", { className: "mt-3 px-2.5 py-2 bg-slate-50 rounded border border-border flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "text-[11px] text-text-muted", children: "Proof needed?" }), _jsx("button", { onClick: () => onUpdate({ proof_status: "not_required" }), className: "px-2 py-1 text-xs font-semibold rounded bg-emerald-50 text-inflow hover:bg-emerald-100", children: "No" }), _jsx("button", { onClick: () => onUpdate({ proof_status: "required" }), className: "px-2 py-1 text-xs font-semibold rounded bg-sky-50 text-sky-700 hover:bg-sky-100", children: "Yes" })] })), _jsxs("div", { className: "flex items-center gap-2 mt-3 flex-wrap", children: [_jsx("a", { href: claim.source_url, target: "_blank", rel: "noopener noreferrer", className: "px-3 py-1.5 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white transition-colors", children: "File claim \u2192" }), isAvailable && (_jsxs(_Fragment, { children: [_jsx("button", { onClick: () => onUpdate({ status: "claimed" }), className: "px-3 py-1.5 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy", children: "Mark filed" }), _jsx("button", { onClick: () => onUpdate({ status: "dismissed" }), className: "px-2 py-1.5 text-xs text-text-muted hover:text-outflow", children: "Skip" })] })), isClaimed && (_jsxs("form", { className: "flex items-center gap-1.5", onSubmit: (e) => {
                            e.preventDefault();
                            const v = parseFloat(paidDraft);
                            if (Number.isNaN(v) || v < 0)
                                return;
                            onUpdate({ status: "paid", actual_payout_cents: Math.round(v * 100) });
                            setPaidDraft("");
                        }, children: [_jsx("span", { className: "text-xs text-text-muted", children: "Got paid? $" }), _jsx("input", { type: "number", min: 0, step: 0.01, value: paidDraft, onChange: (e) => setPaidDraft(e.target.value), className: "w-24 px-2 py-1 text-xs border border-border rounded" }), _jsx("button", { type: "submit", disabled: !paidDraft, className: "px-2.5 py-1 text-xs font-semibold rounded bg-inflow text-white disabled:opacity-40", children: "Mark paid" })] })), isPaid && (_jsxs("span", { className: "text-xs text-inflow font-semibold", children: ["\u2713 Received ", fmtCents(claim.actual_payout_cents ?? 0)] })), _jsx("button", { onClick: () => { if (confirm(`Delete "${claim.name}"?`))
                            onDelete(); }, className: "ml-auto text-xs text-text-muted hover:text-outflow", children: "Delete" })] })] }));
}
/* ------------------------------------------------------------------ */
/*  Top-matches section                                                 */
/* ------------------------------------------------------------------ */
function topMatches(claims, limit = 3) {
    // Settlemate's "Top matches, ranked": surface the highest-value
    // no-proof claims with a deadline ≥ 7 days away. These are the
    // "best 5 minutes you could spend" picks.
    const candidates = claims.filter((c) => c.status === "available" &&
        !c.is_expired &&
        c.proof_status === "not_required" &&
        (c.estimated_payout_cents ?? 0) > 0);
    // Score = estimated_cents / max(days_to_deadline, 7). Penalizes claims
    // with no deadline (treated as 365d) so urgent + valuable beats long-tail.
    const scored = candidates.map((c) => {
        const days = c.days_until_deadline == null ? 365 : Math.max(c.days_until_deadline, 7);
        const score = (c.estimated_payout_cents ?? 0) / days;
        return { c, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.c);
}
/* ------------------------------------------------------------------ */
/*  Scrape result banner                                                */
/* ------------------------------------------------------------------ */
function ScrapeResultBanner({ result, onDismiss }) {
    const elapsed = (new Date(result.finished_at).getTime() - new Date(result.started_at).getTime()) / 1000;
    const errored = result.summaries.filter((s) => s.error);
    const ok = result.summaries.filter((s) => !s.error);
    return (_jsxs("div", { className: "mb-4 border border-border rounded-md bg-card shadow-card overflow-hidden", children: [_jsxs("div", { className: "flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-border", children: [_jsxs("div", { className: "text-sm font-semibold", children: ["Scrape finished \u2014 ", result.total_created, " new", result.total_updated > 0 && `, ${result.total_updated} updated`, _jsxs("span", { className: "text-text-soft font-normal ml-2 text-xs", children: ["(", elapsed.toFixed(1), "s)"] })] }), _jsx("button", { onClick: onDismiss, className: "text-text-muted", children: "\u00D7" })] }), _jsxs("div", { className: "px-4 py-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs", children: [ok.map((s) => (_jsxs("div", { className: "flex items-center justify-between py-1", children: [_jsx("span", { className: "font-semibold", children: s.source }), _jsxs("span", { className: "text-text-muted tabular-nums", children: [s.rows_seen, " seen \u00B7 ", s.rows_created, " new \u00B7 ", s.rows_updated, " updated \u00B7 ", s.rows_skipped, " skipped"] })] }, s.source))), errored.map((s) => (_jsxs("div", { className: "flex items-start justify-between py-1 text-outflow", children: [_jsx("span", { className: "font-semibold", children: s.source }), _jsx("span", { className: "text-right", children: s.error })] }, s.source)))] })] }));
}
/* ------------------------------------------------------------------ */
/*  Stats strip (collected $, pending $, etc.)                          */
/* ------------------------------------------------------------------ */
function StatsRow({ stats }) {
    return (_jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-5", children: [_jsx(Card, { label: "Pending potential", value: fmtCents(stats?.pending_potential_cents ?? 0), sub: "Live in-window claims", tone: "warn" }), _jsx(Card, { label: "Collected lifetime", value: fmtCents(stats?.collected_cents ?? 0), sub: `${stats?.paid_count ?? 0} paid`, tone: "in" }), _jsx(Card, { label: "Quick wins waiting", value: String(stats?.available_quick_count ?? 0), sub: "No-proof claims open" }), _jsx(Card, { label: "Needs triage", value: String(stats?.available_unknown_count ?? 0), sub: "Scraper couldn't tell", tone: stats && stats.available_unknown_count > 0 ? "warn" : undefined })] }));
}
function Card({ label, value, sub, tone }) {
    const cls = tone === "in" ? "text-inflow" : tone === "warn" ? "text-warn" : "text-text";
    return (_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: label }), _jsx("div", { className: `text-2xl font-semibold tabular-nums mt-1 ${cls}`, children: value }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: sub })] }));
}
/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */
export default function LegalClaimsPanel() {
    const qc = useQueryClient();
    const [tab, setTab] = useState("no_proof");
    // ""=All states, "nationwide", or a 2-char code. Persisted in component
    // state — could be persisted to localStorage in a follow-up.
    const [stateFilter, setStateFilter] = useState("");
    const [scrapeResult, setScrapeResult] = useState(null);
    const claims = useQuery({
        queryKey: ["legalClaims", stateFilter],
        queryFn: () => api.listLegalClaims(stateFilter ? { state: stateFilter } : {}),
    });
    const stats = useQuery({ queryKey: ["legalClaimStats"], queryFn: api.legalClaimStats });
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ["legalClaims"] });
        qc.invalidateQueries({ queryKey: ["legalClaimStats"] });
        qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
    };
    const update = useMutation({
        mutationFn: ({ id, patch }) => api.updateLegalClaim(id, patch),
        onSuccess: invalidate,
    });
    const destroy = useMutation({ mutationFn: api.deleteLegalClaim, onSuccess: invalidate });
    const scrape = useMutation({
        mutationFn: api.scrapeLegalClaims,
        onSuccess: (r) => {
            setScrapeResult(r);
            invalidate();
        },
    });
    const grouped = useMemo(() => partitionByTab(claims.data ?? []), [claims.data]);
    const topPicks = useMemo(() => topMatches(claims.data ?? []), [claims.data]);
    const counts = {
        no_proof: grouped.no_proof.length,
        needs_proof: grouped.needs_proof.length,
        unknown: grouped.unknown.length,
        filed: grouped.filed.length,
        paid: grouped.paid.length,
        archive: grouped.archive.length,
    };
    const visible = grouped[tab];
    return (_jsxs("div", { children: [_jsx(Hero, { claims: claims.data ?? [], state: stateFilter }), _jsx(StatsRow, { stats: stats.data }), scrapeResult && _jsx(ScrapeResultBanner, { result: scrapeResult, onDismiss: () => setScrapeResult(null) }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-4 mb-5", children: [_jsxs("div", { className: "flex items-center justify-between mb-2", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Filter by state" }), _jsx("button", { onClick: () => scrape.mutate(), disabled: scrape.isPending, className: "px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-brand hover:text-brand disabled:opacity-50", children: scrape.isPending ? "Scraping…" : "Scrape now" })] }), _jsx(StateChips, { active: stateFilter, onPick: setStateFilter, counts: stats.data?.counts_by_state ?? {} })] }), topPicks.length > 0 && (_jsxs("div", { className: "mb-6", children: [_jsxs("div", { className: "flex items-center gap-2 mb-3", children: [_jsx("h3", { className: "text-base font-semibold text-text", children: "Your top matches, ranked" }), _jsx("span", { className: "text-xs text-text-muted", children: "\u2014 highest $/day no-proof claims open right now" })] }), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-3", children: topPicks.map((c) => (_jsx(ClaimCard, { claim: c, onUpdate: (patch) => update.mutate({ id: c.id, patch }), onDelete: () => destroy.mutate(c.id) }, c.id))) })] })), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card", children: [_jsx("div", { className: "flex items-stretch border-b border-border overflow-x-auto", children: TAB_DEFS.map((t) => (_jsxs("button", { onClick: () => setTab(t.key), title: t.hint, className: `px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap transition-colors ${tab === t.key
                                ? "text-brand border-b-2 border-brand -mb-px"
                                : "text-text-muted border-b-2 border-transparent hover:text-text"}`, children: [t.label, _jsx("span", { className: `ml-1.5 inline-block px-1.5 py-0.5 rounded-full text-[10px] tabular-nums ${tab === t.key ? "bg-brand text-white" : "bg-hover text-text-muted"}`, children: counts[t.key] })] }, t.key))) }), _jsxs("div", { className: "p-4", children: [claims.isLoading && _jsx("div", { className: "text-center py-8 text-sm text-text-muted", children: "Loading\u2026" }), claims.data && visible.length === 0 && (_jsx("div", { className: "text-center py-8 text-sm text-text-muted", children: emptyMessage(tab, stateFilter) })), visible.length > 0 && (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: visible.map((c) => (_jsx(ClaimCard, { claim: c, onUpdate: (patch) => update.mutate({ id: c.id, patch }), onDelete: () => destroy.mutate(c.id) }, c.id))) }))] })] }), _jsx("p", { className: "mt-3 text-[11px] text-text-soft", children: "Scraper runs weekly (Sunday) \u2014 hit \"Scrape now\" any time to pull the latest from TopClassActions + ClassAction.org + ClassActionRebates. State chips reflect live, in-window claims; \"Nationwide\" plus your state always include each other in filter results." })] }));
}
function emptyMessage(tab, state) {
    const stateLabel = !state ? "" : state === "nationwide" ? " (nationwide-only)" : ` in ${STATE_NAMES[state] || state}`;
    switch (tab) {
        case "no_proof":
            return `No quick (no-proof) claims open${stateLabel}. Try a different state, hit "Scrape now", or check the Triage tab.`;
        case "needs_proof":
            return `No proof-required claims open${stateLabel} right now.`;
        case "unknown":
            return "No claims awaiting triage. Newly scraped rows whose proof requirement is unclear land here.";
        case "filed":
            return "Nothing waiting for payout. Mark an available claim as filed once you submit it.";
        case "paid":
            return "No paid settlements yet.";
        case "archive":
            return "Nothing archived yet — dismissed and expired claims land here.";
    }
}
