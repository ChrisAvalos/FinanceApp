"""T2 cross-sender parser: subscription promos + price changes.

This is the *fallback* parser — it runs against ANY sender (no domain gate)
with low priority so bespoke parsers always get first crack. It's the long
tail of "your subscription is changing" emails that come from too many
companies to write a per-sender parser for.

Two signal classes:

* **price_change** — explicit notice of a recurring rate going up
  ("your monthly rate will increase to $15.49 effective May 5"). The
  parser captures the new price; the subscription module's promo applier
  will diff it against the existing ``Subscription.amount_cents`` to
  populate ``prior_amount_cents`` / ``last_amount_cents``.
* **promo** — limited-time offer ("30% off your next 3 months",
  "first month free", "save $5"). Captured as an Offer with the
  detected percent / dollar amount and (when found) a duration in months.

Subject-level gating
--------------------
Without a from-domain filter, we'd run regex on every email in the inbox.
We guardrail that with ``subject_patterns``: the parser only fires on
subjects that include obvious promo/change keywords. Bodies are then
checked for the structured numbers.

Why not also do this from inside the bespoke parsers?
The bespoke parsers are receipt-shaped (one charge → one transaction).
Promo/price-change emails are *broadcasts* — they don't represent a
charge yet. Keeping them in their own parser lets them have their own
output shape (no TransactionDraft) and makes adding new senders
zero-cost: any new domain's promo email gets handled here automatically.
"""
from __future__ import annotations

import re
from typing import Iterator

from ..client import GmailMessage
from .base import ParseResult, ParserSpec


# Subject keywords known to indicate promos or price changes. Match is OR-ed
# at the spec level (case-insensitive). Keep these conservative — false
# positives waste a body-regex pass but don't produce wrong data, since the
# body extraction returns None when no $-amount or %-amount is found.
_SUBJECT_PATTERNS: list[str] = [
    r"price\s+(update|change|increase|adjustment)",
    r"plan\s+(update|change|change\s+is)",
    r"subscription\s+(update|change|price)",
    r"new\s+(price|monthly\s+rate|rate)",
    r"limited[-\s]time",
    r"\d+\s*%\s*off",
    r"save\s*\$\s*\d",
    r"discount\s+on\s+your",
    r"trial\s+(ending|ends|over|will\s+end)",
    r"free\s+month",
    r"renewal\s+notice",
    r"your\s+plan",
]


SPEC = ParserSpec(
    name="subscription_promo",
    label="Subscription promos / price changes (T2 fallback)",
    from_domains=[],          # wildcard — any sender
    subject_patterns=_SUBJECT_PATTERNS,
    kind="offer",
    priority=10,              # runs LAST (bespoke parsers should win first)
)


# Body-level patterns. Each entry: (compiled regex, key on match.group(1))
# Returns the dollar amount as cents.
_PRICE_INCREASE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"increas\w*\s+to\s+\$\s*([0-9][0-9,]*\.?[0-9]{0,2})", re.I),
    re.compile(r"price\s+(?:will\s+)?(?:be|become|rise\s+to|change\s+to)\s+\$\s*([0-9][0-9,]*\.?[0-9]{0,2})", re.I),
    re.compile(r"new\s+(?:monthly\s+)?(?:price|rate)\s+(?:of\s+|is\s+|will\s+be\s+)?\$\s*([0-9][0-9,]*\.?[0-9]{0,2})", re.I),
    re.compile(r"plan\s+will\s+be\s+\$\s*([0-9][0-9,]*\.?[0-9]{0,2})", re.I),
    re.compile(r"updated\s+to\s+\$\s*([0-9][0-9,]*\.?[0-9]{0,2})\s*(?:per|/)\s*month", re.I),
]

# Promo: dollar-off ("save $X")
_PROMO_DOLLAR_RE = re.compile(r"save\s+\$\s*([0-9][0-9,]*\.?[0-9]{0,2})", re.I)
# Promo: percent-off
_PROMO_PERCENT_RE = re.compile(r"(\d{1,2})\s*%\s*off", re.I)
# Promo: free month / N free months
_PROMO_FREE_MONTHS_RE = re.compile(
    r"(?:get\s+(?:your\s+)?)?(?:first\s+(?:(\d+)\s+)?month(?:s)?\s+free|free\s+for\s+(\d+)\s+month|first\s+month\s+free)",
    re.I,
)
# Promo: duration in months ("for the next 3 months")
_PROMO_DURATION_RE = re.compile(r"for\s+(?:the\s+)?(?:next\s+)?(\d+)\s+month", re.I)
# Trial ending
_TRIAL_ENDING_RE = re.compile(r"trial\s+(?:will\s+)?(?:end|expir|over|conclude)", re.I)


def _to_cents(group: str) -> int | None:
    raw = group.replace(",", "").strip()
    if not raw:
        return None
    try:
        return int(round(float(raw) * 100))
    except ValueError:
        return None


def _first_amount(text: str, patterns: list[re.Pattern[str]]) -> int | None:
    for pat in patterns:
        m = pat.search(text)
        if m:
            cents = _to_cents(m.group(1))
            if cents is not None:
                return cents
    return None


def _detect_merchant_hint(msg: GmailMessage) -> str | None:
    """Best-effort merchant hint from the From: address.

    The body might say "your Netflix subscription" but the From: domain is
    the strongest signal — promo emails almost always come from the brand.
    Fall back to None; the applier will then try to match by subject or
    leave the merchant unresolved.
    """
    if not msg.from_domain:
        return None
    # Take the registrable part: 'email.netflix.com' → 'netflix'
    parts = msg.from_domain.split(".")
    if len(parts) >= 2:
        # Last segment is TLD ('com'); second-to-last is brand.
        return parts[-2]
    return parts[0] if parts else None


def parse(msg: GmailMessage) -> ParseResult | None:
    body = msg.body_plain or msg.snippet or ""
    subject = msg.subject or ""
    text = f"{subject}\n{body}"

    payload: dict = {
        "from_domain": msg.from_domain,
        "subject": subject,
    }
    tags: list[str] = []

    # 1) Price increase
    new_price_cents = _first_amount(text, _PRICE_INCREASE_PATTERNS)
    if new_price_cents is not None:
        payload["price_change"] = {
            "new_price_cents": new_price_cents,
            "detected_at": (
                msg.received_at.isoformat() if msg.received_at else None
            ),
        }
        tags.append("price_change")

    # 2) Promo signals — multiple can coexist (e.g. "30% off for 3 months")
    promo: dict = {}
    if (m := _PROMO_DOLLAR_RE.search(text)):
        cents = _to_cents(m.group(1))
        if cents is not None:
            promo["dollars_off_cents"] = cents
    if (m := _PROMO_PERCENT_RE.search(text)):
        try:
            promo["percent_off"] = int(m.group(1))
        except ValueError:
            pass
    if (m := _PROMO_FREE_MONTHS_RE.search(text)):
        # group(1) or group(2) may have a count; default to 1.
        n = m.group(1) or m.group(2)
        try:
            promo["free_months"] = int(n) if n else 1
        except ValueError:
            promo["free_months"] = 1
    if (m := _PROMO_DURATION_RE.search(text)):
        try:
            promo["duration_months"] = int(m.group(1))
        except ValueError:
            pass
    if promo:
        payload["promo"] = promo
        if "promo" not in tags:
            tags.append("promo")

    # 3) Trial ending
    if _TRIAL_ENDING_RE.search(text):
        payload["trial_ending"] = True
        if "trial_ending" not in tags:
            tags.append("trial_ending")

    # If we matched on subject but found nothing structured in the body, bail
    # — let the message land as ignored rather than tagging it noise. This
    # protects the offers/price_changes counts from getting polluted by
    # generic subject-line marketing.
    if not tags:
        return None

    merchant_hint = _detect_merchant_hint(msg)
    if merchant_hint:
        payload["merchant_hint"] = merchant_hint

    return ParseResult(
        parser_name="subscription_promo",
        tags=tags,
        payload=payload,
    )


# --------------------------------------------------------------------
#  Helper for tests / smoke
# --------------------------------------------------------------------


def iter_subject_patterns() -> Iterator[str]:
    """Public for tests so they can confirm the gating set."""
    return iter(_SUBJECT_PATTERNS)
