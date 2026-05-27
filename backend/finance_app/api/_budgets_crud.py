"""CRUD endpoints for Budget rows (list / upsert / delete)."""
from __future__ import annotations

from datetime import date

from fastapi import Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from finance_app.api._budgets_helpers import _normalize_month_start
from finance_app.api.schemas import BudgetIn, BudgetOut
from finance_app.db.models import Budget, Category
from finance_app.db.session import get_db


def list_budgets(
    month_start: date | None = None,
    db: Session = Depends(get_db),
) -> list[BudgetOut]:
    stmt = select(Budget)
    if month_start is not None:
        stmt = stmt.where(Budget.month_start == _normalize_month_start(month_start))
    stmt = stmt.order_by(Budget.month_start.desc(), Budget.category_id)
    rows = db.execute(stmt).scalars().all()
    return [BudgetOut.model_validate(r) for r in rows]


def upsert_budget(body: BudgetIn, db: Session = Depends(get_db)) -> BudgetOut:
    """Create or update a budget for (category, month).

    We upsert on the uniqueness tuple rather than separate POST/PUT endpoints —
    the UI model is "edit the cell," and the API should match that intent.
    """
    ms = _normalize_month_start(body.month_start)
    existing = db.execute(
        select(Budget).where(
            Budget.category_id == body.category_id,
            Budget.month_start == ms,
        )
    ).scalar_one_or_none()
    if existing is not None:
        existing.amount_cents = body.amount_cents
        existing.rollover = body.rollover
        existing.notes = body.notes
        db.commit()
        db.refresh(existing)
        return BudgetOut.model_validate(existing)

    cat = db.get(Category, body.category_id)
    if cat is None:
        raise HTTPException(404, f"Category {body.category_id} not found")

    budget = Budget(
        category_id=body.category_id,
        month_start=ms,
        amount_cents=body.amount_cents,
        rollover=body.rollover,
        notes=body.notes,
    )
    db.add(budget)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, f"Duplicate budget: {exc}") from exc
    db.refresh(budget)
    return BudgetOut.model_validate(budget)


def delete_budget(budget_id: int, db: Session = Depends(get_db)) -> None:
    b = db.get(Budget, budget_id)
    if b is None:
        raise HTTPException(404, f"Budget {budget_id} not found")
    db.delete(b)
    db.commit()
