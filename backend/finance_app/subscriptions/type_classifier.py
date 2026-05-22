"""Heuristic type classifier for detected subscriptions.

Phase B uses transaction-only signals (merchant name + assigned category) so
this is just a layered regex/lookup. Confidence is a coarse 0..1 — the more
signals agree, the higher.

Layered logic:
  1. **Strong merchant patterns** — well-known SaaS/streaming/utility names
     map directly with confidence 0.9.
  2. **Category-based fallback** — if the assigned Category slug points at
     a class we already know (subscriptions.streaming → streaming;
     housing.utilities → utilities), use that with confidence 0.7.
  3. **Catch-all** — return ``unknown`` with confidence 0.0 so the UI can
     surface the row for triage.

Why no LLM here: the long-tail of weird merchant names is small, and Chris
will manually re-classify the unknowns from the UI. Per memory, the engine
runs locally with no LLM API costs — heuristics are the right tool.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from finance_app.db.models import SubscriptionType


@dataclass(frozen=True)
class TypeMatch:
    type: SubscriptionType
    confidence: float


# (compiled regex against merchant/description, type, confidence)
# Order matters — first match wins. Keep streaming/SaaS up top because they
# have the highest hit rate in real ledgers.
_MERCHANT_PATTERNS: list[tuple[re.Pattern[str], SubscriptionType, float]] = [
    # Streaming
    (re.compile(r"NETFLIX", re.I), SubscriptionType.streaming, 0.95),
    (re.compile(r"SPOTIFY", re.I), SubscriptionType.streaming, 0.95),
    (re.compile(r"\bHULU\b", re.I), SubscriptionType.streaming, 0.95),
    (re.compile(r"DISNEY\s*(\+|PLUS)?", re.I), SubscriptionType.streaming, 0.9),
    (re.compile(r"HBO\s*(MAX)?|MAX\.COM", re.I), SubscriptionType.streaming, 0.9),
    (re.compile(r"PEACOCK", re.I), SubscriptionType.streaming, 0.9),
    (re.compile(r"YOUTUBE\s*(PREMIUM|TV)?", re.I), SubscriptionType.streaming, 0.85),
    (re.compile(r"PARAMOUNT\s*\+?", re.I), SubscriptionType.streaming, 0.9),
    (re.compile(r"APPLE\s*(TV|MUSIC|ONE)?", re.I), SubscriptionType.streaming, 0.7),
    (re.compile(r"PANDORA|TIDAL|DEEZER", re.I), SubscriptionType.streaming, 0.9),
    (re.compile(r"AMZN\s*PRIME|AMAZON\s*PRIME", re.I), SubscriptionType.streaming, 0.85),
    # SaaS / software
    (re.compile(r"ADOBE", re.I), SubscriptionType.saas, 0.9),
    (re.compile(r"OPENAI|CHATGPT", re.I), SubscriptionType.saas, 0.95),
    (re.compile(r"ANTHROPIC|CLAUDE\.AI", re.I), SubscriptionType.saas, 0.95),
    (re.compile(r"GITHUB", re.I), SubscriptionType.saas, 0.95),
    (re.compile(r"MICROSOFT\s*(365|OFFICE)?", re.I), SubscriptionType.saas, 0.85),
    (re.compile(r"GOOGLE\s*(ONE|WORKSPACE)?", re.I), SubscriptionType.saas, 0.7),
    (re.compile(r"\b1PASSWORD\b|LASTPASS|DASHLANE|BITWARDEN", re.I), SubscriptionType.saas, 0.9),
    (re.compile(r"NOTION|EVERNOTE|OBSIDIAN", re.I), SubscriptionType.saas, 0.9),
    (re.compile(r"FIGMA|SKETCH|CANVA", re.I), SubscriptionType.saas, 0.9),
    (re.compile(r"\bAWS\b|AMAZON\s*WEB", re.I), SubscriptionType.saas, 0.95),
    (re.compile(r"DIGITAL\s*OCEAN|VERCEL|NETLIFY|HEROKU", re.I), SubscriptionType.saas, 0.95),
    # News / media
    (re.compile(r"NYTIMES|NEW\s*YORK\s*TIMES", re.I), SubscriptionType.news_media, 0.95),
    (re.compile(r"WSJ|WALL\s*STREET\s*JOURNAL", re.I), SubscriptionType.news_media, 0.95),
    (re.compile(r"WASHPOST|WASHINGTON\s*POST", re.I), SubscriptionType.news_media, 0.95),
    (re.compile(r"SUBSTACK|PATREON|MEDIUM", re.I), SubscriptionType.news_media, 0.85),
    # Utilities (electric/gas/water/trash)
    (re.compile(r"PG\s*&?\s*E", re.I), SubscriptionType.utilities, 0.95),
    (re.compile(r"\bSDG&?E\b|SOCAL\s*GAS|SOCALGAS|SCE\b", re.I), SubscriptionType.utilities, 0.95),
    (re.compile(r"\bCONED\b|CON\s*EDISON", re.I), SubscriptionType.utilities, 0.95),
    (re.compile(r"WATER\s*(DEPT|UTIL|BILL)?|EBMUD|SFPUC", re.I), SubscriptionType.utilities, 0.9),
    (re.compile(r"WASTE\s*MGMT|REPUBLIC\s*SERVICES|RECOLOGY", re.I), SubscriptionType.utilities, 0.9),
    # Internet
    (re.compile(r"XFINITY|COMCAST", re.I), SubscriptionType.internet, 0.9),
    (re.compile(r"AT&T\s*(FIBER|INTERNET)", re.I), SubscriptionType.internet, 0.9),
    (re.compile(r"SPECTRUM|COX\s*COMMUNICATIONS", re.I), SubscriptionType.internet, 0.9),
    (re.compile(r"FRONTIER|CENTURYLINK|GOOGLE\s*FIBER|SONIC\.NET", re.I), SubscriptionType.internet, 0.9),
    # Telecom (mobile)
    (re.compile(r"T-?MOBILE", re.I), SubscriptionType.telecom, 0.9),
    (re.compile(r"VERIZON\s*(WIRELESS)?", re.I), SubscriptionType.telecom, 0.9),
    (re.compile(r"AT&T\s*(MOBILITY|WIRELESS)", re.I), SubscriptionType.telecom, 0.9),
    (re.compile(r"\bMINT\s*MOBILE\b|GOOGLE\s*FI|VISIBLE\b|CRICKET\s*WIRELESS", re.I), SubscriptionType.telecom, 0.95),
    # Insurance
    (re.compile(r"GEICO|PROGRESSIVE|STATE\s*FARM|ALLSTATE|LIBERTY\s*MUTUAL", re.I), SubscriptionType.insurance, 0.9),
    (re.compile(r"USAA\s*INSURANCE|FARMERS\s*INS", re.I), SubscriptionType.insurance, 0.9),
    (re.compile(r"\bLEMONADE\b|ROOT\s*INSURANCE", re.I), SubscriptionType.insurance, 0.9),
    (re.compile(r"\bAETNA\b|\bCIGNA\b|UNITED\s*HEALTHCARE|KAISER", re.I), SubscriptionType.insurance, 0.85),
    # Fitness
    (re.compile(r"PLANET\s*FITNESS|24\s*HOUR\s*FITNESS|EQUINOX|LA\s*FITNESS", re.I), SubscriptionType.fitness, 0.95),
    (re.compile(r"PELOTON|CLASSPASS|ORANGE\s*THEORY", re.I), SubscriptionType.fitness, 0.95),
    (re.compile(r"\bGYM\b|YOGA\s*STUDIO|CROSSFIT", re.I), SubscriptionType.fitness, 0.7),
    (re.compile(r"STRAVA|MYFITNESSPAL|NIKE\s*RUN", re.I), SubscriptionType.fitness, 0.85),
    # Storage (cloud + physical)
    (re.compile(r"DROPBOX|BACKBLAZE|CARBONITE", re.I), SubscriptionType.storage, 0.95),
    (re.compile(r"PUBLIC\s*STORAGE|EXTRA\s*SPACE|CUBESMART|U-?HAUL\s*STORAGE", re.I), SubscriptionType.storage, 0.95),
    (re.compile(r"ICLOUD", re.I), SubscriptionType.storage, 0.85),
    # Gaming
    (re.compile(r"XBOX\s*(LIVE|GAME\s*PASS)?|MICROSOFT\s*XBOX", re.I), SubscriptionType.gaming, 0.95),
    (re.compile(r"PLAYSTATION\s*(PLUS|NETWORK)?|SONY\s*PSN", re.I), SubscriptionType.gaming, 0.95),
    (re.compile(r"NINTENDO\s*(ONLINE|SWITCH)", re.I), SubscriptionType.gaming, 0.95),
    (re.compile(r"\bSTEAM\b\s*(SUBSCRIPTION)?|EA\s*PLAY", re.I), SubscriptionType.gaming, 0.85),
]


# Category slug → SubscriptionType, used as fallback when no merchant pattern hits.
_CATEGORY_FALLBACK: dict[str, SubscriptionType] = {
    "subscriptions.streaming": SubscriptionType.streaming,
    "subscriptions.software": SubscriptionType.saas,
    "subscriptions.news": SubscriptionType.news_media,
    "housing.internet": SubscriptionType.internet,
    "housing.utilities": SubscriptionType.utilities,
    "transport.insurance": SubscriptionType.insurance,
    "health.fitness": SubscriptionType.fitness,
}


# Coarse "is this likely variable-amount?" — derived from type. The detector
# uses this to decide whether to apply strict (8%) or loose (~50%) tolerance.
VARIABLE_AMOUNT_TYPES: frozenset[SubscriptionType] = frozenset({
    SubscriptionType.utilities,
    SubscriptionType.internet,    # variable due to overage / promo expiration
    SubscriptionType.telecom,     # often roams into overage
    SubscriptionType.insurance,   # tweaked at renewal
})


def classify_type(
    description: str,
    category_slug: str | None = None,
) -> TypeMatch:
    """Classify a recurring outflow into a SubscriptionType.

    ``description`` is the merchant name or the longest cluster description.
    ``category_slug`` is the assigned Category.slug if any.
    """
    text = description or ""
    for pattern, sub_type, conf in _MERCHANT_PATTERNS:
        if pattern.search(text):
            return TypeMatch(type=sub_type, confidence=conf)

    if category_slug and category_slug in _CATEGORY_FALLBACK:
        return TypeMatch(type=_CATEGORY_FALLBACK[category_slug], confidence=0.7)

    return TypeMatch(type=SubscriptionType.unknown, confidence=0.0)


def is_variable_amount_type(sub_type: SubscriptionType) -> bool:
    """Whether a given type is expected to vary by month."""
    return sub_type in VARIABLE_AMOUNT_TYPES
