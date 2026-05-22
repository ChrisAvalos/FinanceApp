"""Investment holdings + securities API — Phase 9.1.

GET    /securities                  list securities
POST   /securities                  create / upsert (manual entry)
GET    /holdings                    list with current value, cost basis, gain
POST   /holdings                    create one
PATCH  /holdings/{id}               edit (refresh value, change cost basis)
DELETE /holdings/{id}               delete
GET    /holdings/portfolio          top-level: total value, gain, allocation by type
PATCH  /securities/{id}/price       update latest_price_cents (manual refresh)

Manual-entry path is fully usable today. Plaid investments sync is
the future automated path — same shape, just populates the same tables.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import Account, Holding, Security, SecurityType
from finance_app.db.session import get_db


router = APIRouter(tags=["holdings"])


# --- Pydantic --------------------------------------------------------


class SecurityIn(BaseModel):
    ticker: str | None = None
    name: str
    security_type: SecurityType = SecurityType.equity
    cusip: str | None = None
    isin: str | None = None
    latest_price_cents: int | None = None


class SecurityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    ticker: str | None
    name: str
    security_type: SecurityType
    cusip: str | None
    isin: str | None
    latest_price_cents: int | None
    latest_price_at: datetime | None


class PriceUpdate(BaseModel):
    latest_price_cents: int


class HoldingIn(BaseModel):
    account_id: int
    security_id: int
    # User passes a float share-count; we store as quantity_units (×10000)
    quantity: float
    cost_basis_cents: int | None = None
    notes: str | None = None


class HoldingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    account_id: int
    security_id: int
    quantity_units: int  # 10000ths
    cost_basis_cents: int | None
    current_value_cents: int
    as_of: date
    notes: str | None


class HoldingDetailOut(BaseModel):
    """Holding + the joined Security info + computed gain math."""
    id: int
    account_id: int
    account_name: str
    security_id: int
    security_ticker: str | None
    security_name: str
    security_type: SecurityType
    quantity: float          # decoded from quantity_units
    latest_price_cents: int | None
    cost_basis_cents: int | None
    current_value_cents: int
    unrealized_gain_cents: int | None
    unrealized_gain_pct: float | None
    as_of: date


class AllocationSliceOut(BaseModel):
    security_type: str
    total_value_cents: int
    pct: float


class PortfolioOut(BaseModel):
    as_of: date
    total_value_cents: int
    total_cost_basis_cents: int
    total_unrealized_gain_cents: int
    total_unrealized_gain_pct: float
    holdings_count: int
    accounts_count: int
    allocation_by_type: list[AllocationSliceOut]
    top_holdings: list[HoldingDetailOut]  # top 10 by value


# --- Helpers ---------------------------------------------------------


_QUANTITY_SCALE = 10_000


def _quantity_to_float(units: int) -> float:
    return units / _QUANTITY_SCALE


def _quantity_to_units(qty: float) -> int:
    return int(round(qty * _QUANTITY_SCALE))


def _compute_value(qty_units: int, price_cents: int | None) -> int:
    if price_cents is None or qty_units == 0:
        return 0
    # quantity_units / SCALE × price_cents = current value in cents
    return int(round(qty_units * price_cents / _QUANTITY_SCALE))


# --- Securities ------------------------------------------------------


@router.get("/securities", response_model=list[SecurityOut])
def list_securities(db: Session = Depends(get_db)) -> list[Security]:
    return list(
        db.execute(select(Security).order_by(Security.ticker)).scalars().all()
    )


@router.post("/securities", response_model=SecurityOut, status_code=201)
def create_security(body: SecurityIn, db: Session = Depends(get_db)) -> Security:
    """Create or upsert by ticker. Sets latest_price_at when price provided."""
    if body.ticker:
        existing = db.execute(
            select(Security).where(Security.ticker == body.ticker.upper()).limit(1)
        ).scalar_one_or_none()
        if existing is not None:
            existing.name = body.name
            existing.security_type = body.security_type
            if body.latest_price_cents is not None:
                existing.latest_price_cents = body.latest_price_cents
                existing.latest_price_at = datetime.utcnow()
            db.commit()
            db.refresh(existing)
            return existing
    sec = Security(
        ticker=body.ticker.upper() if body.ticker else None,
        name=body.name,
        security_type=body.security_type,
        cusip=body.cusip,
        isin=body.isin,
        latest_price_cents=body.latest_price_cents,
        latest_price_at=datetime.utcnow() if body.latest_price_cents is not None else None,
    )
    db.add(sec)
    db.commit()
    db.refresh(sec)
    return sec


@router.patch("/securities/{sid}/price", response_model=SecurityOut)
def update_price(
    sid: int, body: PriceUpdate, db: Session = Depends(get_db)
) -> Security:
    """Refresh a security's price + recompute every holding's current value."""
    sec = db.get(Security, sid)
    if sec is None:
        raise HTTPException(404, f"Security {sid} not found")
    sec.latest_price_cents = body.latest_price_cents
    sec.latest_price_at = datetime.utcnow()
    # Cascade to holdings — current_value_cents is denormalized.
    for h in db.execute(
        select(Holding).where(Holding.security_id == sid)
    ).scalars().all():
        h.current_value_cents = _compute_value(h.quantity_units, body.latest_price_cents)
    db.commit()
    db.refresh(sec)
    return sec


# --- Holdings --------------------------------------------------------


@router.get("/holdings", response_model=list[HoldingDetailOut])
def list_holdings(db: Session = Depends(get_db)) -> list[HoldingDetailOut]:
    rows = list(
        db.execute(
            select(Holding, Account, Security)
            .join(Account, Account.id == Holding.account_id)
            .join(Security, Security.id == Holding.security_id)
            .order_by(Holding.current_value_cents.desc())
        ).all()
    )
    return [_to_detail(h, a, s) for h, a, s in rows]


@router.post("/holdings", response_model=HoldingDetailOut, status_code=201)
def create_holding(body: HoldingIn, db: Session = Depends(get_db)) -> HoldingDetailOut:
    acct = db.get(Account, body.account_id)
    sec = db.get(Security, body.security_id)
    if acct is None:
        raise HTTPException(404, f"Account {body.account_id} not found")
    if sec is None:
        raise HTTPException(404, f"Security {body.security_id} not found")
    qty_units = _quantity_to_units(body.quantity)
    h = Holding(
        account_id=body.account_id,
        security_id=body.security_id,
        quantity_units=qty_units,
        cost_basis_cents=body.cost_basis_cents,
        current_value_cents=_compute_value(qty_units, sec.latest_price_cents),
        notes=body.notes,
    )
    db.add(h)
    db.commit()
    db.refresh(h)
    return _to_detail(h, acct, sec)


@router.patch("/holdings/{hid}", response_model=HoldingDetailOut)
def update_holding(
    hid: int, body: HoldingIn, db: Session = Depends(get_db)
) -> HoldingDetailOut:
    h = db.get(Holding, hid)
    if h is None:
        raise HTTPException(404, f"Holding {hid} not found")
    h.quantity_units = _quantity_to_units(body.quantity)
    if body.cost_basis_cents is not None:
        h.cost_basis_cents = body.cost_basis_cents
    h.notes = body.notes
    sec = db.get(Security, h.security_id)
    h.current_value_cents = _compute_value(
        h.quantity_units, sec.latest_price_cents if sec else None
    )
    db.commit()
    db.refresh(h)
    acct = db.get(Account, h.account_id)
    return _to_detail(h, acct, sec)


@router.delete("/holdings/{hid}", status_code=204)
def delete_holding(hid: int, db: Session = Depends(get_db)) -> None:
    h = db.get(Holding, hid)
    if h is None:
        raise HTTPException(404, f"Holding {hid} not found")
    db.delete(h)
    db.commit()


@router.get("/holdings/portfolio", response_model=PortfolioOut)
def get_portfolio(db: Session = Depends(get_db)) -> PortfolioOut:
    """Empower-grade portfolio summary."""
    rows = list(
        db.execute(
            select(Holding, Account, Security)
            .join(Account, Account.id == Holding.account_id)
            .join(Security, Security.id == Holding.security_id)
        ).all()
    )
    if not rows:
        return PortfolioOut(
            as_of=date.today(),
            total_value_cents=0,
            total_cost_basis_cents=0,
            total_unrealized_gain_cents=0,
            total_unrealized_gain_pct=0,
            holdings_count=0,
            accounts_count=0,
            allocation_by_type=[],
            top_holdings=[],
        )
    by_type: dict[str, int] = defaultdict(int)
    accts_seen: set[int] = set()
    total_value = 0
    total_cost = 0
    total_cost_known = 0
    for h, a, s in rows:
        accts_seen.add(a.id)
        by_type[s.security_type.value] += h.current_value_cents
        total_value += h.current_value_cents
        if h.cost_basis_cents is not None:
            total_cost += h.cost_basis_cents
            total_cost_known += h.current_value_cents

    gain = total_value - total_cost
    gain_pct = round(gain / total_cost * 100, 2) if total_cost > 0 else 0

    allocation = sorted(
        [
            AllocationSliceOut(
                security_type=t,
                total_value_cents=v,
                pct=round(v / total_value * 100, 1) if total_value else 0,
            )
            for t, v in by_type.items()
        ],
        key=lambda s: s.total_value_cents,
        reverse=True,
    )

    top = [
        _to_detail(h, a, s)
        for h, a, s in sorted(rows, key=lambda x: x[0].current_value_cents, reverse=True)[:10]
    ]

    return PortfolioOut(
        as_of=date.today(),
        total_value_cents=total_value,
        total_cost_basis_cents=total_cost,
        total_unrealized_gain_cents=gain,
        total_unrealized_gain_pct=gain_pct,
        holdings_count=len(rows),
        accounts_count=len(accts_seen),
        allocation_by_type=allocation,
        top_holdings=top,
    )


def _to_detail(h: Holding, a: Account, s: Security) -> HoldingDetailOut:
    qty = _quantity_to_float(h.quantity_units)
    gain: int | None = None
    gain_pct: float | None = None
    if h.cost_basis_cents is not None and h.cost_basis_cents > 0:
        gain = h.current_value_cents - h.cost_basis_cents
        gain_pct = round(gain / h.cost_basis_cents * 100, 2)
    return HoldingDetailOut(
        id=h.id,
        account_id=h.account_id,
        account_name=a.name,
        security_id=h.security_id,
        security_ticker=s.ticker,
        security_name=s.name,
        security_type=s.security_type,
        quantity=qty,
        latest_price_cents=s.latest_price_cents,
        cost_basis_cents=h.cost_basis_cents,
        current_value_cents=h.current_value_cents,
        unrealized_gain_cents=gain,
        unrealized_gain_pct=gain_pct,
        as_of=h.as_of,
    )
