"""Characterization tests for the Plaid ingest sign-flip + fuzzy dedup.

Two things are pinned here:

1. The amount sign convention. Plaid's API uses "positive = money out of
   the account"; the app negates it, so in Transaction.amount_cents an
   outflow is NEGATIVE and an inflow POSITIVE.
2. The fuzzy dedup. Plaid issues new transaction_ids on item re-link and
   on pending->posted transitions; the dedup collapses those onto the
   existing row by matching (account, date, amount, merchant token).
   A regression here silently doubles or merges real transactions.
"""
from __future__ import annotations

from datetime import date

import pytest
from sqlalchemy import select

from finance_app.db.models import AccountType, IngestSource, Transaction
from finance_app.ingestion.plaid_connector import PlaidConnector
from finance_app.util.txn_dedup import merchant_group_key, merchant_token

from factories import make_account, make_plaid_item, make_txn


# ----------------------------------------- merchant_token (pure helper)


@pytest.mark.parametrize(
    "description,expected",
    [
        ("APPLE.COM/BILL CA 04/28", "APPLE.COM/BILL"),
        ("POS DEBIT APPLE.COM/BILL", "APPLE.COM/BILL"),
        ("Dave Inc dave.com 04/10", "DAVE"),
        ("POS DEBIT", ""),
        ("", ""),
        ("04/28 12.99", ""),
    ],
)
def test_merchant_token(description, expected):
    assert merchant_token(description) == expected


def test_merchant_group_key_stable_across_charge_tails(db):
    a = merchant_group_key("MOVEMENT MOUNTAIN VIE CA 05/01")
    b = merchant_group_key("MOVEMENT MOUNTAIN VI WWW.MOVEMENTG CO 04/01")
    assert a == b == "MOVEMENT MOUNTAIN"


# ----------------------------------------------------- amount sign flip


def _plaid_txn(**overrides):
    """A minimal raw-Plaid transaction dict."""
    base = {
        "account_id": "plaid-acct-1",
        "transaction_id": "ext-A",
        "amount": 12.34,
        "name": "WHOLE FOODS MARKET",
        "authorized_date": "2026-05-10",
        "pending": False,
        "iso_currency_code": "USD",
    }
    base.update(overrides)
    return base


def _connector(db):
    # client is never touched by _upsert_txn; a sentinel avoids
    # constructing a real PlaidClient (which would need network config).
    return PlaidConnector(db, client=object())


def test_plaid_positive_amount_becomes_negative_outflow(db):
    acct = make_account(db, account_type=AccountType.checking,
                        plaid_account_id="plaid-acct-1")
    item = make_plaid_item(db)
    _connector(db)._upsert_txn(
        item,
        _plaid_txn(amount=12.34, transaction_id="t1"),
        {"plaid-acct-1": acct.id},
        is_modified=False,
    )
    txn = db.execute(select(Transaction)).scalars().one()
    assert txn.amount_cents == -1234  # Plaid +12.34 (money out) -> -1234


def test_plaid_negative_amount_becomes_positive_inflow(db):
    acct = make_account(db, account_type=AccountType.checking,
                        plaid_account_id="plaid-acct-1")
    item = make_plaid_item(db)
    _connector(db)._upsert_txn(
        item,
        _plaid_txn(amount=-50.0, transaction_id="t2", name="PAYROLL DEPOSIT"),
        {"plaid-acct-1": acct.id},
        is_modified=False,
    )
    txn = db.execute(select(Transaction)).scalars().one()
    assert txn.amount_cents == 5000  # Plaid -50.00 (money in) -> +5000


# ------------------------------------------------------- fuzzy dedup


def test_fuzzy_dedup_merges_same_merchant_new_external_id(db):
    # An already-synced Plaid row...
    acct = make_account(db, account_type=AccountType.checking,
                        plaid_account_id="plaid-acct-1")
    item = make_plaid_item(db)
    make_txn(db, account=acct, posted_date=date(2026, 5, 10), amount_cents=-1234,
             description_raw="POS DEBIT APPLE.COM/BILL",
             source=IngestSource.plaid, external_id="old-ext")
    # ...re-synced under a NEW external_id, cleaner description, same
    # account/date/amount and same merchant token (APPLE.COM/BILL).
    _connector(db)._upsert_txn(
        item,
        _plaid_txn(account_id="plaid-acct-1", transaction_id="new-ext",
                   amount=12.34, name="APPLE.COM/BILL CA",
                   authorized_date="2026-05-10"),
        {"plaid-acct-1": acct.id},
        is_modified=False,
    )
    txns = db.execute(select(Transaction)).scalars().all()
    assert len(txns) == 1                     # merged, not duplicated
    assert txns[0].external_id == "new-ext"   # adopted the new id


def test_no_dedup_when_amount_differs(db):
    acct = make_account(db, account_type=AccountType.checking,
                        plaid_account_id="plaid-acct-1")
    item = make_plaid_item(db)
    make_txn(db, account=acct, posted_date=date(2026, 5, 10), amount_cents=-1234,
             description_raw="APPLE.COM/BILL",
             source=IngestSource.plaid, external_id="old-ext")
    # Same merchant + date but a different amount -> a distinct charge.
    _connector(db)._upsert_txn(
        item,
        _plaid_txn(account_id="plaid-acct-1", transaction_id="new-ext",
                   amount=99.99, name="APPLE.COM/BILL CA",
                   authorized_date="2026-05-10"),
        {"plaid-acct-1": acct.id},
        is_modified=False,
    )
    txns = db.execute(select(Transaction)).scalars().all()
    assert len(txns) == 2


def test_no_dedup_when_merchant_token_differs(db):
    acct = make_account(db, account_type=AccountType.checking,
                        plaid_account_id="plaid-acct-1")
    item = make_plaid_item(db)
    make_txn(db, account=acct, posted_date=date(2026, 5, 10), amount_cents=-1234,
             description_raw="APPLE.COM/BILL",
             source=IngestSource.plaid, external_id="old-ext")
    # Same account/date/amount but a different merchant -> not a dup
    # (this is the coincidence the dedup deliberately does NOT merge).
    _connector(db)._upsert_txn(
        item,
        _plaid_txn(account_id="plaid-acct-1", transaction_id="new-ext",
                   amount=12.34, name="STARBUCKS STORE 123",
                   authorized_date="2026-05-10"),
        {"plaid-acct-1": acct.id},
        is_modified=False,
    )
    txns = db.execute(select(Transaction)).scalars().all()
    assert len(txns) == 2
