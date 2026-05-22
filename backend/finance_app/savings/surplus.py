"""Surplus calculator — two algorithms, user picks which one to display.

Why two?
--------
Different questions deserve different answers:

* **Historical** ("Looking backward, how much surplus did I actually
  generate?") — sum trailing 30d inflows minus trailing 30d outflows.
  Answers "did I live within my means last month?" Robust because every
  number is observed, not projected.

* **Forecast** ("Looking forward, how much room will I have over the next
  30d?") — projected income minus projected fixed obligations
  (Phase B confirmed subscriptions, cadenced into the next 30d window)
  minus rolling variable spend. Answers "if I commit $X to savings now,
  will the bills clear?" Useful for setting up an automated transfer.

Both are computed and returned together when ``mode="both"`` so the UI can
flip without a second round-trip. The user toggles which one anchors the
suggestion engine.

Design notes
------------
* Inflow = positive ``Transaction.amount_cents``.
  Outflow = negative ``Transaction.amount_cents``. Surplus is reported as a
  positive int (= "money left over"). Negative surplus = deficit, returned
  as a negative int rather than wrapped to zero so the UI can render the
  dollar gap honestly.
* "Variable spend" in the forecast model is *uncategorized + non-recurring*
  spending — anything that wasn't picked up by the recurring detector. We
  use the trailing 30d of that as the projection. Doing it from raw
  trailing spend (instead of a per-category budget rollup) keeps the
  forecast honest even when budgets aren't set up yet.
* For the forecast: subscriptions are cadenced via ``30/cadence_days`` so
  an annual $120 charge counts as $10/mo, not $120/mo. Without this the
  forecast would over-state monthly outflow whenever an annual renewal
  fell in the trailing window.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Literal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from finance_app.db.models import Subscription, SubscriptionStatus, Transaction


SurplusMode = Literal["historical", "forecast", "both"]


# --------------------------------------------------------------------
#  Result types
# --------------------------------------------------------------------


@dataclass
class HistoricalBreakdown:
    """What actually moved through the user's accounts in the trailing window."""
    window_start: date
    window_end: date
    inflows_cents: int            # always >= 0 (positive ints summed)
    outflows_cents: int           # always >= 0 (abs of negatives)
    surplus_cents: int            # inflows - outflows (can be negative)
    n_inflow_txns: int
    n_outflow_txns: int


@dataclass
class ForecastBreakdown:
    """Projection of the next 30d based on rolling inputs."""
    window_start: date            # = today
    window_end: date              # = today + 30
    projected_income_cents: int           # rolling 30d trailing inflow
    fixed_obligations_cents: int          # confirmed/active subs cadenced into next 30d
    variable_spend_cents: int             # rolling 30d trailing outflow that wasn't on a recurring sub
    surplus_cents: int                    # income - obligations - variable
    n_active_subscriptions: int
    n_variable_outflow_txns: int


@dataclass
class SurplusSnapshot:
    """Either or both modes returned together; UI toggles."""
    as_of: date
    mode_requested: SurplusMode
    historical: HistoricalBreakdown | None = None
    forecast: ForecastBreakdown | None = None
    notes: list[str] = field(default_factory=list)


# --------------------------------------------------------------------
#  Helpers
# --------------------------------------------------------------------


_INFLOW = case((Transaction.amount_cents > 0, Transaction.amount_cents), else_=0)
_OUTFLOW = case((Transaction.amount_cents < 0, -Transaction.amount_cents), else_=0)


def _trailing_window(today: date, days: int = 30) -> tuple[date, date]:
    """[today - days + 1, today] inclusive — gives an N-day window ending today."""
    return today - timedelta(days=days - 1), today


def _projected_income_from_trailing(db: Session, today: date) -> int:
    """Use trailing 30d total inflow as the projection for next 30d.

    Justified for v0.2: salaries are sticky, gig-style income converges to
    its trailing average. We can refine later by detecting "salary
    transactions" (recurring inflows) and excluding one-off windfalls —
    file a TODO once we see real-world false positives.
    """
    start, end = _trailing_window(today)
    total = db.execute(
        select(func.coalesce(func.sum(_INFLOW), 0))
        .where(Transaction.posted_date >= start, Transaction.posted_date <= end)
    ).scalar_one()
    return int(total or 0)


def _trailing_outflow_minus_subs(db: Session, today: date) -> tuple[int, int]:
    """Trailing 30d outflow that ISN'T on a confirmed/active recurring sub.

    Returns ``(amount_cents_positive, n_txns)``. We approximate "is on a sub"
    by linking via the Subscription.merchant_id → Transaction.merchant_id
    relation. This is best-effort: a subscription without a merchant_id (rare
    in our data, since detector ties subs to merchants) won't be excluded.
    Acceptable for a forecast — the user is going to toggle and compare to
    historical anyway.

    Why subtract subs at all? The forecast model treats subs as a separate
    line ("fixed obligations"). If we left them in variable_spend we'd be
    double-counting them.
    """
    start, end = _trailing_window(today)

    # IDs of merchants that have a confirmed/active recurring subscription.
    sub_merchant_ids = {
        m for (m,) in db.execute(
            select(Subscription.merchant_id)
            .where(
                Subscription.merchant_id.is_not(None),
                Subscription.is_user_confirmed.is_(True),
                Subscription.status.in_(
                    [SubscriptionStatus.active, SubscriptionStatus.suspected]
                ),
            )
        ).all()
    }

    stmt = (
        select(
            func.coalesce(func.sum(_OUTFLOW), 0),
            func.count(Transaction.id),
        )
        .where(
            Transaction.posted_date >= start,
            Transaction.posted_date <= end,
            Transaction.amount_cents < 0,
        )
    )
    if sub_merchant_ids:
        stmt = stmt.where(
            (Transaction.merchant_id.is_(None))
            | (Transaction.merchant_id.notin_(sub_merchant_ids))
        )
    total, count = db.execute(stmt).one()
    return int(total or 0), int(count or 0)


def _confirmed_active_sub_obligations_cents(db: Session) -> tuple[int, int]:
    """Sum confirmed+active sub costs, cadenced into a 30-day window.

    Returns ``(monthly_cost_cents_positive, n_subs)``. Mirrors the
    /subscriptions/stats projection: amount × 30 / cadence_days. A confirmed
    annual sub at $120 → $10/mo here. Skip ``cancelled`` and ``dismissed``
    explicitly; ``suspected`` (auto-detected, not yet confirmed) is also
    skipped — those are on the user's review pile, not committed spend.
    """
    rows = db.execute(
        select(Subscription.amount_cents, Subscription.cadence_days)
        .where(
            Subscription.is_user_confirmed.is_(True),
            Subscription.status == SubscriptionStatus.active,
        )
    ).all()
    total = 0
    for amount_cents, cadence_days in rows:
        cad = cadence_days or 30
        if cad <= 0:
            cad = 30
        # amount_cents is negative for outflows; convert to positive cost.
        monthly = abs(int(round(amount_cents * 30 / cad)))
        total += monthly
    return total, len(rows)


# --------------------------------------------------------------------
#  Top-level entry points
# --------------------------------------------------------------------


def compute_historical(db: Session, today: date | None = None) -> HistoricalBreakdown:
    """Trailing 30d: inflows − outflows."""
    today = today or date.today()
    start, end = _trailing_window(today)

    row = db.execute(
        select(
            func.coalesce(func.sum(_INFLOW), 0),
            func.coalesce(func.sum(_OUTFLOW), 0),
            func.sum(case((Transaction.amount_cents > 0, 1), else_=0)),
            func.sum(case((Transaction.amount_cents < 0, 1), else_=0)),
        ).where(
            Transaction.posted_date >= start,
            Transaction.posted_date <= end,
        )
    ).one()
    inflows, outflows, n_in, n_out = row
    inflows_i = int(inflows or 0)
    outflows_i = int(outflows or 0)
    return HistoricalBreakdown(
        window_start=start,
        window_end=end,
        inflows_cents=inflows_i,
        outflows_cents=outflows_i,
        surplus_cents=inflows_i - outflows_i,
        n_inflow_txns=int(n_in or 0),
        n_outflow_txns=int(n_out or 0),
    )


def compute_forecast(db: Session, today: date | None = None) -> ForecastBreakdown:
    """Next-30d projection: income − fixed_obligations − variable_spend."""
    today = today or date.today()
    income = _projected_income_from_trailing(db, today)
    obligations, n_subs = _confirmed_active_sub_obligations_cents(db)
    variable, n_var = _trailing_outflow_minus_subs(db, today)
    return ForecastBreakdown(
        window_start=today,
        window_end=today + timedelta(days=30),
        projected_income_cents=income,
        fixed_obligations_cents=obligations,
        variable_spend_cents=variable,
        surplus_cents=income - obligations - variable,
        n_active_subscriptions=n_subs,
        n_variable_outflow_txns=n_var,
    )


def compute_surplus(
    db: Session,
    mode: SurplusMode = "both",
    today: date | None = None,
) -> SurplusSnapshot:
    """Return surplus snapshot for the requested mode(s).

    Default is ``"both"`` so the UI gets one round-trip and toggles
    client-side. Pass ``"historical"`` or ``"forecast"`` if you only need
    one (e.g. the suggestion engine, which anchors to a specific mode).
    """
    today = today or date.today()
    snap = SurplusSnapshot(as_of=today, mode_requested=mode)

    if mode in ("historical", "both"):
        snap.historical = compute_historical(db, today)
    if mode in ("forecast", "both"):
        snap.forecast = compute_forecast(db, today)

    if snap.historical and snap.historical.surplus_cents < 0:
        snap.notes.append(
            "Historical window is in deficit — outflow exceeded inflow over the last 30 days."
        )
    if snap.forecast and snap.forecast.surplus_cents < 0:
        snap.notes.append(
            "Forecast projects a deficit — fixed + variable spend exceeds projected income."
        )

    return snap
