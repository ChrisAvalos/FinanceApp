"""Parser: Chase card/account transaction alerts.

Senders  : no.reply.alerts@chase.com, alerts@chase.com, various @chase.com
Subjects : "Your single transaction alert from Chase",
           "Your transaction alert from Chase",
           "Transaction above $X — ending in NNNN", etc.

Body shape (plain-text-ish after HTML strip)::

    Account ending in (...1234)
    Amount: $85.42
    Date: Apr 22, 2026 at 10:34 AM ET
    Merchant: STARBUCKS #23455 SEATTLE WA
    Account Type: Credit Card

The body format has shifted a few times over the years — we pull fields
with targeted regexes rather than positional parsing so it's resilient
to template tweaks.

Sign convention: Chase "transaction" alerts are charges (outflow) unless
the subject/body mentions "deposit" or "credit" — in which case we flip.
"""
from __future__ import annotations

import re
from datetime import datetime

from ..client import GmailMessage
from .base import ParserSpec, ParseResult, TransactionDraft, find_card_last4, parse_dollars_to_cents

SPEC = ParserSpec(
    name="chase_alerts",
    label="Chase — transaction alert",
    from_domains=["chase.com"],
    subject_patterns=[
        r"transaction\s+alert",
        r"transaction\s+above",
        r"your\s+.*transaction",
        r"your\s+deposit",
        r"deposit\s+alert",
    ],
    kind="transaction",
    priority=150,  # above the generic fallback but below tightly-targeted overrides
)


# Field extractors — each tries a labeled form first ("Amount: $X") then
# falls back to looser patterns. Ordered so the most reliable regex is first.

_AMOUNT_RE = re.compile(
    r"(?:amount|charge|transaction\s+amount)\s*[:\-]?\s*\$?\s*([0-9][0-9,]*\.[0-9]{2})",
    re.IGNORECASE,
)

_DATE_RE = re.compile(
    r"(?:date|transaction\s+date|posted)\s*[:\-]?\s*"
    r"(\w+\s+\d{1,2},\s*\d{4})",
    re.IGNORECASE,
)

_MERCHANT_RE = re.compile(
    r"(?:merchant|description|made\s+at)\s*[:\-]?\s*(.+)",
    re.IGNORECASE,
)

_INFLOW_HINTS = ("deposit", "credit posted", "refund", "payment received")


def parse(msg: GmailMessage) -> ParseResult | None:
    body = msg.body_plain or msg.snippet or ""
    if not body:
        return None

    # ---- Amount ----
    cents = _extract_amount(body) or parse_dollars_to_cents(body)
    if cents is None:
        # No dollar value → probably a marketing email from Chase, not an alert.
        return None

    # Sign: default outflow, flip if body hints at inflow
    haystack = (msg.subject or "") + " " + body.lower()
    if any(hint in haystack.lower() for hint in _INFLOW_HINTS):
        signed_cents = abs(cents)
    else:
        signed_cents = -abs(cents)

    # ---- Date ----
    posted_date = _extract_date(body) or msg.received_at.date()

    # ---- Merchant / card ----
    merchant = _extract_merchant(body)
    card_last4 = find_card_last4(body) or find_card_last4(msg.subject or "")

    draft = TransactionDraft(
        posted_date=posted_date,
        amount_cents=signed_cents,
        description_raw=merchant or (msg.subject or "Chase alert"),
        merchant=_clean_merchant(merchant) if merchant else None,
        card_last4=card_last4,
        memo=f"Chase alert · {msg.subject}" if msg.subject else "Chase alert",
        extra={"issuer": "chase", "alert_type": "transaction"},
    )

    return ParseResult(
        parser_name=SPEC.name,
        tags=["transaction", "chase"],
        transaction=draft,
        payload={"card_last4": card_last4},
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
    # Grab the rest of that line only (labels often bleed into multi-line content).
    raw = m.group(1).splitlines()[0].strip()
    return raw or None


_MERCHANT_NOISE_RE = re.compile(r"\s*#\d+\s*", re.IGNORECASE)
_MERCHANT_TRAIL_RE = re.compile(r"\s+[A-Z]{2}$")  # trailing state code


def _clean_merchant(raw: str) -> str:
    """Turn ``"STARBUCKS #23455 SEATTLE WA"`` into ``"Starbucks Seattle"``."""
    s = _MERCHANT_NOISE_RE.sub(" ", raw)
    s = _MERCHANT_TRAIL_RE.sub("", s)
    s = " ".join(s.split())
    # Proper-case-ish: keep all-caps brands (IKEA, IBM) but title-case mixed words.
    tokens = []
    for tok in s.split():
        tokens.append(tok if tok.isupper() and len(tok) <= 4 else tok.title())
    return " ".join(tokens)
