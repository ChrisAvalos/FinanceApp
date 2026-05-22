import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Card-application + welcome-bonus tracker — Phase 8.2.
 *
 * Tracks new card apps through their lifecycle: planning → applied →
 * approved → spending (toward minimum-spend) → bonus_earned → bonus_posted.
 * Computes Chase 5/24 status and Amex once-per-lifetime eligibility for
 * the eligibility-check card at the top.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents } from "./api/client";
import { SkelLine, SkelStat } from "./components/Skeleton";
function StatusBadge({ s }) {
    const map = {
        planning: { label: "Planning", cls: "bg-slate-100 text-text-muted" },
        applied: { label: "Applied", cls: "bg-amber-50 text-warn" },
        approved: { label: "Approved", cls: "bg-emerald-50 text-inflow" },
        denied: { label: "Denied", cls: "bg-rose-50 text-outflow" },
        spending: { label: "Spending", cls: "bg-sky-50 text-sky-700" },
        bonus_earned: { label: "Bonus earned", cls: "bg-emerald-100 text-inflow" },
        bonus_posted: { label: "Bonus posted", cls: "bg-emerald-200 text-inflow" },
        closed: { label: "Closed", cls: "bg-slate-100 text-text-soft" },
        cancelled: { label: "Cancelled", cls: "bg-slate-100 text-text-soft" },
    };
    const m = map[s];
    return _jsx("span", { className: `px-1.5 py-0.5 rounded-sm ${m.cls} text-[10px] font-semibold uppercase tracking-wide`, children: m.label });
}
function Eligibility() {
    const e = useQuery({ queryKey: ["cardEligibility"], queryFn: api.cardApplicationsEligibility });
    if (e.isLoading) {
        // Match the rendered eligibility card's shape so the page doesn't
        // shift when the 5/24 calculation finishes.
        return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-5 p-4 space-y-3", children: [_jsx(SkelLine, { width: "35%", height: "h-3" }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { className: "space-y-2", children: [_jsx(SkelLine, { width: "40%", height: "h-3" }), _jsx(SkelLine, { width: "60%", height: "h-2" }), _jsx(SkelLine, { width: "50%", height: "h-2" })] }), _jsxs("div", { className: "space-y-2", children: [_jsx(SkelLine, { width: "50%", height: "h-3" }), _jsx(SkelLine, { width: "80%", height: "h-2" }), _jsx(SkelLine, { width: "65%", height: "h-2" })] })] })] }));
    }
    if (!e.data)
        return null;
    const c = e.data.chase_5_24;
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-5 p-4", children: [_jsx("h3", { className: "text-sm font-semibold text-text mb-3", children: "Eligibility" }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("h4", { className: "text-sm font-semibold", children: "Chase 5/24" }), _jsx("span", { className: `px-1.5 py-0.5 rounded-sm text-[10px] font-semibold uppercase tracking-wide ${c.is_under_5_24 ? "bg-emerald-50 text-inflow" : "bg-rose-50 text-outflow"}`, children: c.is_under_5_24 ? "Eligible" : "Over 5/24" })] }), _jsxs("p", { className: "text-xs text-text-muted mt-1", children: [c.cards_opened_in_window, "/5 cards in trailing 24mo \u00B7 window ", c.window_start, " \u2192 ", c.window_end] }), c.notes && _jsx("p", { className: "text-[11px] text-text-soft italic mt-1", children: c.notes })] }), _jsxs("div", { children: [_jsx("h4", { className: "text-sm font-semibold", children: "Amex once-per-lifetime" }), e.data.amex_lifetime.length === 0 ? (_jsx("p", { className: "text-xs text-text-muted mt-1", children: "No Amex history tracked." })) : (_jsx("ul", { className: "text-xs space-y-1 mt-1", children: e.data.amex_lifetime.map((a) => (_jsxs("li", { className: "flex justify-between", children: [_jsx("span", { children: a.card_name }), _jsx("span", { className: a.bonus_already_earned ? "text-warn font-semibold" : "text-inflow font-semibold", children: a.bonus_already_earned ? "Already earned" : "Eligible" })] }, a.card_name))) }))] })] })] }));
}
function ProgressBar({ cur, max }) {
    if (!max || max === 0)
        return null;
    const pct = Math.min(100, (cur / max) * 100);
    return (_jsx("div", { className: "w-full h-2 bg-hover rounded mt-2 overflow-hidden", children: _jsx("div", { className: `h-full ${pct >= 100 ? "bg-inflow" : "bg-brand"}`, style: { width: `${pct}%` } }) }));
}
function ApplicationCard({ a, onTransition, onLogSpend, onDelete }) {
    const [spendDraft, setSpendDraft] = useState("");
    const minSpend = a.minimum_spend_cents ?? 0;
    const daysLeft = a.minimum_spend_deadline
        ? Math.ceil((new Date(a.minimum_spend_deadline).getTime() - Date.now()) / (24 * 3600 * 1000))
        : null;
    return (_jsxs("div", { className: "border border-border rounded-md p-4 bg-card hover:shadow-card-hover", children: [_jsxs("div", { className: "flex items-start justify-between gap-3 mb-2", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx(StatusBadge, { s: a.status }), _jsx("h4", { className: "text-sm font-semibold text-text", children: a.card_name }), _jsx("span", { className: "text-xs text-text-muted", children: a.issuer })] }), a.bonus_value_cents && (_jsxs("div", { className: "text-xs text-text-muted mt-1", children: ["Welcome bonus: ", _jsx("span", { className: "text-inflow font-semibold", children: fmtCents(a.bonus_value_cents) }), a.bonus_points && ` (${a.bonus_points.toLocaleString()} pts)`] }))] }), _jsx("div", { className: "text-right", children: a.annual_fee_cents != null && (_jsxs("div", { className: "text-xs text-text-muted", children: ["AF ", fmtCents(-a.annual_fee_cents), a.first_year_fee_waived && " (Y1 waived)"] })) })] }), minSpend > 0 && (_jsxs("div", { className: "text-xs", children: [_jsxs("div", { className: "flex justify-between", children: [_jsx("span", { className: "text-text-muted", children: "Min spend progress" }), _jsxs("span", { className: "tabular-nums", children: [fmtCents(a.spend_to_date_cents), " / ", fmtCents(minSpend)] })] }), _jsx(ProgressBar, { cur: a.spend_to_date_cents, max: minSpend }), daysLeft != null && (_jsx("div", { className: `mt-1 ${daysLeft <= 14 ? "text-outflow font-semibold" : "text-text-muted"}`, children: daysLeft > 0 ? `${daysLeft} days until deadline` : `Deadline passed ${-daysLeft}d ago` }))] })), _jsxs("div", { className: "flex items-center gap-2 mt-3 flex-wrap", children: [a.status === "spending" && (_jsxs("form", { className: "flex items-center gap-1.5", onSubmit: (e) => {
                            e.preventDefault();
                            const v = parseFloat(spendDraft);
                            if (Number.isNaN(v) || v <= 0)
                                return;
                            onLogSpend(Math.round(v * 100));
                            setSpendDraft("");
                        }, children: [_jsx("span", { className: "text-xs text-text-muted", children: "+ $" }), _jsx("input", { type: "number", min: 0, step: 0.01, value: spendDraft, onChange: (e) => setSpendDraft(e.target.value), className: "w-20 px-2 py-1 text-xs border border-border rounded" }), _jsx("button", { type: "submit", disabled: !spendDraft, className: "px-2 py-1 text-xs font-semibold rounded bg-brand text-white disabled:opacity-40", children: "Log" })] })), a.status === "applied" && _jsx("button", { onClick: () => onTransition("approved"), className: "px-2 py-1 text-xs font-semibold rounded bg-brand text-white", children: "Mark approved" }), a.status === "approved" && _jsx("button", { onClick: () => onTransition("spending"), className: "px-2 py-1 text-xs font-semibold rounded bg-brand text-white", children: "Start spending" }), a.status === "spending" && a.spend_to_date_cents >= (a.minimum_spend_cents ?? 0) && (_jsx("button", { onClick: () => onTransition("bonus_earned"), className: "px-2 py-1 text-xs font-semibold rounded bg-inflow text-white", children: "Mark bonus earned" })), a.status === "bonus_earned" && _jsx("button", { onClick: () => onTransition("bonus_posted"), className: "px-2 py-1 text-xs font-semibold rounded bg-inflow text-white", children: "Mark bonus posted" }), _jsx("button", { onClick: () => { if (confirm("Delete?"))
                            onDelete(); }, className: "ml-auto text-xs text-text-muted hover:text-outflow", children: "Delete" })] })] }));
}
function NewApplicationForm({ onAdd }) {
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState({
        issuer: "",
        card_name: "",
        bonus_value_dollars: "",
        minimum_spend_dollars: "",
        minimum_spend_window_days: "90",
        annual_fee_dollars: "",
        counts_toward_5_24: true,
    });
    if (!open) {
        return _jsx("button", { onClick: () => setOpen(true), className: "px-4 py-2 text-sm font-semibold rounded bg-brand text-white hover:bg-brand-navy", children: "+ Plan a new app" });
    }
    return (_jsxs("form", { className: "border border-border rounded-md bg-card p-4 space-y-3 mb-4", onSubmit: (e) => {
            e.preventDefault();
            if (!form.issuer.trim() || !form.card_name.trim())
                return;
            onAdd({
                issuer: form.issuer.trim(),
                card_name: form.card_name.trim(),
                bonus_value_cents: form.bonus_value_dollars ? Math.round(parseFloat(form.bonus_value_dollars) * 100) : null,
                minimum_spend_cents: form.minimum_spend_dollars ? Math.round(parseFloat(form.minimum_spend_dollars) * 100) : null,
                minimum_spend_window_days: form.minimum_spend_window_days ? Number(form.minimum_spend_window_days) : null,
                annual_fee_cents: form.annual_fee_dollars ? Math.round(parseFloat(form.annual_fee_dollars) * 100) : null,
                counts_toward_5_24: form.counts_toward_5_24,
            });
            setForm({ issuer: "", card_name: "", bonus_value_dollars: "", minimum_spend_dollars: "", minimum_spend_window_days: "90", annual_fee_dollars: "", counts_toward_5_24: true });
            setOpen(false);
        }, children: [_jsxs("div", { className: "flex justify-between", children: [_jsx("h4", { className: "text-sm font-semibold", children: "Plan new card application" }), _jsx("button", { type: "button", onClick: () => setOpen(false), children: "\u00D7" })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3 text-xs", children: [_jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Issuer *" }), _jsx("input", { value: form.issuer, onChange: (e) => setForm({ ...form, issuer: e.target.value }), placeholder: "Chase, Amex, Capital One", className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Card name *" }), _jsx("input", { value: form.card_name, onChange: (e) => setForm({ ...form, card_name: e.target.value }), placeholder: "Sapphire Preferred", className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Bonus value ($)" }), _jsx("input", { type: "number", value: form.bonus_value_dollars, onChange: (e) => setForm({ ...form, bonus_value_dollars: e.target.value }), className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Min spend ($)" }), _jsx("input", { type: "number", value: form.minimum_spend_dollars, onChange: (e) => setForm({ ...form, minimum_spend_dollars: e.target.value }), className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Window (days)" }), _jsx("input", { type: "number", value: form.minimum_spend_window_days, onChange: (e) => setForm({ ...form, minimum_spend_window_days: e.target.value }), className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Annual fee ($)" }), _jsx("input", { type: "number", value: form.annual_fee_dollars, onChange: (e) => setForm({ ...form, annual_fee_dollars: e.target.value }), className: "w-full px-2 py-1.5 border border-border rounded" })] })] }), _jsxs("label", { className: "flex items-center gap-2 text-xs", children: [_jsx("input", { type: "checkbox", checked: form.counts_toward_5_24, onChange: (e) => setForm({ ...form, counts_toward_5_24: e.target.checked }) }), _jsx("span", { children: "Counts toward Chase 5/24" })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { type: "submit", className: "px-3 py-1.5 text-sm font-semibold rounded bg-brand text-white", children: "Save" }), _jsx("button", { type: "button", onClick: () => setOpen(false), className: "px-3 py-1.5 text-sm text-text-muted", children: "Cancel" })] })] }));
}
function BestBonusesShelf({ onAdd, }) {
    const bonuses = useQuery({
        queryKey: ["cardApplicationBestBonuses"],
        queryFn: () => api.cardApplicationBestBonuses(),
        staleTime: 60_000,
    });
    if (bonuses.isLoading || !bonuses.data || bonuses.data.length === 0)
        return null;
    const top = bonuses.data.slice(0, 6);
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-4 mb-5", children: [_jsxs("div", { className: "flex items-baseline justify-between mb-3", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Top welcome bonuses right now" }), _jsx("span", { className: "text-[11px] text-text-soft", children: "Ranked by $-equivalent. 5/24 status checked against your history." })] }), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-2", children: top.map((b) => {
                    const ineligibleNote = !b.user_eligible_5_24 ? " · 5/24 over" : "";
                    return (_jsxs("div", { className: `flex items-start gap-3 p-3 rounded border ${b.user_eligible_5_24 ? "border-border" : "border-outflow/30 opacity-60"} hover:bg-hover`, children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: "text-sm font-semibold text-text truncate", children: b.card_name }), _jsxs("div", { className: "text-[11px] text-text-muted truncate", children: [b.issuer, ineligibleNote, " \u00B7 ", b.bonus_points > 0 ? `${b.bonus_points.toLocaleString()} pts ` : "", "\u2248 $", (b.bonus_dollar_value_cents / 100).toFixed(0), " after $", (b.minimum_spend_cents / 100).toFixed(0), " in ", b.minimum_spend_months, "mo \u00B7 $", (b.annual_fee_cents / 100).toFixed(0), " fee"] }), _jsx("p", { className: "text-[11px] text-text-soft mt-0.5 line-clamp-2", children: b.notes })] }), _jsxs("div", { className: "flex flex-col gap-1 shrink-0 items-end", children: [_jsx("a", { href: b.product_url, target: "_blank", rel: "noopener noreferrer", className: "text-[11px] text-brand hover:underline", children: "Apply \u2192" }), _jsx("button", { type: "button", onClick: () => onAdd({
                                            card_name: b.card_name,
                                            issuer: b.issuer,
                                            bonus_points: b.bonus_points,
                                            bonus_value_cents: b.bonus_dollar_value_cents,
                                            minimum_spend_cents: b.minimum_spend_cents,
                                            minimum_spend_window_days: b.minimum_spend_months * 30,
                                            annual_fee_cents: b.annual_fee_cents,
                                            counts_toward_5_24: b.counts_toward_5_24,
                                        }), className: "text-[11px] text-text-muted hover:text-brand", title: "Add this card as a planned application \u2014 start tracking minimum-spend progress.", children: "+ Track" })] })] }, b.card_name));
                }) })] }));
}
export default function CardApplicationsPanel() {
    const qc = useQueryClient();
    const apps = useQuery({ queryKey: ["cardApplications"], queryFn: () => api.listCardApplications() });
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ["cardApplications"] });
        qc.invalidateQueries({ queryKey: ["cardEligibility"] });
    };
    const create = useMutation({ mutationFn: api.createCardApplication, onSuccess: invalidate });
    const transition = useMutation({
        mutationFn: ({ id, status }) => api.updateCardApplicationStatus(id, status),
        onSuccess: invalidate,
    });
    const logSpend = useMutation({
        mutationFn: ({ id, cents }) => api.logCardApplicationSpend(id, cents),
        onSuccess: invalidate,
    });
    const destroy = useMutation({ mutationFn: api.deleteCardApplication, onSuccess: invalidate });
    return (_jsxs("div", { children: [_jsx(Eligibility, {}), _jsx(BestBonusesShelf, { onAdd: (entry) => create.mutate({
                    ...entry,
                    // Default the new application to "planning" so the user
                    // can edit/decline before committing to applying.
                    status: "planning",
                    spend_to_date_cents: 0,
                    first_year_fee_waived: false,
                }) }), _jsx(NewApplicationForm, { onAdd: (p) => create.mutate(p) }), apps.isLoading && (_jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3 mb-5", children: [_jsx(SkelStat, {}), _jsx(SkelStat, {}), _jsx(SkelStat, {}), _jsx(SkelStat, {})] })), apps.data?.length === 0 && (_jsxs("div", { className: "bg-card border border-border rounded-md p-6 text-center text-sm text-text-muted max-w-xl mx-auto", children: ["No card applications tracked yet. Click", " ", _jsx("span", { className: "font-mono", children: "+ Track" }), " on a top-bonus card above to plan one, or use the form below to enter one manually. The 5/24 + Amex eligibility checks fire as soon as your first application is logged."] })), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: apps.data?.map((a) => (_jsx(ApplicationCard, { a: a, onTransition: (s) => transition.mutate({ id: a.id, status: s }), onLogSpend: (c) => logSpend.mutate({ id: a.id, cents: c }), onDelete: () => destroy.mutate(a.id) }, a.id))) })] }));
}
