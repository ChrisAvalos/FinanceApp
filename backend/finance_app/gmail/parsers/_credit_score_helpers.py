"""Shared score-extraction helpers used by every credit-bureau parser.

Credit Karma, Experian, Equifax, TransUnion all produce score-update
emails with similar shapes — labeled "your score is N", optional delta
("up X points"), score in the 300-850 range. These helpers concentrate
the regex work so each per-bureau parser stays a thin SPEC + 20-line
``parse`` wrapper.

If the score-extraction logic ever needs to handle non-FICO ranges
(e.g. business-credit scores in 0-100), update the constants here once.
"""
from __future__ import annotations

import re

# Both FICO and VantageScore use 300–850.
_SCORE_MIN = 300
_SCORE_MAX = 850

_LABELED_SCORE_RE = re.compile(
    r"(?:your\s+(?:new\s+|current\s+|credit\s+|fico[®\s]*\s+)?score\s+(?:is|of)?\s*"
    r"|credit\s+score[:\s]+"
    r"|vantagescore\s*[:\s]+"
    r"|fico[®\s]*(?:8|9)?\s*[:\s]+"
    r")\s*(\d{3})\b",
    re.IGNORECASE,
)

_PLAUSIBLE_SCORE_RE = re.compile(r"\b([3-8]\d{2})\b")

_DELTA_RE = re.compile(
    r"(?:up|increased(?:\s+by)?|gained|\+)\s+(\d{1,3})\s*(?:points?|pts?)?\b"
    r"|(?:down|decreased(?:\s+by)?|dropped|lost|-)\s+(\d{1,3})\s*(?:points?|pts?)?\b",
    re.IGNORECASE,
)


def extract_score(body: str) -> int | None:
    """Return the credit-score figure, or None.

    Prefers labeled forms over scanning. Fallback skips dollar amounts
    (``$400`` would otherwise look like a score).
    """
    m = _LABELED_SCORE_RE.search(body)
    if m:
        try:
            n = int(m.group(1))
        except ValueError:
            return None
        if _SCORE_MIN <= n <= _SCORE_MAX:
            return n

    for fm in _PLAUSIBLE_SCORE_RE.finditer(body):
        n = int(fm.group(1))
        if not (_SCORE_MIN <= n <= _SCORE_MAX):
            continue
        start = max(0, fm.start() - 2)
        prefix = body[start : fm.start()]
        if "$" in prefix:
            continue
        return n
    return None


def extract_delta(body: str) -> int | None:
    """Signed score change. Up = positive, down = negative, missing = None."""
    m = _DELTA_RE.search(body)
    if not m:
        return None
    if m.group(1) is not None:
        try:
            return int(m.group(1))
        except ValueError:
            return None
    if m.group(2) is not None:
        try:
            return -int(m.group(2))
        except ValueError:
            return None
    return None
