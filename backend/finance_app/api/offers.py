"""Offers API — Phase 5.1, with 2026-05 panel-lift extensions.

Endpoints
---------
GET    /offers              persisted offer list (filterable, sorted)
GET    /offers/status       per-portal readiness + auth-state freshness
POST   /offers/scrape       run all configured scrapers (Chase + Amex), value-rank
POST   /offers/{id}/status  update an offer's status (activate / dismiss / etc)

The persisted list reads from the ``offers`` table — populated by the
scraper coordinator. Returning persisted state means the panel can
render something useful on first load instead of waiting for the user
to click "Scrape now". Status tracking lets the user mark an offer
"activated" once they click through; subsequent renders dim those rows
so they fall to the bottom of the list visually.

Scrape requires per-site auth-state files. When a portal's auth is
missing, the per-source ``auth_missing`` flag flips on so the UI can
prompt re-login. ``GET /status`` exposes the same readiness data
without actually running a scrape — useful for the panel's status
strip on first load.
"""
from __future__ import annotations

import os
from datetime import date, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import Merchant, Offer, OfferStatus
from finance_app.db.session import get_db
from finance_app.scrapers.offers.base import auth_state_path

router = APIRouter(prefix="/offers", tags=["offers"])


# ---------------------------------------------------------------------------
# Pydantic shapes
# ---------------------------------------------------------------------------


class OfferOut(BaseModel):
    """Persisted offer row, hydrated for the panel.

    Adds two convenience fields the panel needs:

    * ``merchant_name`` — joined from the merchants table when present;
      falls back to the title (Chase Offers' titles already lead with
      the merchant name) so the panel never shows a bare empty cell.
    * ``expires_in_days`` — days until ``expires_on``. Negative means
      already expired; null means no expiry on file. Computed server-
      side so the UI doesn't recompute from the date string.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    description: str | None
    source: str
    reward_type: str | None
    reward_value_bps: int | None
    reward_cap_cents: int | None
    minimum_spend_cents: int | None
    activation_url: str | None
    expires_on: date | None
    status: OfferStatus
    estimated_value_cents: int | None
    merchant_name: str | None
    expires_in_days: int | None
    created_at: datetime
    updated_at: datetime


class OfferStatusUpdate(BaseModel):
    """Request body for the status-update endpoint. We accept the enum
    by string value so the frontend never has to import the enum."""

    status: OfferStatus


class PortalStatusOut(BaseModel):
    """Per-portal readiness summary for the panel's status strip."""

    site_key: str
    name: str
    auth_state_present: bool
    auth_state_age_days: int | None
    auth_state_path: str
    bootstrap_command: str


class OffersStatusOut(BaseModel):
    portals: list[PortalStatusOut]
    total_offers: int
    available_offers: int
    activated_offers: int
    expiring_within_7_days: int


# Inline rather than from coordinator to avoid pulling Playwright into
# the import path of every request handler.
_PORTAL_META: list[tuple[str, str]] = [
    ("chase", "Chase Offers"),
    ("amex", "Amex Offers"),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _expires_in_days(expires_on: date | None) -> int | None:
    if expires_on is None:
        return None
    return (expires_on - date.today()).days


def _hydrate_offer(o: Offer, merchants: dict[int, Merchant]) -> OfferOut:
    """Build OfferOut with merchant name + computed expiry days."""
    merchant_name: str | None = None
    if o.merchant_id is not None:
        m = merchants.get(o.merchant_id)
        if m is not None:
            merchant_name = m.canonical_name
    if merchant_name is None:
        # Most Chase Offers / Amex Offers titles lead with the merchant
        # name (e.g. "Whole Foods Market — 5% back"). Use the head of
        # the title as a graceful fallback.
        head = (o.title or "").split("—")[0].strip()
        merchant_name = head or None
    return OfferOut(
        id=o.id,
        title=o.title,
        description=o.description,
        source=o.source,
        reward_type=o.reward_type,
        reward_value_bps=o.reward_value_bps,
        reward_cap_cents=o.reward_cap_cents,
        minimum_spend_cents=o.minimum_spend_cents,
        activation_url=o.activation_url,
        expires_on=o.expires_on,
        status=o.status,
        estimated_value_cents=o.estimated_value_cents,
        merchant_name=merchant_name,
        expires_in_days=_expires_in_days(o.expires_on),
        created_at=o.created_at,
        updated_at=o.updated_at,
    )


def _portal_status(site_key: str, name: str) -> PortalStatusOut:
    """File-stat the auth-state JSON to surface presence + age.

    Age is computed against the file's mtime, not its ctime, because
    ``ctx.storage_state(path=...)`` rewrites the same file on each
    bootstrap and we want "how long since the user last refreshed it"
    not "how long since first created".
    """
    path = auth_state_path(site_key)
    present = path.exists()
    age_days: int | None = None
    if present:
        try:
            mtime = datetime.fromtimestamp(path.stat().st_mtime)
            age_days = (datetime.utcnow() - mtime).days
        except OSError:
            age_days = None
    bootstrap = (
        f"python -m finance_app.scrapers.offers.bootstrap {site_key}"
    )
    return PortalStatusOut(
        site_key=site_key,
        name=name,
        auth_state_present=present,
        auth_state_age_days=age_days,
        auth_state_path=str(path),
        bootstrap_command=bootstrap,
    )


# ---------------------------------------------------------------------------
# GET /offers — persisted offer list with filters
# ---------------------------------------------------------------------------


@router.get("", response_model=list[OfferOut])
def list_offers(
    status: OfferStatus | None = None,
    source: str | None = None,
    expiring_within_days: int | None = None,
    db: Session = Depends(get_db),
) -> list[OfferOut]:
    """Persisted offer list, sorted for human consumption.

    Sort order: available first, then activated, then redeemed, then
    expired/dismissed; within each bucket, highest estimated value
    first, then soonest expiry. We compute the bucket via a CASE so the
    SQL stays index-friendly even on the trailing JOIN to merchants.
    """
    stmt = select(Offer)
    if status is not None:
        stmt = stmt.where(Offer.status == status)
    if source is not None:
        stmt = stmt.where(Offer.source == source)
    if expiring_within_days is not None:
        cutoff = date.today()
        # Python-side filter post-fetch is cleaner than juggling SQL date
        # arithmetic across SQLite/Postgres; the result set is small.
        rows: list[Offer] = list(db.execute(stmt).scalars().all())
        rows = [
            r
            for r in rows
            if r.expires_on is not None
            and (r.expires_on - cutoff).days <= expiring_within_days
        ]
    else:
        rows = list(db.execute(stmt).scalars().all())

    # Hydrate merchants in one query to avoid N+1 on the per-row lookup.
    merchant_ids = {r.merchant_id for r in rows if r.merchant_id is not None}
    merchants: dict[int, Merchant] = {}
    if merchant_ids:
        merchants = {
            m.id: m
            for m in db.execute(
                select(Merchant).where(Merchant.id.in_(merchant_ids))
            ).scalars()
        }

    # Sort in Python — small list, simple keys, easier to reason about
    # than a multi-column CASE in SQL.
    _STATUS_RANK = {
        OfferStatus.available: 0,
        OfferStatus.activated: 1,
        OfferStatus.redeemed: 2,
        OfferStatus.expired: 3,
        OfferStatus.dismissed: 4,
    }

    def sort_key(o: Offer) -> tuple[int, int, int]:
        ev = -(o.estimated_value_cents or 0)  # higher value first
        ed = (o.expires_on - date.today()).days if o.expires_on else 9999
        return (_STATUS_RANK.get(o.status, 99), ev, ed)

    rows.sort(key=sort_key)
    return [_hydrate_offer(o, merchants) for o in rows]


# ---------------------------------------------------------------------------
# GET /offers/status — portal readiness + scoreboard
# ---------------------------------------------------------------------------


@router.get("/status", response_model=OffersStatusOut)
def offers_status(db: Session = Depends(get_db)) -> OffersStatusOut:
    """Snapshot for the panel's status strip — no scrape, just stat.

    Reports per-portal auth-state freshness AND a scoreboard of how
    many offers are sitting in each lifecycle bucket. Cheap enough to
    call on every panel mount.
    """
    portals = [_portal_status(key, name) for key, name in _PORTAL_META]

    rows = list(db.execute(select(Offer)).scalars().all())
    total = len(rows)
    available = sum(1 for r in rows if r.status == OfferStatus.available)
    activated = sum(1 for r in rows if r.status == OfferStatus.activated)
    today = date.today()
    expiring_soon = sum(
        1
        for r in rows
        if r.status == OfferStatus.available
        and r.expires_on is not None
        and 0 <= (r.expires_on - today).days <= 7
    )
    return OffersStatusOut(
        portals=portals,
        total_offers=total,
        available_offers=available,
        activated_offers=activated,
        expiring_within_7_days=expiring_soon,
    )


# ---------------------------------------------------------------------------
# POST /offers/{id}/status — flip lifecycle state
# ---------------------------------------------------------------------------


@router.post("/{offer_id}/status", response_model=OfferOut)
def update_offer_status(
    offer_id: int,
    body: OfferStatusUpdate,
    db: Session = Depends(get_db),
) -> OfferOut:
    """Flip an offer's lifecycle state.

    The panel calls this when the user clicks "Activated" (after they
    redeem on Chase/Amex), "Dismiss", or "Redeemed" (when the bonus
    actually posts). We treat this as a simple state transition — no
    state-machine validation since the user knows what they're doing.
    """
    o = db.get(Offer, offer_id)
    if o is None:
        raise HTTPException(404, f"Offer {offer_id} not found")
    o.status = body.status
    db.commit()
    db.refresh(o)
    merchants: dict[int, Merchant] = {}
    if o.merchant_id is not None:
        m = db.get(Merchant, o.merchant_id)
        if m is not None:
            merchants[m.id] = m
    return _hydrate_offer(o, merchants)


# ---------------------------------------------------------------------------
# POST /offers/scrape — run scrapers + value-rank (existing)
# ---------------------------------------------------------------------------


class ScrapedOfferOut(BaseModel):
    site_key: str
    merchant_name: str
    title: str
    reward_type: str
    reward_value_bps: int | None
    reward_cap_cents: int | None
    minimum_spend_cents: int | None
    expires_at: date | None
    activation_url: str | None
    raw_text: str


class OfferMatchOut(BaseModel):
    offer: ScrapedOfferOut
    estimated_monthly_value_cents: int
    confidence: float
    matched_txn_count_90d: int
    matched_spend_90d_cents: int
    rationale: str


class ScrapeSummaryOut(BaseModel):
    site_key: str
    name: str
    rows_seen: int
    rows_created: int
    rows_updated: int
    auth_missing: bool
    error: str | None


class OfferScrapeResponse(BaseModel):
    started_at: datetime
    finished_at: datetime
    summaries: list[ScrapeSummaryOut]
    matches: list[OfferMatchOut]
    total_estimated_value_cents: int


@router.post("/scrape", response_model=OfferScrapeResponse)
def scrape_offers(db: Session = Depends(get_db)) -> OfferScrapeResponse:
    """Run all offer scrapers + rank against user's spending.

    Returns per-source summaries (including auth_missing flags) and
    a ranked list of matches. Safe to call even when no auth states
    are bootstrapped — every scraper just reports auth_missing=true
    and the matches list comes back empty.
    """
    from finance_app.scrapers.offers.coordinator import scrape_and_match

    result = scrape_and_match(db)

    return OfferScrapeResponse(
        started_at=result.started_at,
        finished_at=result.finished_at,
        summaries=[
            ScrapeSummaryOut(
                site_key=s.site_key,
                name=s.name,
                rows_seen=s.rows_seen,
                rows_created=s.rows_created,
                rows_updated=s.rows_updated,
                auth_missing=s.auth_missing,
                error=s.error,
            )
            for s in result.summaries
        ],
        matches=[
            OfferMatchOut(
                offer=ScrapedOfferOut(
                    site_key=m.offer.site_key,
                    merchant_name=m.offer.merchant_name,
                    title=m.offer.title,
                    reward_type=m.offer.reward_type,
                    reward_value_bps=m.offer.reward_value_bps,
                    reward_cap_cents=m.offer.reward_cap_cents,
                    minimum_spend_cents=m.offer.minimum_spend_cents,
                    expires_at=m.offer.expires_at,
                    activation_url=m.offer.activation_url,
                    raw_text=m.offer.raw_text,
                ),
                estimated_monthly_value_cents=m.estimated_monthly_value_cents,
                confidence=m.confidence,
                matched_txn_count_90d=m.matched_txn_count_90d,
                matched_spend_90d_cents=m.matched_spend_90d_cents,
                rationale=m.rationale,
            )
            for m in result.matches
        ],
        total_estimated_value_cents=result.total_estimated_value_cents,
    )


# Suppress unused-import warning when running with stricter linters.
_ = os, Path
