"""Run every credit-score scraper, persist as CreditScoreSnapshot rows.

Public entry point: :func:`scrape_and_persist` runs each enabled
scraper, writes :class:`CreditScoreSnapshot` rows for every observation
that isn't already on file (idempotent on the model's natural-key
tuple), and returns a structured summary suitable for an API response.

Daily cron-friendly
-------------------
The scheduler hook ``run_daily_score_scrape`` wraps this with its own
DB session, so APScheduler can call it without thinking about FastAPI's
``Depends(get_db)`` plumbing.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...db.models import (
    CreditBureau,
    CreditScoreSnapshot,
    CreditScoringModel,
    ScoreSource,
)
from .base import AuthStateMissing, CreditScoreScraperBase, ScrapedScore
from .credit_journey import CreditJourneyScraper
from .credit_karma import CreditKarmaScraper
from .creditwise import CreditWiseScraper
from .smartcredit import SmartCreditScraper

logger = logging.getLogger(__name__)


# Active scrapers. Append here when adding new portals.
_SCRAPERS: list[CreditScoreScraperBase] = [
    CreditKarmaScraper(),
    CreditWiseScraper(),
    CreditJourneyScraper(),
    SmartCreditScraper(),
]


@dataclass
class ScoreScrapeSummary:
    site_key: str
    name: str
    rows_seen: int
    rows_created: int
    rows_skipped_existing: int
    auth_missing: bool = False
    error: str | None = None


@dataclass
class ScoreScrapeResult:
    started_at: datetime
    finished_at: datetime
    summaries: list[ScoreScrapeSummary] = field(default_factory=list)
    new_scores: list[dict] = field(default_factory=list)


def _coerce_bureau(name: str) -> CreditBureau | None:
    try:
        return CreditBureau(name)
    except ValueError:
        return None


def _coerce_model(name: str) -> CreditScoringModel:
    try:
        return CreditScoringModel(name)
    except ValueError:
        return CreditScoringModel.other


# Map each scraper's site_key → the ScoreSource enum value used in the
# DB. Per-portal sources keep the natural-key UC working even when two
# portals report the same bureau on the same day (CK + CW both = TU/VS3).
_SOURCE_BY_SITE_KEY: dict[str, ScoreSource] = {
    "credit_karma": ScoreSource.scraped_credit_karma,
    "creditwise": ScoreSource.scraped_creditwise,
    "credit_journey": ScoreSource.scraped_credit_journey,
}


def _source_for(site_key: str) -> ScoreSource:
    """Pick the right per-portal ScoreSource. Falls back to the generic
    ``scraped`` for unknown site keys (e.g. a stub in tests)."""
    return _SOURCE_BY_SITE_KEY.get(site_key, ScoreSource.scraped)


def _persist(db: Session, s: ScrapedScore) -> bool:
    """Insert one ScrapedScore as a CreditScoreSnapshot. Returns True
    if a new row was created, False if the (bureau, model, as_of, source)
    natural-key already exists.

    The model has a unique constraint on (bureau, scoring_model, as_of,
    source), so a duplicate would raise IntegrityError. We pre-check
    rather than catch — cheap on a small table, cleaner traceback.
    """
    bureau = _coerce_bureau(s.bureau)
    if bureau is None:
        logger.warning("Unknown bureau %r from %s — skipping row", s.bureau, s.site_key)
        return False
    model = _coerce_model(s.scoring_model)
    source = _source_for(s.site_key)

    existing = db.execute(
        select(CreditScoreSnapshot)
        .where(CreditScoreSnapshot.bureau == bureau)
        .where(CreditScoreSnapshot.scoring_model == model)
        .where(CreditScoreSnapshot.as_of == s.as_of)
        .where(CreditScoreSnapshot.source == source)
        .limit(1)
    ).scalar_one_or_none()
    if existing is not None:
        # Same-day re-run: don't double-insert. (User can still log a
        # manual override on the same day; that one has source=manual
        # and counts as a separate row by the natural key.)
        return False

    db.add(
        CreditScoreSnapshot(
            score=s.score,
            bureau=bureau,
            scoring_model=model,
            as_of=s.as_of,
            source=source,
            source_detail=s.source_detail or s.site_key,
            notes=s.notes,
        )
    )
    return True


def scrape_and_persist(db: Session) -> ScoreScrapeResult:
    """Run every credit-score scraper, persist new observations.

    Designed to be cheap to call repeatedly: same-day re-runs are no-ops
    by virtue of the natural-key dedupe. The API + cron both call this.
    """
    started_at = datetime.utcnow()
    summaries: list[ScoreScrapeSummary] = []
    new_scores: list[dict] = []

    for scraper in _SCRAPERS:
        try:
            scores = scraper.run()
        except AuthStateMissing as e:
            summaries.append(
                ScoreScrapeSummary(
                    site_key=scraper.site_key,
                    name=scraper.name,
                    rows_seen=0,
                    rows_created=0,
                    rows_skipped_existing=0,
                    auth_missing=True,
                    error=str(e),
                )
            )
            continue
        except Exception as e:  # noqa: BLE001
            logger.exception("Score scraper %s crashed", scraper.site_key)
            summaries.append(
                ScoreScrapeSummary(
                    site_key=scraper.site_key,
                    name=scraper.name,
                    rows_seen=0,
                    rows_created=0,
                    rows_skipped_existing=0,
                    error=f"{type(e).__name__}: {str(e)[:200]}",
                )
            )
            continue

        created, skipped = 0, 0
        for s in scores:
            try:
                if _persist(db, s):
                    created += 1
                    new_scores.append(
                        {
                            "site_key": s.site_key,
                            "score": s.score,
                            "bureau": s.bureau,
                            "scoring_model": s.scoring_model,
                            "as_of": s.as_of.isoformat(),
                            "source_detail": s.source_detail,
                        }
                    )
                else:
                    skipped += 1
            except Exception:  # noqa: BLE001
                logger.exception("Failed to persist score from %s", s.site_key)
        summaries.append(
            ScoreScrapeSummary(
                site_key=scraper.site_key,
                name=scraper.name,
                rows_seen=len(scores),
                rows_created=created,
                rows_skipped_existing=skipped,
            )
        )

    db.commit()
    return ScoreScrapeResult(
        started_at=started_at,
        finished_at=datetime.utcnow(),
        summaries=summaries,
        new_scores=new_scores,
    )


def run_daily_score_scrape() -> ScoreScrapeResult:
    """APScheduler entry point. Owns its own DB session.

    The scheduler module wires this up alongside the existing daily
    Plaid sync + weekly legal-claim scrape. See
    :mod:`finance_app.scheduler` for registration.
    """
    from ...db.session import SessionLocal  # noqa: WPS433

    db = SessionLocal()
    try:
        return scrape_and_persist(db)
    finally:
        db.close()
