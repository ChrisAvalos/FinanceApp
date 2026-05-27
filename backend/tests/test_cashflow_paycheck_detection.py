"""Characterization tests for cash-flow paycheck detection.

Sprint O's last consistency gap: ``_infer_paycheck_cadence`` and
``_project_paychecks`` in ``cashflow/service.py`` used to join on the
``income.salary`` Category slug, while the rollup uses the canonical
``is_payroll(tx)`` description-based classifier. The mismatch meant an
uncategorized "LIVIO PAYROLL" wire would show on the budget rollup but
be INVISIBLE to the cash-flow forecast, drifting the two surfaces.

These tests pin the post-fix behavior so the regression cannot recur:

  1. ``test_uncategorized_payroll_is_detected_as_paycheck`` exercises
     the bug fix directly — payroll with no category MUST still drive
     paycheck projections.
  2. ``test_categorized_payroll_still_detected_as_paycheck`` is the
     regression guard — the previously-working categorized-payroll
     path must keep working after the fix.
"""
from __future__ import annotations

from datetime import date

from freezegun import freeze_time

from finance_app.cashflow.service import EventKind, build_forecast
from finance_app.db.models import AccountType

from factories import make_account, make_category, make_txn


FROZEN = "2026-05-31"
TODAY = date(2026, 5, 31)


def _seed_payroll_history(db, *, account, category=None):
    """Seed two trailing LIVIO PAYROLL inflows so the cadence inferrer
    has enough data points to project forward.

    The forecast's cadence inferrer requires at least two paychecks in
    the trailing 90-day window; semi-monthly detection further wants
    the cluster signature (mid-month + month-start). Seed both clusters.
    """
    # Mid-month cluster (the 15ths)
    make_txn(
        db,
        account=account,
        posted_date=date(2026, 4, 15),
        amount_cents=362000,
        description_raw="LIVIO PAYROLL",
        category=category,
    )
    make_txn(
        db,
        account=account,
        posted_date=date(2026, 5, 15),
        amount_cents=362000,
        description_raw="LIVIO PAYROLL",
        category=category,
    )
    # Month-start cluster (lands a few days early — late prior month)
    make_txn(
        db,
        account=account,
        posted_date=date(2026, 3, 31),
        amount_cents=362000,
        description_raw="LIVIO PAYROLL",
        category=category,
    )
    make_txn(
        db,
        account=account,
        posted_date=date(2026, 4, 30),
        amount_cents=362000,
        description_raw="LIVIO PAYROLL",
        category=category,
    )


@freeze_time(FROZEN)
def test_uncategorized_payroll_is_detected_as_paycheck(db):
    # Sprint O consistency: a LIVIO PAYROLL wire with NO category set
    # must still be picked up by the cash-flow forecast. Before the
    # fix, ``_infer_paycheck_cadence`` joined on the income.salary
    # Category slug and silently returned zero paychecks for this
    # scenario; the rollup would still show the income because IT uses
    # ``is_payroll(tx)``. The two surfaces drifted.
    chk = make_account(db, account_type=AccountType.checking)
    _seed_payroll_history(db, account=chk, category=None)

    f = build_forecast(db, days=30, today=TODAY)

    paycheck_events = [e for e in f.events if e.kind == EventKind.paycheck]
    assert paycheck_events, (
        "Expected at least one paycheck event for uncategorized LIVIO "
        f"PAYROLL inflows; got events={f.events}"
    )


@freeze_time(FROZEN)
def test_categorized_payroll_still_detected_as_paycheck(db):
    # Regression guard: the previously-working path (payroll txn with
    # category=income.salary) must keep producing paycheck events
    # after the classifier swap.
    chk = make_account(db, account_type=AccountType.checking)
    salary = make_category(db, name="Salary", slug="income.salary")
    _seed_payroll_history(db, account=chk, category=salary)

    f = build_forecast(db, days=30, today=TODAY)

    paycheck_events = [e for e in f.events if e.kind == EventKind.paycheck]
    assert paycheck_events, (
        "Expected at least one paycheck event for categorized LIVIO "
        f"PAYROLL inflows; got events={f.events}"
    )
