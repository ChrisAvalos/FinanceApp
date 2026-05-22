"""Parser interfaces + shared result types.

A *parser* looks at one :class:`GmailMessage` and produces a
:class:`ParseResult`. It's allowed to return ``None`` for "not my message"
so the registry can keep trying other parsers; returning a ParseResult
(even with empty data) means "I claimed this message, here's what I got."

Shape rules we enforce here so the connector doesn't have to:

* ``amount_cents`` follows the project-wide sign convention — negative for
  outflows (debits, bills, card charges), positive for inflows (deposits,
  refunds). Parsers **must** sign-correct before returning.
* ``posted_date`` is the date on which the money moved. For bills where
  the email only shows a due date, use that and set ``tags=["scheduled"]``
  so downstream code knows it's a forecast, not a real movement.
* ``merchant`` is a human-friendly canonical name ("Starbucks", not
  "STARBUCKS #23455 SEATTLE WA").
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Protocol

from ..client import GmailMessage


# ---------------------------------------------------------------------
#  Parser output
# ---------------------------------------------------------------------


@dataclass
class TransactionDraft:
    """Structured data a parser extracted about a single money movement."""

    posted_date: date
    amount_cents: int  # signed: negative = outflow, positive = inflow
    description_raw: str
    merchant: str | None = None
    card_last4: str | None = None
    memo: str | None = None
    # Free-form extras (account suffix, location, category hint, etc.)
    extra: dict = field(default_factory=dict)


@dataclass
class ParseResult:
    """What a parser returns.

    ``transaction`` is optional because some parsers emit things that
    aren't transactions (bills with future due dates, promo offers,
    credit-score updates). The connector decides what to do with each.
    """

    parser_name: str
    tags: list[str] = field(default_factory=list)  # "alert", "statement", "offer", "bill", ...
    transaction: TransactionDraft | None = None
    # For bills: {"bill_amount_cents": 8500, "due_date": "2026-05-15", ...}
    # For offers: {"merchant": "Peacock", "reward_type": "bundle", ...}
    payload: dict = field(default_factory=dict)


# ---------------------------------------------------------------------
#  Parser protocol
# ---------------------------------------------------------------------


class Parser(Protocol):
    """Minimum interface every parser module must implement.

    Parsers are plain modules with two attributes:

      * ``SPEC``:  a :class:`ParserSpec` describing when to try this parser
      * ``parse(msg)`` -> ``ParseResult | None``
    """

    SPEC: "ParserSpec"

    def parse(self, msg: GmailMessage) -> ParseResult | None: ...


@dataclass
class ParserSpec:
    """Declares the senders + subjects a parser cares about.

    Matching is *substring* on domains (so ``"chase.com"`` matches
    ``"alerts@chase.com"`` and ``"no-reply@email.chase.com"``) and *regex*
    on subject (case-insensitive, compiled lazily).

    ``priority`` breaks ties when multiple parsers claim a message —
    higher wins. Default 100; use 200 for a tightly-specific parser that
    should pre-empt a more general one from the same sender.
    """

    name: str
    # Human label shown in UI (e.g. "Chase — card transaction alert")
    label: str
    # Substrings we accept on From: domain. Empty list == wildcard.
    from_domains: list[str] = field(default_factory=list)
    # Regex patterns on Subject (OR-ed). Empty list == match all subjects.
    subject_patterns: list[str] = field(default_factory=list)
    # What kind of output this parser produces; helps the UI group results.
    kind: str = "transaction"  # "transaction" | "bill" | "offer" | "report" | "misc"
    priority: int = 100

    def matches(self, msg: GmailMessage) -> bool:
        if self.from_domains and not any(
            d.lower() in msg.from_domain for d in self.from_domains
        ):
            return False
        if self.subject_patterns:
            subject = msg.subject or ""
            for pat in self.subject_patterns:
                if re.search(pat, subject, re.IGNORECASE):
                    break
            else:
                return False
        return True


# ---------------------------------------------------------------------
#  Small shared helpers parsers reuse
# ---------------------------------------------------------------------


_CURRENCY_RE = re.compile(r"\$[\s]*([0-9][0-9,]*\.[0-9]{2})")


def parse_dollars_to_cents(text: str) -> int | None:
    """Find the first ``$1,234.56``-style value in ``text`` and return cents.

    Returns ``None`` if nothing matched. Callers should sign-correct.
    """
    m = _CURRENCY_RE.search(text)
    if not m:
        return None
    dollars = m.group(1).replace(",", "")
    try:
        return int(round(float(dollars) * 100))
    except ValueError:
        return None


def find_card_last4(text: str) -> str | None:
    """Pull a 4-digit card suffix out of common phrases.

    Handles: "ending in 1234", "card 1234", "...1234", "x1234".
    """
    patterns = [
        r"ending\s+in\s+(\d{4})",
        r"account\s+ending\s+in\s+(\d{4})",
        r"card\s+ending\s+(\d{4})",
        r"\bx(\d{4})\b",
        r"\.\.\.(\d{4})",
        r"\*{2,}(\d{4})",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(1)
    return None
