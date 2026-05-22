"""Cash-flow forecast API — Phase 7.2."""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from finance_app.cashflow import build_forecast
from finance_app.db.session import get_db

router = APIRouter(prefix="/cashflow", tags=["cashflow"])


class CashFlowEventOut(BaseModel):
    on_date: date
    kind: str
    label: str
    amount_cents: int
    confidence: float
    source_id: int | None
    notes: str | None


class DailyForecastPointOut(BaseModel):
    on_date: date
    inflow_cents: int
    outflow_cents: int
    net_cents: int
    running_balance_cents: int


class CashFlowForecastOut(BaseModel):
    window_start: date
    window_end: date
    starting_balance_cents: int
    paycheck_cadence_days: int | None
    paycheck_cadence_confidence: float
    events: list[CashFlowEventOut]
    daily: list[DailyForecastPointOut]
    crunch_days: list[date]
    # Server-side computation timestamp — drives the SyncFreshnessChip on
    # the Cash Flow panel.
    generated_at: datetime | None = None


class UpcomingAnnualOut(BaseModel):
    """One annual renewal landing in the next N months."""
    on_date: date
    label: str
    amount_cents: int           # signed (negative = outflow); stored as-is
    days_out: int               # convenience for UI sorting/grouping
    confidence: float
    subscription_id: int | None
    notes: str | None


class UpcomingAnnualsOut(BaseModel):
    """Sprint 40 — annual renewals BEYOND the standard 30-day Cash Flow
    forecast window. Surfaces $X charges that would otherwise hide in
    the future and surprise the user.
    """
    window_start: date
    window_end: date
    events: list[UpcomingAnnualOut]
    total_outflow_cents: int    # sum of |amount| across events; positive
    generated_at: datetime | None = None


@router.get("/upcoming-annuals", response_model=UpcomingAnnualsOut)
def get_upcoming_annuals(
    days: int = 365,
    db: Session = Depends(get_db),
) -> UpcomingAnnualsOut:
    """Annual renewals over the next N days (default: full year).

    The main /forecast endpoint only walks 30 days ahead by default,
    which hides annual subscriptions whose renewal date is 1–11 months
    out. This endpoint surfaces those events on the "Coming up" tab on
    the Cash Flow panel so the user can see the $69 Truthly renewal
    coming in June even on May 12.

    The underlying projector (Sprint 13's project_annual_renewals)
    already returns these events; this endpoint just exposes them with
    a longer time window and a tighter response shape.
    """
    if days < 1 or days > 730:
        raise HTTPException(400, "days must be between 1 and 730")
    from finance_app.subscriptions.annual_projector import (
        project_annual_renewals,
    )

    today = date.today()
    end = today + timedelta(days=days)
    raw = list(project_annual_renewals(db, start=today, end=end))
    events_out: list[UpcomingAnnualOut] = []
    total_outflow = 0
    for ar in raw:
        label = ar.label if "(annual)" in ar.label.lower() else f"{ar.label} (annual)"
        days_out = (ar.on_date - today).days
        events_out.append(
            UpcomingAnnualOut(
                on_date=ar.on_date,
                label=label,
                amount_cents=ar.amount_cents,
                days_out=days_out,
                confidence=ar.confidence,
                subscription_id=ar.subscription_id,
                notes=ar.notes,
            )
        )
        if ar.amount_cents < 0:
            total_outflow += -ar.amount_cents
    # Sort by date ascending — the "what's coming up next" reading order.
    events_out.sort(key=lambda e: e.on_date)
    return UpcomingAnnualsOut(
        window_start=today,
        window_end=end,
        events=events_out,
        total_outflow_cents=total_outflow,
        generated_at=datetime.utcnow(),
    )


@router.get("/forecast", response_model=CashFlowForecastOut)
def get_forecast(
    days: int = 30,
    crunch_threshold_cents: int = 0,
    db: Session = Depends(get_db),
) -> CashFlowForecastOut:
    """Rolling N-day forecast: subscriptions + bills + paychecks + starting balance."""
    if days < 1 or days > 365:
        raise HTTPException(400, "days must be between 1 and 365")
    forecast = build_forecast(db, days=days, crunch_threshold_cents=crunch_threshold_cents)
    return CashFlowForecastOut(
        window_start=forecast.window_start,
        window_end=forecast.window_end,
        starting_balance_cents=forecast.starting_balance_cents,
        paycheck_cadence_days=forecast.paycheck_cadence_days,
        paycheck_cadence_confidence=forecast.paycheck_cadence_confidence,
        events=[
            CashFlowEventOut(
                on_date=e.on_date,
                kind=e.kind.value,
                label=e.label,
                amount_cents=e.amount_cents,
                confidence=e.confidence,
                source_id=e.source_id,
                notes=e.notes,
            )
            for e in forecast.events
        ],
        daily=[
            DailyForecastPointOut(
                on_date=d.on_date,
                inflow_cents=d.inflow_cents,
                outflow_cents=d.outflow_cents,
                net_cents=d.net_cents,
                running_balance_cents=d.running_balance_cents,
            )
            for d in forecast.daily
        ],
        crunch_days=forecast.crunch_days,
        generated_at=datetime.utcnow(),
    )
