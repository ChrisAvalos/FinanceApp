"""Money-on-the-table dashboard — Phase 8.6.

The aggregator panel. One endpoint that pulls every "claimable /
redeemable / saveable / earnable" opportunity into a single ranked
view. Each opportunity carries:

  - source_kind (unclaimed / class_action / regulatory_redress /
    card_benefit / yield_arb / sub_cancel / offer / retention /
    sign_up_bonus / etc.)
  - title / description
  - estimated_cents (or null if value is qualitative)
  - effort_minutes (rough estimate of user-time to claim)
  - value_per_minute (estimated_cents / effort_minutes)
  - action_url + action_steps
  - urgency (deadline awareness)

The dashboard sorts by value_per_minute desc so the user always sees
their best ROI use of the next 5 minutes. Across the catalog we
encode ~6-15 minute effort estimates per opportunity — most are
"fill out a form" or "click a button" magnitude.

This is the single most important user surface in the app: every
other feature feeds into here.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete, select
from sqlalchemy.orm import Session

from finance_app.benefits import annual_credits_summary
from finance_app.bundles import detect_overlaps as detect_bundle_overlaps
from finance_app.db.models import (
    DailyMoveAction,
    LegalClaim,
    LegalClaimStatus,
    ReceiptCoupon,
    ReceiptCouponStatus,
    Subscription,
    SubscriptionStatus,
    UnclaimedProperty,
    UnclaimedPropertyStatus,
)
from finance_app.db.session import get_db


router = APIRouter(prefix="/money-on-table", tags=["money-on-table"])


# --- Pydantic --------------------------------------------------------


class OpportunityOut(BaseModel):
    """One row in the action queue."""
    source_kind: str
    source_id: int | None
    title: str
    description: str
    estimated_cents: int | None
    effort_minutes: int  # rough; UI rounds to {1,5,15,30,60}
    value_per_minute_cents: int | None
    action_url: str | None
    action_label: str
    deadline: date | None
    urgency_days: int | None  # days until deadline; None if no deadline
    confidence: float  # 0-1


class MoneyOnTableReportOut(BaseModel):
    as_of: datetime
    opportunities: list[OpportunityOut]
    total_claimable_cents: int     # sum of estimated_cents on confident items
    total_savings_cents: int        # sum of recurring savings × 12mo equivalent
    counts_by_kind: dict[str, int]
    summary_text: str


# --- Daily Moves -----------------------------------------------------
#
# Companion endpoint to /report optimized for the daily action surface.
# Same upstream aggregators, but ranks more aggressively (urgency boost),
# slices to top N, and presents a punchy "do this today" framing.


class DailyMoveOut(BaseModel):
    """One actionable item on today's queue.

    Superset of ``OpportunityOut`` with two extra fields:
      - ``priority_score``: blended $/min + urgency boost. Higher = surface first.
      - ``is_urgent``: deadline within 7 days. Drives a UI badge.
    """
    source_kind: str
    source_id: int | None
    title: str
    description: str
    estimated_cents: int | None
    effort_minutes: int
    value_per_minute_cents: int | None
    action_url: str | None
    action_label: str
    deadline: date | None
    urgency_days: int | None
    confidence: float
    priority_score: float
    is_urgent: bool


class DailyMovesReportOut(BaseModel):
    """The 'best 5 minutes you could spend right now' view."""
    as_of: datetime
    moves: list[DailyMoveOut]            # capped at limit, ranked by priority
    total_potential_cents: int           # sum of estimated_cents in this slice
    total_minutes: int                   # sum of effort_minutes if user does all
    items_remaining: int                 # how many more behind the cut
    urgent_count: int                    # how many of `moves` are deadline-driven
    headline: str                        # 1-line "today: X moves, $Y, Z minutes"
    # Streak tracking — counts consecutive distinct dates the user
    # marked at least one move "done". Used by the panel to show a
    # 🔥 N-day streak counter as a delight + retention nudge.
    current_streak_days: int             # ends today (or yesterday with grace)
    longest_streak_days: int             # all-time best


# --- Aggregators per source ------------------------------------------


def _from_unclaimed(db: Session) -> list[OpportunityOut]:
    rows = list(
        db.execute(
            select(UnclaimedProperty).where(
                UnclaimedProperty.status == UnclaimedPropertyStatus.found
            )
        ).scalars().all()
    )
    out: list[OpportunityOut] = []
    for r in rows:
        cents = r.estimated_value_cents
        # State filing is ~15-30 min depending on form; some states are
        # claim-by-mail (60+ min). Use 20 as a default.
        effort = 20
        out.append(
            OpportunityOut(
                source_kind="unclaimed_property",
                source_id=r.id,
                title=f"Claim ${cents/100:,.0f} from {r.state} unclaimed property" if cents else f"Claim from {r.state} unclaimed property",
                description=(
                    f"Reported by {r.holder_name or 'unknown holder'}; "
                    f"property type: {r.property_type or 'unspecified'}."
                ),
                estimated_cents=cents,
                effort_minutes=effort,
                value_per_minute_cents=int(cents / effort) if cents else None,
                action_url=r.claim_url,
                action_label="File claim",
                deadline=None,
                urgency_days=None,
                confidence=0.85,
            )
        )
    return out


def _from_class_actions(db: Session) -> list[OpportunityOut]:
    rows = list(
        db.execute(
            select(LegalClaim).where(LegalClaim.status == LegalClaimStatus.available)
        ).scalars().all()
    )
    today = date.today()
    out: list[OpportunityOut] = []
    for r in rows:
        cents = r.estimated_payout_cents
        # Quick claims (no proof) are 5-10 min; needs-proof are 30-60.
        # Default to 15 since most class actions cluster around quick.
        effort = 10 if (r.proof_status and r.proof_status.value == "not_required") else 30
        urgency = (r.claim_deadline - today).days if r.claim_deadline else None
        out.append(
            OpportunityOut(
                source_kind="class_action",
                source_id=r.id,
                title=f"Class-action: {r.name[:60]}",
                description=r.description or "",
                estimated_cents=cents,
                effort_minutes=effort,
                value_per_minute_cents=int(cents / effort) if cents else None,
                action_url=r.source_url,
                action_label="File claim",
                deadline=r.claim_deadline,
                urgency_days=urgency,
                confidence=0.75 if (r.proof_status and r.proof_status.value == "not_required") else 0.55,
            )
        )
    return out


def _from_card_benefits(db: Session) -> list[OpportunityOut]:
    """Surface CARD-LEVEL net benefit gaps as one opportunity per card."""
    report = annual_credits_summary(db)
    out: list[OpportunityOut] = []
    for r in report.rows:
        # The "use it" effort here is the bundled-up cost of activating
        # benefits during the year. Hard to time precisely; use 20 min
        # as a default for "set up an Equinox membership / link Uber /
        # use the airline credit on next trip."
        if r.total_credit_value_cents <= 0:
            continue
        out.append(
            OpportunityOut(
                source_kind="card_benefit",
                source_id=r.account_id,
                title=f"${r.total_credit_value_cents/100:,.0f}/yr in unused {r.profile_name} benefits",
                description=(
                    f"Net after annual fee: ${r.net_after_fee_cents/100:+,.0f}. "
                    f"{len(r.benefits)} bundled credits — see card-benefits panel "
                    f"for use-by dates."
                ),
                estimated_cents=r.total_credit_value_cents,
                effort_minutes=20,
                value_per_minute_cents=int(r.total_credit_value_cents / 20),
                action_url=None,
                action_label="Review bundled benefits",
                deadline=date(date.today().year, 12, 31),  # most reset annually
                urgency_days=(date(date.today().year, 12, 31) - date.today()).days,
                confidence=0.90,
            )
        )
    return out


def _from_yield_arb(db: Session) -> list[OpportunityOut]:
    """Per-account yield-arb opportunities."""
    # Avoid circular import at module load.
    from .yield_opt import _HYSA_OPTIONS, _TBILL_OPTIONS, _LIQUID_TYPES, _BASELINE_CHECKING_APY_PCT
    from finance_app.db.models import Account, AccountType
    from finance_app.networth.service import _latest_balance_per_account

    cards = list(
        db.execute(
            select(Account).where(Account.account_type.in_(_LIQUID_TYPES))
        ).scalars().all()
    )
    latest = _latest_balance_per_account(db)
    out: list[OpportunityOut] = []
    for c in cards:
        bal = latest.get(c.id, c.current_balance_cents or 0)
        if not bal or bal < 100_000:  # < $1k — not worth optimizing
            continue
        if c.account_type == AccountType.savings:
            current_apy = 4.0
        else:
            current_apy = _BASELINE_CHECKING_APY_PCT
        current_yield = int(bal * current_apy / 100)
        # Best alternative yield given balance
        best_alt = max(
            (
                int(bal * o.apy_pct / 100)
                for o in (_HYSA_OPTIONS + _TBILL_OPTIONS)
                if bal >= o.minimum_cents
            ),
            default=0,
        )
        delta = best_alt - current_yield
        if delta < 2_000:  # <$20/yr — skip
            continue
        out.append(
            OpportunityOut(
                source_kind="yield_arb",
                source_id=c.id,
                title=f"Move {c.name} to higher-yield account → +${delta/100:.0f}/yr",
                description=(
                    f"${bal/100:,.0f} earning {current_apy}% (~${current_yield/100:.0f}/yr). "
                    f"At top HYSA / T-bill rates would earn ~${best_alt/100:.0f}/yr."
                ),
                estimated_cents=delta,
                effort_minutes=30,  # opening a new HYSA + first transfer
                value_per_minute_cents=int(delta / 30),
                action_url=None,
                action_label="See yield-opt panel",
                deadline=None,
                urgency_days=None,
                confidence=0.95,
            )
        )
    return out


def _from_bundle_overlaps(db: Session) -> list[OpportunityOut]:
    """Wave E unique-angle source — "you're paying twice" findings.

    Each finding is a perk you're paying for standalone (e.g. Peacock
    $14.99/mo) while also paying a parent plan that bundles it
    (e.g. Xfinity Mobile). Annual savings = perk_monthly × 12.

    Effort estimate: 15 min — the user has to call/chat to cancel the
    standalone perk + activate it via the parent's portal. Slightly
    longer than a pure cancel because of the activation step.
    """
    findings = detect_bundle_overlaps(db)
    out: list[OpportunityOut] = []
    for f in findings:
        annual = f.annual_savings_cents
        effort = 15
        out.append(
            OpportunityOut(
                source_kind="bundle_overlap",
                source_id=f.perk_subscription_id,
                title=(
                    f"Cancel {f.perk_label} standalone → save "
                    f"${annual/100:,.0f}/yr"
                ),
                description=(
                    f"{f.parent_label} ({f.tier_note}) already includes "
                    f"{f.perk_label}. {f.rationale}"
                ),
                estimated_cents=annual,
                effort_minutes=effort,
                value_per_minute_cents=int(annual / effort),
                action_url=f.activation_url,
                action_label="Cancel standalone + activate via bundle",
                deadline=None,
                urgency_days=None,
                confidence=f.confidence,
            )
        )
    return out


def _from_subs_to_cancel(db: Session) -> list[OpportunityOut]:
    """Subscriptions you should consider cancelling — ranked by monthly cost.

    Only surfaces high-confidence (>=0.75) detected subs you haven't
    confirmed (so we're not nagging about your real Netflix). Annualizes
    the monthly cost as the "estimated savings if you act."
    """
    subs = list(
        db.execute(
            select(Subscription)
            .where(Subscription.status == SubscriptionStatus.active)
            .where(Subscription.is_user_confirmed.is_(False))
            .where(Subscription.confidence_score >= 0.75)
        ).scalars().all()
    )
    out: list[OpportunityOut] = []
    for s in subs:
        monthly = abs(s.last_amount_cents or s.amount_cents or 0)
        if monthly < 500:  # <$5/mo not worth cancelling
            continue
        annual = monthly * 12
        out.append(
            OpportunityOut(
                source_kind="sub_cancel",
                source_id=s.id,
                title=f"Cancel {s.name} → save ${annual/100:,.0f}/yr",
                description=(
                    f"Detected with {s.confidence_score:.0%} confidence; "
                    f"${monthly/100:.2f}/mo. Run the retention playbook "
                    f"first if you want to negotiate down vs cancel."
                ),
                estimated_cents=annual,
                effort_minutes=10,
                value_per_minute_cents=int(annual / 10),
                action_url=None,
                action_label="Run retention playbook",
                deadline=None,
                urgency_days=None,
                confidence=s.confidence_score or 0.75,
            )
        )
    return out


# --------------------------------------------------------------------
#  Catalog-backed aggregators (no DB dependency — these are "free money
#  on the internet" buckets the app surfaces just by knowing they exist).
#  Each entry is one persistent opportunity with a known dollar value
#  and effort estimate. The user opts-in or dismisses per-row in the UI.
# --------------------------------------------------------------------


# Bank account opening bonuses — current public offers as of 2026-Q1.
# Update when offers cycle. Sources: each bank's promotional page.
_BANK_BONUS_CATALOG: list[dict] = [
    {
        "key": "chase_total_checking_300",
        "title": "Chase Total Checking — $300 bonus",
        "description": "Open a new Chase Total Checking, set up direct deposit ≥$500 within 90 days. Standard nag flow; no minimum balance after.",
        "estimated_cents": 30_000,
        "effort_minutes": 25,
        "url": "https://www.chase.com/personal/checking",
    },
    {
        "key": "chase_savings_200",
        "title": "Chase Savings — $200 bonus",
        "description": "Stackable with the checking bonus above. Deposit ≥$15k for 90 days. Pull from another account, get the bonus, then move it back.",
        "estimated_cents": 20_000,
        "effort_minutes": 20,
        "url": "https://www.chase.com/personal/savings",
    },
    {
        "key": "sofi_checking_300",
        "title": "SoFi Checking + Savings — $300 bonus",
        "description": "Direct deposit ≥$5,000 within 25 days. Earns 4.20% APY on savings while you wait. Fully online, no branch.",
        "estimated_cents": 30_000,
        "effort_minutes": 20,
        "url": "https://www.sofi.com/banking/",
    },
    {
        "key": "discover_savings_200",
        "title": "Discover Online Savings — $200 bonus",
        "description": "Deposit ≥$25k within 30 days; hold 90 days. Top-tier APY makes the holding period itself profitable.",
        "estimated_cents": 20_000,
        "effort_minutes": 15,
        "url": "https://www.discover.com/online-banking/savings-account/",
    },
    {
        "key": "citi_priority_2000",
        "title": "Citi Priority — $2,000 bonus (large balance tier)",
        "description": "Deposit ≥$300,000 in new-to-Citi money, hold 60 days. For people with significant idle cash; pairs with the yield-arb panel.",
        "estimated_cents": 200_000,
        "effort_minutes": 60,
        "url": "https://online.citi.com/US/ag/banking/checking-account",
    },
]

# Brokerage transfer / new-account bonuses — similar pattern, larger
# tickets but longer effort because they require ACATS transfers.
_BROKERAGE_BONUS_CATALOG: list[dict] = [
    {
        "key": "schwab_transfer_1000",
        "title": "Schwab transfer bonus — up to $1,000",
        "description": "Transfer ≥$250,000 of brokerage assets. Tier scales: $25k→$100, $100k→$300, $250k→$500, $500k→$1,000.",
        "estimated_cents": 100_000,  # top tier
        "effort_minutes": 90,
        "url": "https://www.schwab.com/public/schwab/investing/accounts_products/accounts/refer-prospects",
    },
    {
        "key": "fidelity_transfer_500",
        "title": "Fidelity transfer bonus — up to $500",
        "description": "Transfer ≥$100,000 from another brokerage. Use the New Account Cash Award promo. Holds 9 months.",
        "estimated_cents": 50_000,
        "effort_minutes": 60,
        "url": "https://www.fidelity.com/customer-service/cash-bonus",
    },
    {
        "key": "robinhood_gold_match_3pct",
        "title": "Robinhood Gold IRA — 3% match on contributions",
        "description": "Highest IRA match in the industry. $7k limit → $210/yr free; over a few years adds up. Requires Gold membership ($5/mo, easily netted out).",
        "estimated_cents": 21_000,
        "effort_minutes": 30,
        "url": "https://robinhood.com/us/en/about/retirement/",
    },
]

# Catalog of category-wide redress / refund tracker sources we know
# about but can't auto-detect from your transactions yet. These are
# "go check this URL once a quarter" reminders — no false positives,
# zero matching required.
_PASSIVE_CHECK_CATALOG: list[dict] = [
    {
        "key": "naupa_missingmoney",
        "title": "Search MissingMoney.com (NAUPA aggregator)",
        "description": "Free national lookup across all 50 state unclaimed-property databases. Most adults have $80–$200; some have thousands. Run quarterly with current + past addresses, full + nickname variants.",
        "estimated_cents": 15_000,  # conservative average
        "effort_minutes": 10,
        "url": "https://www.missingmoney.com",
    },
    {
        "key": "irs_refund_tracker",
        "title": "Old IRS refund check (Where's My Refund)",
        "description": "If you have an unbanked refund, the IRS holds it for ~3 years. Easy lookup — SSN + amount + filing status.",
        "estimated_cents": 30_000,
        "effort_minutes": 5,
        "url": "https://www.irs.gov/refunds",
    },
    {
        "key": "savings_bonds_treasuryhunt",
        "title": "Old paper savings bonds — TreasuryHunt.gov",
        "description": "Decades-old EE/I bonds that matured but were never redeemed. If anyone in your family bought you bonds as a kid, they may be sitting here.",
        "estimated_cents": 25_000,
        "effort_minutes": 10,
        "url": "https://www.treasuryhunt.gov",
    },
    {
        "key": "old_401k_lookup",
        "title": "Lost 401(k) from old jobs — National Registry",
        "description": "Free search across the national database for orphaned defined-contribution plans. Fix any sub-$5k accounts your old employers may have force-rolled.",
        "estimated_cents": 50_000,
        "effort_minutes": 15,
        "url": "https://unclaimedretirementbenefits.com/",
    },
    {
        "key": "pbgc_pension",
        "title": "Forgotten pension benefit (PBGC search)",
        "description": "If any past employer ran a defined-benefit pension plan, you may be vested. PBGC's Find an Unclaimed Pension search is free and matches by name.",
        "estimated_cents": 100_000,
        "effort_minutes": 15,
        "url": "https://www.pbgc.gov/wr/find-an-unclaimed-pension",
    },
    {
        "key": "fdic_failed_bank",
        "title": "Failed-bank deposit lookup (FDIC)",
        "description": "If you ever banked at an institution that later failed, deposits may not have been claimed. The FDIC closed-banks tool is free and instant.",
        "estimated_cents": 0,  # value is "if it applies, could be anything"
        "effort_minutes": 5,
        "url": "https://closedbanks.fdic.gov/funds/",
    },
    {
        "key": "ftc_redress",
        "title": "FTC consumer redress refunds",
        "description": "FTC posts active consumer-refund campaigns (often FOREX scams, deceptive billing, robocalls). Each campaign mails checks to eligible victims; some have lookup forms.",
        "estimated_cents": 5_000,
        "effort_minutes": 15,
        "url": "https://www.ftc.gov/enforcement/refunds",
    },
    {
        "key": "cfpb_redress",
        "title": "CFPB consumer redress fund",
        "description": "Distinct from FTC — CFPB handles bank/lender violations (Wells Fargo unauthorized accounts, etc). Open the URL to see active distributions you may be eligible for.",
        "estimated_cents": 10_000,
        "effort_minutes": 15,
        "url": "https://www.consumerfinance.gov/about-us/payments-harmed-consumers/",
    },
    {
        "key": "usps_undelivered",
        "title": "USPS Mail Recovery Center claim",
        "description": "If you ever lost a package containing money/gift cards/checks and filed a claim, undelivered items get auctioned but proceeds can be reclaimed.",
        "estimated_cents": 0,
        "effort_minutes": 10,
        "url": "https://www.usps.com/help/missing-mail.htm",
    },
    {
        "key": "amazon_price_drop",
        "title": "Amazon price-drop refunds (last 30 days)",
        "description": "Amazon doesn't auto-refund price drops, but if you contact support within 7-30 days they'll typically refund the difference. Check your last 90 days of orders.",
        "estimated_cents": 2_000,
        "effort_minutes": 15,
        "url": "https://www.amazon.com/gp/help/customer/contact-us",
    },
    {
        "key": "credit_card_extended_warranty",
        "title": "Extended warranty / purchase protection on premium cards",
        "description": "Most premium cards (Sapphire Reserve, Amex Platinum) auto-extend manufacturer warranties +1yr and offer 90-120d purchase protection on items under $10k. Most users never file.",
        "estimated_cents": 25_000,
        "effort_minutes": 30,
        "url": None,
    },
    {
        "key": "manufacturer_recall_check",
        "title": "Manufacturer recall check (electronics, appliances, vehicles)",
        "description": "Most recalls offer cash refunds or free replacements. NHTSA + CPSC databases are free; cross-reference your owned items.",
        "estimated_cents": 15_000,
        "effort_minutes": 10,
        "url": "https://www.recalls.gov/",
    },
    {
        "key": "rebate_followup",
        "title": "Manufacturer rebate follow-up",
        "description": "Mail-in / form rebates get rejected at ~20% rate. If you submitted any in the last 90 days and never saw the check, follow up — rejection is often clerical.",
        "estimated_cents": 3_000,
        "effort_minutes": 15,
        "url": None,
    },
    {
        "key": "gift_card_balance_recovery",
        "title": "Forgotten gift card balance lookup",
        "description": "Most gift cards have a 1-800 + 16-digit lookup on the back. Walk through any gift cards in your wallet/junk drawer; many have $5-50 sitting unused.",
        "estimated_cents": 5_000,
        "effort_minutes": 20,
        "url": None,
    },
    {
        "key": "expired_warranty_payout",
        "title": "Class-action warranty payouts (washing machines, hard drives, batteries)",
        "description": "Long-running settlements (Samsung washers, Seagate drives, etc.) often pay $35-$300 per affected unit. Cross-reference any broken-but-still-owned electronics.",
        "estimated_cents": 10_000,
        "effort_minutes": 15,
        "url": "https://topclassactions.com/lawsuit-settlements/closed-settlements/",
    },
]


def _from_bank_bonuses(_db: Session) -> list[OpportunityOut]:
    """Catalog-backed bank account opening bonuses."""
    out: list[OpportunityOut] = []
    for entry in _BANK_BONUS_CATALOG:
        cents = entry["estimated_cents"]
        effort = entry["effort_minutes"]
        out.append(
            OpportunityOut(
                source_kind="bank_bonus",
                source_id=None,
                title=entry["title"],
                description=entry["description"],
                estimated_cents=cents,
                effort_minutes=effort,
                value_per_minute_cents=int(cents / effort) if effort else None,
                action_url=entry.get("url"),
                action_label="Open account",
                deadline=None,
                urgency_days=None,
                confidence=0.70,  # offers cycle, so under-promise
            )
        )
    return out


def _from_brokerage_bonuses(_db: Session) -> list[OpportunityOut]:
    """Catalog-backed brokerage transfer / new-account bonuses."""
    out: list[OpportunityOut] = []
    for entry in _BROKERAGE_BONUS_CATALOG:
        cents = entry["estimated_cents"]
        effort = entry["effort_minutes"]
        out.append(
            OpportunityOut(
                source_kind="brokerage_bonus",
                source_id=None,
                title=entry["title"],
                description=entry["description"],
                estimated_cents=cents,
                effort_minutes=effort,
                value_per_minute_cents=int(cents / effort) if effort else None,
                action_url=entry.get("url"),
                action_label="See offer",
                deadline=None,
                urgency_days=None,
                confidence=0.70,
            )
        )
    return out


def _from_upcoming_annuals(db: Session) -> list[OpportunityOut]:
    """Sprint 44 — annual subscription renewals as plannable items.

    Sprint 13's ``project_annual_renewals`` returns Truthly /
    Settlemate / ESPN+ etc. with a precise on_date in the next 12
    months. Cash Flow's "Coming up" tab (Sprint 40) renders them as
    forecast events; this surfaces the SAME data on Money on the
    Table so the user sees them ranked alongside other planning
    opportunities ("cancel this $69 sub before it renews in 37 days").

    Important framing: we present these as **decision moments**, not
    "free money you can claim". The action is "review whether you
    still want this" — keep, downgrade, cancel. ``estimated_cents``
    is the renewal amount (you save it ALL if you cancel), with a
    modest confidence because most users keep most subs.
    """
    from datetime import date, timedelta

    from finance_app.subscriptions.annual_projector import (
        project_annual_renewals,
    )

    today = date.today()
    horizon = today + timedelta(days=365)
    try:
        events = list(project_annual_renewals(db, start=today, end=horizon))
    except Exception:  # noqa: BLE001 — never let annual projector tank MoT
        return []
    out: list[OpportunityOut] = []
    for ev in events:
        days_out = (ev.on_date - today).days
        # Filter out anything inside the 30-day Cash Flow window — those
        # already show up in the regular forecast and don't need to be
        # re-surfaced here as "plannable." We want the 31–365 day band.
        if days_out < 31:
            continue
        amount_abs = abs(ev.amount_cents)
        if amount_abs <= 0:
            continue
        # Effort: reviewing a sub takes ~10 min (check usage, decide).
        effort = 10
        # Urgency: anything within 60 days is "soon, decide now"; beyond
        # is "on the radar".
        urgency = days_out if days_out <= 90 else None
        label = ev.label if "(annual)" in ev.label.lower() else f"{ev.label} (annual)"
        out.append(
            OpportunityOut(
                source_kind="annual_renewal",
                source_id=ev.subscription_id,
                title=f"{label} renews in {days_out} days",
                description=(
                    f"Annual charge of ${amount_abs / 100:,.2f} expected on "
                    f"{ev.on_date.isoformat()}. Review whether you still use "
                    f"this — cancelling now saves the full amount."
                ),
                estimated_cents=amount_abs,
                effort_minutes=effort,
                value_per_minute_cents=int(amount_abs / effort) if effort else None,
                action_url=None,
                action_label="Review",
                deadline=ev.on_date,
                urgency_days=urgency,
                # 0.40 — we don't know the user wants to cancel; it's a
                # decision moment, not a sure-thing claim.
                confidence=0.40,
            )
        )
    return out


def _from_passive_checks(_db: Session) -> list[OpportunityOut]:
    """Catalog-backed "go check this URL" reminders.

    These are the buckets the app can't auto-match against your data
    (yet) but everyone should check periodically. Low individual
    confidence because we don't *know* you're owed money — we just know
    these are the right places to look.
    """
    out: list[OpportunityOut] = []
    for entry in _PASSIVE_CHECK_CATALOG:
        cents = entry["estimated_cents"]
        effort = entry["effort_minutes"]
        out.append(
            OpportunityOut(
                source_kind="passive_check",
                source_id=None,
                title=entry["title"],
                description=entry["description"],
                estimated_cents=cents if cents > 0 else None,
                effort_minutes=effort,
                value_per_minute_cents=(int(cents / effort) if cents and effort else None),
                action_url=entry.get("url"),
                action_label="Check now",
                deadline=None,
                urgency_days=None,
                # 0.30 = "I think it's worth checking" — not a confident
                # claim that *you* specifically have money sitting here.
                confidence=0.30,
            )
        )
    return out


def _from_cross_store_deals(db: Session) -> list[OpportunityOut]:
    """Cross-store deals — Phase 10 Slice D.

    Each ``DealOpportunity`` becomes an opportunity in the unified
    queue. The estimated_cents is the *annualized* savings (per-trip
    savings × purchases-per-year), not just the per-trip number —
    that's the apples-to-apples value for ranking against one-time
    claims like class actions.
    """
    from finance_app.deals import find_deals
    deals = find_deals(db)
    out: list[OpportunityOut] = []
    for d in deals:
        # Effort: switching merchants for one item is ~5 min. Higher
        # if it's a stand-alone trip; the user makes that call.
        effort = 5
        # Use annualized savings when we have cadence; fall back to
        # per-trip savings otherwise.
        cents = d.annual_savings_cents or d.savings_cents
        out.append(
            OpportunityOut(
                source_kind="cross_store_deal",
                source_id=d.pattern_id,
                title=(
                    f"{d.deal_merchant} has {d.pattern_name[:60]} "
                    f"for ${d.deal_price_cents/100:.2f} "
                    f"(vs your ${d.baseline_cents/100:.2f} typical)"
                ),
                description=(
                    f"Save ${d.savings_cents/100:.2f} per trip "
                    f"({int(d.savings_pct * 100)}% off). "
                    + (
                        f"~${(d.annual_savings_cents or 0)/100:.0f}/yr if you switch "
                        if d.annual_savings_cents else ""
                    )
                ),
                estimated_cents=cents,
                effort_minutes=effort,
                value_per_minute_cents=int(cents / effort) if cents else None,
                action_url=d.product_url,
                action_label="See deal",
                deadline=None,
                urgency_days=None,
                # 0.80 — we've actually seen the price; the only
                # uncertainty is whether you'll switch stores.
                confidence=0.80,
            )
        )
    return out


def _from_receipt_coupons(db: Session) -> list[OpportunityOut]:
    """Coupons + offers extracted from uploaded receipts — Slice C.

    Each available, non-expired coupon becomes an opportunity. The
    estimated value drives sort order; coupons without a parsed value
    (percentage offers, free-shipping, qualitative) sort to the
    bottom but are still surfaced because the user can decide.
    """
    today = date.today()
    rows = list(
        db.execute(
            select(ReceiptCoupon).where(
                ReceiptCoupon.status == ReceiptCouponStatus.available
            )
        ).scalars().all()
    )
    out: list[OpportunityOut] = []
    for r in rows:
        # Auto-skip if expired (don't surface stale coupons in the queue)
        if r.expires_at and r.expires_at < today:
            continue
        urgency = (r.expires_at - today).days if r.expires_at else None
        # Effort estimate: code-only redemption (online) is ~3 min;
        # in-store-only ("next visit") is 0 min effort but the spend
        # constraint makes the real cost higher — flag with 5 min.
        # URL surveys are typically 5-10 min.
        effort = 5
        if "survey" in (r.title or "").lower():
            effort = 8
        if r.code:
            effort = 3
        cents = r.estimated_value_cents
        prefix = f"{r.merchant} coupon" if r.merchant else "Receipt coupon"
        title = f"{prefix}: {r.title[:80]}" if r.title else f"{prefix}"
        out.append(
            OpportunityOut(
                source_kind="receipt_coupon",
                source_id=r.id,
                title=title,
                description=(
                    f"Code: {r.code}. " if r.code else ""
                ) + (
                    f"Expires {r.expires_at}. " if r.expires_at else ""
                ) + "Redeem on next visit.",
                estimated_cents=cents,
                effort_minutes=effort,
                value_per_minute_cents=int(cents / effort) if cents else None,
                action_url=r.redemption_url,
                action_label="Use coupon",
                deadline=r.expires_at,
                urgency_days=urgency,
                # Confidence is high because it came off the user's own
                # receipt — we know they shopped there, the offer is
                # printed, and the code is real. Compares to ~0.55
                # for class actions where eligibility is uncertain.
                confidence=0.85,
            )
        )
    return out


def _from_redress(db: Session) -> list[OpportunityOut]:
    from finance_app.api.redress import (
        _KNOWN_REDRESS_CATALOG,
        _MERCHANT_MATCH_PATTERNS,
    )
    from finance_app.db.models import RegulatoryRedress, RedressStatus, Transaction
    cutoff = date.today() - timedelta(days=730)
    rows = list(
        db.execute(
            select(Transaction).where(Transaction.posted_date >= cutoff)
        ).scalars().all()
    )
    # `select(Model.column).scalars()` returns the column values directly
    # (a list of strings here), not ORM rows — so `r` is already the
    # company_name string. The `.company_name` access was throwing
    # AttributeError on every Today's moves render.
    logged = {
        name.lower()
        for name in db.execute(select(RegulatoryRedress.company_name)).scalars().all()
        if name
    }
    today = date.today()
    out: list[OpportunityOut] = []
    for entry in _KNOWN_REDRESS_CATALOG:
        if entry.get("claim_deadline") and entry["claim_deadline"] < today:
            continue
        if entry["company_name"].lower() in logged:
            continue  # already on the user's list
        patterns = _MERCHANT_MATCH_PATTERNS.get(
            entry["company_name"], [entry["company_name"].upper()]
        )
        # Match any txn
        matched = sum(
            1
            for t in rows
            if any(p in (t.description_raw or "").upper() for p in patterns)
        )
        if matched == 0:
            continue
        cents = entry.get("estimated_per_user_cents")
        out.append(
            OpportunityOut(
                source_kind="regulatory_redress",
                source_id=None,
                title=f"{entry['agency']} redress: {entry['company_name']}",
                description=entry["eligibility_description"],
                estimated_cents=cents,
                effort_minutes=15,
                value_per_minute_cents=int(cents / 15) if cents else None,
                action_url=entry.get("claim_url"),
                action_label="Check eligibility / file",
                deadline=entry.get("claim_deadline"),
                urgency_days=None,
                confidence=0.65,
            )
        )
    return out


# --- Top-level -------------------------------------------------------


@router.get("/report", response_model=MoneyOnTableReportOut)
def get_report(db: Session = Depends(get_db)) -> MoneyOnTableReportOut:
    """The unified ranked-by-ROI-per-minute action queue.

    Pulls every opportunity from every source and ranks them so
    Chris's morning question — "what's the best 5 minutes I could
    spend?" — has a deterministic answer.
    """
    aggregators = [
        _from_unclaimed,
        _from_class_actions,
        _from_card_benefits,
        _from_yield_arb,
        _from_bundle_overlaps,
        _from_subs_to_cancel,
        _from_redress,
        _from_receipt_coupons,
        _from_cross_store_deals,
        # Sprint 44 — annual renewal review opportunities. Sits with
        # the data-backed aggregators (above) rather than the
        # catalog ones (below) because each row is a real
        # subscription-specific decision tied to the user's data.
        _from_upcoming_annuals,
        # Catalog-backed sources — surface even when the DB is empty so
        # Chris always has a list of "free money" buckets to work
        # through, not just the ones we've matched data for.
        _from_bank_bonuses,
        _from_brokerage_bonuses,
        _from_passive_checks,
    ]
    all_ops: list[OpportunityOut] = []
    for fn in aggregators:
        try:
            all_ops.extend(fn(db))
        except Exception as e:  # noqa: BLE001
            # One source failing shouldn't tank the whole dashboard.
            import logging
            logging.getLogger(__name__).exception("aggregator %s failed: %r", fn.__name__, e)

    # Sort by value/minute desc; nulls sink to bottom.
    all_ops.sort(
        key=lambda o: (o.value_per_minute_cents or 0),
        reverse=True,
    )

    counts: dict[str, int] = {}
    total_claimable = 0
    total_savings = 0
    for o in all_ops:
        counts[o.source_kind] = counts.get(o.source_kind, 0) + 1
        if o.estimated_cents is not None and o.confidence >= 0.5:
            if o.source_kind in ("sub_cancel", "yield_arb", "bundle_overlap"):
                total_savings += o.estimated_cents
            else:
                total_claimable += o.estimated_cents

    if not all_ops:
        summary = "No opportunities surfaced yet."
    elif total_claimable + total_savings > 0:
        top_value = (all_ops[0].value_per_minute_cents or 0) / 100
        summary = (
            f"You have ~${total_claimable/100:,.0f} in claimable money "
            f"and ~${total_savings/100:,.0f}/yr in recurring savings "
            f"across {len(all_ops)} opportunities. Top item earns "
            f"~${top_value:.2f} per minute of your time — go."
        )
    else:
        # No high-confidence matches against your data, but the catalog
        # buckets always have value. Nudge toward the passive checks.
        summary = (
            f"{len(all_ops)} opportunities to check — no high-confidence "
            f"matches against your data yet, but the catalog of passive "
            f"checks (NAUPA, IRS refunds, bank bonuses, etc.) is worth a "
            f"15-minute pass. Connect Plaid + Gmail to surface "
            f"data-matched ones."
        )

    return MoneyOnTableReportOut(
        as_of=datetime.utcnow(),
        opportunities=all_ops,
        total_claimable_cents=total_claimable,
        total_savings_cents=total_savings,
        counts_by_kind=counts,
        summary_text=summary,
    )


def _action_key(op: OpportunityOut) -> str:
    """Stable per-opportunity key for the catalog-item case.

    For DB-backed opportunities (with source_id) we identify by id
    in the action lookup; for catalog items (no source_id) we fall
    back to a slugified title. Lowercase + whitespace collapse so
    "Open Marcus HYSA  " and "open marcus hysa" hash the same.
    """
    return re.sub(r"\s+", " ", (op.title or "").strip().lower())


def _load_active_actions(db: Session) -> dict[tuple[str, int | None, str | None], DailyMoveAction]:
    """Fetch all not-yet-expired actions, keyed for fast lookup.

    "Not yet expired" =
      - action ∈ {done, dismissed} → forever
      - action == snoozed AND snoozed_until > today → still active
    Snoozed rows whose date has passed are *not* purged here (the
    caller could; we leave them so a user could see history).

    The lookup key uses the canonicalized form of source_key so it
    matches `_action_key()` on the filter side. Old rows that were
    written before the canonicalization fix get normalized on read.
    """
    today = date.today()
    rows = db.execute(select(DailyMoveAction)).scalars().all()
    out: dict[tuple[str, int | None, str | None], DailyMoveAction] = {}
    for r in rows:
        if r.action == "snoozed" and (r.snoozed_until is None or r.snoozed_until <= today):
            continue  # snooze expired
        canonical_key = (
            re.sub(r"\s+", " ", r.source_key.strip().lower())
            if r.source_key
            else None
        )
        out[(r.source_kind, r.source_id, canonical_key)] = r
    return out


def _is_actioned(
    op: OpportunityOut,
    actions: dict[tuple[str, int | None, str | None], DailyMoveAction],
) -> bool:
    """True if this opportunity has an active action that should hide it from /today."""
    key1 = (op.source_kind, op.source_id, None)
    key2 = (op.source_kind, None, _action_key(op))
    return key1 in actions or key2 in actions


def _priority_score(op: OpportunityOut) -> float:
    """Blend $/minute with urgency for the daily-moves surface.

    Base: dollars-per-minute (value_per_minute_cents / 100). Higher is
    better. ``passive_check``-style items with no estimated value get a
    small floor of 0.05 so they appear on quiet days but always lose to
    real-money items.

    Urgency boost: if there's a deadline within 7 days, multiply by
    ``1 + (7 - days_until_deadline) * 0.5``. So a class-action with a
    2-day deadline gets a 1 + 5*0.5 = 3.5× kicker, and a 6-day one gets
    a 1.5× kicker. Anything past 7 days isn't time-sensitive enough to
    leapfrog higher-$/min items.

    Past-deadline items: DEMOTED, not boosted. The previous formula
    let urgency_days = -10 produce a 1 + 17*0.5 = 9.5× multiplier
    (negative `urgency_days` made `7 - urgency_days` huge), which put
    expired class actions at the top of the queue ahead of active
    opportunities — exactly the opposite of what users expect. We now
    apply a 0.5× DEPRESSOR to expired items so they sink to the bottom
    while still being visible (some class actions allow late filing).
    The UI's expired-badge does the rest.
    """
    base = (op.value_per_minute_cents or 0) / 100.0
    if base <= 0 and op.estimated_cents is None:
        # Catalog items (NAUPA, IRS refunds, etc.) — flat floor so they
        # sort beneath any real-money item but above zero.
        base = 0.05

    if op.urgency_days is not None:
        if op.urgency_days < 0:
            # Expired — demote, don't promote.
            base *= 0.5
        elif op.urgency_days <= 7:
            days_inside = 7 - op.urgency_days  # 0..7, never negative now
            base *= 1.0 + days_inside * 0.5

    return base


def _compute_streaks(db: Session, today: date | None = None) -> tuple[int, int]:
    """Compute (current_streak_days, longest_streak_days) from the
    DailyMoveAction history.

    A "streak day" is a calendar date on which the user marked at least
    one move ``done``. The current streak is the run of consecutive
    days ending today — with a one-day grace window so the user doesn't
    lose a 30-day streak by sleeping in past midnight (a streak ending
    yesterday still counts as current; only TWO missed days break it).
    The longest streak is the best run we've ever seen.

    Returns (0, 0) when the user has never marked a move done.

    Implementation: pull the distinct DATE(actioned_at) for action='done',
    iterate in chronological order, count consecutive runs. Cheap on
    any realistic action history.
    """
    if today is None:
        today = date.today()

    rows = db.execute(
        select(DailyMoveAction.actioned_at)
        .where(DailyMoveAction.action == "done")
        .order_by(DailyMoveAction.actioned_at.asc())
    ).scalars().all()
    if not rows:
        return (0, 0)

    # Reduce to distinct calendar dates.
    distinct_dates: list[date] = []
    seen: set[date] = set()
    for ts in rows:
        d = ts.date() if hasattr(ts, "date") else ts
        if d in seen:
            continue
        seen.add(d)
        distinct_dates.append(d)
    distinct_dates.sort()

    # Walk through and compute the longest run + the run ending most recently.
    longest = 1
    cur_run = 1
    for prev, nxt in zip(distinct_dates, distinct_dates[1:]):
        if (nxt - prev).days == 1:
            cur_run += 1
            longest = max(longest, cur_run)
        else:
            cur_run = 1

    last = distinct_dates[-1]
    days_since_last = (today - last).days
    if days_since_last <= 1:
        # Run ending today or yesterday counts as the "current" streak.
        # Walk backward from `last` to count how long the run is.
        current = 1
        for d in reversed(distinct_dates[:-1]):
            if (last - d).days == current:
                current += 1
                last = d  # not strictly needed; loop just consumes
            else:
                break
        # We re-derive `current` walking backward — simpler form:
        current = 1
        i = len(distinct_dates) - 1
        while i > 0 and (distinct_dates[i] - distinct_dates[i - 1]).days == 1:
            current += 1
            i -= 1
    else:
        current = 0

    return (current, longest)


@router.get("/today", response_model=DailyMovesReportOut)
def daily_moves(
    limit: int = 5,
    db: Session = Depends(get_db),
) -> DailyMovesReportOut:
    """Today's top moves, ranked by blended $/min + urgency.

    The daily action surface. Same aggregators as ``/report`` but
    sliced to a digestible top-N with urgency-aware ranking, so the
    user can answer "what's the best thing I could do RIGHT NOW?" in
    one glance instead of scrolling through 30 opportunities.
    """
    # Re-use the full report's aggregator logic by calling it. Keeps
    # the two endpoints from drifting on what counts as an opportunity.
    full = get_report(db)
    all_ops = full.opportunities

    # Filter out items the user has marked done / dismissed / snoozed.
    # The full /report endpoint deliberately doesn't filter so the user
    # can still browse everything from the cohort tabs.
    actions = _load_active_actions(db)
    all_ops = [op for op in all_ops if not _is_actioned(op, actions)]

    # Exclude past-deadline items entirely from Today's moves. The 0.5×
    # depressor in `_priority_score` wasn't enough — high-face-value
    # class actions ($25K × 0.5 / 30min ≈ $416/min) still leapfrogged
    # legitimate cancel-sub items at ~$240/min. The full /report still
    # surfaces them under their cohort tabs (Class actions etc.) so the
    # user can review late-filing options; "Today's moves" is the
    # action-now surface and shouldn't waste a slot on something that's
    # already over. (Audit findings #2, both passes.)
    all_ops = [
        op for op in all_ops
        if op.urgency_days is None or op.urgency_days >= 0
    ]

    # Re-rank with the urgency-aware score (the /report sort is just $/min).
    scored: list[tuple[float, OpportunityOut]] = [
        (_priority_score(op), op) for op in all_ops
    ]
    scored.sort(key=lambda pair: pair[0], reverse=True)

    top = scored[:limit]
    cut_count = max(0, len(scored) - limit)

    moves: list[DailyMoveOut] = []
    total_value = 0
    total_minutes = 0
    urgent_count = 0
    for score, op in top:
        is_urgent = op.urgency_days is not None and op.urgency_days <= 7
        if is_urgent:
            urgent_count += 1
        moves.append(
            DailyMoveOut(
                **op.model_dump(),
                priority_score=round(score, 2),
                is_urgent=is_urgent,
            )
        )
        if op.estimated_cents:
            total_value += op.estimated_cents
        total_minutes += op.effort_minutes

    if not moves:
        headline = "Nothing on the queue today — sync your accounts and check back."
    else:
        # Compose a punchy headline. Examples:
        #   "Today: 5 moves, ~$240 potential, 22 min"
        #   "Today: 3 moves (1 urgent), ~$120 potential, 18 min"
        urgent_frag = f" ({urgent_count} urgent)" if urgent_count else ""
        if total_value > 0:
            headline = (
                f"Today: {len(moves)} move{'s' if len(moves) != 1 else ''}{urgent_frag}, "
                f"~${total_value/100:,.0f} potential, {total_minutes} min"
            )
        else:
            headline = (
                f"Today: {len(moves)} passive check{'s' if len(moves) != 1 else ''} "
                f"to run — ~{total_minutes} min total"
            )

    current_streak, longest_streak = _compute_streaks(db)

    return DailyMovesReportOut(
        as_of=datetime.utcnow(),
        moves=moves,
        total_potential_cents=total_value,
        total_minutes=total_minutes,
        items_remaining=cut_count,
        urgent_count=urgent_count,
        headline=headline,
        current_streak_days=current_streak,
        longest_streak_days=longest_streak,
    )


# ---------------------------------------------------------------------------
#  Daily-move actions: done / snoozed / dismissed
# ---------------------------------------------------------------------------


class DailyMoveActionIn(BaseModel):
    """Body of POST /money-on-table/today/action.

    Provide ``source_id`` for DB-backed opportunities (LegalClaim,
    CardBenefit, etc.). Provide ``source_key`` for catalog opportunities
    (passive_check, bank_bonus). The frontend has both — it should send
    whichever the opportunity has set.
    """
    source_kind: str
    source_id: int | None = None
    source_key: str | None = None
    action: str  # "done" | "snoozed" | "dismissed"
    snooze_days: int | None = None
    notes: str | None = None


class DailyMoveActionOut(BaseModel):
    id: int
    source_kind: str
    source_id: int | None
    source_key: str | None
    action: str
    snoozed_until: date | None
    notes: str | None
    actioned_at: datetime


@router.post("/today/action", response_model=DailyMoveActionOut, status_code=201)
def record_action(
    payload: DailyMoveActionIn,
    db: Session = Depends(get_db),
) -> DailyMoveActionOut:
    """Mark a daily move as done, snoozed, or dismissed.

    Replaces any prior action on the same opportunity (so re-actioning
    a snoozed item to "done" is a single-row update, not duplicate
    rows). Snoozed items reappear on the queue when ``snoozed_until``
    has passed.
    """
    if payload.action not in {"done", "snoozed", "dismissed"}:
        raise HTTPException(400, f"unknown action: {payload.action!r}")
    if payload.action == "snoozed":
        if not payload.snooze_days or payload.snooze_days < 1:
            raise HTTPException(400, "snoozed action requires snooze_days >= 1")
    if payload.source_id is None and not payload.source_key:
        raise HTTPException(400, "must provide source_id or source_key")

    # Canonicalize the source_key so the stored value matches what
    # _action_key() produces during the /today filter step. Without
    # this normalization, "Forgotten Pension Benefit (PBGC search)"
    # POSTed by the frontend would store as-is, but _is_actioned()
    # looks up the lowercased+collapsed form, so the queue would keep
    # showing the actioned item.
    canonical_key = (
        re.sub(r"\s+", " ", payload.source_key.strip().lower())
        if payload.source_key
        else None
    )

    # Delete any prior action so the unique constraint doesn't bite.
    db.execute(
        sa_delete(DailyMoveAction).where(
            DailyMoveAction.source_kind == payload.source_kind,
            DailyMoveAction.source_id == payload.source_id,
            DailyMoveAction.source_key == canonical_key,
        )
    )

    snooze_until = (
        date.today() + timedelta(days=payload.snooze_days)
        if payload.action == "snoozed" and payload.snooze_days
        else None
    )
    row = DailyMoveAction(
        source_kind=payload.source_kind,
        source_id=payload.source_id,
        source_key=canonical_key,
        action=payload.action,
        snoozed_until=snooze_until,
        notes=payload.notes,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return DailyMoveActionOut(
        id=row.id,
        source_kind=row.source_kind,
        source_id=row.source_id,
        source_key=row.source_key,
        action=row.action,
        snoozed_until=row.snoozed_until,
        notes=row.notes,
        actioned_at=row.actioned_at,
    )


@router.delete("/today/action", status_code=204)
def undo_action(
    source_kind: str,
    source_id: int | None = None,
    source_key: str | None = None,
    db: Session = Depends(get_db),
) -> None:
    """Undo an action — brings the opportunity back into the queue."""
    if source_id is None and not source_key:
        raise HTTPException(400, "must provide source_id or source_key")
    db.execute(
        sa_delete(DailyMoveAction).where(
            DailyMoveAction.source_kind == source_kind,
            DailyMoveAction.source_id == source_id,
            DailyMoveAction.source_key == source_key,
        )
    )
    db.commit()


@router.get("/today/actions", response_model=list[DailyMoveActionOut])
def list_actions(
    days: int = 14,
    db: Session = Depends(get_db),
) -> list[DailyMoveActionOut]:
    """Recent actions, newest first. Powers the 'recently done / snoozed'
    section of the daily-moves panel.

    Default window is 14 days — enough to undo a stray tap from earlier
    in the week without surfacing the full history.
    """
    cutoff = datetime.utcnow() - timedelta(days=days)
    rows = db.execute(
        select(DailyMoveAction)
        .where(DailyMoveAction.actioned_at >= cutoff)
        .order_by(DailyMoveAction.actioned_at.desc())
        .limit(50)
    ).scalars().all()
    return [
        DailyMoveActionOut(
            id=r.id,
            source_kind=r.source_kind,
            source_id=r.source_id,
            source_key=r.source_key,
            action=r.action,
            snoozed_until=r.snoozed_until,
            notes=r.notes,
            actioned_at=r.actioned_at,
        )
        for r in rows
    ]
