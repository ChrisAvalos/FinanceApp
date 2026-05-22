"""Item canonicalization — Phase 10 Slice E.

Public entry points
-------------------
``normalize(text)`` -> ``str``
    Lowercase, strip noise, expand known abbreviations, sort tokens.
    Used as the primary similarity key for matching.

``extract_brand(text)`` -> ``str | None``
    Pull a known brand out of raw item text. Falls back to None for
    private-label / generic items.

``extract_size(text)`` -> ``(value, unit, form) | (None, None, form_or_None)``
    Pull "24 ct", "64 fl oz", "1 gal" out of raw item text.

``fuzzy_match(a, b)`` -> ``float``  (0.0 - 1.0)
    Token-set similarity. >= 0.7 = strong match, >= 0.55 = decent.

``canonicalize_unmatched(db)`` -> ``CanonicalizeResult``
    Walks every ReceiptItem with canonical_product_id IS NULL,
    finds-or-creates a CanonicalProduct, persists the link.
    Mirrors the Slice B detector's idempotent pattern.
"""
from .canonicalizer import CanonicalizeResult, canonicalize_unmatched
from .normalizer import (
    extract_brand,
    extract_size,
    fuzzy_match,
    normalize,
)

__all__ = [
    "CanonicalizeResult",
    "canonicalize_unmatched",
    "extract_brand",
    "extract_size",
    "fuzzy_match",
    "normalize",
]
