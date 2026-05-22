"""Accounts & institutions endpoints."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete, select, text
from sqlalchemy.orm import Session

from finance_app.api.schemas import (
    AccountIn,
    AccountOut,
    InstitutionIn,
    InstitutionOut,
)
from finance_app.db.models import (
    Account,
    BalanceSnapshot,
    Institution,
    PlaidItem,
    Subscription,
    Transaction,
)
from finance_app.db.session import get_db

router = APIRouter()


@router.get("/institutions", response_model=list[InstitutionOut], tags=["institutions"])
def list_institutions(db: Session = Depends(get_db)) -> list[Institution]:
    return db.execute(select(Institution).order_by(Institution.name)).scalars().all()


@router.post("/institutions", response_model=InstitutionOut, tags=["institutions"], status_code=201)
def create_institution(payload: InstitutionIn, db: Session = Depends(get_db)) -> Institution:
    existing = db.execute(
        select(Institution).where(Institution.name == payload.name)
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Institution '{payload.name}' exists")
    inst = Institution(**payload.model_dump())
    db.add(inst)
    db.commit()
    db.refresh(inst)
    return inst


@router.get("/accounts", response_model=list[AccountOut], tags=["accounts"])
def list_accounts(db: Session = Depends(get_db)) -> list[AccountOut]:
    # JOIN Institution so the UI can render "Chase · Sapphire Reserve"
    # instead of just "Sapphire Reserve" with no context. Single query
    # avoids N+1 lookups on accounts list pages.
    #
    # Wave 5 fix F (2026-05-14): also LEFT JOIN PlaidItem so we can
    # surface last_synced_at on each account for the freshness chip.
    # LEFT JOIN keeps manual/CSV accounts (no Plaid item) in the result.
    rows = db.execute(
        select(Account, Institution.name, PlaidItem.last_synced_at)
        .join(Institution, Institution.id == Account.institution_id)
        .join(PlaidItem, PlaidItem.id == Account.plaid_item_id, isouter=True)
        .order_by(Account.name)
    ).all()
    out: list[AccountOut] = []
    for acct, inst_name, last_synced in rows:
        base = AccountOut.model_validate(acct)
        out.append(
            base.model_copy(
                update={
                    "institution_name": inst_name,
                    "last_synced_at": last_synced,
                }
            )
        )
    return out


@router.post("/accounts", response_model=AccountOut, tags=["accounts"], status_code=201)
def create_account(payload: AccountIn, db: Session = Depends(get_db)) -> Account:
    if not db.get(Institution, payload.institution_id):
        raise HTTPException(404, f"Institution {payload.institution_id} not found")
    acct = Account(**payload.model_dump())
    db.add(acct)
    db.commit()
    db.refresh(acct)
    return acct


@router.get("/accounts/{account_id}", response_model=AccountOut, tags=["accounts"])
def get_account(account_id: int, db: Session = Depends(get_db)) -> AccountOut:
    acct = db.get(Account, account_id)
    if not acct:
        raise HTTPException(404, f"Account {account_id} not found")
    # Wave 5 fix F: enrich with freshness from the parent PlaidItem.
    last_synced = None
    if acct.plaid_item_id is not None:
        pi = db.get(PlaidItem, acct.plaid_item_id)
        if pi is not None:
            last_synced = pi.last_synced_at
    base = AccountOut.model_validate(acct)
    return base.model_copy(update={"last_synced_at": last_synced})


# ---------- Manual balance updates (Phase 7.1) ----------


class ManualBalanceIn(BaseModel):
    """Manual balance update for an account without an automated feed.

    Used for real_estate, vehicle, crypto, and any account the user
    wants to log themselves. Writes a BalanceSnapshot row AND updates
    the Account-side cache so the net-worth panel sees it immediately.
    """
    balance_cents: int
    as_of: date | None = None
    notes: str | None = None


@router.post(
    "/accounts/{account_id}/balance",
    status_code=201,
    tags=["accounts"],
)
def log_balance(
    account_id: int,
    body: ManualBalanceIn,
    db: Session = Depends(get_db),
) -> dict:
    """Record a manual balance update for an account."""
    from finance_app.networth import log_manual_balance
    try:
        snap = log_manual_balance(
            db,
            account_id=account_id,
            balance_cents=body.balance_cents,
            as_of=body.as_of,
            notes=body.notes,
        )
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    return {
        "id": snap.id,
        "account_id": snap.account_id,
        "as_of": snap.as_of.isoformat(),
        "balance_cents": snap.balance_cents,
        "source": snap.source.value,
    }


@router.delete("/accounts/{account_id}", status_code=204, tags=["accounts"])
def delete_account(account_id: int, db: Session = Depends(get_db)) -> None:
    """Delete an account and cascade to its hard dependents.

    SQLite doesn't enforce FK cascades by default, and our model relationships
    don't have ``cascade="all, delete-orphan"`` configured (intentional —
    accidental cascades on Plaid-linked accounts would be destructive).
    This endpoint does the manual cascade in one transaction so the UI's
    "remove this account" affordance leaves no orphans.

    Hard cascades (these tables have non-nullable account_id, must delete
    rows): transactions, balance_snapshots.

    Soft cascades (nullable FK — null out the reference instead of deleting
    the row): subscriptions, offers, ingest_batches, goals (both
    linked_account_id and linked_debt_account_id).

    Plaid-linked accounts: refuse delete here. Use DELETE /api/plaid/items/{id}
    to remove the whole Plaid Item, which cascades down through accounts.
    """
    acct = db.get(Account, account_id)
    if not acct:
        raise HTTPException(404, f"Account {account_id} not found")
    if acct.plaid_account_id:
        raise HTTPException(
            409,
            "Account is Plaid-linked. Delete via DELETE /api/plaid/items/{id}.",
        )
    # Run each cleanup in its own SAVEPOINT so a missing/renamed table
    # on a legacy DB doesn't roll back the whole transaction. Best-effort.
    cleanup_steps: list[tuple[str, callable]] = [
        ("transactions", lambda: db.execute(
            sa_delete(Transaction).where(Transaction.account_id == account_id)
        )),
        ("balance_snapshots", lambda: db.execute(
            sa_delete(BalanceSnapshot).where(BalanceSnapshot.account_id == account_id)
        )),
        ("subscriptions.account_id", lambda: db.execute(
            text("UPDATE subscriptions SET account_id = NULL WHERE account_id = :id"),
            {"id": account_id},
        )),
        ("offers.account_id", lambda: db.execute(
            text("UPDATE offers SET account_id = NULL WHERE account_id = :id"),
            {"id": account_id},
        )),
        ("ingest_batches.account_id", lambda: db.execute(
            text("UPDATE ingest_batches SET account_id = NULL WHERE account_id = :id"),
            {"id": account_id},
        )),
        ("goals.linked_account_id", lambda: db.execute(
            text("UPDATE goals SET linked_account_id = NULL WHERE linked_account_id = :id"),
            {"id": account_id},
        )),
        ("goals.linked_debt_account_id", lambda: db.execute(
            text(
                "UPDATE goals SET linked_debt_account_id = NULL "
                "WHERE linked_debt_account_id = :id"
            ),
            {"id": account_id},
        )),
    ]
    skipped: list[str] = []
    for label, op in cleanup_steps:
        try:
            with db.begin_nested():
                op()
        except Exception as exc:  # noqa: BLE001
            skipped.append(f"{label}: {type(exc).__name__}: {str(exc)[:120]}")
    try:
        db.delete(acct)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        raise HTTPException(
            500,
            f"Could not delete account {account_id}: "
            f"{type(exc).__name__}: {str(exc)[:200]}. "
            f"Cleanup steps that errored (best-effort skipped): {skipped}",
        ) from exc


@router.delete(
    "/institutions/{institution_id}", status_code=204, tags=["institutions"]
)
def delete_institution(institution_id: int, db: Session = Depends(get_db)) -> None:
    """Delete an institution. Refuses if any accounts still reference it."""
    inst = db.get(Institution, institution_id)
    if not inst:
        raise HTTPException(404, f"Institution {institution_id} not found")
    remaining = db.execute(
        select(Account).where(Account.institution_id == institution_id).limit(1)
    ).scalar_one_or_none()
    if remaining is not None:
        raise HTTPException(
            409,
            "Institution still has accounts. Delete the accounts first.",
        )
    db.delete(inst)
    db.commit()
