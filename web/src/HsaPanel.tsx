/**
 * HSA receipt-bank panel — Phase 9.2.
 *
 * The decades-deferred reimbursement strategy: log out-of-pocket
 * medical expenses with receipts now, let the HSA grow tax-free, and
 * reimburse yourself decades later. The 30yr-projection card shows
 * what your saved-receipts pile would compound to at 7%/yr if you
 * left it in HSA-invested form instead.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, type HsaReceipt, type HsaReceiptStatus } from "./api/client";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelTableRow } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";
import { UndoToast, useUndoableDelete } from "./components/UndoableDelete";

function StatusPill({ status }: { status: HsaReceiptStatus }) {
  const map: Record<HsaReceiptStatus, { label: string; cls: string }> = {
    saved: { label: "Saved", cls: "bg-emerald-50 text-inflow" },
    reimbursed: { label: "Reimbursed", cls: "bg-slate-100 text-text-muted" },
    voided: { label: "Voided", cls: "bg-rose-50 text-outflow" },
  };
  const m = map[status];
  return <span className={`px-1.5 py-0.5 rounded-sm ${m.cls} text-[10px] font-semibold uppercase tracking-wide`}>{m.label}</span>;
}

function ReceiptRow({ r, onReimburse, onDelete }: {
  r: HsaReceipt;
  onReimburse: () => void;
  onDelete: () => void;
}) {
  return (
    <tr className="border-b border-border last:border-0 hover:bg-hover">
      <td className="px-4 py-2 text-xs text-text-muted whitespace-nowrap">{new Date(r.expense_date).toLocaleDateString()}</td>
      <td className="px-4 py-2"><StatusPill status={r.status} /></td>
      <td className="px-4 py-2 text-sm">{r.description}</td>
      <td className="px-4 py-2 text-xs text-text-muted">{r.expense_category || "—"}</td>
      <td className="px-4 py-2 text-xs text-text-muted">{r.provider_name || "—"}</td>
      <td className="px-4 py-2 text-right text-sm tabular-nums font-semibold">{fmtCents(r.amount_cents)}</td>
      <td className="px-4 py-2 text-right">
        {r.status === "saved" && (
          <button onClick={onReimburse} className="px-2 py-1 text-[11px] font-semibold rounded bg-brand text-white hover:bg-brand-navy">
            Reimburse
          </button>
        )}
        <button onClick={onDelete} className="px-2 py-1 text-[11px] text-text-muted hover:text-outflow">
          Del
        </button>
      </td>
    </tr>
  );
}

function AddReceiptForm({ onAdd }: { onAdd: (p: any) => void }) {
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
    return (
      <button onClick={() => setOpen(true)} className="px-4 py-2 text-sm font-semibold rounded bg-brand text-white hover:bg-brand-navy">
        + Log receipt
      </button>
    );
  }
  return (
    <form
      className="border border-border rounded-md bg-card p-4 space-y-3 mb-4"
      onSubmit={(e) => {
        e.preventDefault();
        const cents = Math.round(parseFloat(form.amount_dollars) * 100);
        if (!form.description.trim() || Number.isNaN(cents) || cents <= 0) return;
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
      }}
    >
      <div className="flex justify-between"><h4 className="text-sm font-semibold">New HSA receipt</h4><button type="button" onClick={() => setOpen(false)}>×</button></div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <label><span className="block mb-1 font-semibold uppercase text-[10px]">Date</span><input type="date" value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} className="w-full px-2 py-1.5 border border-border rounded" /></label>
        <label><span className="block mb-1 font-semibold uppercase text-[10px]">Amount ($) *</span><input type="number" step={0.01} value={form.amount_dollars} onChange={(e) => setForm({ ...form, amount_dollars: e.target.value })} className="w-full px-2 py-1.5 border border-border rounded" /></label>
        <label><span className="block mb-1 font-semibold uppercase text-[10px]">Provider</span><input value={form.provider_name} onChange={(e) => setForm({ ...form, provider_name: e.target.value })} className="w-full px-2 py-1.5 border border-border rounded" /></label>
        <label className="md:col-span-3"><span className="block mb-1 font-semibold uppercase text-[10px]">Description *</span><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Dr. Smith — annual physical" className="w-full px-2 py-1.5 border border-border rounded" /></label>
        <label><span className="block mb-1 font-semibold uppercase text-[10px]">Category</span><input value={form.expense_category} onChange={(e) => setForm({ ...form, expense_category: e.target.value })} placeholder="dental, vision, rx, etc." className="w-full px-2 py-1.5 border border-border rounded" /></label>
        <label><span className="block mb-1 font-semibold uppercase text-[10px]">Paid via</span><input value={form.payment_method} onChange={(e) => setForm({ ...form, payment_method: e.target.value })} placeholder="Sapphire / Cash / etc." className="w-full px-2 py-1.5 border border-border rounded" /></label>
      </div>
      <div className="flex gap-2">
        <button type="submit" className="px-3 py-1.5 text-sm font-semibold rounded bg-brand text-white">Save</button>
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 text-sm text-text-muted">Cancel</button>
      </div>
    </form>
  );
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
  const reimburse = useMutation({ mutationFn: (id: number) => api.reimburseHsaReceipt(id), onSuccess: invalidate });
  const destroy = useMutation({ mutationFn: api.deleteHsaReceipt, onSuccess: invalidate });

  // Two-stage delete with 5s undo window. Replaces a native window.confirm()
  // dialog that was blocking the browser and breaking automated audits.
  const undoDelete = useUndoableDelete<HsaReceipt>({
    commit: (id) => destroy.mutate(id as number),
    describe: (r) => {
      const desc = r.description ? ` "${r.description.slice(0, 40)}"` : "";
      return `Receipt${desc} deleted`;
    },
  });

  const s = summary.data;
  // The compounding multiple — what each dollar banked today is "worth"
  // in 30 years if it stays in the HSA at 7%/yr. Drives the headline
  // greeting. Falls back to the static math (1.07^30 ≈ 7.6×) when the
  // user hasn't banked anything yet — that's the *promise* of the panel.
  const compoundMultiple = useMemo(() => {
    const banked = s?.saved_total_cents ?? 0;
    const projected = s?.projected_at_30yr_7pct_cents ?? 0;
    if (banked > 0 && projected > 0) {
      return projected / banked;
    }
    return Math.pow(1.07, 30); // ≈ 7.61×
  }, [s]);
  const hasReceipts = (s?.saved_count ?? 0) > 0;

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip
          syncedAt={receipts.dataUpdatedAt > 0 ? new Date(receipts.dataUpdatedAt).toISOString() : null}
          label="Last fetched"
        />
      </div>

      {/* Greeting hero — only when there's data. Reframes the compounding
          insight as a multiple ("each $1 banked today is $7.61 at 30yr")
          which is more visceral than the projection card alone. */}
      {hasReceipts && s && (
        <div className="bg-card border border-border rounded-md shadow-card mb-5 p-5">
          <h2 className="text-2xl font-semibold text-text leading-snug">
            Hi Chris{" "}
            <span aria-hidden="true">👋</span>
            <span className="block mt-1 text-text-muted text-base font-normal">
              You've banked{" "}
              <span className="text-text font-semibold">{fmtCents(s.saved_total_cents)}</span>{" "}
              in receipts — at 7%/yr that's{" "}
              <span className="text-warn font-semibold">{fmtCents(s.projected_at_30yr_7pct_cents)}</span>{" "}
              in 30 years.
            </span>
          </h2>
          <div className="text-[11px] text-text-soft mt-2">
            Each dollar saved here is worth ${compoundMultiple.toFixed(2)} when you reimburse decades later — tax-free.
          </div>
        </div>
      )}

      {/* Hero stats — show skeleton on first load, animate values on
          subsequent refetches via CountUp. The 30-year projection is
          the most rewarding number to watch tick up after each new
          receipt log, so it's worth the animation. */}
      {summary.isLoading ? (
        <SkelHeroRow count={4} />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Saved receipts</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-inflow">
              <CountUp value={s?.saved_total_cents ?? 0} format={fmtCents} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">{s?.saved_count ?? 0} receipts banked</div>
          </div>
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Reimbursed</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
              <CountUp value={s?.reimbursed_total_cents ?? 0} format={fmtCents} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">Lifetime distributions</div>
          </div>
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">Total receipts</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-text">
              <CountUp value={s?.total_receipts ?? 0} format={(n) => String(Math.round(n))} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">{s?.voided_count ?? 0} voided</div>
          </div>
          <div className="bg-card border border-border rounded-md p-4 shadow-card">
            <div className="text-xs text-text-muted uppercase tracking-wide">@ 7%/yr · 30yr</div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-warn">
              <CountUp value={s?.projected_at_30yr_7pct_cents ?? 0} format={fmtCents} />
            </div>
            <div className="text-[11px] text-text-soft mt-0.5">If you keep them banked</div>
          </div>
        </div>
      )}

      {s?.summary_text && (
        <div className="mb-5 px-4 py-3 bg-brand-deep text-white rounded-md text-sm leading-relaxed">{s.summary_text}</div>
      )}

      <AddReceiptForm onAdd={(p) => create.mutate(p)} />

      <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left">Date</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-left">Category</th>
              <th className="px-4 py-2 text-left">Provider</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2 text-right"></th>
            </tr>
          </thead>
          <tbody>
            {receipts.isLoading && Array.from({ length: 4 }).map((_, i) => (
              <SkelTableRow key={i} cols={7} />
            ))}
            {receipts.data?.length === 0 && (
              <tr>
                <td colSpan={7} className="p-8">
                  <div className="max-w-xl mx-auto text-center">
                    <div className="text-3xl mb-2" aria-hidden="true">💊</div>
                    <h4 className="text-base font-semibold text-text mb-1">
                      Bank your first receipt to start the clock
                    </h4>
                    <p className="text-sm text-text-muted mb-4 leading-relaxed">
                      Every out-of-pocket medical expense is a future tax-free
                      reimbursement. At 7%/yr, today's $100 doctor bill becomes
                      <span className="text-text font-semibold"> ${(100 * compoundMultiple).toFixed(0)}</span> in
                      30 years if you keep the receipt and let your HSA
                      compound.
                    </p>
                    <div className="inline-block bg-gradient-to-br from-brand/5 to-warn/5 border border-brand/20 rounded-md px-4 py-3 text-xs text-text-muted">
                      <div className="font-semibold text-text mb-0.5">What you'll need to log a receipt:</div>
                      <div>Date · amount · description (e.g. "Dr. Smith — annual physical")</div>
                    </div>
                  </div>
                </td>
              </tr>
            )}
            {receipts.data
              ?.filter((r) => undoDelete.pending?.id !== r.id)
              .map((r) => (
                <ReceiptRow
                  key={r.id}
                  r={r}
                  onReimburse={() => reimburse.mutate(r.id)}
                  onDelete={() => undoDelete.stage(r)}
                />
              ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] text-text-soft">
        HSA contributions are triple-tax-advantaged. Pay medical bills out of pocket, save the receipts here,
        and reimburse yourself decades later — your HSA balance compounds tax-free in the meantime.
      </p>

      {undoDelete.pending && (
        <UndoToast message={undoDelete.message} onUndo={undoDelete.cancel} />
      )}
    </div>
  );
}
