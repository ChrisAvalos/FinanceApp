"""Characterization tests for the assignment-ledger endpoint (api/budgets.py).

Pins Sprint L's zero-based ledger behavior before the planned split of
budgets.py — so the refactor cannot silently change the numbers the UI
relies on.

All tests freeze time so the underlying compute_month_income and pace
math are deterministic regardless of the real clock.
"""
from __future__ import annotations

from datetime import date

from freezegun import freeze_time

from finance_app.api.budgets import assignment_ledger
from finance_app.db.models import AccountType

from factories import make_account, make_budget, make_category, make_txn

MONTH = date(2026, 5, 1)
FROZEN = "2026-05-31"


@freeze_time(FROZEN)
def test_ledger_returns_response_for_the_month(db):
    resp = assignment_ledger(month_start=MONTH, db=db)
    assert resp.month_start == MONTH
    assert isinstance(resp.groups, list)


@freeze_time(FROZEN)
def test_ledger_zero_based_identity(db):
    # The headline invariant: unassigned = income - total_planned (where
    # total_planned excludes the unbudgeted_actual pseudo-group).
    chk = make_account(db, account_type=AccountType.checking)
    make_txn(db, account=chk, posted_date=date(2026, 5, 15), amount_cents=362000,
             description_raw="LIVIO PAYROLL")
    rent = make_category(db, name="Rent", is_discretionary=False)
    make_budget(db, category=rent, month_start=MONTH, amount_cents=200000)
    food = make_category(db, name="Groceries", is_discretionary=True)
    make_budget(db, category=food, month_start=MONTH, amount_cents=50000)
    resp = assignment_ledger(month_start=MONTH, db=db)
    assert resp.unassigned_cents == resp.income_cents - resp.total_planned_cents


@freeze_time(FROZEN)
def test_ledger_groups_in_fixed_kind_order(db):
    chk = make_account(db, account_type=AccountType.checking)
    rent = make_category(db, name="Rent", is_discretionary=False)
    food = make_category(db, name="Groceries", is_discretionary=True)
    make_budget(db, category=rent, month_start=MONTH, amount_cents=200000)
    make_budget(db, category=food, month_start=MONTH, amount_cents=50000)
    # A discretionary category with spend but no budget — populates the
    # unbudgeted_actual group.
    coffee = make_category(db, name="Coffee", is_discretionary=True)
    make_txn(db, account=chk, posted_date=date(2026, 5, 10), amount_cents=-1500,
             description_raw="STARBUCKS", category=coffee)
    resp = assignment_ledger(month_start=MONTH, db=db)
    # Kinds present must be in the canonical order: committed, variable,
    # savings, debt, then unbudgeted_actual.
    canonical = ["committed", "variable", "savings", "debt", "unbudgeted_actual"]
    indices = [canonical.index(g.kind) for g in resp.groups]
    assert indices == sorted(indices)


@freeze_time(FROZEN)
def test_ledger_skips_catchall_categories(db):
    # Transfer / Uncategorized / Credit Card Payment / Investment
    # Contribution categories represent money movement, not spend — the
    # ledger must filter them out (via is_catchall) so they don't inflate
    # any group's actual_cents.
    chk = make_account(db, account_type=AccountType.checking)
    transfer = make_category(db, name="Transfer")
    make_txn(db, account=chk, posted_date=date(2026, 5, 10), amount_cents=-30000,
             description_raw="MOVE TO SAVINGS", category=transfer)
    resp = assignment_ledger(month_start=MONTH, db=db)
    all_cat_ids = {item.category_id for g in resp.groups for item in g.items}
    assert transfer.id not in all_cat_ids


@freeze_time(FROZEN)
def test_ledger_capped_category_with_zero_spend_still_appears(db):
    # A Budget that nobody has spent against this month should still show
    # up as a row in its group, with planned=cap and actual=0 — so the
    # UI surfaces "you committed to this but haven't acted yet."
    rent = make_category(db, name="Rent", is_discretionary=False)
    make_budget(db, category=rent, month_start=MONTH, amount_cents=200000)
    resp = assignment_ledger(month_start=MONTH, db=db)
    committed = next(g for g in resp.groups if g.kind == "committed")
    row = next(item for item in committed.items if item.category_id == rent.id)
    assert row.planned_cents == 200000
    assert row.actual_cents == 0


@freeze_time(FROZEN)
def test_ledger_history_has_three_prior_months(db):
    # The drift strip shows the three months immediately before
    # month_start; even on an empty DB the list has exactly 3 entries.
    resp = assignment_ledger(month_start=MONTH, db=db)
    assert len(resp.history) == 3
