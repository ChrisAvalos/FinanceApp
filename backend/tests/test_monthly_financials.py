"""Characterization tests for budgets/monthly_financials.py.

This module is Sprint O's single source of truth for a month's income
and outflow figures. These tests pin its current behavior so the planned
refactor of the 2,500-line budgets.py cannot silently change the numbers.

`today` is passed explicitly to every call so the suite is deterministic
regardless of the real clock.
"""
from __future__ import annotations

from datetime import date

from finance_app.budgets.monthly_financials import (
    compute_month_income,
    compute_trailing_real_outflow,
)
from finance_app.db.models import AccountType

from factories import make_account, make_category, make_txn

TODAY = date(2026, 5, 31)
MONTH = date(2026, 5, 1)


# ---------------------------------------------------------------- income


def test_empty_db_income_is_all_zero(db):
    mi = compute_month_income(db, MONTH, today=TODAY)
    assert mi.landed_cents == 0
    assert mi.expected_total_cents == 0
    assert mi.recurring_avg_cents == 0
    assert mi.all_inflow_avg_cents == 0
    assert mi.other_income_cents == 0


def test_landed_payroll_counts_as_month_income(db):
    chk = make_account(db, account_type=AccountType.checking)
    # Two Livio paychecks this month, both before the 28th.
    make_txn(db, account=chk, posted_date=date(2026, 5, 5), amount_cents=362000,
             description_raw="LIVIO BUILDING SYSTEMS PAYROLL")
    make_txn(db, account=chk, posted_date=date(2026, 5, 15), amount_cents=362000,
             description_raw="FEDWIRE CREDIT VIA LIVIO")
    mi = compute_month_income(db, MONTH, today=TODAY)
    assert mi.landed_cents == 724000          # 2 x $3,620
    assert mi.expected_total_cents == 724000  # both paychecks already landed
    # recurring_avg = trailing-window payroll total / 3 (90-day -> monthly)
    assert mi.recurring_avg_cents == 724000 // 3


def test_income_is_anchored_to_checking_accounts_only(db):
    # A "paycheck" landing in savings is not counted as income — income
    # only flows through checking; a savings credit is a transfer.
    sav = make_account(db, account_type=AccountType.savings)
    make_txn(db, account=sav, posted_date=date(2026, 5, 10), amount_cents=362000,
             description_raw="LIVIO PAYROLL")
    mi = compute_month_income(db, MONTH, today=TODAY)
    assert mi.landed_cents == 0
    assert mi.recurring_avg_cents == 0


def test_non_payroll_inflow_is_not_recurring(db):
    chk = make_account(db, account_type=AccountType.checking)
    make_txn(db, account=chk, posted_date=date(2026, 5, 10), amount_cents=50000,
             description_raw="ZELLE FROM A FRIEND")
    mi = compute_month_income(db, MONTH, today=TODAY)
    # counted in the all-inflow average...
    assert mi.all_inflow_avg_cents == 50000 // 3
    # ...but NOT as recurring payroll, and not as landed paycheck income.
    assert mi.recurring_avg_cents == 0
    assert mi.landed_cents == 0


def test_end_of_month_paycheck_shifts_to_next_month(db):
    # A paycheck posted on the 29th (day >= 28) is the NEXT month's
    # paycheck arriving early — it must not count as THIS month's landed
    # income, though it still feeds the recurring average.
    chk = make_account(db, account_type=AccountType.checking)
    make_txn(db, account=chk, posted_date=date(2026, 5, 29), amount_cents=362000,
             description_raw="LIVIO PAYROLL")
    mi = compute_month_income(db, MONTH, today=TODAY)
    assert mi.landed_cents == 0                       # effective month is June
    assert mi.recurring_avg_cents == 362000 // 3      # still a real paycheck


def test_prior_month_end_paycheck_shifts_into_this_month(db):
    # The mirror image: a paycheck on Apr 29 (day >= 28) is effectively
    # the May 1 paycheck, so it counts as May landed income.
    chk = make_account(db, account_type=AccountType.checking)
    make_txn(db, account=chk, posted_date=date(2026, 4, 29), amount_cents=362000,
             description_raw="LIVIO PAYROLL")
    mi = compute_month_income(db, MONTH, today=TODAY)
    assert mi.landed_cents == 362000


# --------------------------------------------------------------- outflow


def test_empty_db_real_outflow_is_zero(db):
    assert compute_trailing_real_outflow(db, today=TODAY) == 0


def test_real_outflow_normalizes_window_to_30_days(db):
    chk = make_account(db, account_type=AccountType.checking)
    groceries = make_category(db, name="Groceries")
    make_txn(db, account=chk, posted_date=date(2026, 5, 10), amount_cents=-30000,
             description_raw="WHOLE FOODS", category=groceries)
    # 90-day window total $300 -> 30-day-equivalent $100.
    assert compute_trailing_real_outflow(db, today=TODAY) == 30000 * 30 // 90


def test_real_outflow_excludes_catchall_categories(db):
    chk = make_account(db, account_type=AccountType.checking)
    transfer = make_category(db, name="Transfer")  # a catch-all bucket
    make_txn(db, account=chk, posted_date=date(2026, 5, 10), amount_cents=-30000,
             description_raw="MOVE TO SAVINGS", category=transfer)
    assert compute_trailing_real_outflow(db, today=TODAY) == 0


def test_real_outflow_excludes_one_time_charges(db):
    chk = make_account(db, account_type=AccountType.checking)
    medical = make_category(db, name="Medical")
    make_txn(db, account=chk, posted_date=date(2026, 5, 10), amount_cents=-30000,
             description_raw="ER VISIT", category=medical, is_one_time=True)
    assert compute_trailing_real_outflow(db, today=TODAY) == 0


def test_real_outflow_excludes_albert_savings_sweep(db):
    chk = make_account(db, account_type=AccountType.checking)
    make_txn(db, account=chk, posted_date=date(2026, 5, 10), amount_cents=-30000,
             description_raw="ALBERT EDI AUTOSAVE")
    assert compute_trailing_real_outflow(db, today=TODAY) == 0


def test_real_outflow_anchored_to_checking_and_credit_card(db):
    # Spending flows through checking + credit card; an outflow from a
    # savings account is a transfer, not spend.
    sav = make_account(db, account_type=AccountType.savings)
    cc = make_account(db, account_type=AccountType.credit_card)
    groceries = make_category(db, name="Groceries")
    make_txn(db, account=sav, posted_date=date(2026, 5, 10), amount_cents=-30000,
             description_raw="SAVINGS WITHDRAWAL", category=groceries)
    make_txn(db, account=cc, posted_date=date(2026, 5, 11), amount_cents=-30000,
             description_raw="TARGET", category=groceries)
    # Only the credit-card charge counts.
    assert compute_trailing_real_outflow(db, today=TODAY) == 30000 * 30 // 90
