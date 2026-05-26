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
import {
  api,
  fmtCents,
  type UnclaimedRecord,
  type UnclaimedStatus,
} from "./api/client";
import CountUp from "./components/CountUp";
import { SkelHeroRow, SkelLine } from "./components/Skeleton";
import SyncFreshnessChip from "./components/SyncFreshness";
import {
  CelebrationToastStack,
  useCelebrate,
} from "./components/CelebrationToast";
import PanelError from "./components/PanelError";

type TabKey = "found" | "claimed" | "paid" | "archive";

const TAB_DEFS: { key: TabKey; label: string; hint: string }[] = [
  { key: "found",   label: "Found",   hint: "Logged matches you haven't filed yet" },
  { key: "claimed", label: "Filed",   hint: "Claim filed; waiting for payout" },
  { key: "paid",    label: "Paid",    hint: "Money received" },
  { key: "archive", label: "Archive", hint: "Rejected + dismissed" },
];

/** Stale claim threshold (days). Records sitting in "claimed" longer
 *  than this surface a follow-up nudge — most state portals process
 *  in 30-90 days, so anything past 30d is at least worth a status check. */
const STALE_CLAIM_DAYS = 30;

/** Sort options for the active tab. Sort happens client-side over the
 *  partitioned slice — list size is small (rarely > 50). */
type SortKey = "value_desc" | "recent" | "filed_recent" | "state";

const SORT_DEFS: { key: SortKey; label: string }[] = [
  { key: "value_desc",   label: "Highest value" },
  { key: "recent",       label: "Most recent" },
  { key: "filed_recent", label: "Filed most recently" },
  { key: "state",        label: "By state" },
];

/** Days since an ISO timestamp, floored. Returns null if unparseable. */
function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

function partition(rows: UnclaimedRecord[]): Record<TabKey, UnclaimedRecord[]> {
  const out: Record<TabKey, UnclaimedRecord[]> = {
    found: [], claimed: [], paid: [], archive: [],
  };
  for (const r of rows) {
    if (r.status === "paid") out.paid.push(r);
    else if (r.status === "claimed") out.claimed.push(r);
    else if (r.status === "found") out.found.push(r);
    else out.archive.push(r);
  }
  return out;
}

function StatsRow() {
  const stats = useQuery({ queryKey: ["unclaimedStats"], queryFn: api.unclaimedStats });
  // Skeleton on first load — avoids the layout shift when numbers
  // pop in. After data lands, CountUp animates each refetch.
  if (stats.isLoading) return <SkelHeroRow count={4} />;
  const s = stats.data;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
      <StatCard
        label="Pending"
        numericValue={s?.estimated_pending_cents ?? 0}
        format={fmtCents}
        sub={`${s?.found_count ?? 0} found · ${s?.claimed_count ?? 0} filed`}
        tone="warn"
      />
      <StatCard
        label="Collected"
        numericValue={s?.actual_collected_cents ?? 0}
        format={fmtCents}
        sub={`${s?.paid_count ?? 0} paid out`}
        tone="in"
      />
      <StatCard
        label="Total tracked"
        numericValue={s?.total_count ?? 0}
        format={(n) => String(Math.round(n))}
        sub="Across all states"
      />
      <StatCard
        label="Archived"
        numericValue={(s?.rejected_count ?? 0) + (s?.dismissed_count ?? 0)}
        format={(n) => String(Math.round(n))}
        sub="Rejected + dismissed"
      />
    </div>
  );
}

function StatCard({
  label,
  numericValue,
  format,
  sub,
  tone,
}: {
  label: string;
  /** Animated numeric value — CountUp smoothly tweens between renders. */
  numericValue: number;
  /** Formatter for the displayed string (handles cents → "$X.YZ" etc). */
  format: (v: number) => string;
  sub: string;
  tone?: "in" | "warn";
}) {
  const cls = tone === "in" ? "text-inflow" : tone === "warn" ? "text-warn" : "text-text";
  return (
    <div className="bg-card border border-border rounded-md p-4 shadow-card">
      <div className="text-xs text-text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums mt-1 ${cls}`}>
        <CountUp value={numericValue} format={format} />
      </div>
      <div className="text-[11px] text-text-soft mt-0.5">{sub}</div>
    </div>
  );
}

function SearchTipsBox() {
  const [open, setOpen] = useState(false);
  const tips = useQuery({
    queryKey: ["unclaimedSearchTips"],
    queryFn: api.unclaimedSearchTips,
    enabled: open,
  });

  return (
    <div className="bg-card border border-border rounded-md shadow-card mb-5 overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-border hover:bg-hover"
      >
        <span className="text-sm font-semibold text-text">
          Search guide (federal + state portals)
        </span>
        <span className="text-text-muted text-xs">{open ? "Hide" : "Show"}</span>
      </button>
      {open && tips.data && (
        <div className="p-4 space-y-4 text-sm">
          <p className="text-text-muted leading-relaxed">{tips.data.intro}</p>
          <div>
            <h4 className="font-semibold text-text mb-2">Federal resources</h4>
            <ul className="space-y-1.5">
              {tips.data.federal_resources.map((r) => (
                <li key={r.url}>
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline font-semibold">
                    {r.name}
                  </a>
                  <span className="text-text-muted ml-2 text-xs">— {r.what}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-text mb-2">State portals</h4>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              {tips.data.state_resources.map((r) => (
                <a key={r.state} href={r.url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                  <strong>{r.state}</strong> · {r.name}
                </a>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h4 className="font-semibold text-text mb-2">Name variants</h4>
              <ul className="text-xs text-text-muted space-y-0.5 list-disc pl-4">
                {tips.data.name_variants_to_try.map((n) => <li key={n}>{n}</li>)}
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-text mb-2">Addresses to try</h4>
              <ul className="text-xs text-text-muted space-y-0.5 list-disc pl-4">
                {tips.data.addresses_to_try.map((a) => <li key={a}>{a}</li>)}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AddRecordForm({ onAdd }: { onAdd: (payload: any) => void }) {
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
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 text-sm font-semibold rounded bg-brand text-white hover:bg-brand-navy"
      >
        + Log a match
      </button>
    );
  }

  return (
    <form
      className="border border-border rounded-md bg-card p-4 space-y-3 mb-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!form.state || !form.owner_name) return;
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
      }}
    >
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">New match found via search</h4>
        <button type="button" onClick={() => setOpen(false)} className="text-text-muted">×</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <Input label="State *" value={form.state} onChange={(v) => setForm({ ...form, state: v })} placeholder="CA / TX / NY" />
        <Input label="Owner name *" value={form.owner_name} onChange={(v) => setForm({ ...form, owner_name: v })} placeholder="Your full legal name as it appears" />
        <Input label="Holder" value={form.holder_name} onChange={(v) => setForm({ ...form, holder_name: v })} placeholder="Reporting business" />
        <Input label="Property type" value={form.property_type} onChange={(v) => setForm({ ...form, property_type: v })} placeholder="Uncashed check, deposit refund, etc." />
        <Input label="Estimated value ($)" value={form.estimated_value_dollars} onChange={(v) => setForm({ ...form, estimated_value_dollars: v })} placeholder="If portal shows it" type="number" />
        <Input label="Claim URL" value={form.claim_url} onChange={(v) => setForm({ ...form, claim_url: v })} placeholder="https://..." />
      </div>
      <Input label="Notes" value={form.notes} onChange={(v) => setForm({ ...form, notes: v })} />
      <div className="flex items-center gap-2">
        <button type="submit" className="px-3 py-1.5 text-sm font-semibold rounded bg-brand text-white hover:bg-brand-navy">Save</button>
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 text-sm text-text-muted">Cancel</button>
      </div>
    </form>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="text-xs text-text-muted">
      <span className="block mb-1 font-semibold uppercase tracking-wide text-[10px]">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-2 py-1.5 text-sm border border-border rounded focus:outline-none focus:border-brand"
      />
    </label>
  );
}

function RecordCard({
  r,
  onTransition,
  onDelete,
}: {
  r: UnclaimedRecord;
  onTransition: (status: UnclaimedStatus, payout?: number) => void;
  onDelete: () => void;
}) {
  const [paidDraft, setPaidDraft] = useState("");
  // Stale-claim detection — surfaces a warning chip on records that
  // have been "claimed" longer than STALE_CLAIM_DAYS without payment.
  // Most state portals process within 30-90 days, so anything past
  // 30 days is at least worth a status check on the portal.
  const filedDays = r.status === "claimed" ? daysSince(r.claimed_at) : null;
  const isStale = filedDays !== null && filedDays >= STALE_CLAIM_DAYS;

  return (
    <div className="border border-border rounded-md p-4 bg-card hover:shadow-card-hover transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-1.5 py-0.5 rounded-sm bg-emerald-50 text-inflow text-[10px] font-semibold uppercase tracking-wide">
              {r.state}
            </span>
            <h4 className="text-sm font-semibold text-text">{r.owner_name}</h4>
            {r.holder_name && (
              <span className="text-xs text-text-muted">via {r.holder_name}</span>
            )}
            {isStale && (
              <span
                className="px-1.5 py-0.5 rounded-sm bg-amber-100 text-amber-800 text-[10px] font-semibold uppercase tracking-wide"
                title={`Filed ${filedDays}d ago — most portals process within 30-90 days`}
              >
                ⏳ Filed {filedDays}d ago
              </span>
            )}
          </div>
          {r.property_type && (
            <p className="text-xs text-text-muted mt-1">{r.property_type}</p>
          )}
          {r.notes && (
            <p className="text-[11px] text-text-soft mt-1 italic line-clamp-2">{r.notes}</p>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-base font-semibold tabular-nums text-text">
            {r.estimated_value_cents ? fmtCents(r.estimated_value_cents) : "—"}
          </div>
          <div className="text-[11px] text-text-soft">
            Found {new Date(r.discovered_at).toLocaleDateString()}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {r.claim_url && (
          <a href={r.claim_url} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white">
            File claim →
          </a>
        )}
        {r.status === "found" && (
          <>
            <button onClick={() => onTransition("claimed")} className="px-3 py-1.5 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy">
              Mark filed
            </button>
            <button onClick={() => onTransition("dismissed")} className="px-2 py-1.5 text-xs text-text-muted hover:text-outflow">
              Dismiss
            </button>
          </>
        )}
        {r.status === "claimed" && (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const v = parseFloat(paidDraft);
              if (Number.isNaN(v) || v < 0) return;
              onTransition("paid", Math.round(v * 100));
              setPaidDraft("");
            }}
          >
            <span className="text-xs text-text-muted">Paid? $</span>
            <input
              type="number"
              min={0}
              step={0.01}
              value={paidDraft}
              onChange={(e) => setPaidDraft(e.target.value)}
              className="w-24 px-2 py-1 text-xs border border-border rounded"
            />
            <button type="submit" disabled={!paidDraft} className="px-2.5 py-1 text-xs font-semibold rounded bg-inflow text-white disabled:opacity-40">
              Mark paid
            </button>
          </form>
        )}
        {r.status === "paid" && (
          <span className="text-xs text-inflow font-semibold">
            ✓ Received {fmtCents(r.actual_payout_cents ?? 0)}
          </span>
        )}
        <span className="ml-auto">
          <button onClick={() => { if (confirm("Delete?")) onDelete(); }} className="text-xs text-text-muted hover:text-outflow">
            Delete
          </button>
        </span>
      </div>
    </div>
  );
}

/** Tab-specific empty-state copy. Each tab has a different prompt
 *  because "no rejected claims" reads differently than "no matches yet". */
const EMPTY_COPY: Record<TabKey, string> = {
  found:
    "No matches logged yet. Open the search guide above and run MissingMoney.com + your state portals — most adults have $80-200 sitting in unclaimed databases.",
  claimed:
    "No active claims. After you log a match and file with the state, mark it filed and we'll track follow-up timing.",
  paid:
    "No payments received yet. Claims that pay out land here with the actual amount received.",
  archive:
    "Nothing archived. Rejected claims and dismissed matches collect here as a paper trail.",
};

/** Comparator for the chosen sort key. Returned function is stable for
 *  ties so identical rows preserve their list order. */
function makeSortFn(
  key: SortKey,
): (a: UnclaimedRecord, b: UnclaimedRecord) => number {
  switch (key) {
    case "value_desc":
      return (a, b) =>
        (b.estimated_value_cents ?? 0) - (a.estimated_value_cents ?? 0);
    case "recent":
      return (a, b) =>
        new Date(b.discovered_at).getTime() -
        new Date(a.discovered_at).getTime();
    case "filed_recent":
      return (a, b) =>
        new Date(b.claimed_at ?? 0).getTime() -
        new Date(a.claimed_at ?? 0).getTime();
    case "state":
      return (a, b) => a.state.localeCompare(b.state);
  }
}

/** Skeleton grid for the records list — same shape as RecordCard. */
function RecordSkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="border border-border rounded-md p-4 bg-card space-y-3"
        >
          <div className="flex items-center gap-2">
            <SkelLine width="40px" height="h-4" />
            <SkelLine width="55%" height="h-3" />
          </div>
          <SkelLine width="70%" height="h-2" />
          <div className="flex items-center justify-between">
            <SkelLine width="80px" height="h-2" />
            <SkelLine width="60px" height="h-3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function UnclaimedPanel() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("found");
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("value_desc");

  const records = useQuery({ queryKey: ["unclaimed"], queryFn: () => api.listUnclaimed() });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["unclaimed"] });
    qc.invalidateQueries({ queryKey: ["unclaimedStats"] });
    qc.invalidateQueries({ queryKey: ["moneyOnTable"] });
  };
  const create = useMutation({ mutationFn: api.createUnclaimed, onSuccess: invalidate });
  // Sprint 47 — celebration toast on "got paid". Audit gripe was that
  // celebrations only fired on subscription actions; unclaimed-property
  // payouts deserve the same green moment ("Got $X back from <state>!").
  const celebrate = useCelebrate();
  const transition = useMutation({
    mutationFn: ({ id, status, payout }: { id: number; status: UnclaimedStatus; payout?: number }) =>
      api.updateUnclaimedStatus(id, status, payout),
    onSuccess: (_data, variables) => {
      invalidate();
      if (variables.status === "paid" && typeof variables.payout === "number" && variables.payout > 0) {
        const rec = (records.data ?? []).find((r) => r.id === variables.id);
        const sourceLabel = rec ? `${rec.source} (${rec.state})` : "Unclaimed property";
        celebrate.celebrate({
          kind: "custom",
          label: sourceLabel,
          // One-time payout — renders as "$X received".
          oneTimeCents: variables.payout,
          headline: rec
            ? `Got $${(variables.payout / 100).toFixed(0)} back from ${rec.state} — nice.`
            : "Unclaimed property paid out — nice.",
        });
      }
    },
  });
  const destroy = useMutation({ mutationFn: api.deleteUnclaimed, onSuccess: invalidate });

  const grouped = useMemo(() => partition(records.data ?? []), [records.data]);

  /** Distinct states present across ALL records — used for the state
   *  filter chip row. We hide the chip row entirely when there's only
   *  one state since the filter would be redundant. */
  const distinctStates = useMemo(() => {
    const set = new Set<string>();
    for (const r of records.data ?? []) set.add(r.state);
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
    const filtered =
      stateFilter === "all" ? slice : slice.filter((r) => r.state === stateFilter);
    return [...filtered].sort(makeSortFn(sortKey));
  }, [grouped, tab, stateFilter, sortKey]);

  const counts: Record<TabKey, number> = {
    found: grouped.found.length, claimed: grouped.claimed.length,
    paid: grouped.paid.length, archive: grouped.archive.length,
  };

  if (records.isError) {
    return <PanelError title="Couldn't load unclaimed property records." error={records.error} onRetry={() => records.refetch()} />;
  }

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip
          syncedAt={records.dataUpdatedAt > 0 ? new Date(records.dataUpdatedAt).toISOString() : null}
          label="Last fetched"
        />
      </div>
      <StatsRow />
      <SearchTipsBox />
      <AddRecordForm onAdd={(p) => create.mutate(p)} />

      <div className="bg-card border border-border rounded-md shadow-card">
        <div className="flex items-stretch border-b border-border overflow-x-auto">
          {TAB_DEFS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              title={t.hint}
              className={`px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap ${
                tab === t.key ? "text-brand border-b-2 border-brand -mb-px" : "text-text-muted border-b-2 border-transparent hover:text-text"
              }`}
            >
              {t.label}
              <span className={`ml-1.5 inline-block px-1.5 py-0.5 rounded-full text-[10px] tabular-nums ${tab === t.key ? "bg-brand text-white" : "bg-hover text-text-muted"}`}>
                {counts[t.key]}
              </span>
              {/* Stale-claim badge on the Filed tab — surfaces records
                  that have been pending > 30 days without payment. */}
              {t.key === "claimed" && staleClaimCount > 0 && (
                <span
                  className="ml-1 inline-block px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800"
                  title={`${staleClaimCount} claim${staleClaimCount === 1 ? "" : "s"} filed > ${STALE_CLAIM_DAYS}d ago`}
                >
                  ⏳ {staleClaimCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Filter + sort row. State filter only renders when ≥ 2 states
            are tracked — otherwise it's just visual noise. The sort
            dropdown is always present since order matters even with
            one state. */}
        {(distinctStates.length >= 2 || (records.data?.length ?? 0) > 1) && (
          <div className="flex items-center gap-2 flex-wrap px-4 py-2 border-b border-border bg-slate-50/40">
            {distinctStates.length >= 2 && (
              <>
                <span className="text-[10px] uppercase font-semibold tracking-wide text-text-soft">
                  State
                </span>
                <button
                  onClick={() => setStateFilter("all")}
                  className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                    stateFilter === "all"
                      ? "border-brand text-brand-navy bg-brand/5 font-semibold"
                      : "border-border text-text-muted hover:border-text-muted"
                  }`}
                >
                  All
                </button>
                {distinctStates.map((s) => (
                  <button
                    key={s}
                    onClick={() => setStateFilter(s)}
                    className={`px-2 py-0.5 text-xs rounded-full border font-mono uppercase transition-colors ${
                      stateFilter === s
                        ? "border-brand text-brand-navy bg-brand/5 font-semibold"
                        : "border-border text-text-muted hover:border-text-muted"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </>
            )}
            <span className="ml-auto text-[10px] uppercase font-semibold tracking-wide text-text-soft">
              Sort
            </span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="text-xs px-2 py-1 border border-border rounded bg-card text-text focus:outline-none focus:border-brand"
            >
              {SORT_DEFS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="p-4">
          {records.isLoading && <RecordSkeletonGrid />}
          {!records.isLoading && records.data && visible.length === 0 && (
            <>
              {/* Sprint 33 — first-run empty state on the "found" tab
                  gets a richer playbook with clickable portal links
                  and a dollar-tease. Other tabs use a single line. */}
              {tab === "found" && stateFilter === "all" && (
                <div className="px-4 py-6">
                  <div className="flex items-start gap-4 max-w-2xl">
                    <div
                      className="text-3xl leading-none flex-shrink-0"
                      aria-hidden="true"
                    >
                      🪙
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-text">
                        Most adults have $80–200 sitting in state databases
                      </div>
                      <div className="text-xs text-text-muted mt-1 leading-relaxed">
                        Old utility deposits, unclaimed refund checks, dormant
                        bank accounts, forgotten payroll stubs — they all roll
                        into NAUPA / state-treasurer databases after 1–5 years.
                        Searching takes a few minutes per state and recovering
                        is a form-fill + ID verification.
                      </div>
                      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                        <a
                          href="https://www.missingmoney.com"
                          target="_blank"
                          rel="noopener"
                          className="block px-3 py-2 rounded border border-border bg-card hover:border-brand hover:bg-brand-light transition-colors"
                        >
                          <div className="font-semibold text-text">
                            MissingMoney.com →
                          </div>
                          <div className="text-text-soft text-[11px] mt-0.5">
                            44 states + DC, one search.
                          </div>
                        </a>
                        <a
                          href="https://unclaimed.org/"
                          target="_blank"
                          rel="noopener"
                          className="block px-3 py-2 rounded border border-border bg-card hover:border-brand hover:bg-brand-light transition-colors"
                        >
                          <div className="font-semibold text-text">
                            NAUPA directory →
                          </div>
                          <div className="text-text-soft text-[11px] mt-0.5">
                            Per-state portal links.
                          </div>
                        </a>
                        <a
                          href="https://www.irs.gov/refunds"
                          target="_blank"
                          rel="noopener"
                          className="block px-3 py-2 rounded border border-border bg-card hover:border-brand hover:bg-brand-light transition-colors"
                        >
                          <div className="font-semibold text-text">
                            IRS Where's My Refund →
                          </div>
                          <div className="text-text-soft text-[11px] mt-0.5">
                            Stuck federal refunds.
                          </div>
                        </a>
                      </div>
                      <div className="text-[11px] text-text-soft mt-3 italic">
                        Find a hit? Hit the{" "}
                        <span className="font-semibold text-text">
                          + Log a match
                        </span>{" "}
                        button above to log it here, then file with the holding
                        state. We'll track the claim through paid.
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {!(tab === "found" && stateFilter === "all") && (
                <div className="text-center py-8 text-sm text-text-muted max-w-md mx-auto">
                  {stateFilter !== "all" && grouped[tab].length > 0
                    ? `No ${tab} records in ${stateFilter}. Switch to "All" or pick a different state.`
                    : EMPTY_COPY[tab]}
                </div>
              )}
            </>
          )}
          {visible.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {visible.map((r) => (
                <RecordCard
                  key={r.id}
                  r={r}
                  onTransition={(status, payout) => transition.mutate({ id: r.id, status, payout })}
                  onDelete={() => destroy.mutate(r.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {/* Sprint 47 — celebrate the paid transition. */}
      <CelebrationToastStack events={celebrate.events} />
    </div>
  );
}
