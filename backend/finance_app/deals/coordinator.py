"""Deal-scrape coordinator — Phase 10 Slice D.

For each active RecurringPurchase, fan out across every configured
scraper. Each scraper yields zero or one ScrapedPrice per query;
the coordinator persists each into a PriceObservation row.

Dedup key for scraper observations: (recurring_purchase_id, merchant,
observed_at::date). Re-running the scraper twice in one day produces
exactly one row per (pattern, merchant) combo.

Manual observations skip the dedup logic entirely — the user can
log multiple sightings of the same item on the same day from
different stores.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    PriceObservation,
    PriceObservationSource,
    RecurringPurchase,
    RecurringPurchaseStatus,
)

from .scrapers import default_scrapers
from .scrapers.base import DealScraper, ScrapedPrice

logger = logging.getLogger(__name__)


# Source-string → enum mapping. Adds a new scraper here when one
# graduates from stub to real implementation.
_SCRAPER_SOURCE_MAP: dict[str, PriceObservationSource] = {
    "walmart": PriceObservationSource.scraper_walmart,
    "target": PriceObservationSource.scraper_target,
    "costco": PriceObservationSource.scraper_costco,
    "amazon_fresh": PriceObservationSource.scraper_amazon_fresh,
    "kroger": PriceObservationSource.scraper_kroger,
}


@dataclass
class ScraperRunSummary:
    name: str
    queries_attempted: int = 0
    rows_created: int = 0
    rows_skipped: int = 0
    auth_missing: bool = False
    error: str | None = None


@dataclass
class ScrapeRunResult:
    started_at: datetime
    finished_at: datetime
    patterns_scanned: int
    summaries: list[ScraperRunSummary] = field(default_factory=list)
    total_observations_created: int = 0


def _persist_observation(
    db: Session,
    *,
    pattern_id: int,
    scraped: ScrapedPrice,
    source: PriceObservationSource,
) -> bool:
    """Returns True if a new row was inserted, False if dedup'd."""
    same_day = db.execute(
        select(PriceObservation)
        .where(PriceObservation.recurring_purchase_id == pattern_id)
        .where(PriceObservation.merchant == scraped.merchant)
        .where(PriceObservation.observed_at == scraped.observed_at)
        .where(PriceObservation.source == source)
    ).scalar_one_or_none()
    if same_day is not None:
        # Update price in place — same-day re-scrape might find a
        # different number (sale started mid-day). We keep one row
        # per (pattern, merchant, day) and let it reflect the
        # last-seen price for that combo.
        same_day.price_cents = scraped.price_cents
        same_day.in_stock = scraped.in_stock
        same_day.product_url = scraped.product_url or same_day.product_url
        return False
    db.add(
        PriceObservation(
            recurring_purchase_id=pattern_id,
            merchant=scraped.merchant,
            price_cents=scraped.price_cents,
            observed_at=scraped.observed_at,
            source=source,
            in_stock=scraped.in_stock,
            product_url=scraped.product_url,
            notes=scraped.notes,
        )
    )
    return True


def run_scrape(
    db: Session,
    scrapers: Iterable[DealScraper] | None = None,
) -> ScrapeRunResult:
    """Walk every active pattern × every configured scraper.

    For each combination:
      • If the scraper reports ``auth_missing`` → record once in the
        summary and skip (don't try to scrape, don't blow up).
      • Else call ``scrape(query=pattern.canonical_name)``.
      • If the scraper raises → record the error, continue with the
        next pattern. (One bad pattern shouldn't tank the whole run.)
      • Persist the result via ``_persist_observation``.
    """
    started_at = datetime.utcnow()
    if scrapers is None:
        scrapers = default_scrapers()

    patterns = list(
        db.execute(
            select(RecurringPurchase).where(
                RecurringPurchase.status == RecurringPurchaseStatus.active
            )
        ).scalars().all()
    )
    summaries: dict[str, ScraperRunSummary] = {
        s.name: ScraperRunSummary(name=s.name) for s in scrapers
    }
    total_created = 0

    for s in scrapers:
        if s.auth_missing():
            summaries[s.name].auth_missing = True
            continue
        for pattern in patterns:
            summary = summaries[s.name]
            summary.queries_attempted += 1
            try:
                hit = s.scrape(pattern.canonical_name)
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "deal scraper %s blew up on %r: %r",
                    s.name, pattern.canonical_name, e,
                )
                summary.error = f"{type(e).__name__}: {e}"
                continue
            if hit is None:
                summary.rows_skipped += 1
                continue
            source = _SCRAPER_SOURCE_MAP.get(
                s.name, PriceObservationSource.manual
            )
            try:
                created = _persist_observation(
                    db, pattern_id=pattern.id, scraped=hit, source=source
                )
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "persist observation failed for %s/%s: %r",
                    s.name, pattern.canonical_name, e,
                )
                db.rollback()
                summary.rows_skipped += 1
                continue
            if created:
                summary.rows_created += 1
                total_created += 1
            else:
                summary.rows_skipped += 1
        # Single commit per source — small enough that one transaction
        # is fine and rollback semantics stay simple on error.
        db.commit()

    return ScrapeRunResult(
        started_at=started_at,
        finished_at=datetime.utcnow(),
        patterns_scanned=len(patterns),
        summaries=list(summaries.values()),
        total_observations_created=total_created,
    )


def log_manual_observation(
    db: Session,
    *,
    recurring_purchase_id: int,
    merchant: str,
    price_cents: int,
    observed_at: date | None = None,
    in_stock: bool = True,
    product_url: str | None = None,
    notes: str | None = None,
) -> PriceObservation:
    """Convenience wrapper for the API. Always inserts (no dedup) so
    the user can log multiple sightings on the same day."""
    row = PriceObservation(
        recurring_purchase_id=recurring_purchase_id,
        merchant=merchant.strip(),
        price_cents=price_cents,
        observed_at=observed_at or date.today(),
        source=PriceObservationSource.manual,
        in_stock=in_stock,
        product_url=product_url,
        notes=notes,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row
