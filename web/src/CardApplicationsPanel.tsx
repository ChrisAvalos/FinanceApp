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
import { api, fmtCents, type CardApplication, type CardApplicationStatus } from "./api/client";
import { SkelLine, SkelStat } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";
import { UndoToast, useUndoableDelete } from "./components/UndoableDelete";
import {
  CelebrationToastStack,
  useCelebrate,
} from "./components/CelebrationToast";
import PanelError from "./components/PanelError";

function StatusBadge({ s }: { s: CardApplicationStatus }) {
  const map: Record<CardApplicationStatus, { label: string; cls: string }> = {
    planning:      { label: "Planning",       cls: "bg-slate-100 text-text-muted" },
    applied:       { label: "Applied",        cls: "bg-amber-50 text-warn" },
    approved:      { label: "Approved",       cls: "bg-emerald-50 text-inflow" },
    denied:        { label: "Denied",         cls: "bg-rose-50 text-outflow" },
    spending:      { label: "Spending",       cls: "bg-sky-50 text-sky-700" },
    bonus_earned:  { label: "Bonus earned",   cls: "bg-emerald-100 text-inflow" },
    bonus_posted:  { label: "Bonus posted",   cls: "bg-emerald-200 text-inflow" },
    closed:        { label: "Closed",         cls: "bg-slate-100 text-text-soft" },
    cancelled:     { label: "Cancelled",      cls: "bg-slate-100 text-text-soft" },
  };
  const m = map[s];
  return <span className={`px-1.5 py-0.5 rounded-sm ${m.cls} text-[10px] font-semibold uppercase tracking-wide`}>{m.label}</span>;
}

function Eligibility() {
  const e = useQuery({ queryKey: ["cardEligibility"], queryFn: api.cardApplicationsEligibility });
  if (e.isLoading) {
    // Match the rendered eligibility card's shape so the page doesn't
    // shift when the 5/24 calculation finishes.
    return (
      <div className="bg-card border border-border rounded-md shadow-card mb-5 p-4 space-y-3">
        <SkelLine width="35%" height="h-3" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <SkelLine width="40%" height="h-3" />
            <SkelLine width="60%" height="h-2" />
            <SkelLine width="50%" height="h-2" />
          </div>
          <div className="space-y-2">
            <SkelLine width="50%" height="h-3" />
            <SkelLine width="80%" height="h-2" />
            <SkelLine width="65%" height="h-2" />
          </div>
        </div>
      </div>
    );
  }
  if (!e.data) return null;
  const c = e.data.chase_5_24;
  return (
    <div className="bg-card border border-border rounded-md shadow-card mb-5 p-4">
      <h3 className="text-sm font-semibold text-text mb-3">Eligibility</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold">Chase 5/24</h4>
            <span className={`px-1.5 py-0.5 rounded-sm text-[10px] font-semibold uppercase tracking-wide ${c.is_under_5_24 ? "bg-emerald-50 text-inflow" : "bg-rose-50 text-outflow"}`}>
              {c.is_under_5_24 ? "Eligible" : "Over 5/24"}
            </span>
          </div>
          <p className="text-xs text-text-muted mt-1">
            {c.cards_opened_in_window}/5 cards in trailing 24mo · window {c.window_start} → {c.window_end}
          </p>
          {c.notes && <p className="text-[11px] text-text-soft italic mt-1">{c.notes}</p>}
        </div>
        <div>
          <h4 className="text-sm font-semibold">Amex once-per-lifetime</h4>
          {e.data.amex_lifetime.length === 0 ? (
            <p className="text-xs text-text-muted mt-1">No Amex history tracked.</p>
          ) : (
            <ul className="text-xs space-y-1 mt-1">
              {e.data.amex_lifetime.map((a) => (
                <li key={a.card_name} className="flex justify-between">
                  <span>{a.card_name}</span>
                  <span className={a.bonus_already_earned ? "text-warn font-semibold" : "text-inflow font-semibold"}>
                    {a.bonus_already_earned ? "Already earned" : "Eligible"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ProgressBar({ cur, max }: { cur: number; max: number | null }) {
  if (!max || max === 0) return null;
  const pct = Math.min(100, (cur / max) * 100);
  return (
    <div className="w-full h-2 bg-hover rounded mt-2 overflow-hidden">
      <div className={`h-full ${pct >= 100 ? "bg-inflow" : "bg-brand"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function ApplicationCard({ a, onTransition, onLogSpend, onDelete }: {
  a: CardApplication;
  onTransition: (s: CardApplicationStatus) => void;
  onLogSpend: (cents: number) => void;
  onDelete: () => void;
}) {
  const [spendDraft, setSpendDraft] = useState("");
  const minSpend = a.minimum_spend_cents ?? 0;
  const daysLeft = a.minimum_spend_deadline
    ? Math.ceil((new Date(a.minimum_spend_deadline).getTime() - Date.now()) / (24 * 3600 * 1000))
    : null;

  return (
    <div className="border border-border rounded-md p-4 bg-card hover:shadow-card-hover">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge s={a.status} />
            <h4 className="text-sm font-semibold text-text">{a.card_name}</h4>
            <span className="text-xs text-text-muted">{a.issuer}</span>
          </div>
          {a.bonus_value_cents && (
            <div className="text-xs text-text-muted mt-1">
              Welcome bonus: <span className="text-inflow font-semibold">{fmtCents(a.bonus_value_cents)}</span>
              {a.bonus_points && ` (${a.bonus_points.toLocaleString()} pts)`}
            </div>
          )}
        </div>
        <div className="text-right">
          {a.annual_fee_cents != null && (
            <div className="text-xs text-text-muted">
              AF {fmtCents(-a.annual_fee_cents)}{a.first_year_fee_waived && " (Y1 waived)"}
            </div>
          )}
        </div>
      </div>

      {minSpend > 0 && (
        <div className="text-xs">
          <div className="flex justify-between">
            <span className="text-text-muted">Min spend progress</span>
            <span className="tabular-nums">{fmtCents(a.spend_to_date_cents)} / {fmtCents(minSpend)}</span>
          </div>
          <ProgressBar cur={a.spend_to_date_cents} max={minSpend} />
          {daysLeft != null && (
            <div className={`mt-1 ${daysLeft <= 14 ? "text-outflow font-semibold" : "text-text-muted"}`}>
              {daysLeft > 0 ? `${daysLeft} days until deadline` : `Deadline passed ${-daysLeft}d ago`}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {a.status === "spending" && (
          <form className="flex items-center gap-1.5" onSubmit={(e) => {
            e.preventDefault();
            const v = parseFloat(spendDraft);
            if (Number.isNaN(v) || v <= 0) return;
            onLogSpend(Math.round(v * 100));
            setSpendDraft("");
          }}>
            <span className="text-xs text-text-muted">+ $</span>
            <input type="number" min={0} step={0.01} value={spendDraft} onChange={(e) => setSpendDraft(e.target.value)} className="w-20 px-2 py-1 text-xs border border-border rounded" />
            <button type="submit" disabled={!spendDraft} className="px-2 py-1 text-xs font-semibold rounded bg-brand text-white disabled:opacity-40">Log</button>
          </form>
        )}
        {a.status === "applied" && <button onClick={() => onTransition("approved")} className="px-2 py-1 text-xs font-semibold rounded bg-brand text-white">Mark approved</button>}
        {a.status === "approved" && <button onClick={() => onTransition("spending")} className="px-2 py-1 text-xs font-semibold rounded bg-brand text-white">Start spending</button>}
        {a.status === "spending" && a.spend_to_date_cents >= (a.minimum_spend_cents ?? 0) && (
          <button onClick={() => onTransition("bonus_earned")} className="px-2 py-1 text-xs font-semibold rounded bg-inflow text-white">Mark bonus earned</button>
        )}
        {a.status === "bonus_earned" && <button onClick={() => onTransition("bonus_posted")} className="px-2 py-1 text-xs font-semibold rounded bg-inflow text-white">Mark bonus posted</button>}
        {/* Sprint 32 — non-blocking delete. Parent stages the row in an
            UndoableDelete and shows a 5s "Undo" toast; the actual
            destroy.mutate fires when the window expires. */}
        <button onClick={onDelete} className="ml-auto text-xs text-text-muted hover:text-outflow">Delete</button>
      </div>
    </div>
  );
}

function NewApplicationForm({ onAdd }: { onAdd: (p: any) => void }) {
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
    return <button onClick={() => setOpen(true)} className="px-4 py-2 text-sm font-semibold rounded bg-brand text-white hover:bg-brand-navy">+ Plan a new app</button>;
  }
  return (
    <form className="border border-border rounded-md bg-card p-4 space-y-3 mb-4" onSubmit={(e) => {
      e.preventDefault();
      if (!form.issuer.trim() || !form.card_name.trim()) return;
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
    }}>
      <div className="flex justify-between"><h4 className="text-sm font-semibold">Plan new card application</h4><button type="button" onClick={() => setOpen(false)} aria-label="Close">×</button></div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <label><span className="block mb-1 font-semibold uppercase text-[10px]">Issuer *</span><input value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} placeholder="Chase, Amex, Capital One" className="w-full px-2 py-1.5 border border-border rounded" /></label>
        <label><span className="block mb-1 font-semibold uppercase text-[10px]">Card name *</span><input value={form.card_name} onChange={(e) => setForm({ ...form, card_name: e.target.value })} placeholder="Sapphire Preferred" className="w-full px-2 py-1.5 border border-border rounded" /></label>
        <label><span className="block mb-1 font-semibold uppercase text-[10px]">Bonus value ($)</span><input type="number" value={form.bonus_value_dollars} onChange={(e) => setForm({ ...form, bonus_value_dollars: e.target.value })} className="w-full px-2 py-1.5 border border-border rounded" /></label>
        <label><span className="block mb-1 font-semibold uppercase text-[10px]">Min spend ($)</span><input type="number" value={form.minimum_spend_dollars} onChange={(e) => setForm({ ...form, minimum_spend_dollars: e.target.value })} className="w-full px-2 py-1.5 border border-border rounded" /></label>
        <label><span className="block mb-1 font-semibold uppercase text-[10px]">Window (days)</span><input type="number" value={form.minimum_spend_window_days} onChange={(e) => setForm({ ...form, minimum_spend_window_days: e.target.value })} className="w-full px-2 py-1.5 border border-border rounded" /></label>
        <label><span className="block mb-1 font-semibold uppercase text-[10px]">Annual fee ($)</span><input type="number" value={form.annual_fee_dollars} onChange={(e) => setForm({ ...form, annual_fee_dollars: e.target.value })} className="w-full px-2 py-1.5 border border-border rounded" /></label>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={form.counts_toward_5_24} onChange={(e) => setForm({ ...form, counts_toward_5_24: e.target.checked })} />
        <span>Counts toward Chase 5/24</span>
      </label>
      <div className="flex gap-2">
        <button type="submit" className="px-3 py-1.5 text-sm font-semibold rounded bg-brand text-white">Save</button>
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 text-sm text-text-muted">Cancel</button>
      </div>
    </form>
  );
}

function BestBonusesShelf({
  onAdd,
}: {
  onAdd: (entry: {
    card_name: string;
    issuer: string;
    bonus_points: number;
    bonus_value_cents: number;
    minimum_spend_cents: number;
    minimum_spend_window_days: number;
    annual_fee_cents: number;
    counts_toward_5_24: boolean;
  }) => void;
}) {
  const bonuses = useQuery({
    queryKey: ["cardApplicationBestBonuses"],
    queryFn: () => api.cardApplicationBestBonuses(),
    staleTime: 60_000,
  });
  if (bonuses.isLoading || !bonuses.data || bonuses.data.length === 0) return null;
  const top = bonuses.data.slice(0, 6);
  return (
    <div className="bg-card border border-border rounded-md shadow-card p-4 mb-5">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-text">Top welcome bonuses right now</h3>
        <span className="text-[11px] text-text-soft">Ranked by $-equivalent. 5/24 status checked against your history.</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {top.map((b) => {
          const ineligibleNote = !b.user_eligible_5_24 ? " · 5/24 over" : "";
          return (
            <div
              key={b.card_name}
              className={`flex items-start gap-3 p-3 rounded border ${b.user_eligible_5_24 ? "border-border" : "border-outflow/30 opacity-60"} hover:bg-hover`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-text truncate">{b.card_name}</div>
                <div className="text-[11px] text-text-muted truncate">
                  {b.issuer}{ineligibleNote} · {b.bonus_points > 0 ? `${b.bonus_points.toLocaleString()} pts ` : ""}≈ ${(b.bonus_dollar_value_cents / 100).toFixed(0)} after ${(b.minimum_spend_cents / 100).toFixed(0)} in {b.minimum_spend_months}mo · ${(b.annual_fee_cents / 100).toFixed(0)} fee
                </div>
                <p className="text-[11px] text-text-soft mt-0.5 line-clamp-2">{b.notes}</p>
              </div>
              <div className="flex flex-col gap-1 shrink-0 items-end">
                <a
                  href={b.product_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-brand hover:underline"
                >
                  Apply →
                </a>
                <button
                  type="button"
                  onClick={() =>
                    onAdd({
                      card_name: b.card_name,
                      issuer: b.issuer,
                      bonus_points: b.bonus_points,
                      bonus_value_cents: b.bonus_dollar_value_cents,
                      minimum_spend_cents: b.minimum_spend_cents,
                      minimum_spend_window_days: b.minimum_spend_months * 30,
                      annual_fee_cents: b.annual_fee_cents,
                      counts_toward_5_24: b.counts_toward_5_24,
                    })
                  }
                  className="text-[11px] text-text-muted hover:text-brand"
                  title="Add this card as a planned application — start tracking minimum-spend progress."
                >
                  + Track
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function CardApplicationsPanel() {
  const qc = useQueryClient();
  const apps = useQuery({ queryKey: ["cardApplications"], queryFn: () => api.listCardApplications() });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["cardApplications"] });
    qc.invalidateQueries({ queryKey: ["cardEligibility"] });
  };
  const create = useMutation({ mutationFn: api.createCardApplication, onSuccess: invalidate });
  // Sprint 47 — celebration toast on bonus_posted. Audit gripe was that
  // celebrations only fired on subscription actions; landing a signup
  // bonus is the biggest single "money in" event the app tracks, so it
  // deserves the same green moment.
  const celebrate = useCelebrate();
  const transition = useMutation({
    mutationFn: ({ id, status }: { id: number; status: CardApplicationStatus }) => api.updateCardApplicationStatus(id, status),
    onSuccess: (_data, variables) => {
      invalidate();
      if (variables.status === "bonus_posted") {
        const app = (apps.data ?? []).find((a) => a.id === variables.id);
        const bonusCents = app?.bonus_value_cents ?? null;
        const niceName = app ? `${app.issuer} ${app.card_name}` : "Signup bonus";
        celebrate.celebrate({
          kind: "custom",
          label: niceName,
          // One-time bonus, not recurring — renders as "$X received".
          oneTimeCents: bonusCents ?? undefined,
          headline: bonusCents && bonusCents > 0
            ? `${niceName} bonus posted — $${(bonusCents / 100).toFixed(0)} in!`
            : `${niceName} bonus posted — nice.`,
        });
      }
    },
  });
  const logSpend = useMutation({
    mutationFn: ({ id, cents }: { id: number; cents: number }) => api.logCardApplicationSpend(id, cents),
    onSuccess: invalidate,
  });
  const destroy = useMutation({ mutationFn: api.deleteCardApplication, onSuccess: invalidate });

  // Sprint 32 — two-stage delete + undo toast. Replaces the inline
  // window.confirm("Delete?") that the audit flagged as a blocking-
  // dialog UX wart. The actual destroy.mutate fires after the 5s
  // undo window expires; clicking Undo cancels the timer.
  const undoDelete = useUndoableDelete<CardApplication>({
    commit: (id) => destroy.mutate(id as number),
    describe: (a) => `Application "${a.card_name}" deleted`,
  });

  if (apps.isError) {
    return <PanelError title="Couldn't load card applications." error={apps.error} onRetry={() => apps.refetch()} />;
  }

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip
          syncedAt={apps.dataUpdatedAt > 0 ? new Date(apps.dataUpdatedAt).toISOString() : null}
          label="Last fetched"
        />
      </div>
      <Eligibility />
      <BestBonusesShelf
        onAdd={(entry) =>
          create.mutate({
            ...entry,
            // Default the new application to "planning" so the user
            // can edit/decline before committing to applying.
            status: "planning",
            spend_to_date_cents: 0,
            first_year_fee_waived: false,
          })
        }
      />
      <NewApplicationForm onAdd={(p) => create.mutate(p)} />
      {apps.isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
          <SkelStat />
          <SkelStat />
          <SkelStat />
          <SkelStat />
        </div>
      )}
      {apps.data?.length === 0 && (
        <div className="bg-card border border-border rounded-md p-6 text-center text-sm text-text-muted max-w-xl mx-auto">
          No card applications tracked yet. Click{" "}
          <span className="font-mono">+ Track</span> on a top-bonus card
          above to plan one, or use the form below to enter one
          manually. The 5/24 + Amex eligibility checks fire as soon as
          your first application is logged.
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {apps.data
          ?.filter((a) => undoDelete.pending?.id !== a.id)
          .map((a) => (
            <ApplicationCard
              key={a.id}
              a={a}
              onTransition={(s) => transition.mutate({ id: a.id, status: s })}
              onLogSpend={(c) => logSpend.mutate({ id: a.id, cents: c })}
              onDelete={() => undoDelete.stage(a)}
            />
          ))}
      </div>
      {undoDelete.pending && (
        <UndoToast message={undoDelete.message} onUndo={undoDelete.cancel} />
      )}
      {/* Sprint 47 — celebrate the bonus_posted transition. */}
      <CelebrationToastStack events={celebrate.events} />
    </div>
  );
}
