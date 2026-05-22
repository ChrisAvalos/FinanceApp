"""Canonical products API — Phase 10 Slice E.

Endpoints
---------
GET    /canonical-products             list (search + filter)
GET    /canonical-products/{id}        detail with linked items + patterns
POST   /canonical-products             manual create
PATCH  /canonical-products/{id}        rename / re-categorize / set UPC
DELETE /canonical-products/{id}        delete + null any FKs (SET NULL)
POST   /canonical-products/canonicalize  run the canonicalizer over unmatched data
POST   /canonical-products/merge       merge drop_id into keep_id
POST   /canonical-products/{id}/link-item   manually link a ReceiptItem
"""
from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.canonicalization import canonicalize_unmatched
from finance_app.canonicalization.canonicalizer import merge_canonicals
from finance_app.db.models import (
    CanonicalProduct,
    PriceObservation,
    ReceiptItem,
    RecurringPurchase,
)
from finance_app.db.session import get_db


router = APIRouter(prefix="/canonical-products", tags=["canonical-products"])


# ---------- Pydantic ----------


class CanonicalProductOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    brand: str | None
    category: str | None
    size_value: float | None
    size_unit: str | None
    form: str | None
    normalized_key: str
    primary_upc: str | None
    name_locked: bool
    notes: str | None
    created_at: datetime
    updated_at: datetime


class CanonicalProductDerived(CanonicalProductOut):
    """Adds counts the UI needs but the DB doesn't store."""
    receipt_item_count: int
    recurring_pattern_count: int
    observation_count: int
    merchants: list[str]  # distinct merchants where this canonical appears


class CanonicalProductIn(BaseModel):
    name: str
    brand: str | None = None
    category: str | None = None
    size_value: float | None = None
    size_unit: str | None = None
    form: str | None = None
    primary_upc: str | None = None
    notes: str | None = None


class CanonicalProductPatch(BaseModel):
    name: str | None = None
    brand: str | None = None
    category: str | None = None
    size_value: float | None = None
    size_unit: str | None = None
    form: str | None = None
    primary_upc: str | None = None
    notes: str | None = None
    name_locked: bool | None = None


class MergeRequest(BaseModel):
    keep_id: int
    drop_id: int


class CanonicalizeRunOut(BaseModel):
    items_processed: int
    items_linked: int
    patterns_processed: int
    patterns_linked: int
    canonicals_created: int


class LinkedReceiptItemOut(BaseModel):
    """Slim view of a linked ReceiptItem for the detail page."""
    receipt_item_id: int
    receipt_id: int
    merchant: str | None
    purchase_date: date | None
    name: str | None
    raw_line: str
    line_total_cents: int | None
    quantity_units: int


class CanonicalProductDetailOut(CanonicalProductDerived):
    linked_items: list[LinkedReceiptItemOut]
    linked_patterns: list[dict]  # canonical_name + cadence + occurrence_count


# ---------- Helpers ----------


def _derive(c: CanonicalProduct, db: Session) -> CanonicalProductDerived:
    item_count = db.execute(
        select(ReceiptItem.id).where(ReceiptItem.canonical_product_id == c.id)
    ).all()
    pattern_count = db.execute(
        select(RecurringPurchase.id).where(
            RecurringPurchase.canonical_product_id == c.id
        )
    ).all()
    # Observations are linked through RecurringPurchase, not directly
    pattern_ids = [p[0] for p in pattern_count]
    obs_count = 0
    if pattern_ids:
        obs_count = len(
            db.execute(
                select(PriceObservation.id).where(
                    PriceObservation.recurring_purchase_id.in_(pattern_ids)
                )
            ).all()
        )

    # Distinct merchants: union of (Receipt.merchant via items) +
    # (RecurringPurchase.primary_merchant via patterns) +
    # (PriceObservation.merchant via observations).
    merchants: set[str] = set()
    if pattern_ids:
        rows = db.execute(
            select(PriceObservation.merchant).where(
                PriceObservation.recurring_purchase_id.in_(pattern_ids)
            )
        ).all()
        merchants.update(r[0] for r in rows if r[0])
    pattern_merchants = db.execute(
        select(RecurringPurchase.primary_merchant).where(
            RecurringPurchase.canonical_product_id == c.id
        )
    ).all()
    merchants.update(r[0] for r in pattern_merchants if r[0])

    return CanonicalProductDerived(
        id=c.id,
        name=c.name,
        brand=c.brand,
        category=c.category,
        size_value=c.size_value,
        size_unit=c.size_unit,
        form=c.form,
        normalized_key=c.normalized_key,
        primary_upc=c.primary_upc,
        name_locked=c.name_locked,
        notes=c.notes,
        created_at=c.created_at,
        updated_at=c.updated_at,
        receipt_item_count=len(item_count),
        recurring_pattern_count=len(pattern_count),
        observation_count=obs_count,
        merchants=sorted(merchants),
    )


# ---------- Endpoints ----------


@router.get("", response_model=list[CanonicalProductDerived])
def list_canonicals(
    q: str | None = Query(None, description="Search across name + brand"),
    brand: str | None = None,
    category: str | None = None,
    db: Session = Depends(get_db),
) -> list[CanonicalProductDerived]:
    stmt = select(CanonicalProduct).order_by(CanonicalProduct.name)
    if q:
        like = f"%{q.lower()}%"
        # Use lower() comparisons so "charmin" finds "Charmin" reliably
        from sqlalchemy import or_, func as sqlfunc
        stmt = stmt.where(
            or_(
                sqlfunc.lower(CanonicalProduct.name).like(like),
                sqlfunc.lower(CanonicalProduct.brand).like(like),
                sqlfunc.lower(CanonicalProduct.normalized_key).like(like),
            )
        )
    if brand:
        stmt = stmt.where(CanonicalProduct.brand == brand)
    if category:
        stmt = stmt.where(CanonicalProduct.category == category)
    rows = list(db.execute(stmt).scalars().all())
    return [_derive(c, db) for c in rows]


@router.get("/{cid}", response_model=CanonicalProductDetailOut)
def get_canonical(cid: int, db: Session = Depends(get_db)) -> CanonicalProductDetailOut:
    c = db.get(CanonicalProduct, cid)
    if c is None:
        raise HTTPException(404, f"CanonicalProduct {cid} not found")
    derived = _derive(c, db)

    # Linked receipt items — join through ReceiptItem.receipt_id back to
    # Receipt for merchant + purchase_date.
    from finance_app.db.models import Receipt
    item_rows = db.execute(
        select(ReceiptItem, Receipt)
        .join(Receipt, ReceiptItem.receipt_id == Receipt.id)
        .where(ReceiptItem.canonical_product_id == cid)
        .order_by(Receipt.purchase_date.desc())
    ).all()

    linked_items = [
        LinkedReceiptItemOut(
            receipt_item_id=item.id,
            receipt_id=item.receipt_id,
            merchant=receipt.merchant,
            purchase_date=receipt.purchase_date,
            name=item.name,
            raw_line=item.raw_line,
            line_total_cents=item.line_total_cents,
            quantity_units=item.quantity_units,
        )
        for item, receipt in item_rows
    ]

    pattern_rows = list(
        db.execute(
            select(RecurringPurchase).where(
                RecurringPurchase.canonical_product_id == cid
            )
        ).scalars().all()
    )
    linked_patterns = [
        {
            "id": p.id,
            "canonical_name": p.canonical_name,
            "primary_merchant": p.primary_merchant,
            "cadence_days": p.cadence_days,
            "occurrence_count": p.occurrence_count,
            "typical_line_total_cents": p.typical_line_total_cents,
        }
        for p in pattern_rows
    ]

    return CanonicalProductDetailOut(
        **derived.model_dump(),
        linked_items=linked_items,
        linked_patterns=linked_patterns,
    )


@router.post("", response_model=CanonicalProductOut, status_code=201)
def create_canonical(
    body: CanonicalProductIn, db: Session = Depends(get_db)
) -> CanonicalProduct:
    """Manual create — useful when the user wants to seed a canonical
    before any receipts have linked to it (e.g., to start tracking
    deals on a new item)."""
    from finance_app.canonicalization import normalize
    norm = normalize(body.name)
    row = CanonicalProduct(
        name=body.name.strip(),
        brand=body.brand,
        category=body.category,
        size_value=body.size_value,
        size_unit=body.size_unit,
        form=body.form,
        normalized_key=norm or body.name.lower()[:300],
        primary_upc=body.primary_upc,
        notes=body.notes,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/{cid}", response_model=CanonicalProductOut)
def patch_canonical(
    cid: int, body: CanonicalProductPatch, db: Session = Depends(get_db)
) -> CanonicalProduct:
    c = db.get(CanonicalProduct, cid)
    if c is None:
        raise HTTPException(404, f"CanonicalProduct {cid} not found")
    patch = body.model_dump(exclude_unset=True)
    if "name" in patch and patch["name"]:
        # Auto-lock on rename — same as RecurringPurchase
        c.name_locked = True
    for k, v in patch.items():
        setattr(c, k, v)
    db.commit()
    db.refresh(c)
    return c


@router.delete("/{cid}", status_code=204)
def delete_canonical(cid: int, db: Session = Depends(get_db)) -> None:
    c = db.get(CanonicalProduct, cid)
    if c is None:
        raise HTTPException(404, f"CanonicalProduct {cid} not found")
    db.delete(c)
    db.commit()


@router.post("/canonicalize", response_model=CanonicalizeRunOut)
def run_canonicalize(db: Session = Depends(get_db)) -> CanonicalizeRunOut:
    """Walk every unmatched ReceiptItem + RecurringPurchase, find or
    create a CanonicalProduct, persist the link. Idempotent."""
    res = canonicalize_unmatched(db)
    return CanonicalizeRunOut(
        items_processed=res.items_processed,
        items_linked=res.items_linked,
        patterns_processed=res.patterns_processed,
        patterns_linked=res.patterns_linked,
        canonicals_created=res.canonicals_created,
    )


@router.post("/merge", response_model=CanonicalProductOut)
def merge(body: MergeRequest, db: Session = Depends(get_db)) -> CanonicalProduct:
    """Merge ``drop_id`` into ``keep_id``. Re-points every ReceiptItem
    and RecurringPurchase that pointed at drop, then deletes drop."""
    try:
        return merge_canonicals(db, keep_id=body.keep_id, drop_id=body.drop_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/{cid}/link-item/{item_id}", status_code=204)
def link_receipt_item(
    cid: int, item_id: int, db: Session = Depends(get_db)
) -> None:
    """Manually attach a ReceiptItem to a canonical product —
    overrides whatever the auto-canonicalizer chose."""
    c = db.get(CanonicalProduct, cid)
    if c is None:
        raise HTTPException(404, f"CanonicalProduct {cid} not found")
    item = db.get(ReceiptItem, item_id)
    if item is None:
        raise HTTPException(404, f"ReceiptItem {item_id} not found")
    item.canonical_product_id = cid
    item.canonical_key = c.normalized_key
    db.commit()
