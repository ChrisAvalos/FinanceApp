"""Anomaly / unusual-transaction detection — Phase 9.3.

GET /anomaly/scan?days=90&threshold_sigma=3   detect outliers
GET /anomaly/scan?fire_notifications=true     scan + create Notification rows

Method: per-category statistical baseline over the trailing window;
flag any transaction with abs(amount) > mean + N*stddev. Default N=3
catches ~0.3% of normally-distributed spend (≈ 3 events per 1k txns
which matches the user's perception of "rare large purchase").

Categories with fewer than 5 transactions in the window get a
fallback rule: flag any txn > 3× the median of the rest. Avoids
false positives in tiny categories.
"""
from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import Category, Notification, Transaction
from finance_app.db.session import get_db


router = APIRouter(prefix="/anomaly", tags=["anomaly"])


class AnomalyOut(BaseModel):
    transaction_id: int
    posted_date: date
    description: str
    amount_cents: int
    category_id: int | None
    category_name: str | None
    baseline_mean_cents: int
    baseline_stddev_cents: int
    sigma: float  # how many stddevs away
    rationale: str


class AnomalyScanOut(BaseModel):
    window_start: date
    window_end: date
    threshold_sigma: float
    transactions_scanned: int
    anomalies: list[AnomalyOut]
    notifications_created: int
    # Server-side scan timestamp — drives the SyncFreshnessChip on the
    # Unusual Transactions panel.
    generated_at: datetime | None = None


@router.get("/scan", response_model=AnomalyScanOut)
def scan(
    days: int = Query(90, ge=7, le=730),
    threshold_sigma: float = Query(3.0, ge=1.5, le=10.0),
    fire_notifications: bool = False,
    db: Session = Depends(get_db),
) -> AnomalyScanOut:
    """Scan trailing N days for unusual transactions.

    Statistical baseline per category. Returns anomalies sorted by
    sigma desc. If ``fire_notifications=true``, also creates
    Notification rows so the user sees them in the dashboard alerts
    panel.
    """
    today = date.today()
    start = today - timedelta(days=days)

    rows = list(
        db.execute(
            select(Transaction)
            .where(Transaction.posted_date >= start)
            .where(Transaction.posted_date <= today)
            .where(Transaction.amount_cents < 0)  # outflows only
        ).scalars().all()
    )
    cat_names = {c.id: c.name for c in db.execute(select(Category)).scalars().all()}

    # Group by category
    by_cat: dict[int | None, list[Transaction]] = defaultdict(list)
    for t in rows:
        by_cat[t.category_id].append(t)

    anomalies: list[AnomalyOut] = []
    for cid, txns in by_cat.items():
        if len(txns) < 5:
            # Tiny category — fallback to "3× median of the rest"
            for t in txns:
                others = [-x.amount_cents for x in txns if x.id != t.id]
                if not others:
                    continue
                med = statistics.median(others)
                if med <= 0:
                    continue
                ratio = -t.amount_cents / med
                if ratio < 3.0:
                    continue
                anomalies.append(
                    AnomalyOut(
                        transaction_id=t.id,
                        posted_date=t.posted_date,
                        description=t.description_raw or "",
                        amount_cents=t.amount_cents,
                        category_id=cid,
                        category_name=cat_names.get(cid),
                        baseline_mean_cents=int(med),
                        baseline_stddev_cents=0,
                        sigma=ratio,
                        rationale=f"{ratio:.1f}× the median of {len(txns)-1} other recent txns in this category",
                    )
                )
            continue
        amounts = [-t.amount_cents for t in txns]
        mu = statistics.mean(amounts)
        sd = statistics.pstdev(amounts) or 1
        for t in txns:
            v = -t.amount_cents
            sigma = (v - mu) / sd if sd else 0
            if sigma < threshold_sigma:
                continue
            anomalies.append(
                AnomalyOut(
                    transaction_id=t.id,
                    posted_date=t.posted_date,
                    description=t.description_raw or "",
                    amount_cents=t.amount_cents,
                    category_id=cid,
                    category_name=cat_names.get(cid),
                    baseline_mean_cents=int(mu),
                    baseline_stddev_cents=int(sd),
                    sigma=round(sigma, 2),
                    rationale=(
                        f"${v/100:,.0f} is {sigma:.1f}σ above the "
                        f"${mu/100:.0f} avg / ${sd/100:.0f} stddev for this "
                        f"category over the last {days} days"
                    ),
                )
            )

    # Dedup pass — Plaid sometimes returns the same transaction across
    # both endpoints of a transfer (originator account + counterparty
    # account), with separate transaction IDs but identical date /
    # absolute amount / description prefix. Without this, the panel
    # shows every flagged anomaly twice. Prefer the entry with the
    # lower transaction ID (the originator usually arrives first).
    seen: set[tuple] = set()
    deduped: list[AnomalyOut] = []
    for a in anomalies:
        # Use the first 40 chars of description to ignore Plaid's
        # account-specific suffixes (e.g., trailing memo/account_id).
        desc_prefix = (a.description or "")[:40].strip().upper()
        key = (a.posted_date.isoformat(), abs(a.amount_cents), desc_prefix)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(a)
    anomalies = deduped

    anomalies.sort(key=lambda a: a.sigma, reverse=True)

    notifications_created = 0
    if fire_notifications and anomalies:
        for a in anomalies[:10]:  # cap so a backlog scan doesn't flood
            note = Notification(
                kind="unusual_transaction",
                title=f"Unusual {a.category_name or 'spend'}: ${-a.amount_cents/100:,.0f}",
                body=a.rationale,
                payload={
                    "transaction_id": a.transaction_id,
                    "sigma": a.sigma,
                    "category_id": a.category_id,
                },
            )
            db.add(note)
            notifications_created += 1
        db.commit()

    return AnomalyScanOut(
        window_start=start,
        window_end=today,
        threshold_sigma=threshold_sigma,
        transactions_scanned=len(rows),
        anomalies=anomalies,
        notifications_created=notifications_created,
        generated_at=datetime.utcnow(),
    )
