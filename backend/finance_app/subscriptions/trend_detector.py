"""Month-over-month trend detector — Sprint 11.

Detects subscriptions whose recent spend is materially higher than the
trailing-year baseline. Designed primarily for *usage-metered* services
(Anthropic Claude API, OpenAI, AWS, etc.) where the monthly amount
varies with consumption — these often grow silently as users lean on
them, and a 3-month-vs-12-month comparison surfaces that growth before
the user notices it on their card statement.

Also useful for *bundle* composites (Apple App Store, Google Play) when
a user adds new subscriptions and their parent footprint creeps up
without them realizing they're now paying for more services.

Output: a list of ``TrendAlert`` records, each pointing at a parent
Subscription, with a growth ratio + monthly totals so the UI can render
"Anthropic spend is up 47% over the last 3 months — review usage?"

This module is pure compute; persisting the alerts as Notifications is
the caller's job (jobs/notify_signals.emit_signal_notifications hooks
this in).
"""
from __future__ import annotations

import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    Subscription,
    SubscriptionStatus,
    Transaction,
)

logger = logging.getLogger(__name__)


# Tunable thresholds.
_TREND_LOOKBACK_MONTHS = 12         # full window used for the trailing baseline
_TREND_RECENT_MONTHS = 3            # most recent N months treated as "recent avg"
_TREND_GROWTH_THRESHOLD = 1.20      # 20%+ growth → fire an alert
_MIN_OBSERVED_MONTHS = 6            # require at least 6 months of data
_MIN_RECENT_TOTAL_CENTS = 1000      # don't fire on tiny services (<$10/mo recent)


@dataclass(frozen=True)
class TrendAlert:
    """One subscription whose recent spend is meaningfully higher
    than its trailing baseline."""

    subscription_id: int
    subscription_name: str
    growth_ratio: float                 # recent_avg / baseline_avg, ≥ 1.20
    recent_avg_cents: int               # avg over last N months
    baseline_avg_cents: int             # avg over prior months
    months_observed: int                # how many months of data total
    monthly_totals: list[tuple[date, int]] = field(default_factory=list)

    @property
    def growth_pct(self) -> float:
        return (self.growth_ratio - 1.0) * 100.0

    def headline(self) -> str:
        return (
            f"{self.subscription_name} spend is up "
            f"{self.growth_pct:+.0f}% — "
            f"${self.recent_avg_cents / 100:.0f}/mo recent vs "
            f"${self.baseline_avg_cents / 100:.0f}/mo trailing avg"
        )


def _aggregator_patterns(sub: Subscription) -> list[str]:
    """Return the merchant-string patterns associated with a composite
    subscription's aggregator. For non-composites or unknown
    aggregators, falls back to the subscription's own name tokenized.
    """
    from finance_app.subscriptions.composite_detector import detect_aggregator

    if sub.is_composite:
        agg = detect_aggregator(sub.name or "") or detect_aggregator(
            sub.notes or ""
        )
        if agg:
            return [p.lower() for p in agg.name_patterns]

    # Non-composite (or unknown aggregator): match by the subscription's
    # own name tokens. Strip punctuation and split — same logic the
    # SubscriptionDetector uses to cluster.
    s = (sub.name or "").upper()
    s = re.sub(r"[^A-Z ]+", " ", s)
    tokens = [t for t in s.split() if len(t) > 2]
    return [" ".join(tokens[:3]).lower()] if tokens else []


def _month_key(d: date) -> date:
    """Truncate a date to the first of its month — used as a dict key."""
    return d.replace(day=1)


def _monthly_totals_for(
    db: Session,
    sub: Subscription,
    *,
    today: date,
) -> list[tuple[date, int]]:
    """Sum absolute outflow per month for transactions matching this
    subscription. Returns sorted list of (month_start, cents)."""
    patterns = _aggregator_patterns(sub)
    if not patterns:
        return []
    cutoff = today - timedelta(days=_TREND_LOOKBACK_MONTHS * 31)
    rows = list(
        db.execute(
            select(Transaction)
            .where(Transaction.amount_cents < 0)
            .where(Transaction.posted_date >= cutoff)
        ).scalars().all()
    )

    by_month: dict[date, int] = defaultdict(int)
    for t in rows:
        desc = (t.description_raw or "").lower()
        if not any(p in desc for p in patterns):
            continue
        by_month[_month_key(t.posted_date)] += abs(t.amount_cents)

    return sorted(by_month.items())


def _compute_growth_rows(
    db: Session, *, today: date
) -> list[TrendAlert]:
    """Inner helper — compute a TrendAlert for EVERY observable
    subscription, regardless of growth threshold. Used by both
    :func:`detect_trends` (which filters down to real alerts) and
    :func:`top_movers` (which returns the N fastest growers as
    informational rather than alarming context).

    Drops subs with insufficient data, but does NOT apply the 20% or
    $10/mo guards — callers decide what bar to apply.
    """
    rows: list[TrendAlert] = []
    subs = list(
        db.execute(
            select(Subscription).where(
                Subscription.status != SubscriptionStatus.dismissed
            ).where(
                Subscription.parent_subscription_id.is_(None)
            )
        ).scalars().all()
    )
    for sub in subs:
        totals = _monthly_totals_for(db, sub, today=today)
        if len(totals) < 2:
            continue
        recent_n = min(_TREND_RECENT_MONTHS, max(1, len(totals) // 2))
        recent = totals[-recent_n:]
        baseline = totals[:-recent_n]
        if not recent or not baseline:
            continue
        recent_avg = sum(c for _, c in recent) / len(recent)
        baseline_avg = sum(c for _, c in baseline) / len(baseline)
        if baseline_avg <= 0:
            continue
        ratio = recent_avg / baseline_avg
        rows.append(
            TrendAlert(
                subscription_id=sub.id,
                subscription_name=sub.name,
                growth_ratio=ratio,
                recent_avg_cents=int(round(recent_avg)),
                baseline_avg_cents=int(round(baseline_avg)),
                months_observed=len(totals),
                monthly_totals=list(totals),
            )
        )
    return rows


def detect_trends(
    db: Session, *, today: date | None = None
) -> list[TrendAlert]:
    """Walk all active subscriptions and surface ones with >20% MoM
    growth over the last 3 months relative to the trailing 12.

    Idempotent — call as often as you like; the caller dedupes the
    resulting Notification rows by payload key.
    """
    today = today or date.today()
    rows = _compute_growth_rows(db, today=today)

    alerts: list[TrendAlert] = []
    for r in rows:
        if r.months_observed < _MIN_OBSERVED_MONTHS:
            continue
        if r.recent_avg_cents < _MIN_RECENT_TOTAL_CENTS:
            continue
        if r.growth_ratio < _TREND_GROWTH_THRESHOLD:
            continue
        alerts.append(r)

    alerts.sort(key=lambda a: a.growth_ratio, reverse=True)
    return alerts


def top_movers(
    db: Session, *, today: date | None = None, limit: int = 3,
    min_recent_cents: int = 500,
) -> list[TrendAlert]:
    """Return the N fastest-growing subscriptions even if they don't
    clear the alert threshold. Used by the Subscriptions panel's
    "preview" trend banner so the surface isn't permanently silent on
    accounts that don't have 6+ months of data or a 20%+ jump.

    Defaults to a much lower price gate ($5/mo recent) since this is
    informational, not actionable — we don't want to surface a
    $0.50/mo blip just because its growth ratio was extreme.
    """
    today = today or date.today()
    rows = _compute_growth_rows(db, today=today)
    # Keep things that grew (ratio >= 1) AND aren't trivially small,
    # then sort by descending ratio.
    filtered = [
        r for r in rows
        if r.growth_ratio >= 1.0
        and r.recent_avg_cents >= min_recent_cents
    ]
    filtered.sort(key=lambda r: r.growth_ratio, reverse=True)
    return filtered[:limit]
