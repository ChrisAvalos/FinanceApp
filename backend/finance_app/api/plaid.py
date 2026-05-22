"""Plaid endpoints.

Sandbox flow end-to-end:

    1. GET  /plaid/status                    → tells the UI whether credentials
                                              are configured. Avoids the UI
                                              showing a Connect Bank button that
                                              will just explode.
    2. POST /plaid/link-token                → returns a short-lived link_token.
                                              The browser hands it to Plaid
                                              Link.
    3. POST /plaid/exchange {public_token}   → swap for access_token, persist a
                                              PlaidItem, mirror its Accounts.
    4. POST /plaid/sync/{item_id}            → pull new transactions for that
                                              item. No body.
    5. POST /plaid/sync-all                  → sync every non-error item.
    6. GET  /plaid/items                     → list connected items.
    7. DELETE /plaid/items/{item_id}         → forget a connection (local only;
                                              does NOT revoke on Plaid's side —
                                              we'll add /item/remove in a later
                                              pass).
    8. POST /plaid/sandbox/public-token     → sandbox-only convenience for the
                                              smoke test / manual QA.
"""
from __future__ import annotations

import logging
import traceback
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException

log = logging.getLogger(__name__)
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete as sa_delete, select, text
from sqlalchemy.orm import Session

from finance_app.config import settings
from finance_app.db.models import (
    Account,
    BalanceSnapshot,
    Institution,
    PlaidItem,
    PlaidItemStatus,
    Transaction,
)
from finance_app.db.session import get_db
from finance_app.ingestion.plaid_connector import PlaidClient, PlaidConnector
from finance_app.scheduler import start_scheduler

router = APIRouter(prefix="/plaid", tags=["plaid"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class PlaidStatus(BaseModel):
    configured: bool
    env: str
    client_id_present: bool
    secret_present: bool


class LinkTokenOut(BaseModel):
    link_token: str


class ExchangeIn(BaseModel):
    public_token: str = Field(..., description="One-time public_token from Plaid Link")


class PlaidItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    plaid_item_id: str
    institution_id: int
    plaid_institution_id: str | None
    # Friendly name from our Institution table (e.g. "Chase", "Albert").
    # Populated via JOIN in list_items. Optional because older clients
    # parsing the response don't have this field.
    institution_name: str | None = None
    status: PlaidItemStatus
    last_synced_at: datetime | None
    last_error: str | None
    granted_products: str | None
    created_at: datetime
    updated_at: datetime


class SyncResult(BaseModel):
    added: int = 0
    modified: int = 0
    removed: int = 0
    cursor_advanced: int = 0


class SyncAllResult(BaseModel):
    synced_at: str
    item_count: int
    items: dict[str, dict]


class ScheduleStatus(BaseModel):
    enabled: bool
    interval_hours: int
    next_run_time: datetime | None
    running: bool


class SandboxTokenIn(BaseModel):
    institution_id: str = "ins_109508"  # First Platypus Bank — default sandbox demo
    products: list[str] | None = None


class SandboxTokenOut(BaseModel):
    public_token: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_configured() -> None:
    if not settings.plaid_client_id or not settings.plaid_secret:
        raise HTTPException(
            503,
            "Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET in backend/.env.",
        )


def _connector(db: Session) -> PlaidConnector:
    _require_configured()
    try:
        return PlaidConnector(db, PlaidClient())
    except ImportError as exc:
        raise HTTPException(
            503,
            f"plaid-python is not installed: {exc}. Run `pip install plaid-python`.",
        ) from exc


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/status", response_model=PlaidStatus)
def plaid_status() -> PlaidStatus:
    return PlaidStatus(
        configured=bool(settings.plaid_client_id and settings.plaid_secret),
        env=settings.plaid_env,
        client_id_present=bool(settings.plaid_client_id),
        secret_present=bool(settings.plaid_secret),
    )


@router.post("/link-token", response_model=LinkTokenOut)
def create_link_token(db: Session = Depends(get_db)) -> LinkTokenOut:
    try:
        token = _connector(db).create_link_token()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — surface Plaid errors as 502
        raise HTTPException(502, f"Plaid link_token_create failed: {exc!r}") from exc
    return LinkTokenOut(link_token=token)


@router.post("/items/{item_id}/update-link-token", response_model=LinkTokenOut)
def create_update_link_token(
    item_id: int, db: Session = Depends(get_db)
) -> LinkTokenOut:
    """Sprint 42 — create a Plaid Link token in UPDATE MODE for an
    existing item.

    Used by the "Manage accounts" button on the Bank Connections
    panel: the user clicks it, the frontend gets this token, opens
    Plaid Link, which presents the account-selection screen pre-bound
    to the existing item. The user adds (or removes) accounts; on
    success the existing /sync flow picks them up via the
    accounts/get call that runs at the top of every sync.

    This is the fix path for users who initially shared only a subset
    of their accounts (e.g. only Albert Cash, missing Savings and
    Investing). Without it, the only way to add more accounts was to
    Remove + Re-add the whole item, which loses the auto-migration
    history and triggers a full transaction re-pull.
    """
    item = db.get(PlaidItem, item_id)
    if item is None:
        raise HTTPException(404, f"PlaidItem {item_id} not found")
    try:
        token = _connector(db).create_update_link_token(item)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            502, f"Plaid update-mode link_token_create failed: {exc!r}"
        ) from exc
    return LinkTokenOut(link_token=token)


@router.post("/exchange", response_model=PlaidItemOut)
def exchange_public_token(
    payload: ExchangeIn, db: Session = Depends(get_db)
) -> PlaidItem:
    try:
        item = _connector(db).register_item(payload.public_token)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        # Print the full traceback to the backend log so we can see WHICH
        # Plaid call inside register_item failed. Without this, the only
        # surface is the 502 body in the browser, which is easy to miss.
        tb = traceback.format_exc()
        log.error("Plaid public_token exchange failed:\n%s", tb)
        # Also dump to stderr in case logging isn't wired the way we expect.
        print("=" * 70, flush=True)
        print("PLAID EXCHANGE ERROR (this is what the 502 is hiding):", flush=True)
        print(tb, flush=True)
        print("=" * 70, flush=True)
        raise HTTPException(502, f"Plaid public_token exchange failed: {exc!r}") from exc
    return item


@router.get("/items", response_model=list[PlaidItemOut])
def list_items(db: Session = Depends(get_db)) -> list[PlaidItemOut]:
    # JOIN to Institution so the UI can render a friendly name ("Chase")
    # instead of the Plaid-side ID ("ins_56"). Doing this in the query
    # avoids N+1 lookups when there are many linked items.
    rows = db.execute(
        select(PlaidItem, Institution.name)
        .join(Institution, Institution.id == PlaidItem.institution_id)
        .order_by(PlaidItem.created_at.desc())
    ).all()
    out: list[PlaidItemOut] = []
    for item, inst_name in rows:
        # Build via from_attributes (the existing model_config), then
        # overlay the friendly institution_name field. Avoids leaking
        # SQLAlchemy's _sa_instance_state attribute through __dict__.
        base = PlaidItemOut.model_validate(item)
        out.append(base.model_copy(update={"institution_name": inst_name}))
    return out


@router.delete("/items/{item_id}", status_code=204)
def delete_item(item_id: int, db: Session = Depends(get_db)) -> None:
    """Forget a Plaid Item AND clean up its accounts.

    Without the cascade below, deleting a PlaidItem leaves Account rows
    orphaned (they have non-null plaid_item_id pointing at a now-gone
    item). When the user re-links the same institution later, those
    orphans collide with the new accounts on the
    ``uq_account_inst_name_mask`` UNIQUE constraint and the exchange
    fails with a 502 IntegrityError.

    Cascade strategy mirrors ``delete_account`` in accounts.py:
      - hard delete: transactions, balance_snapshots (non-nullable FK)
      - soft null: subscriptions, offers, ingest_batches, goals
        (nullable FK — null out, don't delete the row)
      - finally delete the Account itself, then the PlaidItem.
    """
    item = db.get(PlaidItem, item_id)
    if item is None:
        raise HTTPException(404, f"PlaidItem {item_id} not found")

    # Find every account tied to this item, then run the same
    # best-effort cascade we use in DELETE /api/accounts/{id}.
    account_ids = [
        a_id for (a_id,) in db.execute(
            select(Account.id).where(Account.plaid_item_id == item.id)
        ).all()
    ]
    skipped: list[str] = []
    for account_id in account_ids:
        cleanup_steps: list[tuple[str, callable]] = [
            ("transactions", lambda aid=account_id: db.execute(
                sa_delete(Transaction).where(Transaction.account_id == aid)
            )),
            ("balance_snapshots", lambda aid=account_id: db.execute(
                sa_delete(BalanceSnapshot).where(BalanceSnapshot.account_id == aid)
            )),
            ("subscriptions.account_id", lambda aid=account_id: db.execute(
                text("UPDATE subscriptions SET account_id = NULL WHERE account_id = :id"),
                {"id": aid},
            )),
            ("offers.account_id", lambda aid=account_id: db.execute(
                text("UPDATE offers SET account_id = NULL WHERE account_id = :id"),
                {"id": aid},
            )),
            ("ingest_batches.account_id", lambda aid=account_id: db.execute(
                text("UPDATE ingest_batches SET account_id = NULL WHERE account_id = :id"),
                {"id": aid},
            )),
            ("goals.linked_account_id", lambda aid=account_id: db.execute(
                text("UPDATE goals SET linked_account_id = NULL WHERE linked_account_id = :id"),
                {"id": aid},
            )),
            ("goals.linked_debt_account_id", lambda aid=account_id: db.execute(
                text(
                    "UPDATE goals SET linked_debt_account_id = NULL "
                    "WHERE linked_debt_account_id = :id"
                ),
                {"id": aid},
            )),
        ]
        for label, op in cleanup_steps:
            try:
                with db.begin_nested():
                    op()
            except Exception as exc:  # noqa: BLE001
                skipped.append(
                    f"acct={account_id} {label}: {type(exc).__name__}: {str(exc)[:120]}"
                )
        # Now delete the Account row itself
        try:
            with db.begin_nested():
                db.execute(sa_delete(Account).where(Account.id == account_id))
        except Exception as exc:  # noqa: BLE001
            skipped.append(
                f"acct={account_id} delete: {type(exc).__name__}: {str(exc)[:120]}"
            )

    try:
        db.delete(item)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        raise HTTPException(
            500,
            f"Could not delete PlaidItem {item_id}: "
            f"{type(exc).__name__}: {str(exc)[:200]}. Skipped steps: {skipped}",
        ) from exc
    if skipped:
        log.warning(
            "PlaidItem %s deleted with %d cleanup steps skipped: %s",
            item_id, len(skipped), skipped,
        )


@router.post("/sync/{item_id}", response_model=SyncResult)
def sync_item(item_id: int, db: Session = Depends(get_db)) -> SyncResult:
    item = db.get(PlaidItem, item_id)
    if item is None:
        raise HTTPException(404, f"PlaidItem {item_id} not found")
    try:
        counts = _connector(db).sync_transactions(item)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Plaid sync failed: {exc!r}") from exc
    return SyncResult(**counts)


@router.post("/sync-all", response_model=SyncAllResult)
def sync_all(db: Session = Depends(get_db)) -> SyncAllResult:
    try:
        result = _connector(db).sync_all()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Plaid sync-all failed: {exc!r}") from exc
    # Stringify any non-dict per-item entries defensively
    items = {str(k): (v if isinstance(v, dict) else {"raw": str(v)}) for k, v in result["items"].items()}
    return SyncAllResult(
        synced_at=result["synced_at"],
        item_count=result["item_count"],
        items=items,
    )


@router.get("/schedule", response_model=ScheduleStatus)
def scheduler_status() -> ScheduleStatus:
    """Report on the background refresh scheduler."""
    sched = start_scheduler()  # idempotent — returns running instance if any
    next_run: datetime | None = None
    running = False
    if sched is not None:
        running = sched.running
        job = sched.get_job("plaid-refresh")
        if job and job.next_run_time:
            # strip tzinfo for consistent JSON; APScheduler uses UTC tz-aware here
            next_run = job.next_run_time.replace(tzinfo=None)
    return ScheduleStatus(
        enabled=settings.plaid_refresh_enabled,
        interval_hours=settings.plaid_refresh_interval_hours,
        next_run_time=next_run,
        running=running,
    )


@router.post("/sandbox/public-token", response_model=SandboxTokenOut)
def sandbox_public_token(
    payload: SandboxTokenIn, db: Session = Depends(get_db)
) -> SandboxTokenOut:
    """Sandbox-only convenience. Mint a public_token without Plaid Link so you
    can drive the Exchange endpoint from curl or the smoke test.

    Returns 400 if you're not in sandbox env.
    """
    _require_configured()
    if settings.plaid_env != "sandbox":
        raise HTTPException(400, "sandbox_public_token_create only works in PLAID_ENV=sandbox")
    try:
        client = PlaidClient()
        token = client.sandbox_public_token_create(
            institution_id=payload.institution_id,
            products=payload.products,
        )
    except ImportError as exc:
        raise HTTPException(503, f"plaid-python not installed: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Plaid sandbox public token failed: {exc!r}") from exc
    return SandboxTokenOut(public_token=token)
