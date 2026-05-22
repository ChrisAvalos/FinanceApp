"""Parser: generic water utility bill.

Water-utility senders vary by city so we keep the from-domain list empty
and match on subject only. Prioritized *lower* than parsers with a
tighter sender match so domain-specific parsers win when they exist.

Body shape — water utilities are templated similarly to gas/electric::

    Your water bill is ready
    Amount due: $58.42
    Due by: May 15, 2026
    Service period: Mar 1, 2026 - Apr 1, 2026

We're conservative on amount detection because the wildcard-sender
match means random promo emails could match the subject. Requires a
labeled "Amount due" / "Total due" / "Balance due" — refuses to fall
back to a bare $ value the way Xfinity does, since we don't trust the
sender domain.
"""
from __future__ import annotations

import re
from datetime import datetime

from ..client import GmailMessage
from .base import ParserSpec, ParseResult

SPEC = ParserSpec(
    name="water_bill",
    label="Water utility — bill",
    from_domains=[],  # subject-only match — covers municipal utilities by name
    subject_patterns=[
        r"your\s+water\s+bill",
        r"water.*statement",
        r"water\s+utility.*bill",
        r"water\s+(bill|service)\s+is\s+ready",
        r"municipal\s+water",
    ],
    kind="bill",
    priority=60,
)


_AMOUNT_RE = re.compile(
    r"(?:total\s+amount\s+due|amount\s+due|balance\s+due|total\s+due)"
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
        # No labeled amount → refuse. Wildcard sender means we can't
        # afford to guess; the subscription_promo T2 fallback can pick
        # up anything we miss.
        return None

    due_date = _extract_due_date(body)
    payload = {
        "bill_amount_cents": cents,
        "provider": _provider_hint_from_subject(msg.subject or ""),
        "due_date": due_date.isoformat() if due_date else None,
        "subject": msg.subject,
    }

    return ParseResult(
        parser_name=SPEC.name,
        tags=["bill", "water", "utility"],
        transaction=None,
        payload=payload,
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


def _provider_hint_from_subject(subject: str) -> str:
    """Best-effort: pull the utility name out of the subject for display.

    "Your San Francisco Water bill is ready" → "San Francisco Water"
    Falls back to a generic label if nothing useful is found.
    """
    cleaned = re.sub(r"\s+", " ", subject).strip()
    m = re.search(r"([A-Z][\w&\s]+\bWater\b)", cleaned)
    if m:
        return m.group(1).strip()
    return "Water utility"
