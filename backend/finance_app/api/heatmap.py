"""Spending heatmap — Phase 9.4.

GET /heatmap/daily?days=90    one-row-per-day grid for calendar visual

The UI uses this to render a GitHub-style calendar where each cell
is a day shaded by spend. Reveals patterns most apps don't surface:
weekend-vs-weekday contrast, dry-run days, big-spend days, payday
spike vs trough, vacation-week distribution.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import Transaction
from finance_app.db.session import get_db


router = APIRouter(prefix="/heatmap", tags=["heatmap"])


class HeatmapDayOut(BaseModel):
    on_date: date
    day_of_week: int  # 0 = Monday
    total_outflow_cents: int
    total_inflow_cents: int
    txn_count: int


class HeatmapStatsOut(BaseModel):
    total_days: int
    days_with_spend: int
    busiest_day_of_week: int  # avg spend by day-of-week, highest
    busiest_dow_avg_cents: int
    quietest_day_of_week: int
    quietest_dow_avg_cents: int
    weekend_avg_cents: int
    weekday_avg_cents: int
    biggest_single_day_cents: int
    biggest_single_day: date | None


class HeatmapOut(BaseModel):
    window_start: date
    window_end: date
    days: list[HeatmapDayOut]
    stats: HeatmapStatsOut
    # Server-side computation timestamp — drives the SyncFreshnessChip on
    # the Heatmap panel.
    generated_at: datetime | None = None


@router.get("/daily", response_model=HeatmapOut)
def daily(
    days: int = Query(90, ge=7, le=730),
    db: Session = Depends(get_db),
) -> HeatmapOut:
    today = date.today()
    start = today - timedelta(days=days - 1)
    rows = list(
        db.execute(
            select(Transaction)
            .where(Transaction.posted_date >= start)
            .where(Transaction.posted_date <= today)
        ).scalars().all()
    )

    by_day: dict[date, dict] = defaultdict(
        lambda: {"outflow": 0, "inflow": 0, "count": 0}
    )
    for t in rows:
        d = t.posted_date
        by_day[d]["count"] += 1
        if t.amount_cents < 0:
            by_day[d]["outflow"] += -t.amount_cents
        else:
            by_day[d]["inflow"] += t.amount_cents

    out_days: list[HeatmapDayOut] = []
    cur = start
    while cur <= today:
        e = by_day.get(cur, {"outflow": 0, "inflow": 0, "count": 0})
        out_days.append(
            HeatmapDayOut(
                on_date=cur,
                day_of_week=cur.weekday(),
                total_outflow_cents=e["outflow"],
                total_inflow_cents=e["inflow"],
                txn_count=e["count"],
            )
        )
        cur = cur + timedelta(days=1)

    # Stats
    by_dow: dict[int, list[int]] = defaultdict(list)
    for d in out_days:
        by_dow[d.day_of_week].append(d.total_outflow_cents)
    dow_avg = {dow: sum(v) // len(v) if v else 0 for dow, v in by_dow.items()}
    if dow_avg:
        busiest = max(dow_avg, key=dow_avg.get)
        quietest = min(dow_avg, key=dow_avg.get)
    else:
        busiest = quietest = 0
    weekend = [d.total_outflow_cents for d in out_days if d.day_of_week >= 5]
    weekday = [d.total_outflow_cents for d in out_days if d.day_of_week < 5]
    biggest = max(out_days, key=lambda d: d.total_outflow_cents) if out_days else None
    days_with_spend = sum(1 for d in out_days if d.total_outflow_cents > 0)

    stats = HeatmapStatsOut(
        total_days=len(out_days),
        days_with_spend=days_with_spend,
        busiest_day_of_week=busiest,
        busiest_dow_avg_cents=dow_avg.get(busiest, 0),
        quietest_day_of_week=quietest,
        quietest_dow_avg_cents=dow_avg.get(quietest, 0),
        weekend_avg_cents=sum(weekend) // len(weekend) if weekend else 0,
        weekday_avg_cents=sum(weekday) // len(weekday) if weekday else 0,
        biggest_single_day_cents=biggest.total_outflow_cents if biggest else 0,
        biggest_single_day=biggest.on_date if biggest else None,
    )
    return HeatmapOut(
        window_start=start,
        window_end=today,
        days=out_days,
        stats=stats,
        generated_at=datetime.utcnow(),
    )
