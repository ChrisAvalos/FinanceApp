"""Shopping-patterns API — Phase 10 Slice B.

Endpoints
---------
GET    /shopping-patterns              list detected recurring purchases
POST   /shopping-patterns/detect       re-run the detector + persist
GET    /shopping-patterns/merchant-rollup   Plaid-fed merchant view (no DB writes)
PATCH  /shopping-patterns/{id}         dismiss / rename / re-categorize
DELETE /shopping-patterns/{id}         hard delete
"""
from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    RecurringPurchase,
    RecurringPurchaseStatus,
)
from finance_app.db.session import get_db
from finance_app.shopping_patterns import (
    detect_recurring_purchases,
    merchant_rollup,
    persist_patterns,
)


router = APIRouter(prefix="/shopping-patterns", tags=["shopping-patterns"])


# ---------- Pydantic ----------


class RecurringPurchaseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    canonical_name: str
    primary_merchant: str | None
    primary_sku: str | None
    typical_unit_price_cents: int | None
    typical_line_total_cents: int | None
    typical_quantity_units: int | None
    unit_label: str | None
    cadence_days: int | None
    occurrence_count: int
    first_purchased_at: date | None
    last_purchased_at: date | None
    confidence_score: float
    category: str | None
    status: RecurringPurchaseStatus
    name_locked: bool
    notes: str | None
    created_at: datetime
    updated_at: datetime


class RecurringPurchaseDerived(RecurringPurchaseOut):
    """Adds computed fields the UI uses but the DB doesn't store.

    ``next_expected_at`` = last_purchased_at + cadence_days.
    ``annualized_cost_cents`` = typical_line_total × (365 / cadence_days).
    Both null when the inputs aren't known.
    """
    next_expected_at: date | None
    annualized_cost_cents: int | None
    cadence_label: str | None  # "weekly", "monthly", etc. computed at read time


class RecurringPurchasePatch(BaseModel):
    canonical_name: str | None = None
    primary_merchant: str | None = None
    category: str | None = None
    status: RecurringPurchaseStatus | None = None
    notes: str | None = None
    # name_locked is set automatically when canonical_name changes; the
    # patch can also flip it explicitly to release a lock if the user
    # wants the detector to suggest names again.
    name_locked: bool | None = None


class DetectRunOut(BaseModel):
    created: int
    updated: int
    deactivated: int
    skipped_dismissed: int
    total_active: int


class MerchantRollupRowOut(BaseModel):
    merchant_key: str
    display_name: str
    transaction_count: int
    monthly_avg_cents: int
    median_per_visit_cents: int
    cadence_days: int | None
    last_seen: date | None
    total_lifetime_cents: int
    primary_category_id: int | None
    primary_category_name: str | None


# ---------- Helpers ----------


_CADENCE_BANDS = [
    (5, 10, "weekly"),
    (12, 17, "biweekly"),
    (25, 35, "monthly"),
    (40, 80, "every 6-8 weeks"),
    (85, 100, "quarterly"),
    (160, 200, "every 6 months"),
]


def _cadence_label(cadence_days: int | None) -> str | None:
    if not cadence_days:
        return None
    for lo, hi, lbl in _CADENCE_BANDS:
        if lo <= cadence_days <= hi:
            return lbl
    return None


def _to_derived(r: RecurringPurchase) -> RecurringPurchaseDerived:
    next_expected: date | None = None
    if r.last_purchased_at and r.cadence_days:
        from datetime import timedelta
        next_expected = r.last_purchased_at + timedelta(days=r.cadence_days)

    annualized: int | None = None
    if r.typical_line_total_cents and r.cadence_days and r.cadence_days > 0:
        annualized = int(r.typical_line_total_cents * 365 / r.cadence_days)

    return RecurringPurchaseDerived(
        id=r.id,
        canonical_name=r.canonical_name,
        primary_merchant=r.primary_merchant,
        primary_sku=r.primary_sku,
        typical_unit_price_cents=r.typical_unit_price_cents,
        typical_line_total_cents=r.typical_line_total_cents,
        typical_quantity_units=r.typical_quantity_units,
        unit_label=r.unit_label,
        cadence_days=r.cadence_days,
        occurrence_count=r.occurrence_count,
        first_purchased_at=r.first_purchased_at,
        last_purchased_at=r.last_purchased_at,
        confidence_score=r.confidence_score,
        category=r.category,
        status=r.status,
        name_locked=r.name_locked,
        notes=r.notes,
        created_at=r.created_at,
        updated_at=r.updated_at,
        next_expected_at=next_expected,
        annualized_cost_cents=annualized,
        cadence_label=_cadence_label(r.cadence_days),
    )


# ---------- Endpoints ----------


@router.get("", response_model=list[RecurringPurchaseDerived])
def list_patterns(
    status: RecurringPurchaseStatus | None = None,
    category: str | None = None,
    merchant: str | None = None,
    db: Session = Depends(get_db),
) -> list[RecurringPurchaseDerived]:
    """List recurring-purchase patterns. Sorted by annualized cost desc."""
    stmt = select(RecurringPurchase)
    if status is not None:
        stmt = stmt.where(RecurringPurchase.status == status)
    if category is not None:
        stmt = stmt.where(RecurringPurchase.category == category)
    if merchant is not None:
        stmt = stmt.where(RecurringPurchase.primary_merchant == merchant)
    rows = list(db.execute(stmt).scalars().all())
    derived = [_to_derived(r) for r in rows]
    derived.sort(
        key=lambda r: r.annualized_cost_cents or 0,
        reverse=True,
    )
    return derived


@router.post("/detect", response_model=DetectRunOut)
def run_detect(db: Session = Depends(get_db)) -> DetectRunOut:
    """Re-run the detector + upsert patterns. Idempotent.

    Honors user overrides: dismissed rows stay dismissed, name_locked
    rows keep their hand-edited names.
    """
    detected = detect_recurring_purchases(db)
    res = persist_patterns(db, detected)
    total_active = db.execute(
        select(RecurringPurchase).where(
            RecurringPurchase.status == RecurringPurchaseStatus.active
        )
    ).scalars()
    return DetectRunOut(
        created=res.created,
        updated=res.updated,
        deactivated=res.deactivated,
        skipped_dismissed=res.skipped_dismissed,
        total_active=sum(1 for _ in total_active),
    )


@router.get("/merchant-rollup", response_model=list[MerchantRollupRowOut])
def get_merchant_rollup(
    days: int = Query(365, ge=30, le=1825),
    min_transactions: int = Query(3, ge=2, le=50),
    db: Session = Depends(get_db),
) -> list[MerchantRollupRowOut]:
    """Plaid-side merchant rollup. Doesn't write to the DB.

    Use case: users without receipt OCR data still get value — "you
    spend $180/mo at Costco" comes straight from transaction history.
    """
    rows = merchant_rollup(db, days=days, min_transactions=min_transactions)
    return [
        MerchantRollupRowOut(
            merchant_key=r.merchant_key,
            display_name=r.display_name,
            transaction_count=r.transaction_count,
            monthly_avg_cents=r.monthly_avg_cents,
            median_per_visit_cents=r.median_per_visit_cents,
            cadence_days=r.cadence_days,
            last_seen=r.last_seen,
            total_lifetime_cents=r.total_lifetime_cents,
            primary_category_id=r.primary_category_id,
            primary_category_name=r.primary_category_name,
        )
        for r in rows
    ]


@router.patch("/{rid}", response_model=RecurringPurchaseDerived)
def patch_pattern(
    rid: int, body: RecurringPurchasePatch, db: Session = Depends(get_db)
) -> RecurringPurchaseDerived:
    r = db.get(RecurringPurchase, rid)
    if r is None:
        raise HTTPException(404, f"RecurringPurchase {rid} not found")
    patch = body.model_dump(exclude_unset=True)
    if "canonical_name" in patch and patch["canonical_name"]:
        # Auto-lock the name when user renames so the detector won't
        # clobber on next run. They can flip name_locked=False to
        # release the lock.
        r.name_locked = True
    for k, v in patch.items():
        setattr(r, k, v)
    db.commit()
    db.refresh(r)
    return _to_derived(r)


@router.delete("/{rid}", status_code=204)
def delete_pattern(rid: int, db: Session = Depends(get_db)) -> None:
    r = db.get(RecurringPurchase, rid)
    if r is None:
        raise HTTPException(404, f"RecurringPurchase {rid} not found")
    db.delete(r)
    db.commit()
