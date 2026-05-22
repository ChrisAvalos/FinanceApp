import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Receipts panel — Phase 10 Slice A.
 *
 * Foundation panel for the shopping-intelligence stack. Lets Chris
 * upload receipt photos (or paste OCR text), see the extracted line
 * items, edit any field, and browse history.
 *
 * UX flow:
 *   1. Top: drag/drop or file picker for image upload, plus a paste
 *      box for the no-OCR fallback. OCR availability probe runs once
 *      so the right path is highlighted.
 *   2. Middle: list of past receipts (newest first), one card per row.
 *      Click a card to open its detail view.
 *   3. Detail view (modal-style on desktop, full-screen on mobile):
 *      - Editable merchant / date / subtotal / tax / total
 *      - Editable line items table (name, qty, price, sku, category)
 *      - Re-parse button (re-runs OCR on stored image)
 *      - Delete button
 *
 * Slice C will add a "Coupons & offers" subsection that pulls
 * coupon codes / promo URLs out of the same OCR text.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
/* ------------------------------------------------------------------ */
/*  Status badge                                                        */
/* ------------------------------------------------------------------ */
function StatusBadge({ s }) {
    const map = {
        pending: { label: "Pending", cls: "bg-slate-100 text-text-muted" },
        parsed: { label: "Parsed", cls: "bg-emerald-50 text-inflow" },
        failed: { label: "Needs attention", cls: "bg-rose-50 text-outflow" },
        manual: { label: "Manual entry", cls: "bg-sky-50 text-sky-700" },
    };
    const m = map[s];
    return (_jsx("span", { className: `px-1.5 py-0.5 rounded-sm ${m.cls} text-[10px] font-semibold uppercase tracking-wide`, children: m.label }));
}
/* ------------------------------------------------------------------ */
/*  Upload card                                                         */
/* ------------------------------------------------------------------ */
function UploadCard({ onUploaded }) {
    const ocr = useQuery({ queryKey: ["ocrStatus"], queryFn: api.ocrStatus });
    const [busy, setBusy] = useState(false);
    const [warnings, setWarnings] = useState([]);
    const [showPasteBox, setShowPasteBox] = useState(false);
    const [pasteText, setPasteText] = useState("");
    const upload = useMutation({
        mutationFn: api.uploadReceipt,
        onSuccess: (r) => {
            setWarnings(r.warnings);
            setBusy(false);
            onUploaded();
        },
        onError: (e) => {
            setWarnings([e.message]);
            setBusy(false);
        },
    });
    const parse = useMutation({
        mutationFn: api.parseReceiptText,
        onSuccess: (r) => {
            setWarnings(r.warnings);
            setShowPasteBox(false);
            setPasteText("");
            onUploaded();
        },
        onError: (e) => setWarnings([e.message]),
    });
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-5 p-5", children: [_jsxs("div", { className: "flex items-start justify-between gap-3 mb-3", children: [_jsxs("div", { children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Add a receipt" }), _jsx("p", { className: "text-xs text-text-muted mt-0.5", children: "Upload a photo (JPG/PNG/PDF) or paste OCR'd text manually. Each receipt becomes line-item-level spending data we can use for budget tracking and deal alerts." })] }), ocr.data && (_jsxs("span", { className: `px-2 py-1 rounded text-[10px] font-semibold uppercase tracking-wide ${ocr.data.available
                            ? "bg-emerald-50 text-inflow"
                            : "bg-amber-50 text-warn"}`, title: ocr.data.install_hint ?? "Tesseract is installed and ready", children: ["OCR ", ocr.data.available ? "ready" : "unavailable"] }))] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: [_jsxs("label", { className: `flex flex-col items-center justify-center px-4 py-8 border-2 border-dashed rounded transition-colors cursor-pointer ${ocr.data?.available
                            ? "border-border hover:border-brand hover:bg-hover"
                            : "border-border bg-slate-50 opacity-50 cursor-not-allowed"}`, children: [_jsx("input", { type: "file", accept: "image/*,application/pdf", disabled: !ocr.data?.available || busy, onChange: (e) => {
                                    const f = e.target.files?.[0];
                                    if (!f)
                                        return;
                                    setBusy(true);
                                    setWarnings([]);
                                    upload.mutate(f);
                                    e.target.value = "";
                                }, className: "hidden" }), _jsx("span", { className: "text-xs font-semibold text-text", children: busy ? "Uploading + OCRing…" : "Drop a receipt or click to browse" }), _jsx("span", { className: "text-[11px] text-text-muted mt-1", children: "JPG, PNG, PDF \u00B7 OCR runs server-side" })] }), _jsx("div", { className: "flex flex-col", children: _jsx("button", { onClick: () => setShowPasteBox((v) => !v), className: "flex items-center justify-center px-4 py-8 border-2 border-dashed border-border rounded hover:border-brand hover:bg-hover transition-colors", children: _jsx("span", { className: "text-xs font-semibold text-text", children: showPasteBox ? "Hide paste box" : "Paste OCR text instead" }) }) })] }), showPasteBox && (_jsxs("form", { className: "mt-3", onSubmit: (e) => {
                    e.preventDefault();
                    if (pasteText.trim()) {
                        setWarnings([]);
                        parse.mutate(pasteText);
                    }
                }, children: [_jsx("textarea", { value: pasteText, onChange: (e) => setPasteText(e.target.value), rows: 8, placeholder: "Paste your receipt text here...", className: "w-full px-3 py-2 text-xs border border-border rounded font-mono focus:outline-none focus:border-brand" }), _jsxs("div", { className: "flex items-center gap-2 mt-2", children: [_jsx("button", { type: "submit", disabled: !pasteText.trim() || parse.isPending, className: "px-3 py-1.5 text-sm font-semibold rounded bg-brand text-white disabled:opacity-50", children: parse.isPending ? "Parsing…" : "Parse + save" }), _jsx("button", { type: "button", onClick: () => { setShowPasteBox(false); setPasteText(""); }, className: "px-3 py-1.5 text-sm text-text-muted hover:text-text", children: "Cancel" })] })] })), warnings.length > 0 && (_jsx("div", { className: "mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-[11px] text-warn space-y-1", children: warnings.map((w, i) => _jsxs("div", { children: ["\u2022 ", w] }, i)) })), ocr.data && !ocr.data.available && (_jsx("div", { className: "mt-3 px-3 py-2 bg-slate-50 rounded text-[11px] text-text-muted", children: ocr.data.install_hint }))] }));
}
/* ------------------------------------------------------------------ */
/*  Receipt list row                                                    */
/* ------------------------------------------------------------------ */
function ReceiptRow({ r, onOpen }) {
    return (_jsx("button", { onClick: onOpen, className: "w-full text-left border border-border rounded-md p-3 bg-card hover:shadow-card-hover transition-shadow", children: _jsxs("div", { className: "flex items-center justify-between gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx("h4", { className: "text-sm font-semibold text-text truncate", children: r.merchant || "Unknown merchant" }), _jsx(StatusBadge, { s: r.status })] }), _jsx("div", { className: "text-xs text-text-muted mt-0.5", children: r.purchase_date || new Date(r.created_at).toLocaleDateString() })] }), _jsx("div", { className: "text-right", children: _jsx("div", { className: "text-sm font-semibold tabular-nums", children: r.total_cents != null ? fmtCents(r.total_cents) : "—" }) })] }) }));
}
/* ------------------------------------------------------------------ */
/*  Detail view (line item table)                                       */
/* ------------------------------------------------------------------ */
function ItemRow({ item, onPatch, onDelete, }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState({
        name: item.name ?? "",
        qty: (item.quantity_units / 1000).toString(),
        price: item.line_total_cents != null ? (item.line_total_cents / 100).toFixed(2) : "",
        cat: item.item_category ?? "",
    });
    if (!editing) {
        return (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-3 py-2 text-xs text-text-muted", children: item.sku || "—" }), _jsx("td", { className: "px-3 py-2 text-sm", children: item.name || item.raw_line }), _jsx("td", { className: "px-3 py-2 text-xs text-text-muted", children: item.item_category || "—" }), _jsxs("td", { className: "px-3 py-2 text-right text-sm tabular-nums", children: [(item.quantity_units / 1000).toFixed(item.quantity_units % 1000 === 0 ? 0 : 2), item.unit_label && ` ${item.unit_label}`] }), _jsx("td", { className: "px-3 py-2 text-right text-sm tabular-nums font-semibold", children: item.line_total_cents != null ? fmtCents(item.line_total_cents) : "—" }), _jsxs("td", { className: "px-3 py-2 text-right", children: [_jsx("button", { onClick: () => setEditing(true), className: "text-xs text-brand hover:underline", children: "Edit" }), _jsx("button", { onClick: () => { if (confirm("Delete this line?"))
                                onDelete(); }, className: "ml-2 text-xs text-text-muted hover:text-outflow", children: "Del" })] })] }));
    }
    return (_jsxs("tr", { className: "border-b border-border last:border-0 bg-amber-50", children: [_jsx("td", { className: "px-3 py-2 text-xs text-text-muted", children: item.sku || "—" }), _jsx("td", { className: "px-3 py-2", children: _jsx("input", { value: draft.name, onChange: (e) => setDraft({ ...draft, name: e.target.value }), className: "w-full px-2 py-1 text-sm border border-border rounded" }) }), _jsx("td", { className: "px-3 py-2", children: _jsx("input", { value: draft.cat, onChange: (e) => setDraft({ ...draft, cat: e.target.value }), placeholder: "grocery, paper, etc", className: "w-full px-2 py-1 text-xs border border-border rounded" }) }), _jsx("td", { className: "px-3 py-2", children: _jsx("input", { type: "number", step: 0.001, value: draft.qty, onChange: (e) => setDraft({ ...draft, qty: e.target.value }), className: "w-20 px-2 py-1 text-xs border border-border rounded text-right" }) }), _jsx("td", { className: "px-3 py-2", children: _jsx("input", { type: "number", step: 0.01, value: draft.price, onChange: (e) => setDraft({ ...draft, price: e.target.value }), className: "w-24 px-2 py-1 text-xs border border-border rounded text-right" }) }), _jsxs("td", { className: "px-3 py-2 text-right", children: [_jsx("button", { onClick: () => {
                            const qty = parseFloat(draft.qty);
                            const priceDollars = parseFloat(draft.price);
                            onPatch({
                                name: draft.name.trim() || null,
                                quantity_units: Number.isNaN(qty) ? 1000 : Math.round(qty * 1000),
                                line_total_cents: Number.isNaN(priceDollars) ? null : Math.round(priceDollars * 100),
                                item_category: draft.cat.trim() || null,
                            });
                            setEditing(false);
                        }, className: "text-xs font-semibold text-brand hover:underline", children: "Save" }), _jsx("button", { onClick: () => setEditing(false), className: "ml-2 text-xs text-text-muted", children: "Cancel" })] })] }));
}
function ReceiptDetailView({ receipt, onClose, }) {
    const qc = useQueryClient();
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ["receipts"] });
        qc.invalidateQueries({ queryKey: ["receipt", receipt.id] });
        // Coupon changes affect Money on the Table — invalidate that too.
        qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
    };
    const patchHeader = useMutation({
        mutationFn: (p) => api.patchReceipt(receipt.id, p),
        onSuccess: invalidate,
    });
    const patchItem = useMutation({
        mutationFn: ({ id, p }) => api.patchReceiptItem(id, p),
        onSuccess: invalidate,
    });
    const deleteItem = useMutation({
        mutationFn: api.deleteReceiptItem,
        onSuccess: invalidate,
    });
    // Slice C coupons
    const patchCoupon = useMutation({
        mutationFn: ({ id, p }) => api.patchReceiptCoupon(id, p),
        onSuccess: invalidate,
    });
    const deleteCoupon = useMutation({
        mutationFn: api.deleteReceiptCoupon,
        onSuccess: invalidate,
    });
    const reparse = useMutation({
        mutationFn: () => api.reparseReceipt(receipt.id),
        onSuccess: () => { invalidate(); onClose(); },
    });
    const destroy = useMutation({
        mutationFn: () => api.deleteReceipt(receipt.id),
        onSuccess: () => { invalidate(); onClose(); },
    });
    const [editingHeader, setEditingHeader] = useState(false);
    const [hdr, setHdr] = useState({
        merchant: receipt.merchant ?? "",
        purchase_date: receipt.purchase_date ?? "",
        total: receipt.total_cents != null ? (receipt.total_cents / 100).toFixed(2) : "",
    });
    const itemsTotal = receipt.items.reduce((s, it) => s + (it.line_total_cents ?? 0), 0);
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-5", children: [_jsxs("div", { className: "flex items-center justify-between gap-3 mb-4", children: [_jsx("div", { children: editingHeader ? (_jsxs("div", { className: "grid grid-cols-3 gap-2 text-xs", children: [_jsx("input", { value: hdr.merchant, onChange: (e) => setHdr({ ...hdr, merchant: e.target.value }), className: "px-2 py-1 border border-border rounded", placeholder: "Merchant" }), _jsx("input", { type: "date", value: hdr.purchase_date, onChange: (e) => setHdr({ ...hdr, purchase_date: e.target.value }), className: "px-2 py-1 border border-border rounded" }), _jsx("input", { type: "number", step: 0.01, value: hdr.total, onChange: (e) => setHdr({ ...hdr, total: e.target.value }), className: "px-2 py-1 border border-border rounded text-right", placeholder: "Total" }), _jsx("button", { onClick: () => {
                                        const totalCents = hdr.total ? Math.round(parseFloat(hdr.total) * 100) : null;
                                        patchHeader.mutate({
                                            merchant: hdr.merchant.trim() || null,
                                            purchase_date: hdr.purchase_date || null,
                                            total_cents: totalCents,
                                        });
                                        setEditingHeader(false);
                                    }, className: "px-2 py-1 text-xs font-semibold rounded bg-brand text-white", children: "Save" }), _jsx("button", { onClick: () => setEditingHeader(false), className: "px-2 py-1 text-xs text-text-muted", children: "Cancel" })] })) : (_jsxs("div", { children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("h3", { className: "text-base font-semibold text-text", children: receipt.merchant || "Unknown merchant" }), _jsx(StatusBadge, { s: receipt.status }), _jsx("button", { onClick: () => setEditingHeader(true), className: "text-xs text-brand hover:underline", children: "Edit" })] }), _jsxs("div", { className: "text-xs text-text-muted mt-0.5", children: [receipt.purchase_date || "no date", " \u00B7", receipt.subtotal_cents != null && ` Subtotal ${fmtCents(receipt.subtotal_cents)} ·`, receipt.tax_cents != null && ` Tax ${fmtCents(receipt.tax_cents)} ·`, receipt.total_cents != null && ` Total ${fmtCents(receipt.total_cents)}`] })] })) }), _jsxs("div", { className: "flex items-center gap-2", children: [receipt.image_path && (_jsx("button", { onClick: () => reparse.mutate(), disabled: reparse.isPending, className: "px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-brand hover:text-brand disabled:opacity-50", title: "Re-run OCR + parser on the original image", children: reparse.isPending ? "Reparsing…" : "Reparse" })), _jsx("button", { onClick: () => { if (confirm(`Delete receipt from ${receipt.merchant || "this"}?`))
                                    destroy.mutate(); }, className: "px-3 py-1.5 text-xs text-text-muted hover:text-outflow", children: "Delete" }), _jsx("button", { onClick: onClose, className: "px-3 py-1.5 text-xs text-text-muted hover:text-text", children: "Close" })] })] }), _jsx("div", { className: "overflow-hidden border border-border rounded", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-3 py-2 text-left", children: "SKU" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Item" }), _jsx("th", { className: "px-3 py-2 text-left", children: "Category" }), _jsx("th", { className: "px-3 py-2 text-right", children: "Qty" }), _jsx("th", { className: "px-3 py-2 text-right", children: "Total" }), _jsx("th", { className: "px-3 py-2 text-right" })] }) }), _jsxs("tbody", { children: [receipt.items.length === 0 && (_jsx("tr", { children: _jsxs("td", { colSpan: 6, className: "px-3 py-6 text-center text-sm text-text-muted", children: ["No line items extracted. ", receipt.status === "failed" ? "OCR failed — try the Reparse button or paste text manually." : "Edit the receipt to add items."] }) })), receipt.items.map((it) => (_jsx(ItemRow, { item: it, onPatch: (p) => patchItem.mutate({ id: it.id, p }), onDelete: () => deleteItem.mutate(it.id) }, it.id)))] }), receipt.items.length > 0 && (_jsx("tfoot", { className: "bg-slate-50 border-t border-border", children: _jsxs("tr", { className: "text-xs", children: [_jsx("td", { colSpan: 4, className: "px-3 py-2 text-right font-semibold", children: "Items sum" }), _jsx("td", { className: "px-3 py-2 text-right font-semibold tabular-nums", children: fmtCents(itemsTotal) }), _jsx("td", {})] }) }))] }) }), receipt.coupons.length > 0 && (_jsx(CouponsSection, { coupons: receipt.coupons, onPatch: (id, p) => patchCoupon.mutate({ id, p }), onDelete: (id) => deleteCoupon.mutate(id) })), receipt.raw_text && (_jsxs("details", { className: "mt-4", children: [_jsx("summary", { className: "text-xs text-text-muted cursor-pointer hover:text-text", children: "Show raw OCR text" }), _jsx("pre", { className: "mt-2 p-3 bg-slate-50 border border-border rounded text-[11px] font-mono whitespace-pre-wrap overflow-x-auto", children: receipt.raw_text })] }))] }));
}
/* ------------------------------------------------------------------ */
/*  Coupons section (Slice C)                                          */
/* ------------------------------------------------------------------ */
function CouponStatusBadge({ s }) {
    const map = {
        available: { label: "Available", cls: "bg-emerald-50 text-inflow" },
        used: { label: "Used", cls: "bg-slate-100 text-text-muted" },
        expired: { label: "Expired", cls: "bg-rose-50 text-outflow" },
        dismissed: { label: "Dismissed", cls: "bg-slate-100 text-text-soft" },
    };
    const m = map[s];
    return _jsx("span", { className: `px-1.5 py-0.5 rounded-sm ${m.cls} text-[10px] font-semibold uppercase tracking-wide`, children: m.label });
}
function CouponCard({ c, onPatch, onDelete, }) {
    const isAvailable = c.status === "available";
    const daysLeft = c.expires_at
        ? Math.ceil((new Date(c.expires_at).getTime() - Date.now()) / (24 * 3600 * 1000))
        : null;
    return (_jsx("div", { className: "border border-border rounded-md p-3 bg-card", children: _jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsx(CouponStatusBadge, { s: c.status }), _jsx("h4", { className: "text-sm font-semibold text-text", children: c.title })] }), _jsxs("div", { className: "flex items-center gap-3 text-xs mt-1", children: [c.code && (_jsx("span", { className: "font-mono px-1.5 py-0.5 bg-slate-100 rounded", children: c.code })), c.estimated_value_cents != null && (_jsx("span", { className: "text-inflow font-semibold tabular-nums", children: fmtCents(c.estimated_value_cents) })), c.expires_at && (_jsx("span", { className: `${daysLeft != null && daysLeft <= 14 ? "text-warn font-semibold" : "text-text-muted"}`, children: daysLeft != null && daysLeft >= 0
                                        ? `${daysLeft}d left`
                                        : `Expired ${c.expires_at}` }))] })] }), _jsxs("div", { className: "flex items-center gap-1 shrink-0", children: [c.redemption_url && (_jsx("a", { href: c.redemption_url, target: "_blank", rel: "noopener noreferrer", className: "px-2 py-1 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white", children: "Open \u2192" })), isAvailable && (_jsxs(_Fragment, { children: [_jsx("button", { onClick: () => onPatch({ status: "used" }), className: "px-2 py-1 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy", children: "Used" }), _jsx("button", { onClick: () => onPatch({ status: "dismissed" }), className: "px-2 py-1 text-xs text-text-muted hover:text-outflow", children: "Dismiss" })] })), _jsx("button", { onClick: () => { if (confirm("Delete coupon?"))
                                onDelete(); }, className: "px-2 py-1 text-xs text-text-muted hover:text-outflow", children: "Del" })] })] }) }));
}
function CouponsSection({ coupons, onPatch, onDelete, }) {
    return (_jsxs("div", { className: "mt-4 border border-border rounded-md p-3 bg-orange-50", children: [_jsxs("h3", { className: "text-sm font-semibold text-orange-800 mb-2", children: ["Coupons & offers extracted (", coupons.length, ")"] }), _jsxs("p", { className: "text-[11px] text-orange-800/70 mb-3", children: ["These also surface in ", _jsx("span", { className: "font-semibold", children: "Money on the table" }), " under the \"Receipt coupon\" source kind."] }), _jsx("div", { className: "grid grid-cols-1 gap-2", children: coupons.map((c) => (_jsx(CouponCard, { c: c, onPatch: (p) => onPatch(c.id, p), onDelete: () => onDelete(c.id) }, c.id))) })] }));
}
/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */
export default function ReceiptsPanel() {
    const qc = useQueryClient();
    const [openId, setOpenId] = useState(null);
    const list = useQuery({ queryKey: ["receipts"], queryFn: () => api.listReceipts() });
    const detail = useQuery({
        queryKey: ["receipt", openId],
        queryFn: () => (openId ? api.getReceipt(openId) : null),
        enabled: openId != null,
    });
    const totalSpend = useMemo(() => (list.data ?? []).reduce((s, r) => s + (r.total_cents ?? 0), 0), [list.data]);
    const itemCount = useMemo(() => (list.data ?? []).filter((r) => r.status === "parsed" || r.status === "manual").length, [list.data]);
    return (_jsxs("div", { children: [_jsxs("div", { className: "grid grid-cols-2 md:grid-cols-3 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Receipts logged" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: list.data?.length ?? 0 }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: [itemCount, " parsed successfully"] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Total tracked spend" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: fmtCents(totalSpend) })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Coming next" }), _jsx("div", { className: "text-sm font-semibold mt-1 text-text", children: "Slice C: coupons" }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "Receipt-bottom coupon codes \u2192 Money on the Table" })] })] }), _jsx(UploadCard, { onUploaded: () => qc.invalidateQueries({ queryKey: ["receipts"] }) }), openId && detail.data && (_jsx("div", { className: "mb-5", children: _jsx(ReceiptDetailView, { receipt: detail.data, onClose: () => setOpenId(null) }) })), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card", children: [_jsx("div", { className: "px-4 py-2 border-b border-border bg-slate-50", children: _jsx("h3", { className: "text-sm font-semibold text-text", children: "Receipt history" }) }), _jsxs("div", { className: "p-4 space-y-2", children: [list.isLoading && _jsx("div", { className: "text-center py-4 text-sm text-text-muted", children: "Loading\u2026" }), list.data?.length === 0 && (_jsx("div", { className: "text-center py-8 text-sm text-text-muted", children: "No receipts yet. Upload one above to get started." })), list.data?.map((r) => (_jsx(ReceiptRow, { r: r, onOpen: () => setOpenId(r.id) }, r.id)))] })] }), _jsx("p", { className: "mt-3 text-[11px] text-text-soft", children: "Each receipt becomes line-item-level spending data. Slice B will detect recurring purchase patterns (\"you buy toilet paper every 6 weeks at Costco for $0.83/roll\"), Slice C will harvest coupons from receipt footers into Money on the Table, Slice D will scrape Costco/Walmart/Target for deals on items you actually buy." })] }));
}
