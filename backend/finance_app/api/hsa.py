"""HSA receipt bank API — Phase 9.2.

GET    /hsa/receipts                  list (filterable: status)
POST   /hsa/receipts                  log a new receipt
GET    /hsa/receipts/summary          lifetime accumulator + projected tax-free growth
PATCH  /hsa/receipts/{id}/reimburse   mark a receipt reimbursed
PATCH  /hsa/receipts/{id}             edit
DELETE /hsa/receipts/{id}             delete
"""
from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import HsaReceipt, HsaReceiptStatus
from finance_app.db.session import get_db


router = APIRouter(prefix="/hsa", tags=["hsa"])


# --- Pydantic --------------------------------------------------------


class HsaReceiptIn(BaseModel):
    expense_date: date
    amount_cents: int
    description: str
    expense_category: str | None = None
    provider_name: str | None = None
    payment_method: str | None = None
    transaction_id: int | None = None
    receipt_path: str | None = None
    notes: str | None = None


class HsaReceiptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    expense_date: date
    amount_cents: int
    description: str
    expense_category: str | None
    provider_name: str | None
    payment_method: str | None
    transaction_id: int | None
    receipt_path: str | None
    status: HsaReceiptStatus
    reimbursed_at: datetime | None
    notes: str | None
    created_at: datetime


class ReimbursePatch(BaseModel):
    notes: str | None = None


class HsaSummaryOut(BaseModel):
    """Lifetime accumulator: how much tax-free reimbursement headroom you've stored."""
    total_receipts: int
    saved_count: int
    saved_total_cents: int
    reimbursed_total_cents: int
    voided_count: int
    earliest_saved_date: date | None
    latest_saved_date: date | None
    # Hypothetical: if you'd left this in HSA at 7%/yr (long-run S&P), what
    # would it grow to over 30yr?
    projected_at_30yr_7pct_cents: int
    summary_text: str


# --- Endpoints -------------------------------------------------------


@router.get("/receipts", response_model=list[HsaReceiptOut])
def list_receipts(
    status: HsaReceiptStatus | None = None, db: Session = Depends(get_db)
) -> list[HsaReceipt]:
    stmt = select(HsaReceipt).order_by(HsaReceipt.expense_date.desc())
    if status is not None:
        stmt = stmt.where(HsaReceipt.status == status)
    return list(db.execute(stmt).scalars().all())


@router.post("/receipts", response_model=HsaReceiptOut, status_code=201)
def create_receipt(body: HsaReceiptIn, db: Session = Depends(get_db)) -> HsaReceipt:
    if body.amount_cents <= 0:
        raise HTTPException(400, "amount_cents must be positive (out-of-pocket spend)")
    row = HsaReceipt(**body.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/receipts/{rid}/reimburse", response_model=HsaReceiptOut)
def reimburse(
    rid: int, body: ReimbursePatch, db: Session = Depends(get_db)
) -> HsaReceipt:
    """Mark a stored receipt as reimbursed (HSA distribution issued)."""
    row = db.get(HsaReceipt, rid)
    if row is None:
        raise HTTPException(404, f"Receipt {rid} not found")
    if row.status != HsaReceiptStatus.saved:
        raise HTTPException(400, f"Receipt is not 'saved' (currently {row.status})")
    row.status = HsaReceiptStatus.reimbursed
    row.reimbursed_at = datetime.utcnow()
    if body.notes:
        existing = row.notes or ""
        sep = "\n\n" if existing else ""
        row.notes = f"{existing}{sep}[reimbursed {row.reimbursed_at.isoformat()}Z] {body.notes}"
    db.commit()
    db.refresh(row)
    return row


@router.patch("/receipts/{rid}", response_model=HsaReceiptOut)
def update_receipt(
    rid: int, body: HsaReceiptIn, db: Session = Depends(get_db)
) -> HsaReceipt:
    row = db.get(HsaReceipt, rid)
    if row is None:
        raise HTTPException(404, f"Receipt {rid} not found")
    for k, v in body.model_dump().items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/receipts/{rid}", status_code=204)
def delete_receipt(rid: int, db: Session = Depends(get_db)) -> None:
    row = db.get(HsaReceipt, rid)
    if row is None:
        raise HTTPException(404, f"Receipt {rid} not found")
    db.delete(row)
    db.commit()


@router.get("/receipts/summary", response_model=HsaSummaryOut)
def get_summary(db: Session = Depends(get_db)) -> HsaSummaryOut:
    rows = list(db.execute(select(HsaReceipt)).scalars().all())
    saved = [r for r in rows if r.status == HsaReceiptStatus.saved]
    reimbursed = [r for r in rows if r.status == HsaReceiptStatus.reimbursed]
    voided = [r for r in rows if r.status == HsaReceiptStatus.voided]
    saved_total = sum(r.amount_cents for r in saved)
    reimbursed_total = sum(r.amount_cents for r in reimbursed)
    earliest = min((r.expense_date for r in saved), default=None)
    latest = max((r.expense_date for r in saved), default=None)
    # Compounding projection: 30 years at 7% real return
    projected_30 = int(saved_total * (1.07 ** 30))
    summary_text = (
        f"You have ${saved_total/100:,.0f} in saved receipts ready to "
        f"reimburse from your HSA tax-free, any time. If you keep that "
        f"$ amount invested in the HSA at 7% real returns for 30 years "
        f"before reimbursing, the HSA will be worth "
        f"${projected_30/100:,.0f} when you draw against these receipts."
        if saved_total > 0
        else "No saved receipts yet. Start by logging out-of-pocket medical expenses; HSA reimbursement is unlimited in time as long as you save the receipt."
    )
    return HsaSummaryOut(
        total_receipts=len(rows),
        saved_count=len(saved),
        saved_total_cents=saved_total,
        reimbursed_total_cents=reimbursed_total,
        voided_count=len(voided),
        earliest_saved_date=earliest,
        latest_saved_date=latest,
        projected_at_30yr_7pct_cents=projected_30,
        summary_text=summary_text,
    )
