"""Parser: American Express transaction alerts.

Senders  : *@americanexpress.com, *@aexp.com (e.g. account@americanexpress.com)
Subjects : "Large purchase approved on your account", "A charge was
           approved", "New charge alert", "Your card was used", etc.

Body shape (after HTML strip)::

    A charge of $42.50 was approved at STARBUCKS #2135 SEATTLE WA
    on Apr 22, 2026.
    Account ending in 11003

Signs follow the project convention — charges are negative, refunds
positive. Amex uses 5-digit account suffixes; ``find_card_last5``
locally handles that and we fall back to the chase 4-digit helper for
the cases where Amex truncates to last-4 in subject lines.
"""
from __future__ import annotations

import re
from datetime import datetime

from ..client import GmailMessage
from .base import ParserSpec, ParseResult, TransactionDraft, find_card_last4, parse_dollars_to_cents

SPEC = ParserSpec(
    name="amex_alerts",
    label="American Express — transaction alert",
    from_domains=["americanexpress.com", "aexp.com"],
    subject_patterns=[
        r"large\s+purchase\s+approved",
        r"amex.*purchase",
        r"transaction\s+alert",
        r"charge\s+(approved|alert|was\s+made)",
        r"a\s+charge\s+of",
        r"new\s+charge",
        r"your\s+card\s+was\s+used",
        r"payment\s+received",
        r"return.*credit",
    ],
    kind="transaction",
    priority=150,
)

_AMOUNT_RE = re.compile(
    r"(?:amount|charge\s+of|purchase\s+of|transaction\s+amount|approved\s+for)\s*[:\-]?\s*"
    r"\$?\s*([0-9][0-9,]*\.[0-9]{2})",
    re.IGNORECASE,
)

_DATE_RE = re.compile(
    r"(?:date|on|posted|approved\s+on)\s*[:\-]?\s*(\w+\s+\d{1,2},\s*\d{4})",
    re.IGNORECASE,
)

_MERCHANT_RE = re.compile(
    r"(?:at|merchant|description|made\s+at|approved\s+at)\s*[:\-]?\s*([^\n]+)",
    re.IGNORECASE,
)

# Amex uses 5-digit suffixes for full account, 4-digit suffixes for the
# embossed-card number. Try 5 first, fall back to chase's 4-digit helper.
_LAST5_RE = re.compile(
    r"(?:ending\s+in|account\s+ending(?:\s+in)?|card\s+ending(?:\s+in)?)\s+(\d{5})\b",
    re.IGNORECASE,
)

_INFLOW_HINTS = ("payment received", "credit posted", "refund", "return")


def parse(msg: GmailMessage) -> ParseResult | None:
    body = msg.body_plain or msg.snippet or ""
    if not body:
        return None

    cents = _extract_amount(body) or parse_dollars_to_cents(body)
    if cents is None:
        return None

    haystack = (msg.subject or "") + " " + body
    if any(h in haystack.lower() for h in _INFLOW_HINTS):
        signed_cents = abs(cents)
    else:
        signed_cents = -abs(cents)

    posted_date = _extract_date(body) or msg.received_at.date()

    merchant = _extract_merchant(body)
    last5 = _extract_last5(body) or _extract_last5(msg.subject or "")
    last4 = find_card_last4(body) or find_card_last4(msg.subject or "")

    extra: dict = {"issuer": "amex", "alert_type": "transaction"}
    if last5:
        extra["account_last5"] = last5

    draft = TransactionDraft(
        posted_date=posted_date,
        amount_cents=signed_cents,
        description_raw=merchant or (msg.subject or "Amex alert"),
        merchant=_clean_merchant(merchant) if merchant else None,
        # Map last5 → last4 fallback so downstream account-resolution still works.
        # If we have an Amex 5-digit, use the trailing 4 as the matching key.
        card_last4=last4 or (last5[-4:] if last5 else None),
        memo=f"Amex alert · {msg.subject}" if msg.subject else "Amex alert",
        extra=extra,
    )

    return ParseResult(
        parser_name=SPEC.name,
        tags=["transaction", "amex"],
        transaction=draft,
        payload={"card_last5": last5, "card_last4": last4},
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
    raw = m.group(1).strip()
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%b %d %Y", "%B %d %Y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


def _extract_merchant(body: str) -> str | None:
    m = _MERCHANT_RE.search(body)
    if not m:
        return None
    raw = m.group(1).splitlines()[0].strip()
    # Amex bodies often render "approved at STARBUCKS ... on Apr 22, 2026."
    # Trim everything from " on " onward so we don't carry the date into
    # the merchant slot.
    raw = re.sub(r"\s+on\s+\w+\s+\d{1,2},\s*\d{4}\.?$", "", raw, flags=re.IGNORECASE)
    raw = raw.rstrip(".")
    return raw or None


def _extract_last5(text: str) -> str | None:
    m = _LAST5_RE.search(text)
    return m.group(1) if m else None


_MERCHANT_NOISE_RE = re.compile(r"\s*#\d+\s*", re.IGNORECASE)
_MERCHANT_TRAIL_RE = re.compile(r"\s+[A-Z]{2}$")


def _clean_merchant(raw: str) -> str:
    s = _MERCHANT_NOISE_RE.sub(" ", raw)
    s = _MERCHANT_TRAIL_RE.sub("", s)
    s = " ".join(s.split())
    tokens = []
    for tok in s.split():
        tokens.append(tok if tok.isupper() and len(tok) <= 4 else tok.title())
    return " ".join(tokens)
