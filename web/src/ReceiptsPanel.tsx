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
import {
  api,
  fmtCents,
  type Receipt,
  type ReceiptCoupon,
  type ReceiptCouponStatus,
  type ReceiptDetail,
  type ReceiptItem,
  type ReceiptStatus,
} from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
import DeleteWithConfirm from "./components/DeleteWithConfirm";

/* ------------------------------------------------------------------ */
/*  Status badge                                                        */
/* ------------------------------------------------------------------ */

function StatusBadge({ s }: { s: ReceiptStatus }) {
  const map: Record<ReceiptStatus, { label: string; cls: string }> = {
    pending: { label: "Pending", cls: "bg-slate-100 text-text-muted" },
    parsed: { label: "Parsed", cls: "bg-emerald-50 text-inflow" },
    failed: { label: "Needs attention", cls: "bg-rose-50 text-outflow" },
    manual: { label: "Manual entry", cls: "bg-sky-50 text-sky-700" },
  };
  const m = map[s];
  return (
    <span className={`px-1.5 py-0.5 rounded-sm ${m.cls} text-[10px] font-semibold uppercase tracking-wide`}>
      {m.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Upload card                                                         */
/* ------------------------------------------------------------------ */

function UploadCard({ onUploaded }: { onUploaded: () => void }) {
  const ocr = useQuery({ queryKey: ["ocrStatus"], queryFn: api.ocrStatus });
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showPasteBox, setShowPasteBox] = useState(false);
  const [pasteText, setPasteText] = useState("");

  const upload = useMutation({
    mutationFn: api.uploadReceipt,
    onSuccess: (r) => {
      setWarnings(r.warnings);
      setBusy(false);
      onUploaded();
    },
    onError: (e: Error) => {
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
    onError: (e: Error) => setWarnings([e.message]),
  });

  return (
    <div className="bg-card border border-border rounded-md shadow-card mb-5 p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-text">Add a receipt</h3>
          <p className="text-xs text-text-muted mt-0.5">
            Upload a photo (JPG/PNG/PDF) or paste OCR'd text manually. Each receipt becomes
            line-item-level spending data we can use for budget tracking and deal alerts.
          </p>
        </div>
        {ocr.data && (
          <span
            className={`px-2 py-1 rounded text-[10px] font-semibold uppercase tracking-wide ${
              ocr.data.available
                ? "bg-emerald-50 text-inflow"
                : "bg-amber-50 text-warn"
            }`}
            title={ocr.data.install_hint ?? "Tesseract is installed and ready"}
          >
            OCR {ocr.data.available ? "ready" : "unavailable"}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* File upload */}
        <label
          className={`flex flex-col items-center justify-center px-4 py-8 border-2 border-dashed rounded transition-colors cursor-pointer ${
            ocr.data?.available
              ? "border-border hover:border-brand hover:bg-hover"
              : "border-border bg-slate-50 opacity-50 cursor-not-allowed"
          }`}
        >
          <input
            type="file"
            accept="image/*,application/pdf"
            disabled={!ocr.data?.available || busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setBusy(true);
              setWarnings([]);
              upload.mutate(f);
              e.target.value = "";
            }}
            className="hidden"
          />
          <span className="text-xs font-semibold text-text">
            {busy ? "Uploading + OCRing…" : "Drop a receipt or click to browse"}
          </span>
          <span className="text-[11px] text-text-muted mt-1">
            JPG, PNG, PDF · OCR runs server-side
          </span>
        </label>

        {/* Paste-text fallback */}
        <div className="flex flex-col">
          <button
            onClick={() => setShowPasteBox((v) => !v)}
            className="flex items-center justify-center px-4 py-8 border-2 border-dashed border-border rounded hover:border-brand hover:bg-hover transition-colors"
          >
            <span className="text-xs font-semibold text-text">
              {showPasteBox ? "Hide paste box" : "Paste OCR text instead"}
            </span>
          </button>
        </div>
      </div>

      {showPasteBox && (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (pasteText.trim()) {
              setWarnings([]);
              parse.mutate(pasteText);
            }
          }}
        >
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={8}
            placeholder="Paste your receipt text here..."
            className="w-full px-3 py-2 text-xs border border-border rounded font-mono focus:outline-none focus:border-brand"
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              type="submit"
              disabled={!pasteText.trim() || parse.isPending}
              className="px-3 py-1.5 text-sm font-semibold rounded bg-brand text-white disabled:opacity-50"
            >
              {parse.isPending ? "Parsing…" : "Parse + save"}
            </button>
            <button
              type="button"
              onClick={() => { setShowPasteBox(false); setPasteText(""); }}
              className="px-3 py-1.5 text-sm text-text-muted hover:text-text"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {warnings.length > 0 && (
        <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-[11px] text-warn space-y-1">
          {warnings.map((w, i) => <div key={i}>• {w}</div>)}
        </div>
      )}

      {ocr.data && !ocr.data.available && (
        <div className="mt-3 px-3 py-2 bg-slate-50 rounded text-[11px] text-text-muted">
          {ocr.data.install_hint}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Receipt list row                                                    */
/* ------------------------------------------------------------------ */

function ReceiptRow({ r, onOpen }: { r: Receipt; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="w-full text-left border border-border rounded-md p-3 bg-card hover:shadow-card-hover transition-shadow"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-text truncate">
              {r.merchant || "Unknown merchant"}
            </h4>
            <StatusBadge s={r.status} />
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {r.purchase_date || new Date(r.created_at).toLocaleDateString()}
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums">
            {r.total_cents != null ? fmtCents(r.total_cents) : "—"}
          </div>
        </div>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Detail view (line item table)                                       */
/* ------------------------------------------------------------------ */

function ItemRow({
  item,
  onPatch,
  onDelete,
}: {
  item: ReceiptItem;
  onPatch: (patch: Partial<ReceiptItem>) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ name: string; qty: string; price: string; cat: string }>({
    name: item.name ?? "",
    qty: (item.quantity_units / 1000).toString(),
    price: item.line_total_cents != null ? (item.line_total_cents / 100).toFixed(2) : "",
    cat: item.item_category ?? "",
  });

  if (!editing) {
    return (
      <tr className="border-b border-border last:border-0 hover:bg-hover">
        <td className="px-3 py-2 text-xs text-text-muted">{item.sku || "—"}</td>
        <td className="px-3 py-2 text-sm">{item.name || item.raw_line}</td>
        <td className="px-3 py-2 text-xs text-text-muted">{item.item_category || "—"}</td>
        <td className="px-3 py-2 text-right text-sm tabular-nums">
          {(item.quantity_units / 1000).toFixed(item.quantity_units % 1000 === 0 ? 0 : 2)}
          {item.unit_label && ` ${item.unit_label}`}
        </td>
        <td className="px-3 py-2 text-right text-sm tabular-nums font-semibold">
          {item.line_total_cents != null ? fmtCents(item.line_total_cents) : "—"}
        </td>
        <td className="px-3 py-2 text-right">
          <button onClick={() => setEditing(true)} className="text-xs text-brand hover:underline">Edit</button>
          {/* Sprint 38 — direct delete; parent's HsaPanel-style undo
              toast (or the global confirm-button-with-pending pattern)
              handles confirmation. Native confirm() blocks the browser
              and breaks automated walkthroughs. */}
          <button onClick={onDelete} className="ml-2 text-xs text-text-muted hover:text-outflow">Del</button>
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-b border-border last:border-0 bg-amber-50">
      <td className="px-3 py-2 text-xs text-text-muted">{item.sku || "—"}</td>
      <td className="px-3 py-2"><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-full px-2 py-1 text-sm border border-border rounded" /></td>
      <td className="px-3 py-2"><input value={draft.cat} onChange={(e) => setDraft({ ...draft, cat: e.target.value })} placeholder="grocery, paper, etc" className="w-full px-2 py-1 text-xs border border-border rounded" /></td>
      <td className="px-3 py-2"><input type="number" step={0.001} value={draft.qty} onChange={(e) => setDraft({ ...draft, qty: e.target.value })} className="w-20 px-2 py-1 text-xs border border-border rounded text-right" /></td>
      <td className="px-3 py-2"><input type="number" step={0.01} value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} className="w-24 px-2 py-1 text-xs border border-border rounded text-right" /></td>
      <td className="px-3 py-2 text-right">
        <button
          onClick={() => {
            const qty = parseFloat(draft.qty);
            const priceDollars = parseFloat(draft.price);
            onPatch({
              name: draft.name.trim() || null,
              quantity_units: Number.isNaN(qty) ? 1000 : Math.round(qty * 1000),
              line_total_cents: Number.isNaN(priceDollars) ? null : Math.round(priceDollars * 100),
              item_category: draft.cat.trim() || null,
            });
            setEditing(false);
          }}
          className="text-xs font-semibold text-brand hover:underline"
        >
          Save
        </button>
        <button onClick={() => setEditing(false)} className="ml-2 text-xs text-text-muted">Cancel</button>
      </td>
    </tr>
  );
}

function ReceiptDetailView({
  receipt,
  onClose,
}: {
  receipt: ReceiptDetail;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["receipts"] });
    qc.invalidateQueries({ queryKey: ["receipt", receipt.id] });
    // Coupon changes affect Money on the Table — invalidate that too.
    qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
  };
  const patchHeader = useMutation({
    mutationFn: (p: Partial<Receipt>) => api.patchReceipt(receipt.id, p),
    onSuccess: invalidate,
  });
  const patchItem = useMutation({
    mutationFn: ({ id, p }: { id: number; p: Partial<ReceiptItem> }) => api.patchReceiptItem(id, p),
    onSuccess: invalidate,
  });
  const deleteItem = useMutation({
    mutationFn: api.deleteReceiptItem,
    onSuccess: invalidate,
  });
  // Slice C coupons
  const patchCoupon = useMutation({
    mutationFn: ({ id, p }: { id: number; p: Partial<ReceiptCoupon> }) => api.patchReceiptCoupon(id, p),
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
  // Sprint 49 — vision-OCR re-extract. Stays open after success
  // (unlike reparse, which closes the detail view because reparse
  // creates a NEW row); ocr-vision updates the SAME row, so it's
  // useful to see the new fields land in the modal you already had
  // open.
  const visionOcrCheck = useQuery({
    queryKey: ["visionOcrStatus"],
    queryFn: api.visionOcrStatus,
    staleTime: 60_000,
  });
  const visionOcr = useMutation({
    mutationFn: () => api.visionOcrReceipt(receipt.id),
    onSuccess: invalidate,
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

  return (
    <div className="bg-card border border-border rounded-md shadow-card p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          {editingHeader ? (
            <div className="grid grid-cols-3 gap-2 text-xs">
              <input value={hdr.merchant} onChange={(e) => setHdr({ ...hdr, merchant: e.target.value })} className="px-2 py-1 border border-border rounded" placeholder="Merchant" />
              <input type="date" value={hdr.purchase_date} onChange={(e) => setHdr({ ...hdr, purchase_date: e.target.value })} className="px-2 py-1 border border-border rounded" />
              <input type="number" step={0.01} value={hdr.total} onChange={(e) => setHdr({ ...hdr, total: e.target.value })} className="px-2 py-1 border border-border rounded text-right" placeholder="Total" />
              <button onClick={() => {
                const totalCents = hdr.total ? Math.round(parseFloat(hdr.total) * 100) : null;
                patchHeader.mutate({
                  merchant: hdr.merchant.trim() || null,
                  purchase_date: hdr.purchase_date || null,
                  total_cents: totalCents,
                });
                setEditingHeader(false);
              }} className="px-2 py-1 text-xs font-semibold rounded bg-brand text-white">Save</button>
              <button onClick={() => setEditingHeader(false)} className="px-2 py-1 text-xs text-text-muted">Cancel</button>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold text-text">{receipt.merchant || "Unknown merchant"}</h3>
                <StatusBadge s={receipt.status} />
                <button onClick={() => setEditingHeader(true)} className="text-xs text-brand hover:underline">Edit</button>
              </div>
              <div className="text-xs text-text-muted mt-0.5">
                {receipt.purchase_date || "no date"} ·
                {receipt.subtotal_cents != null && ` Subtotal ${fmtCents(receipt.subtotal_cents)} ·`}
                {receipt.tax_cents != null && ` Tax ${fmtCents(receipt.tax_cents)} ·`}
                {receipt.total_cents != null && ` Total ${fmtCents(receipt.total_cents)}`}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {receipt.image_path && (
            <button onClick={() => reparse.mutate()} disabled={reparse.isPending} className="px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-brand hover:text-brand disabled:opacity-50" title="Re-run OCR + parser on the original image">
              {reparse.isPending ? "Reparsing…" : "Reparse"}
            </button>
          )}
          {/* Sprint 49 — vision-model OCR button. Disabled (with the
              install hint as tooltip) when Ollama isn't running or
              the vision model hasn't been pulled, so the user doesn't
              kick off a request that's going to time out. */}
          {receipt.image_path && (
            <button
              onClick={() => visionOcr.mutate()}
              disabled={
                visionOcr.isPending ||
                !visionOcrCheck.data?.ollama_running ||
                !visionOcrCheck.data?.vision_model_pulled
              }
              className="px-3 py-1.5 text-xs font-semibold rounded border border-purple-400 text-purple-600 hover:border-purple-600 hover:bg-purple-50 disabled:opacity-50"
              title={
                visionOcrCheck.data?.install_hint ??
                `Re-OCR using Ollama vision model (${visionOcrCheck.data?.model_name ?? "vision"}). ` +
                "Slower than Tesseract but reads crumpled / low-contrast receipts much better. " +
                "Replaces the existing line items in place."
              }
            >
              {visionOcr.isPending ? "Vision OCR…" : "✨ AI OCR"}
            </button>
          )}
          {/* Surface the most recent vision-OCR warning inline so the
              user sees "couldn't read this receipt" without having to
              open the dev tools. */}
          {visionOcr.isError && (
            <span
              className="text-[11px] text-outflow max-w-[18ch] truncate"
              title={(visionOcr.error as Error)?.message ?? ""}
            >
              Vision OCR failed
            </span>
          )}
          {visionOcr.data && (visionOcr.data.warnings ?? []).length > 0 && (
            <span
              className="text-[11px] text-warn max-w-[24ch] truncate"
              title={(visionOcr.data.warnings ?? []).join("; ")}
            >
              {(visionOcr.data.warnings ?? [])[0]}
            </span>
          )}
          {/* Sprint 38 — two-click confirm pattern replaces a blocking
              window.confirm(). First click flips the label to
              "Click again to delete" (red) for 4s; second click in
              that window commits. Click elsewhere or wait → reverts. */}
          <DeleteWithConfirm
            label={`Delete receipt from ${receipt.merchant || "this"}?`}
            onConfirm={() => destroy.mutate()}
          />
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-text-muted hover:text-text">Close</button>
        </div>
      </div>

      <div className="overflow-hidden border border-border rounded">
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-3 py-2 text-left">SKU</th>
              <th className="px-3 py-2 text-left">Item</th>
              <th className="px-3 py-2 text-left">Category</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {receipt.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-text-muted">
                  No line items extracted. {receipt.status === "failed" ? "OCR failed — try the Reparse button or paste text manually." : "Edit the receipt to add items."}
                </td>
              </tr>
            )}
            {receipt.items.map((it) => (
              <ItemRow
                key={it.id}
                item={it}
                onPatch={(p) => patchItem.mutate({ id: it.id, p })}
                onDelete={() => deleteItem.mutate(it.id)}
              />
            ))}
          </tbody>
          {receipt.items.length > 0 && (
            <tfoot className="bg-slate-50 border-t border-border">
              <tr className="text-xs">
                <td colSpan={4} className="px-3 py-2 text-right font-semibold">Items sum</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtCents(itemsTotal)}</td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* Coupons section — Slice C */}
      {receipt.coupons.length > 0 && (
        <CouponsSection
          coupons={receipt.coupons}
          onPatch={(id, p) => patchCoupon.mutate({ id, p })}
          onDelete={(id) => deleteCoupon.mutate(id)}
        />
      )}

      {receipt.raw_text && (
        <details className="mt-4">
          <summary className="text-xs text-text-muted cursor-pointer hover:text-text">Show raw OCR text</summary>
          <pre className="mt-2 p-3 bg-slate-50 border border-border rounded text-[11px] font-mono whitespace-pre-wrap overflow-x-auto">
            {receipt.raw_text}
          </pre>
        </details>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Coupons section (Slice C)                                          */
/* ------------------------------------------------------------------ */

function CouponStatusBadge({ s }: { s: ReceiptCouponStatus }) {
  const map: Record<ReceiptCouponStatus, { label: string; cls: string }> = {
    available: { label: "Available", cls: "bg-emerald-50 text-inflow" },
    used: { label: "Used", cls: "bg-slate-100 text-text-muted" },
    expired: { label: "Expired", cls: "bg-rose-50 text-outflow" },
    dismissed: { label: "Dismissed", cls: "bg-slate-100 text-text-soft" },
  };
  const m = map[s];
  return <span className={`px-1.5 py-0.5 rounded-sm ${m.cls} text-[10px] font-semibold uppercase tracking-wide`}>{m.label}</span>;
}

function CouponCard({
  c,
  onPatch,
  onDelete,
}: {
  c: ReceiptCoupon;
  onPatch: (p: Partial<ReceiptCoupon>) => void;
  onDelete: () => void;
}) {
  const isAvailable = c.status === "available";
  const daysLeft = c.expires_at
    ? Math.ceil((new Date(c.expires_at).getTime() - Date.now()) / (24 * 3600 * 1000))
    : null;
  return (
    <div className="border border-border rounded-md p-3 bg-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <CouponStatusBadge s={c.status} />
            <h4 className="text-sm font-semibold text-text">{c.title}</h4>
          </div>
          <div className="flex items-center gap-3 text-xs mt-1">
            {c.code && (
              <span className="font-mono px-1.5 py-0.5 bg-slate-100 rounded">
                {c.code}
              </span>
            )}
            {c.estimated_value_cents != null && (
              <span className="text-inflow font-semibold tabular-nums">{fmtCents(c.estimated_value_cents)}</span>
            )}
            {c.expires_at && (
              <span className={`${daysLeft != null && daysLeft <= 14 ? "text-warn font-semibold" : "text-text-muted"}`}>
                {daysLeft != null && daysLeft >= 0
                  ? `${daysLeft}d left`
                  : `Expired ${c.expires_at}`}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {c.redemption_url && (
            <a href={c.redemption_url} target="_blank" rel="noopener noreferrer" className="px-2 py-1 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white">
              Open →
            </a>
          )}
          {isAvailable && (
            <>
              <button onClick={() => onPatch({ status: "used" })} className="px-2 py-1 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy">
                Used
              </button>
              <button onClick={() => onPatch({ status: "dismissed" })} className="px-2 py-1 text-xs text-text-muted hover:text-outflow">
                Dismiss
              </button>
            </>
          )}
          {/* Sprint 38 — non-blocking delete (parent table handles
              undo if it wishes; the row remains until parent re-renders). */}
          <button onClick={onDelete} className="px-2 py-1 text-xs text-text-muted hover:text-outflow">
            Del
          </button>
        </div>
      </div>
    </div>
  );
}

function CouponsSection({
  coupons,
  onPatch,
  onDelete,
}: {
  coupons: ReceiptCoupon[];
  onPatch: (id: number, p: Partial<ReceiptCoupon>) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <div className="mt-4 border border-border rounded-md p-3 bg-orange-50">
      <h3 className="text-sm font-semibold text-orange-800 mb-2">
        Coupons & offers extracted ({coupons.length})
      </h3>
      <p className="text-[11px] text-orange-800/70 mb-3">
        These also surface in <span className="font-semibold">Money on the table</span> under the "Receipt coupon" source kind.
      </p>
      <div className="grid grid-cols-1 gap-2">
        {coupons.map((c) => (
          <CouponCard
            key={c.id}
            c={c}
            onPatch={(p) => onPatch(c.id, p)}
            onDelete={() => onDelete(c.id)}
          />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */

export default function ReceiptsPanel() {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<number | null>(null);

  const list = useQuery({ queryKey: ["receipts"], queryFn: () => api.listReceipts() });
  const detail = useQuery({
    queryKey: ["receipt", openId],
    queryFn: () => (openId ? api.getReceipt(openId) : null),
    enabled: openId != null,
  });

  const totalSpend = useMemo(
    () => (list.data ?? []).reduce((s, r) => s + (r.total_cents ?? 0), 0),
    [list.data],
  );
  const itemCount = useMemo(
    () => (list.data ?? []).filter((r) => r.status === "parsed" || r.status === "manual").length,
    [list.data],
  );

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip
          syncedAt={list.dataUpdatedAt > 0 ? new Date(list.dataUpdatedAt).toISOString() : null}
          label="Last fetched"
        />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-5">
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Receipts logged</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">{list.data?.length ?? 0}</div>
          <div className="text-[11px] text-text-soft mt-0.5">{itemCount} parsed successfully</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Total tracked spend</div>
          <div className="text-2xl font-semibold tabular-nums mt-1 text-text">{fmtCents(totalSpend)}</div>
        </div>
        <div className="bg-card border border-border rounded-md p-4 shadow-card">
          <div className="text-xs text-text-muted uppercase tracking-wide">Coming next</div>
          <div className="text-sm font-semibold mt-1 text-text">Slice C: coupons</div>
          <div className="text-[11px] text-text-soft mt-0.5">Receipt-bottom coupon codes → Money on the Table</div>
        </div>
      </div>

      <UploadCard onUploaded={() => qc.invalidateQueries({ queryKey: ["receipts"] })} />

      {openId && detail.data && (
        <div className="mb-5">
          <ReceiptDetailView receipt={detail.data} onClose={() => setOpenId(null)} />
        </div>
      )}

      <div className="bg-card border border-border rounded-md shadow-card">
        <div className="px-4 py-2 border-b border-border bg-slate-50">
          <h3 className="text-sm font-semibold text-text">Receipt history</h3>
        </div>
        <div className="p-4 space-y-2">
          {list.isLoading && <div className="text-center py-4 text-sm text-text-muted">Loading…</div>}
          {list.data?.length === 0 && (
            <div className="py-6 px-4">
              <div className="max-w-2xl mx-auto">
                <div className="text-center mb-5">
                  <div className="text-3xl mb-2" aria-hidden="true">🧾</div>
                  <h4 className="text-base font-semibold text-text mb-1">
                    Your first receipt unlocks four other panels
                  </h4>
                  <p className="text-sm text-text-muted leading-relaxed">
                    OCR pulls item-level data; we cross-reference it with your
                    transactions, surface coupons, and detect "you buy this
                    every 6 weeks" patterns.
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="bg-gradient-to-br from-brand/5 to-inflow/5 border border-brand/20 rounded-md p-3">
                    <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1">
                      → Shopping patterns
                    </div>
                    <div className="text-xs text-text-muted">
                      "Costco TP, every 47 days, $0.83/roll" — recurring
                      purchase rhythm + per-unit price baseline.
                    </div>
                  </div>
                  <div className="bg-gradient-to-br from-warn/5 to-inflow/5 border border-warn/20 rounded-md p-3">
                    <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1">
                      → Money on the Table
                    </div>
                    <div className="text-xs text-text-muted">
                      Coupon codes printed at the bottom of receipts get
                      auto-extracted and queued for redemption.
                    </div>
                  </div>
                  <div className="bg-gradient-to-br from-brand/5 to-inflow/5 border border-brand/20 rounded-md p-3">
                    <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1">
                      → HSA receipt bank
                    </div>
                    <div className="text-xs text-text-muted">
                      Medical receipts route here for the decades-deferred
                      reimbursement strategy.
                    </div>
                  </div>
                  <div className="bg-gradient-to-br from-inflow/5 to-brand/5 border border-inflow/20 rounded-md p-3">
                    <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1">
                      → Cross-store deals
                    </div>
                    <div className="text-xs text-text-muted">
                      "Cheerios at Target $4.99, but Walmart had $3.89 last
                      week" — automatic price comparison on items you
                      actually buy.
                    </div>
                  </div>
                </div>
                <div className="mt-5 text-center text-[11px] text-text-soft">
                  Drag-drop or click the upload card above to start.
                </div>
              </div>
            </div>
          )}
          {list.data?.map((r) => (
            <ReceiptRow key={r.id} r={r} onOpen={() => setOpenId(r.id)} />
          ))}
        </div>
      </div>

      <p className="mt-3 text-[11px] text-text-soft">
        Each receipt becomes line-item-level spending data. Slice B will detect recurring purchase patterns
        ("you buy toilet paper every 6 weeks at Costco for $0.83/roll"), Slice C will harvest coupons from
        receipt footers into Money on the Table, Slice D will scrape Costco/Walmart/Target for deals on
        items you actually buy.
      </p>
    </div>
  );
}
