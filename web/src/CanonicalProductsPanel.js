import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Canonical products panel — Phase 10 Slice E.
 *
 * Three sections:
 *   1. Stats + "Run canonicalizer" button (idempotent batch process).
 *   2. Search + filterable list of canonical products (one card each).
 *   3. Detail view (slides over) showing every linked ReceiptItem +
 *      RecurringPurchase across every merchant.
 *
 * Plus a "Merge two canonicals" workflow when the user spots over-
 * fragmentation — pick two cards, hit merge, drop_id's links re-point
 * to keep_id, drop is deleted.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
import { SkelStat } from "./components/Skeleton";
/* ------------------------------------------------------------------ */
/*  Card (list view)                                                    */
/* ------------------------------------------------------------------ */
function CanonicalCard({ c, selected, onOpen, onSelect, }) {
    const sizeStr = c.size_value != null && c.size_unit
        ? ` · ${c.size_value} ${c.size_unit}${c.form ? ` (${c.form})` : ""}`
        : c.form ? ` · ${c.form}` : "";
    return (_jsx("div", { className: `border rounded-md p-3 bg-card hover:shadow-card-hover cursor-pointer transition-shadow ${selected ? "border-brand ring-2 ring-brand/30" : "border-border"}`, onClick: onOpen, children: _jsxs("div", { className: "flex items-start justify-between gap-2", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [c.brand && (_jsx("span", { className: "px-1.5 py-0.5 rounded-sm bg-slate-100 text-text-muted text-[10px] font-semibold uppercase tracking-wide", children: c.brand })), _jsx("h4", { className: "text-sm font-semibold text-text", children: c.name }), c.name_locked && _jsx("span", { className: "text-[10px] text-text-soft", children: "(renamed)" })] }), _jsxs("div", { className: "text-xs text-text-muted mt-0.5", children: [c.category || "uncategorized", sizeStr, c.primary_upc && _jsxs("span", { className: "ml-1 font-mono text-text-soft", children: ["UPC ", c.primary_upc] })] }), _jsxs("div", { className: "text-[11px] text-text-soft mt-1", children: [c.receipt_item_count, " item", c.receipt_item_count === 1 ? "" : "s", " \u00B7", c.recurring_pattern_count, " pattern", c.recurring_pattern_count === 1 ? "" : "s", " \u00B7", c.observation_count, " observation", c.observation_count === 1 ? "" : "s", c.merchants.length > 0 && ` · ${c.merchants.slice(0, 3).join(" / ")}${c.merchants.length > 3 ? "…" : ""}`] })] }), _jsx("input", { type: "checkbox", checked: selected, onChange: onSelect, onClick: (e) => e.stopPropagation(), className: "mt-1 shrink-0", title: "Select for merge" })] }) }));
}
/* ------------------------------------------------------------------ */
/*  Detail view                                                         */
/* ------------------------------------------------------------------ */
function DetailView({ detail, onClose, onRename, onDelete, }) {
    const [editing, setEditing] = useState(false);
    const [draftName, setDraftName] = useState(detail.name);
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-5 mb-5", children: [_jsxs("div", { className: "flex items-center justify-between gap-3 mb-3", children: [_jsx("div", { className: "flex-1 min-w-0", children: editing ? (_jsxs("form", { className: "flex items-center gap-2", onSubmit: (e) => {
                                e.preventDefault();
                                if (draftName.trim() && draftName !== detail.name) {
                                    onRename(draftName.trim());
                                }
                                setEditing(false);
                            }, children: [_jsx("input", { autoFocus: true, value: draftName, onChange: (e) => setDraftName(e.target.value), className: "flex-1 px-2 py-1 text-sm border border-border rounded" }), _jsx("button", { type: "submit", className: "text-xs font-semibold text-brand", children: "Save" }), _jsx("button", { type: "button", onClick: () => setEditing(false), className: "text-xs text-text-muted", children: "Cancel" })] })) : (_jsxs("div", { children: [_jsxs("h3", { className: "text-base font-semibold text-text", children: [detail.name, detail.name_locked && _jsx("span", { className: "text-[11px] text-text-soft ml-2", children: "(renamed)" }), _jsx("button", { onClick: () => setEditing(true), className: "ml-2 text-xs text-brand hover:underline", children: "Rename" })] }), _jsxs("div", { className: "text-xs text-text-muted mt-0.5", children: [detail.brand && _jsx("span", { className: "font-semibold", children: detail.brand }), detail.category && ` · ${detail.category}`, detail.size_value != null && detail.size_unit && ` · ${detail.size_value} ${detail.size_unit}`, detail.form && ` · ${detail.form}`] })] })) }), _jsxs("div", { className: "flex items-center gap-2 shrink-0", children: [_jsx("button", { onClick: () => { if (confirm(`Delete "${detail.name}"?`))
                                    onDelete(); }, className: "px-3 py-1.5 text-xs text-text-muted hover:text-outflow", children: "Delete" }), _jsx("button", { onClick: onClose, className: "px-3 py-1.5 text-xs text-text-muted hover:text-text", children: "Close" })] })] }), _jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-xs", children: [_jsxs("div", { children: [_jsx("div", { className: "text-text-muted uppercase tracking-wide", children: "Receipt items" }), _jsx("div", { className: "text-lg font-semibold tabular-nums", children: detail.receipt_item_count })] }), _jsxs("div", { children: [_jsx("div", { className: "text-text-muted uppercase tracking-wide", children: "Patterns" }), _jsx("div", { className: "text-lg font-semibold tabular-nums", children: detail.recurring_pattern_count })] }), _jsxs("div", { children: [_jsx("div", { className: "text-text-muted uppercase tracking-wide", children: "Observations" }), _jsx("div", { className: "text-lg font-semibold tabular-nums", children: detail.observation_count })] }), _jsxs("div", { children: [_jsx("div", { className: "text-text-muted uppercase tracking-wide", children: "Merchants" }), _jsx("div", { className: "text-lg font-semibold tabular-nums", children: detail.merchants.length })] })] }), detail.linked_patterns.length > 0 && (_jsxs("div", { className: "mb-4", children: [_jsx("h4", { className: "text-xs font-semibold text-text-muted uppercase tracking-wide mb-2", children: "Recurring patterns" }), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-2", children: detail.linked_patterns.map((p) => (_jsxs("div", { className: "border border-border rounded p-2 text-xs", children: [_jsx("div", { className: "font-semibold text-text", children: p.canonical_name }), _jsxs("div", { className: "text-text-muted mt-0.5", children: [p.primary_merchant || "—", " \u00B7", p.cadence_days ? ` every ${p.cadence_days}d` : " no cadence", " \u00B7", p.occurrence_count, "x \u00B7", p.typical_line_total_cents != null && ` typical ${fmtCents(p.typical_line_total_cents)}`] })] }, p.id))) })] })), _jsxs("h4", { className: "text-xs font-semibold text-text-muted uppercase tracking-wide mb-2", children: ["Linked receipt items (", detail.linked_items.length, ")"] }), _jsx("div", { className: "overflow-x-auto", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[10px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-3 py-1.5 text-left", children: "Date" }), _jsx("th", { className: "px-3 py-1.5 text-left", children: "Merchant" }), _jsx("th", { className: "px-3 py-1.5 text-left", children: "Item" }), _jsx("th", { className: "px-3 py-1.5 text-right", children: "Total" })] }) }), _jsxs("tbody", { children: [detail.linked_items.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 4, className: "p-4 text-center text-xs text-text-muted", children: "No receipt items linked yet." }) })), detail.linked_items.map((it) => (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-3 py-1.5 text-xs text-text-muted whitespace-nowrap", children: it.purchase_date || "—" }), _jsx("td", { className: "px-3 py-1.5 text-xs", children: it.merchant || "—" }), _jsx("td", { className: "px-3 py-1.5 text-xs", children: it.name || it.raw_line }), _jsx("td", { className: "px-3 py-1.5 text-right text-xs tabular-nums font-semibold", children: it.line_total_cents != null ? fmtCents(it.line_total_cents) : "—" })] }, it.receipt_item_id)))] })] }) })] }));
}
/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */
export default function CanonicalProductsPanel() {
    const qc = useQueryClient();
    const [query, setQuery] = useState("");
    const [openId, setOpenId] = useState(null);
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [lastRun, setLastRun] = useState(null);
    const list = useQuery({
        queryKey: ["canonicalProducts", query],
        queryFn: () => api.listCanonicalProducts(query.trim() ? { q: query.trim() } : {}),
    });
    const detail = useQuery({
        queryKey: ["canonicalProduct", openId],
        queryFn: () => (openId ? api.getCanonicalProduct(openId) : null),
        enabled: openId != null,
    });
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ["canonicalProducts"] });
        qc.invalidateQueries({ queryKey: ["canonicalProduct"] });
    };
    const runCanonicalize = useMutation({
        mutationFn: api.runCanonicalize,
        onSuccess: (r) => {
            invalidate();
            setLastRun(`Linked ${r.items_linked}/${r.items_processed} items, ` +
                `${r.patterns_linked}/${r.patterns_processed} patterns, ` +
                `created ${r.canonicals_created} new canonical product${r.canonicals_created === 1 ? "" : "s"}.`);
        },
    });
    const rename = useMutation({
        mutationFn: ({ id, name }) => api.patchCanonicalProduct(id, { name }),
        onSuccess: invalidate,
    });
    const destroy = useMutation({
        mutationFn: api.deleteCanonicalProduct,
        onSuccess: () => { invalidate(); setOpenId(null); },
    });
    const merge = useMutation({
        mutationFn: ({ keepId, dropId }) => api.mergeCanonicalProducts(keepId, dropId),
        onSuccess: () => {
            invalidate();
            setSelectedIds(new Set());
        },
    });
    const toggleSelect = (id) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    };
    const totalLinked = useMemo(() => (list.data ?? []).reduce((s, c) => s + c.receipt_item_count, 0), [list.data]);
    const selectedArray = Array.from(selectedIds);
    const canMerge = selectedArray.length === 2;
    return (_jsxs("div", { children: [_jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Canonical products" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: list.data?.length ?? 0 })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Receipt items linked" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: totalLinked })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Brands tracked" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: new Set((list.data ?? []).map((c) => c.brand).filter(Boolean)).size })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Coming next" }), _jsx("div", { className: "text-sm font-semibold mt-1 text-text", children: "Cross-store deals" }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "via the Deals panel" })] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-4 p-4 flex items-center gap-3 flex-wrap", children: [_jsx("input", { type: "text", value: query, onChange: (e) => setQuery(e.target.value), placeholder: "Search by name, brand, or normalized key\u2026", className: "flex-1 min-w-[200px] px-3 py-2 border border-border rounded text-sm" }), _jsx("button", { onClick: () => runCanonicalize.mutate(), disabled: runCanonicalize.isPending, className: "px-3 py-2 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy disabled:opacity-50", title: "Walk every unmatched receipt item + recurring pattern, find or create a canonical, persist the link", children: runCanonicalize.isPending ? "Running…" : "Run canonicalizer" }), canMerge && (_jsxs("button", { onClick: () => {
                            const [a, b] = selectedArray;
                            if (confirm("Merge — the second selected canonical will be absorbed into the first. Continue?")) {
                                merge.mutate({ keepId: a, dropId: b });
                            }
                        }, className: "px-3 py-2 text-xs font-semibold rounded border border-warn text-warn hover:bg-warn hover:text-white", title: "Merge the two selected canonicals (first \u2192 keep, second \u2192 drop)", children: ["Merge ", selectedArray.length, " selected"] })), selectedArray.length > 0 && !canMerge && (_jsxs("span", { className: "text-[11px] text-text-soft", children: ["Select 2 to merge (", selectedArray.length, " selected)"] }))] }), lastRun && (_jsx("div", { className: "mb-4 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded text-xs text-inflow", children: lastRun })), openId && detail.data && (_jsx(DetailView, { detail: detail.data, onClose: () => setOpenId(null), onRename: (name) => rename.mutate({ id: detail.data.id, name }), onDelete: () => destroy.mutate(detail.data.id) })), list.isLoading && (_jsxs("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: [_jsx(SkelStat, {}), _jsx(SkelStat, {}), _jsx(SkelStat, {}), _jsx(SkelStat, {})] })), list.data?.length === 0 && (_jsxs("div", { className: "bg-card border border-border rounded-md p-6 text-center text-sm text-text-muted max-w-xl mx-auto", children: ["No canonical products yet. Upload receipts first (Receipts panel), then click ", _jsx("span", { className: "font-mono", children: "Run canonicalizer" }), " \u2014 every receipt item gets matched to a canonical identity automatically. The canonicalizer is conservative; it groups variants of the same product across merchants but won't merge ambiguous matches."] })), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: list.data?.map((c) => (_jsx(CanonicalCard, { c: c, selected: selectedIds.has(c.id), onOpen: () => setOpenId(c.id), onSelect: () => toggleSelect(c.id) }, c.id))) }), _jsx("p", { className: "mt-4 text-[11px] text-text-soft", children: "The canonicalizer is conservative \u2014 it would rather create two redundant canonical products than wrongly merge two different ones. If you spot over-fragmentation, select two cards and hit \"Merge\". The \"merge\" link re-points every receipt item + pattern from the dropped row to the kept one, so historical data stays consistent." })] }));
}
