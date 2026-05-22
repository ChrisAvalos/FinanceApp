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
import {
  api,
  fmtCents,
  type Category,
  type Transaction,
} from "./api/client";
import { SkelTableRow } from "./components/Skeleton";
import CountUp from "./components/CountUp";
import SyncFreshnessChip from "./components/SyncFreshness";
import GmailHealthCard from "./components/GmailHealthCard";
import CommandPalette, {
  useCommandPalette,
  type PaletteCommand,
} from "./components/CommandPalette";
import AnomalyPanel from "./AnomalyPanel";
import AttributionPanel from "./AttributionPanel";
import BenefitsPanel from "./BenefitsPanel";
import BudgetsPanel from "./BudgetsPanel";
import CanonicalProductsPanel from "./CanonicalProductsPanel";
import CardApplicationsPanel from "./CardApplicationsPanel";
import CashFlowPanel from "./CashFlowPanel";
import CategorizePanel from "./CategorizePanel";
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

function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

/* ------------------------------------------------------------------ */
/*  Stat card / buttons / row helpers (used inside Overview)          */
/* ------------------------------------------------------------------ */

function StatCard({
  label,
  value,
  numericValue,
  format,
  tone,
  sublabel,
}: {
  label: string;
  /** Pre-formatted display string. Used when no numericValue is provided. */
  value?: string;
  /** Optional numeric source — when present, the value animates via
   *  CountUp from 0 to this value on first render and from the previous
   *  to the current value on every refetch. Pair with `format`. */
  numericValue?: number;
  /** Required when using numericValue — turns the in-flight number
   *  into the display string. Typically `fmtCents`. */
  format?: (v: number) => string;
  tone?: "in" | "out";
  sublabel?: string;
}) {
  const valueColor =
    tone === "in" ? "text-inflow" : tone === "out" ? "text-outflow" : "text-text";
  return (
    <div className="bg-card border border-border rounded-md shadow-card p-5">
      <div className="text-text-muted text-xs font-semibold uppercase tracking-wide">
        {label}
      </div>
      <div className={`text-3xl font-semibold mt-2 tabular-nums ${valueColor}`}>
        {numericValue !== undefined && format ? (
          <CountUp value={numericValue} format={format} />
        ) : (
          value
        )}
      </div>
      {sublabel && (
        <div className="text-text-soft text-xs mt-1">{sublabel}</div>
      )}
    </div>
  );
}

function GhostBtn({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors disabled:opacity-60"
    >
      {children}
    </button>
  );
}

function TxnRow({
  txn,
  categoryMap,
  cats,
}: {
  txn: Transaction;
  categoryMap: Record<number, string>;
  cats: Category[];
}) {
  const qc = useQueryClient();
  const amountTone = txn.amount_cents < 0 ? "text-outflow" : "text-inflow";
  const catName = txn.category_id != null ? categoryMap[txn.category_id] : null;
  const isUncat = !catName || categoryMap[txn.category_id ?? 0] === "Uncategorized";

  // Inline category picker state. Click "+ Categorize" → dropdown appears
  // → user picks a category → we POST /api/rules/from-transaction which
  // creates a rule AND tags this row AND re-runs categorize_all so other
  // matching merchants get the same category in one click.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [lastResult, setLastResult] = useState<{ matches: number } | null>(null);
  const tag = useMutation({
    mutationFn: (categoryId: number) =>
      api.ruleFromTransaction({
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

  // One-time-spend toggle. Flagging a charge as one-time excludes it from
  // the multi-month projection's rolling outflow rate — a medical
  // emergency or car repair must not be smeared into "monthly" spend.
  const oneTime = useMutation({
    mutationFn: (value: boolean) => api.setTransactionOneTime(txn.id, value),
    onSuccess: () => qc.invalidateQueries(),
  });

  return (
    <tr className="border-b border-border last:border-0 hover:bg-hover">
      <td className="px-4 py-3 text-sm text-text-muted whitespace-nowrap">
        {fmtDateShort(txn.posted_date)}
      </td>
      <td className="px-4 py-3 text-sm font-medium">
        {txn.description_raw}
        {txn.amount_cents < 0 && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => oneTime.mutate(!txn.is_one_time)}
              disabled={oneTime.isPending}
              className={
                txn.is_one_time
                  ? "inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 hover:bg-amber-200"
                  : "text-[10px] text-text-soft hover:text-brand hover:underline"
              }
              title={
                txn.is_one_time
                  ? "One-time charge — excluded from the multi-month projection. Click to undo."
                  : "Mark as a one-time charge (medical emergency, car repair, big one-off) so it isn't smeared into your projected monthly spending."
              }
            >
              {oneTime.isPending
                ? "Saving\u2026"
                : txn.is_one_time
                  ? "\u2298 One-time \u00b7 not projected"
                  : "Mark one-time"}
            </button>
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        {!isUncat ? (
          <span className="inline-block px-2 py-0.5 bg-gray-100 text-text-muted rounded text-xs font-medium">
            {catName}
          </span>
        ) : pickerOpen ? (
          <select
            autoFocus
            disabled={tag.isPending}
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value;
              if (v) tag.mutate(Number(v));
            }}
            onBlur={() => !tag.isPending && setPickerOpen(false)}
            className="text-xs border border-border rounded px-2 py-0.5 bg-card max-w-[200px]"
          >
            <option value="" disabled>
              {tag.isPending ? "Saving…" : "Pick a category…"}
            </option>
            {cats
              .filter((c) => c.slug !== "uncategorized")
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        ) : lastResult ? (
          <span className="text-[11px] text-inflow font-semibold">
            ✓ Rule created · {lastResult.matches} row{lastResult.matches === 1 ? "" : "s"} match
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="text-[11px] text-brand hover:underline"
            title="Pick a category. We'll create a rule that catches this merchant on every future row too."
          >
            + Categorize
          </button>
        )}
      </td>
      <td className={`px-4 py-3 text-right tabular-nums text-sm font-semibold ${amountTone}`}>
        {fmtCents(txn.amount_cents)}
      </td>
      <td className="px-4 py-3 text-xs text-text-soft uppercase tracking-wide">
        {txn.source}
      </td>
    </tr>
  );
}

function SectionHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between mb-3 mt-10 first:mt-0">
      <div>
        <h2 className="text-lg font-semibold text-text">{title}</h2>
        {subtitle && (
          <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>
        )}
      </div>
      {action && <div>{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section catalog — single source of truth for nav + content        */
/* ------------------------------------------------------------------ */

type SectionKey =
  | "overview"
  | "chat"
  | "daily-moves"
  | "money-on-table"
  | "networth"
  | "attribution"
  | "cashflow"
  | "budgets"
  | "savings"
  | "credit"
  | "fire"
  | "offers"
  | "claims"
  | "redress"
  | "unclaimed"
  | "benefits"
  | "yield"
  | "deals"
  | "holdings"
  | "hsa"
  | "card-apps"
  | "subscriptions"
  | "shopping-patterns"
  | "canonical-products"
  | "merchants"
  | "tax"
  | "trends"
  | "heatmap"
  | "anomaly"
  | "receipts"
  | "connections"
  | "gmail"
  | "notifications"
  | "transactions";

type Section = {
  key: SectionKey;
  label: string;
  icon: string;
  /** Brief subhead rendered above the panel. Optional. */
  subtitle?: string;
};

type SectionGroup = {
  label: string;
  items: Section[];
};

/** Badge rendered to the right of a sidebar item.
 *
 * - "money" → $ amount in inflow green ("$1.2K")
 * - "count" → neutral grey count chip ("4")
 * - "alert" → red dot, indicates something needs user attention
 *             (login_required Plaid item, unread anomaly, etc.)
 *
 * Accept null/undefined to mean "no badge — render nothing." We never
 * render a "0" badge — empty state is just the absence of the chip.
 */
type SidebarBadge =
  | { tone: "money"; cents: number }
  | { tone: "count"; n: number }
  | { tone: "alert" };

const SECTION_GROUPS: SectionGroup[] = [
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
      { key: "categorize", label: "Categorize", icon: "🗂️", subtitle: "Drag transactions into the right category. Cards with a dashed border are guesses you can confirm or move." },
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

const ALL_KEYS: Set<string> = new Set(
  SECTION_GROUPS.flatMap((g) => g.items.map((s) => s.key)),
);

/** Lookup an item's catalog row by key. */
function findSection(key: string): Section | undefined {
  for (const g of SECTION_GROUPS) {
    const hit = g.items.find((s) => s.key === key);
    if (hit) return hit;
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
function contextualPrompt(key: SectionKey): string {
  const map: Partial<Record<SectionKey, string>> = {
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
function useSidebarBadges(): Partial<Record<SectionKey, SidebarBadge>> {
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

  const out: Partial<Record<SectionKey, SidebarBadge>> = {};

  // Money-on-table: total $ available across all sources (claimable +
  // savings). Format as $1.2K-style abbreviation in the badge component.
  if (moneyOnTable.data) {
    const totalCents =
      (moneyOnTable.data.total_claimable_cents ?? 0) +
      (moneyOnTable.data.total_savings_cents ?? 0);
    if (totalCents > 0) out["money-on-table"] = { tone: "money", cents: totalCents };

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
  if (
    plaidItems.data &&
    plaidItems.data.some((it) => it.status === "login_required" || it.status === "error")
  ) {
    out.connections = { tone: "alert" };
  }

  // Today's moves: prefer the alert dot if anything is urgent (deadline
  // ≤ 7 days), otherwise show the slice's $ value as a money chip.
  // A money chip is more informative than a count here — "$240 today"
  // is actionable, "5 moves" is not.
  if (dailyMoves.data) {
    if (dailyMoves.data.urgent_count > 0) {
      out["daily-moves"] = { tone: "alert" };
    } else if (dailyMoves.data.total_potential_cents > 0) {
      out["daily-moves"] = {
        tone: "money",
        cents: dailyMoves.data.total_potential_cents,
      };
    } else if (dailyMoves.data.moves.length > 0) {
      out["daily-moves"] = { tone: "count", n: dailyMoves.data.moves.length };
    }
  }

  return out;
}

/** Format cents as a compact string for the money-on-table badge.
 *  Examples: $42, $850, $1.2K, $12K, $1.4M. Never shows decimals
 *  because the badge is a glanceable summary, not a precise readout.
 */
function fmtBadgeMoney(cents: number): string {
  const dollars = Math.round(cents / 100);
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1000).toFixed(dollars >= 10_000 ? 0 : 1)}K`;
  return `$${dollars}`;
}

function BadgeChip({ badge, isActive }: { badge: SidebarBadge; isActive: boolean }) {
  if (badge.tone === "alert") {
    return (
      <span
        className="ml-auto w-2 h-2 rounded-full bg-outflow flex-shrink-0"
        title="Needs attention"
      />
    );
  }
  const text =
    badge.tone === "money" ? fmtBadgeMoney(badge.cents) : String(badge.n);
  // Active row's background is brand-light, so the chip needs darker text
  // to stay readable. Inactive rows get the muted treatment.
  const cls =
    badge.tone === "money"
      ? isActive
        ? "bg-emerald-100 text-emerald-800"
        : "bg-emerald-50 text-inflow"
      : isActive
        ? "bg-white/80 text-brand"
        : "bg-slate-100 text-text-muted";
  return (
    <span
      className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums ${cls}`}
    >
      {text}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Sidebar                                                            */
/* ------------------------------------------------------------------ */

function Sidebar({
  active,
  onPick,
}: {
  active: SectionKey;
  onPick: (key: SectionKey) => void;
}) {
  const badges = useSidebarBadges();
  return (
    // Sprint 35 — explicit landmark role + label so screen readers
    // announce "Primary navigation" instead of an unlabeled
    // `<aside>`. Each list is a sub-region grouped under the section
    // heading, and the active panel button carries aria-current="page"
    // so assistive tech can read out which view is currently open.
    // Sprint 50 — switched from <aside role="navigation"> to <nav>:
    // aside is a "complementary" landmark and the role override was
    // flagged as aria-allowed-role. <nav> has the right implicit role,
    // no override needed.
    <nav
      className="w-56 shrink-0 border-r border-border bg-card sticky top-0 h-screen overflow-y-auto py-3"
      aria-label="Primary"
    >
      {SECTION_GROUPS.map((group) => (
        <div key={group.label} className="mb-4">
          <div
            id={`nav-group-${group.label.toLowerCase()}`}
            className="px-4 pb-1 text-[10px] font-bold uppercase tracking-wider text-text-soft"
          >
            {group.label}
          </div>
          <ul aria-labelledby={`nav-group-${group.label.toLowerCase()}`}>
            {group.items.map((item) => {
              const isActive = item.key === active;
              const badge = badges[item.key];
              return (
                <li key={item.key}>
                  <button
                    onClick={() => onPick(item.key)}
                    aria-current={isActive ? "page" : undefined}
                    className={`w-full text-left flex items-center gap-2 px-4 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset ${
                      isActive
                        // Sprint 50 — text-brand on bg-brand-light is 3.93:1
                        // (fails WCAG AA for body text). Swap to text-brand-navy
                        // (#0F4D8C) which gives ~7.5:1 on the same background.
                        ? "bg-brand-light text-brand-navy font-semibold border-l-2 border-brand"
                        : "text-text-muted border-l-2 border-transparent hover:bg-hover hover:text-text"
                    }`}
                  >
                    {/* Icon is decorative; the label below carries the
                        accessible name. aria-hidden prevents screen
                        readers from reading the emoji glyph. */}
                    <span
                      className="text-base leading-none w-5 text-center"
                      aria-hidden="true"
                    >
                      {item.icon}
                    </span>
                    <span className="truncate">{item.label}</span>
                    {badge && <BadgeChip badge={badge} isActive={isActive} />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="px-4 pt-2 pb-4 mt-2 border-t border-border">
        <a
          href="/docs"
          className="text-[11px] text-text-soft hover:text-brand"
          target="_blank"
          rel="noopener"
        >
          API docs ↗
        </a>
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/*  Overview content (extracted from former inline)                    */
/* ------------------------------------------------------------------ */

/**
 * SetupChecklist — Sprint 46.
 *
 * Top-of-Overview tile that shows the user where they are in the
 * one-time-setup journey: Plaid linked? Gmail OAuth done? Receipts
 * uploaded? Ollama running? Card-offer scrapers bootstrapped? Albert
 * scraper bootstrapped?
 *
 * Why this exists
 * ---------------
 * Without this tile, a first-time user lands on Overview with mostly
 * blank panels and has to discover each setup step independently
 * (subtle "needs auth" badges, empty-state copy on individual
 * panels). The audit flagged this gap repeatedly. The checklist is a
 * single coherent surface that says "here's what's done and here's
 * what's next."
 *
 * Self-collapsing
 * ---------------
 * Once every item is ``done`` we drop the tile entirely — no need
 * to remind a power user that they're fully set up forever. The
 * tile reappears if anything regresses to ``todo`` (e.g. Albert
 * cookies expire and we surface that as a status change).
 */
function SetupChecklist() {
  const status = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => api.setupStatus(),
    staleTime: 30_000,
  });

  // Optimistically hide before the first response — don't flash an
  // empty card on initial render. Show a skeleton instead.
  if (status.isLoading) {
    return (
      <div className="bg-card border border-border rounded-md p-4 mb-5 animate-pulse">
        <div className="h-4 w-40 bg-hover rounded mb-3" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-3 w-3/4 bg-hover rounded" />
          ))}
        </div>
      </div>
    );
  }
  if (!status.data || status.data.items.length === 0) return null;
  // Fully done → collapse the entire tile. The user has already
  // graduated past this surface; no point making them scroll past it.
  if (status.data.completed === status.data.total) return null;

  const todos = status.data.items.filter((it) => it.status !== "done");
  const dones = status.data.items.filter((it) => it.status === "done");

  return (
    <div className="bg-card border border-border rounded-md p-4 mb-5 shadow-card">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-text">
          Set up checklist
        </h3>
        <div className="text-[11px] text-text-muted tabular-nums">
          {status.data.completed} of {status.data.total} complete
        </div>
      </div>
      <ul className="space-y-2">
        {[...todos, ...dones].map((it) => {
          const isDone = it.status === "done";
          const isPartial = it.status === "partial";
          // Color the dot by state — green=done, amber=partial, gray=todo.
          // Keeps the strip scannable at a glance without forcing the
          // user to read every line.
          const dotCls = isDone
            ? "bg-inflow"
            : isPartial
              ? "bg-warn"
              : "bg-text-soft";
          return (
            <li key={it.key} className="flex items-start gap-3 text-xs">
              <span
                className={`mt-1 w-2 h-2 rounded-full shrink-0 ${dotCls}`}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <div
                  className={`text-sm ${
                    isDone ? "text-text-muted line-through" : "text-text font-medium"
                  }`}
                >
                  {it.title}
                </div>
                <div className="text-[11px] text-text-muted mt-0.5">
                  {it.detail}
                </div>
              </div>
              {!isDone && (
                <button
                  onClick={() => {
                    window.location.hash = it.action_hash;
                  }}
                  className="text-xs font-semibold text-brand hover:text-brand-navy whitespace-nowrap"
                >
                  {it.action_label} →
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}


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
  const categoryMap: Record<number, string> = Object.fromEntries(
    (cats.data ?? []).map((c: Category) => [c.id, c.name]),
  );

  return (
    <>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip syncedAt={summary.data?.generated_at ?? null} label="Snapshot computed" />
      </div>
      {/* Sprint 46 — first-run setup checklist. Self-collapses once
          everything is done so it doesn't crowd the panel forever. */}
      <SetupChecklist />
      {/* Gmail-status index — central source of truth for Gmail OAuth
          health. Quietly shows a "✓ connected" chip when healthy; pops
          a red banner when the token expires or sync stalls so the user
          isn't surprised by silent staleness in subscription discovery,
          receipt OCR, or bill detection. */}
      <GmailHealthCard />
      <div className="bg-gradient-to-r from-brand/5 to-inflow/5 border border-brand/20 rounded-md p-4 mb-5 flex items-start justify-between gap-4">
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-text">Find money on the table</h3>
          <p className="text-xs text-text-muted mt-0.5">
            One click — runs every detector and scraper. Lights up Subscriptions, Cash Flow events, Class actions, Card offers, Deals, and more. Idempotent; safe to re-run.
          </p>
          {prime.data && (
            <div className="mt-2 text-[11px] text-text-soft flex flex-wrap gap-x-3 gap-y-0.5">
              {prime.data.tasks.map((t) => (
                <span key={t.name} className={t.status === "ok" ? "text-inflow" : "text-outflow"}>
                  {t.status === "ok" ? "✓" : "✕"} {t.name}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => prime.mutate()}
          disabled={prime.isPending}
          className="px-3 py-1.5 rounded-md text-xs font-semibold bg-brand text-white hover:bg-brand-hover disabled:opacity-50 whitespace-nowrap"
        >
          {prime.isPending ? "Running…" : "Prime everything"}
        </button>
      </div>
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Money in · 90d"
          numericValue={summary.data?.total_inflow_cents ?? 0}
          format={fmtCents}
          tone="in"
          sublabel="Deposits, refunds, transfers in"
        />
        <StatCard
          label="Money out · 90d"
          numericValue={summary.data?.total_outflow_cents ?? 0}
          format={fmtCents}
          tone="out"
          sublabel="Card charges, bills, transfers out"
        />
        <StatCard
          label="Net · 90d"
          numericValue={summary.data?.net_cents ?? 0}
          format={fmtCents}
          tone={(summary.data?.net_cents ?? 0) >= 0 ? "in" : "out"}
        />
        <StatCard
          label="Recurring · monthly"
          numericValue={Math.abs(subStats.data?.monthly_cost_cents ?? 0)}
          format={fmtCents}
          tone="out"
          sublabel={
            subStats.data
              ? `${subStats.data.confirmed_count} confirmed · ${subStats.data.needs_review_count} to review · ${subStats.data.by_type?.length ?? 0} types`
              : "No subscriptions yet"
          }
        />
      </section>

      <SectionHeader
        title="Recent transactions"
        subtitle="The 25 most recent across all linked accounts. Full list under Transactions in the sidebar."
        action={
          <GhostBtn
            onClick={() => runCats.mutate()}
            disabled={runCats.isPending}
          >
            {runCats.isPending ? "Categorizing…" : "Run categorization"}
          </GhostBtn>
        }
      />
      <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left">Date</th>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-left">Category</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2 text-left">Source</th>
            </tr>
          </thead>
          <tbody>
            {txns.isLoading && (
              <>
                {/* Skeleton rows roughly the shape of the eventual
                    table — keeps the layout stable so the panel
                    doesn't pop when data arrives. */}
                <SkelTableRow cols={5} />
                <SkelTableRow cols={5} />
                <SkelTableRow cols={5} />
                <SkelTableRow cols={5} />
                <SkelTableRow cols={5} />
              </>
            )}
            {txns.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-text-muted text-sm">
                  No transactions yet. Connect a bank from the sidebar.
                </td>
              </tr>
            )}
            {txns.data?.map((t) => (
              <TxnRow
                key={t.id}
                txn={t}
                categoryMap={categoryMap}
                cats={cats.data ?? []}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Section content router                                             */
/* ------------------------------------------------------------------ */

function SectionContent({ active }: { active: SectionKey }) {
  switch (active) {
    case "overview":
      return <OverviewContent />;
    case "chat":
      return <ChatPanel />;
    case "daily-moves":
      return <DailyMovesPanel />;
    case "money-on-table":
      return <MoneyOnTablePanel />;
    case "networth":
      return <NetWorthPanel />;
    case "attribution":
      return <AttributionPanel />;
    case "cashflow":
      return <CashFlowPanel />;
    case "budgets":
      return <BudgetsPanel />;
    case "savings":
      return <GoalsPanel />;
    case "credit":
      return <CreditPanel />;
    case "fire":
      return <FirePanel />;
    case "offers":
      return <OffersPanel />;
    case "claims":
      return <LegalClaimsPanel />;
    case "redress":
      return <RedressPanel />;
    case "unclaimed":
      return <UnclaimedPanel />;
    case "benefits":
      return <BenefitsPanel />;
    case "yield":
      return <YieldOptPanel />;
    case "deals":
      return <DealsPanel />;
    case "holdings":
      return <HoldingsPanel />;
    case "hsa":
      return <HsaPanel />;
    case "card-apps":
      return <CardApplicationsPanel />;
    case "subscriptions":
      return <SubscriptionsPanel />;
    case "categorize":
      return <CategorizePanel />;
    case "shopping-patterns":
      return <ShoppingPatternsPanel />;
    case "canonical-products":
      return <CanonicalProductsPanel />;
    case "merchants":
      return <MerchantPanel />;
    case "tax":
      return <TaxPanel />;
    case "trends":
      return <TrendsPanel />;
    case "heatmap":
      return <HeatmapPanel />;
    case "anomaly":
      return <AnomalyPanel />;
    case "receipts":
      return <ReceiptsPanel />;
    case "connections":
      return <ConnectionsPanel />;
    case "gmail":
      return <GmailPanel />;
    case "notifications":
      return <NotificationsPanel />;
    case "transactions":
      return <TransactionsContent />;
  }
  return null;
}

function BulkCategorizeWizard({ cats }: { cats: Category[] }) {
  // Top uncategorized merchant patterns + per-pattern count + sample row.
  // Each group becomes one rule when the user picks a category.
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picks, setPicks] = useState<Record<string, number>>({});
  const groups = useQuery({
    queryKey: ["uncategorizedGroups"],
    queryFn: () => api.uncategorizedGroups({ min_txn_count: 2, limit: 20 }),
    enabled: open,
  });
  const submit = useMutation({
    mutationFn: () =>
      api.bulkRulesFromPatterns(
        Object.entries(picks).map(([pattern, category_id]) => ({
          pattern,
          category_id,
        })),
      ),
    onSuccess: () => {
      qc.invalidateQueries();
      setPicks({});
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1.5 border border-border bg-card text-text text-xs font-semibold rounded hover:border-brand hover:text-brand transition-colors"
      >
        Bulk categorize…
      </button>
    );
  }

  const eligible = groups.data ?? [];
  const pickedCount = Object.keys(picks).length;
  const realCats = cats.filter((c) => c.slug !== "uncategorized");

  return (
    <div className="bg-card border border-brand/30 rounded-md shadow-card p-4 mb-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold text-text">Bulk categorize uncategorized merchants</h3>
          <p className="text-xs text-text-muted mt-0.5 max-w-2xl">
            Top merchant patterns by row count. Pick a category for each — we'll create one rule per pattern (priority 230, above seed rules) and re-categorize matching rows in a single pass.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setOpen(false); setPicks({}); }}
          className="text-xs text-text-muted hover:text-text"
        >
          Close
        </button>
      </div>
      {groups.isLoading ? (
        <div className="text-xs text-text-muted py-3">Computing groups…</div>
      ) : eligible.length === 0 ? (
        <div className="text-xs text-text-muted py-3">No multi-row uncategorized merchants. The long tail is all one-offs.</div>
      ) : (
        <div className="space-y-1.5">
          {eligible.map((g) => (
            <div
              key={g.pattern}
              className="flex items-center gap-3 text-xs px-2 py-1.5 rounded hover:bg-hover"
            >
              <div className="w-12 text-right tabular-nums font-semibold text-text">
                {g.txn_count}×
              </div>
              <div className="w-24 text-right tabular-nums text-outflow">
                {fmtCents(g.total_outflow_cents)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-mono text-text truncate">{g.pattern}</div>
                <div className="text-[10px] text-text-soft truncate">{g.sample_description}</div>
              </div>
              <select
                value={picks[g.pattern] ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setPicks((prev) => {
                    const next = { ...prev };
                    if (!v) delete next[g.pattern];
                    else next[g.pattern] = Number(v);
                    return next;
                  });
                }}
                className="px-2 py-1 border border-border rounded bg-card text-xs max-w-[200px]"
              >
                <option value="">— skip —</option>
                {realCats.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          ))}
          <div className="flex items-center justify-between pt-3 mt-2 border-t border-border">
            <div className="text-xs text-text-muted">
              {pickedCount} of {eligible.length} groups picked.
              {submit.data && (
                <span className="ml-2 text-inflow">
                  ✓ {submit.data.rules_created} new rules · {submit.data.rules_updated} updated · {submit.data.txns_tagged} rows tagged
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => submit.mutate()}
              disabled={pickedCount === 0 || submit.isPending}
              className="px-3 py-1.5 rounded text-xs font-semibold bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
            >
              {submit.isPending ? "Tagging…" : `Apply ${pickedCount} rule${pickedCount === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TransactionsContent() {
  const qc = useQueryClient();
  // Honor a one-shot handoff flag from elsewhere in the app. Tax → "Categorize
  // unmapped" CTA sets `txn-only-uncategorized` in sessionStorage before
  // navigating here; we read it once on mount, pre-apply the filter, and
  // clear the flag so a later visit doesn't sticky-filter unexpectedly.
  const [onlyUncategorized, setOnlyUncategorized] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const flag = window.sessionStorage.getItem("txn-only-uncategorized");
    if (flag === "1") {
      window.sessionStorage.removeItem("txn-only-uncategorized");
      return true;
    }
    return false;
  });
  // Substring search against transaction descriptions. The backend's
  // /api/transactions endpoint takes a `search` query param that does
  // a case-insensitive ILIKE on description_raw — perfect for "find
  // every PEACOCK charge" or "find SAFEWAY transactions" without
  // having to scroll. Debounced via the 300ms TextInput → state hop.
  const [search, setSearch] = useState<string>("");
  const cats = useQuery({ queryKey: ["categories"], queryFn: api.listCategories });
  const txns = useQuery({
    queryKey: ["transactions-full", onlyUncategorized, search],
    queryFn: () =>
      api.listTransactions({
        limit: 200,
        only_uncategorized: onlyUncategorized || undefined,
        search: search.trim() || undefined,
      }),
  });
  const runCats = useMutation({
    mutationFn: api.runCategorization,
    onSuccess: () => qc.invalidateQueries(),
  });
  const categoryMap: Record<number, string> = Object.fromEntries(
    (cats.data ?? []).map((c: Category) => [c.id, c.name]),
  );
  return (
    <>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip
          syncedAt={txns.dataUpdatedAt > 0 ? new Date(txns.dataUpdatedAt).toISOString() : null}
          label="Last fetched"
        />
      </div>
      <BulkCategorizeWizard cats={cats.data ?? []} />
      <SectionHeader
        title="All transactions"
        subtitle="Latest 200 transactions across every account. Categorized automatically."
        action={
          <div className="flex items-center gap-2">
            <div className="relative">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search description (e.g. PEACOCK)…"
                className="px-2.5 py-1.5 pl-7 text-xs border border-border rounded bg-card w-64 focus:outline-none focus:border-brand"
                aria-label="Search transactions"
              />
              <span
                className="absolute left-2 top-1/2 -translate-y-1/2 text-text-soft text-xs pointer-events-none"
                aria-hidden="true"
              >
                🔍
              </span>
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-1 top-1/2 -translate-y-1/2 text-text-soft hover:text-text px-1 text-sm"
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-text-muted">
              <input
                type="checkbox"
                checked={onlyUncategorized}
                onChange={(e) => setOnlyUncategorized(e.target.checked)}
              />
              Only uncategorized
            </label>
            <GhostBtn
              onClick={() => runCats.mutate()}
              disabled={runCats.isPending}
            >
              {runCats.isPending ? "Categorizing…" : "Run categorization"}
            </GhostBtn>
          </div>
        }
      />
      {search.trim() && (
        <div className="text-[11px] text-text-muted -mt-1 mb-3">
          Showing matches for <span className="font-mono text-text">{search.trim()}</span>
          {txns.data ? ` · ${txns.data.length} result${txns.data.length === 1 ? "" : "s"}` : ""}
        </div>
      )}
      <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left">Date</th>
              <th className="px-4 py-2 text-left">Description</th>
              <th className="px-4 py-2 text-left">Category</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2 text-left">Source</th>
            </tr>
          </thead>
          <tbody>
            {txns.isLoading && (
              <>
                {/* Skeleton rows roughly the shape of the eventual
                    table — keeps the layout stable so the panel
                    doesn't pop when data arrives. */}
                <SkelTableRow cols={5} />
                <SkelTableRow cols={5} />
                <SkelTableRow cols={5} />
                <SkelTableRow cols={5} />
                <SkelTableRow cols={5} />
              </>
            )}
            {txns.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-text-muted text-sm">
                  {search.trim()
                    ? `No transactions match "${search.trim()}". Try a shorter query.`
                    : onlyUncategorized
                      ? "No uncategorized transactions — you're all caught up."
                      : "No transactions yet."}
                </td>
              </tr>
            )}
            {txns.data?.map((t) => (
              <TxnRow
                key={t.id}
                txn={t}
                categoryMap={categoryMap}
                cats={cats.data ?? []}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

const DEFAULT_ACTIVE: SectionKey = "overview";

function readActiveFromHash(): SectionKey {
  const raw = (typeof window !== "undefined" ? window.location.hash.slice(1) : "") || "";
  if (ALL_KEYS.has(raw)) return raw as SectionKey;
  return DEFAULT_ACTIVE;
}

export default function App() {
  const [active, setActive] = useState<SectionKey>(() => readActiveFromHash());
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
  const commands: PaletteCommand[] = SECTION_GROUPS.flatMap((g) =>
    g.items.map((s) => ({
      id: s.key,
      label: s.label,
      icon: s.icon,
      group: g.label,
      hint: s.subtitle?.split(".")[0] ?? undefined,
      // Keywords help fuzzy match find panels by their typical search
      // intent — e.g. typing "spend" should find Trends and Heatmap.
      keywords: s.subtitle ?? "",
      onRun: () => setActive(s.key),
    })),
  );

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* Skip-to-main-content link for keyboard / screen-reader users.
          Visually hidden until focused via Tab on first page entry. */}
      <a href="#main-content" className="skip-to-main">
        Skip to main content
      </a>
      {/* Top header */}
      <header className="bg-brand-deep text-white shrink-0">
        <div className="px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-sm bg-brand flex items-center justify-center font-bold text-white">
              $
            </div>
            <h1 className="text-lg font-semibold tracking-tight">Finance</h1>
          </div>
          <div className="flex items-center gap-3">
            {/* Cmd+K opener. Visible affordance so the shortcut is
                discoverable; clicking it has the same effect as the
                keyboard chord. Shows the platform's modifier (⌘ on Mac,
                Ctrl elsewhere) — we detect via navigator.platform since
                React's e.metaKey/ctrlKey only matter for the listener,
                not the visual hint. */}
            <button
              onClick={() => palette.setOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-brand-deep border border-white/20 hover:bg-brand transition-colors text-white/90 hover:text-white"
              title="Quick search — open any panel"
            >
              <span>🔍</span>
              <span>Search</span>
              <kbd className="ml-1 px-1.5 py-0.5 text-[10px] bg-white/10 rounded font-mono">
                {typeof navigator !== "undefined" &&
                /Mac|iPod|iPhone|iPad/.test(navigator.platform)
                  ? "⌘K"
                  : "Ctrl+K"}
              </kbd>
            </button>
            {/* Context-aware Ask AI button. Encodes a section-specific
                prompt into the hash so ChatPanel can prefill its input
                + auto-submit when it mounts. The panel handles the hash
                parsing — the header just emits "navigate + payload". */}
            <button
              onClick={() => {
                const prompt = contextualPrompt(active);
                const encoded = encodeURIComponent(prompt);
                // Two-step navigation: set the hash with the payload,
                // then update the active section. ChatPanel reads
                // location.hash on mount.
                window.location.hash = `#chat?prompt=${encoded}`;
                setActive("chat");
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-brand hover:bg-brand-light hover:text-brand transition-colors"
              title="Ask AI a question about this view"
            >
              <span>💬</span>
              <span>Ask AI</span>
            </button>
            <span className="text-xs text-brand-light">
              {summary.isLoading ? "Loading…" : "Secure · Local-only"}
            </span>
          </div>
        </div>
      </header>

      {/* Sidebar + content */}
      <div className="flex flex-1 min-h-0">
        <Sidebar active={active} onPick={setActive} />
        <main
          id="main-content"
          className="flex-1 px-8 py-6 overflow-y-auto"
          aria-label="Panel content"
        >
          {current ? (
            <div className="mb-5">
              <h2 className="text-2xl font-semibold text-text">
                {current.label}
              </h2>
              {current.subtitle && (
                <p className="text-sm text-text-muted mt-1 max-w-3xl">
                  {current.subtitle}
                </p>
              )}
            </div>
          ) : null}
          <SectionContent active={active} />
          <footer className="mt-12 pt-6 border-t border-border text-xs text-text-soft flex justify-between">
            <span>Local-first. Data stays on your machine.</span>
            <span>v0.3 — sidebar nav</span>
          </footer>
        </main>
      </div>

      {/* Cmd+K command palette — rendered at the App root so it overlays
          everything else with its fixed-position backdrop. */}
      <CommandPalette
        open={palette.open}
        onClose={() => palette.setOpen(false)}
        commands={commands}
      />
    </div>
  );
}
