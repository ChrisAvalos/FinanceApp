import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, fmtMonthLong, fmtMonthShort, currentMonthStart, shiftMonthStart, } from "./api/client";
/* ------------------------------------------------------------------ */
/*  Status → color                                                    */
/* ------------------------------------------------------------------ */
const STATUS_BADGE = {
    on_track: "bg-emerald-50 text-inflow",
    warning: "bg-amber-50 text-warn",
    over: "bg-red-50 text-outflow",
};
const STATUS_LABEL = {
    on_track: "On track",
    warning: "Pacing hot",
    over: "Over",
};
function barColor(status) {
    if (status === "over")
        return "bg-outflow";
    if (status === "warning")
        return "bg-warn";
    return "bg-inflow";
}
/* ------------------------------------------------------------------ */
/*  Progress row                                                       */
/* ------------------------------------------------------------------ */
function ProgressBar({ pct, status }) {
    // Cap the visible fill at 100% but keep the raw pct for the label so we
    // can still see "115%" when you've blown past the cap.
    const fill = Math.min(100, pct);
    return (_jsx("div", { className: "w-full h-2 bg-gray-100 rounded-full overflow-hidden", children: _jsx("div", { className: `h-full rounded-full transition-all ${barColor(status)}`, style: { width: `${fill}%` } }) }));
}
/* ------------------------------------------------------------------ */
/*  Editable amount cell                                               */
/* ------------------------------------------------------------------ */
function BudgetAmountCell({ row, onSave, }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState((row.budget_cents / 100).toFixed(0));
    if (!editing) {
        return (_jsx("button", { onClick: () => {
                setDraft((row.budget_cents / 100).toFixed(0));
                setEditing(true);
            }, className: "text-sm font-semibold text-text hover:text-brand", title: "Click to edit", children: fmtCents(row.budget_cents) }));
    }
    return (_jsxs("form", { className: "flex items-center gap-1", onSubmit: (e) => {
            e.preventDefault();
            const dollars = parseFloat(draft);
            if (!Number.isNaN(dollars) && dollars >= 0) {
                onSave(Math.round(dollars * 100));
            }
            setEditing(false);
        }, children: [_jsx("span", { className: "text-text-soft text-sm", children: "$" }), _jsx("input", { autoFocus: true, type: "number", min: 0, step: 1, value: draft, onChange: (e) => setDraft(e.target.value), onBlur: () => setEditing(false), className: "w-20 px-1.5 py-0.5 text-sm border border-border rounded focus:outline-none focus:border-brand" })] }));
}
/* ------------------------------------------------------------------ */
/*  Add-budget form                                                    */
/* ------------------------------------------------------------------ */
function AddBudgetForm({ unbudgeted, allCategories, onAdd, }) {
    // Prefer a category that already has unbudgeted spending — the obvious
    // "you already spent here, want to cap it?" suggestion.
    const unbudgetedIds = new Set(unbudgeted.map((u) => u.category_id).filter((id) => id > 0));
    const preferred = allCategories.filter((c) => unbudgetedIds.has(c.id));
    const others = allCategories.filter((c) => !unbudgetedIds.has(c.id));
    const [catId, setCatId] = useState(preferred[0]?.id ?? others[0]?.id ?? 0);
    const [dollars, setDollars] = useState("");
    return (_jsxs("form", { className: "flex items-center gap-2 text-sm", onSubmit: (e) => {
            e.preventDefault();
            const v = parseFloat(dollars);
            if (!catId || Number.isNaN(v) || v < 0)
                return;
            onAdd(catId, Math.round(v * 100));
            setDollars("");
        }, children: [_jsxs("select", { value: catId, onChange: (e) => setCatId(Number(e.target.value)), className: "px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand bg-card", children: [preferred.length > 0 && (_jsx("optgroup", { label: "Unbudgeted (you already spend here)", children: preferred.map((c) => (_jsx("option", { value: c.id, children: c.name }, c.id))) })), _jsx("optgroup", { label: "Other categories", children: others.map((c) => (_jsx("option", { value: c.id, children: c.name }, c.id))) })] }), _jsx("span", { className: "text-text-soft", children: "$" }), _jsx("input", { type: "number", min: 0, step: 1, value: dollars, onChange: (e) => setDollars(e.target.value), placeholder: "Monthly cap", className: "w-28 px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand" }), _jsx("button", { type: "submit", className: "px-3 py-1 bg-brand text-white text-xs font-semibold rounded hover:bg-brand-navy disabled:opacity-50", disabled: !catId || !dollars, children: "Add budget" })] }));
}
/* ------------------------------------------------------------------ */
/*  Template result banner                                             */
/* ------------------------------------------------------------------ */
const ACTION_LABEL = {
    created: "Created",
    updated: "Updated",
    skipped_existing: "Skipped (already set)",
    skipped_low_avg: "Skipped (low avg)",
};
const ACTION_BADGE = {
    created: "bg-emerald-50 text-inflow",
    updated: "bg-blue-50 text-brand",
    skipped_existing: "bg-gray-100 text-text-muted",
    skipped_low_avg: "bg-gray-100 text-text-muted",
};
function TemplateResultBanner({ result, onDismiss, }) {
    const [showRows, setShowRows] = useState(false);
    // Headline: copy and fill have different framing.
    const isCopy = result.source_month_start !== null;
    const headline = isCopy
        ? `Copied from ${fmtMonthShort(result.source_month_start)} → ${fmtMonthShort(result.target_month_start)}`
        : `Filled ${fmtMonthShort(result.target_month_start)} from ${result.lookback_months ?? 3}-mo average`;
    // If nothing happened, give a softer message rather than "0 created" — the
    // most common cause is that all categories already had budgets and the user
    // didn't pass overwrite=true.
    const nothingHappened = result.created === 0 && result.updated === 0;
    return (_jsxs("div", { className: "mb-5 rounded-md border border-brand-light bg-blue-50/40 p-3", children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "flex-1", children: [_jsx("div", { className: "text-sm font-semibold text-brand-deep", children: headline }), _jsxs("div", { className: "text-xs text-text-muted mt-0.5 tabular-nums", children: [result.created, " created", result.updated > 0 && ` · ${result.updated} updated`, result.skipped > 0 && ` · ${result.skipped} skipped`, nothingHappened && (_jsx("span", { className: "ml-2 text-text-soft italic", children: "\u2014 existing budgets were preserved. Toggle overwrite to replace them." }))] })] }), _jsxs("div", { className: "flex items-center gap-2 shrink-0", children: [result.rows.length > 0 && (_jsx("button", { onClick: () => setShowRows((s) => !s), className: "text-xs text-brand hover:text-brand-navy font-semibold", children: showRows ? "Hide details" : "Show details" })), _jsx("button", { onClick: onDismiss, className: "w-6 h-6 flex items-center justify-center text-text-muted hover:text-text rounded", title: "Dismiss", "aria-label": "Dismiss", children: "\u00D7" })] })] }), showRows && result.rows.length > 0 && (_jsx("div", { className: "mt-3 max-h-56 overflow-y-auto border-t border-border pt-2", children: _jsx("table", { className: "w-full text-xs", children: _jsx("tbody", { children: result.rows.map((r) => (_jsxs("tr", { className: "border-b border-border last:border-0", children: [_jsx("td", { className: "py-1.5 pr-2 font-medium text-text", children: r.category_name }), _jsx("td", { className: "py-1.5 pr-2 text-right tabular-nums text-text-muted w-24", children: fmtCents(r.amount_cents) }), _jsx("td", { className: "py-1.5 text-right w-44", children: _jsx("span", { className: `inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${ACTION_BADGE[r.action] ?? "bg-gray-100 text-text-muted"}`, children: ACTION_LABEL[r.action] ?? r.action }) })] }, r.category_id))) }) }) }))] }));
}
/* ------------------------------------------------------------------ */
/*  Panel                                                              */
/* ------------------------------------------------------------------ */
export default function BudgetsPanel() {
    const qc = useQueryClient();
    const [monthStart, setMonthStart] = useState(currentMonthStart());
    const [lastTemplateResult, setLastTemplateResult] = useState(null);
    const rollup = useQuery({
        queryKey: ["budgetRollup", monthStart],
        queryFn: () => api.budgetRollup(monthStart),
    });
    const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
    const upsert = useMutation({
        mutationFn: api.upsertBudget,
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["budgetRollup", monthStart] });
            qc.invalidateQueries({ queryKey: ["budgets"] });
        },
    });
    const destroy = useMutation({
        mutationFn: api.deleteBudget,
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["budgetRollup", monthStart] });
        },
    });
    const copyFromPrior = useMutation({
        mutationFn: api.budgetCopyFromPrior,
        onSuccess: (result) => {
            setLastTemplateResult(result);
            qc.invalidateQueries({ queryKey: ["budgetRollup", monthStart] });
            qc.invalidateQueries({ queryKey: ["budgets"] });
        },
    });
    const fillFromAvg = useMutation({
        mutationFn: api.budgetFillFromAverage,
        onSuccess: (result) => {
            setLastTemplateResult(result);
            qc.invalidateQueries({ queryKey: ["budgetRollup", monthStart] });
            qc.invalidateQueries({ queryKey: ["budgets"] });
        },
    });
    const templateBusy = copyFromPrior.isPending || fillFromAvg.isPending;
    const data = rollup.data;
    const rows = data?.rows ?? [];
    const unbudgeted = data?.unbudgeted_spending ?? [];
    const pct = useMemo(() => {
        if (!data || data.total_budget_cents <= 0)
            return 0;
        return (data.total_actual_cents / data.total_budget_cents) * 100;
    }, [data]);
    const paceLabel = data ? `${Math.round(data.pace * 100)}% through month` : "";
    // What the overall bar color should be, based on aggregate pacing.
    const overallStatus = useMemo(() => {
        if (!data)
            return "on_track";
        if (data.total_actual_cents > data.total_budget_cents)
            return "over";
        const used = data.total_budget_cents > 0
            ? data.total_actual_cents / data.total_budget_cents
            : 0;
        if (data.pace > 0 && used / data.pace >= 1.2 && used >= 0.5)
            return "warning";
        return "on_track";
    }, [data]);
    return (_jsxs("div", { children: [_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-5 mb-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("button", { onClick: () => setMonthStart(shiftMonthStart(monthStart, -1)), className: "w-8 h-8 border border-border rounded text-text-muted hover:border-brand hover:text-brand transition-colors", title: "Previous month", children: "\u2190" }), _jsxs("div", { className: "min-w-[10rem] text-center", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Budget for" }), _jsx("div", { className: "text-lg font-semibold text-text", children: fmtMonthLong(monthStart) })] }), _jsx("button", { onClick: () => setMonthStart(shiftMonthStart(monthStart, 1)), className: "w-8 h-8 border border-border rounded text-text-muted hover:border-brand hover:text-brand transition-colors", title: "Next month", children: "\u2192" }), _jsx("button", { onClick: () => setMonthStart(currentMonthStart()), className: "ml-2 text-xs text-brand hover:text-brand-navy font-semibold", children: "This month" })] }), _jsx("div", { className: "text-xs text-text-muted", children: paceLabel })] }), _jsxs("div", { className: "flex flex-wrap items-center gap-2 mb-5 pb-5 border-b border-border", children: [_jsx("span", { className: "text-[11px] text-text-muted uppercase tracking-wide font-semibold mr-1", children: "Templates" }), _jsxs("button", { onClick: () => copyFromPrior.mutate({
                                    target_month_start: monthStart,
                                    overwrite: false,
                                }), disabled: templateBusy, title: `Copy budgets from ${fmtMonthShort(shiftMonthStart(monthStart, -1))} into ${fmtMonthShort(monthStart)}. Existing budgets are preserved.`, className: "px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors disabled:opacity-50", children: ["\u2190 Copy from ", fmtMonthShort(shiftMonthStart(monthStart, -1))] }), _jsx("button", { onClick: () => fillFromAvg.mutate({
                                    target_month_start: monthStart,
                                    lookback_months: 3,
                                    round_up_to_cents: 2_500,
                                    overwrite: false,
                                    min_avg_cents: 500,
                                }), disabled: templateBusy, title: "Average the last 3 months of category spending and pre-fill caps, rounded up to the nearest $25.", className: "px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors disabled:opacity-50", children: "Fill from 3-mo average" }), templateBusy && (_jsx("span", { className: "text-xs text-text-muted", children: "Working\u2026" })), _jsx("span", { className: "ml-auto text-[11px] text-text-soft", children: "Templates skip categories you've already set \u2014 your existing budgets stay safe." })] }), lastTemplateResult && (_jsx(TemplateResultBanner, { result: lastTemplateResult, onDismiss: () => setLastTemplateResult(null) })), (data?.total_budget_cents ?? 0) === 0 ? (_jsxs("div", { className: "bg-gradient-to-r from-brand/8 to-inflow/8 border border-brand/30 rounded-md p-5 mb-5 flex items-start gap-4", children: [_jsx("div", { className: "text-3xl", children: "\uD83C\uDFAF" }), _jsxs("div", { className: "flex-1", children: [_jsxs("h3", { className: "text-sm font-semibold text-text", children: ["Set up your first budget for ", fmtMonthShort(monthStart)] }), _jsxs("p", { className: "text-xs text-text-muted mt-1 max-w-2xl", children: ["Pick a template above (Copy from prior / Fill from 3-mo average) for a one-click start, or scroll to", " ", _jsx("span", { className: "font-mono", children: "Unbudgeted spending" }), " below and click ", _jsx("span", { className: "font-mono", children: "Budget this \u2192" }), " on the categories that matter to you."] }), _jsxs("div", { className: "mt-2 text-[11px] text-text-soft tabular-nums", children: ["Unbudgeted outflow so far this month:", " ", _jsx("span", { className: "text-outflow font-semibold", children: fmtCents(unbudgeted.reduce((acc, u) => acc + u.actual_outflow_cents, 0)) })] })] })] })) : (_jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-5", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Budgeted" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1", children: fmtCents(data?.total_budget_cents ?? 0) })] }), _jsxs("div", { children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Spent" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-outflow", children: fmtCents(data?.total_actual_cents ?? 0) })] }), _jsxs("div", { children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Remaining" }), _jsx("div", { className: `text-2xl font-semibold tabular-nums mt-1 ${(data?.total_budget_cents ?? 0) - (data?.total_actual_cents ?? 0) >= 0
                                            ? "text-inflow"
                                            : "text-outflow"}`, children: fmtCents((data?.total_budget_cents ?? 0) - (data?.total_actual_cents ?? 0)) })] }), _jsxs("div", { children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Unbudgeted spend" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text-muted", children: fmtCents(unbudgeted.reduce((acc, u) => acc + u.actual_outflow_cents, 0)) })] })] })), _jsxs("div", { className: "relative", children: [_jsx(ProgressBar, { pct: pct, status: overallStatus }), data && data.pace > 0 && data.pace < 1 && (_jsx("div", { className: "absolute top-0 h-2 w-0.5 bg-text-muted", style: { left: `${data.pace * 100}%` }, title: "Month pace" }))] }), _jsxs("div", { className: "flex justify-between text-[11px] text-text-soft mt-1 tabular-nums", children: [_jsxs("span", { children: [pct.toFixed(1), "% of budget used"] }), _jsx("span", { children: data?.pace !== undefined ? `${(data.pace * 100).toFixed(0)}% of month elapsed` : "" })] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsxs("div", { className: "flex items-center justify-between px-4 py-3 bg-hover border-b border-border", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Category budgets" }), cats.data && (_jsx(AddBudgetForm, { unbudgeted: unbudgeted, allCategories: cats.data, onAdd: (category_id, amount_cents) => upsert.mutate({
                                    category_id,
                                    month_start: monthStart,
                                    amount_cents,
                                }) }))] }), _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left w-1/4", children: "Category" }), _jsx("th", { className: "px-4 py-2 text-right w-1/12", children: "Budget" }), _jsx("th", { className: "px-4 py-2 text-right w-1/12", children: "Spent" }), _jsx("th", { className: "px-4 py-2 text-right w-1/12", children: "Remaining" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Progress" }), _jsx("th", { className: "px-4 py-2 text-left w-1/12", children: "Status" }), _jsx("th", { className: "px-4 py-2" })] }) }), _jsxs("tbody", { children: [rollup.isLoading && (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "p-8 text-center text-text-muted text-sm", children: "Loading\u2026" }) })), rollup.data && rows.length === 0 && (_jsx("tr", { children: _jsxs("td", { colSpan: 7, className: "p-8 text-center text-text-muted text-sm", children: ["No budgets set for ", fmtMonthLong(monthStart), ". Add one above \u2014 start with whatever shows up in Unbudgeted spending below."] }) })), rows.map((r) => {
                                        const rolloverIn = r.rollover_in_cents ?? 0;
                                        const effective = r.effective_budget_cents ?? r.budget_cents;
                                        return (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-4 py-3 text-sm font-medium", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { children: r.category_name }), rolloverIn !== 0 && (_jsx("span", { className: "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-brand-light text-brand", title: rolloverIn > 0
                                                                    ? `+${fmtCents(rolloverIn)} carried in from prior months`
                                                                    : `${fmtCents(rolloverIn)} deficit carried in from prior months`, children: "\u21BB rollover" }))] }) }), _jsxs("td", { className: "px-4 py-3 text-right tabular-nums", children: [_jsx(BudgetAmountCell, { row: r, onSave: (amount_cents) => upsert.mutate({
                                                                category_id: r.category_id,
                                                                month_start: monthStart,
                                                                amount_cents,
                                                            }) }), rolloverIn !== 0 && (_jsxs(_Fragment, { children: [_jsxs("div", { className: `text-[10px] mt-0.5 tabular-nums ${rolloverIn > 0 ? "text-inflow" : "text-outflow"}`, children: [rolloverIn > 0 ? "+" : "−", fmtCents(Math.abs(rolloverIn)), " rolled in"] }), _jsxs("div", { className: "text-[10px] text-text-muted mt-0.5 tabular-nums", children: ["effective: ", fmtCents(effective)] })] }))] }), _jsx("td", { className: "px-4 py-3 text-right tabular-nums text-sm text-outflow font-semibold", children: fmtCents(r.actual_outflow_cents) }), _jsx("td", { className: `px-4 py-3 text-right tabular-nums text-sm font-semibold ${r.remaining_cents >= 0 ? "text-inflow" : "text-outflow"}`, children: fmtCents(r.remaining_cents) }), _jsx("td", { className: "px-4 py-3 w-1/4", children: _jsxs("div", { className: "flex items-center gap-2", children: [_jsx("div", { className: "flex-1", children: _jsx(ProgressBar, { pct: r.pct_used, status: r.status }) }), _jsxs("span", { className: "text-[11px] text-text-muted tabular-nums w-10 text-right", children: [r.pct_used.toFixed(0), "%"] })] }) }), _jsx("td", { className: "px-4 py-3", children: _jsx("span", { className: `inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${STATUS_BADGE[r.status]}`, children: STATUS_LABEL[r.status] }) }), _jsx("td", { className: "px-4 py-3 text-right", children: _jsx("button", { onClick: async () => {
                                                            const list = await api.listBudgets(monthStart);
                                                            const b = list.find((x) => x.category_id === r.category_id);
                                                            if (b)
                                                                destroy.mutate(b.id);
                                                        }, className: "text-xs text-text-muted hover:text-outflow", title: "Remove this budget", children: "Remove" }) })] }, r.category_id));
                                    })] })] })] }), unbudgeted.length > 0 && (_jsxs("div", { className: "mt-6 bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsxs("div", { className: "px-4 py-3 bg-hover border-b border-border", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Unbudgeted spending" }), _jsxs("p", { className: "text-xs text-text-muted mt-0.5", children: ["Categories with money going out but no cap \u2014 blind spots. Click ", _jsx("em", { children: "Add budget" }), " above to set a cap, or ignore if these are intentionally un-policed."] })] }), _jsx("table", { className: "w-full", children: _jsx("tbody", { children: unbudgeted.map((u) => (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-4 py-3 text-sm font-medium", children: u.category_name }), _jsx("td", { className: "px-4 py-3 text-right tabular-nums text-sm text-outflow font-semibold w-32", children: fmtCents(u.actual_outflow_cents) }), _jsx("td", { className: "px-4 py-3 text-right w-32", children: u.category_id > 0 ? (_jsx("button", { onClick: () => {
                                                // Default the cap at roughly-current-spend rounded
                                                // up to the nearest $25 — a sensible starting point
                                                // the user can edit after creation.
                                                const ceil25 = Math.ceil(u.actual_outflow_cents / 2500) * 2500;
                                                upsert.mutate({
                                                    category_id: u.category_id,
                                                    month_start: monthStart,
                                                    amount_cents: Math.max(ceil25, 2500),
                                                });
                                            }, className: "text-xs text-brand hover:text-brand-navy font-semibold", children: "Budget this \u2192" })) : (_jsx("span", { className: "text-xs text-text-soft", children: "Uncategorized" })) })] }, u.category_id))) }) })] }))] }));
}
