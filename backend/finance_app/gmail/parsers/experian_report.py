"""Parser: Experian score / report update emails.

Senders  : support@e.usa.experian.com, notifications@experian.com,
           experian@notifications.experian.com
Subjects : "Christopher, you have scores to view!",
           "Your FICO Score 8 is ready", "Score change alert", etc.

Experian sends both score-summary emails and marketing — the score
extractor returns None on marketing-only mail, which lets the parser
ignore those and surface only real score updates.

Output: ``ParseResult(kind="report")`` with score data in payload.
"""
from __future__ import annotations

from ..client import GmailMessage
from ._credit_score_helpers import extract_delta, extract_score
from .base import ParseResult, ParserSpec

SPEC = ParserSpec(
    name="experian_report",
    label="Experian — score / report update",
    from_domains=[
        "experian.com",
        "e.usa.experian.com",
        "notifications.experian.com",
    ],
    subject_patterns=[
        r"score\s+(update|change|alert|is\s+ready)",
        r"scores?\s+to\s+view",
        r"your\s+credit\s+(score|report)",
        r"fico[®\s]+score",
        r"new\s+credit\s+score",
        r"credit\s+score\s+(updated?|ready)",
    ],
    kind="report",
    priority=120,
)


def parse(msg: GmailMessage) -> ParseResult | None:
    body = msg.body_plain or msg.snippet or ""
    if not body:
        return None

    score = extract_score(body)
    if score is None:
        return None

    delta = extract_delta(body)

    payload: dict = {
        "score": score,
        "model": "fico8",  # Experian's default consumer-facing model
        "bureau": "experian",
        "source": "experian_email",
    }
    if delta is not None:
        payload["score_delta"] = delta
    if msg.received_at is not None:
        payload["observed_at"] = msg.received_at.date().isoformat()

    return ParseResult(
        parser_name=SPEC.name,
        tags=["report", "credit_score", "experian"],
        transaction=None,
        payload=payload,
    )
