"""Parser: Xfinity statement / bill-ready emails.

Senders  : onlinecommunications@alerts.comcast.net, xfinity@xfinity.com,
           comcast.com variants
Subjects : "Your Xfinity bill is ready", "Your Xfinity statement",
           "Your bill statement for Xfinity", etc.

We extract:
  * Bill amount (cents, *positive* — it's a future outflow, not a movement yet)
  * Due date
  * Statement period (best-effort; often not in the email)

Output shape: no :class:`TransactionDraft` (the money hasn't moved yet).
Instead we populate :attr:`ParseResult.payload` with bill fields and tag
the result ``"bill"`` so the connector knows to route it to the upcoming
bills table (Phase 3) rather than transactions.
"""
from __future__ import annotations

import re
from datetime import datetime

from ..client import GmailMessage
from .base import ParserSpec, ParseResult

SPEC = ParserSpec(
    name="xfinity_bill",
    label="Xfinity — monthly statement",
    from_domains=["alerts.comcast.net", "xfinity.com", "comcast.com", "e.xfinity.com"],
    subject_patterns=[
        r"your\s+xfinity\s+(bill|statement)",
        r"xfinity.*(bill|statement)\s+is\s+ready",
        r"your\s+bill\s+statement",
        r"automatic\s+payment",
    ],
    kind="bill",
    priority=150,
)


_AMOUNT_RE = re.compile(
    r"(?:total\s+due|amount\s+due|balance\s+due|your\s+bill\s+is|total\s+amount)"
    r"[^\$]{0,40}\$\s*([0-9][0-9,]*\.[0-9]{2})",
    re.IGNORECASE,
)

_DUE_RE = re.compile(
    r"(?:due\s+(?:by|on|date)|due)\s*[:\-]?\s*"
    r"(\w+\s+\d{1,2},?\s*\d{4})",
    re.IGNORECASE,
)

# Fallback: accept a bare $X.XX if we found no labeled amount. Xfinity
# frequently includes the total right after the greeting.
_FIRST_DOLLAR_RE = re.compile(r"\$\s*([0-9][0-9,]*\.[0-9]{2})")


def parse(msg: GmailMessage) -> ParseResult | None:
    body = msg.body_plain or msg.snippet or ""
    if not body:
        return None

    cents = _extract_amount(body)
    if cents is None:
        return None

    due_date = _extract_due_date(body)

    payload = {
        "bill_amount_cents": cents,
        "provider": "Xfinity",
        "due_date": due_date.isoformat() if due_date else None,
        "subject": msg.subject,
    }

    return ParseResult(
        parser_name=SPEC.name,
        tags=["bill", "xfinity", "utility"],
        transaction=None,  # not a movement yet — Bill row lives in Phase 3
        payload=payload,
    )


# ---------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------


def _extract_amount(body: str) -> int | None:
    m = _AMOUNT_RE.search(body)
    if m is None:
        m = _FIRST_DOLLAR_RE.search(body)
    if m is None:
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
