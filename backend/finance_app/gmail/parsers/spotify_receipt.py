"""Parser: Spotify subscription receipt.

Senders  : no-reply@spotify.com, receipts@spotify.com
Subjects : "Your Spotify receipt", "Your Spotify Premium receipt",
           "Payment confirmation"

Body shape (HTML-stripped) varies between Premium and Family plans but
shares the same labeled-fields skeleton::

    Receipt for your Spotify Premium plan
    ---------------------------------
    Amount paid: $11.99
    Payment method: Visa ending in 1234
    Date of purchase: April 22, 2026
    Next payment date: May 22, 2026

We emit a TransactionDraft and tag for subscription detection, same
as Netflix.
"""
from __future__ import annotations

import re
from datetime import datetime

from ..client import GmailMessage
from .base import ParserSpec, ParseResult, TransactionDraft, find_card_last4, parse_dollars_to_cents

SPEC = ParserSpec(
    name="spotify_receipt",
    label="Spotify — receipt",
    from_domains=["spotify.com"],
    subject_patterns=[
        r"your\s+spotify\s+receipt",
        r"your\s+receipt",
        r"payment\s+confirmation",
        r"spotify.*receipt",
    ],
    kind="transaction",
    priority=140,
)


_AMOUNT_RE = re.compile(
    r"(?:amount\s+paid|total|charged|paid)\s*[:\-]?\s*"
    r"\$?\s*([0-9][0-9,]*\.[0-9]{2})",
    re.IGNORECASE,
)

_DATE_RE = re.compile(
    r"(?:date\s+of\s+purchase|purchase\s+date|billed\s+on|date)\s*[:\-]?\s*"
    r"(\w+\s+\d{1,2},?\s*\d{4})",
    re.IGNORECASE,
)


def parse(msg: GmailMessage) -> ParseResult | None:
    body = msg.body_plain or msg.snippet or ""
    if not body:
        return None

    cents = _extract_amount(body) or parse_dollars_to_cents(body)
    if cents is None:
        return None

    posted_date = _extract_date(body) or msg.received_at.date()
    card_last4 = find_card_last4(body) or find_card_last4(msg.subject or "")

    # Detect plan from subject when possible — it's a useful note for
    # the user but not load-bearing.
    plan_hint = None
    subj_lower = (msg.subject or "").lower()
    if "premium" in subj_lower:
        plan_hint = "premium"
    elif "family" in subj_lower:
        plan_hint = "family"
    elif "duo" in subj_lower:
        plan_hint = "duo"

    extra: dict = {
        "vendor": "spotify",
        "service": "streaming",
        "category_hint": "streaming",
    }
    if plan_hint:
        extra["plan"] = plan_hint

    draft = TransactionDraft(
        posted_date=posted_date,
        amount_cents=-abs(cents),
        description_raw="Spotify",
        merchant="Spotify",
        card_last4=card_last4,
        memo=f"Spotify receipt · {msg.subject}" if msg.subject else "Spotify receipt",
        extra=extra,
    )

    return ParseResult(
        parser_name=SPEC.name,
        tags=["transaction", "spotify", "subscription"],
        transaction=draft,
        payload={
            "card_last4": card_last4,
            "subscription_brand_hint": "spotify",
            "monthly_amount_cents": abs(cents),
            "plan": plan_hint,
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


def _extract_date(body: str):
    m = _DATE_RE.search(body)
    if not m:
        return None
    raw = m.group(1).replace(",", "").strip()
    for fmt in ("%b %d %Y", "%B %d %Y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None
