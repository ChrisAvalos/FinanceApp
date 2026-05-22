import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type CreditBureau,
  type CreditOpportunity,
  type CreditScore,
  type CreditScoringModel,
  type UtilizationRow,
} from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** FICO cliffs — numbers that actually move a score non-linearly. */
const UTIL_CLIFFS = [1, 10, 30, 50, 75];

function utilCliffColor(pct: number | null): string {
  if (pct == null) return "text-text-soft";
  if (pct >= 75) return "text-outflow";
  if (pct >= 50) return "text-outflow";
  if (pct >= 30) return "text-warn";
  if (pct >= 10) return "text-text";
  if (pct >= 1) return "text-inflow";
  return "text-inflow";
}

function utilBarColor(pct: number | null): string {
  if (pct == null) return "bg-gray-200";
  if (pct >= 50) return "bg-outflow";
  if (pct >= 30) return "bg-warn";
  if (pct >= 10) return "bg-brand";
  return "bg-inflow";
}

function fmtDateShort(ymd: string): string {
  // Parse as a local date to avoid TZ drift (YYYY-MM-DD → Date)
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
  });
}

function scoreBand(score: number): { label: string; color: string } {
  if (score >= 800) return { label: "Exceptional", color: "text-inflow" };
  if (score >= 740) return { label: "Very good", color: "text-inflow" };
  if (score >= 670) return { label: "Good", color: "text-text" };
  if (score >= 580) return { label: "Fair", color: "text-warn" };
  return { label: "Poor", color: "text-outflow" };
}

/* ------------------------------------------------------------------ */
/*  Utilization row w/ cliff-aware visualization                       */
/* ------------------------------------------------------------------ */

function CardUtilRow({ row }: { row: UtilizationRow }) {
  const pct = row.live_utilization_pct ?? 0;
  const widthPct = Math.min(100, pct);
  return (
    <tr className="border-b border-border last:border-0 hover:bg-hover">
      <td className="px-4 py-3">
        <div className="text-sm font-medium">{row.account_name}</div>
        <div className="text-[11px] text-text-soft">
          Limit {fmtCents(row.credit_limit_cents)}
        </div>
      </td>
      <td className="px-4 py-3 w-1/3">
        <div className="relative h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${utilBarColor(pct)}`}
            style={{ width: `${widthPct}%` }}
          />
          {/* Cliff markers overlaid */}
          {UTIL_CLIFFS.map((c) => (
            <div
              key={c}
              className="absolute top-0 h-2 w-px bg-text-muted/40"
              style={{ left: `${c}%` }}
              title={`${c}% cliff`}
            />
          ))}
        </div>
        <div className="flex justify-between text-[11px] text-text-soft mt-1 tabular-nums">
          {/* Liability balances are sign-flipped (negative) at the
             account level so net-worth math is a clean sum. In a
             utilization context, the user wants to see "amount owed"
             as a positive number — abs() it for display. */}
          <span>{fmtCents(Math.abs(row.current_balance_cents))}</span>
          <span>of {fmtCents(row.credit_limit_cents)}</span>
        </div>
      </td>
      <td className={`px-4 py-3 text-right tabular-nums text-sm font-semibold ${utilCliffColor(pct)}`}>
        {pct != null ? `${pct.toFixed(1)}%` : "—"}
      </td>
      <td className="px-4 py-3 text-right text-sm text-text-muted tabular-nums">
        {row.last_statement_balance_cents > 0
          ? fmtCents(row.last_statement_balance_cents)
          : "—"}
      </td>
      <td className="px-4 py-3 text-right text-sm text-text-muted tabular-nums">
        {row.days_until_close != null ? (
          <span
            className={
              row.days_until_close <= 7 ? "text-warn font-semibold" : ""
            }
          >
            {row.days_until_close}d
          </span>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/*  Opportunity card (expandable)                                      */
/* ------------------------------------------------------------------ */

function OpportunityCard({ opp }: { opp: CreditOpportunity }) {
  const [open, setOpen] = useState(false);
  const delta = opp.estimated_score_delta ?? 0;
  const deltaColor =
    delta > 0 ? "text-inflow" : delta < 0 ? "text-outflow" : "text-text-muted";
  const urgent = (opp.urgency_days ?? 99) <= 7;

  return (
    <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left p-4 hover:bg-hover transition-colors"
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 pr-4">
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-block px-2 py-0.5 bg-brand-light text-brand-navy rounded-full text-[10px] font-semibold uppercase tracking-wide">
                {opp.kind.replaceAll("_", " ")}
              </span>
              {urgent && (
                <span className="inline-block px-2 py-0.5 bg-amber-50 text-warn rounded-full text-[10px] font-semibold uppercase tracking-wide">
                  Act in {opp.urgency_days}d
                </span>
              )}
            </div>
            <h4 className="text-sm font-semibold text-text">{opp.title}</h4>
            <p className="text-xs text-text-muted mt-1 leading-relaxed">
              {opp.rationale}
            </p>
          </div>
          <div className="text-right whitespace-nowrap">
            <div className={`text-xl font-bold tabular-nums ${deltaColor}`}>
              {delta > 0 ? `+${delta}` : delta}
            </div>
            <div className="text-[10px] text-text-soft uppercase tracking-wide">
              est. score
            </div>
            <div className="text-[10px] text-text-soft mt-0.5">
              conf {(opp.confidence * 100).toFixed(0)}%
            </div>
          </div>
        </div>
      </button>

      {open && (
        <div className="border-t border-border bg-hover/40 p-4 space-y-4">
          <div>
            <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">
              What to do
            </div>
            <ol className="text-sm text-text space-y-1 list-decimal pl-5">
              {opp.action_steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <StatePanel
              title="Now"
              tone="neutral"
              data={opp.before_state}
            />
            <StatePanel
              title="If you act"
              tone="good"
              data={opp.projected_after_if_acted}
            />
            <StatePanel
              title="If you don't"
              tone="warn"
              data={opp.projected_after_if_not_acted}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function StatePanel({
  title,
  tone,
  data,
}: {
  title: string;
  tone: "good" | "warn" | "neutral";
  data: Record<string, number | string | null>;
}) {
  const border =
    tone === "good" ? "border-inflow/40" : tone === "warn" ? "border-outflow/40" : "border-border";
  const header =
    tone === "good" ? "text-inflow" : tone === "warn" ? "text-outflow" : "text-text-muted";
  return (
    <div className={`rounded-md border ${border} bg-card p-3`}>
      <div className={`text-[10px] font-semibold uppercase tracking-wide ${header}`}>
        {title}
      </div>
      <dl className="mt-2 space-y-1">
        {Object.entries(data).map(([k, v]) => (
          <div key={k} className="flex justify-between">
            <dt className="text-text-muted">{k.replaceAll("_", " ")}</dt>
            <dd className="text-text font-medium tabular-nums">
              {formatStateValue(k, v)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Minimal value formatter — cents-suffixed keys render as $, pcts as %. */
function formatStateValue(key: string, value: number | string | null): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (key.endsWith("_cents")) return fmtCents(value);
  if (key.endsWith("_pct")) return `${value}%`;
  return String(value);
}

/* ------------------------------------------------------------------ */
/*  Add-score form                                                     */
/* ------------------------------------------------------------------ */

const BUREAUS: CreditBureau[] = ["experian", "equifax", "transunion"];
const MODELS: CreditScoringModel[] = [
  "fico8",
  "fico9",
  "fico10",
  "vantagescore3",
  "vantagescore4",
  "other",
];

function AddScoreForm({
  onSubmit,
  initialBureau = "experian",
  initialModel = "fico8",
  initialDetail = "",
}: {
  onSubmit: (s: Parameters<typeof api.addCreditScore>[0]) => void;
  /** When the user clicks "Log from SmartCredit" we remount this form
   *  with bureau=transunion + model=fico8 + detail=SmartCredit prefilled
   *  via the parent rotating `key`. */
  initialBureau?: CreditBureau;
  initialModel?: CreditScoringModel;
  initialDetail?: string;
}) {
  const today = new Date();
  const iso = today.toISOString().slice(0, 10);
  const [score, setScore] = useState<string>("");
  const [bureau, setBureau] = useState<CreditBureau>(initialBureau);
  const [model, setModel] = useState<CreditScoringModel>(initialModel);
  const [asOf, setAsOf] = useState<string>(iso);
  const [detail, setDetail] = useState<string>(initialDetail);

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(score);
        if (!Number.isFinite(n) || n < 300 || n > 900) return;
        onSubmit({
          score: n,
          bureau,
          scoring_model: model,
          as_of: asOf,
          source: "manual",
          source_detail: detail || null,
          notes: null,
        });
        setScore("");
        setDetail("");
      }}
    >
      <input
        type="number"
        min={300}
        max={900}
        value={score}
        onChange={(e) => setScore(e.target.value)}
        placeholder="Score"
        className="w-20 px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand"
      />
      <select
        value={bureau}
        onChange={(e) => setBureau(e.target.value as CreditBureau)}
        className="px-2 py-1 text-sm border border-border rounded bg-card"
      >
        {BUREAUS.map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </select>
      <select
        value={model}
        onChange={(e) => setModel(e.target.value as CreditScoringModel)}
        className="px-2 py-1 text-sm border border-border rounded bg-card"
      >
        {MODELS.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <input
        type="date"
        value={asOf}
        onChange={(e) => setAsOf(e.target.value)}
        className="px-2 py-1 text-sm border border-border rounded"
      />
      <input
        type="text"
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        placeholder="Source (e.g. Chase dashboard)"
        className="flex-1 min-w-[12rem] px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand"
      />
      <button
        type="submit"
        className="px-3 py-1 bg-brand text-white text-xs font-semibold rounded hover:bg-brand-navy"
      >
        Log score
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Tiny sparkline for score history                                   */
/* ------------------------------------------------------------------ */

function ScoreSparkline({ scores }: { scores: CreditScore[] }) {
  // Sort oldest → newest so the line marches forward in time
  const sorted = [...scores].sort(
    (a, b) => a.as_of.localeCompare(b.as_of)
  );
  if (sorted.length < 2) return null;
  const W = 240;
  const H = 48;
  const values = sorted.map((s) => s.score);
  const minV = Math.min(...values) - 10;
  const maxV = Math.max(...values) + 10;
  const span = Math.max(1, maxV - minV);
  const pts = sorted.map((s, i) => {
    const x = (i / (sorted.length - 1)) * (W - 8) + 4;
    const y = H - ((s.score - minV) / span) * (H - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const latestDelta = values[values.length - 1] - values[0];
  const deltaColor = latestDelta >= 0 ? "text-inflow" : "text-outflow";

  return (
    <div className="flex items-center gap-3">
      <svg width={W} height={H}>
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-brand"
          points={pts.join(" ")}
        />
        {sorted.map((_, i) => {
          const [x, y] = pts[i].split(",").map(Number);
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={2}
              className="fill-brand"
            />
          );
        })}
      </svg>
      <div className={`text-xs font-semibold ${deltaColor} tabular-nums`}>
        {latestDelta >= 0 ? `+${latestDelta}` : latestDelta} over {sorted.length}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main panel                                                         */
/* ------------------------------------------------------------------ */

export default function CreditPanel() {
  const qc = useQueryClient();

  // Form-prefill state for the score-entry form below. When the user
  // clicks one of the "Quick log from <portal>" shortcuts on a bureau
  // card, we bump prefillKey to remount AddScoreForm with the right
  // bureau/model/source pre-filled. The user just has to type the
  // number they read from their portal.
  const [prefill, setPrefill] = useState<{
    bureau: CreditBureau;
    model: CreditScoringModel;
    detail: string;
    key: number;
  }>({ bureau: "experian", model: "fico8", detail: "", key: 0 });

  function quickLogFrom(
    bureau: CreditBureau,
    model: CreditScoringModel,
    sourceDetail: string,
  ) {
    setPrefill((prev) => ({
      bureau,
      model,
      detail: sourceDetail,
      key: prev.key + 1,
    }));
    // Scroll the entry form into view so the keyboard is one click away.
    setTimeout(() => {
      document
        .getElementById("credit-score-entry-form")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
  }

  const util = useQuery({
    queryKey: ["creditUtilization"],
    queryFn: api.creditUtilization,
  });
  const opps = useQuery({
    queryKey: ["creditOpportunities"],
    queryFn: api.creditOpportunities,
  });
  const scores = useQuery({
    queryKey: ["creditScores"],
    queryFn: () => api.listCreditScores(50),
  });

  const addScore = useMutation({
    mutationFn: api.addCreditScore,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["creditScores"] }),
  });
  const delScore = useMutation({
    mutationFn: api.deleteCreditScore,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["creditScores"] }),
  });

  const latestByBureau = useMemo(() => {
    const map: Record<string, CreditScore> = {};
    for (const s of scores.data ?? []) {
      const existing = map[s.bureau];
      if (!existing || s.as_of > existing.as_of) {
        map[s.bureau] = s;
      }
    }
    return map;
  }, [scores.data]);

  const aggregatePct = util.data?.aggregate_live_utilization_pct ?? null;

  return (
    <div className="space-y-6">
      {/* ---- Score snapshot per bureau ---- */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {BUREAUS.map((b) => {
          const s = latestByBureau[b];
          const band = s ? scoreBand(s.score) : null;
          return (
            <div
              key={b}
              className="bg-card border border-border rounded-md shadow-card p-5"
            >
              <div className="text-xs text-text-muted uppercase tracking-wide">
                {b}
              </div>
              {s ? (
                <>
                  <div className={`text-4xl font-bold tabular-nums mt-2 ${band!.color}`}>
                    {s.score}
                  </div>
                  <div className="text-xs text-text-muted mt-0.5">
                    {band!.label} · {s.scoring_model}
                  </div>
                  <div className="mt-1">
                    {/* `as_of` is a date string ("2026-04-30"), not an ISO
                        timestamp. The chip's formatter accepts either —
                        Date(yyyy-mm-dd) parses to UTC midnight, which is
                        the semantically right anchor for a daily score. */}
                    <SyncFreshnessChip syncedAt={s.as_of} compact />
                  </div>
                  {s.source_detail && (
                    <div className="text-[11px] text-text-soft mt-1 truncate">
                      {s.source_detail}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="text-4xl font-bold tabular-nums mt-2 text-text-soft">
                    —
                  </div>
                  <div className="text-[11px] text-text-muted mt-1">
                    {b === "experian" && (
                      <>
                        Free at <span className="font-mono">experian.com/freecreditscore</span>.
                      </>
                    )}
                    {b === "equifax" && (
                      <>
                        Free quarterly via{" "}
                        <span className="font-mono">annualcreditreport.com</span>; report
                        only — score isn't included. Wells Fargo / Discover surface an Equifax
                        FICO inside their card portal.
                      </>
                    )}
                    {b === "transunion" && (
                      <>
                        You track this on <span className="font-mono">SmartCredit</span> — daily
                        VantageScore 3.0 for all three bureaus.
                      </>
                    )}
                  </div>
                  {/* Quick-log + open-portal shortcuts. Pre-fill the entry
                      form below with bureau + model + source so you only
                      have to type the number. */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] mt-2">
                    {b === "experian" && (
                      <>
                        <a
                          href="https://www.smartcredit.com/member/credit-report/smart-3b/"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand hover:underline"
                        >
                          Open SmartCredit ↗
                        </a>
                        <button
                          type="button"
                          onClick={() =>
                            quickLogFrom(
                              "experian",
                              "vantagescore3",
                              "SmartCredit · Experian VantageScore 3.0",
                            )
                          }
                          className="text-brand hover:underline"
                        >
                          Quick log from SmartCredit →
                        </button>
                      </>
                    )}
                    {b === "equifax" && (
                      <>
                        <a
                          href="https://www.smartcredit.com/member/credit-report/smart-3b/"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand hover:underline"
                        >
                          Open SmartCredit ↗
                        </a>
                        <button
                          type="button"
                          onClick={() =>
                            quickLogFrom(
                              "equifax",
                              "vantagescore3",
                              "SmartCredit · Equifax VantageScore 3.0",
                            )
                          }
                          className="text-brand hover:underline"
                        >
                          Quick log from SmartCredit →
                        </button>
                      </>
                    )}
                    {b === "transunion" && (
                      <>
                        <a
                          href="https://www.smartcredit.com/member/credit-report/smart-3b/"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand hover:underline"
                        >
                          Open SmartCredit ↗
                        </a>
                        <button
                          type="button"
                          onClick={() =>
                            quickLogFrom(
                              "transunion",
                              "vantagescore3",
                              "SmartCredit · TransUnion VantageScore 3.0",
                            )
                          }
                          className="text-brand hover:underline"
                        >
                          Quick log from SmartCredit →
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* ---- Opportunities ---- */}
      <div>
        <div className="flex items-end justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-text uppercase tracking-wide">
              Opportunities
            </h3>
            <p className="text-xs text-text-muted mt-0.5">
              Specific actions ranked by expected score impact. Every card
              includes before/after math — no money moves unless you do it
              yourself.
            </p>
          </div>
          <button
            onClick={() => {
              qc.invalidateQueries({ queryKey: ["creditOpportunities"] });
              qc.invalidateQueries({ queryKey: ["creditUtilization"] });
            }}
            className="text-xs font-semibold text-brand hover:text-brand-navy"
          >
            Refresh
          </button>
        </div>
        {opps.isLoading && (
          <div className="text-text-muted text-sm p-4">Analyzing…</div>
        )}
        {opps.data && opps.data.opportunities.length === 0 && (
          <div className="bg-card border border-border rounded-md shadow-card p-6 text-center text-text-muted text-sm">
            No opportunities right now. Either your cards are already
            optimized, or there isn't enough data yet — try logging statement
            close days and balances on your cards.
          </div>
        )}
        <div className="space-y-3">
          {opps.data?.opportunities.map((o, i) => (
            <OpportunityCard key={i} opp={o} />
          ))}
        </div>
      </div>

      {/* ---- Utilization table ---- */}
      <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 bg-hover border-b border-border">
          <div>
            <h3 className="text-sm font-semibold text-text">Credit utilization</h3>
            <p className="text-[11px] text-text-muted mt-0.5">
              Live vs. reported. Markers on the bars are the FICO cliffs (1%, 10%, 30%, 50%, 75%).
            </p>
          </div>
          {aggregatePct != null && (
            <div className="text-right">
              <div className="text-[10px] text-text-muted uppercase tracking-wide">
                Aggregate live
              </div>
              <div className={`text-xl font-semibold tabular-nums ${utilCliffColor(aggregatePct)}`}>
                {aggregatePct.toFixed(1)}%
              </div>
            </div>
          )}
        </div>
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left">Card</th>
              <th className="px-4 py-2 text-left">Live balance vs. limit</th>
              <th className="px-4 py-2 text-right">Live util</th>
              <th className="px-4 py-2 text-right">Last reported</th>
              <th className="px-4 py-2 text-right">Close in</th>
            </tr>
          </thead>
          <tbody>
            {util.isLoading && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-text-muted text-sm">
                  Loading…
                </td>
              </tr>
            )}
            {util.data && util.data.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-text-muted text-sm">
                  No credit cards with limits set yet. Add{" "}
                  <code>credit_limit_cents</code> on an account to enable
                  utilization tracking.
                </td>
              </tr>
            )}
            {util.data?.rows.map((r) => (
              <CardUtilRow key={r.account_id} row={r} />
            ))}
          </tbody>
        </table>
      </div>

      {/* ---- Score history + add ---- */}
      <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
        <div className="px-4 py-3 bg-hover border-b border-border">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-text">Score history</h3>
              <p className="text-[11px] text-text-muted mt-0.5">
                Manual entry for now. Automated pull (Chase/Credit Karma via
                Playwright) is coming — this table will merge both sources.
              </p>
            </div>
            {scores.data && scores.data.length >= 2 && (
              <ScoreSparkline scores={scores.data} />
            )}
          </div>
        </div>
        <div id="credit-score-entry-form" className="px-4 py-3 border-b border-border">
          <AddScoreForm
            key={prefill.key}
            initialBureau={prefill.bureau}
            initialModel={prefill.model}
            initialDetail={prefill.detail}
            onSubmit={(payload) => addScore.mutate(payload)}
          />
        </div>
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left">Date</th>
              <th className="px-4 py-2 text-right">Score</th>
              <th className="px-4 py-2 text-left">Bureau</th>
              <th className="px-4 py-2 text-left">Model</th>
              <th className="px-4 py-2 text-left">Source</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {scores.data?.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-text-muted text-sm">
                  No scores logged yet. Add the latest reading you see on
                  Chase, Experian, or Credit Karma above.
                </td>
              </tr>
            )}
            {scores.data?.map((s) => (
              <tr key={s.id} className="border-b border-border last:border-0 hover:bg-hover">
                <td className="px-4 py-3 text-sm text-text-muted whitespace-nowrap">
                  {fmtDateShort(s.as_of)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-sm font-semibold">
                  {s.score}
                </td>
                <td className="px-4 py-3 text-sm">{s.bureau}</td>
                <td className="px-4 py-3 text-sm text-text-muted">{s.scoring_model}</td>
                <td className="px-4 py-3 text-sm text-text-muted">
                  {s.source_detail || s.source}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => delScore.mutate(s.id)}
                    className="text-xs text-text-muted hover:text-outflow"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
