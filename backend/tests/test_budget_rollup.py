"""Characterization tests for the budget rollup endpoint (api/budgets.py).

`rollup(month_start, db)` is the most-changed function in the app and
lives in a 2,500-line file. It also reads "today" from the system clock,
so every test freezes time to keep the figures deterministic.

These tests pin the load-bearing behavior: the response shape, that
income is sourced from monthly_financials (the Sprint O wiring), that
spending aggregates into the right budget row, and that catch-all
categories are kept out of the "real" budget headline.
"""
from __future__ import annotations

from datetime import date

from freezegun import freeze_time

from finance_app.api.budgets import rollup
from finance_app.budgets.monthly_financials import compute_month_income
from finance_app.db.models import AccountType

from factories import make_account, make_budget, make_category, make_txn

MONTH = date(2026, 5, 1)
FROZEN = "2026-05-31"


@freeze_time(FROZEN)
def test_rollup_returns_response_for_the_month(db):
    resp = rollup(month_start=MONTH, db=db)
    assert resp.month_start == MONTH
    assert isinstance(resp.rows, list)


@freeze_time(FROZEN)
def test_rollup_income_is_sourced_from_monthly_financials(db):
    chk = make_account(db, account_type=AccountType.checking)
    make_txn(db, account=chk, posted_date=date(2026, 5, 15), amount_cents=362000,
             description_raw="LIVIO PAYROLL")
    resp = rollup(month_start=MONTH, db=db)
    mi = compute_month_income(db, MONTH)
    # The rollup must not re-derive income — it reads monthly_financials.
    assert resp.monthly_income_cents == mi.all_inflow_avg_cents
    assert resp.recurring_income_cents == mi.recurring_avg_cents
    assert resp.month_income_landed_cents == mi.landed_cents


@freeze_time(FROZEN)
def test_rollup_aggregates_spend_into_its_budget_row(db):
    chk = make_account(db, account_type=AccountType.checking)
    groceries = make_category(db, name="Groceries")
    make_budget(db, category=groceries, month_start=MONTH, amount_cents=50000)
    make_txn(db, account=chk, posted_date=date(2026, 5, 10), amount_cents=-12000,
             description_raw="WHOLE FOODS", category=groceries)
    resp = rollup(month_start=MONTH, db=db)
    row = next(r for r in resp.rows if r.category_id == groceries.id)
    assert row.budget_cents == 50000
    # actual_outflow_cents is the positive "how much went out".
    assert row.actual_outflow_cents == 12000


@freeze_time(FROZEN)
def test_rollup_keeps_catchall_out_of_real_budget(db):
    groceries = make_category(db, name="Groceries")
    transfer = make_category(db, name="Transfer")  # a catch-all bucket
    make_budget(db, category=groceries, month_start=MONTH, amount_cents=50000)
    make_budget(db, category=transfer, month_start=MONTH, amount_cents=100000)
    resp = rollup(month_start=MONTH, db=db)
    # Both caps land in total_budget...
    assert resp.total_budget_cents == 150000
    # ...but the catch-all is excluded from the "real" budget headline.
    assert resp.real_budget_cents == 50000
