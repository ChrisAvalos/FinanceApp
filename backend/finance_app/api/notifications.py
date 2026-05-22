"""Notifications API — Phase 6.

GET    /notifications              list (filterable: only_unread)
POST   /notifications/{id}/read    mark one as read
POST   /notifications/read-all     mark all as read
POST   /notifications/clear-read   bulk-delete every already-read row
DELETE /notifications/{id}         delete one

Responses are augmented with two computed fields the UI relies on:

* ``category`` — coarse bucket derived from ``kind``. Lets the panel
  group rows into Security / Money / Opportunity / System sections
  without the frontend hard-coding a kind→bucket map.
* ``link`` — the section hash to drop the user into when they click
  the row (``#anomaly``, ``#savings``, ``#subscriptions``, etc).
  This is the single source of truth for click-to-drill behaviour;
  changing the routing destination of a kind only requires editing
  the table here, not every consumer.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from finance_app.db.models import Notification
from finance_app.db.session import get_db

router = APIRouter(prefix="/notifications", tags=["notifications"])


# ---------------------------------------------------------------------------
# Kind → (category, link) mapping
# ---------------------------------------------------------------------------
# Each producer writes a free-form ``kind`` string. The table below maps
# every shipped kind to a coarse category bucket and a section hash. Add
# new kinds at the bottom; unknown kinds default to "system" / no link.
#
# Categories chosen to match how a user mentally triages alerts:
#   - security      — fraud / unusual / unexpected charge — needs eyeballs
#   - money         — concrete dollars in or out (price hikes, low balance,
#                     goal milestones, score drops)
#   - opportunity   — discretionary actions that surface money on the table
#                     (offers expiring, claims with proof, deals)
#   - system        — app-internal status (sync errors, scheduler hiccups,
#                     auth-state expired). Lowest priority.
_KIND_META: dict[str, tuple[str, str | None]] = {
    # Anomaly + large-charge alerts → Anomaly panel
    "anomaly_flagged": ("security", "anomaly"),
    "large_charge_alert": ("security", "anomaly"),
    # Subscription price moved up → Subscriptions panel
    "subscription_price_up": ("money", "subscriptions"),
    "subscription_price_change": ("money", "subscriptions"),
    "free_trial_converting": ("opportunity", "subscriptions"),
    # Goal / savings milestones → Savings panel
    "goal_milestone": ("money", "savings"),
    "goal_completed": ("money", "savings"),
    # Cash-flow / balance warnings → Cash flow panel
    "low_balance_warn": ("security", "cashflow"),
    "upcoming_bill": ("money", "cashflow"),
    # Credit-related signals → Credit panel
    "credit_score_drop": ("money", "credit"),
    "credit_utilization_high": ("money", "credit"),
    "credit_score_new": ("money", "credit"),
    # Card-offer + redemption opportunities → Offers panel
    "offer_expiring": ("opportunity", "offers"),
    "offer_new": ("opportunity", "offers"),
    # Legal-claim opportunities → Claims panel
    "claim_new": ("opportunity", "claims"),
    "claim_deadline_soon": ("opportunity", "claims"),
    # Unclaimed-property / redress hits → MoneyOnTable panel
    "unclaimed_match": ("opportunity", "money-on-table"),
    "redress_match": ("opportunity", "money-on-table"),
    # Plaid / scraper auth issues → Connections panel
    "plaid_login_required": ("system", "connections"),
    "scraper_auth_missing": ("system", "connections"),
    # Backups / scheduler failures → no obvious panel; leave at system
    "scheduler_error": ("system", None),
    "backup_failed": ("system", None),
}


def _meta_for(kind: str) -> tuple[str, str | None]:
    """Return (category, link) for a given notification kind. Unknown
    kinds get the conservative default of ('system', None) — they still
    appear, they just don't get a colored badge or drill-in target."""
    return _KIND_META.get(kind, ("system", None))


class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    title: str
    body: str | None
    payload: dict | None
    is_read: bool
    created_at: datetime
    read_at: datetime | None
    # Computed fields. ``Field(default=...)`` so existing call sites that
    # pass an ORM Notification continue to validate; we fill these in
    # after-the-fact in the list endpoints.
    category: str = Field(default="system")
    link: str | None = Field(default=None)


def _hydrate(n: Notification) -> NotificationOut:
    """Build a NotificationOut from an ORM row, filling in derived fields."""
    out = NotificationOut.model_validate(n)
    cat, link = _meta_for(n.kind)
    out.category = cat
    out.link = link
    return out


@router.get("", response_model=list[NotificationOut])
def list_notifications(
    only_unread: bool = False,
    limit: int = 50,
    db: Session = Depends(get_db),
) -> list[NotificationOut]:
    stmt = select(Notification).order_by(Notification.created_at.desc()).limit(limit)
    if only_unread:
        stmt = stmt.where(Notification.is_read.is_(False))
    rows = list(db.execute(stmt).scalars().all())
    return [_hydrate(r) for r in rows]


@router.post("/{nid}/read", response_model=NotificationOut)
def mark_read(nid: int, db: Session = Depends(get_db)) -> NotificationOut:
    n = db.get(Notification, nid)
    if n is None:
        raise HTTPException(404, f"Notification {nid} not found")
    if not n.is_read:
        n.is_read = True
        n.read_at = datetime.utcnow()
        db.commit()
        db.refresh(n)
    return _hydrate(n)


@router.post("/read-all")
def mark_all_read(db: Session = Depends(get_db)) -> dict:
    res = db.execute(
        update(Notification)
        .where(Notification.is_read.is_(False))
        .values(is_read=True, read_at=datetime.utcnow())
    )
    db.commit()
    return {"marked_read": res.rowcount or 0}


@router.post("/clear-read")
def clear_read(db: Session = Depends(get_db)) -> dict:
    """Delete every notification that's already been marked read.

    Used by the panel's "Clear read" action — gives users a way to
    keep the list lean without clicking Delete one row at a time.
    Unread rows are never touched.
    """
    res = db.execute(delete(Notification).where(Notification.is_read.is_(True)))
    db.commit()
    return {"cleared": res.rowcount or 0}


@router.delete("/{nid}", status_code=204)
def delete_notification(nid: int, db: Session = Depends(get_db)) -> None:
    n = db.get(Notification, nid)
    if n is None:
        raise HTTPException(404, f"Notification {nid} not found")
    db.delete(n)
    db.commit()
