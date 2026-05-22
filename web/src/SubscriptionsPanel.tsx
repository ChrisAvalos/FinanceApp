/**
 * Subscriptions panel — Phase B.
 *
 * Detected recurring outflows, grouped into typed buckets so Chris can see at
 * a glance:
 *   - what's confirmed vs auto-detected ("Needs review")
 *   - the monthly + annual cost broken down by category
 *   - which rows have a *price change* the detector or the T2 Gmail parser
 *     spotted (prior_amount_cents != last_amount_cents)
 *
 * Phase A had a single flat table inside App.tsx; this replaces it. The old
 * detector still exists; this UI surfaces all the new fields.
 *
 * Why a separate panel: the surplus engine (Phase D) consumes these rows.
 * Keeping confirm/dismiss state visible + easy reduces the chance Chris
 * forgets to triage them, which would silently degrade surplus math.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  fmtCents,
  type CompositeChildIn,
  type CompositeUnmaskResponse,
  type Subscription,
  type SubscriptionStats,
  type SubscriptionStatus,
  type SubscriptionType,
} from "./api/client";
import SyncFreshnessChip from "./components/SyncFreshness";
import { UndoToast, useUndoableDelete } from "./components/UndoableDelete";
import {
  CelebrationToastStack,
  useCelebrate,
} from "./components/CelebrationToast";

/* ------------------------------------------------------------------ */
/*  Type tab definitions                                              */
/* ------------------------------------------------------------------ */

type TabKey =
  | "all"
  | "needs_review"
  | "streaming"
  | "saas"
  | "utilities"
  | "internet"
  | "telecom"
  | "insurance"
  | "fitness"
  | "news_media"
  | "storage"
  | "gaming"
  | "other"
  | "price_changes"
  | "dismissed";

interface TabDef {
  key: TabKey;
  label: string;
  hint: string;
}

const TABS: TabDef[] = [
  { key: "all",           label: "All",           hint: "Every active or suspected sub" },
  { key: "needs_review",  label: "Needs review",  hint: "Suspected, or type=unknown — confirm/dismiss to clear" },
  { key: "price_changes", label: "Price changed", hint: "Last charge differs from the prior baseline" },
  { key: "streaming",     label: "Streaming",     hint: "Netflix, Spotify, etc." },
  { key: "saas",          label: "SaaS",          hint: "Adobe, ChatGPT, GitHub, etc." },
  { key: "news_media",    label: "News",          hint: "NYT, WSJ, Substack, etc." },
  { key: "utilities",     label: "Utilities",     hint: "PG&E, water, gas, trash" },
  { key: "internet",      label: "Internet",      hint: "Xfinity, Comcast, fiber" },
  { key: "telecom",       label: "Telecom",       hint: "Mobile carrier" },
  { key: "insurance",     label: "Insurance",     hint: "Auto, home, health premium" },
  { key: "fitness",       label: "Fitness",       hint: "Gym, Peloton, ClassPass" },
  { key: "storage",       label: "Storage",       hint: "iCloud, Dropbox, Public Storage" },
  { key: "gaming",        label: "Gaming",        hint: "Xbox Live, PS+, Nintendo" },
  { key: "other",         label: "Other",         hint: "Confirmed-recurring but uncategorized" },
  { key: "dismissed",     label: "Dismissed",     hint: "Marked not-a-subscription" },
];

/* ------------------------------------------------------------------ */
/*  Type & status badges                                              */
/* ------------------------------------------------------------------ */

const TYPE_BADGE: Record<
  SubscriptionType,
  { label: string; bg: string; fg: string }
> = {
  streaming:  { label: "Streaming",  bg: "bg-rose-50",    fg: "text-rose-700" },
  saas:       { label: "SaaS",       bg: "bg-indigo-50",  fg: "text-indigo-700" },
  news_media: { label: "News",       bg: "bg-orange-50",  fg: "text-orange-700" },
  utilities:  { label: "Utility",    bg: "bg-yellow-50",  fg: "text-yellow-700" },
  internet:   { label: "Internet",   bg: "bg-cyan-50",    fg: "text-cyan-700" },
  telecom:    { label: "Telecom",    bg: "bg-sky-50",     fg: "text-sky-700" },
  insurance:  { label: "Insurance",  bg: "bg-emerald-50", fg: "text-emerald-700" },
  fitness:    { label: "Fitness",    bg: "bg-lime-50",    fg: "text-lime-700" },
  storage:    { label: "Storage",    bg: "bg-purple-50",  fg: "text-purple-700" },
  gaming:     { label: "Gaming",     bg: "bg-fuchsia-50", fg: "text-fuchsia-700" },
  other:      { label: "Other",      bg: "bg-slate-100",  fg: "text-text-muted" },
  unknown:    { label: "?",          bg: "bg-slate-100",  fg: "text-text-muted" },
};

const STATUS_BADGE: Record<SubscriptionStatus, string> = {
  active:    "bg-brand-light text-brand-navy",
  paused:    "bg-amber-50 text-warn",
  suspected: "bg-amber-50 text-warn",
  cancelled: "bg-gray-100 text-text-muted line-through",
  dismissed: "bg-gray-100 text-text-muted",
};

function TypeBadge({ type }: { type: SubscriptionType }) {
  const cfg = TYPE_BADGE[type];
  return (
    <span
      className={`px-1.5 py-0.5 rounded-sm ${cfg.bg} ${cfg.fg} text-[10px] font-semibold uppercase tracking-wide`}
    >
      {cfg.label}
    </span>
  );
}

function ConfidenceChip({ score }: { score: number | null }) {
  if (score == null) return null;
  const pct = Math.round(score * 100);
  const tone =
    pct >= 75
      ? "bg-emerald-50 text-inflow"
      : pct >= 50
      ? "bg-amber-50 text-warn"
      : "bg-slate-100 text-text-muted";
  return (
    <span
      className={`ml-2 px-1.5 py-0.5 rounded-sm ${tone} text-[10px] font-semibold tracking-wide tabular-nums`}
      title="Detector confidence (0–100). Driven by occurrences × amount stability × cadence agreement."
    >
      {pct}%
    </span>
  );
}

function CadenceLabel({ days, label }: { days: number; label: string | null }) {
  return (
    <span className="text-xs text-text-muted">
      {(label ?? "monthly").replace(/^./, (s) => s.toUpperCase())} · {days}d
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Price change banner                                               */
/* ------------------------------------------------------------------ */

function PriceChangeBanner({ sub }: { sub: Subscription }) {
  if (
    sub.prior_amount_cents == null ||
    sub.last_amount_cents == null ||
    sub.prior_amount_cents === sub.last_amount_cents
  ) {
    return null;
  }
  const direction =
    Math.abs(sub.last_amount_cents) > Math.abs(sub.prior_amount_cents)
      ? "increased"
      : "decreased";
  const tone =
    direction === "increased"
      ? "bg-rose-50 text-outflow"
      : "bg-emerald-50 text-inflow";
  const arrow = direction === "increased" ? "↑" : "↓";
  return (
    <div className={`mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${tone}`}>
      <span>{arrow}</span>
      <span>
        Price {direction}: {fmtCents(sub.prior_amount_cents)} →{" "}
        {fmtCents(sub.last_amount_cents)}
      </span>
      {sub.price_change_date && (
        <span className="text-text-soft ml-1">
          on {new Date(sub.price_change_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stats header                                                      */
/* ------------------------------------------------------------------ */

function StatsHeader({ stats }: { stats: SubscriptionStats | undefined }) {
  if (!stats) {
    return <div className="text-text-muted text-sm">Loading stats…</div>;
  }
  const cards: { label: string; value: string; sub?: string; tone?: "out" | "warn" | "in" }[] = [
    {
      label: "Monthly recurring",
      value: fmtCents(stats.monthly_cost_cents),
      sub: `${stats.total_count} active or suspected`,
      tone: "out",
    },
    {
      label: "Annual recurring",
      value: fmtCents(stats.annual_cost_cents),
      sub: `${stats.confirmed_count} confirmed`,
      tone: "out",
    },
    {
      label: "Needs review",
      value: String(stats.needs_review_count),
      sub: stats.needs_review_count > 0 ? "Confirm or dismiss" : "All clear",
      tone: stats.needs_review_count > 0 ? "warn" : undefined,
    },
    {
      label: "Price changes",
      value: String(stats.price_change_count),
      sub: stats.price_change_count > 0 ? "Recent changes detected" : "No drift",
      tone: stats.price_change_count > 0 ? "warn" : undefined,
    },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
      {cards.map((c) => {
        const valueColor =
          c.tone === "out"
            ? "text-outflow"
            : c.tone === "warn"
            ? "text-warn"
            : c.tone === "in"
            ? "text-inflow"
            : "text-text";
        return (
          <div
            key={c.label}
            className="bg-card border border-border rounded-md shadow-card p-4"
          >
            <div className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              {c.label}
            </div>
            <div className={`text-2xl font-semibold mt-1 tabular-nums ${valueColor}`}>
              {c.value}
            </div>
            {c.sub && (
              <div className="text-text-soft text-xs mt-0.5">{c.sub}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Row                                                                */
/* ------------------------------------------------------------------ */

interface RowActions {
  onConfirm: (id: number) => void;
  onDismiss: (id: number) => void;
  onCancel: (id: number) => void;
  onSetType: (id: number, t: SubscriptionType) => void;
  onDelete: (id: number) => void;
}

type BundleHint = {
  parentLabel: string;
  annualSavings: number;
  tierNote: string;
  confidence: number;
};

function SubRow({
  sub,
  actions,
  bundleHint,
  onUnmask,
}: {
  sub: Subscription;
  actions: RowActions;
  bundleHint?: BundleHint;
  onUnmask?: (id: number) => void;
}) {
  return (
    <tr className="border-b border-border last:border-0 hover:bg-hover">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{sub.name}</span>
          <TypeBadge type={sub.subscription_type} />
          <ConfidenceChip score={sub.confidence_score} />
          {sub.is_user_confirmed && (
            <span className="text-[10px] font-semibold text-inflow uppercase tracking-wide">
              ✓ confirmed
            </span>
          )}
          {sub.is_variable_amount && (
            <span
              className="text-[10px] text-text-muted"
              title="Variable-amount bill — minor wobble doesn't trigger price-change alerts."
            >
              variable
            </span>
          )}
          {bundleHint && (
            <span
              className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                bundleHint.confidence >= 0.8
                  ? "bg-fuchsia-100 text-fuchsia-800"
                  : "bg-fuchsia-50 text-fuchsia-700"
              }`}
              title={`Bundled with ${bundleHint.parentLabel} (${bundleHint.tierNote}). Cancel this standalone to save ~$${(bundleHint.annualSavings / 100).toFixed(0)}/yr.${
                bundleHint.confidence < 0.8 ? " Verify your specific plan tier first." : ""
              }`}
            >
              ⊕ Bundled · save ${(bundleHint.annualSavings / 100).toFixed(0)}/yr
            </span>
          )}
          {sub.is_composite && sub.composite_kind === "usage" && (
            // Usage-meter composites (Anthropic, OpenAI, AWS, ...) have
            // no children to declare — they meter a single service
            // whose monthly cost just happens to vary. Show a passive
            // "usage" pill instead of the actionable UNMASK button so
            // the user knows this is a tracked variable-amount service
            // and doesn't expect to drill in.
            <span
              className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 text-violet-800"
              title="Usage-metered service — monthly amount varies with consumption. Tracked as a single subscription row; no children to declare."
            >
              ◌ Usage · variable
            </span>
          )}
          {sub.is_composite && sub.composite_kind !== "usage" && onUnmask && (
            <button
              type="button"
              onClick={() => onUnmask(sub.id)}
              className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 hover:bg-amber-200"
              title="Aggregator charge (Apple, Google, PayPal…) — click to declare what's bundled inside. Each declared line item flows into bundle detection + retention playbook."
            >
              ⌬ Composite · unmask
            </button>
          )}
        </div>
        <PriceChangeBanner sub={sub} />
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wide ${STATUS_BADGE[sub.status]}`}
        >
          {sub.status}
        </span>
      </td>
      <td className="px-4 py-3">
        <CadenceLabel days={sub.cadence_days} label={sub.cadence_label} />
        {sub.n_occurrences != null && (
          <div className="text-[11px] text-text-soft">{sub.n_occurrences}× seen</div>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-sm font-semibold text-outflow">
        {fmtCents(sub.amount_cents)}
      </td>
      <td className="px-4 py-3 text-sm text-text-muted">
        {sub.next_expected_date
          ? new Date(sub.next_expected_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
          : "—"}
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap">
        {!sub.is_user_confirmed && sub.status !== "dismissed" && (
          <button
            onClick={() => actions.onConfirm(sub.id)}
            className="text-xs text-brand hover:text-brand-navy font-semibold ml-2"
            title="Mark as a real subscription — counts toward surplus math"
          >
            Confirm
          </button>
        )}
        {sub.subscription_type === "unknown" && (
          <select
            className="text-xs border border-border rounded px-1 py-0.5 ml-2 text-text-muted bg-card"
            value=""
            onChange={(e) =>
              e.target.value && actions.onSetType(sub.id, e.target.value as SubscriptionType)
            }
            title="Manually classify"
          >
            <option value="">Set type…</option>
            <option value="streaming">Streaming</option>
            <option value="saas">SaaS</option>
            <option value="news_media">News</option>
            <option value="utilities">Utility</option>
            <option value="internet">Internet</option>
            <option value="telecom">Telecom</option>
            <option value="insurance">Insurance</option>
            <option value="fitness">Fitness</option>
            <option value="storage">Storage</option>
            <option value="gaming">Gaming</option>
            <option value="other">Other</option>
          </select>
        )}
        <button
          onClick={() => actions.onCancel(sub.id)}
          className="text-xs text-text-muted hover:text-outflow font-semibold ml-3"
          title="You cancelled this subscription"
        >
          Cancelled
        </button>
        <button
          onClick={() => actions.onDismiss(sub.id)}
          className="text-xs text-text-muted hover:text-text font-semibold ml-3"
          title="Not a subscription — don't resurface"
        >
          Dismiss
        </button>
        <button
          onClick={() => actions.onDelete(sub.id)}
          className="text-xs text-text-soft hover:text-outflow ml-3"
          title="Delete row"
        >
          ✕
        </button>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/*  Filtering                                                          */
/* ------------------------------------------------------------------ */

function filterByTab(rows: Subscription[], tab: TabKey): Subscription[] {
  switch (tab) {
    case "all":
      return rows.filter((s) => s.status !== "dismissed");
    case "dismissed":
      return rows.filter((s) => s.status === "dismissed");
    case "needs_review":
      return rows.filter(
        (s) =>
          s.status !== "dismissed" &&
          (s.status === "suspected" || s.subscription_type === "unknown")
      );
    case "price_changes":
      return rows.filter(
        (s) =>
          s.prior_amount_cents != null &&
          s.last_amount_cents != null &&
          s.prior_amount_cents !== s.last_amount_cents
      );
    default:
      return rows.filter((s) => s.subscription_type === tab && s.status !== "dismissed");
  }
}

/* ------------------------------------------------------------------ */
/*  Needs-input banner — Phase F-6                                     */
/* ------------------------------------------------------------------ */

/**
 * "Needs your input" prompt strip.
 *
 * Surfaces one ranked question at a time from /api/subscriptions/prompts.
 * Each prompt is a question the engine wants answered (confirm a high-
 * confidence detection, unmask a composite charge). Answering changes
 * the underlying state and the prompt drops off the next refresh.
 *
 * "Skip" is frontend-only (advances to next prompt without persisting),
 * so a skipped prompt re-appears on next page load. That's intentional
 * for v1 — if a prompt is durable enough to ignore twice, the user
 * should explicitly Dismiss it.
 */
/**
 * Sprint 18 — bundle-overlap "you're paying twice" banner.
 *
 * Aggregates the detected duplicate-paid findings from the Wave-E
 * bundle detector into a single high-prominence headline. When the
 * user has, e.g., a standalone Peacock charge AND an Xfinity Mobile
 * plan that bundles Peacock, this surfaces "$X/yr you're paying
 * twice" with a one-click route to the detail.
 *
 * Self-hides when there are no overlaps. Renders before the
 * NeedsInputBanner so the dollar-headline is the very first thing
 * the user sees on the panel — that's the design intent for Sprint
 * 18 ("the engine just saved you $X" is the kind of moment that
 * makes the app feel earned).
 */
function BundleOverlapBanner() {
  const overlaps = useQuery({
    queryKey: ["bundle-overlaps"],
    queryFn: () => api.bundleOverlaps(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // No data, error, or zero findings → render nothing. This banner
  // earns its space only when there's a real dollar headline.
  if (!overlaps.data || overlaps.data.overlaps.length === 0) return null;
  const total = overlaps.data.total_annual_savings_cents;
  if (total <= 0) return null;

  const annualUsd = (total / 100).toFixed(0);
  const monthlyUsd = (total / 12 / 100).toFixed(0);
  const itemCount = overlaps.data.overlaps.length;
  const itemLabel = itemCount === 1 ? "duplicate" : "duplicates";
  const exemplars = overlaps.data.overlaps
    .slice(0, 2)
    .map((o) => `${o.perk_label} (also in ${o.parent_label})`)
    .join(", ");

  function jumpToMoneyOnTable() {
    // The Money on the Table panel lives at #money-on-table — its
    // bundle-overlap source kind is rendered inline with a dedicated
    // badge color (added in Wave E-4). Just navigating there is enough.
    window.location.hash = "#money-on-table";
  }

  return (
    <div
      className="mb-4 border border-warn/40 bg-amber-50 rounded-md p-4 shadow-card"
      role="status"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-warn text-white text-[10px] font-bold"
              aria-hidden="true"
            >
              $
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-warn">
              You're paying twice — review {itemCount} {itemLabel}
            </span>
          </div>
          <div className="text-sm font-semibold text-text">
            Cancel duplicates to save{" "}
            <span className="tabular-nums text-warn">${annualUsd}/yr</span>{" "}
            <span className="text-text-muted font-normal">
              (~${monthlyUsd}/mo)
            </span>
          </div>
          <div className="text-xs text-text-muted mt-1 leading-relaxed">
            {exemplars}
            {itemCount > 2 && ` + ${itemCount - 2} more`}
          </div>
        </div>
        <button
          onClick={jumpToMoneyOnTable}
          className="px-3 py-1.5 text-xs font-semibold rounded bg-warn text-white hover:bg-amber-700 transition-colors whitespace-nowrap"
        >
          Review →
        </button>
      </div>
    </div>
  );
}


/**
 * TrendAlertBanner — Sprint 22.
 *
 * Surfaces usage-creep on metered subscriptions (Anthropic, OpenAI,
 * AWS, the Apple/Google bundle composites). Lives just below the
 * BundleOverlapBanner so the panel's top edge reads as a money-stack:
 *   "you're paying twice → save $X/yr"   (BundleOverlapBanner)
 *   "your usage is up Y% → review"        (this banner)
 *   "we found N possible new subs"        (NeedsInputBanner)
 *
 * Self-hides when there are no alerts — the detector requires 6+
 * months of data AND a 20%+ growth ratio, so it's quiet by design.
 * Click "Review →" jumps to the relevant subscription row.
 */
function TrendAlertBanner() {
  const trends = useQuery({
    queryKey: ["subscription-trends"],
    queryFn: () => api.subscriptionTrends(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (!trends.data) return null;

  // Decide which display mode to use:
  //   - alert mode (orange, dollar-headline) — real Sprint 11 alerts
  //   - preview mode (blue, informational) — top movers, no threshold
  // Mode is exclusive — alerts win when they exist.
  const isAlertMode = trends.data.alerts.length > 0;
  const rows = isAlertMode
    ? trends.data.alerts
    : trends.data.top_movers ?? [];
  if (rows.length === 0) return null;

  const itemCount = rows.length;
  const itemLabel = itemCount === 1 ? "subscription" : "subscriptions";
  const exemplars = rows
    .slice(0, 3)
    .map((a) => `${a.subscription_name} (+${a.growth_pct.toFixed(0)}%)`)
    .join(", ");

  function jumpToTopAlert() {
    const topId = rows[0]?.subscription_id;
    const el = topId
      ? document.querySelector(`[data-subscription-id="${topId}"]`)
      : null;
    if (el) {
      (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      const tbl = document.querySelector("[data-subscriptions-table]");
      if (tbl) (tbl as HTMLElement).scrollIntoView({ behavior: "smooth" });
    }
  }

  if (isAlertMode) {
    // Alert mode: dollar headline, action-y CTA, orange palette.
    const deltaMonthly = trends.data.total_monthly_delta_cents;
    const monthlyUsd = (deltaMonthly / 100).toFixed(0);
    const annualUsd = (deltaMonthly * 12 / 100).toFixed(0);
    return (
      <div
        className="mb-4 border border-orange-300 bg-orange-50 rounded-md p-4 shadow-card"
        role="status"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span
                className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-orange-500 text-white text-[10px] font-bold"
                aria-hidden="true"
              >
                ↑
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-wide text-orange-700">
                Usage trending up on {itemCount} {itemLabel}
              </span>
            </div>
            <div className="text-sm font-semibold text-text">
              Your recent monthly spend is{" "}
              <span className="tabular-nums text-orange-700">+${monthlyUsd}/mo</span>{" "}
              <span className="text-text-muted font-normal">
                vs trailing average (~${annualUsd}/yr at this pace)
              </span>
            </div>
            <div className="text-xs text-text-muted mt-1 leading-relaxed">
              {exemplars}
              {itemCount > 3 && ` + ${itemCount - 3} more`}
            </div>
          </div>
          <button
            onClick={jumpToTopAlert}
            className="px-3 py-1.5 text-xs font-semibold rounded bg-orange-600 text-white hover:bg-orange-700 transition-colors whitespace-nowrap"
          >
            Review →
          </button>
        </div>
      </div>
    );
  }

  // Preview mode: blue palette, informational tone. No dollar
  // headline because these rows haven't actually grown enough to
  // promise meaningful savings — they're just trends to watch.
  return (
    <div
      className="mb-4 border border-blue-200 bg-blue-50 rounded-md p-3 shadow-card"
      role="status"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-500 text-white text-[10px] font-bold"
              aria-hidden="true"
            >
              ↗
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-blue-700">
              Trending up · {itemCount} {itemLabel}
            </span>
          </div>
          <div className="text-sm text-text-muted leading-relaxed">
            {exemplars}
            {itemCount > 3 && ` + ${itemCount - 3} more`}
            {/* Sprint 50 — dropped /80 opacity modifier; the muted-text base
                color is already de-emphasized enough to convey hierarchy,
                and the /80 multiplier pushed it to 3.5:1 on the tinted
                background (fails WCAG AA for small text). */}
            <span className="block text-[11px] mt-0.5 text-text-muted">
              Not flagged as alerts yet — needs 6+ months of data and 20%
              growth to fire the dollar warning.
            </span>
          </div>
        </div>
        <button
          onClick={jumpToTopAlert}
          className="px-3 py-1.5 text-xs font-semibold rounded border border-blue-300 bg-card text-blue-700 hover:bg-blue-100 transition-colors whitespace-nowrap"
        >
          View →
        </button>
      </div>
    </div>
  );
}


function NeedsInputBanner({
  onUnmask,
}: {
  onUnmask: (subscriptionId: number) => void;
}) {
  const qc = useQueryClient();
  const [skipIndex, setSkipIndex] = useState(0);
  // Per-prompt local state for the needs-price inline input. Keyed by
  // prompt.id so switching to a different prompt (via Skip) resets the
  // input to empty without losing what the user already typed for
  // another prompt earlier in the queue.
  const [priceDraftById, setPriceDraftById] = useState<Record<string, string>>({});

  const prompts = useQuery({
    queryKey: ["subscription-prompts"],
    queryFn: () => api.listSubscriptionPrompts(),
  });

  const invalidateAll = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["subscription-prompts"] }),
      qc.invalidateQueries({ queryKey: ["subscriptions"] }),
      qc.invalidateQueries({ queryKey: ["subscription-stats"] }),
      qc.invalidateQueries({ queryKey: ["bundle-overlaps"] }),
    ]);

  const confirm = useMutation({
    mutationFn: api.confirmSubscription,
    onSuccess: () => {
      setSkipIndex(0);
      invalidateAll();
    },
  });
  const dismiss = useMutation({
    mutationFn: api.dismissSubscription,
    onSuccess: () => {
      setSkipIndex(0);
      invalidateAll();
    },
  });
  const setNotComposite = useMutation({
    mutationFn: (id: number) => api.setCompositeFlag(id, false),
    onSuccess: () => {
      setSkipIndex(0);
      invalidateAll();
    },
  });
  // Sprint 23a — price mutation for needs_price prompts.
  const setPrice = useMutation({
    mutationFn: (args: { id: number; monthly_cents: number; cadence?: string }) =>
      api.setSubscriptionPrice(args.id, args.monthly_cents, args.cadence),
    onSuccess: () => {
      setSkipIndex(0);
      invalidateAll();
    },
  });

  const list = prompts.data?.prompts ?? [];
  // Clamp the index — if the list shrinks (after an action) and our
  // index points past the end, fall back to the new last item.
  const safeIndex = list.length > 0 ? Math.min(skipIndex, list.length - 1) : 0;
  const current = list[safeIndex];

  // Hide the strip entirely while loading or empty — no point showing
  // a placeholder for a feature that's only useful when it has work.
  if (prompts.isLoading || !current) return null;

  const total = prompts.data?.total ?? list.length;
  const isAnyPending =
    confirm.isPending ||
    dismiss.isPending ||
    setNotComposite.isPending ||
    setPrice.isPending;

  // Needs-price helpers — extracted so the inline form below stays
  // readable. `current` is guaranteed non-null by the early return.
  const isNeedsPrice = current.kind === "needs_price";
  const priceDraft = priceDraftById[current.id] ?? "";

  function saveCurrentPrice() {
    if (!current.subscription_id) return;
    const parsed = parseFloat(priceDraft);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const cents = Math.round(parsed * 100);
    const cadence = (current.payload as { cadence_label?: string } | undefined)
      ?.cadence_label;
    setPrice.mutate({
      id: current.subscription_id,
      monthly_cents: cents,
      cadence,
    });
  }

  function dispatch(actionKind: string) {
    switch (actionKind) {
      case "confirm_sub":
        confirm.mutate(current.subscription_id);
        break;
      case "dismiss_sub":
        dismiss.mutate(current.subscription_id);
        break;
      case "open_unmask_modal":
        onUnmask(current.subscription_id);
        break;
      case "set_not_composite":
        setNotComposite.mutate(current.subscription_id);
        break;
      case "set_price":
        saveCurrentPrice();
        break;
      default:
        // Unknown action kind — fail loudly in dev so a backend
        // schema drift is obvious instead of silently broken.
        // eslint-disable-next-line no-console
        console.warn("Unknown prompt action kind:", actionKind);
    }
  }

  function skip() {
    if (list.length <= 1) return; // no-op if there's nothing to skip to
    setSkipIndex((i) => (i + 1) % list.length);
  }

  return (
    <div className="mb-4 border border-brand/30 bg-brand-light/40 rounded-md p-4 shadow-card">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-brand text-white text-[10px] font-bold"
            aria-hidden="true"
          >
            ?
          </span>
          {/* Sprint 50 — text-brand on the prompt strip's tinted blue
              background was 4.07:1 (fails AA for small text — needs 4.5:1).
              Swapping to brand-navy puts it at 7.5:1 on the same bg. */}
          <span className="text-[11px] font-semibold uppercase tracking-wide text-brand-navy">
            Needs your input
          </span>
          {total > 1 && (
            <span className="text-[11px] text-text-muted">
              · {safeIndex + 1} of {total}
            </span>
          )}
        </div>
        {list.length > 1 && (
          <button
            onClick={skip}
            disabled={isAnyPending}
            className="text-[11px] text-text-muted hover:text-brand disabled:opacity-50"
          >
            Skip →
          </button>
        )}
      </div>

      <div className="mb-3">
        <div className="text-sm font-semibold text-text">{current.title}</div>
        <div className="text-xs text-text-muted mt-0.5 leading-relaxed">
          {current.body}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {isNeedsPrice && (
          <div className="flex items-center gap-1 mr-1">
            <span className="text-text-muted text-sm tabular-nums">$</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="9.99"
              value={priceDraft}
              onChange={(e) =>
                setPriceDraftById((prev) => ({
                  ...prev,
                  [current.id]: e.target.value,
                }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  saveCurrentPrice();
                }
              }}
              disabled={isAnyPending}
              className="w-20 px-2 py-1 text-sm rounded border border-border bg-card text-text tabular-nums focus:outline-none focus:ring-1 focus:ring-brand focus:border-brand disabled:opacity-60"
              aria-label={`Monthly price for ${current.title}`}
            />
            <span className="text-text-muted text-xs">/mo</span>
          </div>
        )}
        <button
          onClick={() => dispatch(current.primary.kind)}
          disabled={
            isAnyPending ||
            (isNeedsPrice &&
              (priceDraft.trim() === "" || isNaN(parseFloat(priceDraft))))
          }
          className="px-3 py-1.5 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy disabled:opacity-60"
        >
          {current.primary.label}
        </button>
        {current.secondary && (
          <button
            onClick={() => dispatch(current.secondary!.kind)}
            disabled={isAnyPending}
            className="px-3 py-1.5 text-xs font-semibold rounded border border-border bg-card text-text-muted hover:border-brand hover:text-brand disabled:opacity-60"
          >
            {current.secondary.label}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel                                                              */
/* ------------------------------------------------------------------ */

export default function SubscriptionsPanel() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabKey>("all");
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const subs = useQuery({
    queryKey: ["subscriptions"],
    queryFn: () => api.listSubscriptions(),
  });
  const stats = useQuery({
    queryKey: ["subscription-stats"],
    queryFn: () => api.subscriptionStats(false),
  });
  // Wave E: bundle-overlap findings. The detector tells us which
  // subscription IDs are paid-twice (you have the perk standalone AND
  // a parent plan that bundles it). We badge those rows so the user
  // sees the duplicate-pay flag inline, without having to bounce to
  // Money on the Table.
  const bundles = useQuery({
    queryKey: ["bundle-overlaps"],
    queryFn: () => api.bundleOverlaps(),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const bundleByPerkId = useMemo(() => {
    const map = new Map<number, { parentLabel: string; annualSavings: number; tierNote: string; confidence: number }>();
    for (const b of bundles.data?.overlaps ?? []) {
      map.set(b.perk_subscription_id, {
        parentLabel: b.parent_label,
        annualSavings: b.annual_savings_cents,
        tierNote: b.tier_note,
        confidence: b.confidence,
      });
    }
    return map;
  }, [bundles.data]);

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["subscriptions"] }),
      qc.invalidateQueries({ queryKey: ["subscription-stats"] }),
      // F-6: row-level Confirm/Dismiss buttons answer the same questions
      // the prompt banner asks. Refresh prompts so the banner drops the
      // answered question without a manual reload.
      qc.invalidateQueries({ queryKey: ["subscription-prompts"] }),
    ]);

  // ---- Manual "add a subscription" form ----
  // The detector only auto-creates a row after 2+ charges at a stable
  // cadence. A subscription billed only once (HealthTrackRx) needs this.
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addAmount, setAddAmount] = useState("");
  const [addCadence, setAddCadence] = useState(30);
  const [addType, setAddType] = useState<SubscriptionType>("other");
  const createSub = useMutation({
    mutationFn: () =>
      api.createSubscription({
        name: addName.trim(),
        amount_cents: Math.round(parseFloat(addAmount || "0") * 100),
        cadence_days: addCadence,
        subscription_type: addType,
      }),
    onSuccess: () => {
      setAddOpen(false);
      setAddName("");
      setAddAmount("");
      setAddCadence(30);
      setAddType("other");
      invalidate();
    },
  });

  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const detect = useMutation({
    mutationFn: api.detectSubscriptions,
    onSuccess: (counts) => {
      invalidate();
      // Build a "Detected X / Confirmed Y / Suspected Z" summary so
      // the user gets feedback even when nothing new appeared.
      const parts: string[] = [];
      const total = (counts as Record<string, number>).total ?? null;
      const created = (counts as Record<string, number>).created ?? null;
      const updated = (counts as Record<string, number>).updated ?? null;
      const suspected = (counts as Record<string, number>).suspected ?? null;
      if (created !== null) parts.push(`${created} new`);
      if (updated !== null) parts.push(`${updated} updated`);
      if (suspected !== null) parts.push(`${suspected} suspected`);
      if (total !== null) parts.push(`${total} total in window`);
      setDetectMsg(
        parts.length
          ? `Detector ran: ${parts.join(" · ")}`
          : `Detector ran. Counts: ${JSON.stringify(counts)}`,
      );
    },
    onError: (e: unknown) => {
      setDetectMsg(`Detector error: ${e instanceof Error ? e.message : String(e)}`);
    },
  });
  // Wave E-6: trigger the Playwright run that pulls real plan-tier
  // data from carrier portals (Xfinity for now). After it succeeds,
  // re-fetch overlaps so the badges/confidence reflect the new
  // snapshot. Auth-missing is surfaced inline so the user knows to
  // run the one-time bootstrap.
  const [tierScrapeMsg, setTierScrapeMsg] = useState<string | null>(null);
  // Phase F: which composite parent's unmask modal is currently open.
  // null = closed; otherwise the parent's id. The modal is a child
  // component that fetches its own unmask payload by id.
  const [unmaskingId, setUnmaskingId] = useState<number | null>(null);
  const scrapeTiers = useMutation({
    mutationFn: api.scrapePlanTiers,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["bundle-overlaps"] });
      const summary = r.sites
        .map((s) => {
          if (s.status === "ok") {
            return `${s.site_key}: ${s.snapshots_saved} snapshot${s.snapshots_saved === 1 ? "" : "s"} (${s.plan_summary.join(" · ") || "no perks detected"})`;
          }
          if (s.status === "auth_missing") {
            return `${s.site_key}: needs login — run \`py -m finance_app.scrapers.plan_tiers.bootstrap ${s.site_key}\` once`;
          }
          if (s.status === "no_data") {
            return `${s.site_key}: portal loaded but no plan card found`;
          }
          return `${s.site_key}: error (${s.error ?? "unknown"})`;
        })
        .join(" · ");
      setTierScrapeMsg(summary);
    },
    onError: (e: unknown) => {
      setTierScrapeMsg(e instanceof Error ? e.message : String(e));
    },
  });
  const confirm = useMutation({
    mutationFn: api.confirmSubscription,
    onSuccess: invalidate,
  });
  const dismiss = useMutation({
    mutationFn: api.dismissSubscription,
    onSuccess: invalidate,
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: SubscriptionStatus }) =>
      api.setSubscriptionStatus(id, status),
    onSuccess: invalidate,
  });
  const setType = useMutation({
    mutationFn: ({ id, type }: { id: number; type: SubscriptionType }) =>
      api.setSubscriptionType(id, type),
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: api.deleteSubscription,
    onSuccess: invalidate,
  });

  // Two-stage delete with 5s undo. Replaces window.confirm("Delete this
  // subscription row?") which was blocking and flagged in the button audit.
  const undoDelete = useUndoableDelete<Subscription>({
    commit: (id) => del.mutate(id as number),
    describe: (s) => `Subscription "${s.name}" deleted`,
  });
  const applyPromos = useMutation({
    mutationFn: api.applySubscriptionPromos,
    onSuccess: (r) => {
      setApplyResult(
        `Scanned ${r.scanned} email${r.scanned === 1 ? "" : "s"} · ${r.price_changes_applied} price change${r.price_changes_applied === 1 ? "" : "s"} applied · ${r.promos_seen} promo${r.promos_seen === 1 ? "" : "s"} seen${r.unlinked ? ` · ${r.unlinked} unlinked` : ""}`
      );
      invalidate();
    },
    onError: () => setApplyResult("Failed to apply promo signals"),
  });

  const visible = useMemo(
    () =>
      filterByTab(subs.data ?? [], tab).filter(
        (s) => undoDelete.pending?.id !== s.id,
      ),
    [subs.data, tab, undoDelete.pending],
  );

  // Tab counts for the strip — only counts rows that the tab would show.
  const counts = useMemo(() => {
    const out: Partial<Record<TabKey, number>> = {};
    for (const t of TABS) {
      out[t.key] = filterByTab(subs.data ?? [], t.key).length;
    }
    return out;
  }, [subs.data]);

  // Sprint 31 — celebration toasts on cancel/dismiss with a price.
  // The hook owns the queue; CelebrationToastStack is mounted in the
  // panel's JSX root so multiple events can stack visibly.
  const celebrate = useCelebrate();

  // Helper: fire a "$X/mo saved" celebration when the user cancels or
  // dismisses a subscription that has a positive monthly cost. Skips
  // free / $0 rows (the discovery-flow rows that haven't been priced
  // yet) since "$0 saved" is the opposite of delightful.
  function _celebrateCancel(id: number, kind: "cancel_sub" | "dismiss_sub") {
    const row = (subs.data ?? []).find((s) => s.id === id);
    if (!row) return;
    const rawCents = Math.abs(
      row.last_amount_cents ?? row.amount_cents ?? 0,
    );
    if (rawCents <= 0) return;
    // Normalize to a per-month equivalent — annual subs divide by 12.
    const monthlyCents = Math.round(
      rawCents * (30 / Math.max(row.cadence_days ?? 30, 1)),
    );
    if (monthlyCents <= 0) return;
    celebrate.celebrate({
      kind,
      label: row.name,
      monthlyCents,
    });
  }

  const actions: RowActions = {
    onConfirm: (id) => confirm.mutate(id),
    onDismiss: (id) => {
      _celebrateCancel(id, "dismiss_sub");
      dismiss.mutate(id);
    },
    onCancel: (id) => {
      _celebrateCancel(id, "cancel_sub");
      setStatus.mutate({ id, status: "cancelled" });
    },
    onSetType: (id, type) => setType.mutate({ id, type }),
    onDelete: (id) => {
      // Two-stage delete: stage the row, show 5s undo toast. The toast's
      // commit fires the actual del.mutate. Replaces a window.confirm()
      // that was blocking and breaking automated audits.
      const row = (subs.data ?? []).find((s) => s.id === id);
      if (row) undoDelete.stage(row);
    },
  };

  return (
    <div>
      <div className="flex justify-end mb-2">
        <SyncFreshnessChip
          syncedAt={subs.dataUpdatedAt > 0 ? new Date(subs.dataUpdatedAt).toISOString() : null}
          label="Last fetched"
        />
      </div>
      <StatsHeader stats={stats.data} />

      {/* Sprint 18 — net-of-bundle banner. When we've detected the user
          is paying for a perk standalone that's also bundled into a
          parent plan (e.g. Peacock standalone + Xfinity Mobile bundle),
          surface the headline "you're paying twice — save $X" so it's
          impossible to miss. Self-hides when there are no overlaps. */}
      <BundleOverlapBanner />
      <TrendAlertBanner />

      {/* Phase F-6 — active-prompt strip. Surfaces one ranked question
          at a time (confirm-sub or unmask-composite). The banner self-
          hides when there's nothing to ask. */}
      <NeedsInputBanner onUnmask={setUnmaskingId} />

      {/* Tab strip */}
      <div className="flex flex-wrap gap-1 mb-3">
        {TABS.map((t) => {
          const count = counts[t.key] ?? 0;
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              title={t.hint}
              className={`px-3 py-1.5 rounded text-xs font-semibold border transition-colors ${
                isActive
                  ? "bg-brand text-white border-brand"
                  : "bg-card text-text-muted border-border hover:border-brand hover:text-brand"
              }`}
            >
              {t.label}
              {count > 0 && (
                <span
                  className={`ml-1.5 tabular-nums ${
                    // Sprint 50 — text-white/80 on bg-brand was 3.44:1
                    // (fails WCAG AA). Bumped to full white (5.6:1) so
                    // the count badge inside the active tab is readable.
                    isActive ? "text-white" : "text-text-soft"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
        <div className="flex-1" />
        <button
          onClick={() => setAddOpen((v) => !v)}
          className="px-3 py-1.5 rounded text-xs font-semibold border border-border bg-card text-text-muted hover:border-brand hover:text-brand"
          title="Manually add a subscription the detector can't see yet (e.g. only one charge so far)"
        >
          + Add manually
        </button>
        <button
          onClick={() => applyPromos.mutate()}
          disabled={applyPromos.isPending}
          className="px-3 py-1.5 rounded text-xs font-semibold border border-border bg-card text-text-muted hover:border-brand hover:text-brand disabled:opacity-60"
          title="Scan recent T2-parsed Gmail messages and apply promo / price-change signals"
        >
          {applyPromos.isPending ? "Applying…" : "Apply email signals"}
        </button>
        <button
          onClick={() => scrapeTiers.mutate()}
          disabled={scrapeTiers.isPending}
          className="px-3 py-1.5 rounded text-xs font-semibold border border-fuchsia-300 bg-fuchsia-50 text-fuchsia-800 hover:bg-fuchsia-100 disabled:opacity-60"
          title="Run Playwright against Xfinity (and other carriers) to pull your real plan tier. Bundle overlap badges become high-confidence after this succeeds."
        >
          {scrapeTiers.isPending ? "Scraping…" : "Sync plan tiers"}
        </button>
        <button
          onClick={() => detect.mutate()}
          disabled={detect.isPending}
          className="px-3 py-1.5 rounded text-xs font-semibold bg-brand text-white hover:bg-brand-navy disabled:opacity-60"
        >
          {detect.isPending ? "Detecting…" : "Re-detect"}
        </button>
      </div>

      {addOpen && (
        <div className="mb-3 px-4 py-3 bg-card border border-border rounded-md">
          <h3 className="text-xs font-bold text-text mb-2">
            Add a subscription manually
          </h3>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-text-muted">
              Name
              <input
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="e.g. HealthTrackRx"
                className="border border-border rounded px-2 py-1 text-xs bg-card w-48 text-text"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-text-muted">
              Amount per charge
              <input
                type="number"
                min="0"
                step="0.01"
                value={addAmount}
                onChange={(e) => setAddAmount(e.target.value)}
                placeholder="25.00"
                className="border border-border rounded px-2 py-1 text-xs bg-card w-28 text-text"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-text-muted">
              Cadence
              <select
                value={addCadence}
                onChange={(e) => setAddCadence(Number(e.target.value))}
                className="border border-border rounded px-2 py-1 text-xs bg-card text-text"
              >
                <option value={7}>Weekly</option>
                <option value={30}>Monthly</option>
                <option value={90}>Quarterly</option>
                <option value={365}>Annual</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-text-muted">
              Type
              <select
                value={addType}
                onChange={(e) => setAddType(e.target.value as SubscriptionType)}
                className="border border-border rounded px-2 py-1 text-xs bg-card text-text"
              >
                {([
                  "streaming", "saas", "news_media", "utilities",
                  "internet", "telecom", "insurance", "fitness",
                  "storage", "gaming", "other",
                ] as SubscriptionType[]).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!addName.trim() || !addAmount || createSub.isPending}
              onClick={() => createSub.mutate()}
              className="px-3 py-1.5 rounded text-xs font-semibold bg-brand text-white hover:bg-brand-navy disabled:opacity-40"
            >
              {createSub.isPending ? "Adding\u2026" : "Add subscription"}
            </button>
            <button
              type="button"
              onClick={() => setAddOpen(false)}
              className="px-2 py-1.5 text-xs text-text-muted hover:text-text"
            >
              Cancel
            </button>
          </div>
          {createSub.isError && (
            <div className="text-[11px] text-outflow mt-1">
              Couldn't add the subscription \u2014 check the name and amount.
            </div>
          )}
        </div>
      )}

      {applyResult && (
        <div className="mb-3 px-3 py-2 bg-brand-light/40 border border-brand-light rounded text-xs text-brand-navy">
          {applyResult}
        </div>
      )}

      {tierScrapeMsg && (
        <div className="mb-3 px-3 py-2 bg-fuchsia-50 border border-fuchsia-200 rounded text-xs text-fuchsia-900">
          {tierScrapeMsg}
        </div>
      )}

      {detectMsg && (
        <div className="mb-3 px-3 py-2 bg-brand-light/40 border border-brand-light rounded text-xs text-brand-navy">
          {detectMsg}
        </div>
      )}

      {/* Table */}
      <div className="bg-card border border-border rounded-md shadow-card overflow-hidden">
        <table className="w-full">
          <thead className="bg-hover border-b border-border">
            <tr className="text-text-muted text-[11px] font-semibold uppercase tracking-wide">
              <th className="px-4 py-2 text-left">Subscription</th>
              <th className="px-4 py-2 text-left">Status</th>
              <th className="px-4 py-2 text-left">Cadence</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2 text-left">Next charge</th>
              <th className="px-4 py-2 text-right" />
            </tr>
          </thead>
          <tbody>
            {subs.isLoading && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-text-muted text-sm">
                  Loading…
                </td>
              </tr>
            )}
            {!subs.isLoading && visible.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-text-muted text-sm">
                  {(subs.data ?? []).length === 0
                    ? <>No subscriptions detected yet. Click <em>Re-detect</em>.</>
                    : "Nothing in this bucket."}
                </td>
              </tr>
            )}
            {visible.map((s) => (
              <SubRow
                key={s.id}
                sub={s}
                actions={actions}
                bundleHint={bundleByPerkId.get(s.id)}
                onUnmask={setUnmaskingId}
              />
            ))}
          </tbody>
        </table>
      </div>

      {unmaskingId !== null && (
        <UnmaskModal
          parentId={unmaskingId}
          onClose={() => setUnmaskingId(null)}
        />
      )}

      {undoDelete.pending && (
        <UndoToast message={undoDelete.message} onUndo={undoDelete.cancel} />
      )}
      {/* Sprint 31 — green celebratory toast(s) on cancel/dismiss
          with a positive monthly cost. Stacks; auto-fades. */}
      <CelebrationToastStack events={celebrate.events} />
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Unmask modal — Phase F                                             */
/* ------------------------------------------------------------------ */

function UnmaskModal({
  parentId,
  onClose,
}: {
  parentId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const unmask = useQuery({
    queryKey: ["unmask", parentId],
    queryFn: () => api.unmaskSubscription(parentId),
    staleTime: 0,
  });

  // Sprint 5 — fetch ranked guesses for what's inside the composite.
  // Cross-references the parent's unique charge amounts against the
  // service catalog and Gmail sender signals. Click a chip and the
  // draft form below pre-fills with that suggestion's name + amount.
  const suggestions = useQuery({
    queryKey: ["unmask-suggestions", parentId],
    queryFn: () => api.unmaskSuggestions(parentId),
    staleTime: 60 * 1000, // suggestions don't change quickly
    retry: false,
  });

  // Local form state for the "Add line item" inline form. Three small
  // inputs — name, $ amount, optional notes — minimum signal we need
  // to make the child useful to the bundle detector + retention engine.
  const [draft, setDraft] = useState<{ name: string; amount: string; notes: string }>(
    { name: "", amount: "", notes: "" },
  );

  const addChild = useMutation({
    mutationFn: (payload: CompositeChildIn) => api.addCompositeChild(parentId, payload),
    onSuccess: () => {
      // Refetch the unmask payload + the main subscription list so totals update.
      qc.invalidateQueries({ queryKey: ["unmask", parentId] });
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["subscription-stats"] });
      qc.invalidateQueries({ queryKey: ["bundle-overlaps"] });
      // F-6: once the parent has a child, the "unmask this composite"
      // prompt no longer applies; refresh so the strip drops it.
      qc.invalidateQueries({ queryKey: ["subscription-prompts"] });
      // Sprint 5: refresh suggestions so the chip the user just clicked
      // (or one matching the same amount) doesn't redundantly re-appear.
      qc.invalidateQueries({ queryKey: ["unmask-suggestions", parentId] });
      setDraft({ name: "", amount: "", notes: "" });
    },
  });

  const removeChild = useMutation({
    mutationFn: (id: number) => api.deleteSubscription(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["unmask", parentId] });
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["bundle-overlaps"] });
      qc.invalidateQueries({ queryKey: ["subscription-prompts"] });
      qc.invalidateQueries({ queryKey: ["unmask-suggestions", parentId] });
    },
  });

  // Two-stage delete + undo on the children list. Replaces a
  // window.confirm("Remove ${name}?") which blocked the browser.
  const undoRemoveChild = useUndoableDelete<Subscription>({
    commit: (id) => removeChild.mutate(id as number),
    describe: (c) => `Removed "${c.name}"`,
  });

  const data: CompositeUnmaskResponse | undefined = unmask.data;
  const dollarsToCents = (s: string): number | null => {
    const parsed = parseFloat(s.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed * 100);
  };
  const draftCents = dollarsToCents(draft.amount);
  const canSubmit = draft.name.trim().length > 0 && draftCents !== null && !addChild.isPending;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-md shadow-xl border border-border w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-text">
              {data?.aggregator_label ?? "Unmask composite charge"}
            </h2>
            <p className="text-xs text-text-muted mt-0.5">
              {data
                ? <>Declare what's bundled inside <span className="font-mono">{data.parent.name}</span>. Each line item flows into bundle detection and retention playbooks just like a standalone sub.</>
                : "Loading…"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text px-2 text-lg leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {data && data.hint_questions.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-900 space-y-1">
              {data.hint_questions.map((q, i) => (
                <div key={i}>{q}</div>
              ))}
            </div>
          )}

          {data && (
            <div className="grid grid-cols-3 gap-3 text-xs">
              <div className="bg-card border border-border rounded p-2">
                <div className="text-text-muted uppercase tracking-wide">Parent total</div>
                <div className="text-text font-semibold tabular-nums mt-0.5">
                  {fmtCents(-Math.abs(data.parent_total_cents))}
                </div>
              </div>
              <div className="bg-card border border-border rounded p-2">
                <div className="text-text-muted uppercase tracking-wide">Declared</div>
                <div className="text-text font-semibold tabular-nums mt-0.5">
                  {fmtCents(-Math.abs(data.declared_total_cents))}
                </div>
              </div>
              <div className="bg-card border border-border rounded p-2">
                <div className="text-text-muted uppercase tracking-wide">Unaccounted</div>
                <div
                  className={`font-semibold tabular-nums mt-0.5 ${
                    Math.abs(data.unaccounted_cents) > 200 ? "text-warn" : "text-text-soft"
                  }`}
                >
                  {fmtCents(-Math.abs(data.unaccounted_cents))}
                </div>
              </div>
            </div>
          )}

          {data && data.children.length > 0 && (
            <div className="border border-border rounded">
              <div className="px-3 py-2 border-b border-border bg-hover text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Declared line items ({data.children.length})
              </div>
              <ul>
                {data.children
                  .filter((c) => undoRemoveChild.pending?.id !== c.id)
                  .map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border last:border-0 text-sm"
                    >
                      <div className="flex-1">
                        <div className="font-medium text-text">{c.name}</div>
                        {c.notes && (
                          <div className="text-[11px] text-text-soft mt-0.5">{c.notes}</div>
                        )}
                      </div>
                      <div className="tabular-nums font-semibold text-outflow">
                        {fmtCents(c.last_amount_cents ?? c.amount_cents)}
                      </div>
                      <button
                        onClick={() => undoRemoveChild.stage(c)}
                        className="text-[11px] text-text-muted hover:text-outflow px-1"
                        aria-label={`Remove ${c.name}`}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {/* Sprint 5 — suggestion chips. Each is a one-click prefill
              of the line-item form below. The backend cross-references
              the parent's charge amounts against the service catalog
              AND the user's Gmail sender history, so chips with both
              signals appear first. Empty state hides the strip. */}
          {suggestions.data && suggestions.data.suggestions.length > 0 && (
            <div className="border border-border rounded p-3 space-y-2 bg-brand-light/30">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">
                Suggestions · click to pre-fill
              </div>
              <div className="flex flex-wrap gap-2">
                {suggestions.data.suggestions.map((s) => {
                  const conf = Math.round(s.confidence * 100);
                  const dollars = (Math.abs(s.amount_cents) / 100).toFixed(2);
                  // Sprint 6 — when we have a Gmail content signal,
                  // surface the email subject so the user can verify
                  // the guess by clicking through to their own inbox.
                  // High-evidence chips get a green check + the subject
                  // preview, separating them visually from price-only
                  // guesses.
                  const hasEvidence = s.evidence !== null;
                  const evidenceDate = s.evidence
                    ? new Date(s.evidence.received_at).toLocaleDateString(
                        undefined,
                        { month: "short", day: "numeric" },
                      )
                    : null;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() =>
                        setDraft({
                          name: s.name,
                          amount: dollars,
                          notes: s.reason,
                        })
                      }
                      title={s.reason}
                      className={`text-left px-2.5 py-1.5 rounded border transition-colors ${
                        hasEvidence
                          ? "border-inflow/40 bg-emerald-50/40 hover:border-inflow hover:bg-emerald-50"
                          : "border-border bg-card hover:border-brand hover:bg-brand-light/60"
                      }`}
                    >
                      <div className="text-xs font-semibold text-text">
                        {hasEvidence && (
                          <span
                            className="text-inflow mr-1"
                            aria-label="Evidence-backed"
                          >
                            ✓
                          </span>
                        )}
                        {s.name}{" "}
                        <span className="text-text-muted font-normal">
                          · ${dollars}/mo
                        </span>
                      </div>
                      <div className="text-[10px] text-text-soft mt-0.5">
                        {conf}% · {s.reason}
                      </div>
                      {s.evidence && (
                        <div className="text-[10px] text-text-soft mt-1 italic truncate max-w-xs">
                          "{(s.evidence.subject || s.evidence.snippet || "").slice(0, 80)}"
                          {evidenceDate ? ` · ${evidenceDate}` : ""}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="text-[10px] text-text-soft">
                Sources: known service prices + your Gmail sender history.
                Confidence rises when both signals agree.
              </div>
            </div>
          )}

          <form
            className="border border-border rounded p-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit || draftCents === null) return;
              addChild.mutate({
                name: draft.name.trim(),
                amount_cents: draftCents,
                notes: draft.notes.trim() || undefined,
              });
            }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Add a line item
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <input
                type="text"
                placeholder="What's the sub? (e.g. Peacock)"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="px-2 py-1.5 text-sm border border-border rounded md:col-span-1"
                autoFocus
              />
              <input
                type="number"
                step={0.01}
                min={0.01}
                placeholder="Monthly $ (e.g. 14.99)"
                value={draft.amount}
                onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                className="px-2 py-1.5 text-sm border border-border rounded md:col-span-1"
              />
              <input
                type="text"
                placeholder="Notes (optional)"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                className="px-2 py-1.5 text-sm border border-border rounded md:col-span-1"
              />
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[11px] text-text-soft">
                Children inherit cadence from the parent ({data?.parent.cadence_label ?? "monthly"}).
              </span>
              <button
                type="submit"
                disabled={!canSubmit}
                className="px-3 py-1.5 text-xs font-semibold rounded bg-brand text-white hover:bg-brand-navy disabled:opacity-50"
              >
                {addChild.isPending ? "Adding…" : "Add line item"}
              </button>
            </div>
            {addChild.isError && (
              <div className="text-xs text-outflow">
                Failed to add: {addChild.error instanceof Error ? addChild.error.message : "unknown error"}
              </div>
            )}
          </form>
        </div>

        <div className="px-5 py-3 border-t border-border bg-hover flex justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-semibold rounded border border-border bg-card text-text-muted hover:border-brand hover:text-brand"
          >
            Done
          </button>
        </div>
      </div>
      {undoRemoveChild.pending && (
        <UndoToast message={undoRemoveChild.message} onUndo={undoRemoveChild.cancel} />
      )}
    </div>
  );
}
