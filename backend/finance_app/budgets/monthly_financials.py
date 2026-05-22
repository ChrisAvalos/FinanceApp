"""monthly_financials — one source of truth for a month's money figures.

Sprint O. Before this module, ``rollup``, ``assignment-ledger``,
``project_budgets`` and ``recurring-bills`` each re-derived "what did
the user earn / spend this month." They drifted — the Budgets page
showed income as both $7,240 and $7,159 at the same time.

This module computes a month's canonical figures ONCE. Every endpoint
reads from here instead of recomputing. Same idea as Sprint N's
``EnrichmentService`` (which consolidated transaction *classification*)
— this consolidates the dollar *aggregates*.

O-1 ships the INCOME figures (the keystone — income is the most
visible mismatch). O-1-continued adds the spend / EOM figures, then
O-2..O-4 rewire the consumers.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from statistics import median

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import Account, AccountType, Category, Transaction
from finance_app.enrichment import (
    is_catchall,
    is_other_income,
    is_payroll,
    is_savings_transfer,
)


# Income is averaged / scanned over this trailing window. 90 days = 3
# months, matching the rollup's existing convention.
_INCOME_WINDOW_DAYS = 90


# ---- Account anchoring (the "unified Chase basis") ----
#
# Every money figure is anchored on the accounts money actually flows
# THROUGH, not every linked account. Chris's setup: all real activity is
# on Chase checking + the Chase credit card; the E*TRADE / Albert
# savings + investment accounts are destinations — money lands there
# only as a transfer.
#
#   * INCOME lands only in a checking account (payroll, peer transfers,
#     refunds). A credit card never receives income — only payments and
#     refunds; a savings account only receives transfers. Scanning all
#     accounts would miscount a self-transfer into savings as income.
#   * SPENDING flows through the two transaction conduits — checking
#     (debit) and credit card (charges). Savings/investment outflows are
#     transfers, never spend.
INCOME_ACCOUNT_TYPES: tuple[AccountType, ...] = (AccountType.checking,)
SPEND_ACCOUNT_TYPES: tuple[AccountType, ...] = (
    AccountType.checking,
    AccountType.credit_card,
)


def account_ids_for(db: Session, types: tuple[AccountType, ...]) -> set[int]:
    """Ids of every account whose type is in ``types`` — the set a
    transaction query filters on to stay anchored on the right accounts."""
    return set(
        db.execute(
            select(Account.id).where(Account.account_type.in_(types))
        ).scalars().all()
    )


@dataclass(frozen=True)
class MonthlyIncome:
    """Every income figure the app needs for one month, computed once.

    Why so many fields: different surfaces legitimately want different
    cuts. The current-month cards want ``expected_total`` ($7,240). The
    multi-month projection wants ``recurring_avg`` ($7,159 — the
    dependable baseline, since future months have no landed paychecks).
    The bug was each surface computing its OWN version; here they're
    all derived together so they can never disagree.
    """
    month_start: date
    # Livio paychecks whose EFFECTIVE month is this month, summed.
    # "Effective" applies the end-of-month wire shift (a paycheck
    # posted on the 30th for the 1st counts toward next month).
    landed_cents: int
    # Paychecks still expected before month-end, from payroll cadence.
    expected_remaining_cents: int
    # landed + expected_remaining — "what will I make this month."
    # This is the number the current-month cards should show.
    expected_total_cents: int
    # 90-day trailing average of Livio paychecks. Stable; used by the
    # multi-month projection (future months have no landed paychecks).
    recurring_avg_cents: int
    # 90-day trailing average of ALL positive inflows / 3 (includes
    # peer transfers, settlements). Rarely the right number to show —
    # kept for backward-compat with the old monthly_income field.
    all_inflow_avg_cents: int
    # Windfalls / settlement payouts that landed this month (Brigit,
    # Labaton). Surfaced separately — NOT in expected_total because
    # windfalls don't recur.
    other_income_cents: int
    # The next expected paycheck date (cadence heuristic). None if no
    # more paychecks expected this month.
    next_paycheck_date: date | None


def _effective_month(d: date) -> tuple[int, int]:
    """End-of-month payroll wires (day >= 28) count toward NEXT month —
    they're the 1st-of-next-month paycheck landing early to dodge a
    weekend/holiday. Mirrors the rollup's logic exactly."""
    if d.day >= 28:
        if d.month == 12:
            return (d.year + 1, 1)
        return (d.year, d.month + 1)
    return (d.year, d.month)


def compute_month_income(
    db: Session,
    month_start: date,
    *,
    today: date | None = None,
) -> MonthlyIncome:
    """Compute every income figure for ``month_start``'s month.

    Faithful port of the income math currently inline in
    ``api/budgets.py::rollup`` — extracted so assignment-ledger and the
    projection can read the SAME numbers instead of re-deriving them.
    """
    today = today or date.today()
    window_start = today - timedelta(days=_INCOME_WINDOW_DAYS)

    # ---- 90-day trailing averages ----
    # Anchored on checking-type accounts: income lands in checking, never
    # on a credit card or in a savings account. Without this filter a
    # self-transfer into E*TRADE/Albert savings was being summed in as
    # "income."
    income_account_ids = account_ids_for(db, INCOME_ACCOUNT_TYPES)
    inflow_rows = db.execute(
        select(Transaction)
        .where(Transaction.amount_cents > 0)
        .where(Transaction.posted_date >= window_start)
        .where(Transaction.posted_date <= today)
        .where(Transaction.account_id.in_(income_account_ids))
    ).scalars().all()

    all_inflow_total = sum(tx.amount_cents for tx in inflow_rows)
    payroll_total = sum(
        tx.amount_cents for tx in inflow_rows if is_payroll(tx)
    )
    all_inflow_avg = max(0, int(all_inflow_total) // 3)
    recurring_avg = max(0, int(payroll_total) // 3)

    # ---- this month's paycheck cadence ----
    payroll_history = [tx for tx in inflow_rows if is_payroll(tx)]
    current_key = (month_start.year, month_start.month)

    expected_remaining = 0
    next_paycheck_date: date | None = None
    if payroll_history:
        # paychecks per effective-month
        month_counts: dict[tuple[int, int], int] = {}
        for tx in payroll_history:
            k = _effective_month(tx.posted_date)
            month_counts[k] = month_counts.get(k, 0) + 1

        # typical = median of FULL months (exclude the in-progress one)
        full_months = [c for k, c in month_counts.items() if k != current_key]
        typical_per_month = (
            sorted(full_months)[len(full_months) // 2] if full_months else 2
        )
        received = month_counts.get(current_key, 0)
        remaining = max(0, typical_per_month - received)
        avg_paycheck = sum(int(t.amount_cents) for t in payroll_history) // len(
            payroll_history
        )
        expected_remaining = remaining * avg_paycheck

        # next-paycheck date via median gap
        if remaining > 0:
            chrono = sorted(payroll_history, key=lambda t: t.posted_date)
            gaps = [
                (chrono[i + 1].posted_date - chrono[i].posted_date).days
                for i in range(len(chrono) - 1)
                if (chrono[i + 1].posted_date - chrono[i].posted_date).days > 0
            ]
            if gaps:
                median_gap = sorted(gaps)[len(gaps) // 2]
                projected = chrono[-1].posted_date + timedelta(days=median_gap)
                if projected > today:
                    next_paycheck_date = projected

    # ---- landed this month (effective-month bucketed) ----
    landed = sum(
        int(tx.amount_cents)
        for tx in payroll_history
        if _effective_month(tx.posted_date) == current_key
    )
    expected_total = landed + expected_remaining

    # ---- windfalls landed this month (posted-month bucketed) ----
    other_income = sum(
        int(tx.amount_cents)
        for tx in inflow_rows
        if is_other_income(tx)
        and tx.posted_date.year == month_start.year
        and tx.posted_date.month == month_start.month
    )

    return MonthlyIncome(
        month_start=month_start,
        landed_cents=landed,
        expected_remaining_cents=expected_remaining,
        expected_total_cents=expected_total,
        recurring_avg_cents=recurring_avg,
        all_inflow_avg_cents=all_inflow_avg,
        other_income_cents=other_income,
        next_paycheck_date=next_paycheck_date,
    )


def compute_trailing_real_outflow(
    db: Session,
    *,
    today: date | None = None,
    window_days: int = _INCOME_WINDOW_DAYS,
) -> int:
    """Trailing-window monthly average of "real" outflow, in cents.

    Sprint O-4. "Real" outflow excludes internal money movement:

      * the four catchall categories — Transfer, Uncategorized, Credit
        Card Payment, Investment Contribution;
      * description-detected savings sweeps (Albert EDI auto-saves and
        similar) that may not carry a catchall category.
      * user-flagged one-time transactions (``is_one_time``) — a
        medical emergency or car repair must not be smeared into the
        recurring monthly rate the projection extrapolates forward.

    Those dollars don't deplete net worth. A credit-card payment just
    moves cash against a liability the projector already holds constant
    (and the underlying purchases were already counted in their own
    categories); an investment contribution moves checking → investment.
    Counting them as "spending" made the conservative projection roughly
    $1,400/mo too pessimistic.

    The query is anchored on the transaction conduits (checking + credit
    card); the catchall + savings-transfer exclusions below are a backup.
    The window total is normalised to a 30-day month.
    """
    today = today or date.today()
    window_start = today - timedelta(days=window_days)

    cats: dict[int, Category] = {
        c.id: c for c in db.execute(select(Category)).scalars().all()
    }

    # Anchored on the transaction conduits — checking + credit card.
    # An outflow on a savings/investment account is a transfer, not
    # spending, so it never belongs in this total.
    spend_account_ids = account_ids_for(db, SPEND_ACCOUNT_TYPES)
    outflow_rows = db.execute(
        select(Transaction)
        .where(Transaction.amount_cents < 0)
        .where(Transaction.posted_date >= window_start)
        .where(Transaction.posted_date <= today)
        .where(Transaction.account_id.in_(spend_account_ids))
    ).scalars().all()

    total = 0
    for tx in outflow_rows:
        if tx.is_one_time:
            # User-flagged one-off (medical emergency, car repair, a big
            # one-time purchase). Excluded so a single spike is not smeared
            # into the monthly outflow rate the projection extrapolates.
            continue
        cat = cats.get(tx.category_id) if tx.category_id else None
        if is_catchall(cat.name if cat else None):
            continue
        if is_savings_transfer(tx):
            continue
        total += -int(tx.amount_cents)

    # Normalise the window sum to a 30-day month (90-day window -> / 3).
    return max(0, total * 30 // window_days)
