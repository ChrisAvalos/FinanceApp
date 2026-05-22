import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function fmtDateShort(ymd) {
    if (!ymd)
        return "—";
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "2-digit",
    });
}
function todayIso() {
    return new Date().toISOString().slice(0, 10);
}
function daysBetween(fromIso, toIso) {
    // fromIso/toIso are YYYY-MM-DD; parse local to avoid TZ drift
    const [y1, m1, d1] = fromIso.split("-").map(Number);
    const [y2, m2, d2] = toIso.split("-").map(Number);
    const a = new Date(y1, m1 - 1, d1).getTime();
    const b = new Date(y2, m2 - 1, d2).getTime();
    return Math.round((b - a) / 86_400_000);
}
const KIND_LABEL = {
    emergency_fund: "Emergency fund",
    debt_payoff: "Debt payoff",
    specific_savings: "Specific savings",
    general_savings: "General savings",
};
const KIND_BADGE = {
    emergency_fund: "bg-amber-50 text-warn",
    debt_payoff: "bg-red-50 text-outflow",
    specific_savings: "bg-brand-light text-brand-navy",
    general_savings: "bg-gray-100 text-text-muted",
};
const STATUS_LABEL = {
    active: "Active",
    achieved: "Achieved",
    paused: "Paused",
    archived: "Archived",
};
const SUGGESTION_KIND_LABEL = {
    allocate_to_goal: "Allocation",
    cancel_subscription: "Cancellation",
    debt_payoff_avalanche: "Avalanche",
    debt_payoff_snowball: "Snowball",
};
function progressPct(g) {
    if (g.target_amount_cents <= 0)
        return 0;
    return Math.min(100, Math.max(0, (g.current_amount_cents / g.target_amount_cents) * 100));
}
function progressBarColor(g) {
    const pct = progressPct(g);
    if (g.status === "achieved")
        return "bg-inflow";
    if (g.kind === "debt_payoff") {
        // For debt, "more progress" = more principal paid down = good
        if (pct >= 75)
            return "bg-inflow";
        if (pct >= 25)
            return "bg-brand";
        return "bg-warn";
    }
    if (pct >= 75)
        return "bg-inflow";
    if (pct >= 25)
        return "bg-brand";
    return "bg-text-soft";
}
/* ------------------------------------------------------------------ */
/*  Surplus card with toggle + breakdown                               */
/* ------------------------------------------------------------------ */
function SurplusCard({ snapshot, mode, onModeChange, }) {
    const [showDetail, setShowDetail] = useState(false);
    const value = useMemo(() => {
        if (!snapshot)
            return null;
        if (mode === "historical")
            return snapshot.historical?.surplus_cents ?? null;
        if (mode === "forecast")
            return snapshot.forecast?.surplus_cents ?? null;
        // "both" = show whichever exists; both endpoint returns both, so prefer historical
        return snapshot.historical?.surplus_cents ?? snapshot.forecast?.surplus_cents ?? null;
    }, [snapshot, mode]);
    const tone = value == null
        ? "text-text-soft"
        : value > 0
            ? "text-inflow"
            : value < 0
                ? "text-outflow"
                : "text-text";
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsxs("div", { className: "flex flex-col md:flex-row md:items-center md:justify-between gap-3 px-5 py-4 bg-hover border-b border-border", children: [_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("div", { className: "text-[11px] font-semibold uppercase tracking-wide text-text-muted", children: "Monthly surplus" }), _jsx(SyncFreshnessChip, { syncedAt: snapshot?.as_of ?? null, compact: true })] }), _jsx("p", { className: "text-xs text-text-soft mt-0.5", children: mode === "historical"
                                    ? "What you actually had left over the last 30 days."
                                    : mode === "forecast"
                                        ? "What you'll likely have left over the next 30 days."
                                        : "Both views — historical (looking back) and forecast (looking ahead)." })] }), _jsx("div", { className: "flex gap-1 bg-bg p-0.5 rounded-md border border-border", children: ["historical", "forecast", "both"].map((m) => (_jsx("button", { onClick: () => onModeChange(m), className: `px-3 py-1 text-xs font-semibold rounded transition-colors ${mode === m
                                ? "bg-brand text-white"
                                : "text-text-muted hover:text-text"}`, children: m === "historical" ? "Last 30d" : m === "forecast" ? "Next 30d" : "Both" }, m))) })] }), _jsx("div", { className: "px-5 py-5", children: snapshot == null ? (_jsx("div", { className: "text-text-soft text-sm", children: "Loading\u2026" })) : (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-4", children: [(mode === "historical" || mode === "both") && snapshot.historical && (_jsx(SurplusFigure, { label: "Last 30 days", value: snapshot.historical.surplus_cents, sub: `${snapshot.historical.window_start} → ${snapshot.historical.window_end}` })), (mode === "forecast" || mode === "both") && snapshot.forecast && (_jsx(SurplusFigure, { label: "Next 30 days", value: snapshot.forecast.surplus_cents, sub: `${snapshot.forecast.window_start} → ${snapshot.forecast.window_end}` })), mode !== "both" && value != null && (
                                // Keep at least one big number on screen if mode is single
                                _jsx("div", { className: `text-5xl font-bold tabular-nums self-center ${tone} hidden`, children: fmtCents(value) }))] }), snapshot.notes && snapshot.notes.length > 0 && (_jsx("ul", { className: "mt-3 text-[11px] text-warn space-y-1", children: snapshot.notes.map((n, i) => (_jsxs("li", { children: ["\u2022 ", n] }, i))) })), _jsx("button", { onClick: () => setShowDetail((v) => !v), className: "mt-4 text-xs font-semibold text-brand hover:text-brand-navy", children: showDetail ? "Hide breakdown ↑" : "Show breakdown ↓" }), showDetail && (_jsxs("div", { className: "mt-3 grid grid-cols-1 md:grid-cols-2 gap-4", children: [snapshot.historical && _jsx(HistoricalBreakdownCard, { h: snapshot.historical }), snapshot.forecast && _jsx(ForecastBreakdownCard, { f: snapshot.forecast })] }))] })) })] }));
}
function SurplusFigure({ label, value, sub, }) {
    const tone = value > 0 ? "text-inflow" : value < 0 ? "text-outflow" : "text-text";
    return (_jsxs("div", { children: [_jsx("div", { className: "text-[11px] font-semibold uppercase tracking-wide text-text-muted", children: label }), _jsx("div", { className: `text-3xl font-bold tabular-nums ${tone}`, children: fmtCents(value) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: sub })] }));
}
function HistoricalBreakdownCard({ h }) {
    return (_jsxs("div", { className: "rounded-md border border-border p-3 bg-bg", children: [_jsx("div", { className: "text-[10px] font-semibold uppercase tracking-wide text-text-muted", children: "Historical \u00B7 last 30d" }), _jsxs("dl", { className: "mt-2 space-y-1 text-xs", children: [_jsx(Row, { label: "Inflows", value: fmtCents(h.inflows_cents), tone: "in" }), _jsx(Row, { label: "Outflows", value: fmtCents(-h.outflows_cents), tone: "out" }), _jsx("div", { className: "border-t border-border my-1" }), _jsx(Row, { label: "Surplus", value: fmtCents(h.surplus_cents), tone: h.surplus_cents >= 0 ? "in" : "out", bold: true }), _jsxs("div", { className: "text-[10px] text-text-soft pt-1", children: [h.n_inflow_txns, " inflow txns \u00B7 ", h.n_outflow_txns, " outflow txns"] })] })] }));
}
function ForecastBreakdownCard({ f }) {
    return (_jsxs("div", { className: "rounded-md border border-border p-3 bg-bg", children: [_jsx("div", { className: "text-[10px] font-semibold uppercase tracking-wide text-text-muted", children: "Forecast \u00B7 next 30d" }), _jsxs("dl", { className: "mt-2 space-y-1 text-xs", children: [_jsx(Row, { label: "Projected income", value: fmtCents(f.projected_income_cents), tone: "in" }), _jsx(Row, { label: "Fixed obligations", value: fmtCents(-f.fixed_obligations_cents), tone: "out" }), _jsx(Row, { label: "Variable spend (est.)", value: fmtCents(-f.variable_spend_cents), tone: "out" }), _jsx("div", { className: "border-t border-border my-1" }), _jsx(Row, { label: "Surplus", value: fmtCents(f.surplus_cents), tone: f.surplus_cents >= 0 ? "in" : "out", bold: true }), _jsxs("div", { className: "text-[10px] text-text-soft pt-1", children: [f.n_active_subscriptions, " active subs \u00B7 ", f.n_variable_outflow_txns, " variable txns sampled"] })] })] }));
}
function Row({ label, value, tone, bold, }) {
    const color = tone === "in" ? "text-inflow" : tone === "out" ? "text-outflow" : "text-text";
    return (_jsxs("div", { className: "flex justify-between items-baseline", children: [_jsx("dt", { className: "text-text-muted", children: label }), _jsx("dd", { className: `tabular-nums ${color} ${bold ? "font-semibold" : ""}`, children: value })] }));
}
/* ------------------------------------------------------------------ */
/*  Goal card with progress + contribute dialog                        */
/* ------------------------------------------------------------------ */
function GoalCard({ goal, onContribute, onEdit, onDelete, }) {
    const pct = progressPct(goal);
    const remaining = Math.max(0, goal.target_amount_cents - goal.current_amount_cents);
    const daysLeft = goal.target_date ? daysBetween(todayIso(), goal.target_date) : null;
    const overdue = daysLeft != null && daysLeft < 0 && goal.status === "active";
    const close = daysLeft != null && daysLeft >= 0 && daysLeft <= 30;
    return (_jsx("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: _jsxs("div", { className: "p-4", children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 mb-1 flex-wrap", children: [_jsx("span", { className: `inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${KIND_BADGE[goal.kind]}`, children: KIND_LABEL[goal.kind] }), goal.status !== "active" && (_jsx("span", { className: "inline-block px-2 py-0.5 bg-gray-100 text-text-muted rounded-full text-[10px] font-semibold uppercase tracking-wide", children: STATUS_LABEL[goal.status] })), overdue && (_jsx("span", { className: "inline-block px-2 py-0.5 bg-red-50 text-outflow rounded-full text-[10px] font-semibold uppercase tracking-wide", children: "Overdue" })), !overdue && close && (_jsxs("span", { className: "inline-block px-2 py-0.5 bg-amber-50 text-warn rounded-full text-[10px] font-semibold uppercase tracking-wide", children: ["Due in ", daysLeft, "d"] }))] }), _jsx("h4", { className: "text-sm font-semibold text-text truncate", children: goal.name }), goal.notes && (_jsx("p", { className: "text-[11px] text-text-soft mt-0.5 line-clamp-2", children: goal.notes }))] }), _jsxs("div", { className: "text-right whitespace-nowrap", children: [_jsx("div", { className: "text-lg font-bold tabular-nums text-text", children: fmtCents(goal.current_amount_cents) }), _jsxs("div", { className: "text-[10px] text-text-soft uppercase tracking-wide", children: ["of ", fmtCents(goal.target_amount_cents)] }), goal.target_date && (_jsxs("div", { className: "text-[10px] text-text-soft mt-0.5", children: ["by ", fmtDateShort(goal.target_date)] }))] })] }), _jsxs("div", { className: "mt-3", children: [_jsx("div", { className: "relative h-2 bg-gray-100 rounded-full overflow-hidden", children: _jsx("div", { className: `h-full rounded-full transition-all ${progressBarColor(goal)}`, style: { width: `${pct}%` } }) }), _jsxs("div", { className: "flex justify-between text-[11px] text-text-soft mt-1 tabular-nums", children: [_jsxs("span", { children: [pct.toFixed(0), "%"] }), _jsxs("span", { children: [goal.kind === "debt_payoff" ? "remaining principal" : "remaining", " ", fmtCents(remaining)] })] })] }), _jsxs("div", { className: "mt-3 flex items-center justify-between gap-2", children: [_jsxs("div", { className: "text-[10px] text-text-soft", children: ["Priority ", goal.priority, " \u00B7 created ", fmtDateShort(goal.created_at.slice(0, 10))] }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("button", { onClick: () => onContribute(goal), className: "px-3 py-1 bg-brand text-white text-xs font-semibold rounded hover:bg-brand-navy", disabled: goal.status === "archived", children: goal.kind === "debt_payoff" ? "Log payment" : "Log contribution" }), _jsx("button", { onClick: () => onEdit(goal), className: "px-2 py-1 border border-border text-text-muted text-xs rounded hover:text-text hover:border-brand", children: "Edit" }), _jsx("button", { onClick: () => onDelete(goal), className: "text-xs text-text-soft hover:text-outflow", children: "Delete" })] })] })] }) }));
}
/* ------------------------------------------------------------------ */
/*  Add/edit goal form                                                 */
/* ------------------------------------------------------------------ */
const KIND_OPTIONS = [
    "emergency_fund",
    "debt_payoff",
    "specific_savings",
    "general_savings",
];
function GoalForm({ initial, onSubmit, onCancel, }) {
    const [name, setName] = useState(initial?.name ?? "");
    const [kind, setKind] = useState(initial?.kind ?? "general_savings");
    const [targetDollars, setTargetDollars] = useState(initial ? (initial.target_amount_cents / 100).toString() : "");
    const [targetDate, setTargetDate] = useState(initial?.target_date ?? "");
    const [priority, setPriority] = useState(String(initial?.priority ?? 5));
    const [status, setStatus] = useState(initial?.status ?? "active");
    const [notes, setNotes] = useState(initial?.notes ?? "");
    const valid = name.trim().length > 0 && Number(targetDollars) > 0;
    return (_jsxs("form", { className: "bg-card border border-border rounded-md shadow-card p-4 space-y-3", onSubmit: (e) => {
            e.preventDefault();
            if (!valid)
                return;
            onSubmit({
                name: name.trim(),
                kind,
                target_amount_cents: Math.round(Number(targetDollars) * 100),
                target_date: targetDate || null,
                priority: Number(priority) || 5,
                status,
                linked_account_id: initial?.linked_account_id ?? null,
                linked_debt_account_id: initial?.linked_debt_account_id ?? null,
                notes: notes.trim() || null,
            });
        }, children: [_jsx("div", { className: "text-sm font-semibold text-text", children: initial ? "Edit goal" : "New goal" }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: [_jsxs("label", { className: "block", children: [_jsx("span", { className: "text-[11px] font-semibold text-text-muted uppercase tracking-wide", children: "Name" }), _jsx("input", { type: "text", value: name, onChange: (e) => setName(e.target.value), placeholder: "e.g. Emergency fund \u2014 3 months", className: "mt-1 w-full px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand" })] }), _jsxs("label", { className: "block", children: [_jsx("span", { className: "text-[11px] font-semibold text-text-muted uppercase tracking-wide", children: "Kind" }), _jsx("select", { value: kind, onChange: (e) => setKind(e.target.value), className: "mt-1 w-full px-2 py-1 text-sm border border-border rounded bg-card", children: KIND_OPTIONS.map((k) => (_jsx("option", { value: k, children: KIND_LABEL[k] }, k))) })] }), _jsxs("label", { className: "block", children: [_jsx("span", { className: "text-[11px] font-semibold text-text-muted uppercase tracking-wide", children: "Target ($)" }), _jsx("input", { type: "number", step: "0.01", min: "0", value: targetDollars, onChange: (e) => setTargetDollars(e.target.value), placeholder: "10000", className: "mt-1 w-full px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand" })] }), _jsxs("label", { className: "block", children: [_jsx("span", { className: "text-[11px] font-semibold text-text-muted uppercase tracking-wide", children: "Target date" }), _jsx("input", { type: "date", value: targetDate, onChange: (e) => setTargetDate(e.target.value), className: "mt-1 w-full px-2 py-1 text-sm border border-border rounded" })] }), _jsxs("label", { className: "block", children: [_jsx("span", { className: "text-[11px] font-semibold text-text-muted uppercase tracking-wide", children: "Priority (lower = higher)" }), _jsx("input", { type: "number", min: "1", max: "99", value: priority, onChange: (e) => setPriority(e.target.value), className: "mt-1 w-full px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand" })] }), _jsxs("label", { className: "block", children: [_jsx("span", { className: "text-[11px] font-semibold text-text-muted uppercase tracking-wide", children: "Status" }), _jsx("select", { value: status, onChange: (e) => setStatus(e.target.value), className: "mt-1 w-full px-2 py-1 text-sm border border-border rounded bg-card", children: Object.keys(STATUS_LABEL).map((s) => (_jsx("option", { value: s, children: STATUS_LABEL[s] }, s))) })] })] }), _jsxs("label", { className: "block", children: [_jsx("span", { className: "text-[11px] font-semibold text-text-muted uppercase tracking-wide", children: "Notes" }), _jsx("textarea", { value: notes, onChange: (e) => setNotes(e.target.value), rows: 2, className: "mt-1 w-full px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand" })] }), _jsxs("div", { className: "flex justify-end gap-2 pt-1", children: [_jsx("button", { type: "button", onClick: onCancel, className: "px-3 py-1 border border-border text-text-muted text-xs rounded hover:text-text", children: "Cancel" }), _jsx("button", { type: "submit", disabled: !valid, className: "px-4 py-1 bg-brand text-white text-xs font-semibold rounded hover:bg-brand-navy disabled:opacity-50", children: initial ? "Save changes" : "Create goal" })] })] }));
}
/* ------------------------------------------------------------------ */
/*  Contribution dialog                                                */
/* ------------------------------------------------------------------ */
function ContributionDialog({ goal, onSubmit, onCancel, }) {
    const [amount, setAmount] = useState("");
    const [when, setWhen] = useState(todayIso());
    const [notes, setNotes] = useState("");
    const valid = Number(amount) > 0 && when.length === 10;
    return (_jsxs("div", { className: "bg-card border-2 border-brand rounded-md shadow-card p-4 space-y-3", children: [_jsxs("div", { children: [_jsx("div", { className: "text-sm font-semibold text-text", children: goal.kind === "debt_payoff" ? "Log a payment" : "Log a contribution" }), _jsx("p", { className: "text-[11px] text-text-soft mt-0.5", children: goal.kind === "debt_payoff"
                            ? "Records principal you've already paid down — does NOT initiate any transfer."
                            : "Records money you've already moved yourself — this app never moves money for you." })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: [_jsxs("label", { className: "block", children: [_jsx("span", { className: "text-[11px] font-semibold text-text-muted uppercase tracking-wide", children: "Amount ($)" }), _jsx("input", { type: "number", step: "0.01", min: "0", value: amount, onChange: (e) => setAmount(e.target.value), placeholder: "200.00", className: "mt-1 w-full px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand" })] }), _jsxs("label", { className: "block", children: [_jsx("span", { className: "text-[11px] font-semibold text-text-muted uppercase tracking-wide", children: "Date" }), _jsx("input", { type: "date", value: when, onChange: (e) => setWhen(e.target.value), className: "mt-1 w-full px-2 py-1 text-sm border border-border rounded" })] })] }), _jsxs("label", { className: "block", children: [_jsx("span", { className: "text-[11px] font-semibold text-text-muted uppercase tracking-wide", children: "Notes" }), _jsx("input", { type: "text", value: notes, onChange: (e) => setNotes(e.target.value), placeholder: "e.g. Transferred from checking", className: "mt-1 w-full px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand" })] }), _jsxs("div", { className: "flex justify-end gap-2", children: [_jsx("button", { onClick: onCancel, className: "px-3 py-1 border border-border text-text-muted text-xs rounded hover:text-text", children: "Cancel" }), _jsx("button", { onClick: () => {
                            if (!valid)
                                return;
                            onSubmit({
                                amount_cents: Math.round(Number(amount) * 100),
                                contributed_at: when,
                                source: goal.kind === "debt_payoff" ? "debt_payment" : "manual",
                                notes: notes.trim() || null,
                            });
                        }, disabled: !valid, className: "px-4 py-1 bg-brand text-white text-xs font-semibold rounded hover:bg-brand-navy disabled:opacity-50", children: "Record" })] })] }));
}
/* ------------------------------------------------------------------ */
/*  Suggestion card with expandable before/after                       */
/* ------------------------------------------------------------------ */
function SuggestionCard({ s }) {
    const [open, setOpen] = useState(false);
    const savings = s.estimated_savings_cents;
    const savingsTone = savings > 0 ? "text-inflow" : savings < 0 ? "text-outflow" : "text-text";
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsx("button", { onClick: () => setOpen((v) => !v), className: "w-full text-left p-4 hover:bg-hover transition-colors", children: _jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 mb-1 flex-wrap", children: [_jsx("span", { className: "inline-block px-2 py-0.5 bg-brand-light text-brand-navy rounded-full text-[10px] font-semibold uppercase tracking-wide", children: SUGGESTION_KIND_LABEL[s.kind] }), _jsxs("span", { className: "text-[10px] text-text-soft", children: ["conf ", (s.confidence * 100).toFixed(0), "%"] })] }), _jsx("h4", { className: "text-sm font-semibold text-text", children: s.title }), _jsx("p", { className: "text-xs text-text-muted mt-1 leading-relaxed", children: s.body })] }), _jsx("div", { className: "text-right whitespace-nowrap", children: savings !== 0 && (_jsxs(_Fragment, { children: [_jsxs("div", { className: `text-lg font-bold tabular-nums ${savingsTone}`, children: [savings > 0 ? "+" : "", fmtCents(savings)] }), _jsx("div", { className: "text-[10px] text-text-soft uppercase tracking-wide", children: "est. impact" })] })) })] }) }), open && s.before_after.length > 0 && (_jsxs("div", { className: "border-t border-border bg-hover/40 p-4", children: [_jsx("div", { className: "text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-2", children: "Before / after" }), _jsx("div", { className: "space-y-3", children: s.before_after.map((ba, i) => (_jsx(BeforeAfterRow, { ba: ba }, i))) })] }))] }));
}
function BeforeAfterRow({ ba }) {
    // Months-encoded-as-cents trick: debt strategies stuff month counts in here.
    // Render plainly when the label hints at months; otherwise as currency.
    const isMonths = /month/i.test(ba.label) || /payoff/i.test(ba.label);
    const fmt = (c) => (isMonths ? `${c} mo` : fmtCents(c));
    return (_jsxs("div", { className: "rounded border border-border bg-card p-3", children: [_jsx("div", { className: "text-xs font-semibold text-text mb-2", children: ba.label }), _jsxs("div", { className: "grid grid-cols-3 gap-3 text-xs", children: [_jsx(Mini, { label: "Now", tone: "neutral", value: fmt(ba.current_cents) }), _jsx(Mini, { label: "If you act", tone: "good", value: fmt(ba.if_act_cents) }), _jsx(Mini, { label: "If you don't", tone: "warn", value: fmt(ba.if_dont_act_cents) })] }), _jsx("div", { className: "text-[11px] text-text-soft mt-2", children: ba.summary })] }));
}
function Mini({ label, tone, value, }) {
    const border = tone === "good"
        ? "border-inflow/40"
        : tone === "warn"
            ? "border-outflow/40"
            : "border-border";
    const head = tone === "good"
        ? "text-inflow"
        : tone === "warn"
            ? "text-outflow"
            : "text-text-muted";
    return (_jsxs("div", { className: `rounded border ${border} bg-bg p-2`, children: [_jsx("div", { className: `text-[10px] font-semibold uppercase tracking-wide ${head}`, children: label }), _jsx("div", { className: "text-sm tabular-nums font-medium text-text mt-0.5", children: value })] }));
}
/* ------------------------------------------------------------------ */
/*  Suggestion section grouping                                        */
/* ------------------------------------------------------------------ */
function SuggestionSection({ title, subtitle, items, emptyText, }) {
    return (_jsxs("div", { children: [_jsxs("div", { className: "mb-2", children: [_jsx("h4", { className: "text-xs font-semibold text-text uppercase tracking-wide", children: title }), _jsx("p", { className: "text-[11px] text-text-soft", children: subtitle })] }), items.length === 0 ? (_jsx("div", { className: "bg-card border border-dashed border-border rounded-md p-4 text-center text-text-soft text-xs", children: emptyText })) : (_jsx("div", { className: "space-y-2", children: items.map((s, i) => (_jsx(SuggestionCard, { s: s }, i))) }))] }));
}
/* ------------------------------------------------------------------ */
/*  Contributions history (per-goal drawer)                            */
/* ------------------------------------------------------------------ */
function ContributionHistory({ goalId }) {
    const qc = useQueryClient();
    const list = useQuery({
        queryKey: ["goal-contributions", goalId],
        queryFn: () => api.listGoalContributions(goalId),
    });
    const del = useMutation({
        mutationFn: (cid) => api.deleteGoalContribution(goalId, cid),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["goal-contributions", goalId] });
            qc.invalidateQueries({ queryKey: ["goals"] });
        },
    });
    if (list.isLoading) {
        return _jsx("div", { className: "text-text-soft text-xs p-2", children: "Loading contributions\u2026" });
    }
    const rows = list.data ?? [];
    if (rows.length === 0) {
        return (_jsx("div", { className: "text-text-soft text-xs p-2", children: "No contributions yet." }));
    }
    return (_jsx("div", { className: "bg-bg border border-border rounded-md overflow-hidden", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[10px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-3 py-2 text-left", children: "Date" }), _jsx("th", { className: "px-3 py-2 text-right", children: "Amount" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Source" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Notes" }), _jsx("th", { className: "px-3 py-2" })] }) }), _jsx("tbody", { children: rows.map((r) => (_jsxs("tr", { className: "border-b border-border last:border-0", children: [_jsx("td", { className: "px-3 py-2 text-xs text-text-muted", children: fmtDateShort(r.contributed_at) }), _jsx("td", { className: "px-3 py-2 text-right tabular-nums text-xs font-medium", children: fmtCents(r.amount_cents) }), _jsx("td", { className: "px-3 py-2 text-xs text-text-muted", children: r.source }), _jsx("td", { className: "px-3 py-2 text-xs text-text-soft truncate max-w-[16rem]", children: r.notes ?? "—" }), _jsx("td", { className: "px-3 py-2 text-right", children: _jsx("button", { onClick: () => del.mutate(r.id), className: "text-[11px] text-text-soft hover:text-outflow", children: "Delete" }) })] }, r.id))) })] }) }));
}
/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */
export default function GoalsPanel() {
    const qc = useQueryClient();
    // Toggle is a single source of truth for both surplus and suggestions.
    // Surplus accepts "both"; suggestions are anchored to one mode (the server
    // and our client both coerce "both" → "historical" for the bundle).
    const [surplusMode, setSurplusMode] = useState("both");
    const suggestionMode = surplusMode === "forecast" ? "forecast" : "historical";
    const [showAdd, setShowAdd] = useState(false);
    const [editing, setEditing] = useState(null);
    const [contributing, setContributing] = useState(null);
    const [historyFor, setHistoryFor] = useState(null);
    const goals = useQuery({
        queryKey: ["goals"],
        queryFn: () => api.listGoals(),
    });
    const surplus = useQuery({
        queryKey: ["surplus", surplusMode],
        queryFn: () => api.surplus(surplusMode),
    });
    const suggestions = useQuery({
        queryKey: ["suggestions", suggestionMode],
        queryFn: () => api.suggestions(suggestionMode),
    });
    const createMut = useMutation({
        mutationFn: api.createGoal,
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["goals"] });
            qc.invalidateQueries({ queryKey: ["suggestions"] });
            setShowAdd(false);
        },
    });
    const updateMut = useMutation({
        mutationFn: ({ id, payload }) => api.updateGoal(id, payload),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["goals"] });
            qc.invalidateQueries({ queryKey: ["suggestions"] });
            setEditing(null);
        },
    });
    const deleteMut = useMutation({
        mutationFn: api.deleteGoal,
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["goals"] });
            qc.invalidateQueries({ queryKey: ["suggestions"] });
        },
    });
    const contribMut = useMutation({
        mutationFn: ({ id, payload }) => api.contributeToGoal(id, payload),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["goals"] });
            qc.invalidateQueries({ queryKey: ["goal-contributions"] });
            qc.invalidateQueries({ queryKey: ["suggestions"] });
            setContributing(null);
        },
    });
    // Group goals by status (active first, then achieved, then paused/archived)
    const groupedGoals = useMemo(() => {
        const all = goals.data ?? [];
        return {
            active: all.filter((g) => g.status === "active"),
            achieved: all.filter((g) => g.status === "achieved"),
            other: all.filter((g) => g.status === "paused" || g.status === "archived"),
        };
    }, [goals.data]);
    const bundle = suggestions.data;
    return (_jsxs("div", { className: "space-y-6", children: [_jsx(SurplusCard, { snapshot: surplus.data, mode: surplusMode, onModeChange: setSurplusMode }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsxs("div", { className: "px-5 py-3 bg-hover border-b border-border flex items-end justify-between", children: [_jsxs("div", { children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Suggestions" }), _jsxs("p", { className: "text-[11px] text-text-muted mt-0.5", children: ["Anchored to your", " ", _jsx("span", { className: "font-semibold", children: suggestionMode === "forecast" ? "next-30-day forecast" : "last-30-day" }), " ", "surplus of", " ", _jsx("span", { className: "font-semibold tabular-nums", children: bundle ? fmtCents(bundle.surplus_cents) : "—" }), ". The app never moves money \u2014 every recommendation is for you to act on."] })] }), _jsx("button", { onClick: () => {
                                    qc.invalidateQueries({ queryKey: ["surplus"] });
                                    qc.invalidateQueries({ queryKey: ["suggestions"] });
                                }, className: "text-xs font-semibold text-brand hover:text-brand-navy", children: "Refresh" })] }), _jsxs("div", { className: "p-5 space-y-5", children: [suggestions.isLoading && (_jsx("div", { className: "text-text-soft text-sm", children: "Computing\u2026" })), bundle && bundle.notes.length > 0 && (_jsx("ul", { className: "text-[11px] text-warn space-y-1", children: bundle.notes.map((n, i) => (_jsxs("li", { children: ["\u2022 ", n] }, i))) })), bundle && (_jsxs(_Fragment, { children: [_jsx(SuggestionSection, { title: "Allocate surplus", subtitle: "Greedy fill of your top goals from the surplus above.", items: bundle.allocations, emptyText: bundle.surplus_cents <= 0
                                            ? "No surplus to allocate this month."
                                            : "No active goals — create one below to see allocation suggestions." }), _jsx(SuggestionSection, { title: "Cancel or downgrade", subtitle: "Subscriptions ranked by likelihood of being safely droppable.", items: bundle.cancellations, emptyText: "No clear cancellation candidates right now." }), _jsx(SuggestionSection, { title: "Debt payoff strategy", subtitle: "Avalanche (highest APR first) and snowball (smallest balance first), with the months-saved math.", items: bundle.debt_strategies, emptyText: "No debt-payoff goals yet \u2014 add one with a linked credit account to see strategy comparisons." })] }))] })] }), _jsxs("div", { children: [_jsxs("div", { className: "flex items-end justify-between mb-3", children: [_jsxs("div", { children: [_jsx("h3", { className: "text-sm font-semibold text-text uppercase tracking-wide", children: "Your goals" }), _jsx("p", { className: "text-xs text-text-muted mt-0.5", children: "Sorted by priority. Emergency fund > debt payoff > specific savings > general savings within each priority tier." })] }), _jsx("button", { onClick: () => {
                                    setShowAdd((v) => !v);
                                    setEditing(null);
                                }, className: "px-3 py-1.5 bg-brand text-white text-xs font-semibold rounded hover:bg-brand-navy", children: showAdd ? "Close" : "+ New goal" })] }), showAdd && !editing && (_jsx("div", { className: "mb-4", children: _jsx(GoalForm, { onSubmit: (payload) => createMut.mutate(payload), onCancel: () => setShowAdd(false) }) })), editing && (_jsx("div", { className: "mb-4", children: _jsx(GoalForm, { initial: editing, onSubmit: (payload) => updateMut.mutate({ id: editing.id, payload }), onCancel: () => setEditing(null) }) })), contributing && (_jsx("div", { className: "mb-4", children: _jsx(ContributionDialog, { goal: contributing, onSubmit: (payload) => contribMut.mutate({ id: contributing.id, payload }), onCancel: () => setContributing(null) }) })), goals.isLoading && (_jsx("div", { className: "text-text-soft text-sm p-4", children: "Loading\u2026" })), goals.data && goals.data.length === 0 && !showAdd && (_jsx("div", { className: "bg-gradient-to-r from-brand/8 to-inflow/8 border border-brand/30 rounded-md p-6", children: _jsxs("div", { className: "flex items-start gap-4", children: [_jsx("div", { className: "text-3xl", children: "\uD83C\uDFAF" }), _jsxs("div", { className: "flex-1", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Set your first savings goal" }), _jsx("p", { className: "text-xs text-text-muted mt-1 max-w-2xl", children: "A goal turns vague intent into a deadline + dollar amount \u2014 and unlocks the suggestion engine that allocates your monthly surplus across goals, debt payoff, and high-interest parking." }), _jsxs("div", { className: "mt-3 flex flex-wrap gap-2 text-[11px]", children: [_jsx("span", { className: "px-2 py-0.5 rounded-full bg-card border border-border text-text-muted", children: "Emergency fund \u00B7 3\u20136 months expenses" }), _jsx("span", { className: "px-2 py-0.5 rounded-full bg-card border border-border text-text-muted", children: "Down payment \u00B7 12\u201324 months" }), _jsx("span", { className: "px-2 py-0.5 rounded-full bg-card border border-border text-text-muted", children: "Car / next big purchase" }), _jsx("span", { className: "px-2 py-0.5 rounded-full bg-card border border-border text-text-muted", children: "Annual travel" })] }), _jsx("button", { type: "button", onClick: () => setShowAdd(true), className: "mt-3 px-3 py-1.5 rounded-md text-xs font-semibold bg-brand text-white hover:bg-brand-hover", children: "+ New goal" })] })] }) })), groupedGoals.active.length > 0 && (_jsx("div", { className: "grid grid-cols-1 lg:grid-cols-2 gap-3", children: groupedGoals.active.map((g) => (_jsxs("div", { children: [_jsx(GoalCard, { goal: g, onContribute: (gg) => {
                                        setContributing(gg);
                                        setEditing(null);
                                    }, onEdit: (gg) => {
                                        setEditing(gg);
                                        setContributing(null);
                                        setShowAdd(false);
                                    }, onDelete: (gg) => {
                                        if (confirm(`Delete "${gg.name}"? This also removes its contributions history.`)) {
                                            deleteMut.mutate(gg.id);
                                        }
                                    } }), _jsx("button", { onClick: () => setHistoryFor(historyFor === g.id ? null : g.id), className: "mt-1 text-[11px] text-text-soft hover:text-brand", children: historyFor === g.id ? "Hide history ↑" : "Show history ↓" }), historyFor === g.id && (_jsx("div", { className: "mt-2", children: _jsx(ContributionHistory, { goalId: g.id }) }))] }, g.id))) })), groupedGoals.achieved.length > 0 && (_jsxs("div", { className: "mt-6", children: [_jsx("div", { className: "text-xs font-semibold text-text-muted uppercase tracking-wide mb-2", children: "Achieved" }), _jsx("div", { className: "grid grid-cols-1 lg:grid-cols-2 gap-3", children: groupedGoals.achieved.map((g) => (_jsx(GoalCard, { goal: g, onContribute: (gg) => setContributing(gg), onEdit: (gg) => setEditing(gg), onDelete: (gg) => {
                                        if (confirm(`Delete "${gg.name}"?`))
                                            deleteMut.mutate(gg.id);
                                    } }, g.id))) })] })), groupedGoals.other.length > 0 && (_jsxs("div", { className: "mt-6", children: [_jsx("div", { className: "text-xs font-semibold text-text-muted uppercase tracking-wide mb-2", children: "Paused / archived" }), _jsx("div", { className: "grid grid-cols-1 lg:grid-cols-2 gap-3", children: groupedGoals.other.map((g) => (_jsx(GoalCard, { goal: g, onContribute: (gg) => setContributing(gg), onEdit: (gg) => setEditing(gg), onDelete: (gg) => {
                                        if (confirm(`Delete "${gg.name}"?`))
                                            deleteMut.mutate(gg.id);
                                    } }, g.id))) })] }))] })] }));
}
