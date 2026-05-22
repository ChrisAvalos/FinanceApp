"""Balance-scraper API — Sprint 43.

One on-demand endpoint that triggers every registered balance
scraper, persists what they return, and returns the result counts.
Symmetric to ``/api/bundles/scrape-tiers`` and ``/api/offers/scrape``
— same shape, same coordinator-result shape.

Why a separate router file
--------------------------
Could fit under ``/api/plaid`` since it's Plaid-adjacent (filling
gaps Plaid leaves), but conceptually it's its own thing: scraped
balances aren't Plaid items, the auth-state lives elsewhere, and the
"sites" set will grow beyond banks (potentially crypto exchanges, etc.).
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from finance_app.db.session import get_db
from finance_app.scrapers.balances import run_scrapers
from finance_app.scrapers.balances.notify import emit_auth_missing_notifications

router = APIRouter(prefix="/balance-scrapers", tags=["balance-scrapers"])


class FailureOut(BaseModel):
    site: str
    error: str


class ScrapeRunOut(BaseModel):
    sites_attempted: int
    sites_succeeded: int
    sites_auth_missing: list[str]
    sites_failed: list[FailureOut]
    balances_written: int
    accounts_created: int
    ran_at: datetime


@router.post("/run", response_model=ScrapeRunOut)
def run_balance_scrapers(db: Session = Depends(get_db)) -> ScrapeRunOut:
    """Trigger an on-demand balance-scraper run across all registered sites.

    For now that's just Albert (Savings + Investing — Cash skipped
    because Plaid already covers it). Future neobanks plug in by
    adding a scraper class to scrapers/balances and the coordinator's
    registry.

    Returns counts + per-site failure list. ``sites_auth_missing``
    lists site_keys whose bootstrap hasn't been run (or whose stored
    cookies have expired); the UI surfaces these as "log in once via
    bootstrap" guidance. ``sites_failed`` is the catch-all for
    layout-change / network errors.
    """
    try:
        result = run_scrapers(db)
    except Exception as exc:  # noqa: BLE001 — coordinator-level failure
        raise HTTPException(
            502, f"Balance scraper run failed: {exc!r}"
        ) from exc
    # Sprint 52 — also queue an auth-missing notification when the
    # user kicks this off manually and a site is still expired.
    # Dedup is shared with the scheduled job (weekly key) so a 5am
    # cron run + a noon manual run on the same day produce ONE
    # notification, not two. Failure here is silent — the user
    # already sees the auth-missing list in the response payload.
    if result.sites_auth_missing:
        try:
            emit_auth_missing_notifications(db, result.sites_auth_missing)
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
    return ScrapeRunOut(
        sites_attempted=result.sites_attempted,
        sites_succeeded=result.sites_succeeded,
        sites_auth_missing=list(result.sites_auth_missing),
        sites_failed=[
            FailureOut(site=s, error=e) for s, e in result.sites_failed
        ],
        balances_written=result.balances_written,
        accounts_created=result.accounts_created,
        ran_at=datetime.utcnow(),
    )
