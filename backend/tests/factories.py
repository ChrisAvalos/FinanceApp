"""Seed-data factories for tests.

Small helpers that insert the minimum valid row for each model and
return it flushed (so its primary key is populated). Every factory
takes the test `db` session as its first argument.
"""
from __future__ import annotations

from datetime import date

from finance_app.db.models import (
    Account,
    AccountType,
    Budget,
    Category,
    IngestSource,
    Institution,
    PlaidItem,
    Transaction,
    TransactionStatus,
)

# Monotonic counter so auto-generated unique fields (slugs, external_ids,
# institution names) never collide within a test run.
_seq = {"n": 0}


def _n() -> int:
    _seq["n"] += 1
    return _seq["n"]


def make_institution(db, name: str | None = None) -> Institution:
    inst = Institution(name=name or f"Institution {_n()}")
    db.add(inst)
    db.flush()
    return inst


def make_account(
    db,
    *,
    account_type: AccountType = AccountType.checking,
    name: str | None = None,
    institution: Institution | None = None,
    current_balance_cents: int | None = None,
    plaid_account_id: str | None = None,
    is_active: bool = True,
) -> Account:
    if institution is None:
        institution = make_institution(db)
    acct = Account(
        institution_id=institution.id,
        name=name or f"Account {_n()}",
        account_type=account_type,
        is_active=is_active,
        current_balance_cents=current_balance_cents,
        plaid_account_id=plaid_account_id,
    )
    db.add(acct)
    db.flush()
    return acct


def make_category(
    db,
    *,
    name: str,
    slug: str | None = None,
    is_discretionary: bool = True,
    parent_id: int | None = None,
) -> Category:
    cat = Category(
        name=name,
        slug=slug or f"{name.lower().replace(' ', '-')}-{_n()}",
        is_discretionary=is_discretionary,
        parent_id=parent_id,
    )
    db.add(cat)
    db.flush()
    return cat


def make_txn(
    db,
    *,
    account: Account,
    posted_date: date,
    amount_cents: int,
    description_raw: str = "TEST TXN",
    description_clean: str | None = None,
    memo: str | None = None,
    category: Category | None = None,
    is_one_time: bool = False,
    source: IngestSource = IngestSource.manual,
    external_id: str | None = None,
    status: TransactionStatus = TransactionStatus.posted,
) -> Transaction:
    txn = Transaction(
        account_id=account.id,
        posted_date=posted_date,
        amount_cents=amount_cents,
        description_raw=description_raw,
        description_clean=description_clean,
        memo=memo,
        category_id=category.id if category is not None else None,
        is_one_time=is_one_time,
        source=source,
        external_id=external_id or f"ext-{_n()}",
        status=status,
    )
    db.add(txn)
    db.flush()
    return txn


def make_budget(
    db,
    *,
    category: Category,
    month_start: date,
    amount_cents: int,
    rollover: bool = False,
) -> Budget:
    b = Budget(
        category_id=category.id,
        month_start=month_start,
        amount_cents=amount_cents,
        rollover=rollover,
    )
    db.add(b)
    db.flush()
    return b


def make_plaid_item(
    db,
    *,
    institution: Institution | None = None,
    plaid_item_id: str | None = None,
    access_token: str = "test-access-token",
) -> PlaidItem:
    if institution is None:
        institution = make_institution(db)
    item = PlaidItem(
        institution_id=institution.id,
        plaid_item_id=plaid_item_id or f"plaid-item-{_n()}",
        access_token=access_token,
    )
    db.add(item)
    db.flush()
    return item
