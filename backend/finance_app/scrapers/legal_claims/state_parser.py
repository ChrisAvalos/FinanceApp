"""State-eligibility parser for class-action settlements.

Settlemate-inspired: many class actions are state-specific — e.g.
"California residents who purchased X between 2018-2022". Without
state extraction, our UI lumps every listing under one global pile,
which makes the firehose unmanageable. With it, the UI can do what
Settlemate does — chip-row of "California (31), Florida (22), ..."
filters and a per-state breakdown of total pending payouts.

Approach
--------
Bag-of-regex over title + description + eligibility text. The regex
covers the four most common phrasings in TCA / ClassAction.org /
Top Class Actions copy:

  1. "[State] residents" / "residents of [State]"          → state-specific
  2. "purchased in [State]" / "from [State]"               → state-specific (weaker)
  3. "[STATE_CODE] residents" (postal abbr.)               → state-specific
  4. Multi-state: "California, Florida, and Texas residents" → multi-state

If multiple states are detected, the result is a comma-separated list
of postal codes (e.g. ``"CA,FL,TX"``). If no state pattern fires, we
return ``"nationwide"`` — the conservative default that ensures the
listing is visible in the All-states view rather than dropped on the
floor.

The parser is intentionally pessimistic about state-specific tags.
Tagging a nationwide settlement as state-specific would hide it from
users in other states (bad). Tagging a state-specific settlement as
nationwide just shows it everywhere, which is at worst noisy — much
recoverable than the alternative.
"""
from __future__ import annotations

import re
from collections import OrderedDict
from typing import Iterable

# Full state name → postal abbreviation. Keys lowercased for matching;
# we ship all 50 states + DC. ``Puerto Rico`` and territories left out
# because they almost never appear in TCA copy.
_STATE_NAME_TO_CODE: dict[str, str] = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "district of columbia": "DC", "florida": "FL", "georgia": "GA",
    "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN",
    "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
    "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI",
    "minnesota": "MN", "mississippi": "MS", "missouri": "MO", "montana": "MT",
    "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
    "new mexico": "NM", "new york": "NY", "north carolina": "NC",
    "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR",
    "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
    "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
}

_STATE_CODES: set[str] = set(_STATE_NAME_TO_CODE.values())

# Reverse map: postal code → display name (for UI breakdown ranking).
_CODE_TO_NAME: dict[str, str] = {
    code: name.title() for name, code in _STATE_NAME_TO_CODE.items()
}

# Compiled patterns. Each captures the state name/code as group 1.
# Order matters — we run the most specific patterns first so a match
# in "[State] residents" doesn't get clobbered by a weaker
# "from [State]" elsewhere in the text.
_STATE_NAME_RE = re.compile(
    r"\b(" + r"|".join(re.escape(n) for n in _STATE_NAME_TO_CODE.keys()) + r")\b",
    re.I,
)

# Strong patterns: explicit residency requirement. Hits → high confidence.
_STRONG_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"residents?\s+of\s+([A-Za-z][A-Za-z\s]{2,30}?)\b", re.I),
    re.compile(r"\b([A-Za-z][A-Za-z\s]{2,30}?)\s+residents?\b", re.I),
    # "(the\s+)?state of [State]"
    re.compile(r"\bstate\s+of\s+([A-Za-z][A-Za-z\s]{2,30}?)\b", re.I),
]

# Weaker — mention of state in transactional context. Only used as
# tiebreaker when strong patterns don't fire.
_WEAK_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\bpurchased\s+(in|from)\s+([A-Za-z][A-Za-z\s]{2,30}?)\b", re.I),
    re.compile(r"\bsold\s+in\s+([A-Za-z][A-Za-z\s]{2,30}?)\b", re.I),
]

# Phrases that indicate a NATIONWIDE settlement, even if a specific
# state name appears in passing (e.g. "filed in California state
# court" is procedural metadata, not a residency requirement).
_NATIONWIDE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\bnationwide\s+(class|settlement)\b", re.I),
    re.compile(r"\b(all\s+50\s+states|every\s+state)\b", re.I),
    re.compile(r"\b(any\s+state|U\.?S\.?\s+residents?)\b", re.I),
]


def _normalize_candidate(raw: str) -> str | None:
    """Lookup a candidate phrase against the state name dictionary."""
    candidate = raw.strip().lower()
    # Try exact match first
    if candidate in _STATE_NAME_TO_CODE:
        return _STATE_NAME_TO_CODE[candidate]
    # Try first 2-3 words (handles "California consumers", "New York buyers", etc.)
    parts = candidate.split()
    for n in (3, 2, 1):
        if len(parts) >= n:
            head = " ".join(parts[:n])
            if head in _STATE_NAME_TO_CODE:
                return _STATE_NAME_TO_CODE[head]
    # 2-letter postal code in caps?
    upper = raw.strip().upper()
    if upper in _STATE_CODES:
        return upper
    return None


def extract_states(*texts: str) -> str:
    """Return ``"nationwide"`` or a comma-separated list like ``"CA,FL"``.

    Concatenates all input texts and runs the patterns. If a nationwide
    phrase is found, returns ``"nationwide"`` immediately (those phrases
    are unambiguous). Otherwise collects state codes from strong + weak
    patterns and returns them comma-separated, deduped.
    """
    blob = " ".join(t for t in texts if t).strip()
    if not blob:
        return "nationwide"

    for pat in _NATIONWIDE_PATTERNS:
        if pat.search(blob):
            return "nationwide"

    found: "OrderedDict[str, None]" = OrderedDict()  # ordered set

    for pat in _STRONG_PATTERNS:
        for m in pat.finditer(blob):
            raw_match = m.group(1)
            # Multi-state lists: "Florida and Texas", "California, Florida and Texas".
            # Split on common conjunctions and try each piece as its own
            # candidate so "Residents of Florida and Texas" tags both.
            parts = re.split(r"\s*(?:,|;|\band\b|\bor\b|/)\s*", raw_match, flags=re.I)
            for part in parts:
                code = _normalize_candidate(part)
                if code:
                    found[code] = None
            # Also try the original capture as-is (for names like "New York"
            # that contain a space which would break the split above).
            code = _normalize_candidate(raw_match)
            if code:
                found[code] = None

    if not found:
        for pat in _WEAK_PATTERNS:
            for m in pat.finditer(blob):
                code = _normalize_candidate(m.group(2 if pat.groups >= 2 else 1))
                if code:
                    found[code] = None

    # Last-ditch: scan for explicit state names anywhere AND for
    # multi-state lists like "California, Florida, and Texas residents".
    if not found:
        for m in _STATE_NAME_RE.finditer(blob):
            code = _normalize_candidate(m.group(1))
            if code:
                found[code] = None

    if not found:
        return "nationwide"
    return ",".join(found.keys())


def state_codes_to_names(codes_csv: str) -> list[str]:
    """For UI display — turn ``"CA,FL"`` into ``["California", "Florida"]``."""
    if codes_csv == "nationwide" or not codes_csv:
        return []
    return [_CODE_TO_NAME.get(c.strip().upper(), c.strip().upper()) for c in codes_csv.split(",")]


def split_state_codes(codes_csv: str) -> list[str]:
    """Return the codes from an entry; ``[]`` for nationwide."""
    if codes_csv == "nationwide" or not codes_csv:
        return []
    return [c.strip().upper() for c in codes_csv.split(",") if c.strip()]


def matches_state(claim_state_eligibility: str, target_state: str) -> bool:
    """True if a claim with state_eligibility=X applies to a user in target_state.

    Examples:
        matches_state("nationwide", "CA")        → True
        matches_state("CA", "CA")                → True
        matches_state("CA,FL", "CA")             → True
        matches_state("FL", "CA")                → False
        matches_state("CA", "")                  → True (empty target = no filter)
    """
    if not target_state:
        return True
    if claim_state_eligibility == "nationwide":
        return True
    target = target_state.strip().upper()
    return target in split_state_codes(claim_state_eligibility)


# Sanity-check helper — used by the tests + the smoke script.
def _all_known_states() -> Iterable[str]:
    return _STATE_CODES
