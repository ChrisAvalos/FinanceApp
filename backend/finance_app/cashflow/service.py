"""Forecast builder.

Public entry point: :func:`build_forecast(db, days=30)` returns a
:class:`CashFlowForecast` with:

  * ``events`` — sorted list of every projected outflow/inflow with
    its source kind (subscription, bill, paycheck) and confidence
  * ``daily`` — one row per day with running balance after that day's
    events. UI renders this as a line chart + dot list.
  * ``crunch_days`` — days where running balance drops below threshold.

Heuristics for paycheck cadence
-------------------------------
Walk the last 90 days of income.salary inflows. Compute gaps between
consecutive paychecks. Use the modal gap (rounded to the nearest
common cadence: 7, 14, 15, 30) as the assumed cadence going forward.
Reject if there are fewer than 2 paychecks in window — too few to
forecast confidently. Confidence reflects how regular the past
cadence was.
"""
from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta
from enum import Enum
from statistics import median

from sqlalchemy import select
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from ..db.models import (
    Account,
    AccountType,
    Bill,
    Subscription,
    SubscriptionStatus,
    Transaction,
)
from ..enrichment import is_payroll
from ..budgets.monthly_financials import account_ids_for, INCOME_ACCOUNT_TYPES


class EventKind(str, Enum):
    subscription = "subscription"
    bill = "bill"
    paycheck = "paycheck"
    manual = "manual"


@dataclass
class CashFlowEvent:
    """One projected money movement."""
    on_date: date
    kind: EventKind
    label: str
    amount_cents: int  # signed: + inflow, − outflow
    confidence: float  # 0..1
    source_id: int | None = None  # FK back to the source row (sub/bill)
    notes: str | None = None


@dataclass
class DailyForecastPoint:
    on_date: date
    inflow_cents: int
    outflow_cents: int
    net_cents: int
    running_balance_cents: int


@dataclass
class CashFlowForecast:
    window_start: date
    window_end: date
    starting_balance_cents: int
    paycheck_cadence_days: int | None
    paycheck_cadence_confidence: float
    events: list[CashFlowEvent] = field(default_factory=list)
    daily: list[DailyForecastPoint] = field(default_factory=list)
    crunch_days: list[date] = field(default_factory=list)
    # Sprint O wiring — everyday variable spending the forecast now folds
    # into the running balance so the projection is realistic. Sourced
    # from monthly_financials.compute_trailing_real_outflow (the canonical
    # 90-day "real spend"), minus the bills/subscriptions already
    # projected as events, to avoid double-counting.
    variable_spend_monthly_cents: int = 0
    variable_spend_daily_cents: int = 0


# ---------------------------------------------------------------------
#  Source 1: subscriptions
# ---------------------------------------------------------------------


def _project_subscriptions(
    db: Session, *, start: date, end: date
) -> list[CashFlowEvent]:
    """Project active subs forward through the window.

    Sprint 13 — skip subs flagged as annual in their notes. Those are
    handled by ``project_annual_renewals`` which emits a single
    big-amount event on the actual renewal date instead of 12 small
    monthly-equivalent events. Without this skip the cash-flow would
    double-count annual subs (one monthly-equiv stream + one annual
    spike, summing to ~2× the real spend).
    """
    from finance_app.subscriptions.annual_projector import _is_annual

    subs = db.execute(
        select(Subscription).where(Subscription.status == SubscriptionStatus.active)
    ).scalars().all()
    out: list[CashFlowEvent] = []
    for s in subs:
        if s.next_expected_date is None or s.cadence_days is None:
            continue
        if _is_annual(s):
            continue
        amt = s.last_amount_cents or s.amount_cents or 0
        if amt == 0:
            continue
        cur = s.next_expected_date
        # Step forward cadence_days at a time until we exit the window.
        while cur <= end:
            if cur >= start:
                out.append(
                    CashFlowEvent(
                        on_date=cur,
                        kind=EventKind.subscription,
                        label=s.name,
                        amount_cents=-abs(amt),
                        confidence=s.confidence_score or 0.7,
                        source_id=s.id,
                    )
                )
            cur = cur + timedelta(days=s.cadence_days)
    return out


# ---------------------------------------------------------------------
#  Source 2: tracked Bills
# ---------------------------------------------------------------------


def _project_bills(
    db: Session, *, start: date, end: date
) -> list[CashFlowEvent]:
    bills = db.execute(select(Bill)).scalars().all()
    out: list[CashFlowEvent] = []
    for b in bills:
        amt = b.typical_amount_cents or 0
        if amt == 0 or b.cadence_days <= 0:
            continue
        # Anchor: due_day_of_month if set, else step from today by cadence.
        if b.due_day_of_month is not None and b.due_day_of_month > 0:
            cur = _next_due_day(start, b.due_day_of_month)
        else:
            cur = start + timedelta(days=b.cadence_days)
        while cur <= end:
            if cur >= start:
                out.append(
                    CashFlowEvent(
                        on_date=cur,
                        kind=EventKind.bill,
                        label=b.name,
                        amount_cents=-abs(amt),
                        confidence=0.95,
                        source_id=b.id,
                    )
                )
            cur = cur + timedelta(days=b.cadence_days)
    return out


def _next_due_day(after: date, dom: int) -> date:
    """Next date with day-of-month == dom on or after ``after``."""
    from calendar import monthrange
    y, m = after.year, after.month
    _, last = monthrange(y, m)
    target_dom = min(dom, last)
    candidate = date(y, m, target_dom)
    if candidate >= after:
        return candidate
    # Rollover to next month
    if m == 12:
        y, m = y + 1, 1
    else:
        m += 1
    _, last = monthrange(y, m)
    return date(y, m, min(dom, last))


# ---------------------------------------------------------------------
#  Source 3: paycheck cadence inference + projection
# ---------------------------------------------------------------------

_COMMON_CADENCES = (7, 14, 15, 30)


def _infer_paycheck_cadence(
    db: Session, *, lookback_days: int = 90
) -> tuple[int | None, float, int]:
    """Walk the trailing payroll inflows; return (cadence_days, confidence, typical_amount).

    Sprint O consistency fix: paychecks are now identified via the
    canonical ``is_payroll`` classifier (description-based, matches
    "LIVIO ...") rather than by the ``income.salary`` Category slug.
    The slug-based path missed uncategorized payroll wires, which left
    the cash-flow forecast silently inconsistent with the budgets
    rollup (which has always used ``is_payroll``).

    Returns ``(None, 0.0, 0)`` when there's <2 paychecks or the gap pattern
    is too irregular to confidently project.
    """
    cutoff = date.today() - timedelta(days=lookback_days)
    income_account_ids = account_ids_for(db, INCOME_ACCOUNT_TYPES)
    if not income_account_ids:
        return (None, 0.0, 0)
    rows = list(
        db.execute(
            select(Transaction)
            .where(Transaction.amount_cents > 0)
            .where(Transaction.posted_date >= cutoff)
            .where(Transaction.account_id.in_(income_account_ids))
            .order_by(Transaction.posted_date)
        ).scalars().all()
    )
    rows = [t for t in rows if is_payroll(t)]
    if len(rows) < 2:
        return (None, 0.0, 0)
    gaps = [(rows[i + 1].posted_date - rows[i].posted_date).days for i in range(len(rows) - 1)]
    # Round each gap to the closest common cadence.
    rounded = [min(_COMMON_CADENCES, key=lambda c: abs(c - g)) for g in gaps]
    counter = Counter(rounded)
    cadence, count = counter.most_common(1)[0]
    confidence = count / len(rounded)  # what fraction of gaps agreed
    typical = int(median(t.amount_cents for t in rows))
    return (cadence, round(confidence, 2), typical)


def _project_paychecks(
    db: Session, *, start: date, end: date
) -> tuple[list[CashFlowEvent], int | None, float]:
    """Project upcoming paychecks.

    Semi-monthly pay (the common case for salaried US payroll — Chris is
    paid on the 1st and the 15th) is NOT a fixed day-gap: stepping +15
    days from the last paycheck drifts a day or two off every cycle.

    When the history shows the two-cluster semi-monthly signature, each
    paycheck is forecast on its NOMINAL payday — the 1st and the 15th —
    NOT on the date it tends to actually land. The 1st-of-month wire
    routinely arrives a few days early (the 28th-31st of the prior
    month); that early arrival is an actuals phenomenon, not something to
    bake into a forecast. So the forecast says "June 1"; once the wire
    actually posts (early, on time, or late) the ±-window check below
    recognises it AS the June-1 paycheck and stops projecting a duplicate.

    Falls back to flat-gap stepping for genuine bi-weekly / weekly /
    monthly cadences.
    """
    from calendar import monthrange

    cadence, confidence, typical = _infer_paycheck_cadence(db)
    if typical <= 0:
        return ([], cadence, confidence)

    income_account_ids = account_ids_for(db, INCOME_ACCOUNT_TYPES)
    if not income_account_ids:
        return ([], cadence, confidence)
    history = list(
        db.execute(
            select(Transaction)
            .where(Transaction.amount_cents > 0)
            .where(Transaction.posted_date >= date.today() - timedelta(days=120))
            .where(Transaction.account_id.in_(income_account_ids))
            .order_by(Transaction.posted_date)
        ).scalars().all()
    )
    history = [t for t in history if is_payroll(t)]
    if not history:
        return ([], cadence, confidence)
    last_paycheck_date = history[-1].posted_date

    # Semi-monthly signature: paychecks fall into a mid-month cluster
    # (~the 15th) AND a month-start cluster (~the 1st — which, landing
    # early, shows up on the 23rd-31st or the 1st-7th).
    mid_cluster = sum(1 for r in history if 8 <= r.posted_date.day <= 22)
    start_cluster = sum(
        1 for r in history if r.posted_date.day >= 23 or r.posted_date.day <= 7
    )
    is_semi_monthly = mid_cluster >= 2 and start_cluster >= 2

    out: list[CashFlowEvent] = []

    if is_semi_monthly:
        history_dates = [r.posted_date for r in history]

        def _already_landed(nominal: date) -> bool:
            # A paycheck transaction within ±5 days of a nominal payday
            # IS that payday's paycheck — covers the early arrival, plus
            # any weekend / holiday drift. Prevents forecasting a June-1
            # paycheck on top of one that already landed on May 29.
            return any(abs((d - nominal).days) <= 5 for d in history_dates)

        y, m = start.year, start.month
        for _ in range(15):   # safety bound; far more than any real window
            for dom in (1, 15):
                nominal = date(y, m, dom)
                if start <= nominal <= end and not _already_landed(nominal):
                    out.append(
                        CashFlowEvent(
                            on_date=nominal,
                            kind=EventKind.paycheck,
                            label="Expected paycheck",
                            amount_cents=int(typical),
                            confidence=max(confidence, 0.85),
                        )
                    )
            if m == 12:
                y, m = y + 1, 1
            else:
                m += 1
            if date(y, m, 1) > end:
                break
        out.sort(key=lambda e: e.on_date)
        return (out, cadence or 15, max(confidence, 0.85))

    # Fallback: flat-gap projection for bi-weekly / weekly / monthly pay.
    if cadence is None:
        return ([], None, confidence)
    cur = last_paycheck_date + timedelta(days=cadence)
    while cur <= end:
        if cur >= start:
            out.append(
                CashFlowEvent(
                    on_date=cur,
                    kind=EventKind.paycheck,
                    label="Expected paycheck",
                    amount_cents=int(typical),
                    confidence=confidence,
                )
            )
        cur = cur + timedelta(days=cadence)
    return (out, cadence, confidence)


# ---------------------------------------------------------------------
#  Source 4: starting balance (liquid assets)
# ---------------------------------------------------------------------


_LIQUID_TYPES = {AccountType.checking, AccountType.savings, AccountType.cash}


def _liquid_starting_balance(db: Session) -> int:
    """Sum of latest-known balances on liquid asset accounts.

    Mirrors the cache-fallback logic in :mod:`networth.service` —
    prefer the latest BalanceSnapshot for the account, fall back to
    Account.current_balance_cents.
    """
    from ..networth.service import _latest_balance_per_account
    accts = db.execute(
        select(Account).where(Account.account_type.in_(_LIQUID_TYPES))
    ).scalars().all()
    latest = _latest_balance_per_account(db)
    total = 0
    for a in accts:
        bal = latest.get(a.id)
        if bal is None:
            bal = a.current_balance_cents
        if bal is None:
            continue
        total += int(bal)
    return total


def _modeled_recurring_monthly_cents(db: Session) -> int:
    """Monthly-equivalent of the recurring outflows the forecast already
    draws as explicit events — active (non-annual) subscriptions + tracked
    bills.

    ``monthly_financials.compute_trailing_real_outflow`` reports TOTAL real
    spend, which already includes these recurring charges. ``build_forecast``
    subtracts this figure from that total so only the *variable* remainder
    (groceries, gas, dining, shopping) is spread as a daily burn — the
    recurring part is already on the calendar as its own dated events.
    """
    from finance_app.subscriptions.annual_projector import _is_annual

    total = 0
    subs = db.execute(
        select(Subscription).where(Subscription.status == SubscriptionStatus.active)
    ).scalars().all()
    for s in subs:
        if s.cadence_days is None or s.cadence_days <= 0:
            continue
        if _is_annual(s):
            continue
        amt = abs(s.last_amount_cents or s.amount_cents or 0)
        total += amt * 30 // s.cadence_days
    for b in db.execute(select(Bill)).scalars().all():
        amt = abs(b.typical_amount_cents or 0)
        if amt == 0 or b.cadence_days <= 0:
            continue
        total += amt * 30 // b.cadence_days
    return total


# ---------------------------------------------------------------------
#  Top-level
# ---------------------------------------------------------------------


def build_forecast(
    db: Session,
    *,
    days: int = 30,
    today: date | None = None,
    crunch_threshold_cents: int = 0,
) -> CashFlowForecast:
    """Build the rolling N-day cash-flow forecast."""
    today = today or date.today()
    end = today + timedelta(days=days)

    sub_events = _project_subscriptions(db, start=today, end=end)
    bill_events = _project_bills(db, start=today, end=end)
    paycheck_events, cadence, cadence_conf = _project_paychecks(db, start=today, end=end)

    # Sprint 13 — annual subscription renewals (ESPN+ annual, Truthly,
    # etc.). These get stored as monthly-equivalent rows for reporting,
    # but the cash-flow projector must emit a single big event on the
    # actual renewal date, not 12 small fake-monthly events.
    annual_events: list[CashFlowEvent] = []
    try:
        from finance_app.subscriptions.annual_projector import (
            project_annual_renewals,
        )
        for ar in project_annual_renewals(db, start=today, end=end):
            # Avoid "Foo (annual) (annual)" when the row's own name
            # already contains the marker (e.g. "Truthly Pro (annual)"
            # added during manual unmask).
            label = ar.label
            if "(annual)" not in label.lower():
                label = f"{label} (annual)"
            annual_events.append(
                CashFlowEvent(
                    on_date=ar.on_date,
                    kind=EventKind.subscription,
                    label=label,
                    amount_cents=ar.amount_cents,
                    confidence=ar.confidence,
                    source_id=ar.subscription_id,
                    notes=ar.notes,
                )
            )
    except Exception:  # noqa: BLE001 — never let annual projector tank forecast
        logger.exception("annual renewal projector failed; continuing without it")

    events = sorted(
        sub_events + bill_events + paycheck_events + annual_events,
        key=lambda e: (e.on_date, -e.amount_cents),
    )
    starting_balance = _liquid_starting_balance(db)

    # ---- Sprint O wiring: everyday variable spending --------------------
    # The events above only cover subscriptions, bills and paychecks.
    # Without the rest of the spending — groceries, gas, dining, shopping —
    # the running balance only ever climbs and no crunch day is ever
    # flagged. Pull the canonical "real spend" figure from the Sprint O
    # monthly_financials module and subtract the recurring charges already
    # drawn as events, leaving just the variable remainder to spread as a
    # flat daily burn.
    from finance_app.budgets.monthly_financials import (
        compute_trailing_real_outflow,
    )

    real_monthly = compute_trailing_real_outflow(db, today=today)
    modeled_monthly = _modeled_recurring_monthly_cents(db)
    variable_monthly = max(0, real_monthly - modeled_monthly)
    variable_daily = variable_monthly // 30

    # Build per-day rollup
    by_day: dict[date, list[CashFlowEvent]] = {}
    for e in events:
        by_day.setdefault(e.on_date, []).append(e)
    daily: list[DailyForecastPoint] = []
    running = starting_balance
    crunch: list[date] = []
    for i in range(days + 1):
        d = today + timedelta(days=i)
        days_events = by_day.get(d, [])
        inflow = sum(e.amount_cents for e in days_events if e.amount_cents > 0)
        # Explicit dated outflows that day + the flat variable-spend burn.
        # The burn is deliberately NOT added to ``events`` — 30-180
        # identical "variable spending" rows would bury the real events;
        # it surfaces only in the balance line + the panel footnote.
        outflow = (
            sum(-e.amount_cents for e in days_events if e.amount_cents < 0)
            + variable_daily
        )
        net = inflow - outflow
        running += net
        daily.append(
            DailyForecastPoint(
                on_date=d,
                inflow_cents=inflow,
                outflow_cents=outflow,
                net_cents=net,
                running_balance_cents=running,
            )
        )
        if running < crunch_threshold_cents:
            crunch.append(d)

    return CashFlowForecast(
        window_start=today,
        window_end=end,
        starting_balance_cents=starting_balance,
        paycheck_cadence_days=cadence,
        paycheck_cadence_confidence=cadence_conf,
        events=events,
        daily=daily,
        crunch_days=crunch,
        variable_spend_monthly_cents=variable_monthly,
        variable_spend_daily_cents=variable_daily,
    )
