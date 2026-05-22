import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * Web app shell — header + grouped left sidebar + active-section content.
 *
 * Replaced the previous all-panels-stacked-vertically scroll page (29
 * sections rendered at once, all 29 fetched on mount) with a
 * single-active-panel router driven by URL hash. Now you tap a
 * sidebar item, the panel mounts, and the rest don't waste cycles.
 *
 * Why the URL hash and not React Router: deep links + browser back
 * button work, no extra dep, and the existing #networth / #cashflow
 * style anchors that we used in the old layout keep working as
 * direct links from emails / docs / scheduler digests.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { api, fmtCents, } from "./api/client";
import { SkelTableRow } from "./components/Skeleton";
import CountUp from "./components/CountUp";
import CommandPalette, { useCommandPalette, } from "./components/CommandPalette";
import AnomalyPanel from "./AnomalyPanel";
import AttributionPanel from "./AttributionPanel";
import BenefitsPanel from "./BenefitsPanel";
import BudgetsPanel from "./BudgetsPanel";
import CanonicalProductsPanel from "./CanonicalProductsPanel";
import CardApplicationsPanel from "./CardApplicationsPanel";
import CashFlowPanel from "./CashFlowPanel";
import ChatPanel from "./ChatPanel";
import ConnectionsPanel from "./ConnectionsPanel";
import DailyMovesPanel from "./DailyMovesPanel";
import DealsPanel from "./DealsPanel";
import CreditPanel from "./CreditPanel";
import FirePanel from "./FirePanel";
import GmailPanel from "./GmailPanel";
import GoalsPanel from "./GoalsPanel";
import HeatmapPanel from "./HeatmapPanel";
import HoldingsPanel from "./HoldingsPanel";
import HsaPanel from "./HsaPanel";
import LegalClaimsPanel from "./LegalClaimsPanel";
import MerchantPanel from "./MerchantPanel";
import MoneyOnTablePanel from "./MoneyOnTablePanel";
import NetWorthPanel from "./NetWorthPanel";
import NotificationsPanel from "./NotificationsPanel";
import OffersPanel from "./OffersPanel";
import ReceiptsPanel from "./ReceiptsPanel";
import RedressPanel from "./RedressPanel";
import ShoppingPatternsPanel from "./ShoppingPatternsPanel";
import SubscriptionsPanel from "./SubscriptionsPanel";
import TaxPanel from "./TaxPanel";
import TrendsPanel from "./TrendsPanel";
import UnclaimedPanel from "./UnclaimedPanel";
import YieldOptPanel from "./YieldOptPanel";
/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */
function fmtDateShort(iso) {
    return new Date(iso).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
    });
}
/* ------------------------------------------------------------------ */
/*  Stat card / buttons / row helpers (used inside Overview)          */
/* ------------------------------------------------------------------ */
function StatCard({ label, value, numericValue, format, tone, sublabel, }) {
    const valueColor = tone === "in" ? "text-inflow" : tone === "out" ? "text-outflow" : "text-text";
    return (_jsxs("div", { className: "bg-card border border-border rounded-md shadow-card p-5", children: [_jsx("div", { className: "text-text-muted text-xs font-semibold uppercase tracking-wide", children: label }), _jsx("div", { className: `text-3xl font-semibold mt-2 tabular-nums ${valueColor}`, children: numericValue !== undefined && format ? (_jsx(CountUp, { value: numericValue, format: format })) : (value) }), sublabel && (_jsx("div", { className: "text-text-soft text-xs mt-1", children: sublabel }))] }));
}
function GhostBtn({ children, onClick, disabled, }) {
    return (_jsx("button", { onClick: onClick, disabled: disabled, className: "px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors disabled:opacity-60", children: children }));
}
function TxnRow({ txn, categoryMap, cats, }) {
    const qc = useQueryClient();
    const amountTone = txn.amount_cents < 0 ? "text-outflow" : "text-inflow";
    const catName = txn.category_id != null ? categoryMap[txn.category_id] : null;
    const isUncat = !catName || categoryMap[txn.category_id ?? 0] === "Uncategorized";
    // Inline category picker state. Click "+ Categorize" → dropdown appears
    // → user picks a category → we POST /api/rules/from-transaction which
    // creates a rule AND tags this row AND re-runs categorize_all so other
    // matching merchants get the same category in one click.
    const [pickerOpen, setPickerOpen] = useState(false);
    const [lastResult, setLastResult] = useState(null);
    const tag = useMutation({
        mutationFn: (categoryId) => api.ruleFromTransaction({
            transaction_id: txn.id,
            category_id: categoryId,
        }),
        onSuccess: (result) => {
            setLastResult({ matches: result.txns_now_matching });
            setPickerOpen(false);
            qc.invalidateQueries();
            // Auto-clear the toast after a couple seconds.
            window.setTimeout(() => setLastResult(null), 3000);
        },
    });
    return (_jsxs("tr", { className: "border-b border-border last:border-0 hover:bg-hover", children: [_jsx("td", { className: "px-4 py-3 text-sm text-text-muted whitespace-nowrap", children: fmtDateShort(txn.posted_date) }), _jsx("td", { className: "px-4 py-3 text-sm font-medium", children: txn.description_raw }), _jsx("td", { className: "px-4 py-3", children: !isUncat ? (_jsx("span", { className: "inline-block px-2 py-0.5 bg-gray-100 text-text-muted rounded text-xs font-medium", children: catName })) : pickerOpen ? (_jsxs("select", { autoFocus: true, disabled: tag.isPending, defaultValue: "", onChange: (e) => {
                        const v = e.target.value;
                        if (v)
                            tag.mutate(Number(v));
                    }, onBlur: () => !tag.isPending && setPickerOpen(false), className: "text-xs border border-border rounded px-2 py-0.5 bg-card max-w-[200px]", children: [_jsx("option", { value: "", disabled: true, children: tag.isPending ? "Saving…" : "Pick a category…" }), cats
                            .filter((c) => c.slug !== "uncategorized")
                            .map((c) => (_jsx("option", { value: c.id, children: c.name }, c.id)))] })) : lastResult ? (_jsxs("span", { className: "text-[11px] text-inflow font-semibold", children: ["\u2713 Rule created \u00B7 ", lastResult.matches, " row", lastResult.matches === 1 ? "" : "s", " match"] })) : (_jsx("button", { type: "button", onClick: () => setPickerOpen(true), className: "text-[11px] text-brand hover:underline", title: "Pick a category. We'll create a rule that catches this merchant on every future row too.", children: "+ Categorize" })) }), _jsx("td", { className: `px-4 py-3 text-right tabular-nums text-sm font-semibold ${amountTone}`, children: fmtCents(txn.amount_cents) }), _jsx("td", { className: "px-4 py-3 text-xs text-text-soft uppercase tracking-wide", children: txn.source })] }));
}
function SectionHeader({ title, subtitle, action, }) {
    return (_jsxs("div", { className: "flex items-end justify-between mb-3 mt-10 first:mt-0", children: [_jsxs("div", { children: [_jsx("h2", { className: "text-lg font-semibold text-text", children: title }), subtitle && (_jsx("p", { className: "text-xs text-text-muted mt-0.5", children: subtitle }))] }), action && _jsx("div", { children: action })] }));
}
const SECTION_GROUPS = [
    {
        label: "Daily",
        items: [
            { key: "overview", label: "Overview", icon: "🏠" },
            { key: "chat", label: "Ask about money", icon: "💬", subtitle: "Plain-English questions over your data. Local Ollama model — no cloud calls. Try \"how much did I spend on groceries last month?\"" },
            { key: "daily-moves", label: "Today's moves", icon: "⚡", subtitle: "Your top 5–7 highest-value actions for today, ranked by $/minute with an urgency boost for soon-to-expire opportunities." },
            { key: "money-on-table", label: "Money found", icon: "💰", subtitle: "Every claim, refund, unused credit, and yield-arb opportunity, ranked by $/minute of your time." },
            { key: "networth", label: "Net worth", icon: "📈", subtitle: "Assets minus liabilities, with breakdown by account type and a daily history chart." },
            { key: "attribution", label: "Attribution", icon: "🔍", subtitle: "Why did net worth change each month? Decomposes the delta into income, spending, and market gains/losses with drill-in to top spending categories." },
            { key: "cashflow", label: "Cash flow", icon: "💵", subtitle: "Rolling 30-day projection: paychecks + bills + subscriptions vs. starting balance. Crunch days flagged." },
            { key: "budgets", label: "Budgets", icon: "🎯", subtitle: "Pace-aware monthly budgets. Warning fires when you're burning faster than the month is passing." },
            { key: "savings", label: "Savings & goals", icon: "🏆", subtitle: "Surplus snapshot + ranked allocation, cancellation, and debt-payoff suggestions." },
            { key: "fire", label: "FIRE projection", icon: "🔥", subtitle: "Monte Carlo simulation: when do you hit your FIRE number, with adjustable sliders for savings rate, return assumptions, retirement age, and target spend." },
            { key: "credit", label: "Credit", icon: "💳", subtitle: "Utilization, statement-close timing, and specific score-moving actions with before/after math." },
        ],
    },
    {
        label: "Opportunities",
        items: [
            { key: "offers", label: "Card offers", icon: "🎁", subtitle: "Chase Offers + Amex Offers, scraped via Playwright and ranked by estimated $/month." },
            { key: "claims", label: "Class actions", icon: "⚖️", subtitle: "Settlements you're eligible to file. Quick (no proof) ones can be knocked out in a coffee break." },
            { key: "redress", label: "Redress", icon: "🏛️", subtitle: "CFPB / FTC / state-AG enforcement orders matched against your transaction history." },
            { key: "unclaimed", label: "Unclaimed property", icon: "💸", subtitle: "State-held money the holder lost track of. Most adults have $80–200 sitting in NAUPA / state databases." },
            { key: "benefits", label: "Card benefits", icon: "🪪", subtitle: "Annual credits bundled into premium cards. Net-after-fee math reveals which cards actually pay for themselves." },
            { key: "yield", label: "Yield optimization", icon: "🏧", subtitle: "Idle cash earning < top HYSA / T-bill rates. Per-account breakdown of $-delta moving balances." },
            { key: "deals", label: "Cross-store deals", icon: "🏷️", subtitle: "Live price observations vs. your typical price for each tracked item." },
        ],
    },
    {
        label: "Tracking",
        items: [
            { key: "holdings", label: "Holdings", icon: "🏦", subtitle: "Empower-style portfolio: total value, unrealized gain, allocation by security type." },
            { key: "hsa", label: "HSA receipts", icon: "🩺", subtitle: "The decades-deferred reimbursement strategy: log medical bills now, reimburse later." },
            { key: "card-apps", label: "Card applications", icon: "✉️", subtitle: "Track new card apps through their lifecycle. Eligibility check covers Chase 5/24 + Amex once-per-lifetime." },
            { key: "subscriptions", label: "Subscriptions", icon: "🔁", subtitle: "Detected from transaction patterns + corroborated by Gmail signals (price changes, promos)." },
            { key: "shopping-patterns", label: "Shopping patterns", icon: "🛒", subtitle: "Recurring purchases detected from your receipts (item-level) + a Plaid-fed merchant rollup." },
            { key: "canonical-products", label: "Product catalog", icon: "📦", subtitle: "Cross-store product identity — same item across Costco / Target / Amazon resolves to one row." },
            { key: "merchants", label: "Merchants", icon: "🏪", subtitle: "Look up any merchant: lifetime spend, monthly breakdown, recent transactions, related sub + offers." },
        ],
    },
    {
        label: "Analytics",
        items: [
            { key: "tax", label: "Tax export", icon: "🧾", subtitle: "Annual roll-up by tax bucket + CSV download for upload to TurboTax / your CPA." },
            { key: "trends", label: "Trends", icon: "📊", subtitle: "Month-over-month outflow by category. Big swings surface at the top." },
            { key: "heatmap", label: "Heatmap", icon: "🔥", subtitle: "GitHub-style calendar grid colored by daily outflow. Reveals weekend vs weekday, payday spikes, dry-run days." },
            { key: "anomaly", label: "Unusual txns", icon: "⚠️", subtitle: "Statistical baseline per category; flags transactions ≥3σ above the per-category mean." },
        ],
    },
    {
        label: "System",
        items: [
            { key: "receipts", label: "Receipts", icon: "🧾", subtitle: "Upload photos of paper receipts; OCR extracts merchant + line items + totals." },
            { key: "connections", label: "Bank connections", icon: "🔌", subtitle: "Plaid-powered. Data lives on your machine; only access tokens are stored." },
            { key: "gmail", label: "Gmail inbox", icon: "📧", subtitle: "Bank alerts, bills, credit reports, subscriptions & promo emails. Read-only scope." },
            { key: "notifications", label: "Alerts", icon: "🔔", subtitle: "Anomaly scans, goal milestones, daily-digest summaries — every in-app alert lands here." },
            { key: "transactions", label: "Transactions", icon: "📋", subtitle: "Everything your accounts show, categorized automatically." },
        ],
    },
];
const ALL_KEYS = new Set(SECTION_GROUPS.flatMap((g) => g.items.map((s) => s.key)));
/** Lookup an item's catalog row by key. */
function findSection(key) {
    for (const g of SECTION_GROUPS) {
        const hit = g.items.find((s) => s.key === key);
        if (hit)
            return hit;
    }
    return undefined;
}
/** Default chat prompt for each panel.
 *
 * When the user clicks "Ask AI" from any panel, we want the chat to
 * open with a sensible contextual question pre-filled — so they
 * don't have to write the question themselves and so the LLM
 * tool-routes correctly out of the gate. The mapping below is the
 * hand-curated "if I'm staring at panel X, the most likely first
 * question I'd ask is …".
 */
function contextualPrompt(key) {
    const map = {
        overview: "Give me a quick snapshot of how my finances are doing right now.",
        "daily-moves": "Summarize the biggest money moves I should make this week.",
        "money-on-table": "What's the highest-value money-on-the-table opportunity for me right now?",
        networth: "How is my net worth split between assets and liabilities?",
        attribution: "Why did my net worth change last month?",
        cashflow: "Am I going to run into any cash crunches this month?",
        budgets: "Which budget categories am I most over/under on this month?",
        savings: "Am I on track for my savings goals?",
        fire: "Am I on track to hit my FIRE number by my target retirement age?",
        credit: "What's my credit utilization and what should I do about it?",
        offers: "What are the best card offers I should activate?",
        claims: "How many class-action settlements am I eligible to file right now?",
        redress: "Are there any CFPB or state-AG redress matches against my spending?",
        unclaimed: "Do I have any unclaimed property in my state?",
        benefits: "Which annual card benefits have I used or not used this year?",
        yield: "How much could I earn moving idle cash to a high-yield account?",
        deals: "Are there any cross-store deals worth grabbing right now?",
        holdings: "What's my brokerage portfolio look like — total value, biggest position?",
        hsa: "How much do I have in HSA receipts that I haven't reimbursed yet?",
        "card-apps": "Where am I on Chase 5/24 and what cards should I apply for next?",
        subscriptions: "What's my total monthly subscription cost? Anything worth cancelling?",
        "shopping-patterns": "What recurring purchases is the receipt parser flagging?",
        "canonical-products": "What products do I buy most across stores?",
        merchants: "Who are my top merchants by spend over the last 90 days?",
        tax: "What's my categorized year-to-date tax-relevant spend?",
        trends: "Which spending categories changed most month-over-month?",
        heatmap: "Which days of the week or month do I spend the most?",
        anomaly: "Were any recent transactions flagged as unusually large?",
        receipts: "How many receipts have I uploaded and what's parsed vs pending?",
        connections: "Are all my bank connections healthy and up-to-date?",
        gmail: "How many bills and bank alerts has the Gmail parser found?",
        notifications: "What unread alerts do I have and what should I act on first?",
        transactions: "Show me my top transactions from this month.",
        chat: "How can you help me with my finances?",
    };
    return map[key] ?? "Tell me what stands out about my finances right now.";
}
/* ------------------------------------------------------------------ */
/*  Sidebar badges                                                     */
/* ------------------------------------------------------------------ */
/** Fetch the small handful of endpoints that drive sidebar badges.
 *
 * Each query is cached for 5 minutes and refetches in the background —
 * the sidebar is mounted once at the app shell level, so this is one
 * fetch per endpoint per session, not per nav click. We swallow errors
 * silently because a missing badge shouldn't take down the whole app
 * shell — the panel itself will surface its own error state when the
 * user navigates to it.
 */
function useSidebarBadges() {
    const STALE = 5 * 60 * 1000; // 5 minutes
    const moneyOnTable = useQuery({
        queryKey: ["moneyOnTable"],
        queryFn: api.moneyOnTable,
        staleTime: STALE,
        retry: false,
    });
    // Daily moves: shows on the "Today's moves" sidebar entry.
    // We fetch independently of moneyOnTable because the daily slice
    // has its own urgency-boosted ranking and we want both badges to
    // potentially differ (full $ on Money-on-table, urgent count or
    // today's slice $ on Today's moves).
    const dailyMoves = useQuery({
        queryKey: ["dailyMoves"],
        queryFn: () => api.dailyMoves(7),
        staleTime: STALE,
        retry: false,
    });
    const claims = useQuery({
        queryKey: ["legalClaimStats"],
        queryFn: api.legalClaimStats,
        staleTime: STALE,
        retry: false,
    });
    const notifs = useQuery({
        queryKey: ["notificationsUnread"],
        queryFn: () => api.listNotifications(true, 100),
        staleTime: STALE,
        retry: false,
    });
    const plaidItems = useQuery({
        queryKey: ["plaidItems"],
        queryFn: api.plaidListItems,
        staleTime: STALE,
        retry: false,
    });
    const out = {};
    // Money-on-table: total $ available across all sources (claimable +
    // savings). Format as $1.2K-style abbreviation in the badge component.
    if (moneyOnTable.data) {
        const totalCents = (moneyOnTable.data.total_claimable_cents ?? 0) +
            (moneyOnTable.data.total_savings_cents ?? 0);
        if (totalCents > 0)
            out["money-on-table"] = { tone: "money", cents: totalCents };
        // counts_by_kind keys are the backend's source_kind values —
        // see money_on_table.py, every aggregator emits one of these.
        // Keep the mapping in sync if new aggregators get added.
        const kinds = moneyOnTable.data.counts_by_kind ?? {};
        if (kinds.unclaimed_property)
            out.unclaimed = { tone: "count", n: kinds.unclaimed_property };
        if (kinds.card_benefit)
            out.benefits = { tone: "count", n: kinds.card_benefit };
        if (kinds.regulatory_redress)
            out.redress = { tone: "count", n: kinds.regulatory_redress };
        if (kinds.cross_store_deal)
            out.deals = { tone: "count", n: kinds.cross_store_deal };
        if (kinds.yield_arb)
            out.yield = { tone: "count", n: kinds.yield_arb };
        // sub_cancel = "subscriptions worth cancelling". Surface on the
        // Subscriptions tab so the user can see at a glance there's
        // money to be had there, not just a passive list of recurring bills.
        if (kinds.sub_cancel)
            out.subscriptions = { tone: "count", n: kinds.sub_cancel };
    }
    // Class actions: surface the count of *eligible* claims the user can
    // act on right now. Settlemate redesign already exposes this. The
    // proof-not-required bucket is the easiest-win subset.
    if (claims.data && claims.data.available_count > 0) {
        out.claims = { tone: "count", n: claims.data.available_count };
    }
    // Notifications: just show unread count. List is capped at 100 by
    // the query, which is plenty — once you have 100+ unread you've
    // stopped reading them anyway.
    if (notifs.data && notifs.data.length > 0) {
        out.notifications = { tone: "count", n: notifs.data.length };
    }
    // Connections: red dot if any Plaid item needs attention. We don't
    // count — one broken connection is enough to demand a click.
    if (plaidItems.data &&
        plaidItems.data.some((it) => it.status === "login_required" || it.status === "error")) {
        out.connections = { tone: "alert" };
    }
    // Today's moves: prefer the alert dot if anything is urgent (deadline
    // ≤ 7 days), otherwise show the slice's $ value as a money chip.
    // A money chip is more informative than a count here — "$240 today"
    // is actionable, "5 moves" is not.
    if (dailyMoves.data) {
        if (dailyMoves.data.urgent_count > 0) {
            out["daily-moves"] = { tone: "alert" };
        }
        else if (dailyMoves.data.total_potential_cents > 0) {
            out["daily-moves"] = {
                tone: "money",
                cents: dailyMoves.data.total_potential_cents,
            };
        }
        else if (dailyMoves.data.moves.length > 0) {
            out["daily-moves"] = { tone: "count", n: dailyMoves.data.moves.length };
        }
    }
    return out;
}
/** Format cents as a compact string for the money-on-table badge.
 *  Examples: $42, $850, $1.2K, $12K, $1.4M. Never shows decimals
 *  because the badge is a glanceable summary, not a precise readout.
 */
function fmtBadgeMoney(cents) {
    const dollars = Math.round(cents / 100);
    if (dollars >= 1_000_000)
        return `$${(dollars / 1_000_000).toFixed(1)}M`;
    if (dollars >= 1_000)
        return `$${(dollars / 1000).toFixed(dollars >= 10_000 ? 0 : 1)}K`;
    return `$${dollars}`;
}
function BadgeChip({ badge, isActive }) {
    if (badge.tone === "alert") {
        return (_jsx("span", { className: "ml-auto w-2 h-2 rounded-full bg-outflow flex-shrink-0", title: "Needs attention" }));
    }
    const text = badge.tone === "money" ? fmtBadgeMoney(badge.cents) : String(badge.n);
    // Active row's background is brand-light, so the chip needs darker text
    // to stay readable. Inactive rows get the muted treatment.
    const cls = badge.tone === "money"
        ? isActive
            ? "bg-emerald-100 text-emerald-800"
            : "bg-emerald-50 text-inflow"
        : isActive
            ? "bg-white/80 text-brand"
            : "bg-slate-100 text-text-muted";
    return (_jsx("span", { className: `ml-auto px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums ${cls}`, children: text }));
}
/* ------------------------------------------------------------------ */
/*  Sidebar                                                            */
/* ------------------------------------------------------------------ */
function Sidebar({ active, onPick, }) {
    const badges = useSidebarBadges();
    return (_jsxs("aside", { className: "w-56 shrink-0 border-r border-border bg-card sticky top-0 h-screen overflow-y-auto py-3", children: [SECTION_GROUPS.map((group) => (_jsxs("div", { className: "mb-4", children: [_jsx("div", { className: "px-4 pb-1 text-[10px] font-bold uppercase tracking-wider text-text-soft", children: group.label }), _jsx("ul", { children: group.items.map((item) => {
                            const isActive = item.key === active;
                            const badge = badges[item.key];
                            return (_jsx("li", { children: _jsxs("button", { onClick: () => onPick(item.key), className: `w-full text-left flex items-center gap-2 px-4 py-1.5 text-sm transition-colors ${isActive
                                        ? "bg-brand-light text-brand font-semibold border-l-2 border-brand"
                                        : "text-text-muted border-l-2 border-transparent hover:bg-hover hover:text-text"}`, children: [_jsx("span", { className: "text-base leading-none w-5 text-center", children: item.icon }), _jsx("span", { className: "truncate", children: item.label }), badge && _jsx(BadgeChip, { badge: badge, isActive: isActive })] }) }, item.key));
                        }) })] }, group.label))), _jsx("div", { className: "px-4 pt-2 pb-4 mt-2 border-t border-border", children: _jsx("a", { href: "/docs", className: "text-[11px] text-text-soft hover:text-brand", target: "_blank", rel: "noopener", children: "API docs \u2197" }) })] }));
}
/* ------------------------------------------------------------------ */
/*  Overview content (extracted from former inline)                    */
/* ------------------------------------------------------------------ */
function OverviewContent() {
    const qc = useQueryClient();
    const summary = useQuery({ queryKey: ["summary"], queryFn: api.summary });
    const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
    const txns = useQuery({
        queryKey: ["transactions"],
        queryFn: () => api.listTransactions({ limit: 25 }),
    });
    const runCats = useMutation({
        mutationFn: api.runCategorization,
        onSuccess: () => qc.invalidateQueries(),
    });
    // Prime everything — fires every detector + scraper, then refetches all queries
    // so panels light up without a manual refresh. Surfaces task-level results
    // (subscriptions: 3 detected · class actions: 27 …) inline.
    const prime = useMutation({
        mutationFn: api.primeRun,
        onSuccess: () => qc.invalidateQueries(),
    });
    const subStats = useQuery({
        queryKey: ["subscription-stats"],
        queryFn: () => api.subscriptionStats(),
    });
    const categoryMap = Object.fromEntries((cats.data ?? []).map((c) => [c.id, c.name]));
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "bg-gradient-to-r from-brand/5 to-inflow/5 border border-brand/20 rounded-md p-4 mb-5 flex items-start justify-between gap-4", children: [_jsxs("div", { className: "flex-1", children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Find money on the table" }), _jsx("p", { className: "text-xs text-text-muted mt-0.5", children: "One click \u2014 runs every detector and scraper. Lights up Subscriptions, Cash Flow events, Class actions, Card offers, Deals, and more. Idempotent; safe to re-run." }), prime.data && (_jsx("div", { className: "mt-2 text-[11px] text-text-soft flex flex-wrap gap-x-3 gap-y-0.5", children: prime.data.tasks.map((t) => (_jsxs("span", { className: t.status === "ok" ? "text-inflow" : "text-outflow", children: [t.status === "ok" ? "✓" : "✕", " ", t.name] }, t.name))) }))] }), _jsx("button", { type: "button", onClick: () => prime.mutate(), disabled: prime.isPending, className: "px-3 py-1.5 rounded-md text-xs font-semibold bg-brand text-white hover:bg-brand-hover disabled:opacity-50 whitespace-nowrap", children: prime.isPending ? "Running…" : "Prime everything" })] }), _jsxs("section", { className: "grid grid-cols-2 md:grid-cols-4 gap-4 mb-6", children: [_jsx(StatCard, { label: "Money in \u00B7 90d", numericValue: summary.data?.total_inflow_cents ?? 0, format: fmtCents, tone: "in", sublabel: "Deposits, refunds, transfers in" }), _jsx(StatCard, { label: "Money out \u00B7 90d", numericValue: summary.data?.total_outflow_cents ?? 0, format: fmtCents, tone: "out", sublabel: "Card charges, bills, transfers out" }), _jsx(StatCard, { label: "Net \u00B7 90d", numericValue: summary.data?.net_cents ?? 0, format: fmtCents, tone: (summary.data?.net_cents ?? 0) >= 0 ? "in" : "out" }), _jsx(StatCard, { label: "Recurring \u00B7 monthly", numericValue: Math.abs(subStats.data?.monthly_cost_cents ?? 0), format: fmtCents, tone: "out", sublabel: subStats.data
                            ? `${subStats.data.confirmed_count} confirmed · ${subStats.data.needs_review_count} to review · ${subStats.data.by_type?.length ?? 0} types`
                            : "No subscriptions yet" })] }), _jsx(SectionHeader, { title: "Recent transactions", subtitle: "The 25 most recent across all linked accounts. Full list under Transactions in the sidebar.", action: _jsx(GhostBtn, { onClick: () => runCats.mutate(), disabled: runCats.isPending, children: runCats.isPending ? "Categorizing…" : "Run categorization" }) }), _jsx("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left", children: "Date" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Description" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Category" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Amount" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Source" })] }) }), _jsxs("tbody", { children: [txns.isLoading && (_jsxs(_Fragment, { children: [_jsx(SkelTableRow, { cols: 5 }), _jsx(SkelTableRow, { cols: 5 }), _jsx(SkelTableRow, { cols: 5 }), _jsx(SkelTableRow, { cols: 5 }), _jsx(SkelTableRow, { cols: 5 })] })), txns.data?.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "p-8 text-center text-text-muted text-sm", children: "No transactions yet. Connect a bank from the sidebar." }) })), txns.data?.map((t) => (_jsx(TxnRow, { txn: t, categoryMap: categoryMap, cats: cats.data ?? [] }, t.id)))] })] }) })] }));
}
/* ------------------------------------------------------------------ */
/*  Section content router                                             */
/* ------------------------------------------------------------------ */
function SectionContent({ active }) {
    switch (active) {
        case "overview":
            return _jsx(OverviewContent, {});
        case "chat":
            return _jsx(ChatPanel, {});
        case "daily-moves":
            return _jsx(DailyMovesPanel, {});
        case "money-on-table":
            return _jsx(MoneyOnTablePanel, {});
        case "networth":
            return _jsx(NetWorthPanel, {});
        case "attribution":
            return _jsx(AttributionPanel, {});
        case "cashflow":
            return _jsx(CashFlowPanel, {});
        case "budgets":
            return _jsx(BudgetsPanel, {});
        case "savings":
            return _jsx(GoalsPanel, {});
        case "credit":
            return _jsx(CreditPanel, {});
        case "fire":
            return _jsx(FirePanel, {});
        case "offers":
            return _jsx(OffersPanel, {});
        case "claims":
            return _jsx(LegalClaimsPanel, {});
        case "redress":
            return _jsx(RedressPanel, {});
        case "unclaimed":
            return _jsx(UnclaimedPanel, {});
        case "benefits":
            return _jsx(BenefitsPanel, {});
        case "yield":
            return _jsx(YieldOptPanel, {});
        case "deals":
            return _jsx(DealsPanel, {});
        case "holdings":
            return _jsx(HoldingsPanel, {});
        case "hsa":
            return _jsx(HsaPanel, {});
        case "card-apps":
            return _jsx(CardApplicationsPanel, {});
        case "subscriptions":
            return _jsx(SubscriptionsPanel, {});
        case "shopping-patterns":
            return _jsx(ShoppingPatternsPanel, {});
        case "canonical-products":
            return _jsx(CanonicalProductsPanel, {});
        case "merchants":
            return _jsx(MerchantPanel, {});
        case "tax":
            return _jsx(TaxPanel, {});
        case "trends":
            return _jsx(TrendsPanel, {});
        case "heatmap":
            return _jsx(HeatmapPanel, {});
        case "anomaly":
            return _jsx(AnomalyPanel, {});
        case "receipts":
            return _jsx(ReceiptsPanel, {});
        case "connections":
            return _jsx(ConnectionsPanel, {});
        case "gmail":
            return _jsx(GmailPanel, {});
        case "notifications":
            return _jsx(NotificationsPanel, {});
        case "transactions":
            return _jsx(TransactionsContent, {});
    }
    return null;
}
function BulkCategorizeWizard({ cats }) {
    // Top uncategorized merchant patterns + per-pattern count + sample row.
    // Each group becomes one rule when the user picks a category.
    const qc = useQueryClient();
    const [open, setOpen] = useState(false);
    const [picks, setPicks] = useState({});
    const groups = useQuery({
        queryKey: ["uncategorizedGroups"],
        queryFn: () => api.uncategorizedGroups({ min_txn_count: 2, limit: 20 }),
        enabled: open,
    });
    const submit = useMutation({
        mutationFn: () => api.bulkRulesFromPatterns(Object.entries(picks).map(([pattern, category_id]) => ({
            pattern,
            category_id,
        }))),
        onSuccess: () => {
            qc.invalidateQueries();
            setPicks({});
        },
    });
    if (!open) {
        return (_jsx("button", { type: "button", onClick: () => setOpen(true), className: "px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors", children: "Bulk categorize\u2026" }));
    }
    const eligible = groups.data ?? [];
    const pickedCount = Object.keys(picks).length;
    const realCats = cats.filter((c) => c.slug !== "uncategorized");
    return (_jsxs("div", { className: "bg-card border border-brand/30 rounded-md shadow-card p-4 mb-4", children: [_jsxs("div", { className: "flex items-start justify-between gap-3 mb-3", children: [_jsxs("div", { children: [_jsx("h3", { className: "text-sm font-semibold text-text", children: "Bulk categorize uncategorized merchants" }), _jsx("p", { className: "text-xs text-text-muted mt-0.5 max-w-2xl", children: "Top merchant patterns by row count. Pick a category for each \u2014 we'll create one rule per pattern (priority 230, above seed rules) and re-categorize matching rows in a single pass." })] }), _jsx("button", { type: "button", onClick: () => { setOpen(false); setPicks({}); }, className: "text-xs text-text-muted hover:text-text", children: "Close" })] }), groups.isLoading ? (_jsx("div", { className: "text-xs text-text-muted py-3", children: "Computing groups\u2026" })) : eligible.length === 0 ? (_jsx("div", { className: "text-xs text-text-muted py-3", children: "No multi-row uncategorized merchants. The long tail is all one-offs." })) : (_jsxs("div", { className: "space-y-1.5", children: [eligible.map((g) => (_jsxs("div", { className: "flex items-center gap-3 text-xs px-2 py-1.5 rounded hover:bg-hover", children: [_jsxs("div", { className: "w-12 text-right tabular-nums font-semibold text-text", children: [g.txn_count, "\u00D7"] }), _jsx("div", { className: "w-24 text-right tabular-nums text-outflow", children: fmtCents(g.total_outflow_cents) }), _jsxs("div", { className: "flex-1 min-w-0", children: [_jsx("div", { className: "font-mono text-text truncate", children: g.pattern }), _jsx("div", { className: "text-[10px] text-text-soft truncate", children: g.sample_description })] }), _jsxs("select", { value: picks[g.pattern] ?? "", onChange: (e) => {
                                    const v = e.target.value;
                                    setPicks((prev) => {
                                        const next = { ...prev };
                                        if (!v)
                                            delete next[g.pattern];
                                        else
                                            next[g.pattern] = Number(v);
                                        return next;
                                    });
                                }, className: "px-2 py-1 border border-border rounded bg-card text-xs max-w-[200px]", children: [_jsx("option", { value: "", children: "\u2014 skip \u2014" }), realCats.map((c) => (_jsx("option", { value: c.id, children: c.name }, c.id)))] })] }, g.pattern))), _jsxs("div", { className: "flex items-center justify-between pt-3 mt-2 border-t border-border", children: [_jsxs("div", { className: "text-xs text-text-muted", children: [pickedCount, " of ", eligible.length, " groups picked.", submit.data && (_jsxs("span", { className: "ml-2 text-inflow", children: ["\u2713 ", submit.data.rules_created, " new rules \u00B7 ", submit.data.rules_updated, " updated \u00B7 ", submit.data.txns_tagged, " rows tagged"] }))] }), _jsx("button", { type: "button", onClick: () => submit.mutate(), disabled: pickedCount === 0 || submit.isPending, className: "px-3 py-1.5 rounded text-xs font-semibold bg-brand text-white hover:bg-brand-hover disabled:opacity-50", children: submit.isPending ? "Tagging…" : `Apply ${pickedCount} rule${pickedCount === 1 ? "" : "s"}` })] })] }))] }));
}
function TransactionsContent() {
    const qc = useQueryClient();
    const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
    const txns = useQuery({
        queryKey: ["transactions-full"],
        queryFn: () => api.listTransactions({ limit: 200 }),
    });
    const runCats = useMutation({
        mutationFn: api.runCategorization,
        onSuccess: () => qc.invalidateQueries(),
    });
    const categoryMap = Object.fromEntries((cats.data ?? []).map((c) => [c.id, c.name]));
    return (_jsxs(_Fragment, { children: [_jsx(BulkCategorizeWizard, { cats: cats.data ?? [] }), _jsx(SectionHeader, { title: "All transactions", subtitle: "Latest 200 transactions across every account. Categorized automatically.", action: _jsx(GhostBtn, { onClick: () => runCats.mutate(), disabled: runCats.isPending, children: runCats.isPending ? "Categorizing…" : "Run categorization" }) }), _jsx("div", { className: "bg-card border border-border rounded-md shadow-card overflow-hidden", children: _jsxs("table", { className: "w-full", children: [_jsx("thead", { className: "bg-hover border-b border-border", children: _jsxs("tr", { className: "text-text-muted text-[11px] font-semibold uppercase tracking-wide", children: [_jsx("th", { className: "px-4 py-2 text-left", children: "Date" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Description" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Category" }), _jsx("th", { className: "px-4 py-2 text-right", children: "Amount" }), _jsx("th", { className: "px-4 py-2 text-left", children: "Source" })] }) }), _jsxs("tbody", { children: [txns.isLoading && (_jsxs(_Fragment, { children: [_jsx(SkelTableRow, { cols: 5 }), _jsx(SkelTableRow, { cols: 5 }), _jsx(SkelTableRow, { cols: 5 }), _jsx(SkelTableRow, { cols: 5 }), _jsx(SkelTableRow, { cols: 5 })] })), txns.data?.length === 0 && (_jsx("tr", { children: _jsx("td", { colSpan: 5, className: "p-8 text-center text-text-muted text-sm", children: "No transactions yet." }) })), txns.data?.map((t) => (_jsx(TxnRow, { txn: t, categoryMap: categoryMap, cats: cats.data ?? [] }, t.id)))] })] }) })] }));
}
/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */
const DEFAULT_ACTIVE = "overview";
function readActiveFromHash() {
    const raw = (typeof window !== "undefined" ? window.location.hash.slice(1) : "") || "";
    if (ALL_KEYS.has(raw))
        return raw;
    return DEFAULT_ACTIVE;
}
export default function App() {
    const [active, setActive] = useState(() => readActiveFromHash());
    const summary = useQuery({ queryKey: ["summary"], queryFn: api.summary });
    // Cmd+K command palette — owns its own open state and listens for the
    // shortcut globally. The hook is a one-liner; the modal renders below
    // the main content.
    const palette = useCommandPalette();
    // Sync state ⇄ URL hash. Forward syncs (state → hash) on every nav
    // click; backward syncs (hash → state) when the user uses browser
    // back/forward buttons or pastes a deep link.
    useEffect(() => {
        if (window.location.hash.slice(1) !== active) {
            window.history.replaceState(null, "", `#${active}`);
        }
    }, [active]);
    useEffect(() => {
        const onHashChange = () => setActive(readActiveFromHash());
        window.addEventListener("hashchange", onHashChange);
        return () => window.removeEventListener("hashchange", onHashChange);
    }, []);
    const current = findSection(active);
    // Build command list once per render — cheap (32 panels) and keeps the
    // palette in sync if the section list ever becomes dynamic.
    const commands = SECTION_GROUPS.flatMap((g) => g.items.map((s) => ({
        id: s.key,
        label: s.label,
        icon: s.icon,
        group: g.label,
        hint: s.subtitle?.split(".")[0] ?? undefined,
        // Keywords help fuzzy match find panels by their typical search
        // intent — e.g. typing "spend" should find Trends and Heatmap.
        keywords: s.subtitle ?? "",
        onRun: () => setActive(s.key),
    })));
    return (_jsxs("div", { className: "min-h-screen bg-bg flex flex-col", children: [_jsx("a", { href: "#main-content", className: "skip-to-main", children: "Skip to main content" }), _jsx("header", { className: "bg-brand-deep text-white shrink-0", children: _jsxs("div", { className: "px-6 py-4 flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center gap-3", children: [_jsx("div", { className: "w-8 h-8 rounded-sm bg-brand flex items-center justify-center font-bold text-white", children: "$" }), _jsx("h1", { className: "text-lg font-semibold tracking-tight", children: "Finance" })] }), _jsxs("div", { className: "flex items-center gap-3", children: [_jsxs("button", { onClick: () => palette.setOpen(true), className: "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-brand-deep border border-white/20 hover:bg-brand transition-colors text-white/90 hover:text-white", title: "Quick search \u2014 open any panel", children: [_jsx("span", { children: "\uD83D\uDD0D" }), _jsx("span", { children: "Search" }), _jsx("kbd", { className: "ml-1 px-1.5 py-0.5 text-[10px] bg-white/10 rounded font-mono", children: typeof navigator !== "undefined" &&
                                                /Mac|iPod|iPhone|iPad/.test(navigator.platform)
                                                ? "⌘K"
                                                : "Ctrl+K" })] }), _jsxs("button", { onClick: () => {
                                        const prompt = contextualPrompt(active);
                                        const encoded = encodeURIComponent(prompt);
                                        // Two-step navigation: set the hash with the payload,
                                        // then update the active section. ChatPanel reads
                                        // location.hash on mount.
                                        window.location.hash = `#chat?prompt=${encoded}`;
                                        setActive("chat");
                                    }, className: "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-brand hover:bg-brand-light hover:text-brand transition-colors", title: "Ask AI a question about this view", children: [_jsx("span", { children: "\uD83D\uDCAC" }), _jsx("span", { children: "Ask AI" })] }), _jsx("span", { className: "text-xs text-brand-light", children: summary.isLoading ? "Loading…" : "Secure · Local-only" })] })] }) }), _jsxs("div", { className: "flex flex-1 min-h-0", children: [_jsx(Sidebar, { active: active, onPick: setActive }), _jsxs("main", { id: "main-content", className: "flex-1 px-8 py-6 overflow-y-auto", "aria-label": "Panel content", children: [current ? (_jsxs("div", { className: "mb-5", children: [_jsx("h2", { className: "text-2xl font-semibold text-text", children: current.label }), current.subtitle && (_jsx("p", { className: "text-sm text-text-muted mt-1 max-w-3xl", children: current.subtitle }))] })) : null, _jsx(SectionContent, { active: active }), _jsxs("footer", { className: "mt-12 pt-6 border-t border-border text-xs text-text-soft flex justify-between", children: [_jsx("span", { children: "Local-first. Data stays on your machine." }), _jsx("span", { children: "v0.3 \u2014 sidebar nav" })] })] })] }), _jsx(CommandPalette, { open: palette.open, onClose: () => palette.setOpen(false), commands: commands })] }));
}
