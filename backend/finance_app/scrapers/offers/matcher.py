"""Cross-reference offers against actual spending.

Given a list of :class:`ScrapedOffer` from the portal scrapers and the
user's transaction history, compute the **estimated dollar value** of
activating each offer based on what they've actually been spending at
that merchant.

Heuristics
----------
* **Spend baseline**: trailing 90 days of transactions matching the
  offer's merchant. We use a fuzzy-match (rapidfuzz partial_ratio ≥
  85) so "Whole Foods Market #2" matches an offer for "Whole Foods".
* **Value estimate**: ``avg_monthly_spend * reward_pct`` (capped at
  the offer's ``reward_cap_cents``). For fixed-amount offers ("get $5
  back when you spend $25"), the value is the fixed amount IF the
  trailing average month exceeds ``minimum_spend_cents``; otherwise
  zero (we'd be coaching the user to spend MORE than they normally
  do, which is the opposite of helpful).
* **Confidence**: how regularly they shop at the merchant. >= 3
  transactions in the trailing 90d → high (0.9); 1-2 → medium (0.5);
  0 (or never matched) → low (0.1, surfaces with a "you'd need to
  start shopping there" caveat).

The matcher is pure — db-fed, no network. Easy to test offline.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta

from rapidfuzz import fuzz, process
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db.models import Transaction
from .base import ScrapedOffer

logger = logging.getLogger(__name__)


@dataclass
class OfferMatch:
    """Offer + its estimated $ value to this user."""
    offer: ScrapedOffer
    estimated_monthly_value_cents: int
    confidence: float  # 0..1
    matched_txn_count_90d: int
    matched_spend_90d_cents: int
    rationale: str  # short string the UI shows


def _trailing_90d_spend_by_merchant(
    db: Session, *, today: date | None = None
) -> dict[str, tuple[int, int]]:
    """For every merchant string in the last 90d, return (txn_count, total_cents)."""
    today = today or date.today()
    since = today - timedelta(days=90)
    rows = db.execute(
        select(Transaction.description_raw, Transaction.amount_cents)
        .where(Transaction.posted_date >= since)
        .where(Transaction.amount_cents < 0)
    ).all()
    out: dict[str, tuple[int, int]] = {}
    for desc, amt in rows:
        if not desc:
            continue
        key = desc.upper().strip()
        cur = out.get(key, (0, 0))
        out[key] = (cur[0] + 1, cur[1] + (-int(amt)))
    return out


def _best_merchant_match(
    target: str, candidates: list[str], threshold: int = 85
) -> str | None:
    """Pick the closest-matching merchant string above ``threshold``."""
    if not candidates:
        return None
    target_u = target.upper()
    match = process.extractOne(target_u, candidates, scorer=fuzz.partial_ratio)
    if match and match[1] >= threshold:
        return match[0]
    return None


def match_offers_to_spend(
    db: Session, offers: list[ScrapedOffer], *, today: date | None = None
) -> list[OfferMatch]:
    """Return a value-ranked list of OfferMatches.

    Ranks high-value, high-confidence offers first. Filters out offers
    where the trailing minimum-spend gate would coach Chris into
    extra spending (that's not what this app does — see project memory:
    "every recommendation must include before/after math, app never
    coaches into more spend").
    """
    spend_by_merchant = _trailing_90d_spend_by_merchant(db, today=today)
    candidates = list(spend_by_merchant.keys())

    matches: list[OfferMatch] = []
    for offer in offers:
        match_key = _best_merchant_match(offer.merchant_name, candidates)
        if match_key is None:
            txn_count, spend_90d = 0, 0
        else:
            txn_count, spend_90d = spend_by_merchant[match_key]

        # Confidence based on history
        if txn_count >= 3:
            confidence = 0.9
        elif txn_count >= 1:
            confidence = 0.5
        else:
            confidence = 0.1

        # Value estimate
        avg_monthly = spend_90d // 3 if spend_90d else 0  # 90d → ~3 months
        if offer.reward_type == "percent_back":
            bps = offer.reward_value_bps or 0
            est = int(avg_monthly * bps / 10000)
            if offer.reward_cap_cents is not None:
                est = min(est, offer.reward_cap_cents)
            rationale = (
                f"~${avg_monthly/100:.0f}/mo at {offer.merchant_name} "
                f"× {bps/100:.1f}% = ${est/100:.2f}/mo"
                if avg_monthly > 0
                else f"You haven't shopped at {offer.merchant_name} recently — "
                f"value depends on whether you'd start"
            )
        elif offer.reward_type == "fixed_amount":
            min_spend = offer.minimum_spend_cents or 0
            # Only credit the offer if Chris's typical month would HIT the
            # minimum without changing behavior. Otherwise zero — we don't
            # nudge into extra spend.
            if avg_monthly >= min_spend and offer.reward_value_bps is not None:
                # reward_value_bps overloaded as cents for fixed_amount, see scraper
                est = int(offer.reward_value_bps)
                rationale = (
                    f"You typically spend ${avg_monthly/100:.0f}/mo at "
                    f"{offer.merchant_name} (≥${min_spend/100:.0f} minimum). "
                    f"Activating earns ${est/100:.2f}."
                )
            else:
                est = 0
                rationale = (
                    f"Minimum spend ${min_spend/100:.0f} not met by your "
                    f"typical monthly spend at {offer.merchant_name}; skipping."
                )
        else:
            est = 0
            rationale = f"Unknown reward type {offer.reward_type!r} — surface raw."

        matches.append(
            OfferMatch(
                offer=offer,
                estimated_monthly_value_cents=est,
                confidence=confidence,
                matched_txn_count_90d=txn_count,
                matched_spend_90d_cents=spend_90d,
                rationale=rationale,
            )
        )

    # Sort by est value desc * confidence (confident high-value first).
    matches.sort(
        key=lambda m: m.estimated_monthly_value_cents * m.confidence, reverse=True
    )
    return matches
