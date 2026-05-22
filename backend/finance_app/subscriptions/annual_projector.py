"""Annual subscription renewal projector — Sprint 13.

The base ``_project_subscriptions`` projector in cashflow/service.py
walks Subscription rows by their ``cadence_days`` field. That works
fine for true monthly subscriptions but produces wrong cash-flow
forecasts for annual subscriptions that have been stored as
monthly-equivalent rows (cadence_days=30, amount=$10.83/mo) for
reporting reasons — those would emit a "Subscription: ESPN+ -$10.83"
event every 30 days through the window, when in reality the user
gets one big -$129.99 hit per year.

This module recognizes the "monthly equivalent of annual" pattern
from the row's ``notes`` field and emits a single CashFlowEvent on
the actual renewal date with the actual annual amount.

The notes field gets populated by the manual unmask flow and the
Apple-receipt reconciler in formats like:

    "Annual $129.99, monthly equiv. Renews Sep 12 — from iPhone"
    "Renews July 24 — verify cadence (likely annual at $34.99)"

We parse both the "Renews ..." date and any "$X.XX" annual amount,
falling back to amount × 12 when the explicit annual figure isn't in
the notes.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import Subscription, SubscriptionStatus

logger = logging.getLogger(__name__)


# Match phrases the unmask flow / Apple reconciler write into notes
# when the underlying subscription is annual.
_ANNUAL_MARKER_RE = re.compile(
    r"(?:^|\W)(annual(ly)?|yearly|1[\s-]?year|annual\s*plan)\b",
    re.IGNORECASE,
)
# Renewal date patterns. Matches:
#   "Renews Sep 12, 2026"   "Renews September 12"   "Renews Sep 12"
# Year is optional — if missing we infer the next future occurrence.
_RENEWAL_RE = re.compile(
    r"renews?\s+([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?",
    re.IGNORECASE,
)
# Explicit annual amount (vs. the monthly-equiv stored on amount_cents).
_ANNUAL_AMOUNT_RE = re.compile(r"\$([0-9]+(?:\.[0-9]{2})?)\s*(?:annual|/yr)?")
# How many months ahead to project. 12 months gives us a full annual
# cycle so any once-yearly charge in the window shows up.
_DEFAULT_HORIZON_DAYS = 365


@dataclass(frozen=True)
class AnnualRenewalEvent:
    """A single projected annual renewal."""
    subscription_id: int
    label: str
    on_date: date
    amount_cents: int  # signed (negative outflow)
    confidence: float
    notes: str | None = None


def _parse_renewal_date(text: str, *, today: date) -> date | None:
    """Extract the next "Renews <Month> <day>" date from a notes blob.
    Year defaults to whichever future year the (month, day) lands in."""
    m = _RENEWAL_RE.search(text or "")
    if not m:
        return None
    month_name, day_str, year_str = m.groups()
    for fmt in ("%b %d", "%B %d"):
        try:
            parsed = datetime.strptime(f"{month_name} {day_str}", fmt)
            break
        except ValueError:
            parsed = None
    if parsed is None:
        return None
    year = int(year_str) if year_str else today.year
    try:
        d = date(year, parsed.month, parsed.day)
    except ValueError:
        return None
    # If no year was provided and the date has already passed this year,
    # roll forward to next year.
    if not year_str and d < today:
        try:
            d = date(year + 1, parsed.month, parsed.day)
        except ValueError:
            return None
    return d


def _parse_annual_amount_cents(text: str) -> int | None:
    """Extract an explicit annual price from the notes ("$129.99 annual").
    Returns positive cents; caller flips sign for outflow."""
    m = _ANNUAL_AMOUNT_RE.search(text or "")
    if not m:
        return None
    try:
        return int(round(float(m.group(1)) * 100))
    except (TypeError, ValueError):
        return None


def _is_annual(sub: Subscription) -> bool:
    """True iff this row is an annual subscription stored as a
    monthly-equivalent. Two signals:
      1. notes contain an "annual"/"yearly" marker
      2. cadence_days is null OR cadence_days <= 60 (monthly) but the
         note explicitly says annual — caller is the source of truth.

    Pure monthly rows (no annual marker) return False even if their
    notes mention dates.
    """
    if not _ANNUAL_MARKER_RE.search(sub.notes or ""):
        return False
    return True


def project_annual_renewals(
    db: Session,
    *,
    start: date | None = None,
    end: date | None = None,
) -> list[AnnualRenewalEvent]:
    """Walk subscriptions, return projected annual renewals in window.

    Includes children of composite parents (the Apple bundle's ESPN+
    annual, Truthly annual, etc.). Skips dismissed subs. Only emits one
    event per subscription per year.
    """
    today = start or date.today()
    horizon = end or date.fromordinal(
        today.toordinal() + _DEFAULT_HORIZON_DAYS
    )

    subs = list(
        db.execute(
            select(Subscription).where(
                Subscription.status != SubscriptionStatus.dismissed
            )
        ).scalars().all()
    )

    events: list[AnnualRenewalEvent] = []
    for sub in subs:
        if not _is_annual(sub):
            continue
        renewal = _parse_renewal_date(sub.notes or "", today=today)
        if renewal is None:
            # Annual marker present but no parseable date — best effort
            # fallback: use existing next_expected_date if set.
            renewal = sub.next_expected_date
        if renewal is None or renewal < today or renewal > horizon:
            continue
        annual_amount = (
            _parse_annual_amount_cents(sub.notes or "")
            or abs(sub.amount_cents or 0) * 12
        )
        if annual_amount <= 0:
            continue
        events.append(
            AnnualRenewalEvent(
                subscription_id=sub.id,
                label=sub.name,
                on_date=renewal,
                amount_cents=-annual_amount,
                confidence=sub.confidence_score or 0.85,
                notes="Annual renewal projected from subscription notes",
            )
        )
    events.sort(key=lambda e: e.on_date)
    return events
