"""T2 cross-sender parser: generic financial-account alerts.

Sister to ``subscription_promo``. Where that parser handles
price-changes-and-promos broadcast emails, this one catches the
day-to-day financial alerts every bank / card / lender / brokerage /
credit-monitoring service sends — without needing a per-sender
bespoke parser:

* "Your statement is ready"
* "Payment due in N days"
* "Your credit score is available"
* "Balance update: $X"
* "Large purchase alert"
* "Low balance warning"
* "Direct deposit posted"

Bespoke parsers (chase_alerts, amex_alerts, the bureau-report parsers)
still take priority because they extract richer structured data from
their specific senders. This T2 parser fires on the long tail —
Capital One alerts, Discover alerts, smaller banks, brokerage emails,
mortgage servicers — that don't have bespoke implementations yet.

Output shape
------------
Returns a ``ParseResult(kind="misc")`` with a structured ``payload``
describing the alert kind. We deliberately do NOT emit
``TransactionDraft`` — these emails are broadcasts ABOUT activity,
not the activity itself, and the actual transaction will land via
the Plaid sync. Trying to materialize it twice would just create
duplicates the dedupe layer would have to clean up.

If the email body doesn't contain enough structured detail for any
of our patterns, we return None and let the message fall through to
ignored — same convention as the other parsers.
"""
from __future__ import annotations

import re

from ..client import GmailMessage
from .base import ParseResult, ParserSpec, parse_dollars_to_cents


# ---------------------------------------------------------------------
#  Subject gates
# ---------------------------------------------------------------------

# Each entry is (regex, alert_kind). Regex is matched on the SUBJECT
# (case-insensitive). The first match decides the alert kind. Order
# matters for ambiguous subjects — we prefer the most specific
# interpretation. The "score available" patterns sit at the top so
# generic "Your X is ready" subjects on credit-bureau emails can be
# routed correctly even when the bespoke bureau parser misses them.
_SUBJECT_KINDS: list[tuple[re.Pattern[str], str]] = [
    # Score / report
    (re.compile(r"score\s+(is\s+)?(available|ready|updated)", re.I), "score_available"),
    (re.compile(r"credit\s+report\s+(is\s+)?(available|ready|updated)", re.I), "credit_report"),
    (re.compile(r"new\s+inquiry\s+on\s+your\s+credit", re.I), "credit_inquiry"),
    # Statement / payment lifecycle
    (re.compile(r"(statement|e-statement)\s+(is\s+)?(ready|available|now\s+available)", re.I), "statement_ready"),
    (re.compile(r"your\s+statement\s+is\s+ready", re.I), "statement_ready"),
    (re.compile(r"(?:new|latest)\s+statement", re.I), "statement_ready"),
    (re.compile(r"have\s+a\s+(?:new\s+)?statement", re.I), "statement_ready"),
    (re.compile(r"payment\s+(is\s+)?due", re.I), "payment_due"),
    (re.compile(r"autopay\s+(scheduled|set\s+up|enrolled)", re.I), "autopay_set"),
    (re.compile(r"payment\s+(received|posted|processed|confirmation)", re.I), "payment_posted"),
    (re.compile(r"thank\s+you\s+for\s+your\s+payment", re.I), "payment_posted"),
    # Charge / spend
    (re.compile(r"large\s+(purchase|transaction|charge)\s+(alert|approved)", re.I), "large_charge"),
    (re.compile(r"unusual\s+(activity|charge|sign[-\s]?in)", re.I), "fraud_alert"),
    (re.compile(r"suspicious\s+(activity|charge)", re.I), "fraud_alert"),
    (re.compile(r"transaction\s+(declined|reversed)", re.I), "transaction_decline"),
    # Balance
    (re.compile(r"balance\s+(update|alert|notification)", re.I), "balance_update"),
    (re.compile(r"low\s+balance", re.I), "low_balance"),
    # Income side
    (re.compile(r"direct\s+deposit\s+(posted|received|alert)", re.I), "deposit_posted"),
    (re.compile(r"deposit\s+(posted|received|alert)", re.I), "deposit_posted"),
    # Card lifecycle
    (re.compile(r"card\s+(shipped|on\s+the\s+way|will\s+arrive|has\s+been\s+activated|activated)", re.I), "card_shipment"),
    # Limits
    (re.compile(r"credit\s+limit\s+(increase|decrease|change)", re.I), "credit_limit_change"),
    # Retention / offers (different from subscription_promo's price-change focus)
    (re.compile(r"(?:rewards?|cash\s*back|points)\s+(earned|posted|available)", re.I), "rewards_earned"),
]

# Generic body extractors — tried in order. First successful pull wins
# for that field.
_AMOUNT_RE = re.compile(
    r"\$([0-9][0-9,]*\.[0-9]{2})",
)

_DUE_DATE_RE = re.compile(
    r"(?:due|by|payable)\s+(?:on|date|on\s+or\s+before)?\s*"
    r"(\w+\s+\d{1,2},\s*\d{4}|\d{1,2}/\d{1,2}/\d{4})",
    re.IGNORECASE,
)

_LAST4_RE = re.compile(
    r"(?:ending\s+in|account\s+ending\s+in|card\s+ending\s+in|\.{3}|x)\s*(\d{4})\b",
    re.IGNORECASE,
)


SPEC = ParserSpec(
    name="financial_alert",
    label="Generic financial alert (T2 fallback)",
    from_domains=[],  # wildcard — any sender
    subject_patterns=[pat.pattern for pat, _ in _SUBJECT_KINDS],
    kind="misc",
    # Priority just above subscription_promo (10) but well below the
    # bespoke transaction/report parsers (120-150). If a Chase email
    # has a "statement is ready" subject AND chase_alerts matches its
    # body, chase_alerts wins. If chase_alerts returns None (couldn't
    # extract), this parser still gets a chance to record the kind.
    priority=20,
)


def parse(msg: GmailMessage) -> ParseResult | None:
    subject = msg.subject or ""
    body = msg.body_plain or msg.snippet or ""

    alert_kind = _classify_subject(subject)
    if alert_kind is None:
        # Subject didn't match any of our gates. The spec's
        # subject_patterns should have prevented this, but defend in depth.
        return None

    payload: dict = {"alert_kind": alert_kind, "source": "financial_alert_t2"}

    # Try to pull useful structured data from the body. None of these
    # are required — even just knowing "this email = statement ready
    # for card x1234" is useful UI signal.
    amount_cents = _first_amount(body)
    if amount_cents is not None:
        payload["amount_cents"] = amount_cents

    due_date = _first_due_date(body)
    if due_date is not None:
        payload["due_date"] = due_date

    last4 = _first_last4(body) or _first_last4(subject)
    if last4 is not None:
        payload["card_last4"] = last4

    # Sender info is what makes a long-tail parser useful for the UI:
    # we know "Capital One sent a payment-due alert" even without a
    # bespoke Capital One parser.
    if msg.from_domain:
        payload["from_domain"] = msg.from_domain

    if msg.received_at is not None:
        payload["observed_at"] = msg.received_at.date().isoformat()

    return ParseResult(
        parser_name=SPEC.name,
        tags=["financial_alert", alert_kind],
        transaction=None,
        payload=payload,
    )


# ---------------------------------------------------------------------
#  Helpers (pure, easy to unit-test)
# ---------------------------------------------------------------------


def _classify_subject(subject: str) -> str | None:
    for pat, kind in _SUBJECT_KINDS:
        if pat.search(subject):
            return kind
    return None


def _first_amount(body: str) -> int | None:
    """First $-amount in the body, in cents. Used for balance / amount due."""
    return parse_dollars_to_cents(body)


def _first_due_date(body: str) -> str | None:
    """ISO-format due date if a "due by ..." line is present, else None."""
    m = _DUE_DATE_RE.search(body)
    if not m:
        return None
    raw = m.group(1).strip()
    # Try a few common formats; if none match, return the raw string —
    # downstream code can decide whether to use it as-is.
    from datetime import datetime
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return raw  # uninterpreted but still informative


def _first_last4(text: str) -> str | None:
    m = _LAST4_RE.search(text)
    return m.group(1) if m else None
