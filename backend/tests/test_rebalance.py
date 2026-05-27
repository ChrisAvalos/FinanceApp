"""Characterization tests for the rebalance-suggestions endpoint.

Pins the three behavioral branches (neutral / surplus / deficit) and the
fact that unassigned_cents tracks the ledger's identically — so the
upcoming split of budgets.py can't silently change what the rebalance
modal shows.
"""
from __future__ import annotations

from datetime import date

from freezegun import freeze_time

from finance_app.api.budgets import assignment_ledger, rebalance_suggestions
from finance_app.db.models import AccountType

from factories import make_account, make_budget, make_category, make_txn

MONTH = date(2026, 5, 1)
FROZEN = "2026-05-31"


@freeze_time(FROZEN)
def test_neutral_balance_returns_empty_suggestions(db):
    # No income, no budgets -> unassigned ≈ 0 -> falls inside the
    # |unassigned| < $25 dead-zone -> no suggestions.
    resp = rebalance_suggestions(month_start=MONTH, db=db)
    assert resp.month_start == MONTH
    assert resp.unassigned_cents == 0
    assert resp.suggestions == []


@freeze_time(FROZEN)
def test_surplus_path_always_includes_hold_suggestion(db):
    # One paycheck and no budgets -> a large positive unassigned. The
    # surplus path always emits the "hold as buffer" option among the
    # ranked suggestions.
    chk = make_account(db, account_type=AccountType.checking)
    make_txn(db, account=chk, posted_date=date(2026, 5, 15), amount_cents=362000,
             description_raw="LIVIO PAYROLL")
    resp = rebalance_suggestions(month_start=MONTH, db=db)
    assert resp.unassigned_cents > 2500
    kinds = [s.kind for s in resp.suggestions]
    assert "hold" in kinds


@freeze_time(FROZEN)
def test_deficit_path_returns_single_trim_suggestion(db):
    # No income but a real Budget -> unassigned is sharply negative ->
    # one trim-deficit suggestion with no apply payload.
    cat = make_category(db, name="Rent", is_discretionary=False)
    make_budget(db, category=cat, month_start=MONTH, amount_cents=500000)
    resp = rebalance_suggestions(month_start=MONTH, db=db)
    assert resp.unassigned_cents <= -2500
    assert len(resp.suggestions) == 1
    only = resp.suggestions[0]
    assert only.kind == "trim_deficit"
    assert only.apply is None


@freeze_time(FROZEN)
def test_rebalance_unassigned_tracks_ledger(db):
    # Both endpoints compute unassigned the same way; if they ever drift
    # the UI would show contradictory numbers across the two cards.
    chk = make_account(db, account_type=AccountType.checking)
    make_txn(db, account=chk, posted_date=date(2026, 5, 15), amount_cents=362000,
             description_raw="LIVIO PAYROLL")
    cat = make_category(db, name="Groceries", is_discretionary=True)
    make_budget(db, category=cat, month_start=MONTH, amount_cents=50000)
    lr = assignment_ledger(month_start=MONTH, db=db)
    rr = rebalance_suggestions(month_start=MONTH, db=db)
    assert rr.unassigned_cents == lr.unassigned_cents
