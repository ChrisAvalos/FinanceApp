import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Net-worth tracker panel — Phase 7.1.
 *
 * Top-of-page metric every personal-finance app surfaces, with a few
 * twists: per-account-type breakdown (so the user can see *where*
 * their net worth lives), a 30d/1y delta, and a sparkline pulled
 * from NetWorthSnapshot rows. Snapshots fire daily via the scheduler
 * — the "Take snapshot" button is the manual override after a balance
 * update.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fmtCents } from "./api/client";
import CountUp from "./components/CountUp";
import SyncFreshnessChip from "./components/SyncFreshness";
/** "Chase · Sapphire Reserve" → returns the friendly composite label. */
function accountLabel(a) {
    return a.institution_name ? `${a.institution_name} · ${a.name}` : a.name;
}
function bucketAccounts(accounts) {
    const assets = [];
    const liabilities = [];
    let assetSum = 0;
    let liabSum = 0;
    for (const a of accounts) {
        const cents = a.current_balance_cents ?? 0;
        const isLiability = a.account_type === "credit_card" ||
            a.account_type === "loan" ||
            a.account_type === "mortgage" ||
            cents < 0;
        if (isLiability) {
            liabilities.push(a);
            liabSum += cents;
        }
        else {
            assets.push(a);
            assetSum += cents;
        }
    }
    // Sort each bucket by abs(balance) desc so the biggest entries show first.
    const byAbs = (a, b) => Math.abs(b.current_balance_cents ?? 0) - Math.abs(a.current_balance_cents ?? 0);
    assets.sort(byAbs);
    liabilities.sort(byAbs);
    return [
        { label: "Assets", accounts: assets, total: assetSum },
        { label: "Liabilities", accounts: liabilities, total: liabSum },
    ];
}
function Sparkline({ series }) {
    // Below 3 points the chart is just a line between two dots — visually
    // indistinguishable from a bug. Show a calmer placeholder until we have
    // enough history for the trend to mean anything.
    if (series.length < 3) {
        const n = series.length;
        return (_jsxs("div", { className: "text-center py-10 px-4", children: [_jsx("div", { className: "text-3xl mb-2", children: "\uD83D\uDCC8" }), _jsx("div", { className: "text-sm font-semibold text-text", children: n === 0 ? "No snapshots yet" : `${n} snapshot${n === 1 ? "" : "s"} so far` }), _jsxs("div", { className: "text-xs text-text-muted mt-1 max-w-md mx-auto", children: ["The scheduler captures one snapshot per day. After about a week the chart becomes meaningful \u2014 until then, hit ", _jsx("span", { className: "font-mono", children: "Take snapshot" }), " ", "above to seed history manually."] })] }));
    }
    const min = Math.min(...series.map((p) => p.net_cents));
    const max = Math.max(...series.map((p) => p.net_cents));
    const range = max - min || 1;
    const w = 600;
    const h = 120;
    const points = series.map((p, i) => {
        const x = (i / (series.length - 1)) * w;
        const y = h - ((p.net_cents - min) / range) * h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const area = `0,${h} ${points.join(" ")} ${w},${h}`;
    const line = points.join(" ");
    return (_jsxs("svg", { viewBox: `0 0 ${w} ${h}`, className: "w-full h-32", children: [_jsx("polygon", { points: area, fill: "rgba(37, 99, 235, 0.08)" }), _jsx("polyline", { points: line, fill: "none", stroke: "#2563eb", strokeWidth: "2" }), _jsx("circle", { cx: (series.length - 1) / (series.length - 1) * w, cy: h - ((series[series.length - 1].net_cents - min) / range) * h, r: "3", fill: "#2563eb" })] }));
}
function DeltaPill({ cents, label }) {
    if (cents == null) {
        return (_jsxs("div", { className: "text-xs text-text-soft", children: [_jsx("div", { className: "uppercase tracking-wide", children: label }), _jsx("div", { className: "text-text-muted", children: "Need history" })] }));
    }
    const tone = cents >= 0 ? "text-inflow" : "text-outflow";
    return (_jsxs("div", { className: "text-xs", children: [_jsx("div", { className: "text-text-muted uppercase tracking-wide", children: label }), _jsxs("div", { className: `text-base font-semibold tabular-nums ${tone}`, children: [cents >= 0 ? "+" : "", fmtCents(cents)] })] }));
}
export default function NetWorthPanel() {
    const qc = useQueryClient();
    const [days, setDays] = useState(365);
    const summary = useQuery({ queryKey: ["netWorth"], queryFn: api.netWorth });
    const history = useQuery({
        queryKey: ["netWorthHistory", days],
        queryFn: () => api.netWorthHistory(days),
    });
    // Per-account list — the "where exactly is my money?" view Chris asked
    // for. Loaded alongside the rollup so it stays in sync with the hero.
    const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.listAccounts });
    const snapshot = useMutation({
        mutationFn: api.netWorthSnapshot,
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["netWorth"] });
            qc.invalidateQueries({ queryKey: ["netWorthHistory"] });
            qc.invalidateQueries({ queryKey: ["accounts"] });
        },
    });
    const breakdown = useMemo(() => {
        const rows = summary.data?.breakdown ?? [];
        return rows.slice().sort((a, b) => Math.abs(b.total_cents) - Math.abs(a.total_cents));
    }, [summary.data]);
    const accountBuckets = useMemo(() => bucketAccounts(accounts.data ?? []), [accounts.data]);
    return (_jsxs("div", { children: [_jsxs("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-5 shadow-card md:col-span-1", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Net worth" }), _jsx(SyncFreshnessChip, { syncedAt: summary.data?.as_of ?? null, label: "Snapshot", compact: true })] }), _jsx("div", { className: "text-3xl font-semibold tabular-nums mt-2 text-text", children: _jsx(CountUp, { value: summary.data?.net_cents ?? 0, format: fmtCents }) }), _jsxs("div", { className: "grid grid-cols-2 gap-3 mt-3", children: [_jsx(DeltaPill, { cents: history.data?.delta_30d_cents ?? null, label: "\u0394 30d" }), _jsx(DeltaPill, { cents: history.data?.delta_1y_cents ?? null, label: "\u0394 1y" })] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-5 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Assets" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-2 text-inflow", children: _jsx(CountUp, { value: summary.data?.assets_cents ?? 0, format: fmtCents }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: summary.data?.accounts_with_no_balance ? `${summary.data.accounts_with_no_balance} accounts missing balance` : "All accounts reporting" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-5 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Liabilities" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-2 text-outflow", children: _jsx(CountUp, { value: -(summary.data?.liabilities_cents ?? 0), format: fmtCents }) })] })] }), (accounts.data?.length ?? 0) > 0 && (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-5 overflow-hidden", children: [_jsxs("div", { className: "px-4 py-2 border-b border-border bg-slate-50 flex items-center justify-between", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Accounts" }), _jsxs("span", { className: "text-[11px] text-text-muted", children: [accounts.data?.length ?? 0, " linked"] })] }), _jsx("div", { className: "divide-y divide-border", children: accountBuckets.map((bucket) => bucket.accounts.length === 0 ? null : (_jsxs("div", { children: [_jsxs("div", { className: "px-4 py-2 bg-hover flex items-center justify-between", children: [_jsx("span", { className: "text-[11px] font-semibold uppercase tracking-wide text-text-muted", children: bucket.label }), _jsx("span", { className: `text-xs font-semibold tabular-nums ${bucket.label === "Assets" ? "text-inflow" : "text-outflow"}`, children: bucket.label === "Liabilities"
                                                ? `−${fmtCents(Math.abs(bucket.total))}`
                                                : fmtCents(bucket.total) })] }), bucket.accounts.map((a) => {
                                    const cents = a.current_balance_cents;
                                    const hasBalance = cents != null;
                                    const tone = bucket.label === "Liabilities" ? "text-outflow" : "text-text";
                                    return (_jsxs("div", { className: "px-4 py-2.5 flex items-center justify-between hover:bg-hover", children: [_jsxs("div", { className: "min-w-0 pr-3", children: [_jsxs("div", { className: "text-sm font-medium truncate", children: [accountLabel(a), a.mask ? (_jsxs("span", { className: "text-text-soft font-mono ml-2 text-[11px]", children: ["\u00B7\u00B7\u00B7\u00B7", a.mask] })) : null] }), _jsxs("div", { className: "text-[11px] text-text-muted capitalize", children: [a.account_type.replace("_", " "), a.credit_limit_cents
                                                                ? ` · limit ${fmtCents(a.credit_limit_cents)}`
                                                                : ""] })] }), _jsx("div", { className: `text-sm font-semibold tabular-nums ${tone}`, children: hasBalance
                                                    ? bucket.label === "Liabilities"
                                                        ? `−${fmtCents(Math.abs(cents))}`
                                                        : fmtCents(cents)
                                                    : _jsx("span", { className: "text-text-soft font-normal", children: "\u2014" }) })] }, a.id));
                                })] }, bucket.label))) })] })), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-5 p-5", children: [_jsxs("div", { className: "flex items-center justify-between mb-3", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Net worth over time" }), _jsxs("div", { className: "flex items-center gap-2", children: [_jsxs("select", { value: days, onChange: (e) => setDays(Number(e.target.value)), className: "px-2 py-1 text-xs border border-border rounded bg-card", children: [_jsx("option", { value: 30, children: "30 days" }), _jsx("option", { value: 90, children: "90 days" }), _jsx("option", { value: 365, children: "1 year" }), _jsx("option", { value: 1825, children: "5 years" })] }), _jsx("button", { onClick: () => snapshot.mutate(), disabled: snapshot.isPending, className: "px-3 py-1.5 text-xs font-semibold rounded border border-border hover:border-brand hover:text-brand disabled:opacity-50", children: snapshot.isPending ? "Saving…" : "Take snapshot" })] })] }), _jsx(Sparkline, { series: history.data?.series ?? [] }), _jsx("div", { className: "text-[11px] text-text-soft mt-2", children: history.data?.earliest && history.data?.latest
                            ? `${history.data.series.length} snapshots between ${history.data.earliest} and ${history.data.latest}`
                            : "Snapshot scheduler runs daily — chart populates as snapshots accumulate." })] }), breakdown.length > 0 && (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: [_jsx("div", { className: "px-4 py-2 border-b border-border bg-slate-50", children: _jsx("h3", { className: "text-sm font-semibold text-text", children: "Breakdown by account type" }) }), _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left", children: "Type" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Kind" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Accounts" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Total" })] }) }), _jsx("tbody", { children: breakdown.map((b, i) => (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-4 py-2 text-sm", children: b.account_type }), _jsx("td", { className: "px-4 py-2 text-xs text-text-muted", children: b.kind }), _jsx("td", { className: "px-4 py-2 text-right text-sm tabular-nums", children: b.accounts }), _jsx("td", { className: `px-4 py-2 text-right text-sm font-semibold tabular-nums ${b.kind === "asset" ? "text-inflow" : "text-outflow"}`, children: fmtCents(b.kind === "asset" ? b.total_cents : -b.total_cents) })] }, i))) })] })] }))] }));
}
