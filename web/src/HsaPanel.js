import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * HSA receipt-bank panel — Phase 9.2.
 *
 * The decades-deferred reimbursement strategy: log out-of-pocket
 * medical expenses with receipts now, let the HSA grow tax-free, and
 * reimburse yourself decades later. The 30yr-projection card shows
 * what your saved-receipts pile would compound to at 7%/yr if you
 * left it in HSA-invested form instead.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents } from "./api/client";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelTableRow } from "./components/Skeleton";
function StatusPill({ status }) {
    const map = {
        saved: { label: "Saved", cls: "bg-emerald-50 text-inflow" },
        reimbursed: { label: "Reimbursed", cls: "bg-slate-100 text-text-muted" },
        voided: { label: "Voided", cls: "bg-rose-50 text-outflow" },
    };
    const m = map[status];
    return _jsx("span", { className: `px-1.5 py-0.5 rounded-sm ${m.cls} text-[10px] font-semibold uppercase tracking-wide`, children: m.label });
}
function ReceiptRow({ r, onReimburse, onDelete }) {
    return (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-4 py-2 text-xs text-text-muted whitespace-nowrap", children: new Date(r.expense_date).toLocaleDateString() }), _jsx("td", { className: "px-4 py-2", children: _jsx(StatusPill, { status: r.status }) }), _jsx("td", { className: "px-4 py-2 text-sm", children: r.description }), _jsx("td", { className: "px-4 py-2 text-xs text-text-muted", children: r.expense_category || "—" }), _jsx("td", { className: "px-4 py-2 text-xs text-text-muted", children: r.provider_name || "—" }), _jsx("td", { className: "px-4 py-2 text-right text-sm tabular-nums font-semibold", children: fmtCents(r.amount_cents) }), _jsxs("td", { className: "px-4 py-2 text-right", children: [r.status === "saved" && (_jsx("button", { onClick: onReimburse, className: "px-2 py-1 text-[11px] font-semibold rounded bg-brand text-white hover:bg-brand-navy", children: "Reimburse" })), _jsx("button", { onClick: () => { if (confirm("Delete?"))
                            onDelete(); }, className: "px-2 py-1 text-[11px] text-text-muted hover:text-outflow", children: "Del" })] })] }));
}
function AddReceiptForm({ onAdd }) {
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState({
        expense_date: new Date().toISOString().slice(0, 10),
        amount_dollars: "",
        description: "",
        expense_category: "",
        provider_name: "",
        payment_method: "",
        notes: "",
    });
    if (!open) {
        return (_jsx("button", { onClick: () => setOpen(true), className: "px-4 py-2 text-sm font-semibold rounded bg-brand text-white hover:bg-brand-navy", children: "+ Log receipt" }));
    }
    return (_jsxs("form", { className: "border border-border rounded-md bg-card p-4 space-y-3 mb-4", onSubmit: (e) => {
            e.preventDefault();
            const cents = Math.round(parseFloat(form.amount_dollars) * 100);
            if (!form.description.trim() || Number.isNaN(cents) || cents <= 0)
                return;
            onAdd({
                expense_date: form.expense_date,
                amount_cents: cents,
                description: form.description.trim(),
                expense_category: form.expense_category.trim() || null,
                provider_name: form.provider_name.trim() || null,
                payment_method: form.payment_method.trim() || null,
                notes: form.notes.trim() || null,
            });
            setForm({ expense_date: new Date().toISOString().slice(0, 10), amount_dollars: "", description: "", expense_category: "", provider_name: "", payment_method: "", notes: "" });
            setOpen(false);
        }, children: [_jsxs("div", { className: "flex justify-between", children: [_jsx("h4", { className: "text-sm font-semibold", children: "New HSA receipt" }), _jsx("button", { type: "button", onClick: () => setOpen(false), children: "\u00D7" })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-3 text-xs", children: [_jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Date" }), _jsx("input", { type: "date", value: form.expense_date, onChange: (e) => setForm({ ...form, expense_date: e.target.value }), className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Amount ($) *" }), _jsx("input", { type: "number", step: 0.01, value: form.amount_dollars, onChange: (e) => setForm({ ...form, amount_dollars: e.target.value }), className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Provider" }), _jsx("input", { value: form.provider_name, onChange: (e) => setForm({ ...form, provider_name: e.target.value }), className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { className: "md:col-span-3", children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Description *" }), _jsx("input", { value: form.description, onChange: (e) => setForm({ ...form, description: e.target.value }), placeholder: "e.g. Dr. Smith \u2014 annual physical", className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Category" }), _jsx("input", { value: form.expense_category, onChange: (e) => setForm({ ...form, expense_category: e.target.value }), placeholder: "dental, vision, rx, etc.", className: "w-full px-2 py-1.5 border border-border rounded" })] }), _jsxs("label", { children: [_jsx("span", { className: "block mb-1 font-semibold uppercase text-[10px]", children: "Paid via" }), _jsx("input", { value: form.payment_method, onChange: (e) => setForm({ ...form, payment_method: e.target.value }), placeholder: "Sapphire / Cash / etc.", className: "w-full px-2 py-1.5 border border-border rounded" })] })] }), _jsxs("div", { className: "flex gap-2", children: [_jsx("button", { type: "submit", className: "px-3 py-1.5 text-sm font-semibold rounded bg-brand text-white", children: "Save" }), _jsx("button", { type: "button", onClick: () => setOpen(false), className: "px-3 py-1.5 text-sm text-text-muted", children: "Cancel" })] })] }));
}
export default function HsaPanel() {
    const qc = useQueryClient();
    const receipts = useQuery({ queryKey: ["hsaReceipts"], queryFn: () => api.listHsaReceipts() });
    const summary = useQuery({ queryKey: ["hsaSummary"], queryFn: api.hsaSummary });
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ["hsaReceipts"] });
        qc.invalidateQueries({ queryKey: ["hsaSummary"] });
    };
    const create = useMutation({ mutationFn: api.createHsaReceipt, onSuccess: invalidate });
    const reimburse = useMutation({ mutationFn: (id) => api.reimburseHsaReceipt(id), onSuccess: invalidate });
    const destroy = useMutation({ mutationFn: api.deleteHsaReceipt, onSuccess: invalidate });
    const s = summary.data;
    return (_jsxs("div", { children: [summary.isLoading ? (_jsx(SkelHeroRow, { count: 4 })) : (_jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Saved receipts" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-inflow", children: _jsx(CountUp, { value: s?.saved_total_cents ?? 0, format: fmtCents }) }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: [s?.saved_count ?? 0, " receipts banked"] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Reimbursed" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: _jsx(CountUp, { value: s?.reimbursed_total_cents ?? 0, format: fmtCents }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "Lifetime distributions" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Total receipts" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: _jsx(CountUp, { value: s?.total_receipts ?? 0, format: (n) => String(Math.round(n)) }) }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: [s?.voided_count ?? 0, " voided"] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "@ 7%/yr \u00B7 30yr" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-warn", children: _jsx(CountUp, { value: s?.projected_at_30yr_7pct_cents ?? 0, format: fmtCents }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "If you keep them banked" })] })] })), s?.summary_text && (_jsx("div", { className: "mb-5 px-4 py-3 bg-brand-deep text-white rounded-md text-sm leading-relaxed", children: s.summary_text })), _jsx(AddReceiptForm, { onAdd: (p) => create.mutate(p) }), _jsx("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left", children: "Date" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Status" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Description" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Category" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Provider" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Amount" }), _jsx("th", { className: "px-4 py-2 text-right" })] }) }), _jsxs("tbody", { children: [receipts.isLoading && Array.from({ length: 4 }).map((_, i) => (_jsx(SkelTableRow, { cols: 7 }, i))), receipts.data?.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 7, className: "p-6 text-center text-sm text-text-muted max-w-md mx-auto", children: "No receipts logged yet. Start banking out-of-pocket medical expenses now \u2014 the 30-year projection above shows what each dollar saved becomes if you reimburse decades later." }) })), receipts.data?.map((r) => (_jsx(ReceiptRow, { r: r, onReimburse: () => reimburse.mutate(r.id), onDelete: () => destroy.mutate(r.id) }, r.id)))] })] }) }), _jsx("p", { className: "mt-3 text-[11px] text-text-soft", children: "HSA contributions are triple-tax-advantaged. Pay medical bills out of pocket, save the receipts here, and reimburse yourself decades later \u2014 your HSA balance compounds tax-free in the meantime." })] }));
}
