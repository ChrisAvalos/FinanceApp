"""Bundle-overlap detector.

Walks the user's active subscriptions and the bundle knowledge base in
parallel. For each (parent, perk) pair where BOTH are present in the
user's data, emits a :class:`BundleOverlap` finding describing the
duplicate-paid situation.

Confidence model
----------------

Every finding gets a 0-1 confidence score driven by:

* **bill-range match** — the user's actual parent-bill amount falls in
  the tier-range that includes the perk → high confidence (0.85+);
  outside the range → medium (0.55); range unknown → 0.6 default.
* **match specificity** — exact provider match scores higher than
  generic substring hits.

Below 0.5 we still emit but mark the finding as "needs verification";
the UI can hide low-confidence rows by default.

Output is plain data (dataclasses) — no DB writes, no money moves. The
caller decides whether to surface in /api/bundles/overlaps,
/api/money-on-table, or both.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import TYPE_CHECKING, Any

from .loader import BundleEntry, PerkEntry, load_bundles

# SQLAlchemy + the Subscription model are imported LAZILY inside the
# Session-backed wrapper. This keeps the module loadable from contexts
# that don't have those installed (smoke tests against system Python),
# since the pure function below doesn't actually need them.
if TYPE_CHECKING:  # pragma: no cover
    from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# Confidence boost when a Wave E-6 plan-tier scrape confirms the perk.
# Capped at this value rather than 1.0 because a stale snapshot is
# slightly less trustworthy than a freshly-scraped one.
_SCRAPED_TIER_CONFIDENCE = 0.95


@dataclass
class BundleOverlap:
    """One duplicate-paid finding the user can act on.

    ``parent_subscription_id`` and ``perk_subscription_id`` reference
    rows in the Subscription table — the perk is the one to cancel,
    the parent is what should already include it.
    """

    parent_subscription_id: int | None
    parent_label: str                       # "Xfinity Mobile"
    parent_monthly_cents: int               # what the user pays for the parent
    perk_subscription_id: int               # row to cancel
    perk_merchant: str                      # canonical key
    perk_label: str                         # "Peacock Premium"
    perk_monthly_cents: int                 # what the user pays standalone
    annual_savings_cents: int               # perk_monthly × 12, signed positive
    tier_note: str
    confidence: float                       # 0..1
    activation_url: str | None
    notes: list[str] = field(default_factory=list)
    # Verification reason — short string for the UI to render under the
    # finding so the user knows *why* we flagged it.
    rationale: str = ""


def _matches(name: str, patterns: tuple[str, ...]) -> bool:
    """True if any pattern is a case-insensitive substring of ``name``.

    Empty pattern list returns False (the "card-tied bundle" case is
    handled separately by the caller, not by name matching).
    """
    if not patterns:
        return False
    lower = (name or "").lower()
    return any(p in lower for p in patterns)


def _find_subscription_match(
    subs: list[Any], patterns: tuple[str, ...]
) -> Any | None:
    """Return the highest-cost active subscription that matches.

    "Highest-cost" because if a user has multiple Xfinity rows
    (e.g. Internet + Mobile both present), the more expensive one is
    usually the parent we want; cheaper rows might be the perk.
    """
    candidates = [s for s in subs if _matches(s.name or "", patterns)]
    if not candidates:
        return None
    # |amount| because outflows are stored negative.
    return max(candidates, key=lambda s: abs(s.last_amount_cents or s.amount_cents or 0))


def _bill_in_range(
    parent_monthly_cents: int, bill_range: tuple[int, int] | None
) -> tuple[bool, str]:
    """Return (is_in_range, reason). ``bill_range`` of None → True with neutral reason."""
    if bill_range is None:
        return True, "bill range unknown — assuming bundle applies"
    low, high = bill_range
    bill = abs(parent_monthly_cents)
    if bill < low:
        return False, (
            f"your ${bill/100:.0f}/mo parent bill is below the ${low/100:.0f}-${high/100:.0f}/mo "
            f"tier range that typically includes this perk"
        )
    if bill > high:
        return True, (
            f"your ${bill/100:.0f}/mo parent bill is above the ${low/100:.0f}-${high/100:.0f}/mo "
            f"tier range — likely a higher tier that still includes the perk"
        )
    return True, (
        f"your ${bill/100:.0f}/mo parent bill matches the ${low/100:.0f}-${high/100:.0f}/mo "
        f"tier range that includes this perk"
    )


def _confidence_for_match(
    *, parent_in_range: bool, range_known: bool, has_recent_charge: bool
) -> float:
    """Combine the signals into a single 0-1 score.

    * range_known + in_range + recent → 0.9
    * range_known + in_range + stale → 0.75
    * range_known + out_of_range → 0.5 (still flag, but caveat heavily)
    * range_unknown + recent → 0.65
    * range_unknown + stale → 0.55
    """
    if not range_known:
        return 0.65 if has_recent_charge else 0.55
    if parent_in_range:
        return 0.9 if has_recent_charge else 0.75
    return 0.5


def _has_recent_charge(sub: Any, today: date | None = None) -> bool:
    """True if the subscription has been charged in the last ~45 days.

    Older rows might be cancelled-but-not-marked in the DB, so we
    require a recent transaction signal before assigning high confidence.

    Subscription has no `last_seen_date` column — the closest proxy is
    ``next_expected_date - cadence_days`` (the previous expected charge).
    For monthly subs that's accurate to within a few days; for variable-
    amount or weird cadences it's still a reasonable bound. If either
    field is missing, fall back to "not recent".
    """
    today = today or date.today()
    next_expected = getattr(sub, "next_expected_date", None)
    cadence = getattr(sub, "cadence_days", None) or 30
    if next_expected is None:
        return False
    last_seen = next_expected - timedelta(days=cadence)
    days_since = (today - last_seen).days
    return 0 <= days_since <= 45


def _detect_from_subs(
    subs: list[Any],
    *,
    today: date | None = None,
    plan_snapshots: dict[str, Any] | None = None,
) -> list[BundleOverlap]:
    """Pure function — given a list of Subscription rows, return findings.

    Split from the Session-backed wrapper so the unit test can call this
    directly with plain dataclasses, no SQLAlchemy required.

    ``plan_snapshots`` is an optional ``{provider_key: ScrapedPlanTier}``
    map (Wave E-6). When a bundle entry's ``provider`` matches a key in
    the snapshot map AND the perk's canonical merchant key appears in
    that snapshot's ``perk_keys`` list, the finding's confidence is
    raised to ~0.95 regardless of whether the parent bill is in the
    bundles.yaml ``bill_range_cents`` heuristic. This is how Wave E-6
    upgrades the detector from "guessed from bill amount" to "verified
    against the carrier's account portal."
    """
    bundles = load_bundles()
    if not bundles:
        return []
    snapshots = plan_snapshots or {}

    findings: list[BundleOverlap] = []
    for bundle in bundles:
        # Card-tied bundles (e.g. CSP DashPass) are routed differently —
        # they need to look at the user's CARD accounts, not Subscription
        # rows. Phase 1 of E skips those; Phase 2 (a follow-up) wires
        # them via Account.card_profile_override.
        if not bundle.match_patterns:
            continue

        parent_sub = _find_subscription_match(subs, bundle.match_patterns)
        if parent_sub is None:
            continue
        parent_monthly = abs(parent_sub.last_amount_cents or parent_sub.amount_cents or 0)
        parent_recent = _has_recent_charge(parent_sub, today=today)

        for perk in bundle.perks:
            perk_sub = _find_subscription_match(subs, perk.match_patterns)
            if perk_sub is None:
                continue
            # Don't flag the parent against itself if patterns overlap.
            if perk_sub.id == parent_sub.id:
                continue

            in_range, range_reason = _bill_in_range(parent_monthly, perk.bill_range_cents)
            confidence = _confidence_for_match(
                parent_in_range=in_range,
                range_known=perk.bill_range_cents is not None,
                has_recent_charge=parent_recent,
            )

            # Wave E-6 override: if a plan-tier scrape snapshot exists
            # for this provider and explicitly lists this perk, we trust
            # the portal more than the bill-amount heuristic.
            scraped_tier = snapshots.get(bundle.provider)
            scraped_perk_keys = (
                getattr(scraped_tier, "perk_keys", None) or []
                if scraped_tier is not None
                else []
            )
            if scraped_tier is not None and perk.merchant in scraped_perk_keys:
                confidence = max(confidence, _SCRAPED_TIER_CONFIDENCE)
                range_reason = (
                    f"verified against your {bundle.parent_label} portal "
                    f"(plan: {getattr(scraped_tier, 'plan_name', '?')}) — "
                    f"this perk is on the included-with-your-plan list"
                )
            elif scraped_tier is not None and perk.merchant not in scraped_perk_keys:
                # Portal says NO — strong negative signal. Drop confidence
                # so the UI can hide this row by default. Caller still
                # gets the finding for transparency.
                confidence = min(confidence, 0.2)
                range_reason = (
                    f"checked your {bundle.parent_label} portal — "
                    f"plan '{getattr(scraped_tier, 'plan_name', '?')}' does NOT "
                    f"include this perk"
                )

            perk_monthly = abs(perk_sub.last_amount_cents or perk_sub.amount_cents or perk.perk_value_cents)
            annual_savings = perk_monthly * 12

            rationale = (
                f"You have an active {bundle.parent_label} subscription "
                f"(${parent_monthly/100:.0f}/mo) AND a separate "
                f"{perk.perk_name} charge (${perk_monthly/100:.0f}/mo); "
                f"{range_reason}."
            )

            findings.append(
                BundleOverlap(
                    parent_subscription_id=parent_sub.id,
                    parent_label=bundle.parent_label,
                    parent_monthly_cents=parent_monthly,
                    perk_subscription_id=perk_sub.id,
                    perk_merchant=perk.merchant,
                    perk_label=perk.perk_name,
                    perk_monthly_cents=perk_monthly,
                    annual_savings_cents=annual_savings,
                    tier_note=perk.tier_note,
                    confidence=round(confidence, 2),
                    activation_url=perk.activation_url,
                    notes=list(bundle.notes),
                    rationale=rationale,
                )
            )

    findings.sort(key=lambda f: f.annual_savings_cents, reverse=True)
    return findings


def detect_overlaps(
    db: "Session", *, today: date | None = None
) -> list[BundleOverlap]:
    """Session-backed wrapper for the API path.

    Pulls active+suspected subscriptions and delegates to the pure
    function. Dismissed / cancelled rows are excluded — they're not
    active spend, so a stale Peacock row from last year shouldn't
    trigger a finding against your current Xfinity bill.
    """
    # Imported lazily so the module loads without sqlalchemy / db.models
    # in environments that only need the pure function (smoke tests).
    from sqlalchemy import select
    from ..db.models import Subscription, SubscriptionStatus
    # Plan-tier snapshots are also lazy-loaded — the import chain
    # touches the playwright module path; if it's not installed we
    # fall back to an empty dict and the detector behaves like
    # pre-E-6 (bill-amount heuristic only).
    try:
        from ..scrapers.plan_tiers.snapshots import load_snapshots
        plan_snapshots: dict[str, Any] = dict(load_snapshots())
    except Exception:  # noqa: BLE001
        logger.exception("Failed to load plan snapshots — using bill-amount heuristic only")
        plan_snapshots = {}

    subs = list(
        db.execute(
            select(Subscription).where(
                Subscription.status.in_(
                    [SubscriptionStatus.active, SubscriptionStatus.suspected]
                )
            )
        )
        .scalars()
        .all()
    )
    return _detect_from_subs(subs, today=today, plan_snapshots=plan_snapshots)
