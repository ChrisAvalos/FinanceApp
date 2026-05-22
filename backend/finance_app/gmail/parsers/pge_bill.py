"""Parser: Pacific Gas & Electric monthly bill / energy statement.

Senders  : DoNotReply@billpay.pge.com, no-reply@pge.com,
           paperlessbilling@billpay.pge.com
Subjects : "Your PG&E bill is ready", "Your energy statement",
           "Your bill is ready to view"

Body shape (HTML-stripped) — PG&E uses several templates, all converge
on labeled total + due-date fields::

    Your PG&E bill is ready
    Total amount due: $147.32
    Due date: May 22, 2026
    Service period: Mar 22, 2026 - Apr 21, 2026
    Account #: 1234567890

PG&E bills are *future outflows* (bill emails arrive ~3 weeks before
the due date). We emit a `bill` payload with no TransactionDraft —
same shape as `xfinity_bill`. The cash-flow forecast and price-change
detector both consume this payload.
"""
from __future__ import annotations

import re
from datetime import datetime

from ..client import GmailMessage
from .base import ParserSpec, ParseResult, parse_dollars_to_cents

SPEC = ParserSpec(
    name="pge_bill",
    label="PG&E — monthly bill",
    from_domains=["pge.com", "billing.pge.com", "billpay.pge.com"],
    subject_patterns=[
        r"energy\s+statement",
        r"your\s+pg&?e\s+bill",
        r"bill\s+is\s+ready",
        r"(monthly|new)\s+statement",
    ],
    kind="bill",
    priority=150,
)


_AMOUNT_RE = re.compile(
    r"(?:total\s+amount\s+due|amount\s+due|balance\s+due|total\s+due|your\s+bill\s+is)"
    r"[^\$]{0,40}\$\s*([0-9][0-9,]*\.[0-9]{2})",
    re.IGNORECASE,
)
_DUE_RE = re.compile(
    r"(?:due\s+(?:by|on|date)|due)\s*[:\-]?\s*(\w+\s+\d{1,2},?\s*\d{4})",
    re.IGNORECASE,
)


def parse(msg: GmailMessage) -> ParseResult | None:
    body = msg.body_plain or msg.snippet or ""
    if not body:
        return None

    cents = _extract_amount(body)
    if cents is None:
        # Fallback: a marketing email with no labeled total isn't a bill.
        # We refuse rather than guess from any old "$" sequence — getting
        # the bill amount wrong would mess up the cashflow forecast.
        return None

    due_date = _extract_due_date(body)
    payload = {
        "bill_amount_cents": cents,
        "provider": "PG&E",
        "due_date": due_date.isoformat() if due_date else None,
        "subject": msg.subject,
    }

    return ParseResult(
        parser_name=SPEC.name,
        tags=["bill", "pge", "utility", "energy"],
        transaction=None,
        payload=payload,
    )


def _extract_amount(body: str) -> int | None:
    m = _AMOUNT_RE.search(body)
    if not m:
        return None
    try:
        return int(round(float(m.group(1).replace(",", "")) * 100))
    except ValueError:
        return None


def _extract_due_date(body: str):
    m = _DUE_RE.search(body)
    if not m:
        return None
    raw = m.group(1).replace(",", "").strip()
    for fmt in ("%b %d %Y", "%B %d %Y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None
