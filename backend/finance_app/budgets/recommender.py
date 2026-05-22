"""Budget recommendation engine — Wave G, Sprint G-4.

Produces ranked, actionable recommendations across four signals:

  1. **Overspend** — categories where the 3-month rolling spend exceeds
     a typical baseline (the user's own budget cap, or the 12-month
     long-run average). Recommend a specific cap.

  2. **Goal-driven** — for each Goal with a target_date, compute the
     per-month savings needed to hit it. If the user's monthly net
     flow can't cover all goals, recommend the cuts needed.

  3. **Subscription duplicates** — reuse the Wave E bundle overlap
     detector. Each overlap becomes a "you're paying twice for X"
     recommendation with the bundle child as the savings target.

  4. **Yield-shift** — reuse the Yield Optimization panel's logic.
     Idle checking-balance > $X at < 1% APY is a free monthly-income
     uplift if moved to T-bills.

Each recommendation carries:
  * ``kind`` — stable enum string (overspend / goal / bundle_dup / yield_shift)
  * ``priority`` — float 0..1, used by the UI to sort
  * ``expected_monthly_impact_cents`` — signed; positive = $-saved per month
  * ``title`` / ``body`` — display copy
  * ``apply`` — optional override-style payload the UI can pass to
    /api/budgets/project to model the change in the what-if scenario.

The list is sorted by descending impact so the highest-leverage moves
land at the top of the panel.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


@dataclass
class CategoryOverridePayload:
    """Shape of the override the UI sends back into /api/budgets/project
    if the user clicks "Apply to scenario". Keyed by category for
    overspend recs; goal recs carry a per-goal contribution map."""
    category_overrides: dict[int, int] = field(default_factory=dict)
    # G-11 — per-goal contribution map (goal_id → monthly_cents).
    # Replaces the previous single scalar so multiple goal recs can
    # compose. Each one only sets its own goal_id; the parent merges.
    goal_contributions: dict[int, int] = field(default_factory=dict)
    # Legacy — kept so older callers/tests don't blow up. Whoever
    # wires up goal recs today should populate `goal_contributions`
    # instead; this scalar is summed into the projection by the API
    # endpoint as a fallback when `goal_contributions` is empty.
    monthly_investment_contribution_cents: int = 0


@dataclass
class Recommendation:
    kind: str
    title: str
    body: str
    expected_monthly_impact_cents: int
    priority: float
    apply: CategoryOverridePayload | None = None
    # Free-form metadata the UI can use without growing the type union
    # (e.g. goal_id, bundle_overlap_id, source_subscription_ids).
    meta: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "title": self.title,
            "body": self.body,
            "expected_monthly_impact_cents": self.expected_monthly_impact_cents,
            "priority": round(self.priority, 4),
            "apply": (
                {
                    "category_overrides": self.apply.category_overrides,
                    "goal_contributions": self.apply.goal_contributions,
                    "monthly_investment_contribution_cents": self.apply.monthly_investment_contribution_cents,
                }
                if self.apply
                else None
            ),
            "meta": self.meta,
        }


# ----------------------------------------------------------------------
#  Signal 1 — overspend categories
# ----------------------------------------------------------------------

# Categories that aren't real "spending" — they're transfers, debt
# service, or income flows that the user can't realistically "cap"
# without it being a much bigger decision (e.g. miss a credit card
# payment to save money). Match by lowercase substring.
_TRANSFER_CATEGORY_PATTERNS = (
    "credit card payment",
    "credit card",
    "transfer",
    "loan payment",
    "mortgage payment",
    "tax payment",
    "irs",
    "401k",
    "ira contribution",
    "investment contribution",
    "savings transfer",
    "atm withdrawal",
)


def _is_transfer_category(name: str) -> bool:
    """True if a category name matches a known transfer / debt-service
    / income pattern that shouldn't surface as overspend."""
    if not name:
        return False
    lower = name.lower()
    return any(p in lower for p in _TRANSFER_CATEGORY_PATTERNS)


def _overspend_recs(db: Session) -> list[Recommendation]:
    """Find categories where last 3-month rolling spend exceeds the
    current budget cap (if any) OR exceeds the user's own 12-month
    long-run average by 20%+. Recommend trimming to the lower of (cap,
    rolling avg).
    """
    from finance_app.db.models import Budget, Category, Transaction

    today = date.today()
    month_start = today.replace(day=1)
    three_mo_ago = month_start - timedelta(days=90)
    twelve_mo_ago = month_start - timedelta(days=365)

    # Per-category 3-month rolling outflow.
    three_mo_rows = db.execute(
        select(
            Transaction.category_id,
            Category.name,
            func.sum(Transaction.amount_cents).label("amt"),
        )
        .join(Category, Category.id == Transaction.category_id, isouter=True)
        .where(Transaction.amount_cents < 0)
        .where(Transaction.posted_date >= three_mo_ago)
        .where(Transaction.category_id.is_not(None))
        .group_by(Transaction.category_id, Category.name)
    ).all()

    # Per-category 12-month long-run baseline.
    twelve_mo_avg: dict[int, int] = {}
    twelve_mo_rows = db.execute(
        select(
            Transaction.category_id,
            func.sum(Transaction.amount_cents).label("amt"),
        )
        .where(Transaction.amount_cents < 0)
        .where(Transaction.posted_date >= twelve_mo_ago)
        .where(Transaction.category_id.is_not(None))
        .group_by(Transaction.category_id)
    ).all()
    for row in twelve_mo_rows:
        twelve_mo_avg[row.category_id] = abs(row.amt or 0) // 12  # monthly avg

    # Current budgets keyed by category.
    current_budgets = {
        b.category_id: b.amount_cents
        for b in db.execute(
            select(Budget).where(Budget.month_start == month_start)
        ).scalars().all()
    }

    recs: list[Recommendation] = []
    for row in three_mo_rows:
        cat_id = row.category_id
        if cat_id is None:
            continue
        # Skip transfer/debt-service categories — capping them is a
        # different kind of decision than capping discretionary spend.
        if _is_transfer_category(row.name or ""):
            continue
        # Three-month rolling avg, normalized to monthly cents.
        rolling_avg_monthly = abs(row.amt or 0) // 3
        cap = current_budgets.get(cat_id)
        long_run_avg = twelve_mo_avg.get(cat_id, 0)

        # Two trigger paths:
        #  (a) rolling > cap (the user said "I want to cap at $X" but
        #      they've been doing > $X/mo for the last 3 months).
        #  (b) rolling > 1.2 × long-run (uptick of 20%+ vs their own
        #      stable history — likely lifestyle creep).
        target_cap = None
        reason = ""
        if cap is not None and rolling_avg_monthly > cap and rolling_avg_monthly - cap >= 1_000:
            # Cap is $X but spending is $Y > X. Recommend hitting the cap.
            target_cap = cap
            reason = f"You set a {_dollars(cap)}/mo cap but the last 3 months ran {_dollars(rolling_avg_monthly)}/mo."
        elif long_run_avg > 0 and rolling_avg_monthly > long_run_avg * 1.2 and rolling_avg_monthly - long_run_avg >= 2_500:
            # No cap, but rolling avg climbed 20%+ vs long-run. Cap at
            # the 12-month avg.
            target_cap = long_run_avg
            reason = (
                f"Last 3 months ran {_dollars(rolling_avg_monthly)}/mo — "
                f"~{int((rolling_avg_monthly / long_run_avg - 1) * 100)}% above your 12-month average of {_dollars(long_run_avg)}/mo."
            )
        else:
            continue

        impact = rolling_avg_monthly - target_cap
        if impact < 500:  # < $5/mo isn't worth surfacing
            continue
        recs.append(
            Recommendation(
                kind="overspend",
                title=f"{row.name}: cap at {_dollars(target_cap)}/mo",
                body=reason,
                expected_monthly_impact_cents=impact,
                # Priority is the impact (capped at $1000/mo as max signal).
                priority=min(1.0, impact / 100_000),
                apply=CategoryOverridePayload(
                    category_overrides={cat_id: target_cap},
                ),
                meta={"category_id": cat_id, "rolling_avg_monthly_cents": rolling_avg_monthly},
            )
        )
    return recs


# ----------------------------------------------------------------------
#  Signal 2 — goal-driven
# ----------------------------------------------------------------------

def _goal_recs(db: Session, monthly_net_flow_cents: int) -> list[Recommendation]:
    """For each Goal with a target_date in the future, compute the
    per-month contribution needed to hit it on time. If the user's
    monthly net flow can't fund the goal, flag the gap.
    """
    from finance_app.db.models import Goal

    today = date.today()
    goals = db.execute(
        select(Goal)
        .where(Goal.target_date.is_not(None))
        .where(Goal.target_amount_cents > 0)
    ).scalars().all()

    recs: list[Recommendation] = []
    for g in goals:
        if g.target_date is None or g.target_date <= today:
            continue
        gap_cents = g.target_amount_cents - (g.current_amount_cents or 0)
        if gap_cents <= 0:
            continue
        months_left = max(1, (g.target_date.year - today.year) * 12 + (g.target_date.month - today.month))
        needed_monthly = gap_cents // months_left
        if needed_monthly < 1_000:
            continue
        priority_score = min(1.0, needed_monthly / 100_000)
        if monthly_net_flow_cents >= needed_monthly:
            # User can afford it — frame as "set up the auto-contribution".
            title = f"Auto-contribute {_dollars(needed_monthly)}/mo to {g.name}"
            body = (
                f"Goal: {_dollars(g.target_amount_cents)} by "
                f"{g.target_date.strftime('%b %Y')} ({months_left} months left). "
                f"You currently have {_dollars(g.current_amount_cents or 0)} saved "
                f"and {_dollars(monthly_net_flow_cents)}/mo to deploy."
            )
        else:
            # Can't afford it — flag the deficit.
            deficit = needed_monthly - max(0, monthly_net_flow_cents)
            title = f"{g.name} needs +{_dollars(deficit)}/mo more"
            body = (
                f"Goal: {_dollars(g.target_amount_cents)} by "
                f"{g.target_date.strftime('%b %Y')} requires {_dollars(needed_monthly)}/mo. "
                f"Your current net flow is {_dollars(max(0, monthly_net_flow_cents))}/mo, "
                f"so you're short {_dollars(deficit)}/mo. Trim from the overspend categories below to close the gap."
            )
        recs.append(
            Recommendation(
                kind="goal",
                title=title,
                body=body,
                expected_monthly_impact_cents=needed_monthly,
                priority=priority_score,
                apply=CategoryOverridePayload(
                    # G-11 — populate the per-goal map so multiple goal
                    # recs can compose. The parent merges these into a
                    # global goal_contributions dict that's passed to
                    # the project endpoint.
                    goal_contributions={g.id: needed_monthly},
                ),
                meta={
                    "goal_id": g.id,
                    "goal_name": g.name,
                    "months_left": months_left,
                    "needed_monthly_cents": needed_monthly,
                },
            )
        )
    return recs


# ----------------------------------------------------------------------
#  Signal 3 — subscription bundle duplicates
# ----------------------------------------------------------------------

def _bundle_recs(db: Session) -> list[Recommendation]:
    """Reuse the Wave E bundle overlap detector. Each overlap becomes
    a recommendation: "you're paying for X standalone AND it's bundled
    in Y — cancel the standalone." Uses BundleOverlap's perk_monthly_cents
    (what the user pays for the redundant standalone sub)."""
    try:
        from finance_app.bundles.detector import detect_overlaps
    except ImportError:
        logger.info("bundle detector not importable — skipping bundle recs")
        return []

    try:
        overlaps = detect_overlaps(db)
    except Exception as exc:  # noqa: BLE001 — never fail the recommender
        logger.warning("bundle detector failed: %r", exc)
        return []

    recs: list[Recommendation] = []
    for overlap in overlaps:
        monthly_savings = overlap.perk_monthly_cents or 0
        if monthly_savings < 500:
            continue
        recs.append(
            Recommendation(
                kind="bundle_dup",
                title=f"Cancel standalone {overlap.perk_label}",
                body=(
                    f"{overlap.perk_label} is bundled in your {overlap.parent_label} "
                    f"plan. Cancelling the standalone saves "
                    f"{_dollars(monthly_savings)}/mo (~{_dollars(monthly_savings * 12)}/yr)."
                ),
                expected_monthly_impact_cents=monthly_savings,
                priority=min(1.0, overlap.confidence * (monthly_savings / 100_000)),
                apply=None,  # no budget-category cut; the savings come from the sub cancel
                meta={
                    "subscription_id": overlap.perk_subscription_id,
                    "parent_label": overlap.parent_label,
                    "perk_label": overlap.perk_label,
                    "annual_savings_cents": overlap.annual_savings_cents,
                    "confidence": overlap.confidence,
                },
            )
        )
    return recs


# ----------------------------------------------------------------------
#  Signal 4 — store-swap (Sprint G-12)
# ----------------------------------------------------------------------

def _store_swap_recs(db: Session) -> list[Recommendation]:
    """G-12 — Cross-store deal findings, lifted into the Budget panel.

    Pipeline:
      Receipts → ReceiptItem (via OCR or vision) → canonical product
      matcher → RecurringPurchase rolls up "you buy X every Y weeks
      at $Z at Merchant M" → PriceObservation tracks alternative-store
      prices → find_deals() surfaces "Walmart has it for $X.XX, you
      typically pay $Y.YY at Whole Foods."

    Each beats-baseline finding becomes a Recommendation. The
    annualized savings drive ranking — small per-trip wins amortize
    to real money over a year of weekly trips.

    Why this lives in the Budgets recommender (and not just Money on
    the Table): the user asked for a feedback loop where receipts
    drive budget decisions. By surfacing the same cross-store findings
    inside the Budgets recommendations panel, the user can compare a
    "cap restaurants" rec against a "switch grocery stores" rec on
    the same $-impact-per-month scale.
    """
    try:
        from finance_app.deals import find_deals
    except ImportError:
        logger.info("deals detector not importable — skipping store_swap recs")
        return []

    try:
        deals = find_deals(db)
    except Exception as exc:  # noqa: BLE001
        logger.warning("deals detector failed: %r", exc)
        return []

    recs: list[Recommendation] = []
    for d in deals:
        # Surface only material deals — < $5/mo savings isn't worth a
        # store-switching trip, and the user already has the bigger
        # cross-store list in the Money on Table panel.
        annual = d.annual_savings_cents or 0
        if annual < 6_000:  # $5/mo × 12 ≈ $60/yr floor
            continue
        monthly = annual // 12
        title = f"Swap to {d.deal_merchant} for {d.pattern_name[:50]}"
        body = (
            f"{d.deal_merchant} had it for ${d.deal_price_cents/100:.2f} on "
            f"{d.observed_at.isoformat()} — you typically pay "
            f"${d.baseline_cents/100:.2f} at {d.pattern_merchant or 'your usual store'}. "
            f"Save ~${d.savings_cents/100:.2f} per trip "
            f"(~${monthly/100:.0f}/mo, ${annual/100:.0f}/yr at your buying rhythm)."
        )
        recs.append(
            Recommendation(
                kind="store_swap",
                title=title,
                body=body,
                expected_monthly_impact_cents=monthly,
                priority=min(1.0, monthly / 100_000),
                # No category-cut override — this is a behavioral change
                # ("buy at different store"), not a budget cap change.
                apply=None,
                meta={
                    "pattern_id": d.pattern_id,
                    "pattern_name": d.pattern_name,
                    "deal_merchant": d.deal_merchant,
                    "deal_price_cents": d.deal_price_cents,
                    "baseline_cents": d.baseline_cents,
                    "savings_per_trip_cents": d.savings_cents,
                    "savings_pct": d.savings_pct,
                    "annual_savings_cents": annual,
                },
            )
        )
    return recs


# ----------------------------------------------------------------------
#  Signal 5 — yield-shift
# ----------------------------------------------------------------------

def _yield_shift_recs(db: Session) -> list[Recommendation]:
    """If the user has > $X in checking at a typical sub-1% APY, the
    delta to T-bills (currently ~5%) is a free monthly income uplift.
    """
    from finance_app.db.models import Account, AccountType

    checking_total = db.execute(
        select(func.coalesce(func.sum(Account.current_balance_cents), 0))
        .where(Account.account_type == AccountType.checking)
        .where(Account.is_active == True)  # noqa: E712
    ).scalar() or 0

    # Threshold: don't recommend yield-shift unless there's at least
    # $5K of idle checking to move. Anything less and the friction of
    # moving it isn't worth it.
    if checking_total < 500_000:
        return []

    # Conservative buffer to leave in checking — $3K covers most rolling
    # spend buffers. Everything past that could move to a Treasury MMF.
    buffer_cents = 300_000
    moveable_cents = checking_total - buffer_cents
    if moveable_cents < 200_000:  # less than $2K moveable
        return []

    # APY delta: assume checking ~0.05%, MMF ~5%. So 4.95% on the
    # moveable balance / 12 months.
    apy_delta = 0.0495
    monthly_uplift = int(moveable_cents * apy_delta / 12)
    if monthly_uplift < 500:
        return []

    return [Recommendation(
        kind="yield_shift",
        title=f"Move {_dollars(moveable_cents)} from checking to a money-market fund",
        body=(
            f"You have {_dollars(checking_total)} sitting in checking. After leaving "
            f"a {_dollars(buffer_cents)} buffer, moving the rest to a Treasury MMF "
            f"(~5% APY) would generate roughly {_dollars(monthly_uplift)}/mo in "
            f"interest — no spending change required. See the Yield Optimization "
            f"panel for specific funds + their current rates."
        ),
        expected_monthly_impact_cents=monthly_uplift,
        priority=min(1.0, monthly_uplift / 100_000),
        apply=None,  # yield shift is an account move, not a budget override
        meta={
            "checking_total_cents": checking_total,
            "moveable_cents": moveable_cents,
            "buffer_cents": buffer_cents,
            "apy_delta": apy_delta,
        },
    )]


# ----------------------------------------------------------------------
#  Public — gather + rank
# ----------------------------------------------------------------------

def gather_recommendations(db: Session) -> list[Recommendation]:
    """Run all four signals and return them sorted by:
    (1) descending priority, (2) descending impact, (3) stable on kind.
    """
    # Need monthly net flow for the goal recs. Compute it here so we
    # don't recompute inside _goal_recs.
    from finance_app.budgets.projector import gather_inputs

    today = date.today()
    inputs = gather_inputs(db, today.replace(day=1))
    monthly_net_flow_cents = inputs["monthly_income_cents"] - inputs["monthly_outflow_cents"]

    all_recs: list[Recommendation] = []
    all_recs.extend(_overspend_recs(db))
    all_recs.extend(_goal_recs(db, monthly_net_flow_cents))
    all_recs.extend(_bundle_recs(db))
    all_recs.extend(_store_swap_recs(db))   # G-12 — receipt-driven cross-store deals
    all_recs.extend(_yield_shift_recs(db))

    all_recs.sort(
        key=lambda r: (-r.priority, -r.expected_monthly_impact_cents, r.kind),
    )
    return all_recs


def _dollars(cents: int) -> str:
    """Compact dollar-string used in recommendation copy."""
    sign = "-" if cents < 0 else ""
    abs_cents = abs(cents)
    return f"{sign}${abs_cents / 100:,.0f}"


__all__ = [
    "Recommendation",
    "CategoryOverridePayload",
    "gather_recommendations",
]
