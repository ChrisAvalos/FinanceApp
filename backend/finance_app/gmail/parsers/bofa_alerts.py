"""Parser: Bank of America debit/credit card alerts.

Senders  : alerts@bankofamerica.com, customerservice@notification.bankofamerica.com,
           messages-noreply@notification.bankofamerica.com
Subjects : "Card transaction over $X", "Your card was used", "Debit card
           transaction", "Available balance alert", "Direct deposit", etc.

Body shapes (after HTML strip — BofA varies by alert type)::

    Card transaction
    --------------
    Account: Adv Plus Banking - 1234
    Card ending in 5678
    Amount: $42.50
    Merchant: STARBUCKS #2135 SEATTLE WA
    Posted: 04/22/2026

    or

    A purchase of $42.50 was made at STARBUCKS on 04/22/2026
    using your card ending in 5678.

The MM/DD/YYYY date format is unique to BofA among the bank parsers we
support — Chase / Amex / WF use "Apr 22, 2026". We accept both here so
small template tweaks don't break the parser.

Sign convention: outflow by default; flip if subject/body mentions the
deposit / refund hints.
"""
from __future__ import annotations

import re
from datetime import datetime

from ..client import GmailMessage
from .base import ParserSpec, ParseResult, TransactionDraft, find_card_last4, parse_dollars_to_cents

SPEC = ParserSpec(
    name="bofa_alerts",
    label="Bank of America — account alert",
    from_domains=["bankofamerica.com", "bofa.com"],
    subject_patterns=[
        r"alert",
        r"card\s+(transaction|purchase|charge|was\s+used)",
        r"(debit|credit)\s+card\s+transaction",
        r"transaction\s+over",
        r"a\s+(purchase|charge)\s+was",
        r"direct\s+deposit",
        r"deposit\s+posted",
    ],
    kind="transaction",
    priority=150,
)


# Labeled "Amount: $X.XX" comes first; bare "$X.XX was made/charged" second.
_AMOUNT_LABELED_RE = re.compile(
    r"(?:amount|charge|transaction\s+amount|purchase\s+amount)\s*[:\-]?\s*"
    r"\$?\s*([0-9][0-9,]*\.[0-9]{2})",
    re.IGNORECASE,
)

# BofA frequently writes "A purchase of $42.50" with no label before it.
_AMOUNT_NARRATIVE_RE = re.compile(
    r"(?:purchase|charge|transaction)\s+of\s+\$\s*([0-9][0-9,]*\.[0-9]{2})",
    re.IGNORECASE,
)

# BofA dates: prefer MM/DD/YYYY, fall back to "Apr 22, 2026"-style.
_DATE_NUMERIC_RE = re.compile(
    r"(?:posted|date|on)\s*[:\-]?\s*(\d{1,2}/\d{1,2}/\d{2,4})",
    re.IGNORECASE,
)
_DATE_WORDY_RE = re.compile(
    r"(?:posted|date|on)\s*[:\-]?\s*(\w+\s+\d{1,2},\s*\d{4})",
    re.IGNORECASE,
)

_MERCHANT_LABELED_RE = re.compile(
    r"(?:merchant|description|made\s+at|used\s+at)\s*[:\-]?\s*([^\n]+)",
    re.IGNORECASE,
)
# Narrative form: "...was made at STARBUCKS on 04/22/2026"
_MERCHANT_NARRATIVE_RE = re.compile(
    r"(?:purchase|charge|transaction|payment).{0,40}?\s+at\s+([^\n]+?)\s+on\s+\d{1,2}/\d{1,2}/\d{2,4}",
    re.IGNORECASE,
)

_INFLOW_HINTS = (
    "direct deposit",
    "deposit posted",
    "payment received",
    "credit posted",
    "refund",
    "return",
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

    description = merchant or (msg.subject or "Bank of America alert")
    extra: dict = {"issuer": "bofa", "alert_type": "transaction"}
    if is_inflow:
        extra["alert_type"] = "deposit"

    draft = TransactionDraft(
        posted_date=posted_date,
        amount_cents=signed_cents,
        description_raw=description,
        merchant=_clean_merchant(merchant) if merchant else None,
        card_last4=card_last4,
        memo=f"BofA alert · {msg.subject}" if msg.subject else "BofA alert",
        extra=extra,
    )

    return ParseResult(
        parser_name=SPEC.name,
        tags=["transaction", "bofa"],
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
    # Numeric MM/DD/YYYY first — BofA's preferred form.
    m = _DATE_NUMERIC_RE.search(body)
    if m:
        raw = m.group(1).strip()
        for fmt in ("%m/%d/%Y", "%m/%d/%y"):
            try:
                return datetime.strptime(raw, fmt).date()
            except ValueError:
                continue
    # Wordy fallback for cases where BofA bodies use "Apr 22, 2026".
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
    # Labeled form first ("Merchant: STARBUCKS").
    m = _MERCHANT_LABELED_RE.search(body)
    if m:
        raw = m.group(1).splitlines()[0].strip()
        # Trim trailing date if it bled into the merchant line (BofA
        # sometimes puts "STARBUCKS on 04/22/2026" on a single line).
        raw = re.sub(r"\s+on\s+\d{1,2}/\d{1,2}/\d{2,4}\.?$", "", raw, flags=re.IGNORECASE)
        if raw:
            return raw
    # Narrative form ("...was made at STARBUCKS on 04/22/2026").
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
