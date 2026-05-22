"""Parser: Netflix monthly receipt.

Senders  : info@account.netflix.com (most common), no-reply@netflix.com
Subjects : "Your Netflix receipt", "Your Netflix billing receipt",
           "Payment receipt for Netflix"

Body shape after HTML strip — Netflix is short and structured::

    Hi Chris,
    Here's a copy of your Netflix payment receipt.
    Total: $22.99
    Card: Visa ending in 1234
    Service period: Apr 22, 2026 - May 21, 2026
    Thanks for being a member!

We emit a TransactionDraft (the money already moved — receipts come
*after* the charge) and tag the result so the Subscription detector can
match it. The card_last4 lets the connector route the txn to the right
card account.
"""
from __future__ import annotations

import re
from datetime import datetime

from ..client import GmailMessage
from .base import ParserSpec, ParseResult, TransactionDraft, find_card_last4, parse_dollars_to_cents

SPEC = ParserSpec(
    name="netflix_receipt",
    label="Netflix — receipt",
    from_domains=["netflix.com", "account.netflix.com"],
    subject_patterns=[
        r"your\s+receipt",
        r"(payment|billing)\s+receipt",
        r"netflix.*receipt",
        r"thanks?\s+for\s+being",
    ],
    kind="transaction",
    priority=140,
)


_AMOUNT_RE = re.compile(
    r"(?:total|amount|charged|paid|service\s+price)\s*[:\-]?\s*"
    r"\$?\s*([0-9][0-9,]*\.[0-9]{2})",
    re.IGNORECASE,
)

# "Service period: Apr 22, 2026 - May 21, 2026" — first date is the
# billing date we want to anchor the transaction to.
_SERVICE_PERIOD_RE = re.compile(
    r"(?:service\s+period|billing\s+period)\s*[:\-]?\s*(\w+\s+\d{1,2},\s*\d{4})",
    re.IGNORECASE,
)


def parse(msg: GmailMessage) -> ParseResult | None:
    body = msg.body_plain or msg.snippet or ""
    if not body:
        return None

    cents = _extract_amount(body) or parse_dollars_to_cents(body)
    if cents is None:
        return None

    posted_date = _extract_period_start(body) or msg.received_at.date()
    card_last4 = find_card_last4(body) or find_card_last4(msg.subject or "")

    draft = TransactionDraft(
        posted_date=posted_date,
        amount_cents=-abs(cents),  # always an outflow
        description_raw="Netflix",
        merchant="Netflix",
        card_last4=card_last4,
        memo=f"Netflix receipt · {msg.subject}" if msg.subject else "Netflix receipt",
        extra={
            "vendor": "netflix",
            "service": "streaming",
            "category_hint": "streaming",
        },
    )

    return ParseResult(
        parser_name=SPEC.name,
        # The "subscription" tag wires this into apply_pending_signals so
        # the Subscriptions detector picks Netflix as a recurring charge
        # without needing to wait for two cycles of Plaid txns.
        tags=["transaction", "netflix", "subscription"],
        transaction=draft,
        payload={
            "card_last4": card_last4,
            "subscription_brand_hint": "netflix",
            "monthly_amount_cents": abs(cents),
        },
    )


# ---------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------


def _extract_amount(body: str) -> int | None:
    m = _AMOUNT_RE.search(body)
    if not m:
        return None
    try:
        return int(round(float(m.group(1).replace(",", "")) * 100))
    except ValueError:
        return None


def _extract_period_start(body: str):
    m = _SERVICE_PERIOD_RE.search(body)
    if not m:
        return None
    raw = m.group(1).strip()
    for fmt in ("%b %d, %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None
