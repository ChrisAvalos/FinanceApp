"""Budget projection engine — Wave G, Sprint G-2.

Projects checking / savings / investment / net-worth balances forward
N months given a baseline budget, optional category overrides, and the
data already in the DB (Plaid balances, Cash Flow forecast, confirmed
Subscriptions, recurring paychecks).

Why this lives in its own module
--------------------------------
The math is meaty (5 inputs, monthly compounding for investments, a
two-bucket cash allocator) and we want it tested in isolation. The API
layer just builds inputs and calls :func:`project` — no inline math.

Inputs
------
* ``start_balances`` — current balances by bucket (checking / savings /
  investment), in cents.
* ``monthly_income_cents`` — recurring inflows. We pull the cash-flow
  forecast's paychecks for the next 30 days and project them forward,
  assuming the same monthly cadence.
* ``budgeted_outflow_cents`` — the sum of category budgets. This is
  what the user has explicitly planned to spend each month.
* ``unbudgeted_outflow_cents`` — categories with no budget but visible
  spend in the last 3 months. We assume the user will keep spending
  here at the rolling avg unless they explicitly budget = 0 via the
  what-if interface.
* ``annual_outflow_cents`` — sum of annual renewals from the Cash Flow
  upcoming-annuals endpoint, amortized over 12 months.
* ``category_overrides`` — optional dict[category_id, new_monthly_cents]
  that replaces the rolling-avg for those categories. Drives the
  what-if scenario UI.

Investment growth model
-----------------------
Investment balance grows at a configurable annual rate (default 5%
post-inflation — the long-run real return the FIRE projection panel
also defaults to, so the two views agree numerically when opened side
by side). Monthly compounding: ``b *= (1 + r/12)``.

Cash overflow rule
------------------
Net monthly cash flow (income − outflow) goes into checking by
default. If checking exceeds a configurable cap (default $5K), the
excess sweeps to savings. This matches a typical user's mental model
of "anything past my buffer goes to savings."
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Optional

logger = logging.getLogger(__name__)


# Tunables. Kept in sync with the FIRE projection panel's default
# assumptions so the two views don't disagree numerically when the user
# opens both side-by-side. FIRE defaults to a 5% post-inflation real
# return ("historical S&P 500 ≈ 5% real"); the Budgets projection uses
# the same figure. (2026-05-20: was 0.07, which had drifted out of sync
# with FIRE's 5% — the audit caught it. The numeric impact is tiny here
# anyway since the projection is flow-dominated, not balance-dominated.)
DEFAULT_INVESTMENT_APY = 0.05     # 5% long-run real return (post-inflation)
DEFAULT_CHECKING_CAP_CENTS = 500_000  # $5K — anything past this sweeps to savings


@dataclass
class StartBalances:
    """Current bucket-wise balances. All values in cents, all positive."""
    checking_cents: int = 0
    savings_cents: int = 0
    investment_cents: int = 0

    @property
    def total_cents(self) -> int:
        return self.checking_cents + self.savings_cents + self.investment_cents


@dataclass
class ProjectionPoint:
    """One month's projected balances. Month index is 0-based — 0 is today."""
    month_index: int
    checking_cents: int
    savings_cents: int
    investment_cents: int
    # Net is the sum of the three buckets MINUS any liability balances
    # the caller passed in. If liabilities aren't tracked, net = sum.
    net_cents: int
    # Per-month flow values (kept for the tooltip / debugging).
    income_cents: int
    outflow_cents: int


@dataclass
class ProjectionResult:
    """Output of a single project() call."""
    points: list[ProjectionPoint] = field(default_factory=list)
    # Sum of monthly net flow (income - outflow) projected. Useful for
    # the headline "you'll save $X over 24 months" copy.
    total_net_flow_cents: int = 0
    # Echo the effective assumptions back so the UI can label the chart
    # with "Assumes 7% return, $5K checking cap" etc.
    investment_apy: float = DEFAULT_INVESTMENT_APY
    checking_cap_cents: int = DEFAULT_CHECKING_CAP_CENTS


# ----------------------------------------------------------------------
#  Core projection function
# ----------------------------------------------------------------------

def project(
    *,
    months: int,
    start: StartBalances,
    monthly_income_cents: int,
    monthly_outflow_cents: int,
    liability_cents: int = 0,
    investment_apy: float = DEFAULT_INVESTMENT_APY,
    checking_cap_cents: int = DEFAULT_CHECKING_CAP_CENTS,
    monthly_investment_contribution_cents: int = 0,
) -> ProjectionResult:
    """Run a balance projection out to ``months`` months.

    Args:
        months: Number of months to project. Must be ≥ 1.
        start: Starting balances by bucket.
        monthly_income_cents: Expected income per month (positive cents).
        monthly_outflow_cents: Expected outflow per month (positive cents).
        liability_cents: Current liabilities (mortgage principal, credit card
            balances). Held constant — we don't amortize loans here because
            the user's spending budget should already include the monthly
            payment; double-counting payoff would distort the projection.
        investment_apy: Annual rate of return for investments (decimal,
            e.g. 0.07 for 7%). Compounded monthly.
        checking_cap_cents: When checking balance exceeds this, the
            overflow sweeps to savings. Set to a very large number to
            disable the sweep (all surplus stays in checking).
        monthly_investment_contribution_cents: Per-month transfer from
            checking → investment. Useful for goal-driven scenarios
            ("$500/mo to retirement"). Defaults to 0.

    Returns:
        ProjectionResult with months+1 points (index 0 = current,
        index `months` = end-state).
    """
    if months < 1:
        raise ValueError("months must be ≥ 1")
    if investment_apy < -1.0:
        raise ValueError("investment_apy is a decimal rate, not a percent")

    monthly_rate = (1.0 + investment_apy) ** (1.0 / 12.0) - 1.0
    points: list[ProjectionPoint] = []
    checking = start.checking_cents
    savings = start.savings_cents
    investment = start.investment_cents

    # Point 0 = "today" — record the starting state with zero flows.
    points.append(ProjectionPoint(
        month_index=0,
        checking_cents=checking,
        savings_cents=savings,
        investment_cents=investment,
        net_cents=checking + savings + investment - liability_cents,
        income_cents=0,
        outflow_cents=0,
    ))

    cumulative_net_flow = 0
    for m in range(1, months + 1):
        # 1. Income lands in checking.
        checking += monthly_income_cents
        # 2. Outflow leaves from checking. Allowed to go negative —
        # the projection should expose that "you'll be broke by Aug"
        # rather than silently clamp.
        checking -= monthly_outflow_cents
        # 3. Investment contribution: pull from checking → investment.
        if monthly_investment_contribution_cents > 0:
            checking -= monthly_investment_contribution_cents
            investment += monthly_investment_contribution_cents
        # 4. Investment compounds at the monthly rate.
        # round() to nearest cent so we don't accrete floating-point dust.
        investment = round(investment * (1.0 + monthly_rate))
        # 5. Sweep: anything in checking above the cap moves to savings.
        if checking > checking_cap_cents:
            excess = checking - checking_cap_cents
            checking -= excess
            savings += excess
        net = checking + savings + investment - liability_cents
        cumulative_net_flow += monthly_income_cents - monthly_outflow_cents
        points.append(ProjectionPoint(
            month_index=m,
            checking_cents=checking,
            savings_cents=savings,
            investment_cents=investment,
            net_cents=net,
            income_cents=monthly_income_cents,
            outflow_cents=monthly_outflow_cents,
        ))

    return ProjectionResult(
        points=points,
        total_net_flow_cents=cumulative_net_flow,
        investment_apy=investment_apy,
        checking_cap_cents=checking_cap_cents,
    )


# ----------------------------------------------------------------------
#  Convenience: pull inputs out of the DB
# ----------------------------------------------------------------------


def gather_inputs(db, month_start: date) -> dict:
    """Pull starting balances, recurring income, baseline outflow, etc.

    Returns a dict suitable for spreading into :func:`project`. Caller
    can override any field before passing to project — that's the
    what-if hook.
    """
    from sqlalchemy import case, func, select
    from finance_app.db.models import (
        Account,
        AccountType,
        Budget,
        Category,
        Subscription,
        SubscriptionStatus,
        Transaction,
    )

    # 1. Bucket-wise starting balances. Pull from Account.current_balance_cents
    # which Plaid keeps fresh + the Albert scraper (Sprint 43) writes to.
    accounts = db.execute(
        select(Account).where(Account.is_active == True)  # noqa: E712
    ).scalars().all()

    bucket = StartBalances()
    liability_cents = 0
    for a in accounts:
        bal = a.current_balance_cents or 0
        if a.account_type == AccountType.checking:
            bucket.checking_cents += bal
        elif a.account_type == AccountType.savings:
            bucket.savings_cents += bal
        elif a.account_type == AccountType.investment:
            bucket.investment_cents += bal
        elif a.account_type == AccountType.cash:
            bucket.checking_cents += bal  # treat cash like checking
        elif a.account_type in (AccountType.credit_card, AccountType.loan, AccountType.mortgage):
            # Liability accounts store their balance as a NEGATIVE number
            # (the Chase card reads −$1,984.12 owed). `liability_cents` is
            # a positive magnitude of debt that the projection SUBTRACTS,
            # so flip the sign. Net worth then works out to
            # assets − liability_cents == assets + bal — the same signed
            # sum the Net Worth panel and the FIRE projection use, so all
            # three agree. (A positive balance — a card in credit —
            # correctly nudges net worth up.)
            #
            # The prior code did `+= bal` on the assumption balances were
            # stored positive; that flipped liability_cents negative and
            # inflated starting net worth by 2× the debt ($5,169.51 shown
            # vs the true $1,201.27).
            liability_cents -= bal

    # 2. Monthly income — Sprint O-4: from the ONE canonical module
    # (`monthly_financials`), the same source the rollup and ledger now
    # read. The projection uses `recurring_avg` (90-day Livio payroll
    # average) rather than this month's expected total, because future
    # projection months have no "landed" paychecks — the dependable
    # recurring baseline is the honest input there.
    from finance_app.budgets.monthly_financials import (
        compute_month_income,
        compute_trailing_real_outflow,
    )

    ninety_days_ago = date.today() - timedelta(days=90)
    monthly_income_cents = compute_month_income(
        db, month_start
    ).recurring_avg_cents

    # 3. Baseline outflow — sum of THIS month's budgets if set, otherwise
    # fall back to the 90-day rolling outflow average.
    budgets = db.execute(
        select(Budget).where(Budget.month_start == month_start)
    ).scalars().all()
    budgeted_outflow_cents = sum(b.amount_cents for b in budgets)

    # Sprint O-4 — the conservative (90-day rolling) outflow comes from
    # the ONE canonical computation. The previous inline version only
    # excluded description-detected savings sweeps (Sprint K-5); it
    # still counted credit-card payments, transfers and investment
    # contributions as "spending". That inflated the conservative
    # projection by ~$1,400/mo and made it contradict the EOM card
    # (-$2,093 vs -$632). `compute_trailing_real_outflow` applies the
    # same catchall exclusion the rollup's "real spending" uses, so the
    # two surfaces can no longer disagree on what counts as spending.
    monthly_rolling_outflow_cents = compute_trailing_real_outflow(db)

    # Status-quo baseline = rolling-avg, NOT budget caps. Reasoning:
    # the projection's job is "if nothing changes, where do I end up" —
    # that's the realistic outflow the user has been running, not the
    # cap they SET. Budget caps drive the slider RANGES in the what-if
    # interface, but the baseline projection reflects reality.
    #
    # If the user has zero transactions yet (fresh install), fall back
    # to budget caps as a best-guess.
    monthly_outflow_cents = (
        monthly_rolling_outflow_cents
        if monthly_rolling_outflow_cents > 0
        else budgeted_outflow_cents
    )

    # 4. Subscription contribution — only add subs if we don't have
    # transaction history yet (otherwise rolling_outflow already
    # captures their charges). Prevents double-counting.
    if monthly_rolling_outflow_cents == 0:
        subs = db.execute(
            select(Subscription).where(Subscription.status == SubscriptionStatus.active)
        ).scalars().all()
        for s in subs:
            raw = abs(s.last_amount_cents or s.amount_cents or 0)
            cadence = max(s.cadence_days or 30, 1)
            monthly_outflow_cents += round(raw * 30 / cadence)

    # 5. Per-category breakdown — needed for the what-if override path.
    # KEY: the "monthly_cents" stored here is the user's ACTUAL rolling
    # 3-month spend for the category, NOT the budget cap. This is what
    # makes overrides math out correctly: when a user "applies" the
    # recommendation `Restaurants: cap at $200/mo`, the new value
    # ($200) is compared against ACTUAL spend ($719), and the $519/mo
    # delta lands in the projection. If we used the budget cap as the
    # baseline, override == cap → no diff → no projection change.
    #
    # The budget cap is preserved as `budget_cap_cents` so the slider UI
    # can show "Your current cap: $200" alongside the slider value.
    rolling_per_category = {}
    rolling_cat_rows = db.execute(
        select(
            Transaction.category_id,
            func.sum(Transaction.amount_cents).label("amt"),
        )
        .where(Transaction.amount_cents < 0)
        .where(Transaction.posted_date >= ninety_days_ago)
        .where(Transaction.category_id.is_not(None))
        # Exclude user-flagged one-offs — a one-time spike must not inflate
        # the rolling per-category baseline the projection carries forward.
        .where(Transaction.is_one_time.is_(False))
        .group_by(Transaction.category_id)
    ).all()
    for row in rolling_cat_rows:
        rolling_per_category[row.category_id] = abs(row.amt or 0) // 3

    # Union of (budgeted categories, categories with rolling spend) — both
    # appear as sliders so the user can budget categories they've been
    # spending in but haven't capped yet.
    cat_ids = set(rolling_per_category.keys()) | {b.category_id for b in budgets}
    if cat_ids:
        categories_query = db.execute(
            select(Category.id, Category.name).where(Category.id.in_(cat_ids))
        ).all()
    else:
        categories_query = []
    category_baseline: dict[int, dict] = {}
    for cat_id, cat_name in categories_query:
        budget_row = next((b for b in budgets if b.category_id == cat_id), None)
        rolling = rolling_per_category.get(cat_id, 0)
        # If the user has a budget but no rolling spend (e.g. just set
        # the budget today), fall back to the budget as the baseline.
        baseline_for_override = rolling if rolling > 0 else (budget_row.amount_cents if budget_row else 0)
        if baseline_for_override <= 0:
            continue
        category_baseline[cat_id] = {
            "id": cat_id,
            "name": cat_name,
            "monthly_cents": baseline_for_override,
            "budget_cap_cents": budget_row.amount_cents if budget_row else 0,
        }

    # ---- Sprint J-1a: optimistic outflow ----
    # The conservative outflow above (rolling-90-day) is inflated by
    # rent-timing artifacts (multiple rent payments crammed into one
    # calendar month, e.g. Chris's Feb 2/Mar 2/Mar 31/Apr 30 Valeria
    # payments). The "optimistic" view assumes future months play out
    # like THIS month is currently pacing — splitting committed bills
    # (one-shot monthly) from variable spend (pace-extrapolated).
    #
    # Formula: optimistic_outflow = committed_actual_this_month
    #                              + committed_remaining_this_month
    #                              + (variable_actual_so_far / pace)
    #
    # Same math the rollup endpoint uses for `eom_projected_outflow_cents`.
    # We replicate it here rather than importing from the API layer
    # because backend → API would be a circular dep.
    from finance_app.api.budgets import (
        _is_catchall_cat,
        _RENT_SHIFT_DAY_CUTOFF,
        _find_rent_like_txns,
    )
    from calendar import monthrange

    first_day = month_start
    last_day_num = monthrange(month_start.year, month_start.month)[1]
    last_day = date(month_start.year, month_start.month, last_day_num)
    days_in_month = last_day_num
    days_elapsed = (min(date.today(), last_day) - first_day).days + 1
    pace_this_month = max(0.05, min(1.0, days_elapsed / days_in_month))

    # Walk this month's outflows category-by-category, splitting committed
    # (non-discretionary, non-catchall) from variable.
    committed_actual_this_month = 0
    variable_actual_this_month = 0
    committed_remaining_this_month = 0
    # Pull this month's spending by category.
    spend_rows = db.execute(
        select(
            Transaction.category_id,
            func.sum(case((Transaction.amount_cents < 0, -Transaction.amount_cents), else_=0)).label("outflow"),
        )
        .where(Transaction.posted_date >= first_day)
        .where(Transaction.posted_date <= last_day)
        # One-offs are excluded here too: optimistic_monthly_outflow is
        # projected forward as a monthly rate, and future months will not
        # repeat a medical emergency or car repair.
        .where(Transaction.is_one_time.is_(False))
        .group_by(Transaction.category_id)
    ).all()
    spend_by_cat = {r.category_id: int(r.outflow or 0) for r in spend_rows if r.outflow}

    # Rent-attribution: if Apr 30 Valeria $2,075 lands in the prior month's
    # data, the rollup endpoint shifts it forward. Do the same here so the
    # optimistic projection doesn't undercount rent.
    prior_ms_end = first_day - timedelta(days=1)
    prior_ms_start = prior_ms_end.replace(day=_RENT_SHIFT_DAY_CUTOFF)
    rent_canonical_cat = db.execute(
        select(Category).where(
            func.lower(Category.name).in_(("rent / mortgage", "rent/mortgage", "rent", "mortgage"))
        )
    ).scalars().first()
    if rent_canonical_cat is not None:
        for tx in _find_rent_like_txns(db, start_date=prior_ms_start, end_date=prior_ms_end):
            spend_by_cat[rent_canonical_cat.id] = (
                spend_by_cat.get(rent_canonical_cat.id, 0) + (-tx.amount_cents)
            )

    cat_lookup = {c.id: c for c in db.execute(select(Category)).scalars().all()}

    for cat_id, actual in spend_by_cat.items():
        if cat_id is None:
            variable_actual_this_month += actual
            continue
        cat = cat_lookup.get(cat_id)
        if cat is None:
            variable_actual_this_month += actual
            continue
        if _is_catchall_cat(cat.name):
            # Catchalls don't count toward optimistic outflow at all —
            # treating them as a one-shot ghost would over-deflate the
            # number. They're already excluded from real_budget too.
            continue
        if not cat.is_discretionary:
            committed_actual_this_month += actual
        else:
            variable_actual_this_month += actual

    # Committed remaining = sum over non-discretionary categories of
    # (cap - actual_so_far), clipped at zero.
    for b in budgets:
        cat = cat_lookup.get(b.category_id)
        if cat is None or _is_catchall_cat(cat.name) or cat.is_discretionary:
            continue
        actual = spend_by_cat.get(b.category_id, 0)
        committed_remaining_this_month += max(0, b.amount_cents - actual)

    if pace_this_month > 0.05:
        variable_eom = int(round(variable_actual_this_month / pace_this_month))
    else:
        variable_eom = variable_actual_this_month
    optimistic_monthly_outflow_cents = (
        committed_actual_this_month + committed_remaining_this_month + variable_eom
    )

    return {
        "start": bucket,
        "liability_cents": liability_cents,
        "monthly_income_cents": monthly_income_cents,
        "monthly_outflow_cents": monthly_outflow_cents,
        "optimistic_monthly_outflow_cents": optimistic_monthly_outflow_cents,
        "budgeted_outflow_cents": budgeted_outflow_cents,
        "monthly_rolling_outflow_cents": monthly_rolling_outflow_cents,
        "category_baseline": category_baseline,
    }


def apply_overrides(
    baseline_outflow_cents: int,
    category_baseline: dict[int, dict],
    overrides: dict[int, int],
) -> int:
    """Compute the adjusted monthly outflow when the user has overridden
    some category caps via the what-if sliders.

    Args:
        baseline_outflow_cents: The status-quo monthly outflow.
        category_baseline: Per-category baseline monthly cents.
        overrides: dict[category_id, new_monthly_cents].

    Returns:
        Adjusted total monthly outflow in cents (never negative).
    """
    if not overrides:
        return baseline_outflow_cents
    adjustment = 0
    for cat_id, new_cents in overrides.items():
        baseline = category_baseline.get(cat_id, {}).get("monthly_cents")
        if baseline is None:
            continue
        adjustment += new_cents - baseline
    return max(0, baseline_outflow_cents + adjustment)


__all__ = [
    "DEFAULT_INVESTMENT_APY",
    "DEFAULT_CHECKING_CAP_CENTS",
    "StartBalances",
    "ProjectionPoint",
    "ProjectionResult",
    "project",
    "gather_inputs",
    "apply_overrides",
]
