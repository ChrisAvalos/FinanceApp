"""Coordinator: runs every registered scraper, persists ScrapedClaims,
returns a per-source summary.

The coordinator owns the side effects (HTTP fetches, DB writes,
exception handling). Each scraper stays focused on parsing.

Persistence semantics
---------------------
Dedup key is ``LegalClaim.source_url`` (UNIQUE). For each scraped row:

* No row with that URL → INSERT, count as ``rows_created``.
* Row exists, status is still ``available`` → UPDATE in place if any
  field differs. Counts as ``rows_updated``. We never blow away rows
  the user has already advanced through the lifecycle (claimed / paid
  / dismissed) — the user has moved on, and re-overwriting their notes
  with whatever the scraper saw this week would be hostile.
* Row exists, status is past available → ``rows_skipped``. (No write.)

Errors are isolated per source: one scraper blowing up doesn't
cancel the others. The error message is captured into
``ScraperRunSummary.error`` and surfaced in the UI toast.

Why this isn't an upsert SQL statement
--------------------------------------
SQLite doesn't have a portable ``ON CONFLICT DO UPDATE`` syntax that
plays nicely with our ORM models, and we want to compute "did
anything actually change" so we don't bump ``updated_at`` for every
no-op weekly run. Doing it in Python keeps the diff logic explicit.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Iterable

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.api.schemas import ScraperRunResponse, ScraperRunSummary
from finance_app.db.models import LegalClaim, LegalClaimStatus

from .base import LegalClaimScraper, ScrapedClaim
from .state_parser import extract_states

logger = logging.getLogger(__name__)


# Fields on LegalClaim that the scraper is allowed to update. Anything
# not in here (e.g. ``status``, ``claimed_at``) is owned by the user
# and must never be touched by automated runs.
_UPDATABLE_FIELDS: tuple[str, ...] = (
    "name",
    "administrator",
    "case_number",
    "description",
    "eligibility",
    "proof_status",
    "estimated_payout_cents",
    "claim_deadline",
    "state_eligibility",
)


def _enrich_state(claim: ScrapedClaim) -> None:
    """Populate ``state_eligibility`` from title + description + eligibility text.

    Mutates the dataclass in place. Skipped if the scraper already set
    a non-default value (a future state-specific scraper might know the
    answer better than the parser).
    """
    if claim.state_eligibility and claim.state_eligibility != "nationwide":
        return
    detected = extract_states(
        claim.name or "",
        claim.eligibility or "",
        claim.description or "",
    )
    claim.state_eligibility = detected


def _apply_scraped_to_row(row: LegalClaim, claim: ScrapedClaim) -> bool:
    """Copy non-empty fields from ``claim`` onto ``row``. Returns True if anything changed.

    "Non-empty" matters because scrapers prefer to leave fields None
    rather than guess. We don't want a re-scrape that produced fewer
    fields to clobber the row's existing data.
    """
    changed = False
    for field_name in _UPDATABLE_FIELDS:
        new = getattr(claim, field_name)
        if new is None or new == "":
            continue
        old = getattr(row, field_name)
        if old != new:
            setattr(row, field_name, new)
            changed = True
    # Notes: append rather than overwrite so manual user notes survive.
    incoming_notes = claim.notes or ""
    if incoming_notes and incoming_notes not in (row.notes or ""):
        suffix = f"[scraper] {incoming_notes}"
        row.notes = (row.notes + "\n" + suffix) if row.notes else suffix
        changed = True
    return changed


def _persist_one(db: Session, scraper_name: str, claim: ScrapedClaim) -> str:
    """Persist a single scraped claim and return one of:
    ``"created" | "updated" | "skipped"``.

    Caller is responsible for committing / flushing — we want a single
    transaction across the whole source so a partial failure rolls
    back cleanly without half-written rows.
    """
    existing = db.execute(
        select(LegalClaim).where(LegalClaim.source_url == claim.source_url)
    ).scalar_one_or_none()

    if existing is None:
        row = LegalClaim(
            name=claim.name,
            source_url=claim.source_url,
            administrator=claim.administrator,
            case_number=claim.case_number,
            description=claim.description,
            eligibility=claim.eligibility,
            proof_status=claim.proof_status,
            estimated_payout_cents=claim.estimated_payout_cents,
            claim_deadline=claim.claim_deadline,
            notes=claim.notes,
            state_eligibility=claim.state_eligibility,
            source=f"scraper:{scraper_name}",
            status=LegalClaimStatus.available,
        )
        db.add(row)
        return "created"

    # Don't touch rows the user has already moved past `available`.
    if existing.status != LegalClaimStatus.available:
        return "skipped"

    changed = _apply_scraped_to_row(existing, claim)
    return "updated" if changed else "skipped"


def run_one_scraper(
    db: Session,
    scraper: LegalClaimScraper,
    client: httpx.Client,
) -> ScraperRunSummary:
    """Run a single scraper and persist its rows. Catches exceptions
    so a flaky source never breaks the rest of the run.

    Per-row exceptions are swallowed and counted as ``skipped`` —
    a single bad detail page shouldn't poison a 30-row scrape.
    """
    seen = created = updated = skipped = 0
    err: str | None = None
    try:
        for listing in scraper.fetch_pages(client):
            seen += 1
            try:
                claim = scraper.parse(listing)
            except Exception as e:  # noqa: BLE001 — per-row resilience
                logger.warning(
                    "scraper %s parse failed for %s: %r",
                    scraper.name, listing.url, e,
                )
                skipped += 1
                continue
            if claim is None:
                skipped += 1
                continue
            # Enrich state eligibility before persistence — keeps scraper
            # implementations dumb about state extraction.
            _enrich_state(claim)
            try:
                outcome = _persist_one(db, scraper.name, claim)
            except Exception as e:  # noqa: BLE001 — per-row resilience
                logger.warning(
                    "scraper %s persist failed for %s: %r",
                    scraper.name, claim.source_url, e,
                )
                db.rollback()
                skipped += 1
                continue
            if outcome == "created":
                created += 1
            elif outcome == "updated":
                updated += 1
            else:
                skipped += 1
        # Single commit per source — atomic, easy to reason about.
        db.commit()
    except Exception as e:  # noqa: BLE001 — top-level isolation
        logger.exception("scraper %s blew up: %r", scraper.name, e)
        db.rollback()
        err = f"{type(e).__name__}: {e}"

    return ScraperRunSummary(
        source=scraper.name,
        rows_seen=seen,
        rows_created=created,
        rows_updated=updated,
        rows_skipped=skipped,
        error=err,
    )


def run_scrapers(
    db: Session,
    scrapers: Iterable[LegalClaimScraper],
    client: httpx.Client | None = None,
) -> ScraperRunResponse:
    """Run every scraper sequentially against a single shared HTTP client.

    Sequential rather than parallel: aggregator sites are small and
    rate-limit unfriendly to bursts, and the wall-clock difference for
    2-3 sources is meaningless. Keeps logs and DB transactions easy
    to follow.
    """
    started = datetime.utcnow()
    own_client = False
    if client is None:
        # 20s timeout matches the rest of our HTTP code; aggregator
        # detail pages are static HTML so this is plenty.
        client = httpx.Client(
            timeout=20.0,
            follow_redirects=True,
            headers={"User-Agent": "FinanceAppScraper/0.1 (+local)"},
        )
        own_client = True

    summaries: list[ScraperRunSummary] = []
    try:
        for s in scrapers:
            summaries.append(run_one_scraper(db, s, client))
    finally:
        if own_client:
            client.close()

    return ScraperRunResponse(
        started_at=started,
        finished_at=datetime.utcnow(),
        summaries=summaries,
        total_created=sum(s.rows_created for s in summaries),
        total_updated=sum(s.rows_updated for s in summaries),
    )
