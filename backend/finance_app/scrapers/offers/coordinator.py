"""Run every offer scraper, persist raw offers, value-rank against spend.

Public entry point: :func:`scrape_and_match` returns a structured
report with per-source scrape summaries + a ranked list of valuable
offers. The API layer wraps this into ``GET /api/offers/scrape``.

Persistence
-----------
Each :class:`ScrapedOffer` lands in the existing ``Offer`` table.
Idempotent on ``(source, merchant_name + title)`` as a stable-ish
dedupe key — Chase and Amex both rotate the underlying offer-ids on
their portal, so name+title is a sturdier idempotency key than the
portal's numeric id.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db.models import Offer
from .amex_offers import AmexOffersScraper
from .base import AuthStateMissing, OfferScraperBase, ScrapedOffer
from .chase_offers import ChaseOffersScraper
from .matcher import OfferMatch, match_offers_to_spend

logger = logging.getLogger(__name__)


# Active scrapers. Append here when adding new portals.
_SCRAPERS: list[OfferScraperBase] = [
    ChaseOffersScraper(),
    AmexOffersScraper(),
]


@dataclass
class ScrapeSummary:
    site_key: str
    name: str
    rows_seen: int
    rows_created: int
    rows_updated: int
    auth_missing: bool = False
    error: str | None = None


@dataclass
class CoordinatorResult:
    started_at: datetime
    finished_at: datetime
    summaries: list[ScrapeSummary] = field(default_factory=list)
    matches: list[OfferMatch] = field(default_factory=list)
    total_estimated_value_cents: int = 0


def _persist_offer(db: Session, offer: ScrapedOffer) -> tuple[int, int]:
    """Idempotent upsert. Returns (created, updated)."""
    existing = db.execute(
        select(Offer)
        .where(Offer.source == offer.site_key)
        .where(Offer.title == offer.title)
        .limit(1)
    ).scalar_one_or_none()
    if existing is not None:
        # Refresh the fields that may shift (cap, expires, url).
        changed = False
        if existing.reward_value_bps != offer.reward_value_bps:
            existing.reward_value_bps = offer.reward_value_bps
            changed = True
        if existing.reward_cap_cents != offer.reward_cap_cents:
            existing.reward_cap_cents = offer.reward_cap_cents
            changed = True
        if existing.activation_url != offer.activation_url:
            existing.activation_url = offer.activation_url
            changed = True
        return (0, 1 if changed else 0)
    row = Offer(
        title=offer.title,
        description=offer.raw_text or None,
        source=offer.site_key,
        reward_type=offer.reward_type,
        reward_value_bps=offer.reward_value_bps,
        reward_cap_cents=offer.reward_cap_cents,
        minimum_spend_cents=offer.minimum_spend_cents,
        activation_url=offer.activation_url,
    )
    db.add(row)
    return (1, 0)


def scrape_and_match(db: Session) -> CoordinatorResult:
    """Run every scraper, persist offers, value-rank against trailing spend."""
    started_at = datetime.utcnow()
    summaries: list[ScrapeSummary] = []
    all_offers: list[ScrapedOffer] = []

    for scraper in _SCRAPERS:
        seen, created, updated = 0, 0, 0
        try:
            offers = scraper.run()
        except AuthStateMissing as e:
            summaries.append(
                ScrapeSummary(
                    site_key=scraper.site_key,
                    name=scraper.name,
                    rows_seen=0,
                    rows_created=0,
                    rows_updated=0,
                    auth_missing=True,
                    error=str(e),
                )
            )
            continue
        except Exception as e:  # noqa: BLE001
            logger.exception("Offer scraper %s crashed", scraper.site_key)
            summaries.append(
                ScrapeSummary(
                    site_key=scraper.site_key,
                    name=scraper.name,
                    rows_seen=0,
                    rows_created=0,
                    rows_updated=0,
                    error=f"{type(e).__name__}: {str(e)[:200]}",
                )
            )
            continue
        seen = len(offers)
        for offer in offers:
            try:
                c, u = _persist_offer(db, offer)
                created += c
                updated += u
            except Exception:  # noqa: BLE001
                logger.exception("Failed to persist offer %s", offer.title)
        all_offers.extend(offers)
        summaries.append(
            ScrapeSummary(
                site_key=scraper.site_key,
                name=scraper.name,
                rows_seen=seen,
                rows_created=created,
                rows_updated=updated,
            )
        )

    db.commit()

    matches = match_offers_to_spend(db, all_offers) if all_offers else []
    total_value = sum(m.estimated_monthly_value_cents for m in matches)

    return CoordinatorResult(
        started_at=started_at,
        finished_at=datetime.utcnow(),
        summaries=summaries,
        matches=matches,
        total_estimated_value_cents=total_value,
    )
