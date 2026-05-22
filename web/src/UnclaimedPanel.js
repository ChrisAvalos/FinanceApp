import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Unclaimed-property tracker — Phase 8.1.
 *
 * Most adults have $80–200 sitting in NAUPA / state databases. The
 * panel surfaces three things:
 *
 *   1. Stats roll-up (pending $, found count, lifetime collected).
 *   2. Search-tips checklist — a structured guide for the user to
 *      run the searches themselves on MissingMoney.com + state
 *      portals (we can't auto-search because each state portal has
 *      its own form, captcha, and ToS). Open the federal + per-state
 *      links, run the name + address variants, log matches as rows.
 *   3. Status-tab partition (Found / Filed / Paid / Archive) —
 *      same UX shape as LegalClaimsPanel so the cohort flow is
 *      consistent across "money on the table" surfaces.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelLine } from "./components/Skeleton";
const TAB_DEFS = [
    { key: "found", label: "Found", hint: "Logged matches you haven't filed yet" },
    { key: "claimed", label: "Filed", hint: "Claim filed; waiting for payout" },
    { key: "paid", label: "Paid", hint: "Money received" },
    { key: "archive", label: "Archive", hint: "Rejected + dismissed" },
];
/** Stale claim threshold (days). Records sitting in "claimed" longer
 *  than this surface a follow-up nudge — most state portals process
 *  in 30-90 days, so anything past 30d is at least worth a status check. */
const STALE_CLAIM_DAYS = 30;
const SORT_DEFS = [
    { key: "value_desc", label: "Highest value" },
    { key: "recent", label: "Most recent" },
    { key: "filed_recent", label: "Filed most recently" },
    { key: "state", label: "By state" },
];
/** Days since an ISO timestamp, floored. Returns null if unparseable. */
function daysSince(iso) {
    if (!iso)
        return null;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t))
        return null;
    return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
function partition(rows) {
    const out = {
        found: [], claimed: [], paid: [], archive: [],
    };
    for (const r of rows) {
        if (r.status === "paid")
            out.paid.push(r);
        else if (r.status === "claimed")
            out.claimed.push(r);
        else if (r.status === "found")
            out.found.push(r);
        else
            out.archive.push(r);
    }
    return out;
}
function StatsRow() {
    const stats = useQuery({ queryKey: ["unclaimedStats"], queryFn: api.unclaimedStats });
    // Skeleton on first load — avoids the layout shift when numbers
    // pop in. After data lands, CountUp animates each refetch.
    if (stats.isLoading)
        return _jsx(SkelHeroRow, { count: 4 });
    const s = stats.data;
    return (_jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-5", children: [_jsx(StatCard, { label: "Pending", numericValue: s?.estimated_pending_cents ?? 0, format: fmtCents, sub: `${s?.found_count ?? 0} found · ${s?.claimed_count ?? 0} filed`, tone: "warn" }), _jsx(StatCard, { label: "Collected", numericValue: s?.actual_collected_cents ?? 0, format: fmtCents, sub: `${s?.paid_count ?? 0} paid out`, tone: "in" }), _jsx(StatCard, { label: "Total tracked", numericValue: s?.total_count ?? 0, format: (n) => String(Math.round(n)), sub: "Across all states" }), _jsx(StatCard, { label: "Archived", numericValue: (s?.rejected_count ?? 0) + (s?.dismissed_count ?? 0), format: (n) => String(Math.round(n)), sub: "Rejected + dismissed" })] }));
}
function StatCard({ label, numericValue, format, sub, tone, }) {
    const cls = tone === "in" ? "text-inflow" : tone === "warn" ? "text-warn" : "text-text";
    return (_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: label }), _jsx("div", { className: `text-2xl font-semibold tabular-nums mt-1 ${cls}`, children: _jsx(CountUp, { value: numericValue, format: format }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: sub })] }));
}
function SearchTipsBox() {
    const [open, setOpen] = useState(false);
    const tips = useQuery({
        queryKey: ["unclaimedSearchTips"],
        queryFn: api.unclaimedSearchTips,
        enabled: open,
    });
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-5 overflow-hidden", children: [_jsxs("button", { onClick: () => setOpen((o) => !o), className: "w-full flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-border hover:bg-hover", children: [_jsx("span", { className: "text-sm font-semibold text-text", children: "Search guide (federal + state portals)" }), _jsx("span", { className: "text-text-muted text-xs", children: open ? "Hide" : "Show" })] }), open && tips.data && (_jsxs("div", { className: "p-4 space-y-4 text-sm", children: [_jsx("p", { className: "text-text-muted leading-relaxed", children: tips.data.intro }), _jsxs("div", { children: [_jsx("h4", { className: "font-semibold text-text mb-2", children: "Federal resources" }), _jsx("ul", { className: "space-y-1.5", children: tips.data.federal_resources.map((r) => (_jsxs("li", { children: [_jsx("a", { href: r.url, target: "_blank", rel: "noopener noreferrer", className: "text-brand hover:underline font-semibold", children: r.name }), _jsxs("span", { className: "text-text-muted ml-2 text-xs", children: ["\u2014 ", r.what] })] }, r.url))) })] }), _jsxs("div", { children: [_jsx("h4", { className: "font-semibold text-text mb-2", children: "State portals" }), _jsx("div", { className: "grid grid-cols-2 md:grid-cols-3 gap-2 text-xs", children: tips.data.state_resources.map((r) => (_jsxs("a", { href: r.url, target: "_blank", rel: "noopener noreferrer", className: "text-brand hover:underline", children: [_jsx("strong", { children: r.state }), " \u00B7 ", r.name] }, r.state))) })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsx("h4", { className: "font-semibold text-text mb-2", children: "Name variants" }), _jsx("ul", { className: "text-xs text-text-muted space-y-0.5 list-disc pl-4", children: tips.data.name_variants_to_try.map((n) => _jsx("li", { children: n }, n)) })] }), _jsxs("div", { children: [_jsx("h4", { className: "font-semibold text-text mb-2", children: "Addresses to try" }), _jsx("ul", { className: "text-xs text-text-muted space-y-0.5 list-disc pl-4", children: tips.data.addresses_to_try.map((a) => _jsx("li", { children: a }, a)) })] })] })] }))] }));
}
function AddRecordForm({ onAdd }) {
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState({
        state: "",
        holder_name: "",
        owner_name: "",
        property_type: "",
        estimated_value_dollars: "",
        claim_url: "",
        notes: "",
    });
    if (!open) {
        return (_jsx("button", { onClick: () => setOpen(true), className: "px-4 py-2 text-sm font-semibold rounded bg-brand text-white hover:bg-brand-navy", children: "+ Log a match" }));
    }
    return (_jsxs("form", { className: "border border-border rounded-md bg-card p-4 space-y-3 mb-4", onSubmit: (e) => {
            e.preventDefault();
            if (!form.state || !form.owner_name)
                return;
            const cents = form.estimated_value_dollars
                ? Math.round(parseFloat(form.estimated_value_dollars) * 100)
                : null;
            onAdd({
                state: form.state.trim().toUpperCase().slice(0, 8),
                holder_name: form.holder_name.trim() || null,
                owner_name: form.owner_name.trim(),
                property_type: form.property_type.trim() || null,
                estimated_value_cents: cents,
                claim_url: form.claim_url.trim() || null,
                notes: form.notes.trim() || null,
            });
            setForm({ state: "", holder_name: "", owner_name: "", property_type: "", estimated_value_dollars: "", claim_url: "", notes: "" });
            setOpen(false);
        }, children: [_jsxs("div", { className: "flex items-center justify-between", children: [_jsx("h4", { className: "text-sm font-semibold", children: "New match found via search" }), _jsx("button", { type: "button", onClick: () => setOpen(false), className: "text-text-muted", children: "\u00D7" })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3 text-xs", children: [_jsx(Input, { label: "State *", value: form.state, onChange: (v) => setForm({ ...form, state: v }), placeholder: "CA / TX / NY" }), _jsx(Input, { label: "Owner name *", value: form.owner_name, onChange: (v) => setForm({ ...form, owner_name: v }), placeholder: "Your full legal name as it appears" }), _jsx(Input, { label: "Holder", value: form.holder_name, onChange: (v) => setForm({ ...form, holder_name: v }), placeholder: "Reporting business" }), _jsx(Input, { label: "Property type", value: form.property_type, onChange: (v) => setForm({ ...form, property_type: v }), placeholder: "Uncashed check, deposit refund, etc." }), _jsx(Input, { label: "Estimated value ($)", value: form.estimated_value_dollars, onChange: (v) => setForm({ ...form, estimated_value_dollars: v }), placeholder: "If portal shows it", type: "number" }), _jsx(Input, { label: "Claim URL", value: form.claim_url, onChange: (v) => setForm({ ...form, claim_url: v }), placeholder: "https://..." })] }), _jsx(Input, { label: "Notes", value: form.notes, onChange: (v) => setForm({ ...form, notes: v }) }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("button", { type: "submit", className: "px-3 py-1.5 text-sm font-semibold rounded bg-brand text-white hover:bg-brand-navy", children: "Save" }), _jsx("button", { type: "button", onClick: () => setOpen(false), className: "px-3 py-1.5 text-sm text-text-muted", children: "Cancel" })] })] }));
}
function Input({ label, value, onChange, placeholder, type = "text", }) {
    return (_jsxs("label", { className: "text-xs text-text-muted", children: [_jsx("span", { className: "block mb-1 font-semibold uppercase tracking-wide text-[10px]", children: label }), _jsx("input", { type: type, value: value, onChange: (e) => onChange(e.target.value), placeholder: placeholder, className: "w-full px-2 py-1.5 text-sm border border-border rounded focus:outline-none focus:border-brand" })] }));
}
function RecordCard({ r, onTransition, onDelete, }) {
    const [paidDraft, setPaidDraft] = useState("");
    // Stale-claim detection — surfaces a warning chip on records that
    // have been "claimed" longer than STALE_CLAIM_DAYS without payment.
    // Most state portals process within 30-90 days, so anything past
    // 30 days is at least worth a status check on the portal.
    const filedDays = r.status === "claimed" ? daysSince(r.claimed_at) : null;
    const isStale = filedDays !== null && filedDays >= STALE_CLAIM_DAYS;
    return (_jsxs("div", { className: "border border-border rounded-md p-4 bg-card hover:shadow-card-hover transition-shadow", children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("span", { className: "px-1.5 py-0.5 rounded-sm bg-emerald-50 text-inflow text-[10px] font-semibold uppercase tracking-wide", children: r.state }), _jsx("h4", { className: "text-sm font-semibold text-text", children: r.owner_name }), r.holder_name && (_jsxs("span", { className: "text-xs text-text-muted", children: ["via ", r.holder_name] })), isStale && (_jsxs("span", { className: "px-1.5 py-0.5 rounded-sm bg-amber-100 text-amber-800 text-[10px] font-semibold uppercase tracking-wide", title: `Filed ${filedDays}d ago — most portals process within 30-90 days`, children: ["\u23F3 Filed ", filedDays, "d ago"] }))] }), r.property_type && (_jsx("p", { className: "text-xs text-text-muted mt-1", children: r.property_type })), r.notes && (_jsx("p", { className: "text-[11px] text-text-soft mt-1 italic line-clamp-2", children: r.notes }))] }), _jsxs("div", { className: "text-right shrink-0", children: [_jsx("div", { className: "text-base font-semibold tabular-nums text-text", children: r.estimated_value_cents ? fmtCents(r.estimated_value_cents) : "—" }), _jsxs("div", { className: "text-[11px] text-text-soft", children: ["Found ", new Date(r.discovered_at).toLocaleDateString()] })] })] }), _jsxs("div", { className: "flex items-center gap-2 mt-3 flex-wrap", children: [r.claim_url && (_jsx("a", { href: r.claim_url, target: "_blank", rel: "noopener noreferrer", className: "px-3 py-1.5 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white", children: "File claim \u2192" })), r.status === "found" && (_jsxs(_Fragment, { children: [_jsx("button", { onClick: () => onTransition("claimed"), className: "px-3 py-1.5 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy", children: "Mark filed" }), _jsx("button", { onClick: () => onTransition("dismissed"), className: "px-2 py-1.5 text-xs text-text-muted hover:text-outflow", children: "Dismiss" })] })), r.status === "claimed" && (_jsxs("form", { className: "flex items-center gap-1.5", onSubmit: (e) => {
                            e.preventDefault();
                            const v = parseFloat(paidDraft);
                            if (Number.isNaN(v) || v < 0)
                                return;
                            onTransition("paid", Math.round(v * 100));
                            setPaidDraft("");
                        }, children: [_jsx("span", { className: "text-xs text-text-muted", children: "Paid? $" }), _jsx("input", { type: "number", min: 0, step: 0.01, value: paidDraft, onChange: (e) => setPaidDraft(e.target.value), className: "w-24 px-2 py-1 text-xs border border-border rounded" }), _jsx("button", { type: "submit", disabled: !paidDraft, className: "px-2.5 py-1 text-xs font-semibold rounded bg-inflow text-white disabled:opacity-40", children: "Mark paid" })] })), r.status === "paid" && (_jsxs("span", { className: "text-xs text-inflow font-semibold", children: ["\u2713 Received ", fmtCents(r.actual_payout_cents ?? 0)] })), _jsx("span", { className: "ml-auto", children: _jsx("button", { onClick: () => { if (confirm("Delete?"))
                                onDelete(); }, className: "text-xs text-text-muted hover:text-outflow", children: "Delete" }) })] })] }));
}
/** Tab-specific empty-state copy. Each tab has a different prompt
 *  because "no rejected claims" reads differently than "no matches yet". */
const EMPTY_COPY = {
    found: "No matches logged yet. Open the search guide above and run MissingMoney.com + your state portals — most adults have $80-200 sitting in unclaimed databases.",
    claimed: "No active claims. After you log a match and file with the state, mark it filed and we'll track follow-up timing.",
    paid: "No payments received yet. Claims that pay out land here with the actual amount received.",
    archive: "Nothing archived. Rejected claims and dismissed matches collect here as a paper trail.",
};
/** Comparator for the chosen sort key. Returned function is stable for
 *  ties so identical rows preserve their list order. */
function makeSortFn(key) {
    switch (key) {
        case "value_desc":
            return (a, b) => (b.estimated_value_cents ?? 0) - (a.estimated_value_cents ?? 0);
        case "recent":
            return (a, b) => new Date(b.discovered_at).getTime() -
                new Date(a.discovered_at).getTime();
        case "filed_recent":
            return (a, b) => new Date(b.claimed_at ?? 0).getTime() -
                new Date(a.claimed_at ?? 0).getTime();
        case "state":
            return (a, b) => a.state.localeCompare(b.state);
    }
}
/** Skeleton grid for the records list — same shape as RecordCard. */
function RecordSkeletonGrid() {
    return (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: Array.from({ length: 4 }).map((_, i) => (_jsxs("div", { className: "border border-border rounded-md p-4 bg-card space-y-3", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx(SkelLine, { width: "40px", height: "h-4" }), _jsx(SkelLine, { width: "55%", height: "h-3" })] }), _jsx(SkelLine, { width: "70%", height: "h-2" }), _jsxs("div", { className: "flex items-center justify-between", children: [_jsx(SkelLine, { width: "80px", height: "h-2" }), _jsx(SkelLine, { width: "60px", height: "h-3" })] })] }, i))) }));
}
export default function UnclaimedPanel() {
    const qc = useQueryClient();
    const [tab, setTab] = useState("found");
    const [stateFilter, setStateFilter] = useState("all");
    const [sortKey, setSortKey] = useState("value_desc");
    const records = useQuery({ queryKey: ["unclaimed"], queryFn: () => api.listUnclaimed() });
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ["unclaimed"] });
        qc.invalidateQueries({ queryKey: ["unclaimedStats"] });
        qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
    };
    const create = useMutation({ mutationFn: api.createUnclaimed, onSuccess: invalidate });
    const transition = useMutation({
        mutationFn: ({ id, status, payout }) => api.updateUnclaimedStatus(id, status, payout),
        onSuccess: invalidate,
    });
    const destroy = useMutation({ mutationFn: api.deleteUnclaimed, onSuccess: invalidate });
    const grouped = useMemo(() => partition(records.data ?? []), [records.data]);
    /** Distinct states present across ALL records — used for the state
     *  filter chip row. We hide the chip row entirely when there's only
     *  one state since the filter would be redundant. */
    const distinctStates = useMemo(() => {
        const set = new Set();
        for (const r of records.data ?? [])
            set.add(r.state);
        return Array.from(set).sort();
    }, [records.data]);
    /** Stale-claim count across the "claimed" bucket — surfaces in the
     *  Filed tab badge so the user knows there's something to act on. */
    const staleClaimCount = useMemo(() => {
        return grouped.claimed.filter((r) => {
            const d = daysSince(r.claimed_at);
            return d !== null && d >= STALE_CLAIM_DAYS;
        }).length;
    }, [grouped.claimed]);
    /** Apply state filter + sort to the active tab's slice. */
    const visible = useMemo(() => {
        const slice = grouped[tab];
        const filtered = stateFilter === "all" ? slice : slice.filter((r) => r.state === stateFilter);
        return [...filtered].sort(makeSortFn(sortKey));
    }, [grouped, tab, stateFilter, sortKey]);
    const counts = {
        found: grouped.found.length, claimed: grouped.claimed.length,
        paid: grouped.paid.length, archive: grouped.archive.length,
    };
    return (_jsxs("div", { children: [_jsx(StatsRow, {}), _jsx(SearchTipsBox, {}), _jsx(AddRecordForm, { onAdd: (p) => create.mutate(p) }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card", children: [_jsx("div", { className: "flex items-stretch border-b border-border overflow-x-auto", children: TAB_DEFS.map((t) => (_jsxs("button", { onClick: () => setTab(t.key), title: t.hint, className: `px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap ${tab === t.key ? "text-brand border-b-2 border-brand -mb-px" : "text-text-muted border-b-2 border-transparent hover:text-text"}`, children: [t.label, _jsx("span", { className: `ml-1.5 inline-block px-1.5 py-0.5 rounded-full text-[10px] tabular-nums ${tab === t.key ? "bg-brand text-white" : "bg-hover text-text-muted"}`, children: counts[t.key] }), t.key === "claimed" && staleClaimCount > 0 && (_jsxs("span", { className: "ml-1 inline-block px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800", title: `${staleClaimCount} claim${staleClaimCount === 1 ? "" : "s"} filed > ${STALE_CLAIM_DAYS}d ago`, children: ["\u23F3 ", staleClaimCount] }))] }, t.key))) }), (distinctStates.length >= 2 || (records.data?.length ?? 0) > 1) && (_jsxs("div", { className: "flex items-center gap-2 flex-wrap px-4 py-2 border-b border-border bg-slate-50/40", children: [distinctStates.length >= 2 && (_jsxs(_Fragment, { children: [_jsx("span", { className: "text-[10px] uppercase font-semibold tracking-wide text-text-soft", children: "State" }), _jsx("button", { onClick: () => setStateFilter("all"), className: `px-2 py-0.5 text-xs rounded-full border transition-colors ${stateFilter === "all"
                                            ? "border-brand text-brand bg-brand/5 font-semibold"
                                            : "border-border text-text-muted hover:border-text-muted"}`, children: "All" }), distinctStates.map((s) => (_jsx("button", { onClick: () => setStateFilter(s), className: `px-2 py-0.5 text-xs rounded-full border font-mono uppercase transition-colors ${stateFilter === s
                                            ? "border-brand text-brand bg-brand/5 font-semibold"
                                            : "border-border text-text-muted hover:border-text-muted"}`, children: s }, s)))] })), _jsx("span", { className: "ml-auto text-[10px] uppercase font-semibold tracking-wide text-text-soft", children: "Sort" }), _jsx("select", { value: sortKey, onChange: (e) => setSortKey(e.target.value), className: "text-xs px-2 py-1 border border-border rounded bg-card text-text focus:outline-none focus:border-brand", children: SORT_DEFS.map((s) => (_jsx("option", { value: s.key, children: s.label }, s.key))) })] })), _jsxs("div", { className: "p-4", children: [records.isLoading && _jsx(RecordSkeletonGrid, {}), !records.isLoading && records.data && visible.length === 0 && (_jsx("div", { className: "text-center py-8 text-sm text-text-muted max-w-md mx-auto", children: stateFilter !== "all" && grouped[tab].length > 0
                                    ? `No ${tab} records in ${stateFilter}. Switch to "All" or pick a different state.`
                                    : EMPTY_COPY[tab] })), visible.length > 0 && (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: visible.map((r) => (_jsx(RecordCard, { r: r, onTransition: (status, payout) => transition.mutate({ id: r.id, status, payout }), onDelete: () => destroy.mutate(r.id) }, r.id))) }))] })] })] }));
}
