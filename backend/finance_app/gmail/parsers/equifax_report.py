"""Parser: Equifax score / report update emails.

Senders  : alerts@equifax.com, notifications@equifax.com
Subjects : "Your Equifax credit score is ready", "Score alert",
           "Your credit report has been updated", etc.

Equifax sends fewer score-update emails than Credit Karma (most
people see TU/EQ scores via Credit Karma anyway), but parses the same
way thanks to the shared score-extraction helpers.
"""
from __future__ import annotations

from ..client import GmailMessage
from ._credit_score_helpers import extract_delta, extract_score
from .base import ParseResult, ParserSpec

SPEC = ParserSpec(
    name="equifax_report",
    label="Equifax — score / report update",
    from_domains=["equifax.com", "alerts.equifax.com"],
    subject_patterns=[
        r"score\s+(update|change|alert|is\s+ready)",
        r"credit\s+report\s+(update|ready|alert)",
        r"your\s+credit\s+(score|report)",
        r"new\s+credit\s+score",
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
        "model": "fico8",
        "bureau": "equifax",
        "source": "equifax_email",
    }
    if delta is not None:
        payload["score_delta"] = delta
    if msg.received_at is not None:
        payload["observed_at"] = msg.received_at.date().isoformat()

    return ParseResult(
        parser_name=SPEC.name,
        tags=["report", "credit_score", "equifax"],
        transaction=None,
        payload=payload,
    )
