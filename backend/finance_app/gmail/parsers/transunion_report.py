"""Parser: TransUnion score / report update emails.

Senders  : noreply@transunion.com, alerts@service.transunion.com
Subjects : "Your TransUnion credit score is ready", "Score change alert"
"""
from __future__ import annotations

from ..client import GmailMessage
from ._credit_score_helpers import extract_delta, extract_score
from .base import ParseResult, ParserSpec

SPEC = ParserSpec(
    name="transunion_report",
    label="TransUnion — score / report update",
    from_domains=["transunion.com", "service.transunion.com"],
    subject_patterns=[
        r"score\s+(update|change|alert|is\s+ready)",
        r"credit\s+report\s+(update|ready|alert)",
        r"your\s+credit\s+(score|report)",
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
        "model": "vantage_3",  # TransUnion most often surfaces VantageScore
        "bureau": "transunion",
        "source": "transunion_email",
    }
    if delta is not None:
        payload["score_delta"] = delta
    if msg.received_at is not None:
        payload["observed_at"] = msg.received_at.date().isoformat()

    return ParseResult(
        parser_name=SPEC.name,
        tags=["report", "credit_score", "transunion"],
        transaction=None,
        payload=payload,
    )
