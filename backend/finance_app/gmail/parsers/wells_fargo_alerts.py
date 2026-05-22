"""Parser: Wells Fargo card / account alerts.

Senders  : alerts@wellsfargo.com, no-reply@wellsfargo.com,
           account.alerts@wellsfargo.com, secure-message@wellsfargo.com
Subjects : "You made a purchase", "Wells Fargo Card Alert", "Your Wells
           Fargo card was used", "Account activity alert", "Direct
           deposit posted", etc.

Body shapes after HTML strip — Wells uses several templates depending on
account type. Two common ones::

    Wells Fargo card alert
    --------------------
    Card ending in 1234
    Amount: $42.50
    Merchant: STARBUCKS #2135 SEATTLE WA
    Date: 04/22/2026

    or

    A purchase of $42.50 was made on 04/22/2026
    at STARBUCKS using your Wells Fargo card ending in 1234.

Wells Fargo uses MM/DD/YYYY dates almost exclusively, with occasional
"April 22, 2026" forms in older templates. We accept both.
"""
from __future__ import annotations

import re
from datetime import datetime

from ..client import GmailMessage
from .base import ParserSpec, ParseResult, TransactionDraft, find_card_last4, parse_dollars_to_cents

SPEC = ParserSpec(
    name="wells_fargo_alerts",
    label="Wells Fargo — account alert",
    from_domains=["wellsfargo.com"],
    subject_patterns=[
        r"you\s+made\s+a\s+purchase",
        r"wells\s+fargo\s+card",
        r"card\s+alert",
        r"account\s+activity",
        r"transaction\s+alert",
        r"direct\s+deposit",
        r"deposit\s+posted",
        r"a\s+purchase\s+was\s+made",
        r"purchase\s+(made|posted)",
        r"debit\s+card\s+transaction",
    ],
    kind="transaction",
    priority=150,
)


_AMOUNT_LABELED_RE = re.compile(
    r"(?:amount|charge|transaction\s+amount|purchase\s+amount)\s*[:\-]?\s*"
    r"\$?\s*([0-9][0-9,]*\.[0-9]{2})",
    re.IGNORECASE,
)
_AMOUNT_NARRATIVE_RE = re.compile(
    r"(?:purchase|charge|transaction)\s+of\s+\$\s*([0-9][0-9,]*\.[0-9]{2})",
    re.IGNORECASE,
)

_DATE_NUMERIC_RE = re.compile(
    r"(?:date|on|posted)\s*[:\-]?\s*(\d{1,2}/\d{1,2}/\d{2,4})",
    re.IGNORECASE,
)
_DATE_WORDY_RE = re.compile(
    r"(?:date|on|posted)\s*[:\-]?\s*(\w+\s+\d{1,2},\s*\d{4})",
    re.IGNORECASE,
)

_MERCHANT_LABELED_RE = re.compile(
    r"(?:merchant|description|made\s+at|used\s+at)\s*[:\-]?\s*([^\n]+)",
    re.IGNORECASE,
)
_MERCHANT_NARRATIVE_RE = re.compile(
    # "was made on 04/22/2026 at STARBUCKS using"  — capture between
    # "at" and either "using" or end-of-line.
    r"\s+at\s+([^\n]+?)(?:\s+using|\s+\.|\s*$)",
    re.IGNORECASE,
)

_INFLOW_HINTS = (
    "direct deposit",
    "deposit posted",
    "payment received",
    "credit posted",
    "refund",
    "return",
    "deposit alert",
)


def parse(msg: GmailMessage) -> ParseResult | None:
    body = msg.body_plain or msg.snippet or ""
    if not body:
        return None

    cents = _extract_amount(body) or parse_dollars_to_cents(body)
    if cents is None:
        return None

    haystack = ((msg.subject or "") + " " + body).lower()
    is_inflow = any(h in haystack for h in _INFLOW_HINTS)
    signed_cents = abs(cents) if is_inflow else -abs(cents)

    posted_date = _extract_date(body) or msg.received_at.date()

    merchant = _extract_merchant(body)
    card_last4 = find_card_last4(body) or find_card_last4(msg.subject or "")

    extra: dict = {"issuer": "wells_fargo", "alert_type": "deposit" if is_inflow else "transaction"}

    draft = TransactionDraft(
        posted_date=posted_date,
        amount_cents=signed_cents,
        description_raw=merchant or (msg.subject or "Wells Fargo alert"),
        merchant=_clean_merchant(merchant) if merchant else None,
        card_last4=card_last4,
        memo=f"Wells Fargo alert · {msg.subject}" if msg.subject else "Wells Fargo alert",
        extra=extra,
    )

    return ParseResult(
        parser_name=SPEC.name,
        tags=["transaction", "wells_fargo"],
        transaction=draft,
        payload={"card_last4": card_last4},
    )


# ---------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------


def _extract_amount(body: str) -> int | None:
    for pat in (_AMOUNT_LABELED_RE, _AMOUNT_NARRATIVE_RE):
        m = pat.search(body)
        if m:
            try:
                return int(round(float(m.group(1).replace(",", "")) * 100))
            except ValueError:
                continue
    return None


def _extract_date(body: str):
    m = _DATE_NUMERIC_RE.search(body)
    if m:
        raw = m.group(1).strip()
        for fmt in ("%m/%d/%Y", "%m/%d/%y"):
            try:
                return datetime.strptime(raw, fmt).date()
            except ValueError:
                continue
    m = _DATE_WORDY_RE.search(body)
    if m:
        raw = m.group(1).strip()
        for fmt in ("%b %d, %Y", "%B %d, %Y"):
            try:
                return datetime.strptime(raw, fmt).date()
            except ValueError:
                continue
    return None


def _extract_merchant(body: str) -> str | None:
    m = _MERCHANT_LABELED_RE.search(body)
    if m:
        raw = m.group(1).splitlines()[0].strip()
        raw = re.sub(r"\s+on\s+\d{1,2}/\d{1,2}/\d{2,4}\.?$", "", raw, flags=re.IGNORECASE)
        if raw:
            return raw
    m = _MERCHANT_NARRATIVE_RE.search(body)
    if m:
        return m.group(1).strip() or None
    return None


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
