"""Net-worth math + helpers.

Public:

  * :func:`current_net_worth` — latest (assets, liabilities, net) tuple
    from the most recent BalanceSnapshot per account.
  * :func:`log_manual_balance` — record a balance update for an
    account that doesn't have an automated feed (real estate, vehicle,
    crypto wallet you self-report). Writes a BalanceSnapshot AND
    refreshes Account.current_balance_cents so the live snapshot can
    rely on the Account-side cache.
  * :func:`snapshot_net_worth` — persist today's NetWorthSnapshot row.
    Idempotent: re-running the same day overwrites that day's row
    (we want one row per calendar day, latest values win).

Sign convention reminder
------------------------
``Account.current_balance_cents`` holds the SIGNED balance:
  - Assets (checking, savings, investment, real_estate, vehicle, crypto, hsa,
    cash) — positive value means money you have.
  - Liabilities (credit_card, loan, mortgage) — positive value means
    money you OWE. We subtract these to get net worth.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db.models import (
    Account,
    AccountType,
    BalanceSnapshot,
    IngestSource,
    NetWorthSnapshot,
)


class AccountKind(str, Enum):
    """Coarse asset/liability/excluded classification of an account."""
    asset = "asset"
    liability = "liability"
    excluded = "excluded"  # cash with no logged balance, "other" we don't want in net worth


# Map AccountType → AccountKind. Centralized so we never drift.
_TYPE_TO_KIND: dict[AccountType, AccountKind] = {
    AccountType.checking: AccountKind.asset,
    AccountType.savings: AccountKind.asset,
    AccountType.investment: AccountKind.asset,
    AccountType.cash: AccountKind.asset,
    AccountType.real_estate: AccountKind.asset,
    AccountType.vehicle: AccountKind.asset,
    AccountType.crypto: AccountKind.asset,
    AccountType.hsa: AccountKind.asset,
    AccountType.credit_card: AccountKind.liability,
    AccountType.loan: AccountKind.liability,
    AccountType.mortgage: AccountKind.liability,
    AccountType.other: AccountKind.excluded,
}


def classify_account(account: Account) -> AccountKind:
    return _TYPE_TO_KIND.get(account.account_type, AccountKind.excluded)


@dataclass
class NetWorthBreakdown:
    """Per-account-type rollup."""
    account_type: str
    kind: str  # "asset" | "liability"
    total_cents: int
    accounts: int


@dataclass
class NetWorthSummary:
    """Top-level numbers for the dashboard tile."""
    as_of: date
    assets_cents: int
    liabilities_cents: int
    net_cents: int
    breakdown: list[NetWorthBreakdown] = field(default_factory=list)
    accounts_with_no_balance: int = 0  # informational — accounts we couldn't include


def _latest_balance_per_account(db: Session) -> dict[int, int]:
    """Return account_id → latest BalanceSnapshot.balance_cents.

    Falls back to Account.current_balance_cents when no BalanceSnapshot
    exists (e.g. credit cards where Account is the source of truth, or
    a brand-new manual asset that hasn't been logged yet).
    """
    # Subquery: max(as_of) per account
    subq = (
        select(
            BalanceSnapshot.account_id,
            func.max(BalanceSnapshot.as_of).label("latest_as_of"),
        )
        .group_by(BalanceSnapshot.account_id)
        .subquery()
    )
    rows = db.execute(
        select(BalanceSnapshot.account_id, BalanceSnapshot.balance_cents)
        .join(
            subq,
            (BalanceSnapshot.account_id == subq.c.account_id)
            & (BalanceSnapshot.as_of == subq.c.latest_as_of),
        )
    ).all()
    by_account = {r.account_id: int(r.balance_cents or 0) for r in rows}
    return by_account


def current_net_worth(db: Session, *, today: date | None = None) -> NetWorthSummary:
    """Compute the live net-worth summary across every linked account.

    Follow-up (2026-05-14): filter inactive accounts (Stock Plan TSLA
    was flipped after Wave 5 fix D and was showing as ghost row in the
    breakdown with `investment: 3` when only 2 are truly active).
    """
    today = today or date.today()
    accounts = list(
        db.execute(select(Account).where(Account.is_active.is_(True))).scalars().all()
    )
    latest = _latest_balance_per_account(db)

    by_type: dict[AccountType, dict] = {}
    assets = 0
    liabilities = 0
    no_balance = 0

    for a in accounts:
        kind = classify_account(a)
        if kind == AccountKind.excluded:
            continue
        # Prefer a logged BalanceSnapshot; fall back to the Account-side
        # cache (current_balance_cents) for cards / freshly-linked items.
        bal = latest.get(a.id)
        if bal is None:
            bal = a.current_balance_cents
        if bal is None:
            no_balance += 1
            continue
        bucket = by_type.setdefault(
            a.account_type,
            {"kind": kind.value, "total_cents": 0, "accounts": 0},
        )
        bucket["total_cents"] += int(bal)
        bucket["accounts"] += 1
        if kind == AccountKind.asset:
            assets += int(bal)
        else:
            liabilities += int(bal)

    breakdown = [
        NetWorthBreakdown(
            account_type=t.value,
            kind=v["kind"],
            total_cents=v["total_cents"],
            accounts=v["accounts"],
        )
        for t, v in sorted(by_type.items(), key=lambda x: -x[1]["total_cents"])
    ]
    return NetWorthSummary(
        as_of=today,
        assets_cents=assets,
        liabilities_cents=liabilities,
        # liabilities is the *signed* sum across debt accounts (negative
        # because credit-card balances are stored as e.g. -1200). To get
        # net worth we ADD that signed value to assets, which correctly
        # subtracts the debt. The earlier `assets - liabilities` was a
        # sign bug — it added the debt back, inflating net worth by 2x
        # the debt amount. Smoke_phase_7 caught this.
        net_cents=assets + liabilities,
        breakdown=breakdown,
        accounts_with_no_balance=no_balance,
    )


def log_manual_balance(
    db: Session,
    *,
    account_id: int,
    balance_cents: int,
    as_of: date | None = None,
    notes: str | None = None,
) -> BalanceSnapshot:
    """Append a manual BalanceSnapshot AND update Account-side cache.

    Used for real_estate, vehicle, crypto, and any account without a
    Plaid feed. The unique constraint on
    (account_id, as_of, source=manual) means re-logging the same day
    overwrites; that's intentional — the user adjusts a guess.
    """
    as_of = as_of or date.today()
    acct = db.get(Account, account_id)
    if acct is None:
        raise ValueError(f"Account {account_id} not found")

    # Replace any existing manual snapshot for this (account, day).
    existing = db.execute(
        select(BalanceSnapshot)
        .where(BalanceSnapshot.account_id == account_id)
        .where(BalanceSnapshot.as_of == as_of)
        .where(BalanceSnapshot.source == IngestSource.manual)
        .limit(1)
    ).scalar_one_or_none()
    if existing is not None:
        existing.balance_cents = balance_cents
        snap = existing
    else:
        snap = BalanceSnapshot(
            account_id=account_id,
            as_of=as_of,
            balance_cents=balance_cents,
            available_cents=None,
            source=IngestSource.manual,
        )
        db.add(snap)

    # Account-side cache so current_net_worth() can fall back fast.
    # For credit cards, current_balance_cents is the live live-balance;
    # we honor the same field for assets going forward.
    acct.current_balance_cents = balance_cents
    db.commit()
    db.refresh(snap)
    return snap


def snapshot_net_worth(db: Session, *, as_of: date | None = None) -> NetWorthSnapshot:
    """Persist (or replace) today's NetWorthSnapshot row.

    Called by the daily scheduler job. Idempotent — running twice in
    one day produces one row, not two; we want exactly one observation
    per calendar day for clean charting.
    """
    as_of = as_of or date.today()
    summary = current_net_worth(db, today=as_of)
    breakdown_dict = {
        b.account_type: {
            "kind": b.kind,
            "total_cents": b.total_cents,
            "accounts": b.accounts,
        }
        for b in summary.breakdown
    }
    existing = db.execute(
        select(NetWorthSnapshot).where(NetWorthSnapshot.as_of == as_of).limit(1)
    ).scalar_one_or_none()
    if existing is not None:
        existing.assets_cents = summary.assets_cents
        existing.liabilities_cents = summary.liabilities_cents
        existing.net_cents = summary.net_cents
        existing.breakdown = breakdown_dict
        snap = existing
    else:
        snap = NetWorthSnapshot(
            as_of=as_of,
            assets_cents=summary.assets_cents,
            liabilities_cents=summary.liabilities_cents,
            net_cents=summary.net_cents,
            breakdown=breakdown_dict,
        )
        db.add(snap)
    db.commit()
    db.refresh(snap)
    return snap
