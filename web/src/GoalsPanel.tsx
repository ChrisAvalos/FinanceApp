import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type BeforeAfter,
  type ForecastBreakdown,
  type Goal,
  type GoalContribution,
  type GoalContributionIn,
  type GoalIn,
  type GoalKind,
  type GoalStatus,
  type HistoricalBreakdown,
  type Suggestion,
  type SuggestionBundle,
  type SuggestionKind,
  type SurplusMode,
  type SurplusSnapshot,
} from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
import { UndoToast, useUndoableDelete } from "./components/UndoableDelete";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtDateShort(ymd: string | null): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  // fromIso/toIso are YYYY-MM-DD; parse local to avoid TZ drift
  const [y1, m1, d1] = fromIso.split("-").map(Number);
  const [y2, m2, d2] = toIso.split("-").map(Number);
  const a = new Date(y1, m1 - 1, d1).getTime();
  const b = new Date(y2, m2 - 1, d2).getTime();
  return Math.round((b - a) / 86_400_000);
}

const KIND_LABEL: Record<GoalKind, string> = {
  emergency_fund: "Emergency fund",
  debt_payoff: "Debt payoff",
  specific_savings: "Specific savings",
  general_savings: "General savings",
};

const KIND_BADGE: Record<GoalKind, string> = {
  emergency_fund: "bg-amber-50 text-warn",
  debt_payoff: "bg-red-50 text-outflow",
  specific_savings: "bg-brand-light text-brand-navy",
  general_savings: "bg-gray-100 text-text-muted",
};

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: "Active",
  achieved: "Achieved",
  paused: "Paused",
  archived: "Archived",
};

const SUGGESTION_KIND_LABEL: Record<SuggestionKind, string> = {
  allocate_to_goal: "Allocation",
  cancel_subscription: "Cancellation",
  debt_payoff_avalanche: "Avalanche",
  debt_payoff_snowball: "Snowball",
};

function progressPct(g: Goal): number {
  if (g.target_amount_cents <= 0) return 0;
  return Math.min(100, Math.max(0, (g.current_amount_cents / g.target_amount_cents) * 100));
}

function progressBarColor(g: Goal): string {
  const pct = progressPct(g);
  if (g.status === "achieved") return "bg-inflow";
  if (g.kind === "debt_payoff") {
    // For debt, "more progress" = more principal paid down = good
    if (pct >= 75) return "bg-inflow";
    if (pct >= 25) return "bg-brand";
    return "bg-warn";
  }
  if (pct >= 75) return "bg-inflow";
  if (pct >= 25) return "bg-brand";
  return "bg-text-soft";
}

/* ------------------------------------------------------------------ */
/*  Surplus card with toggle + breakdown                               */
/* ------------------------------------------------------------------ */

function SurplusCard({
  snapshot,
  mode,
  onModeChange,
}: {
  snapshot: SurplusSnapshot | undefined;
  mode: SurplusMode;
  onModeChange: (m: SurplusMode) => void;
}) {
  const [showDetail, setShowDetail] = useState(false);

  const value = useMemo(() => {
    if (!snapshot) return null;
    if (mode === "historical") return snapshot.historical?.surplus_cents ?? null;
    if (mode === "forecast") return snapshot.forecast?.surplus_cents ?? null;
    // "both" = show whichever exists; both endpoint returns both, so prefer historical
    return snapshot.historical?.surplus_cents ?? snapshot.forecast?.surplus_cents ?? null;
  }, [snapshot, mode]);

  const tone =
    value == null
      ? "text-text-soft"
      : value > 0
        ? "text-inflow"
        : value < 0
          ? "text-outflow"
          : "text-text";

  return (
    <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 px-5 py-4 bg-hover border-b border-border">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Monthly surplus
            </div>
            {/* Surplus is computed server-side from a transaction window;
                the chip pins the recency of that computation rather than
                the cache freshness. */}
            <SyncFreshnessChip syncedAt={snapshot?.as_of ?? null} compact />
          </div>
          <p className="text-xs text-text-soft mt-0.5">
            {mode === "historical"
              ? "What you actually had left over the last 30 days."
              : mode === "forecast"
                ? "What you'll likely have left over the next 30 days."
                : "Both views — historical (looking back) and forecast (looking ahead)."}
          </p>
        </div>
        <div className="flex gap-1 bg-bg p-0.5 rounded-md border border-border">
          {(["historical", "forecast", "both"] as const).map((m) => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${
                mode === m
                  ? "bg-brand text-white"
                  : "text-text-muted hover:text-text"
              }`}
            >
              {m === "historical" ? "Last 30d" : m === "forecast" ? "Next 30d" : "Both"}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 py-5">
        {snapshot == null ? (
          <div className="text-text-soft text-sm">Loading…</div>
        ) : (
          <>
            {/* Headline numbers */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(mode === "historical" || mode === "both") && snapshot.historical && (
                <SurplusFigure
                  label="Last 30 days"
                  value={snapshot.historical.surplus_cents}
                  sub={`${snapshot.historical.window_start} → ${snapshot.historical.window_end}`}
                />
              )}
              {(mode === "forecast" || mode === "both") && snapshot.forecast && (
                <SurplusFigure
                  label="Next 30 days"
                  value={snapshot.forecast.surplus_cents}
                  sub={`${snapshot.forecast.window_start} → ${snapshot.forecast.window_end}`}
                />
              )}
              {mode !== "both" && value != null && (
                // Keep at least one big number on screen if mode is single
                <div className={`text-5xl font-bold tabular-nums self-center ${tone} hidden`}>
                  {fmtCents(value)}
                </div>
              )}
            </div>

            {/* Inline notes from server */}
            {snapshot.notes && snapshot.notes.length > 0 && (
              <ul className="mt-3 text-[11px] text-warn space-y-1">
                {snapshot.notes.map((n, i) => (
                  <li key={i}>• {n}</li>
                ))}
              </ul>
            )}

            {/* Breakdown drawer */}
            <button
              onClick={() => setShowDetail((v) => !v)}
              className="mt-4 text-xs font-semibold text-brand hover:text-brand-navy"
            >
              {showDetail ? "Hide breakdown ↑" : "Show breakdown ↓"}
            </button>
            {showDetail && (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                {snapshot.historical && <HistoricalBreakdownCard h={snapshot.historical} />}
                {snapshot.forecast && <ForecastBreakdownCard f={snapshot.forecast} />}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SurplusFigure({
  label,
  value,
  sub,
}: {
  label: string;
  value: number;
  sub: string;
}) {
  const tone = value > 0 ? "text-inflow" : value < 0 ? "text-outflow" : "text-text";
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        {label}
      </div>
      <div className={`text-3xl font-bold tabular-nums ${tone}`}>{fmtCents(value)}</div>
      <div className="text-[11px] text-text-soft mt-0.5">{sub}</div>
    </div>
  );
}

function HistoricalBreakdownCard({ h }: { h: HistoricalBreakdown }) {
  return (
    <div className="rounded-md border border-border p-3 bg-bg">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
        Historical · last 30d
      </div>
      <dl className="mt-2 space-y-1 text-xs">
        <Row label="Inflows" value={fmtCents(h.inflows_cents)} tone="in" />
        <Row label="Outflows" value={fmtCents(-h.outflows_cents)} tone="out" />
        <div className="border-t border-border my-1" />
        <Row
          label="Surplus"
          value={fmtCents(h.surplus_cents)}
          tone={h.surplus_cents >= 0 ? "in" : "out"}
          bold
        />
        <div className="text-[10px] text-text-soft pt-1">
          {h.n_inflow_txns} inflow txns · {h.n_outflow_txns} outflow txns
        </div>
      </dl>
    </div>
  );
}

function ForecastBreakdownCard({ f }: { f: ForecastBreakdown }) {
  return (
    <div className="rounded-md border border-border p-3 bg-bg">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
        Forecast · next 30d
      </div>
      <dl className="mt-2 space-y-1 text-xs">
        <Row label="Projected income" value={fmtCents(f.projected_income_cents)} tone="in" />
        <Row label="Fixed obligations" value={fmtCents(-f.fixed_obligations_cents)} tone="out" />
        <Row label="Variable spend (est.)" value={fmtCents(-f.variable_spend_cents)} tone="out" />
        <div className="border-t border-border my-1" />
        <Row
          label="Surplus"
          value={fmtCents(f.surplus_cents)}
          tone={f.surplus_cents >= 0 ? "in" : "out"}
          bold
        />
        <div className="text-[10px] text-text-soft pt-1">
          {f.n_active_subscriptions} active subs · {f.n_variable_outflow_txns} variable txns sampled
        </div>
      </dl>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  bold,
}: {
  label: string;
  value: string;
  tone?: "in" | "out";
  bold?: boolean;
}) {
  const color =
    tone === "in" ? "text-inflow" : tone === "out" ? "text-outflow" : "text-text";
  return (
    <div className="flex justify-between items-baseline">
      <dt className="text-text-muted">{label}</dt>
      <dd className={`tabular-nums ${color} ${bold ? "font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Goal card with progress + contribute dialog                        */
/* ------------------------------------------------------------------ */

function GoalCard({
  goal,
  onContribute,
  onEdit,
  onDelete,
}: {
  goal: Goal;
  onContribute: (g: Goal) => void;
  onEdit: (g: Goal) => void;
  onDelete: (g: Goal) => void;
}) {
  const pct = progressPct(goal);
  const remaining = Math.max(0, goal.target_amount_cents - goal.current_amount_cents);
  const daysLeft = goal.target_date ? daysBetween(todayIso(), goal.target_date) : null;
  const overdue = daysLeft != null && daysLeft < 0 && goal.status === "active";
  const close = daysLeft != null && daysLeft >= 0 && daysLeft <= 30;

  return (
    <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span
                className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${KIND_BADGE[goal.kind]}`}
              >
                {KIND_LABEL[goal.kind]}
              </span>
              {goal.status !== "active" && (
                <span className="inline-block px-2 py-0.5 bg-gray-100 text-text-muted rounded-full text-[10px] font-semibold uppercase tracking-wide">
                  {STATUS_LABEL[goal.status]}
                </span>
              )}
              {overdue && (
                <span className="inline-block px-2 py-0.5 bg-red-50 text-outflow rounded-full text-[10px] font-semibold uppercase tracking-wide">
                  Overdue
                </span>
              )}
              {!overdue && close && (
                <span className="inline-block px-2 py-0.5 bg-amber-50 text-warn rounded-full text-[10px] font-semibold uppercase tracking-wide">
                  Due in {daysLeft}d
                </span>
              )}
            </div>
            <h4 className="text-sm font-semibold text-text truncate">{goal.name}</h4>
            {goal.notes && (
              <p className="text-[11px] text-text-soft mt-0.5 line-clamp-2">{goal.notes}</p>
            )}
          </div>
          <div className="text-right whitespace-nowrap">
            <div className="text-lg font-bold tabular-nums text-text">
              {fmtCents(goal.current_amount_cents)}
            </div>
            <div className="text-[10px] text-text-soft uppercase tracking-wide">
              of {fmtCents(goal.target_amount_cents)}
            </div>
            {goal.target_date && (
              <div className="text-[10px] text-text-soft mt-0.5">
                by {fmtDateShort(goal.target_date)}
              </div>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3">
          <div className="relative h-2 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${progressBarColor(goal)}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-text-soft mt-1 tabular-nums">
            <span>{pct.toFixed(0)}%</span>
            <span>
              {goal.kind === "debt_payoff" ? "remaining principal" : "remaining"}{" "}
              {fmtCents(remaining)}
            </span>
          </div>
        </div>

        {/* Action row */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="text-[10px] text-text-soft">
            Priority {goal.priority} · created {fmtDateShort(goal.created_at.slice(0, 10))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onContribute(goal)}
              className="px-3 py-1 bg-brand text-white text-xs font-semibold rounded hover:bg-brand-navy"
              disabled={goal.status === "archived"}
            >
              {goal.kind === "debt_payoff" ? "Log payment" : "Log contribution"}
            </button>
            <button
              onClick={() => onEdit(goal)}
              className="px-2 py-1 border border-border text-text-muted text-xs rounded hover:text-text hover:border-brand"
            >
              Edit
            </button>
            <button
              onClick={() => onDelete(goal)}
              className="text-xs text-text-soft hover:text-outflow"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Add/edit goal form                                                 */
/* ------------------------------------------------------------------ */

const KIND_OPTIONS: GoalKind[] = [
  "emergency_fund",
  "debt_payoff",
  "specific_savings",
  "general_savings",
];

function GoalForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: Goal | null;
  onSubmit: (g: GoalIn) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<GoalKind>(initial?.kind ?? "general_savings");
  const [targetDollars, setTargetDollars] = useState<string>(
    initial ? (initial.target_amount_cents / 100).toString() : ""
  );
  const [targetDate, setTargetDate] = useState<string>(initial?.target_date ?? "");
  const [priority, setPriority] = useState<string>(String(initial?.priority ?? 5));
  const [status, setStatus] = useState<GoalStatus>(initial?.status ?? "active");
  const [notes, setNotes] = useState(initial?.notes ?? "");

  const valid = name.trim().length > 0 && Number(targetDollars) > 0;

  return (
    <form
      className="bg-card border border-border rounded-md shadow-card p-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
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
      }}
    >
      <div className="text-sm font-semibold text-text">
        {initial ? "Edit goal" : "New goal"}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
            Name
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Emergency fund — 3 months"
            className="mt-1 w-full px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
            Kind
          </span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as GoalKind)}
            className="mt-1 w-full px-2 py-1 text-sm border border-border rounded bg-card"
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
            Target ($)
          </span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={targetDollars}
            onChange={(e) => setTargetDollars(e.target.value)}
            placeholder="10000"
            className="mt-1 w-full px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
            Target date
          </span>
          <input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            className="mt-1 w-full px-2 py-1 text-sm border border-border rounded"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
            Priority (lower = higher)
          </span>
          <input
            type="number"
            min="1"
            max="99"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="mt-1 w-full px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
            Status
          </span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as GoalStatus)}
            className="mt-1 w-full px-2 py-1 text-sm border border-border rounded bg-card"
          >
            {(Object.keys(STATUS_LABEL) as GoalStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block">
        <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
          Notes
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="mt-1 w-full px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand"
        />
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 border border-border text-text-muted text-xs rounded hover:text-text"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!valid}
          className="px-4 py-1 bg-brand text-white text-xs font-semibold rounded hover:bg-brand-navy disabled:opacity-50"
        >
          {initial ? "Save changes" : "Create goal"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Contribution dialog                                                */
/* ------------------------------------------------------------------ */

function ContributionDialog({
  goal,
  onSubmit,
  onCancel,
}: {
  goal: Goal;
  onSubmit: (payload: GoalContributionIn) => void;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState<string>("");
  const [when, setWhen] = useState<string>(todayIso());
  const [notes, setNotes] = useState<string>("");

  const valid = Number(amount) > 0 && when.length === 10;

  return (
    <div className="bg-card border-2 border-brand rounded-md shadow-card p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold text-text">
          {goal.kind === "debt_payoff" ? "Log a payment" : "Log a contribution"}
        </div>
        <p className="text-[11px] text-text-soft mt-0.5">
          {goal.kind === "debt_payoff"
            ? "Records principal you've already paid down — does NOT initiate any transfer."
            : "Records money you've already moved yourself — this app never moves money for you."}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
            Amount ($)
          </span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="200.00"
            className="mt-1 w-full px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
            Date
          </span>
          <input
            type="date"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="mt-1 w-full px-2 py-1 text-sm border border-border rounded"
          />
        </label>
      </div>
      <label className="block">
        <span className="text-[11px] font-semibold text-text-muted uppercase tracking-wide">
          Notes
        </span>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Transferred from checking"
          className="mt-1 w-full px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand"
        />
      </label>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1 border border-border text-text-muted text-xs rounded hover:text-text"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            if (!valid) return;
            onSubmit({
              amount_cents: Math.round(Number(amount) * 100),
              contributed_at: when,
              source: goal.kind === "debt_payoff" ? "debt_payment" : "manual",
              notes: notes.trim() || null,
            });
          }}
          disabled={!valid}
          className="px-4 py-1 bg-brand text-white text-xs font-semibold rounded hover:bg-brand-navy disabled:opacity-50"
        >
          Record
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Suggestion card with expandable before/after                       */
/* ------------------------------------------------------------------ */

function SuggestionCard({ s }: { s: Suggestion }) {
  const [open, setOpen] = useState(false);
  const savings = s.estimated_savings_cents;
  const savingsTone = savings > 0 ? "text-inflow" : savings < 0 ? "text-outflow" : "text-text";

  return (
    <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left p-4 hover:bg-hover transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="inline-block px-2 py-0.5 bg-brand-light text-brand-navy rounded-full text-[10px] font-semibold uppercase tracking-wide">
                {SUGGESTION_KIND_LABEL[s.kind]}
              </span>
              <span className="text-[10px] text-text-soft">
                conf {(s.confidence * 100).toFixed(0)}%
              </span>
            </div>
            <h4 className="text-sm font-semibold text-text">{s.title}</h4>
            <p className="text-xs text-text-muted mt-1 leading-relaxed">{s.body}</p>
          </div>
          <div className="text-right whitespace-nowrap">
            {savings !== 0 && (
              <>
                <div className={`text-lg font-bold tabular-nums ${savingsTone}`}>
                  {savings > 0 ? "+" : ""}
                  {fmtCents(savings)}
                </div>
                <div className="text-[10px] text-text-soft uppercase tracking-wide">
                  est. impact
                </div>
              </>
            )}
          </div>
        </div>
      </button>
      {open && s.before_after.length > 0 && (
        <div className="border-t border-border bg-hover/40 p-4">
          <div className="text-[10px] font-semibold text-text-muted uppercase tracking-wide mb-2">
            Before / after
          </div>
          <div className="space-y-3">
            {s.before_after.map((ba, i) => (
              <BeforeAfterRow key={i} ba={ba} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BeforeAfterRow({ ba }: { ba: BeforeAfter }) {
  // Months-encoded-as-cents trick: debt strategies stuff month counts in here.
  // Render plainly when the label hints at months; otherwise as currency.
  const isMonths = /month/i.test(ba.label) || /payoff/i.test(ba.label);
  const fmt = (c: number) => (isMonths ? `${c} mo` : fmtCents(c));
  return (
    <div className="rounded border border-border bg-card p-3">
      <div className="text-xs font-semibold text-text mb-2">{ba.label}</div>
      <div className="grid grid-cols-3 gap-3 text-xs">
        <Mini label="Now" tone="neutral" value={fmt(ba.current_cents)} />
        <Mini label="If you act" tone="good" value={fmt(ba.if_act_cents)} />
        <Mini label="If you don't" tone="warn" value={fmt(ba.if_dont_act_cents)} />
      </div>
      <div className="text-[11px] text-text-soft mt-2">{ba.summary}</div>
    </div>
  );
}

function Mini({
  label,
  tone,
  value,
}: {
  label: string;
  tone: "good" | "warn" | "neutral";
  value: string;
}) {
  const border =
    tone === "good"
      ? "border-inflow/40"
      : tone === "warn"
        ? "border-outflow/40"
        : "border-border";
  const head =
    tone === "good"
      ? "text-inflow"
      : tone === "warn"
        ? "text-outflow"
        : "text-text-muted";
  return (
    <div className={`rounded border ${border} bg-bg p-2`}>
      <div className={`text-[10px] font-semibold uppercase tracking-wide ${head}`}>
        {label}
      </div>
      <div className="text-sm tabular-nums font-medium text-text mt-0.5">{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Suggestion section grouping                                        */
/* ------------------------------------------------------------------ */

function SuggestionSection({
  title,
  subtitle,
  items,
  emptyText,
}: {
  title: string;
  subtitle: string;
  items: Suggestion[];
  emptyText: string;
}) {
  return (
    <div>
      <div className="mb-2">
        <h4 className="text-xs font-semibold text-text uppercase tracking-wide">{title}</h4>
        <p className="text-[11px] text-text-soft">{subtitle}</p>
      </div>
      {items.length === 0 ? (
        <div className="bg-card border border-dashed border-border rounded-md p-4 text-center text-text-soft text-xs">
          {emptyText}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((s, i) => (
            <SuggestionCard key={i} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Contributions history (per-goal drawer)                            */
/* ------------------------------------------------------------------ */

function ContributionHistory({ goalId }: { goalId: number }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["goal-contributions", goalId],
    queryFn: () => api.listGoalContributions(goalId),
  });
  const del = useMutation({
    mutationFn: (cid: number) => api.deleteGoalContribution(goalId, cid),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["goal-contributions", goalId] });
      qc.invalidateQueries({ queryKey: ["goals"] });
    },
  });

  if (list.isLoading) {
    return <div className="text-text-soft text-xs p-2">Loading contributions…</div>;
  }
  const rows = list.data ?? [];
  if (rows.length === 0) {
    return (
      <div className="text-text-soft text-xs p-2">
        No contributions yet.
      </div>
    );
  }

  return (
    <div className="bg-bg border border-border rounded-md overflow-hidden">
      <table className="w-full">
        <thead className="bg-hover border-b border-border">
          <tr className="text-text-muted text-[10px] font-semibold uppercase tracking-wide">
            <th className="px-3 py-2 text-left">Date</th>
            <th className="px-3 py-2 text-right">Amount</th>
            <th className="px-3 py-2 text-left">Source</th>
            <th className="px-3 py-2 text-left">Notes</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r: GoalContribution) => (
            <tr key={r.id} className="border-b border-border last:border-0">
              <td className="px-3 py-2 text-xs text-text-muted">
                {fmtDateShort(r.contributed_at)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-xs font-medium">
                {fmtCents(r.amount_cents)}
              </td>
              <td className="px-3 py-2 text-xs text-text-muted">{r.source}</td>
              <td className="px-3 py-2 text-xs text-text-soft truncate max-w-[16rem]">
                {r.notes ?? "—"}
              </td>
              <td className="px-3 py-2 text-right">
                <button
                  onClick={() => del.mutate(r.id)}
                  className="text-[11px] text-text-soft hover:text-outflow"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */

export default function GoalsPanel() {
  const qc = useQueryClient();

  // Toggle is a single source of truth for both surplus and suggestions.
  // Surplus accepts "both"; suggestions are anchored to one mode (the server
  // and our client both coerce "both" → "historical" for the bundle).
  const [surplusMode, setSurplusMode] = useState<SurplusMode>("both");
  const suggestionMode: "historical" | "forecast" =
    surplusMode === "forecast" ? "forecast" : "historical";

  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [contributing, setContributing] = useState<Goal | null>(null);
  const [historyFor, setHistoryFor] = useState<number | null>(null);

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
    mutationFn: ({ id, payload }: { id: number; payload: GoalIn }) =>
      api.updateGoal(id, payload),
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

  // Sprint 32 — non-blocking delete. Replaces three window.confirm()
  // callsites that the audit flagged. Each delete row stages the
  // goal, hides it from the rendered list, and shows a 5s undo toast;
  // deleteMut.mutate fires when the timer expires. Goals with
  // contribution history land in the same flow — the "this also
  // removes contributions" warning is now implicit in the 5-second
  // window: if the user wanted to keep it, they hit Undo.
  const undoDeleteGoal = useUndoableDelete<Goal>({
    commit: (id) => deleteMut.mutate(id as number),
    describe: (g) => `Goal "${g.name}" deleted`,
  });
  const contribMut = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: GoalContributionIn }) =>
      api.contributeToGoal(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["goals"] });
      qc.invalidateQueries({ queryKey: ["goal-contributions"] });
      qc.invalidateQueries({ queryKey: ["suggestions"] });
      setContributing(null);
    },
  });

  // Group goals by status (active first, then achieved, then paused/archived).
  // Sprint 32 — hide any goal currently staged for delete (5s undo
  // window) so the row disappears immediately on click; if the user
  // hits Undo it reappears when undoDeleteGoal.pending clears.
  const groupedGoals = useMemo(() => {
    const stagedId = undoDeleteGoal.pending?.id ?? null;
    const all = (goals.data ?? []).filter((g) => g.id !== stagedId);
    return {
      active: all.filter((g) => g.status === "active"),
      achieved: all.filter((g) => g.status === "achieved"),
      other: all.filter((g) => g.status === "paused" || g.status === "archived"),
    };
  }, [goals.data, undoDeleteGoal.pending]);

  const bundle: SuggestionBundle | undefined = suggestions.data;

  return (
    <div className="space-y-6">
      {/* ---- Surplus card ---- */}
      <SurplusCard
        snapshot={surplus.data}
        mode={surplusMode}
        onModeChange={setSurplusMode}
      />

      {/* ---- Suggestions ---- */}
      <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
        <div className="px-5 py-3 bg-hover border-b border-border flex items-end justify-between">
          <div>
            <h3 className="text-sm font-semibold text-text">Suggestions</h3>
            <p className="text-[11px] text-text-muted mt-0.5">
              Anchored to your{" "}
              <span className="font-semibold">
                {suggestionMode === "forecast" ? "next-30-day forecast" : "last-30-day"}
              </span>{" "}
              surplus of{" "}
              <span className="font-semibold tabular-nums">
                {bundle ? fmtCents(bundle.surplus_cents) : "—"}
              </span>
              . The app never moves money — every recommendation is for you to act on.
            </p>
          </div>
          <button
            onClick={() => {
              qc.invalidateQueries({ queryKey: ["surplus"] });
              qc.invalidateQueries({ queryKey: ["suggestions"] });
            }}
            className="text-xs font-semibold text-brand hover:text-brand-navy"
          >
            Refresh
          </button>
        </div>
        <div className="p-5 space-y-5">
          {suggestions.isLoading && (
            <div className="text-text-soft text-sm">Computing…</div>
          )}
          {bundle && bundle.notes.length > 0 && (
            <ul className="text-[11px] text-warn space-y-1">
              {bundle.notes.map((n, i) => (
                <li key={i}>• {n}</li>
              ))}
            </ul>
          )}
          {bundle && (
            <>
              <SuggestionSection
                title="Allocate surplus"
                subtitle="Greedy fill of your top goals from the surplus above."
                items={bundle.allocations}
                emptyText={
                  bundle.surplus_cents <= 0
                    ? "No surplus to allocate this month."
                    : "No active goals — create one below to see allocation suggestions."
                }
              />
              <SuggestionSection
                title="Cancel or downgrade"
                subtitle="Subscriptions ranked by likelihood of being safely droppable."
                items={bundle.cancellations}
                emptyText="No clear cancellation candidates right now."
              />
              <SuggestionSection
                title="Debt payoff strategy"
                subtitle="Avalanche (highest APR first) and snowball (smallest balance first), with the months-saved math."
                items={bundle.debt_strategies}
                emptyText="No debt-payoff goals yet — add one with a linked credit account to see strategy comparisons."
              />
            </>
          )}
        </div>
      </div>

      {/* ---- Goals list ---- */}
      <div>
        <div className="flex items-end justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-text uppercase tracking-wide">
              Your goals
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              Sorted by priority. Emergency fund &gt; debt payoff &gt; specific savings &gt; general
              savings within each priority tier.
            </p>
          </div>
          <button
            onClick={() => {
              setShowAdd((v) => !v);
              setEditing(null);
            }}
            className="px-3 py-1.5 bg-brand text-white text-xs font-semibold rounded hover:bg-brand-navy"
          >
            {showAdd ? "Close" : "+ New goal"}
          </button>
        </div>

        {showAdd && !editing && (
          <div className="mb-4">
            <GoalForm
              onSubmit={(payload) => createMut.mutate(payload)}
              onCancel={() => setShowAdd(false)}
            />
          </div>
        )}

        {editing && (
          <div className="mb-4">
            <GoalForm
              initial={editing}
              onSubmit={(payload) =>
                updateMut.mutate({ id: editing.id, payload })
              }
              onCancel={() => setEditing(null)}
            />
          </div>
        )}

        {contributing && (
          <div className="mb-4">
            <ContributionDialog
              goal={contributing}
              onSubmit={(payload) =>
                contribMut.mutate({ id: contributing.id, payload })
              }
              onCancel={() => setContributing(null)}
            />
          </div>
        )}

        {goals.isLoading && (
          <div className="text-text-soft text-sm p-4">Loading…</div>
        )}

        {goals.data && goals.data.length === 0 && !showAdd && (
          <div className="bg-gradient-to-r from-brand/8 to-inflow/8 border border-brand/30 rounded-md p-6">
            <div className="flex items-start gap-4">
              <div className="text-3xl">🎯</div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-text">
                  Set your first savings goal
                </h3>
                <p className="text-xs text-text-muted mt-1 max-w-2xl">
                  A goal turns vague intent into a deadline + dollar amount —
                  and unlocks the suggestion engine that allocates your
                  monthly surplus across goals, debt payoff, and
                  high-interest parking.
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                  <span className="px-2 py-0.5 rounded-full bg-card border border-border text-text-muted">Emergency fund · 3–6 months expenses</span>
                  <span className="px-2 py-0.5 rounded-full bg-card border border-border text-text-muted">Down payment · 12–24 months</span>
                  <span className="px-2 py-0.5 rounded-full bg-card border border-border text-text-muted">Car / next big purchase</span>
                  <span className="px-2 py-0.5 rounded-full bg-card border border-border text-text-muted">Annual travel</span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAdd(true)}
                  className="mt-3 px-3 py-1.5 rounded-md text-xs font-semibold bg-brand text-white hover:bg-brand-hover"
                >
                  + New goal
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Active */}
        {groupedGoals.active.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {groupedGoals.active.map((g) => (
              <div key={g.id}>
                <GoalCard
                  goal={g}
                  onContribute={(gg) => {
                    setContributing(gg);
                    setEditing(null);
                  }}
                  onEdit={(gg) => {
                    setEditing(gg);
                    setContributing(null);
                    setShowAdd(false);
                  }}
                  onDelete={(gg) => undoDeleteGoal.stage(gg)}
                />
                <button
                  onClick={() =>
                    setHistoryFor(historyFor === g.id ? null : g.id)
                  }
                  className="mt-1 text-[11px] text-text-soft hover:text-brand"
                >
                  {historyFor === g.id ? "Hide history ↑" : "Show history ↓"}
                </button>
                {historyFor === g.id && (
                  <div className="mt-2">
                    <ContributionHistory goalId={g.id} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Achieved */}
        {groupedGoals.achieved.length > 0 && (
          <div className="mt-6">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
              Achieved
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {groupedGoals.achieved.map((g) => (
                <GoalCard
                  key={g.id}
                  goal={g}
                  onContribute={(gg) => setContributing(gg)}
                  onEdit={(gg) => setEditing(gg)}
                  onDelete={(gg) => undoDeleteGoal.stage(gg)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Paused / archived */}
        {groupedGoals.other.length > 0 && (
          <div className="mt-6">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
              Paused / archived
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {groupedGoals.other.map((g) => (
                <GoalCard
                  key={g.id}
                  goal={g}
                  onContribute={(gg) => setContributing(gg)}
                  onEdit={(gg) => setEditing(gg)}
                  onDelete={(gg) => undoDeleteGoal.stage(gg)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      {undoDeleteGoal.pending && (
        <UndoToast
          message={undoDeleteGoal.message}
          onUndo={undoDeleteGoal.cancel}
        />
      )}
    </div>
  );
}
