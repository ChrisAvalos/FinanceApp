"""Deals API — Phase 10 Slice D.

Endpoints
---------
GET    /deals                    list active deals (computed)
POST   /deals/scan               run all configured scrapers
GET    /deals/observations       list price observations
POST   /deals/observations       log a manual observation
PATCH  /deals/observations/{id}  edit
DELETE /deals/observations/{id}  delete
GET    /deals/scraper-status     report which scrapers are auth-ready

The "list active deals" endpoint is read-only computation — it
walks PriceObservations through the detector each time. Cheap
because volume stays small (a few obs × a few patterns).
"""
from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    PriceObservation,
    PriceObservationSource,
)
from finance_app.db.session import get_db
from finance_app.deals import (
    find_deals,
    log_manual_observation,
    run_scrape,
)
from finance_app.deals.scrapers import default_scrapers


router = APIRouter(prefix="/deals", tags=["deals"])


# ---------- Pydantic ----------


class DealOpportunityOut(BaseModel):
    pattern_id: int
    pattern_name: str
    pattern_merchant: str | None
    baseline_cents: int
    deal_merchant: str
    deal_price_cents: int
    savings_cents: int
    savings_pct: float
    observed_at: date
    product_url: str | None
    annual_savings_cents: int | None


class PriceObservationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    recurring_purchase_id: int
    merchant: str
    price_cents: int
    observed_at: date
    source: PriceObservationSource
    in_stock: bool
    product_url: str | None
    notes: str | None
    created_at: datetime


class ManualObservationIn(BaseModel):
    recurring_purchase_id: int
    merchant: str
    price_cents: int
    observed_at: date | None = None
    in_stock: bool = True
    product_url: str | None = None
    notes: str | None = None


class ObservationPatch(BaseModel):
    merchant: str | None = None
    price_cents: int | None = None
    observed_at: date | None = None
    in_stock: bool | None = None
    product_url: str | None = None
    notes: str | None = None


class ScraperRunSummaryOut(BaseModel):
    name: str
    queries_attempted: int
    rows_created: int
    rows_skipped: int
    auth_missing: bool
    error: str | None


class ScrapeRunOut(BaseModel):
    started_at: datetime
    finished_at: datetime
    patterns_scanned: int
    summaries: list[ScraperRunSummaryOut]
    total_observations_created: int


class ScraperStatusOut(BaseModel):
    """Per-store readiness probe for the UI install-hint banner."""
    name: str
    requires_auth: bool
    auth_missing: bool


# ---------- Endpoints ----------


@router.get("", response_model=list[DealOpportunityOut])
def list_deals(
    threshold: float = Query(0.15, ge=0.01, le=0.9),
    window_days: int = Query(30, ge=1, le=365),
    db: Session = Depends(get_db),
) -> list[DealOpportunityOut]:
    """Active deals — observations meaningfully below the user's typical price."""
    deals = find_deals(db, threshold=threshold, window_days=window_days)
    return [
        DealOpportunityOut(
            pattern_id=d.pattern_id,
            pattern_name=d.pattern_name,
            pattern_merchant=d.pattern_merchant,
            baseline_cents=d.baseline_cents,
            deal_merchant=d.deal_merchant,
            deal_price_cents=d.deal_price_cents,
            savings_cents=d.savings_cents,
            savings_pct=d.savings_pct,
            observed_at=d.observed_at,
            product_url=d.product_url,
            annual_savings_cents=d.annual_savings_cents,
        )
        for d in deals
    ]


@router.post("/scan", response_model=ScrapeRunOut)
def scan(db: Session = Depends(get_db)) -> ScrapeRunOut:
    """Run every configured scraper against every active pattern.

    Synchronous on purpose — small volumes, faster to surface "auth
    missing" diagnostics inline. The scheduler job calls
    ``run_scrape`` directly, not this endpoint.
    """
    result = run_scrape(db)
    return ScrapeRunOut(
        started_at=result.started_at,
        finished_at=result.finished_at,
        patterns_scanned=result.patterns_scanned,
        summaries=[
            ScraperRunSummaryOut(
                name=s.name,
                queries_attempted=s.queries_attempted,
                rows_created=s.rows_created,
                rows_skipped=s.rows_skipped,
                auth_missing=s.auth_missing,
                error=s.error,
            )
            for s in result.summaries
        ],
        total_observations_created=result.total_observations_created,
    )


@router.get("/scraper-status", response_model=list[ScraperStatusOut])
def scraper_status() -> list[ScraperStatusOut]:
    """One row per configured scraper with its current auth state."""
    return [
        ScraperStatusOut(
            name=s.name,
            requires_auth=s.requires_auth,
            auth_missing=s.auth_missing(),
        )
        for s in default_scrapers()
    ]


@router.get("/observations", response_model=list[PriceObservationOut])
def list_observations(
    recurring_purchase_id: int | None = None,
    merchant: str | None = None,
    limit: int = 200,
    db: Session = Depends(get_db),
) -> list[PriceObservation]:
    stmt = select(PriceObservation).order_by(
        PriceObservation.observed_at.desc(),
        PriceObservation.id.desc(),
    ).limit(limit)
    if recurring_purchase_id is not None:
        stmt = stmt.where(PriceObservation.recurring_purchase_id == recurring_purchase_id)
    if merchant is not None:
        stmt = stmt.where(PriceObservation.merchant == merchant)
    return list(db.execute(stmt).scalars().all())


@router.post("/observations", response_model=PriceObservationOut, status_code=201)
def create_observation(
    body: ManualObservationIn, db: Session = Depends(get_db)
) -> PriceObservation:
    """Log a manual price sighting — "I saw Charmin at Target for $17.49"."""
    if body.price_cents <= 0:
        raise HTTPException(400, "price_cents must be positive")
    return log_manual_observation(
        db,
        recurring_purchase_id=body.recurring_purchase_id,
        merchant=body.merchant,
        price_cents=body.price_cents,
        observed_at=body.observed_at,
        in_stock=body.in_stock,
        product_url=body.product_url,
        notes=body.notes,
    )


@router.patch("/observations/{oid}", response_model=PriceObservationOut)
def patch_observation(
    oid: int, body: ObservationPatch, db: Session = Depends(get_db)
) -> PriceObservation:
    o = db.get(PriceObservation, oid)
    if o is None:
        raise HTTPException(404, f"PriceObservation {oid} not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(o, k, v)
    db.commit()
    db.refresh(o)
    return o


@router.delete("/observations/{oid}", status_code=204)
def delete_observation(oid: int, db: Session = Depends(get_db)) -> None:
    o = db.get(PriceObservation, oid)
    if o is None:
        raise HTTPException(404, f"PriceObservation {oid} not found")
    db.delete(o)
    db.commit()
