"""Budget templates — copy-from-prior and fill-from-average."""
from __future__ import annotations

from datetime import date, timedelta

from fastapi import Depends, HTTPException
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from finance_app.api._budgets_helpers import (
    _normalize_month_start,
    _prior_month_start,
)
from finance_app.api.schemas import (
    BudgetCopyRequest,
    BudgetFillRequest,
    BudgetTemplateApplied,
    BudgetTemplateResponse,
)
from finance_app.db.models import (
    Budget,
    Category,
    Transaction,
)
from finance_app.db.session import get_db


# ---------- Templates (copy + average-fill) ----------
#
# Two ergonomic shortcuts that turn "budget setup" from busywork into one click:
#
#   1. Copy from prior month — "I had a working April, just give me May."
#   2. Fill from N-month average — "I have no idea where to start, just look
#      at what I actually spent and pre-fill caps near that."
#
# Both default to non-destructive: existing budgets in the target month are
# preserved unless overwrite=true. The response is a per-row trace so the UI
# can show "we created 4, skipped 2 you'd already set" without a second call.


def _round_up(amount_cents: int, granularity_cents: int) -> int:
    """Ceil ``amount_cents`` up to the next multiple of ``granularity_cents``.

    Picking $25 by default mirrors how a human would round when picking a cap:
    nobody sets a budget at $327.14, they pick $350. Cleaner caps are also
    easier to compare month-to-month.
    """
    if granularity_cents <= 0 or amount_cents <= 0:
        return max(0, amount_cents)
    chunks = (amount_cents + granularity_cents - 1) // granularity_cents
    return chunks * granularity_cents


def copy_from_prior(
    body: BudgetCopyRequest,
    db: Session = Depends(get_db),
) -> BudgetTemplateResponse:
    """Copy budgets from ``source_month`` (default: target - 1) into target month.

    Use this once a month: most months are 80% the same as last month. The
    user only edits the few categories that differ, instead of re-entering
    everything from scratch.
    """
    target_ms = _normalize_month_start(body.target_month_start)
    source_ms = _normalize_month_start(
        body.source_month_start
        if body.source_month_start is not None
        else _prior_month_start(target_ms)
    )
    if source_ms == target_ms:
        raise HTTPException(400, "source_month_start must differ from target_month_start")

    # Pull source budgets joined to category for a clean trace
    source_rows = db.execute(
        select(Budget, Category)
        .join(Category, Category.id == Budget.category_id)
        .where(Budget.month_start == source_ms)
    ).all()

    # Pre-load existing budgets in target so the skip/update decision is one
    # dict-lookup per row instead of N round-trips
    existing = {
        b.category_id: b
        for b in db.execute(
            select(Budget).where(Budget.month_start == target_ms)
        ).scalars().all()
    }

    rows: list[BudgetTemplateApplied] = []
    created = updated = skipped = 0
    for src_budget, cat in source_rows:
        existing_b = existing.get(cat.id)
        if existing_b is not None and not body.overwrite:
            rows.append(BudgetTemplateApplied(
                category_id=cat.id,
                category_name=cat.name,
                amount_cents=existing_b.amount_cents,
                action="skipped_existing",
            ))
            skipped += 1
            continue
        if existing_b is not None:
            existing_b.amount_cents = src_budget.amount_cents
            existing_b.rollover = src_budget.rollover
            existing_b.notes = src_budget.notes
            updated += 1
            rows.append(BudgetTemplateApplied(
                category_id=cat.id,
                category_name=cat.name,
                amount_cents=src_budget.amount_cents,
                action="updated",
            ))
        else:
            db.add(Budget(
                category_id=cat.id,
                month_start=target_ms,
                amount_cents=src_budget.amount_cents,
                rollover=src_budget.rollover,
                notes=src_budget.notes,
            ))
            created += 1
            rows.append(BudgetTemplateApplied(
                category_id=cat.id,
                category_name=cat.name,
                amount_cents=src_budget.amount_cents,
                action="created",
            ))

    db.commit()
    return BudgetTemplateResponse(
        target_month_start=target_ms,
        source_month_start=source_ms,
        lookback_months=None,
        created=created,
        updated=updated,
        skipped=skipped,
        rows=rows,
    )


def fill_from_average(
    body: BudgetFillRequest,
    db: Session = Depends(get_db),
) -> BudgetTemplateResponse:
    """Auto-create budgets from the trailing N-month spending average.

    Looks at the lookback_months *prior* to the target month (so it doesn't
    include the target's own partial spending), averages outflow per category,
    rounds up to the nearest $25 (configurable), and writes a Budget row for
    each category whose average clears ``min_avg_cents``.

    This is the "I have no idea where to start" onboarding button. Pair it
    with copy-from-prior for ongoing months.
    """
    target_ms = _normalize_month_start(body.target_month_start)

    # Build the lookback window: [target - N months, target - 1 day]
    first_lookback = target_ms
    for _ in range(body.lookback_months):
        first_lookback = _prior_month_start(first_lookback)
    # last day before target month
    if target_ms.month == 1:
        last_lookback = date(target_ms.year - 1, 12, 31)
    else:
        last_lookback = date(target_ms.year, target_ms.month, 1) - timedelta(days=1)

    # Aggregate outflow per category across the window
    outflow_expr = func.sum(
        case((Transaction.amount_cents < 0, -Transaction.amount_cents), else_=0)
    ).label("outflow")
    rows_q = db.execute(
        select(
            Transaction.category_id,
            Category.name.label("category_name"),
            outflow_expr,
        )
        .join(Category, Category.id == Transaction.category_id, isouter=False)
        .where(
            Transaction.posted_date >= first_lookback,
            Transaction.posted_date <= last_lookback,
            Transaction.category_id.is_not(None),
        )
        .group_by(Transaction.category_id, Category.name)
    ).all()

    existing = {
        b.category_id: b
        for b in db.execute(
            select(Budget).where(Budget.month_start == target_ms)
        ).scalars().all()
    }

    rows: list[BudgetTemplateApplied] = []
    created = updated = skipped = 0
    for r in rows_q:
        if r.category_id is None:
            continue
        avg_cents = int((r.outflow or 0) // body.lookback_months)
        if avg_cents < body.min_avg_cents:
            rows.append(BudgetTemplateApplied(
                category_id=r.category_id,
                category_name=r.category_name or "(unknown)",
                amount_cents=avg_cents,
                action="skipped_low_avg",
            ))
            skipped += 1
            continue

        cap_cents = _round_up(avg_cents, body.round_up_to_cents)
        existing_b = existing.get(r.category_id)
        if existing_b is not None and not body.overwrite:
            rows.append(BudgetTemplateApplied(
                category_id=r.category_id,
                category_name=r.category_name or "(unknown)",
                amount_cents=existing_b.amount_cents,
                action="skipped_existing",
            ))
            skipped += 1
            continue
        if existing_b is not None:
            existing_b.amount_cents = cap_cents
            updated += 1
            rows.append(BudgetTemplateApplied(
                category_id=r.category_id,
                category_name=r.category_name or "(unknown)",
                amount_cents=cap_cents,
                action="updated",
            ))
        else:
            db.add(Budget(
                category_id=r.category_id,
                month_start=target_ms,
                amount_cents=cap_cents,
                rollover=False,
                notes=f"auto-filled from {body.lookback_months}-mo average",
            ))
            created += 1
            rows.append(BudgetTemplateApplied(
                category_id=r.category_id,
                category_name=r.category_name or "(unknown)",
                amount_cents=cap_cents,
                action="created",
            ))

    db.commit()
    # Sort the trace so the UI doesn't show created budgets in random pk order
    rows.sort(key=lambda r: r.amount_cents, reverse=True)
    return BudgetTemplateResponse(
        target_month_start=target_ms,
        source_month_start=None,
        lookback_months=body.lookback_months,
        created=created,
        updated=updated,
        skipped=skipped,
        rows=rows,
    )
