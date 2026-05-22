import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
/** FICO cliffs — numbers that actually move a score non-linearly. */
const UTIL_CLIFFS = [1, 10, 30, 50, 75];
function utilCliffColor(pct) {
    if (pct == null)
        return "text-text-soft";
    if (pct >= 75)
        return "text-outflow";
    if (pct >= 50)
        return "text-outflow";
    if (pct >= 30)
        return "text-warn";
    if (pct >= 10)
        return "text-text";
    if (pct >= 1)
        return "text-inflow";
    return "text-inflow";
}
function utilBarColor(pct) {
    if (pct == null)
        return "bg-gray-200";
    if (pct >= 50)
        return "bg-outflow";
    if (pct >= 30)
        return "bg-warn";
    if (pct >= 10)
        return "bg-brand";
    return "bg-inflow";
}
function fmtDateShort(ymd) {
    // Parse as a local date to avoid TZ drift (YYYY-MM-DD → Date)
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "2-digit",
    });
}
function scoreBand(score) {
    if (score >= 800)
        return { label: "Exceptional", color: "text-inflow" };
    if (score >= 740)
        return { label: "Very good", color: "text-inflow" };
    if (score >= 670)
        return { label: "Good", color: "text-text" };
    if (score >= 580)
        return { label: "Fair", color: "text-warn" };
    return { label: "Poor", color: "text-outflow" };
}
/* ------------------------------------------------------------------ */
/*  Utilization row w/ cliff-aware visualization                       */
/* ------------------------------------------------------------------ */
function CardUtilRow({ row }) {
    const pct = row.live_utilization_pct ?? 0;
    const widthPct = Math.min(100, pct);
    return (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsxs("td", { className: "px-4 py-3", children: [_jsx("div", { className: "text-sm font-medium", children: row.account_name }), _jsxs("div", { className: "text-[11px] text-text-soft", children: ["Limit ", fmtCents(row.credit_limit_cents)] })] }), _jsxs("td", { className: "px-4 py-3 w-1/3", children: [_jsxs("div", { className: "relative h-2 bg-gray-100 rounded-full overflow-hidden", children: [_jsx("div", { className: `h-full rounded-full transition-all ${utilBarColor(pct)}`, style: { width: `${widthPct}%` } }), UTIL_CLIFFS.map((c) => (_jsx("div", { className: "absolute top-0 h-2 w-px bg-text-muted/40", style: { left: `${c}%` }, title: `${c}% cliff` }, c)))] }), _jsxs("div", { className: "flex justify-between text-[11px] text-text-soft mt-1 tabular-nums", children: [_jsx("span", { children: fmtCents(Math.abs(row.current_balance_cents)) }), _jsxs("span", { children: ["of ", fmtCents(row.credit_limit_cents)] })] })] }), _jsx("td", { className: `px-4 py-3 text-right tabular-nums text-sm font-semibold ${utilCliffColor(pct)}`, children: pct != null ? `${pct.toFixed(1)}%` : "—" }), _jsx("td", { className: "px-4 py-3 text-right text-sm text-text-muted tabular-nums", children: row.last_statement_balance_cents > 0
                    ? fmtCents(row.last_statement_balance_cents)
                    : "—" }), _jsx("td", { className: "px-4 py-3 text-right text-sm text-text-muted tabular-nums", children: row.days_until_close != null ? (_jsxs("span", { className: row.days_until_close <= 7 ? "text-warn font-semibold" : "", children: [row.days_until_close, "d"] })) : ("—") })] }));
}
/* ------------------------------------------------------------------ */
/*  Opportunity card (expandable)                                      */
/* ------------------------------------------------------------------ */
function OpportunityCard({ opp }) {
    const [open, setOpen] = useState(false);
    const delta = opp.estimated_score_delta ?? 0;
    const deltaColor = delta > 0 ? "text-inflow" : delta < 0 ? "text-outflow" : "text-text-muted";
    const urgent = (opp.urgency_days ?? 99) <= 7;
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsx("button", { onClick: () => setOpen((o) => !o), className: "w-full text-left p-4 hover:bg-hover transition-colors", children: _jsxs("div", { className: "flex items-start justify-between", children: [_jsxs("div", { className: "flex-1 pr-4", children: [_jsxs("div", { className: "flex items-center gap-2 mb-1", children: [_jsx("span", { className: "inline-block px-2 py-0.5 bg-brand-light text-brand-navy rounded-full text-[10px] font-semibold uppercase tracking-wide", children: opp.kind.replaceAll("_", " ") }), urgent && (_jsxs("span", { className: "inline-block px-2 py-0.5 bg-amber-50 text-warn rounded-full text-[10px] font-semibold uppercase tracking-wide", children: ["Act in ", opp.urgency_days, "d"] }))] }), _jsx("h4", { className: "text-sm font-semibold text-text", children: opp.title }), _jsx("p", { className: "text-xs text-text-muted mt-1 leading-relaxed", children: opp.rationale })] }), _jsxs("div", { className: "text-right whitespace-nowrap", children: [_jsx("div", { className: `text-xl font-bold tabular-nums ${deltaColor}`, children: delta > 0 ? `+${delta}` : delta }), _jsx("div", { className: "text-[10px] text-text-soft uppercase tracking-wide", children: "est. score" }), _jsxs("div", { className: "text-[10px] text-text-soft mt-0.5", children: ["conf ", (opp.confidence * 100).toFixed(0), "%"] })] })] }) }), open && (_jsxs("div", { className: "border-t border-border bg-hover/40 p-4 space-y-4", children: [_jsxs("div", { children: [_jsx("div", { className: "text-xs font-semibold text-text-muted uppercase tracking-wide mb-2", children: "What to do" }), _jsx("ol", { className: "text-sm text-text space-y-1 list-decimal pl-5", children: opp.action_steps.map((step, i) => (_jsx("li", { children: step }, i))) })] }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-3 text-xs", children: [_jsx(StatePanel, { title: "Now", tone: "neutral", data: opp.before_state }), _jsx(StatePanel, { title: "If you act", tone: "good", data: opp.projected_after_if_acted }), _jsx(StatePanel, { title: "If you don't", tone: "warn", data: opp.projected_after_if_not_acted })] })] }))] }));
}
function StatePanel({ title, tone, data, }) {
    const border = tone === "good" ? "border-inflow/40" : tone === "warn" ? "border-outflow/40" : "border-border";
    const header = tone === "good" ? "text-inflow" : tone === "warn" ? "text-outflow" : "text-text-muted";
    return (_jsxs("div", { className: `rounded-md border ${border} bg-card p-3`, children: [_jsx("div", { className: `text-[10px] font-semibold uppercase tracking-wide ${header}`, children: title }), _jsx("dl", { className: "mt-2 space-y-1", children: Object.entries(data).map(([k, v]) => (_jsxs("div", { className: "flex justify-between", children: [_jsx("dt", { className: "text-text-muted", children: k.replaceAll("_", " ") }), _jsx("dd", { className: "text-text font-medium tabular-nums", children: formatStateValue(k, v) })] }, k))) })] }));
}
/** Minimal value formatter — cents-suffixed keys render as $, pcts as %. */
function formatStateValue(key, value) {
    if (value == null)
        return "—";
    if (typeof value === "string")
        return value;
    if (key.endsWith("_cents"))
        return fmtCents(value);
    if (key.endsWith("_pct"))
        return `${value}%`;
    return String(value);
}
/* ------------------------------------------------------------------ */
/*  Add-score form                                                     */
/* ------------------------------------------------------------------ */
const BUREAUS = ["experian", "equifax", "transunion"];
const MODELS = [
    "fico8",
    "fico9",
    "fico10",
    "vantagescore3",
    "vantagescore4",
    "other",
];
function AddScoreForm({ onSubmit, initialBureau = "experian", initialModel = "fico8", initialDetail = "", }) {
    const today = new Date();
    const iso = today.toISOString().slice(0, 10);
    const [score, setScore] = useState("");
    const [bureau, setBureau] = useState(initialBureau);
    const [model, setModel] = useState(initialModel);
    const [asOf, setAsOf] = useState(iso);
    const [detail, setDetail] = useState(initialDetail);
    return (_jsxs("form", { className: "flex flex-wrap items-center gap-2", onSubmit: (e) => {
            e.preventDefault();
            const n = Number(score);
            if (!Number.isFinite(n) || n < 300 || n > 900)
                return;
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
        }, children: [_jsx("input", { type: "number", min: 300, max: 900, value: score, onChange: (e) => setScore(e.target.value), placeholder: "Score", className: "w-20 px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand" }), _jsx("select", { value: bureau, onChange: (e) => setBureau(e.target.value), className: "px-2 py-1 text-sm border border-border rounded bg-card", children: BUREAUS.map((b) => (_jsx("option", { value: b, children: b }, b))) }), _jsx("select", { value: model, onChange: (e) => setModel(e.target.value), className: "px-2 py-1 text-sm border border-border rounded bg-card", children: MODELS.map((m) => (_jsx("option", { value: m, children: m }, m))) }), _jsx("input", { type: "date", value: asOf, onChange: (e) => setAsOf(e.target.value), className: "px-2 py-1 text-sm border border-border rounded" }), _jsx("input", { type: "text", value: detail, onChange: (e) => setDetail(e.target.value), placeholder: "Source (e.g. Chase dashboard)", className: "flex-1 min-w-[12rem] px-2 py-1 text-sm border border-border rounded focus:outline-none focus:border-brand" }), _jsx("button", { type: "submit", className: "px-3 py-1 bg-brand text-white text-xs font-semibold rounded hover:bg-brand-navy", children: "Log score" })] }));
}
/* ------------------------------------------------------------------ */
/*  Tiny sparkline for score history                                   */
/* ------------------------------------------------------------------ */
function ScoreSparkline({ scores }) {
    // Sort oldest → newest so the line marches forward in time
    const sorted = [...scores].sort((a, b) => a.as_of.localeCompare(b.as_of));
    if (sorted.length < 2)
        return null;
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
    return (_jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("svg", { width: W, height: H, children: [_jsx("polyline", { fill: "none", stroke: "currentColor", strokeWidth: "1.5", className: "text-brand", points: pts.join(" ") }), sorted.map((_, i) => {
                        const [x, y] = pts[i].split(",").map(Number);
                        return (_jsx("circle", { cx: x, cy: y, r: 2, className: "fill-brand" }, i));
                    })] }), _jsxs("div", { className: `text-xs font-semibold ${deltaColor} tabular-nums`, children: [latestDelta >= 0 ? `+${latestDelta}` : latestDelta, " over ", sorted.length] })] }));
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
    const [prefill, setPrefill] = useState({ bureau: "experian", model: "fico8", detail: "", key: 0 });
    function quickLogFrom(bureau, model, sourceDetail) {
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
        const map = {};
        for (const s of scores.data ?? []) {
            const existing = map[s.bureau];
            if (!existing || s.as_of > existing.as_of) {
                map[s.bureau] = s;
            }
        }
        return map;
    }, [scores.data]);
    const aggregatePct = util.data?.aggregate_live_utilization_pct ?? null;
    return (_jsxs("div", { className: "space-y-6", children: [_jsx("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-4", children: BUREAUS.map((b) => {
                    const s = latestByBureau[b];
                    const band = s ? scoreBand(s.score) : null;
                    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-5", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: b }), s ? (_jsxs(_Fragment, { children: [_jsx("div", { className: `text-4xl font-bold tabular-nums mt-2 ${band.color}`, children: s.score }), _jsxs("div", { className: "text-xs text-text-muted mt-0.5", children: [band.label, " \u00B7 ", s.scoring_model] }), _jsx("div", { className: "mt-1", children: _jsx(SyncFreshnessChip, { syncedAt: s.as_of, compact: true }) }), s.source_detail && (_jsx("div", { className: "text-[11px] text-text-soft mt-1 truncate", children: s.source_detail }))] })) : (_jsxs(_Fragment, { children: [_jsx("div", { className: "text-4xl font-bold tabular-nums mt-2 text-text-soft", children: "\u2014" }), _jsxs("div", { className: "text-[11px] text-text-muted mt-1", children: [b === "experian" && (_jsxs(_Fragment, { children: ["Free at ", _jsx("span", { className: "font-mono", children: "experian.com/freecreditscore" }), "."] })), b === "equifax" && (_jsxs(_Fragment, { children: ["Free quarterly via", " ", _jsx("span", { className: "font-mono", children: "annualcreditreport.com" }), "; report only \u2014 score isn't included. Wells Fargo / Discover surface an Equifax FICO inside their card portal."] })), b === "transunion" && (_jsxs(_Fragment, { children: ["You track this on ", _jsx("span", { className: "font-mono", children: "SmartCredit" }), " \u2014 daily VantageScore 3.0 for all three bureaus."] }))] }), _jsxs("div", { className: "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] mt-2", children: [b === "experian" && (_jsxs(_Fragment, { children: [_jsx("a", { href: "https://www.smartcredit.com/member/credit-report/smart-3b/", target: "_blank", rel: "noopener noreferrer", className: "text-brand hover:underline", children: "Open SmartCredit \u2197" }), _jsx("button", { type: "button", onClick: () => quickLogFrom("experian", "vantagescore3", "SmartCredit · Experian VantageScore 3.0"), className: "text-brand hover:underline", children: "Quick log from SmartCredit \u2192" })] })), b === "equifax" && (_jsxs(_Fragment, { children: [_jsx("a", { href: "https://www.smartcredit.com/member/credit-report/smart-3b/", target: "_blank", rel: "noopener noreferrer", className: "text-brand hover:underline", children: "Open SmartCredit \u2197" }), _jsx("button", { type: "button", onClick: () => quickLogFrom("equifax", "vantagescore3", "SmartCredit · Equifax VantageScore 3.0"), className: "text-brand hover:underline", children: "Quick log from SmartCredit \u2192" })] })), b === "transunion" && (_jsxs(_Fragment, { children: [_jsx("a", { href: "https://www.smartcredit.com/member/credit-report/smart-3b/", target: "_blank", rel: "noopener noreferrer", className: "text-brand hover:underline", children: "Open SmartCredit \u2197" }), _jsx("button", { type: "button", onClick: () => quickLogFrom("transunion", "vantagescore3", "SmartCredit · TransUnion VantageScore 3.0"), className: "text-brand hover:underline", children: "Quick log from SmartCredit \u2192" })] }))] })] }))] }, b));
                }) }), _jsxs("div", { children: [_jsxs("div", { className: "flex items-end justify-between mb-3", children: [_jsxs("div", { children: [_jsx("h3", { className: "text-sm font-semibold text-text uppercase tracking-wide", children: "Opportunities" }), _jsx("p", { className: "text-xs text-text-muted mt-0.5", children: "Specific actions ranked by expected score impact. Every card includes before/after math \u2014 no money moves unless you do it yourself." })] }), _jsx("button", { onClick: () => {
                                    qc.invalidateQueries({ queryKey: ["creditOpportunities"] });
                                    qc.invalidateQueries({ queryKey: ["creditUtilization"] });
                                }, className: "text-xs font-semibold text-brand hover:text-brand-navy", children: "Refresh" })] }), opps.isLoading && (_jsx("div", { className: "text-text-muted text-sm p-4", children: "Analyzing\u2026" })), opps.data && opps.data.opportunities.length === 0 && (_jsx("div", { className: "bg-card border border-border rounded-md shadow-card p-6 text-center text-text-muted text-sm", children: "No opportunities right now. Either your cards are already optimized, or there isn't enough data yet \u2014 try logging statement close days and balances on your cards." })), _jsx("div", { className: "space-y-3", children: opps.data?.opportunities.map((o, i) => (_jsx(OpportunityCard, { opp: o }, i))) })] }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsxs("div", { className: "flex items-center justify-between px-4 py-3 bg-hover border-b border-border", children: [_jsxs("div", { children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Credit utilization" }), _jsx("p", { className: "text-[11px] text-text-muted mt-0.5", children: "Live vs. reported. Markers on the bars are the FICO cliffs (1%, 10%, 30%, 50%, 75%)." })] }), aggregatePct != null && (_jsxs("div", { className: "text-right", children: [_jsx("div", { className: "text-[10px] text-text-muted uppercase tracking-wide", children: "Aggregate live" }), _jsxs("div", { className: `text-xl font-semibold tabular-nums ${utilCliffColor(aggregatePct)}`, children: [aggregatePct.toFixed(1), "%"] })] }))] }), _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left", children: "Card" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Live balance vs. limit" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Live util" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Last reported" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Close in" })] }) }), _jsxs("tbody", { children: [util.isLoading && (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "p-8 text-center text-text-muted text-sm", children: "Loading\u2026" }) })), util.data && util.data.rows.length === 0 && (_jsx("tr", { children: _jsxs("td", { colSpan: 5, className: "p-8 text-center text-text-muted text-sm", children: ["No credit cards with limits set yet. Add", " ", _jsx("code", { children: "credit_limit_cents" }), " on an account to enable utilization tracking."] }) })), util.data?.rows.map((r) => (_jsx(CardUtilRow, { row: r }, r.account_id)))] })] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsx("div", { className: "px-4 py-3 bg-hover border-b border-border", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Score history" }), _jsx("p", { className: "text-[11px] text-text-muted mt-0.5", children: "Manual entry for now. Automated pull (Chase/Credit Karma via Playwright) is coming \u2014 this table will merge both sources." })] }), scores.data && scores.data.length >= 2 && (_jsx(ScoreSparkline, { scores: scores.data }))] }) }), _jsx("div", { id: "credit-score-entry-form", className: "px-4 py-3 border-b border-border", children: _jsx(AddScoreForm, { initialBureau: prefill.bureau, initialModel: prefill.model, initialDetail: prefill.detail, onSubmit: (payload) => addScore.mutate(payload) }, prefill.key) }), _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left", children: "Date" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Score" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Bureau" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Model" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Source" }), _jsx("th", { className: "px-4 py-2" })] }) }), _jsxs("tbody", { children: [scores.data?.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 6, className: "p-6 text-center text-text-muted text-sm", children: "No scores logged yet. Add the latest reading you see on Chase, Experian, or Credit Karma above." }) })), scores.data?.map((s) => (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-4 py-3 text-sm text-text-muted whitespace-nowrap", children: fmtDateShort(s.as_of) }), _jsx("td", { className: "px-4 py-3 text-right tabular-nums text-sm font-semibold", children: s.score }), _jsx("td", { className: "px-4 py-3 text-sm", children: s.bureau }), _jsx("td", { className: "px-4 py-3 text-sm text-text-muted", children: s.scoring_model }), _jsx("td", { className: "px-4 py-3 text-sm text-text-muted", children: s.source_detail || s.source }), _jsx("td", { className: "px-4 py-3 text-right", children: _jsx("button", { onClick: () => delScore.mutate(s.id), className: "text-xs text-text-muted hover:text-outflow", children: "Delete" }) })] }, s.id)))] })] })] })] }));
}
