import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Money on the Table — Phase 8.6 unified opportunity dashboard.
 *
 * Cohort-tab UX (mirrors LegalClaimsPanel) so the user can knock out
 * batches by *kind of action* rather than mentally re-grouping a flat
 * ranked list every visit:
 *
 *   - Quick wins        ≤ 10 min effort, has value, high confidence
 *   - Needs proof       requires receipts/docs (>15 min)
 *   - Big tickets       ≥ $500 estimated value
 *   - Urgent            deadline ≤ 30 days
 *   - Triage / passive  unmatched-against-your-data buckets to check
 *   - All               flat ranked list (legacy view)
 *
 * Each row carries source_kind + estimated value + effort + $/minute,
 * so the ordering inside each tab is still ROI-ranked. Empty sources
 * surface a "How to populate this" CTA inline rather than disappearing
 * silently — the user wanted to *see* every category of free money,
 * not just the ones with detected matches.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
import { SkelListRows } from "./components/Skeleton";
import CountUp from "./components/CountUp";
import SyncFreshnessChip from "./components/SyncFreshness";
const SOURCE_KIND_META = {
    unclaimed_property: {
        label: "Unclaimed",
        hint: "State-held money the holder lost track of",
        bg: "bg-emerald-50",
        fg: "text-inflow",
        populate: "Open the Unclaimed property panel and run a MissingMoney.com search. Add any matches you find.",
    },
    class_action: {
        label: "Class action",
        hint: "Open settlement you may be eligible to file",
        bg: "bg-amber-50",
        fg: "text-warn",
        populate: 'Hit "Scrape now" on the Class-action settlements panel to pull the latest from TopClassActions, ClassAction.org, and ClassActionRebates.',
    },
    regulatory_redress: {
        label: "CFPB / AG",
        hint: "Regulatory redress — agency-administered refund",
        bg: "bg-violet-50",
        fg: "text-violet-700",
        populate: "Connect Plaid so the redress catalog can match against your transaction history. Without transactions, we can't tell which cases apply to you.",
    },
    card_benefit: {
        label: "Card benefit",
        hint: "Annual credit on one of your cards you haven't used yet",
        bg: "bg-sky-50",
        fg: "text-sky-700",
        populate: "Add your premium cards in Connections (Sapphire Reserve, Amex Plat, etc.) — the bundled credits panel will then surface annual credit gaps.",
    },
    yield_arb: {
        label: "Yield arb",
        hint: "Idle cash earning less than top HYSA / T-bill rates",
        bg: "bg-indigo-50",
        fg: "text-indigo-700",
        populate: "Connect a checking/savings account via Plaid. Yield-arb only fires on liquid balances ≥ $1k.",
    },
    sub_cancel: {
        label: "Sub-cancel",
        hint: "Detected subscription you may want to cancel or negotiate",
        bg: "bg-rose-50",
        fg: "text-rose-700",
        populate: 'Run "Detect subscriptions" on the Subscriptions panel. We need ~3 months of recurring charges to be confident.',
    },
    bank_bonus: {
        label: "Bank bonus",
        hint: "Account-opening bonus catalog (Chase, SoFi, Discover, etc.)",
        bg: "bg-teal-50",
        fg: "text-teal-700",
        populate: "Catalog source — always populated. Open offers cycle quarterly.",
    },
    brokerage_bonus: {
        label: "Brokerage bonus",
        hint: "ACATS-transfer or new-account bonus (Schwab, Fidelity, Robinhood)",
        bg: "bg-cyan-50",
        fg: "text-cyan-700",
        populate: "Catalog source — always populated. Best ROI when you're consolidating brokerages anyway.",
    },
    passive_check: {
        label: "Passive check",
        hint: "Free-money buckets the app knows about but can't auto-match (NAUPA, IRS, recalls, etc.)",
        bg: "bg-slate-100",
        fg: "text-text",
        populate: "Catalog source — always populated. Run through these once a quarter.",
    },
    receipt_coupon: {
        label: "Receipt coupon",
        hint: "Coupon code or offer extracted from a receipt you uploaded",
        bg: "bg-orange-50",
        fg: "text-orange-700",
        populate: "Upload a receipt photo on the Receipts panel — coupons printed at the bottom auto-extract.",
    },
    cross_store_deal: {
        label: "Cross-store deal",
        hint: "An item you regularly buy is currently cheaper at another store",
        bg: "bg-pink-50",
        fg: "text-pink-700",
        populate: "Upload receipts to detect recurring purchases (Slice B), then log price observations or run scrapers (Slice D) — deals fire when another store beats your typical price.",
    },
};
const FALLBACK_META = {
    label: "Other",
    hint: "Unknown opportunity type — see description",
    bg: "bg-slate-100",
    fg: "text-text-muted",
    populate: "",
};
function kindMeta(kind) {
    return SOURCE_KIND_META[kind] ?? {
        ...FALLBACK_META,
        label: kind.replace(/_/g, " "),
    };
}
const ALL_KINDS_ORDERED = [
    "unclaimed_property",
    "class_action",
    "regulatory_redress",
    "card_benefit",
    "yield_arb",
    "sub_cancel",
    "bank_bonus",
    "brokerage_bonus",
    "passive_check",
    "receipt_coupon",
    "cross_store_deal",
];
const TAB_DEFS = [
    { key: "quick", label: "Quick wins", hint: "≤10 min effort with high confidence — knock these out in a coffee break" },
    { key: "needs_proof", label: "Needs proof", hint: "Class actions / refunds requiring receipts or documentation" },
    { key: "big_ticket", label: "Big tickets", hint: "≥ $500 estimated value — worth a longer block of time" },
    { key: "urgent", label: "Urgent", hint: "Deadline within 30 days" },
    { key: "triage", label: "Triage", hint: "Passive-check catalog + low-confidence rows that need you to decide" },
    { key: "all", label: "All", hint: "Flat ranked list across every source" },
];
function classifyTab(o) {
    // Tabs are non-exclusive — an opportunity can show in multiple
    // (e.g. Big ticket + Urgent). The "all" tab always includes it.
    const tabs = ["all"];
    const days = o.urgency_days;
    if (days != null && days >= 0 && days <= 30)
        tabs.push("urgent");
    if ((o.estimated_cents ?? 0) >= 50_000)
        tabs.push("big_ticket");
    // "Needs proof" covers regulatory redress + class actions where we
    // assume some documentation is needed (effort ≥ 15 min is the proxy).
    if ((o.source_kind === "class_action" || o.source_kind === "regulatory_redress") &&
        o.effort_minutes >= 15) {
        tabs.push("needs_proof");
    }
    // Quick wins — short-effort items worth doing even if the payoff
    // is uncertain. Includes:
    //   • High-confidence matches with positive value (data-fed claims,
    //     detected subs to cancel, eligible CFPB redress, etc.)
    //   • Catalog "go check this URL" lookups (NAUPA, IRS refund tracker,
    //     savings bonds, FDIC failed banks). These ship at low confidence
    //     because we can't tell whether *you specifically* have money
    //     there, but the action itself is universally worth the 5-10
    //     minutes — that's exactly the coffee-break flow.
    if (o.effort_minutes <= 15) {
        const isCatalogLookup = o.source_kind === "passive_check" || o.source_kind === "regulatory_redress";
        const isConfidentMatch = o.confidence >= 0.6 && (o.estimated_cents ?? 0) > 0;
        if (isCatalogLookup || isConfidentMatch) {
            tabs.push("quick");
        }
    }
    // Triage — passive-check catalog and low-confidence items
    if (o.source_kind === "passive_check" || o.confidence < 0.5) {
        tabs.push("triage");
    }
    return tabs;
}
/* ------------------------------------------------------------------ */
/*  Pretty $/min                                                        */
/* ------------------------------------------------------------------ */
function fmtPerMinute(cents) {
    if (cents == null || cents === 0)
        return "—";
    if (cents >= 100_00)
        return `$${Math.round(cents / 100).toLocaleString()}/min`;
    return `${(cents / 100).toFixed(2).replace(/\.00$/, "")}/min`;
}
function fmtEffort(minutes) {
    if (minutes < 1)
        return "<1 min";
    if (minutes < 60)
        return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
/* ------------------------------------------------------------------ */
/*  Headline cards                                                      */
/* ------------------------------------------------------------------ */
function HeaderStats({ report }) {
    return (_jsxs("div", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-5", children: [_jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Claimable now" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-inflow", children: _jsx(CountUp, { value: report?.total_claimable_cents ?? 0, format: fmtCents }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "One-time claims you haven't filed yet" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Recurring savings \u00B7 1yr" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-warn", children: _jsx(CountUp, { value: report?.total_savings_cents ?? 0, format: fmtCents }) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "Annual value of cancellations + yield moves" })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Live opportunities" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-text", children: report?.opportunities.length ?? 0 }), _jsxs("div", { className: "text-[11px] text-text-soft mt-0.5", children: ["Across ", Object.keys(report?.counts_by_kind ?? {}).length, " sources"] })] }), _jsxs("div", { className: "bg-card border border-border rounded-md p-4 shadow-card", children: [_jsx("div", { className: "text-xs text-text-muted uppercase tracking-wide", children: "Best $/minute" }), _jsx("div", { className: "text-2xl font-semibold tabular-nums mt-1 text-brand", children: fmtPerMinute(report?.opportunities[0]?.value_per_minute_cents ?? null) }), _jsx("div", { className: "text-[11px] text-text-soft mt-0.5", children: "Top-of-queue ROI on your next 5 min" })] })] }));
}
/* ------------------------------------------------------------------ */
/*  Opportunity card                                                    */
/* ------------------------------------------------------------------ */
function UrgencyPill({ op }) {
    if (!op.deadline) {
        return _jsx("span", { className: "text-[11px] text-text-soft", children: "No deadline" });
    }
    const d = op.urgency_days ?? 0;
    if (d < 0) {
        return (_jsxs("span", { className: "text-[11px] font-semibold text-outflow", children: ["Expired ", Math.abs(d), "d ago"] }));
    }
    let cls = "text-text-muted";
    if (d <= 7)
        cls = "text-outflow font-semibold";
    else if (d <= 30)
        cls = "text-warn font-semibold";
    return _jsxs("span", { className: `text-[11px] ${cls}`, children: [d, "d left"] });
}
function OpportunityCard({ op, rank, }) {
    const meta = kindMeta(op.source_kind);
    const cents = op.estimated_cents;
    return (_jsxs("div", { className: "border border-border rounded-md p-4 bg-card hover:shadow-card-hover transition-shadow", children: [_jsxs("div", { className: "flex items-start justify-between gap-3", children: [_jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2 flex-wrap", children: [_jsxs("span", { className: "text-[10px] font-mono text-text-soft tabular-nums", title: `Rank #${rank} by $/minute within this tab`, children: ["#", rank] }), _jsx("span", { className: `px-1.5 py-0.5 rounded-sm ${meta.bg} ${meta.fg} text-[10px] font-semibold uppercase tracking-wide`, title: meta.hint, children: meta.label }), _jsx("h4", { className: "text-sm font-semibold text-text", children: op.title })] }), op.description && (_jsx("p", { className: "text-xs text-text-muted mt-1 line-clamp-3", children: op.description }))] }), _jsxs("div", { className: "text-right shrink-0", children: [_jsx("div", { className: "text-base font-semibold tabular-nums text-text", children: cents !== null ? fmtCents(cents) : "—" }), _jsxs("div", { className: "text-[11px] text-text-muted", children: [fmtEffort(op.effort_minutes), " \u00B7", " ", _jsx("span", { className: "text-brand font-semibold", children: fmtPerMinute(op.value_per_minute_cents) })] })] })] }), _jsxs("div", { className: "flex items-center gap-3 mt-3 flex-wrap", children: [_jsx(UrgencyPill, { op: op }), _jsxs("span", { className: "text-[11px] text-text-soft", title: "Aggregator's confidence this opportunity actually applies to you", children: [Math.round(op.confidence * 100), "% confident"] }), _jsx("span", { className: "ml-auto", children: op.action_url ? (_jsxs("a", { href: op.action_url, target: "_blank", rel: "noopener noreferrer", className: "px-3 py-1.5 text-xs font-semibold rounded border border-brand text-brand hover:bg-brand hover:text-white transition-colors", children: [op.action_label, " \u2192"] })) : (_jsx("span", { className: "px-3 py-1.5 text-xs font-semibold rounded bg-hover text-text-muted", children: op.action_label })) })] })] }));
}
/* ------------------------------------------------------------------ */
/*  "Sources at a glance" strip — every kind, even when empty           */
/* ------------------------------------------------------------------ */
function SourcesStrip({ counts, }) {
    // Show every known kind so the user sees the full menu of free-money
    // categories — not just the ones with hits. Empty kinds get the
    // populate hint instead.
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card mb-5 overflow-hidden", children: [_jsxs("div", { className: "px-4 py-2 border-b border-border bg-slate-50", children: [_jsx("span", { className: "text-xs font-semibold uppercase tracking-wide text-text-muted", children: "Sources of free money" }), _jsx("span", { className: "ml-2 text-[11px] text-text-soft", children: "Every category the app knows about \u2014 empty ones tell you how to populate them." })] }), _jsx("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-x-4 gap-y-2 p-4", children: ALL_KINDS_ORDERED.map((kind) => {
                    const meta = kindMeta(kind);
                    const n = counts[kind] ?? 0;
                    const empty = n === 0;
                    return (_jsxs("div", { className: "flex items-start gap-2 text-xs", title: meta.hint, children: [_jsx("span", { className: `px-1.5 py-0.5 rounded-sm ${meta.bg} ${meta.fg} text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap`, children: meta.label }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: `tabular-nums font-semibold ${empty ? "text-text-soft" : "text-text"}`, children: n }), _jsx("span", { className: "text-text-muted", children: empty ? "no matches" : "matches" })] }), empty && meta.populate && (_jsx("p", { className: "text-[11px] text-text-soft mt-0.5 leading-snug", children: meta.populate }))] })] }, kind));
                }) })] }));
}
/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */
export default function MoneyOnTablePanel() {
    const [tab, setTab] = useState("quick");
    const [kindFilter, setKindFilter] = useState("all");
    const report = useQuery({
        queryKey: ["moneyOnTable"],
        queryFn: api.moneyOnTable,
        refetchOnWindowFocus: true,
    });
    // Pre-bucket by tab so the header counts and the rendered list use
    // the same source. Each opportunity may live in 1+ tabs (e.g. Big +
    // Urgent), and "all" gets every row.
    const byTab = useMemo(() => {
        const buckets = {
            quick: [],
            needs_proof: [],
            big_ticket: [],
            urgent: [],
            triage: [],
            all: [],
        };
        for (const op of report.data?.opportunities ?? []) {
            for (const t of classifyTab(op))
                buckets[t].push(op);
        }
        return buckets;
    }, [report.data]);
    const counts = {
        quick: byTab.quick.length,
        needs_proof: byTab.needs_proof.length,
        big_ticket: byTab.big_ticket.length,
        urgent: byTab.urgent.length,
        triage: byTab.triage.length,
        all: byTab.all.length,
    };
    const visible = useMemo(() => {
        let ops = byTab[tab];
        if (kindFilter !== "all")
            ops = ops.filter((o) => o.source_kind === kindFilter);
        return ops;
    }, [byTab, tab, kindFilter]);
    return (_jsxs("div", { children: [_jsx(HeaderStats, { report: report.data }), report.data?.summary_text && (_jsx("div", { className: "mb-5 px-4 py-3 bg-brand-deep text-white rounded-md text-sm leading-relaxed", children: report.data.summary_text })), _jsx(SourcesStrip, { counts: report.data?.counts_by_kind ?? {} }), _jsxs("div", { className: "bg-card border border-border rounded-md shadow-card", children: [_jsx("div", { className: "flex items-stretch border-b border-border overflow-x-auto", children: TAB_DEFS.map((t) => (_jsxs("button", { onClick: () => setTab(t.key), className: `px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap transition-colors ${tab === t.key
                                ? "text-brand border-b-2 border-brand -mb-px"
                                : "text-text-muted border-b-2 border-transparent hover:text-text"}`, title: t.hint, children: [t.label, _jsx("span", { className: `ml-1.5 inline-block px-1.5 py-0.5 rounded-full text-[10px] tabular-nums ${tab === t.key
                                        ? "bg-brand text-white"
                                        : "bg-hover text-text-muted"}`, children: counts[t.key] })] }, t.key))) }), _jsxs("div", { className: "flex items-center gap-3 px-4 py-2 border-b border-border bg-slate-50 text-xs", children: [_jsx("span", { className: "text-text-muted", children: "Source:" }), _jsxs("select", { value: kindFilter, onChange: (e) => setKindFilter(e.target.value), className: "px-2 py-1 text-xs border border-border rounded bg-card focus:outline-none focus:border-brand", children: [_jsx("option", { value: "all", children: "All sources" }), ALL_KINDS_ORDERED.map((k) => (_jsx("option", { value: k, children: kindMeta(k).label }, k)))] }), _jsx("span", { className: "ml-auto", children: _jsx(SyncFreshnessChip, { syncedAt: report.data?.as_of ?? null }) })] }), _jsxs("div", { className: "p-4", children: [report.isLoading && _jsx(SkelListRows, { count: 6 }), report.isError && (_jsxs("div", { className: "text-sm text-outflow text-center py-8", children: ["Could not load opportunities: ", report.error.message] })), report.data && visible.length === 0 && (_jsx("div", { className: "text-sm text-text-muted text-center py-12", children: emptyMessage(tab, kindFilter) })), visible.length > 0 && (_jsx("div", { className: "grid grid-cols-1 md:grid-cols-2 gap-3", children: visible.map((op, i) => (_jsx(OpportunityCard, { op: op, rank: i + 1 }, `${op.source_kind}:${op.source_id}:${i}:${op.title}`))) }))] })] }), _jsx("p", { className: "mt-3 text-[11px] text-text-soft", children: "Quick wins, needs proof, and big tickets are sub-views of the same ranked queue. Each row is sorted by $/minute within its tab. The triage tab includes the passive-check catalog (NAUPA, IRS refunds, recall searches, gift-card balance recovery, etc.) \u2014 buckets the app can't auto-match against your data but everyone should run through quarterly." })] }));
}
function emptyMessage(tab, kindFilter) {
    if (kindFilter !== "all") {
        return `No ${kindMeta(kindFilter).label} opportunities in the ${TAB_DEFS.find((t) => t.key === tab)?.label} tab.`;
    }
    switch (tab) {
        case "quick":
            return "No quick wins right now. Check Triage — the passive-check catalog (MissingMoney.com, IRS refund tracker, etc.) usually has at least one quick item to run.";
        case "needs_proof":
            return "No proof-required claims open. New class actions appear here when the scraper pulls them.";
        case "big_ticket":
            return "No ≥$500 opportunities. These tend to be brokerage transfer bonuses, big card sign-up bonuses, or large unclaimed-property finds.";
        case "urgent":
            return "Nothing urgent right now (no deadlines within 30 days). Good — keep it that way.";
        case "triage":
            return "Nothing in triage. Catalog sources should always populate this — if it's empty, the backend may need a restart to pick up the new aggregators.";
        case "all":
            return "No opportunities surfaced yet. Connect Plaid + Gmail to feed the data-matched aggregators.";
    }
}
