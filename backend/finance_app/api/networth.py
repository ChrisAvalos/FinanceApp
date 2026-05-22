"""Net-worth API — Phase 7.1.

GET  /networth                     current snapshot
POST /networth/snapshot            persist today's snapshot (one row per day)
GET  /networth/history?days=365    historical chart data (one point per day)
POST /accounts/{id}/balance        log a manual balance update for an account
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import Account, IngestSource, NetWorthSnapshot
from finance_app.db.session import get_db
from finance_app.networth import (
    current_net_worth,
    log_manual_balance,
    snapshot_net_worth,
)
from finance_app.networth.attribution import compute as compute_attribution

router = APIRouter(prefix="/networth", tags=["networth"])


class NetWorthBreakdownOut(BaseModel):
    account_type: str
    kind: str
    total_cents: int
    accounts: int


class NetWorthSummaryOut(BaseModel):
    as_of: date
    assets_cents: int
    liabilities_cents: int
    net_cents: int
    breakdown: list[NetWorthBreakdownOut]
    accounts_with_no_balance: int


class NetWorthHistoryPoint(BaseModel):
    as_of: date
    assets_cents: int
    liabilities_cents: int
    net_cents: int


class NetWorthHistoryOut(BaseModel):
    series: list[NetWorthHistoryPoint]
    earliest: date | None
    latest: date | None
    delta_30d_cents: int | None
    delta_1y_cents: int | None


class ManualBalanceIn(BaseModel):
    balance_cents: int
    as_of: date | None = None
    notes: str | None = None


class BalanceSnapshotOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    account_id: int
    as_of: date
    balance_cents: int
    available_cents: int | None
    source: IngestSource


@router.get("", response_model=NetWorthSummaryOut)
def get_current(db: Session = Depends(get_db)) -> NetWorthSummaryOut:
    summary = current_net_worth(db)
    return NetWorthSummaryOut(
        as_of=summary.as_of,
        assets_cents=summary.assets_cents,
        liabilities_cents=summary.liabilities_cents,
        net_cents=summary.net_cents,
        breakdown=[
            NetWorthBreakdownOut(
                account_type=b.account_type,
                kind=b.kind,
                total_cents=b.total_cents,
                accounts=b.accounts,
            )
            for b in summary.breakdown
        ],
        accounts_with_no_balance=summary.accounts_with_no_balance,
    )


@router.post("/snapshot", response_model=NetWorthSummaryOut)
def take_snapshot(db: Session = Depends(get_db)) -> NetWorthSummaryOut:
    """Force-write today's NetWorthSnapshot. Useful for testing.

    Normally fires once a day via the scheduler. This endpoint lets the
    UI take an on-demand snapshot — handy after a manual balance entry
    when the user wants the chart to reflect the new value immediately.
    """
    snap = snapshot_net_worth(db)
    return NetWorthSummaryOut(
        as_of=snap.as_of,
        assets_cents=snap.assets_cents,
        liabilities_cents=snap.liabilities_cents,
        net_cents=snap.net_cents,
        breakdown=[
            NetWorthBreakdownOut(
                account_type=k,
                kind=v["kind"],
                total_cents=v["total_cents"],
                accounts=v["accounts"],
            )
            for k, v in (snap.breakdown or {}).items()
        ],
        accounts_with_no_balance=0,
    )


@router.get("/history", response_model=NetWorthHistoryOut)
def get_history(
    days: int = 365, db: Session = Depends(get_db)
) -> NetWorthHistoryOut:
    """Time-series of NetWorthSnapshot rows, latest first.

    Returns 30-day and 1-year deltas if enough history exists. Empty
    series until the daily scheduler has run a few times.
    """
    if days < 1 or days > 3650:
        raise HTTPException(400, "days must be between 1 and 3650")
    cutoff = date.today() - timedelta(days=days)
    rows = list(
        db.execute(
            select(NetWorthSnapshot)
            .where(NetWorthSnapshot.as_of >= cutoff)
            .order_by(NetWorthSnapshot.as_of)
        ).scalars().all()
    )
    if not rows:
        return NetWorthHistoryOut(
            series=[], earliest=None, latest=None,
            delta_30d_cents=None, delta_1y_cents=None,
        )
    by_date = {r.as_of: r for r in rows}
    latest_row = rows[-1]

    def _net_at(target: date) -> int | None:
        # Find the most recent snapshot at or before target
        for r in reversed(rows):
            if r.as_of <= target:
                return r.net_cents
        return None

    today = date.today()
    delta_30 = (
        latest_row.net_cents - n
        if (n := _net_at(today - timedelta(days=30))) is not None
        else None
    )
    delta_1y = (
        latest_row.net_cents - n
        if (n := _net_at(today - timedelta(days=365))) is not None
        else None
    )

    return NetWorthHistoryOut(
        series=[
            NetWorthHistoryPoint(
                as_of=r.as_of,
                assets_cents=r.assets_cents,
                liabilities_cents=r.liabilities_cents,
                net_cents=r.net_cents,
            )
            for r in rows
        ],
        earliest=rows[0].as_of,
        latest=latest_row.as_of,
        delta_30d_cents=delta_30,
        delta_1y_cents=delta_1y,
    )


# ---------------------------------------------------------------------------
#  Attribution — Smart Feature #4
# ---------------------------------------------------------------------------


class AttributionCategoryOut(BaseModel):
    name: str
    cents: int
    txn_count: int


class AttributionMonthOut(BaseModel):
    month_start: date
    month_label: str
    nw_start_cents: int | None
    nw_end_cents: int | None
    delta_cents: int | None
    income_cents: int
    spending_cents: int
    net_cash_flow_cents: int
    debt_paydown_cents: int
    other_cents: int | None
    top_spending_categories: list[AttributionCategoryOut]


class AttributionReportOut(BaseModel):
    months: list[AttributionMonthOut]
    summary_text: str
    # Server-side computation timestamp — drives the SyncFreshnessChip on
    # the Attribution panel.
    generated_at: datetime | None = None


@router.get("/attribution", response_model=AttributionReportOut)
def attribution(
    months: int = 12,
    db: Session = Depends(get_db),
) -> AttributionReportOut:
    """Why did net worth move each month?

    Decomposes month-over-month NW change into income, spending, and
    "other" (market gains/losses, interest, etc.). Months without
    snapshots at both endpoints return ``delta=null`` and ``other=null``;
    cash-flow components are still populated for those months.
    """
    if months < 1 or months > 36:
        raise HTTPException(400, "months must be between 1 and 36")
    report = compute_attribution(db, n_months=months)
    return AttributionReportOut(
        months=[
            AttributionMonthOut(
                month_start=m.month_start,
                month_label=m.month_label,
                nw_start_cents=m.nw_start_cents,
                nw_end_cents=m.nw_end_cents,
                delta_cents=m.delta_cents,
                income_cents=m.income_cents,
                spending_cents=m.spending_cents,
                net_cash_flow_cents=m.net_cash_flow_cents,
                debt_paydown_cents=m.debt_paydown_cents,
                other_cents=m.other_cents,
                top_spending_categories=[
                    AttributionCategoryOut(
                        name=c.name,
                        cents=c.cents,
                        txn_count=c.txn_count,
                    )
                    for c in m.top_spending_categories
                ],
            )
            for m in report.months
        ],
        summary_text=report.summary_text,
        generated_at=datetime.utcnow(),
    )
