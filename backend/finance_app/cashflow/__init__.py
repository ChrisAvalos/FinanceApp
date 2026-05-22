"""Bill calendar / cash-flow forecast (Phase 7.2).

Combines four streams to produce a forward-looking 30-day calendar:

  1. **Recurring subscriptions** — each active Subscription has a
     ``next_expected_date`` and ``last_amount_cents``; project forward
     N months.
  2. **Tracked bills** — Bill rows with ``cadence_days`` and
     ``due_day_of_month`` (mortgage, insurance premiums).
  3. **Expected paychecks** — derived from the trailing salary cadence
     in the income.salary category. We pick the most-frequent gap
     between paycheck deposits and project the next N at that cadence.
  4. **Live cash on hand** — sum of asset balances at the start of the
     window (the ``current_net_worth().assets_cents`` from the asset
     side, intersected to liquid-only types: checking, savings, cash).

For every forecast day we compute (running balance after that day's
inflows and outflows). Crunch days surface where running_balance < 0
or < user-configurable threshold.
"""
from .service import (
    CashFlowEvent,
    CashFlowForecast,
    DailyForecastPoint,
    EventKind,
    build_forecast,
)

__all__ = [
    "CashFlowEvent",
    "CashFlowForecast",
    "DailyForecastPoint",
    "EventKind",
    "build_forecast",
]
