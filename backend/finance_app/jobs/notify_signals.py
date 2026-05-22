"""Signal-driven notifications producer.

Companion to :mod:`milestones` — that job emits goal-progress
notifications. This one emits everything else: large new transactions,
fresh anomalies, subscription price changes, and projected low-balance
days.

Idempotency: every emitter walks since-last-check (uses created_at on
Notification or a payload-encoded marker) so a job re-running every
hour doesn't spam duplicates.

Idiom for each producer:
    1. Pull the underlying signal from its source-of-truth table.
    2. Filter to "new since last notify" using a payload-keyed lookup.
    3. Insert one Notification row per surviving event.
    4. Log a count summary.

Notifications kinds used by this module:
    - ``anomaly_flagged``         new σ-based anomaly above threshold
    - ``subscription_price_up``   detected price increase on a known sub
    - ``subscription_trend_alert`` 3mo avg > 12mo avg × 1.20 (Sprint 11)
    - ``low_balance_warn``        cash flow forecast crosses crunch threshold
    - ``large_charge_alert``      transaction over a $-amount threshold
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta

from sqlalchemy import select

from ..db.models import (
    Notification,
    Subscription,
    Transaction,
)
from ..db.session import SessionLocal

logger = logging.getLogger(__name__)


# Threshold for the "large charge" notifier. A user can change this in
# settings later; default is "anything over $200 is worth a heads-up."
_LARGE_CHARGE_THRESHOLD_CENTS = 20_000


def _existing_payload_keys(db, kind: str) -> set[str]:
    """Pull the dedup keys from existing notifications of a given kind.

    Each producer encodes a stable per-event key in payload['key'] —
    e.g. the transaction ID for large-charge alerts, the subscription
    ID for price changes, the (date, account_id) tuple for low-balance
    warnings. Two passes can't emit the same notification because we
    look it up before inserting.
    """
    rows = db.execute(
        select(Notification).where(Notification.kind == kind)
    ).scalars().all()
    return {
        (n.payload or {}).get("key", "")
        for n in rows
        if n.payload
    }


def _emit_anomaly_notifications(db) -> int:
    """One Notification per anomaly_scan hit not previously seen.

    The anomaly detector lives inline in api/anomaly.py — we call its
    `scan()` route function directly with `fire_notifications=False`
    (we handle dedup ourselves; the route's notification write would
    otherwise stomp on our key-based idempotency).
    """
    try:
        from finance_app.api.anomaly import scan as anomaly_scan
    except ImportError:
        logger.warning("anomaly route not importable; skipping anomaly notifications")
        return 0

    seen = _existing_payload_keys(db, "anomaly_flagged")
    try:
        result = anomaly_scan(days=90, threshold_sigma=3.0, fire_notifications=False, db=db)
    except Exception:  # noqa: BLE001
        logger.exception("anomaly scan failed inside notify_signals")
        return 0
    anomalies = getattr(result, "anomalies", []) or []
    created = 0
    for a in anomalies:
        txn_id = getattr(a, "transaction_id", None)
        if txn_id is None:
            continue
        key = f"txn:{txn_id}"
        if key in seen:
            continue
        amt = abs(getattr(a, "amount_cents", 0)) / 100
        desc = (getattr(a, "description", "") or "")[:80]
        sigma = getattr(a, "sigma", None)
        sigma_s = f" ({sigma:.1f}σ)" if isinstance(sigma, (int, float)) else ""
        db.add(
            Notification(
                kind="anomaly_flagged",
                title=f"Unusual ${amt:,.2f} charge{sigma_s}",
                body=f"{desc} — flagged as σ-outlier vs. your typical pattern.",
                payload={"key": key, "transaction_id": txn_id, "sigma": sigma},
            )
        )
        created += 1
        seen.add(key)
    return created


def _emit_subscription_price_notifications(db) -> int:
    """One per subscription where ``last_amount`` differs from prior.

    The subscription detector already populates ``prior_amount_cents``
    + ``last_amount_cents`` + ``price_change_date``. We emit when the
    delta is positive (price went up) and we haven't already.
    """
    seen = _existing_payload_keys(db, "subscription_price_up")
    subs = db.execute(
        select(Subscription).where(
            Subscription.prior_amount_cents.is_not(None),
            Subscription.last_amount_cents.is_not(None),
        )
    ).scalars().all()
    created = 0
    for s in subs:
        prior = s.prior_amount_cents
        latest = s.last_amount_cents
        if prior is None or latest is None or prior == 0:
            continue
        # Only notify on increases — decreases are good news, no urgency.
        delta = abs(latest) - abs(prior)
        if delta <= 0:
            continue
        change_date = s.price_change_date.isoformat() if s.price_change_date else "?"
        key = f"sub:{s.id}:{change_date}"
        if key in seen:
            continue
        pct = (delta / abs(prior)) * 100
        # Subscription has a `merchant` relationship (Merchant | None), not a
        # `merchant_name` column. Reach through the relationship; fall back to
        # the cluster `name` field, then to a generic id label.
        merchant_name = s.merchant.name if s.merchant else None
        name = merchant_name or s.name or f"Subscription #{s.id}"
        db.add(
            Notification(
                kind="subscription_price_up",
                title=f"{name} bumped ${abs(prior)/100:.2f} → ${abs(latest)/100:.2f}",
                body=f"+{pct:.0f}% increase. Consider negotiating retention or cancelling.",
                payload={
                    "key": key,
                    "subscription_id": s.id,
                    "prior_cents": prior,
                    "latest_cents": latest,
                    "delta_cents": delta,
                },
            )
        )
        created += 1
    return created


def _emit_subscription_trend_notifications(db) -> int:
    """Sprint 11 — fire when a subscription's recent-3-month spend
    is ≥20% above its trailing-12-month baseline.

    Particularly valuable for usage-metered services (Anthropic, OpenAI,
    AWS) whose monthly cost creeps as you lean on them. Dedup key is
    ``trend:{sub_id}:{YYYY-MM}`` so we fire at most once per
    subscription per calendar month — preventing a daily scheduler
    run from spamming the same alert.
    """
    from finance_app.subscriptions.trend_detector import detect_trends

    alerts = detect_trends(db)
    if not alerts:
        return 0
    seen = _existing_payload_keys(db, "subscription_trend_alert")
    today = date.today()
    month_tag = today.strftime("%Y-%m")
    created = 0
    for a in alerts:
        key = f"trend:{a.subscription_id}:{month_tag}"
        if key in seen:
            continue
        db.add(
            Notification(
                kind="subscription_trend_alert",
                title=a.headline(),
                body=(
                    f"Recent {a.recent_avg_cents / 100:.2f}/mo avg vs "
                    f"trailing {a.baseline_avg_cents / 100:.2f}/mo baseline "
                    f"({a.months_observed} months observed). "
                    "Worth reviewing whether the usage matches the value "
                    "you're getting."
                ),
                payload={
                    "key": key,
                    "subscription_id": a.subscription_id,
                    "growth_ratio": round(a.growth_ratio, 3),
                    "recent_avg_cents": a.recent_avg_cents,
                    "baseline_avg_cents": a.baseline_avg_cents,
                    "months_observed": a.months_observed,
                },
            )
        )
        created += 1
    return created


def _emit_low_balance_notifications(db) -> int:
    """One per ``crunch_day`` returned by the cash-flow forecast.

    The forecast already computes which days the running balance would
    dip below threshold. We emit a single notification per (account,
    date) so the user gets one heads-up per crunch even if the forecast
    re-runs.
    """
    try:
        from finance_app.cashflow import build_forecast
    except ImportError:
        logger.warning("cashflow module not importable; skipping low-balance notifications")
        return 0

    try:
        forecast = build_forecast(db, days=30)
    except Exception:  # noqa: BLE001 — forecast can raise if no accounts linked
        return 0

    seen = _existing_payload_keys(db, "low_balance_warn")
    crunch_days = getattr(forecast, "crunch_days", None) or []
    created = 0
    for d in crunch_days:
        # crunch_days may be ISO strings or date objects depending on impl.
        d_str = d if isinstance(d, str) else d.isoformat()
        key = f"crunch:{d_str}"
        if key in seen:
            continue
        db.add(
            Notification(
                kind="low_balance_warn",
                title=f"Projected low balance on {d_str}",
                body="Cash flow forecast says your running balance dips below the crunch threshold this day. Pre-empt by moving money or postponing a discretionary charge.",
                payload={"key": key, "date": d_str},
            )
        )
        created += 1
    return created


def _emit_large_charge_notifications(db) -> int:
    """One per recently-posted transaction above the threshold.

    Walks the last 7 days of activity. Skips transactions already
    notified. Skips obvious transfers/payroll on the inflow side —
    only outflow over the threshold counts as a "heads up."
    """
    seen = _existing_payload_keys(db, "large_charge_alert")
    cutoff = date.today() - timedelta(days=7)
    rows = db.execute(
        select(Transaction).where(
            Transaction.posted_date >= cutoff,
            Transaction.amount_cents <= -_LARGE_CHARGE_THRESHOLD_CENTS,
        )
    ).scalars().all()
    created = 0
    for t in rows:
        key = f"txn:{t.id}"
        if key in seen:
            continue
        amt = abs(t.amount_cents) / 100
        desc = (t.description_clean or t.description_raw or "")[:80]
        db.add(
            Notification(
                kind="large_charge_alert",
                title=f"${amt:,.2f} charge — {desc[:40]}",
                body=f"On {t.posted_date.isoformat()}. Above the $200 alert threshold.",
                payload={
                    "key": key,
                    "transaction_id": t.id,
                    "amount_cents": t.amount_cents,
                },
            )
        )
        created += 1
    return created


def emit_signal_notifications(db=None) -> dict[str, int]:
    """Run every producer in one pass. Idempotent across calls.

    If ``db`` is None we open a fresh session, commit at the end, and
    close it. Pass an existing session when running inside a request
    or another job that already owns one.
    """
    own_session = db is None
    if own_session:
        db = SessionLocal()
    started = datetime.utcnow()
    try:
        anomaly_count = _emit_anomaly_notifications(db)
        sub_count = _emit_subscription_price_notifications(db)
        trend_count = _emit_subscription_trend_notifications(db)
        crunch_count = _emit_low_balance_notifications(db)
        large_count = _emit_large_charge_notifications(db)
        if own_session:
            db.commit()
        total = anomaly_count + sub_count + trend_count + crunch_count + large_count
        result = {
            "anomaly_flagged": anomaly_count,
            "subscription_price_up": sub_count,
            "subscription_trend_alert": trend_count,
            "low_balance_warn": crunch_count,
            "large_charge_alert": large_count,
            "total": total,
            "duration_ms": int((datetime.utcnow() - started).total_seconds() * 1000),
        }
        logger.info("signal-notifications emitted: %s", result)
        return result
    except Exception:
        if own_session:
            db.rollback()
        raise
    finally:
        if own_session:
            db.close()
