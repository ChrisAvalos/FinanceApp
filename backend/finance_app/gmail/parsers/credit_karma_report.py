"""Parser: Credit Karma weekly/monthly score update.

Senders  : notifications@mail.creditkarma.com, support@creditkarma.com
Subjects : "Your credit score update", "Your weekly TransUnion update",
           "Christopher, your credit score is ready", etc.

Body shape varies wildly by template version — Credit Karma rotates a
few. We extract the FICO/VantageScore number and the score delta if
available, then emit a ``ParseResult(kind="report")`` with the data in
``payload`` so downstream code can convert it into a
:class:`CreditScoreSnapshot` row.

Sign convention does not apply (no money movement).

Score-extraction strategy
-------------------------
1. Look for a labeled "score: 720" / "your score is 720" pattern.
2. Fall back to the highest 3-digit number in the body that's in the
   plausible-FICO range (300-850). Body text often includes other
   numbers (account counts, dollar amounts) so we prefer labeled finds.
3. If we find a delta line ("up 5 points since last month"), capture it
   into ``score_delta``.

If we can't extract a score AT ALL, return None and let the message
land as ignored — better than a confidently-wrong report.
"""
from __future__ import annotations

import re

from ..client import GmailMessage
from .base import ParseResult, ParserSpec

SPEC = ParserSpec(
    name="credit_karma_report",
    label="Credit Karma — score update",
    from_domains=["creditkarma.com", "mail.creditkarma.com"],
    subject_patterns=[
        r"score\s+update",
        r"your\s+credit\s+score",
        r"credit\s+report",
        r"score\s+is\s+ready",
        r"weekly\s+(\w+\s+)?update",
        r"score\s+changed",
        r"new\s+credit\s+score",
    ],
    kind="report",
    priority=120,  # above the T2 fallback, below pilot transaction parsers
)

# Score itself: prefer labeled "your score is 720", "score: 720", etc.
_LABELED_SCORE_RE = re.compile(
    r"(?:your\s+(?:new\s+|current\s+|credit\s+)?score\s+(?:is|of)?\s*"
    r"|credit\s+score[:\s]+"
    r"|vantagescore\s*[:\s]+"
    r"|fico[®\s]*(?:8|9)?\s*[:\s]+"
    r")\s*(\d{3})\b",
    re.IGNORECASE,
)

# Range fallback. FICO + VantageScore both live in 300–850.
_PLAUSIBLE_SCORE_RE = re.compile(r"\b([3-8]\d{2})\b")

# Delta: "up 5 points", "down 3", "+12", etc.
_DELTA_RE = re.compile(
    r"(?:up|increased(?:\s+by)?|gained|\+)\s+(\d{1,3})\s*(?:points?|pts?)?\b"
    r"|(?:down|decreased(?:\s+by)?|dropped|lost|-)\s+(\d{1,3})\s*(?:points?|pts?)?\b",
    re.IGNORECASE,
)

# Bureau hint inside the email body (Credit Karma reports both TU + Equifax).
_BUREAU_HINTS = {
    "transunion": "transunion",
    "equifax": "equifax",
    "experian": "experian",
}


def parse(msg: GmailMessage) -> ParseResult | None:
    body = msg.body_plain or msg.snippet or ""
    if not body:
        return None

    score = _extract_score(body)
    if score is None:
        # Marketing email with no actual score — ignore.
        return None

    delta = _extract_delta(body)
    bureau = _extract_bureau(body, msg.subject or "")

    payload: dict = {
        "score": score,
        "model": "vantage_3",  # Credit Karma's default; refine if body says otherwise
        "source": "credit_karma_email",
    }
    if delta is not None:
        payload["score_delta"] = delta
    if bureau is not None:
        payload["bureau"] = bureau
    if msg.received_at is not None:
        payload["observed_at"] = msg.received_at.date().isoformat()

    return ParseResult(
        parser_name=SPEC.name,
        tags=["report", "credit_score", "credit_karma"],
        transaction=None,
        payload=payload,
    )


# ---------------------------------------------------------------------
#  Helpers (pure — testable)
# ---------------------------------------------------------------------


def _extract_score(body: str) -> int | None:
    """Pick the credit-score figure out of an email body.

    Strategy: prefer labeled forms ("Your score is 720"); fall back to
    the first plausible-range 3-digit number that's NOT preceded by a
    known non-score label (account count, dollar amount, etc.).
    """
    m = _LABELED_SCORE_RE.search(body)
    if m:
        try:
            n = int(m.group(1))
        except ValueError:
            return None
        if 300 <= n <= 850:
            return n

    # Fallback: scan for plausible scores; skip those preceded by "$"
    # (dollar amounts — "$400" would otherwise look like a score).
    for fm in _PLAUSIBLE_SCORE_RE.finditer(body):
        n = int(fm.group(1))
        if not (300 <= n <= 850):
            continue
        # Look at the 2 chars before the match to skip "$XXX".
        start = max(0, fm.start() - 2)
        prefix = body[start : fm.start()]
        if "$" in prefix:
            continue
        return n
    return None


def _extract_delta(body: str) -> int | None:
    """Signed score change ("+5", "-3", "up 12 points", "down 4")."""
    m = _DELTA_RE.search(body)
    if not m:
        return None
    if m.group(1) is not None:  # up branch
        try:
            return int(m.group(1))
        except ValueError:
            return None
    if m.group(2) is not None:  # down branch
        try:
            return -int(m.group(2))
        except ValueError:
            return None
    return None


def _extract_bureau(body: str, subject: str) -> str | None:
    """Which bureau did Credit Karma quote? Default None — caller decides."""
    haystack = (subject + " " + body).lower()
    for keyword, slug in _BUREAU_HINTS.items():
        if keyword in haystack:
            return slug
    return None
