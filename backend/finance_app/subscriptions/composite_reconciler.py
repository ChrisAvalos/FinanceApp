"""Reconcile parsed Apple/Google receipt line items into composite children.

Lifecycle (parallels promo_applier.apply_pending_signals):
1. Gmail connector parses a receipt email; the T1 ``apple_receipt``
   parser stashes the line items in ``EmailMessage.extra`` with
   ``payload["composite"] = "apple"`` etc.
2. This reconciler walks recently-parsed receipt rows, finds the
   parent Subscription that the receipt came from (by matching the
   ``parent_match_hints``), and creates child Subscription rows for
   each declared line item.
3. Each EmailMessage gets ``extra["composite_applied"] = True`` so
   subsequent runs are idempotent (no duplicate children created from
   the same receipt).

Match rules to avoid duplicate children
---------------------------------------
We dedupe children within a parent by lowercased title. So if last
month's receipt declared "Peacock Premium" and this month's repeats it
unchanged, we update the existing child's ``last_amount_cents`` rather
than creating a second row. This also covers the user editing the
title (e.g. "Peacock" → "Peacock Premium") via the unmask UI.

Status / confirmation
---------------------
Children created here are auto-confirmed because the source-of-truth
is Apple's own receipt. If Apple says it, it's true.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    EmailMessage,
    ParserOutcome,
    Subscription,
    SubscriptionStatus,
    SubscriptionType,
)

logger = logging.getLogger(__name__)


@dataclass
class CompositeReconcileResult:
    receipts_scanned: int = 0
    children_created: int = 0
    children_updated: int = 0
    receipts_unlinked: int = 0
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "receipts_scanned": self.receipts_scanned,
            "children_created": self.children_created,
            "children_updated": self.children_updated,
            "receipts_unlinked": self.receipts_unlinked,
            "notes": self.notes,
        }


def _normalize_for_match(s: str) -> str:
    """Strip non-alphanumeric chars and lowercase, so punctuation
    differences don't block hint matching. "APPLE.COM/BILL" and
    "APPLE COM BILL" both normalize to "applecombill".
    """
    import re as _re
    return _re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _find_parent(
    subs: list[Subscription], hints: list[str]
) -> Subscription | None:
    """Find the active parent subscription whose name contains any hint.

    Matches punctuation-insensitively — the receipt parser emits hints
    like "apple.com/bill" but the recurring-charge detector's
    ``normalize_key`` strips punctuation, so parent names are stored as
    "APPLE COM BILL". Both normalize to "applecombill" for comparison.
    """
    if not hints:
        return None
    norm_hints = [_normalize_for_match(h) for h in hints if h]
    for sub in subs:
        name_norm = _normalize_for_match(sub.name or "")
        for h in norm_hints:
            if h and h in name_norm:
                return sub
    return None


def _normalize_title(s: str) -> str:
    return " ".join((s or "").lower().split())


def reconcile_composite_receipts(
    db: Session,
    *,
    lookback_days: int = 60,
) -> CompositeReconcileResult:
    """Walk recent composite-receipt EmailMessages and populate children.

    Idempotent — once an EmailMessage is marked ``composite_applied``
    it's skipped. Re-running this function on the same DB is safe.
    """
    since = datetime.utcnow() - timedelta(days=lookback_days)
    # Composite parsers — anything that emits payload["composite"] gets
    # picked up here. Order doesn't matter; we filter by parser_name
    # only so the parser_outcome+received_at index does its job. Add
    # new vendors here when adding a parser.
    composite_parsers = ["apple_receipt", "google_play_receipt"]
    receipts = list(
        db.execute(
            select(EmailMessage).where(
                EmailMessage.parser_name.in_(composite_parsers),
                EmailMessage.parser_outcome == ParserOutcome.parsed,
                EmailMessage.received_at >= since,
            )
        ).scalars().all()
    )

    result = CompositeReconcileResult(receipts_scanned=len(receipts))
    if not receipts:
        return result

    subs = list(db.execute(select(Subscription)).scalars().all())

    for em in receipts:
        extra = em.extra or {}
        if extra.get("composite_applied"):
            continue

        payload = extra
        # The parser stashes the line items inside the EmailMessage's
        # ``extra`` dict. Some sites wrap payload under "payload"; tolerate
        # either shape.
        line_items = payload.get("line_items") or (payload.get("payload") or {}).get("line_items")
        hints = payload.get("parent_match_hints") or (payload.get("payload") or {}).get("parent_match_hints")
        if not line_items or not hints:
            continue

        parent = _find_parent(subs, hints)
        if parent is None:
            result.receipts_unlinked += 1
            result.notes.append(
                f"Receipt with {len(line_items)} item(s) but no matching parent (hints={hints})"
            )
            continue
        if not parent.is_composite:
            parent.is_composite = True

        # Dedupe existing children of this parent by normalized title.
        existing_children = [s for s in subs if s.parent_subscription_id == parent.id]
        by_title: dict[str, Subscription] = {
            _normalize_title(c.name): c for c in existing_children
        }

        for item in line_items:
            title = (item.get("title") or "").strip()
            cents = item.get("amount_cents")
            if not title or not isinstance(cents, int) or cents <= 0:
                continue
            signed = -abs(cents)
            key = _normalize_title(title)
            existing = by_title.get(key)
            if existing is not None:
                # Update the recorded amount in case the price changed.
                if existing.last_amount_cents != signed:
                    existing.prior_amount_cents = existing.last_amount_cents
                    existing.last_amount_cents = signed
                    existing.price_change_date = (
                        em.received_at.date() if em.received_at else None
                    )
                existing.amount_cents = signed
                result.children_updated += 1
                continue
            child = Subscription(
                name=title[:160],
                merchant_id=None,
                amount_cents=signed,
                last_amount_cents=signed,
                cadence_days=parent.cadence_days,
                cadence_label=parent.cadence_label,
                next_expected_date=parent.next_expected_date,
                status=SubscriptionStatus.active,
                subscription_type=SubscriptionType.unknown,
                confidence_score=1.0,
                is_user_confirmed=True,
                is_variable_amount=False,
                is_composite=False,
                parent_subscription_id=parent.id,
                notes=f"Auto-extracted from {parent.name} receipt"
                + (f" ({item.get('period')})" if item.get("period") else ""),
            )
            db.add(child)
            subs.append(child)
            by_title[key] = child
            result.children_created += 1

        # Mark the email so we don't reprocess.
        new_extra = dict(extra)
        new_extra["composite_applied"] = True
        new_extra["applied_to_subscription_id"] = parent.id
        em.extra = new_extra

    db.commit()
    return result
