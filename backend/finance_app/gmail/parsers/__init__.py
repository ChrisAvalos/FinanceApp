"""Parser registry — maps Gmail messages to the right extractor.

How parsers are registered
--------------------------

Each parser module exposes ``SPEC`` (a :class:`ParserSpec`) and a
``parse(msg)`` function. Importing this package auto-discovers them via
an explicit :data:`_PARSER_MODULES` list — explicit beats importlib magic
because it keeps the set of live parsers grep-able from a single spot.

Adding a new parser: drop a file under this folder, implement
``SPEC``/``parse``, add the import to :data:`_PARSER_MODULES` below.

Dispatch
--------

:func:`dispatch` tries every matching parser in descending priority order
and returns the first :class:`ParseResult` produced. Parsers that return
``None`` are treated as "not mine, try the next one."

Search queries
--------------

:func:`build_search_query` joins every parser's from-domains into one
big Gmail search so the connector only fetches mail from senders we can
actually handle. It's the cheapest place to filter — fewer API round-trips
than fetching + discarding irrelevant mail.
"""
from __future__ import annotations

import logging
from typing import Iterable

from ..client import GmailMessage
from .base import ParseResult, ParserSpec

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
#  Active parser set — edit this when adding parsers
# ----------------------------------------------------------------------

# Order doesn't matter functionally (priority is stored on SPEC), but
# grouping by kind makes this list easy to read. Pilot parsers (fully
# implemented) come first; stubs are below them so you can tell at a
# glance what's working vs. what's stubbed out.
_PARSER_MODULES: list[str] = [
    # ---- Bank/card transaction alerts (T1 — bespoke) ----
    "chase_alerts",
    "amex_alerts",
    "bofa_alerts",         # promoted from stub 2026-05-06 (Wave D-5)
    "wells_fargo_alerts",  # promoted from stub 2026-05-06 (Wave D-5)
    # ---- Bills (T1 — bespoke) ----
    "xfinity_bill",
    "pge_bill",            # promoted from stub 2026-05-06 (Wave D-5)
    "water_bill",          # promoted from stub 2026-05-06 (Wave D-5)
    # ---- Subscription receipts (T1 — bespoke) ----
    "netflix_receipt",     # promoted from stub 2026-05-06 (Wave D-5)
    "spotify_receipt",     # promoted from stub 2026-05-06 (Wave D-5)
    "apple_receipt",       # added 2026-05-07 (Wave F-2) — composite line items
    "google_play_receipt", # added 2026-05-12 (Wave F-3) — Google Play receipts
    # ---- Credit-bureau reports (T1 — bespoke) ----
    "credit_karma_report",
    "smart_credit_report",
    "transunion_report",
    "equifax_report",
    "experian_report",
    # ---- Stubs still pending (SPEC only, parse() returns None) ----
    "rocket_money_digest",
    "student_loan_statement",
    # ---- T2 fallback (low priority — runs after bespokes) ----
    "subscription_promo",
    "financial_alert",
]


# ----------------------------------------------------------------------
#  Registry — populated lazily on first use
# ----------------------------------------------------------------------


_registry: list["tuple[ParserSpec, callable]"] | None = None


def _load_registry() -> list[tuple[ParserSpec, callable]]:
    """Import every parser module and collect (SPEC, parse) tuples."""
    global _registry
    if _registry is not None:
        return _registry

    out: list[tuple[ParserSpec, callable]] = []
    for mod_name in _PARSER_MODULES:
        try:
            module = __import__(
                f"finance_app.gmail.parsers.{mod_name}", fromlist=["SPEC", "parse"]
            )
        except Exception:  # broken parser shouldn't take down the whole system
            logger.exception("Failed to import gmail parser %s", mod_name)
            continue
        spec = getattr(module, "SPEC", None)
        parse_fn = getattr(module, "parse", None)
        if spec is None or parse_fn is None:
            logger.warning(
                "Parser %s missing SPEC or parse() — skipping.", mod_name
            )
            continue
        out.append((spec, parse_fn))
    # Sort once: high-priority first so dispatch just walks the list.
    out.sort(key=lambda pair: pair[0].priority, reverse=True)
    _registry = out
    return _registry


def list_parsers() -> list[ParserSpec]:
    """Return every registered ParserSpec (order = dispatch order)."""
    return [spec for spec, _ in _load_registry()]


def iter_matching(msg: GmailMessage) -> Iterable[tuple[ParserSpec, callable]]:
    for spec, fn in _load_registry():
        if spec.matches(msg):
            yield spec, fn


def dispatch(msg: GmailMessage) -> ParseResult | None:
    """Run the first parser that claims this message.

    Returns ``None`` if no parser matched on headers OR every matched
    parser returned ``None`` (meaning the message looks right at the
    envelope level but isn't actually a shape this parser handles).
    """
    last_error: Exception | None = None
    for spec, parse_fn in iter_matching(msg):
        try:
            result = parse_fn(msg)
        except Exception as exc:
            logger.exception("Parser %s crashed on message %s", spec.name, msg.gmail_message_id)
            last_error = exc
            # Return a failed result so the row isn't silently re-processed
            # next sync — the connector will tag it ParserOutcome.failed.
            return ParseResult(
                parser_name=spec.name,
                tags=["failed"],
                payload={"error": f"{type(exc).__name__}: {exc}"},
            )
        if result is not None:
            return result

    if last_error is not None:
        # Unreachable given the early return above, but mypy-friendly.
        raise last_error
    return None


def build_search_query(
    *,
    newer_than_days: int | None = 30,
    extra_filters: str | None = None,
) -> str:
    """Compose a Gmail search query covering all known senders.

    Produces something like::

        ((from:chase.com OR from:xfinity.com) OR
         subject:("price update" OR "plan change" OR "30% off"))
        newer_than:30d

    Notes:
    * ``newer_than`` is the most useful filter — keep the fetch small.
    * Wildcard parsers (empty from_domains) widen the fetch via a
      subject-keyword clause. This is what lets the Phase B T2 promo
      parser see "your Adobe plan is increasing to $35" without us having
      a bespoke Adobe parser.
    * We do NOT exclude promotions globally because some parsers (offer
      emails, credit-report summaries) live there. Parsers are cheap; let
      them filter.
    """
    domains: set[str] = set()
    wildcard_subject_keywords: set[str] = set()
    for spec in list_parsers():
        if spec.from_domains:
            for d in spec.from_domains:
                domains.add(d)
        else:
            # Wildcard parser — pull a few representative literal phrases
            # from its subject patterns to widen the Gmail fetch.
            for sub_pat in spec.subject_patterns:
                phrase = _gmail_phrase_for_pattern(sub_pat)
                if phrase:
                    wildcard_subject_keywords.add(phrase)

    if not domains and not wildcard_subject_keywords:
        # No parsers registered — return a query that matches nothing so
        # the connector doesn't accidentally fetch the entire inbox.
        return "from:(__no_parsers_registered__)"

    sender_clause = (
        " OR ".join(f"from:{d}" for d in sorted(domains)) if domains else ""
    )
    subject_clause = (
        " OR ".join(f'subject:"{p}"' for p in sorted(wildcard_subject_keywords))
        if wildcard_subject_keywords
        else ""
    )

    if sender_clause and subject_clause:
        outer = f"(({sender_clause}) OR ({subject_clause}))"
    elif sender_clause:
        outer = f"({sender_clause})"
    else:
        outer = f"({subject_clause})"

    parts = [outer]
    if newer_than_days:
        parts.append(f"newer_than:{newer_than_days}d")
    if extra_filters:
        parts.append(extra_filters)
    return " ".join(parts)


# Pull a literal phrase out of a subject regex so we can use it in Gmail's
# query language. Gmail subject-search isn't regex; we approximate by
# extracting the longest run of words/spaces at the start of each pattern.
_REGEX_LITERAL_RE = __import__("re").compile(r"^([A-Za-z][A-Za-z\s]{2,30})")


def _gmail_phrase_for_pattern(pattern: str) -> str | None:
    """Best-effort: extract a literal phrase from a regex for Gmail search.

    Drops the pattern if it starts with anchors / special chars or has no
    plain-word prefix long enough to be useful.
    """
    cleaned = pattern.replace(r"\s+", " ").replace(r"\s*", " ")
    m = _REGEX_LITERAL_RE.match(cleaned)
    if not m:
        return None
    phrase = " ".join(m.group(1).split())
    if len(phrase) < 4:
        return None
    return phrase


def reset_registry_for_tests() -> None:
    """Drop the cached registry — test-only hook so modules can be re-imported."""
    global _registry
    _registry = None
