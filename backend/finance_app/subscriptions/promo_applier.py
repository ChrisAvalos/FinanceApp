"""Apply T2 parser signals (promos, price changes) to Subscription rows.

Lifecycle:
1. The Gmail connector parses an email; the T2 ``subscription_promo`` parser
   tags it ``price_change`` / ``promo`` / ``trial_ending`` and stashes the
   structured data in ``EmailMessage.extra``.
2. We do NOT update Subscription rows from inside the connector — keep the
   connector single-responsibility (fetch + parse + persist).
3. Instead, ``apply_pending_signals`` runs after the sync (or from an API
   button). It scans recent EmailMessage rows tagged with promo/price-change,
   matches them to subscriptions by brand hint, and updates the
   ``last_amount_cents`` / ``prior_amount_cents`` / ``price_change_date``
   fields. Each EmailMessage row gets a marker in ``extra["applied"] = True``
   so subsequent runs are idempotent.

Matching strategy
-----------------
* If the email's ``merchant_hint`` (brand from From-domain) matches a
  Subscription whose normalized name contains the same brand, attach.
* Otherwise, leave it unattached but still report it in the run summary
  so the UI can show "we saw a price-change email but couldn't link it."

Why not also create Offer rows?
That's a Phase D concern (suggestion engine consumes Offers). Phase B
keeps this minimal: extract → apply to Subscription → done.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    EmailMessage,
    ParserOutcome,
    Subscription,
)

logger = logging.getLogger(__name__)


@dataclass
class PromoApplyResult:
    scanned: int = 0
    price_changes_applied: int = 0
    promos_seen: int = 0
    trials_ending: int = 0
    unlinked: int = 0
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "scanned": self.scanned,
            "price_changes_applied": self.price_changes_applied,
            "promos_seen": self.promos_seen,
            "trials_ending": self.trials_ending,
            "unlinked": self.unlinked,
            "notes": self.notes,
        }


def _matches_subscription(merchant_hint: str, sub: Subscription) -> bool:
    """Crude case-insensitive substring match.

    The Subscription.name is the cluster key (normalized — uppercase, only
    letters and spaces). The merchant_hint is a brand slug from the From:
    domain. Both lowered + substring is good enough for Phase B; we can
    upgrade to a merchant alias table later.
    """
    if not merchant_hint or not sub.name:
        return False
    return merchant_hint.lower() in sub.name.lower()


def _email_already_applied(em: EmailMessage) -> bool:
    return bool(em.extra and em.extra.get("applied"))


def _mark_applied(em: EmailMessage, attached_to: int | None) -> None:
    extra = dict(em.extra or {})
    extra["applied"] = True
    if attached_to is not None:
        extra["applied_to_subscription_id"] = attached_to
    em.extra = extra


def apply_pending_signals(
    db: Session,
    *,
    lookback_days: int = 60,
    today: date | None = None,
) -> PromoApplyResult:
    """Scan recent T2-parsed EmailMessage rows and apply signals to subscriptions.

    Idempotent — once applied, an EmailMessage's ``extra["applied"]`` is
    set so we don't re-apply the same price change twice.
    """
    today = today or date.today()
    since = datetime.combine(today - timedelta(days=lookback_days), datetime.min.time())

    rows = (
        db.execute(
            select(EmailMessage).where(
                EmailMessage.parser_name == "subscription_promo",
                EmailMessage.parser_outcome == ParserOutcome.parsed,
                EmailMessage.received_at >= since,
            )
        )
        .scalars()
        .all()
    )

    result = PromoApplyResult(scanned=len(rows))
    if not rows:
        return result

    subs = db.execute(select(Subscription)).scalars().all()

    for em in rows:
        if _email_already_applied(em):
            continue
        extra = em.extra or {}
        merchant_hint = extra.get("merchant_hint") or ""
        tags = extra.get("tags") or []

        # Find the best-matching subscription by brand.
        match: Subscription | None = None
        for sub in subs:
            if _matches_subscription(merchant_hint, sub):
                match = sub
                break

        if "price_change" in tags:
            pc = extra.get("price_change") or {}
            new_price = pc.get("new_price_cents")
            if isinstance(new_price, int) and match is not None:
                # Convert outflow sign convention: subscriptions store
                # negative cents (outflow). The parsed dollar amount is
                # positive — flip if the existing row is negative.
                signed_new = -abs(new_price) if (match.amount_cents or 0) < 0 else new_price
                # Only act if it's a real change vs current.
                if signed_new != match.amount_cents:
                    match.prior_amount_cents = match.amount_cents
                    match.last_amount_cents = signed_new
                    # The detector may flip amount_cents on the next run
                    # once new charges land; for now leave amount_cents
                    # alone so MoM math doesn't snap.
                    match.price_change_date = (em.received_at.date() if em.received_at else today)
                    result.price_changes_applied += 1
                    result.notes.append(
                        f"price change applied: {match.name} "
                        f"{match.prior_amount_cents}→{match.last_amount_cents}"
                    )
                _mark_applied(em, match.id)
                continue
            # New price extracted but no matching subscription — leave
            # unlinked so the UI can show "saw a price change for X
            # but we don't track it as a subscription yet".
            result.unlinked += 1
            result.notes.append(
                f"price change unlinked: hint={merchant_hint or '?'}, new={new_price}"
            )
            _mark_applied(em, None)
            continue

        if "promo" in tags:
            result.promos_seen += 1
            if match is None:
                result.unlinked += 1
                _mark_applied(em, None)
            else:
                _mark_applied(em, match.id)
            continue

        if "trial_ending" in tags:
            result.trials_ending += 1
            _mark_applied(em, match.id if match else None)
            continue

        # No actionable tag — mark applied to skip next run.
        _mark_applied(em, None)

    db.commit()
    return result
