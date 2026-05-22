"""Summary/statistics endpoints."""
from __future__ import annotations

from calendar import monthrange
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, extract, func, select
from sqlalchemy.orm import Session

from finance_app.api.schemas import (
    CategoryMonthRow,
    CategoryTrendRow,
    MonthOutflowCell,
    MonthOverMonthResponse,
    SummaryResponse,
)
from finance_app.db.models import Category, Transaction
from finance_app.db.session import get_db

router = APIRouter(tags=["stats"])


@router.get("/stats/summary", response_model=SummaryResponse)
def summary(
    start_date: date | None = None,
    end_date: date | None = None,
    db: Session = Depends(get_db),
) -> SummaryResponse:
    if end_date is None:
        end_date = date.today()
    if start_date is None:
        start_date = end_date - timedelta(days=90)

    # Outflow/inflow totals
    totals = db.execute(
        select(
            func.sum(
                case((Transaction.amount_cents < 0, -Transaction.amount_cents), else_=0)
            ).label("outflow"),
            func.sum(
                case((Transaction.amount_cents > 0, Transaction.amount_cents), else_=0)
            ).label("inflow"),
        ).where(
            Transaction.posted_date >= start_date,
            Transaction.posted_date <= end_date,
        )
    ).one()
    outflow = int(totals.outflow or 0)
    inflow = int(totals.inflow or 0)

    # By-category breakdown per month
    rows = db.execute(
        select(
            extract("year", Transaction.posted_date).label("year"),
            extract("month", Transaction.posted_date).label("month"),
            Transaction.category_id,
            Category.name,
            func.sum(
                case((Transaction.amount_cents < 0, -Transaction.amount_cents), else_=0)
            ).label("outflow"),
            func.sum(
                case((Transaction.amount_cents > 0, Transaction.amount_cents), else_=0)
            ).label("inflow"),
            func.count(Transaction.id).label("n"),
        )
        .join(Category, Category.id == Transaction.category_id, isouter=True)
        .where(
            Transaction.posted_date >= start_date,
            Transaction.posted_date <= end_date,
        )
        .group_by("year", "month", Transaction.category_id, Category.name)
        .order_by("year", "month")
    ).all()

    by_cat = [
        CategoryMonthRow(
            year=int(r.year),
            month=int(r.month),
            category_id=r.category_id,
            category_name=r.name,
            outflow_cents=int(r.outflow or 0),
            inflow_cents=int(r.inflow or 0),
            txn_count=int(r.n),
        )
        for r in rows
    ]

    return SummaryResponse(
        start_date=start_date,
        end_date=end_date,
        total_inflow_cents=inflow,
        total_outflow_cents=outflow,
        net_cents=inflow - outflow,
        by_category=by_cat,
        generated_at=datetime.utcnow(),
    )


# ---------- Month-over-month trend ----------

def _month_windows(months: int, anchor: date | None = None) -> list[date]:
    """Return the last ``months`` month-start dates (YYYY-MM-01), oldest first.

    Anchored to today's month by default. months=6 with anchor=2026-04-23
    returns [2025-11-01, 2025-12-01, 2026-01-01, 2026-02-01, 2026-03-01, 2026-04-01].
    Using real dates here (not (year, month) tuples) keeps the whole stack
    date-native — the API contract, the DB column, and the in-memory keys all
    agree on a single type.
    """
    anchor = anchor or date.today()
    out: list[date] = []
    y, m = anchor.year, anchor.month
    for _ in range(months):
        out.append(date(y, m, 1))
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    out.reverse()
    return out


@router.get("/stats/month-over-month", response_model=MonthOverMonthResponse)
def month_over_month(
    months: int = 6,
    db: Session = Depends(get_db),
) -> MonthOverMonthResponse:
    """Outflow by category across the last N months + trend vs trailing avg.

    trend_pct_vs_avg compares the MOST RECENT month to the average of the
    OTHER months in the window. Positive = spending up vs. recent baseline,
    negative = down. Null if the prior-months average is zero.
    """
    if months < 2 or months > 36:
        raise HTTPException(400, "months must be between 2 and 36")

    windows = _month_windows(months)
    start = windows[0]
    newest = windows[-1]
    _, last_day_newest = monthrange(newest.year, newest.month)
    end = date(newest.year, newest.month, last_day_newest)

    # Pull all (category, year, month) outflow rows at once. We also
    # carry a per-bucket transaction count so the pro-rate decision
    # below can require a minimum sample size before extrapolating
    # the partial current month to a full-month equivalent (Sprint 30).
    rows = db.execute(
        select(
            extract("year", Transaction.posted_date).label("year"),
            extract("month", Transaction.posted_date).label("month"),
            Transaction.category_id,
            Category.name.label("category_name"),
            func.sum(
                case((Transaction.amount_cents < 0, -Transaction.amount_cents), else_=0)
            ).label("outflow"),
            func.sum(
                case((Transaction.amount_cents < 0, 1), else_=0)
            ).label("outflow_count"),
        )
        .join(Category, Category.id == Transaction.category_id, isouter=True)
        .where(
            Transaction.posted_date >= start,
            Transaction.posted_date <= end,
        )
        .group_by("year", "month", Transaction.category_id, Category.name)
    ).all()

    # Pivot into (category_id | None) → {month_start_date: outflow},
    # plus a parallel pivot of transaction counts used by the
    # sample-size guard on the current-month pro-rate.
    by_cat: dict[tuple[int | None, str | None], dict[date, int]] = {}
    by_cat_counts: dict[tuple[int | None, str | None], dict[date, int]] = {}
    for r in rows:
        key = (r.category_id, r.category_name)
        ms = date(int(r.year), int(r.month), 1)
        by_cat.setdefault(key, {})[ms] = int(r.outflow or 0)
        by_cat_counts.setdefault(key, {})[ms] = int(r.outflow_count or 0)

    # Also compute per-month totals (for the envelope) — sum across categories
    months_out: list[MonthOutflowCell] = []
    for ms in windows:
        total = sum(
            cat_map.get(ms, 0) for cat_map in by_cat.values()
        )
        months_out.append(MonthOutflowCell(month_start=ms, outflow_cents=total))

    # Sprint 25/30 — pro-rate the in-progress current month when
    # computing the trend %. Without this, on the 7th of the month
    # every category reads "-77% vs trailing avg" because we've only
    # had a week to spend.
    #
    # Sprint 30 (audit follow-up): the original pro-rate created the
    # opposite problem — categories with only 1–2 transactions so far
    # this month got extrapolated to absurd percentages (Clothing
    # +1700%, Travel +2854%). One Costco trip in early May does not
    # mean you're going to spend at that pace all month. We now
    # require at least _MIN_PRO_RATE_TXNS transactions in the current
    # month for that specific category before applying the pro-rate;
    # below the threshold we leave the trend null ("not enough data
    # yet this month") rather than inventing a number.
    today = date.today()
    newest_ms = windows[-1]
    is_current_month = (
        newest_ms.year == today.year and newest_ms.month == today.month
    )
    days_in_newest = monthrange(newest_ms.year, newest_ms.month)[1]
    days_elapsed = today.day if is_current_month else days_in_newest
    pro_rate_active = is_current_month and days_elapsed < int(days_in_newest * 0.9)
    pro_rate_factor = (
        days_in_newest / days_elapsed if pro_rate_active and days_elapsed > 0 else 1.0
    )
    _MIN_PRO_RATE_TXNS = 3  # ≥ 3 txns this month to trust the extrapolation

    categories_out: list[CategoryTrendRow] = []
    for (cat_id, cat_name), cat_map in by_cat.items():
        series = [cat_map.get(w, 0) for w in windows]
        # Both the displayed Avg and the trend % must use the SAME denominator
        # — the trailing average EXCLUDING the latest month. Otherwise users
        # see "Avg $X / +Y%" where the % is computed against a different,
        # invisible average. Was a bug pre-2026-04-27.
        trend: float | None = None
        avg: int = 0
        if len(series) >= 2:
            latest_raw = series[-1]
            # Per-category sample size in the in-progress month.
            current_month_txns = (
                by_cat_counts.get((cat_id, cat_name), {}).get(newest_ms, 0)
            )
            if pro_rate_active and current_month_txns >= _MIN_PRO_RATE_TXNS:
                # Enough samples to trust extrapolation.
                latest_for_trend = latest_raw * pro_rate_factor
                apply_trend = True
            elif pro_rate_active:
                # Pro-rate would amplify single-purchase noise — suppress
                # the trend rather than show "+2854%".
                latest_for_trend = latest_raw
                apply_trend = False
            else:
                latest_for_trend = latest_raw
                apply_trend = True
            prior = series[:-1]
            prior_avg_float = sum(prior) / len(prior) if prior else 0.0
            avg = int(prior_avg_float)
            if apply_trend and prior_avg_float > 0:
                trend = round(
                    ((latest_for_trend - prior_avg_float) / prior_avg_float) * 100,
                    1,
                )
        elif series:
            # Only one month of data — no "trailing" anything to compare to,
            # so report the single month's outflow as the avg and leave trend
            # null. Edge case but worth being explicit.
            avg = series[0]
        categories_out.append(
            CategoryTrendRow(
                category_id=cat_id,
                category_name=cat_name,
                outflow_by_month_cents=series,
                avg_outflow_cents=avg,
                trend_pct_vs_avg=trend,
            )
        )

    # Stable sort: biggest average spender first (what Chris will want to see)
    categories_out.sort(key=lambda c: c.avg_outflow_cents, reverse=True)

    return MonthOverMonthResponse(
        months=months_out,
        categories=categories_out,
        generated_at=datetime.utcnow(),
    )
