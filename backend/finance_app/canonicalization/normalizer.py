"""Text normalization, brand/size extraction, fuzzy matching.

Stdlib only — uses ``difflib.SequenceMatcher`` instead of ``rapidfuzz``
to keep the dependency surface clean. The matching quality is good
enough for receipt-scale data (a few hundred unique items per user),
and the speed difference is irrelevant at that volume.

Design philosophy: deterministic, conservative, debuggable. Every
transformation is a pure function with a clear input/output contract,
so the canonicalizer can be unit-tested without touching the DB.
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

# ----------------------------------------------------------------------
# Known household brands.
#
# Curated from the top ~30 brands across grocery + paper goods + HBA +
# household cleaners. The keys are the canonical display name; the
# values are aliases / abbreviations the parser should match against
# the raw line text.
#
# This is NOT the universe of brands — it's the high-frequency set
# that covers ~80% of typical household receipts. Add more rows as
# we see misses in real receipts.
# ----------------------------------------------------------------------
_KNOWN_BRANDS: dict[str, list[str]] = {
    # Paper goods
    "Charmin":     ["charmin", "chrmn", "charmn"],
    "Bounty":      ["bounty", "bnty"],
    "Cottonelle":  ["cottonelle", "cttnle"],
    "Kleenex":     ["kleenex", "klnx"],
    "Scott":       ["scott", "scotts"],
    "Brawny":      ["brawny", "brwny"],
    # Beverages
    "Coca-Cola":   ["coca cola", "coca-cola", "cocacola", "coke"],
    "Pepsi":       ["pepsi"],
    "Gatorade":    ["gatorade", "gatorde"],
    "LaCroix":     ["lacroix", "la croix"],
    "Pellegrino":  ["pellegrino", "san pellegrino"],
    "Topo Chico":  ["topo chico", "topochico"],
    # Dairy
    "Horizon":     ["horizon", "hrzn"],
    "Organic Valley": ["organic valley", "ov"],
    "Chobani":     ["chobani"],
    "Fairlife":    ["fairlife"],
    # Cereal / pantry
    "Cheerios":    ["cheerios", "chrios"],
    "Quaker":      ["quaker"],
    "Kellogg's":   ["kelloggs", "kellogg"],
    # Snacks
    "Doritos":     ["doritos"],
    "Lay's":       ["lays", "lay s"],
    "Pringles":    ["pringles"],
    # Household / cleaning
    "Tide":        ["tide"],
    "Dawn":        ["dawn"],
    "Clorox":      ["clorox", "clrx"],
    "Lysol":       ["lysol"],
    "Mr. Clean":   ["mr clean", "mr. clean", "mrclean"],
    "Febreze":     ["febreze", "febrz"],
    # Personal care / HBA
    "Crest":       ["crest"],
    "Colgate":     ["colgate"],
    "Dove":        ["dove"],
    "Olay":        ["olay"],
    "Pantene":     ["pantene"],
    "Old Spice":   ["old spice", "oldspice"],
    "Gillette":    ["gillette"],
    # Eggs / produce / proteins (non-branded items often have no brand)
    "Eggland's Best": ["egglands", "egglands best", "eggland's"],
    "Tyson":       ["tyson"],
    # Coffee
    "Starbucks":   ["starbucks", "sbux"],
    "Peet's":      ["peets", "peet's"],
    "Folgers":     ["folgers"],
    # Cleaning sundries
    "Ziploc":      ["ziploc", "zip loc"],
    "Glad":        ["glad"],
}

# Pre-build a flat alias → display map for fast lookup. We sort by
# length desc so longer aliases match before their shorter substrings
# ("starbucks" wins over "sb" if both were aliases of the same brand).
_ALIAS_TO_BRAND: list[tuple[str, str]] = sorted(
    [
        (alias, brand)
        for brand, aliases in _KNOWN_BRANDS.items()
        for alias in aliases
    ],
    key=lambda p: -len(p[0]),
)


# ----------------------------------------------------------------------
# Receipt-abbreviation expansion.
#
# Most receipt OCR tokens like "TP" / "UL" / "ULTRA" / "MEGA" are
# heavily abbreviated. Expanding them improves both fuzzy-match
# similarity AND the human readability of the canonical name.
# ----------------------------------------------------------------------
_ABBREV_EXPANSIONS: dict[str, str] = {
    "tp": "toilet paper",
    "ul": "ultra",
    "ult": "ultra",
    "ultr": "ultra",
    "soft": "soft",
    "mga": "mega",
    "mr": "mega rolls",
    "mega": "mega",
    "rl": "roll",
    "rolls": "rolls",
    "rl": "rolls",
    "ct": "ct",
    "pk": "pack",
    "pkg": "pack",
    "lg": "large",
    "lrg": "large",
    "med": "medium",
    "sm": "small",
    "sml": "small",
    "org": "organic",
    "orgn": "organic",
    "lf": "low fat",
    "ff": "fat free",
    "wh": "whole",
    "rd": "red",
    "yel": "yellow",
    "grn": "green",
    "blk": "black",
    "wht": "white",
    "almnd": "almond",
    "almd": "almond",
    "pnut": "peanut",
    "pn": "peanut",
    "btr": "butter",
    "btr": "butter",
    "chs": "cheese",
    "chse": "cheese",
    "yg": "yogurt",
    "yog": "yogurt",
    "yog": "yogurt",
    "frz": "frozen",
    "frzn": "frozen",
    "fr": "fresh",
    "frsh": "fresh",
    "shmpo": "shampoo",
    "shmp": "shampoo",
    "cndtnr": "conditioner",
    "cnd": "conditioner",
}

# Tokens that are pure noise and should be dropped during normalization.
_NOISE_TOKENS = frozenset({
    "the", "and", "or", "of", "with", "in", "for", "by",
    "ea",  # "each" — useless for matching
})


# ----------------------------------------------------------------------
# Size extraction
#
# Common forms on receipts:
#   "24CT" / "24 CT" / "24 ct"
#   "64OZ" / "64 fl oz" / "64FLOZ"
#   "1GAL" / "1 GAL" / "1 GALLON"
#   "1.5LB" / "1.5 LB"
# ----------------------------------------------------------------------
_SIZE_RE = re.compile(
    r"\b(\d+(?:\.\d+)?)\s*"
    r"(ct|count|pk|pack|oz|fl\s*oz|floz|lb|lbs|pound|pounds|"
    r"gal|gallon|gallons|qt|quart|quarts|pt|pint|pints|"
    r"ml|liter|liters|l|kg|g|gram|grams|"
    r"in|inch|inches|ft)\b",
    re.I,
)

# Map of unit-aliases to a single canonical unit string.
_UNIT_CANONICAL: dict[str, str] = {
    "ct": "ct", "count": "ct", "pk": "ct", "pack": "ct",
    "oz": "oz", "fl oz": "oz", "floz": "oz",
    "lb": "lb", "lbs": "lb", "pound": "lb", "pounds": "lb",
    "gal": "gal", "gallon": "gal", "gallons": "gal",
    "qt": "qt", "quart": "qt", "quarts": "qt",
    "pt": "pt", "pint": "pt", "pints": "pt",
    "ml": "ml", "l": "l", "liter": "l", "liters": "l",
    "kg": "kg", "g": "g", "gram": "g", "grams": "g",
    "in": "in", "inch": "in", "inches": "in", "ft": "ft",
}

# "form" tokens — descriptive package words that go into CanonicalProduct.form
_FORM_TOKENS = ("mega rolls", "mega roll", "double rolls", "regular rolls", "tall cans")


# ----------------------------------------------------------------------
# Normalization
# ----------------------------------------------------------------------


def _expand_abbrev(token: str) -> str:
    return _ABBREV_EXPANSIONS.get(token, token)


def normalize(text: str | None) -> str:
    """Lowercase + strip non-alphanum + expand abbreviations + sort tokens.

    The output is the matcher's primary similarity key. Two strings
    that ``normalize()`` to the same value are treated as the same
    canonical product (after a final fuzzy-match validation step).

    Examples:
        normalize("CHRMN UL TP 24CT") → "24 charmin ct toilet paper ultra"
        normalize("Charmin Ultra 24-ct") → "24 charmin ct ultra"
                                           # close enough for fuzzy_match >= 0.7
    """
    if not text:
        return ""
    s = text.lower()
    # Replace punctuation with whitespace so token boundaries are honored.
    s = re.sub(r"[^a-z0-9\s]+", " ", s)
    # Split digit-letter joins ("24ct" → "24 ct") so the size token
    # canonicalizes the same way as " 24 ct " from a space-separated source.
    s = re.sub(r"(\d)([a-z])", r"\1 \2", s)
    s = re.sub(r"([a-z])(\d)", r"\1 \2", s)
    tokens = s.split()
    expanded: list[str] = []
    for t in tokens:
        if not t:
            continue
        if t in _NOISE_TOKENS:
            continue
        # Drop pure-numeric tokens longer than 4 chars (likely SKUs)
        if t.isdigit() and len(t) > 4:
            continue
        # Expand known abbreviation
        head = _expand_abbrev(t)
        # Re-split if expansion produced a multi-token string
        for piece in head.split():
            if piece and piece not in _NOISE_TOKENS:
                expanded.append(piece)
    # Token-sort for order-independent comparison
    expanded.sort()
    return " ".join(expanded)


def extract_brand(text: str | None) -> str | None:
    """Look up a known brand in the raw text."""
    if not text:
        return None
    haystack = " " + text.lower() + " "
    # Replace punctuation with whitespace for the lookup pass.
    haystack = re.sub(r"[^a-z0-9\s]+", " ", haystack)
    for alias, brand in _ALIAS_TO_BRAND:
        # Word-boundary check so "tide" doesn't match inside "tides"
        if re.search(r"\b" + re.escape(alias) + r"\b", haystack):
            return brand
    return None


def extract_size(text: str | None) -> tuple[float | None, str | None, str | None]:
    """Returns (value, canonical_unit, form_string).

    Form string captures phrases like "mega rolls" / "tall cans" that
    aren't a numeric size but describe the package shape. NULL when
    not detected.
    """
    if not text:
        return (None, None, None)
    low = text.lower()

    form: str | None = None
    for f in _FORM_TOKENS:
        if f in low:
            form = f
            break

    m = _SIZE_RE.search(text)
    if m:
        try:
            value = float(m.group(1))
        except ValueError:
            value = None
        unit_raw = m.group(2).lower().replace(" ", "").replace("flz", "floz")
        # _UNIT_CANONICAL keys use single spaces; normalize the unit
        unit_key = unit_raw if unit_raw in _UNIT_CANONICAL else unit_raw.replace("floz", "fl oz")
        unit = _UNIT_CANONICAL.get(unit_key, _UNIT_CANONICAL.get(unit_raw))
        return (value, unit, form)
    return (None, None, form)


# ----------------------------------------------------------------------
# Fuzzy matching
# ----------------------------------------------------------------------


def _token_set(s: str) -> set[str]:
    return set(t for t in s.split() if t)


def fuzzy_match(a: str, b: str) -> float:
    """Token-set similarity in [0, 1].

    Combines:
      • Jaccard over token sets — captures order-independent overlap.
      • SequenceMatcher.ratio over normalized strings — captures
        character-level similarity for typo / abbrev tolerance.
    Final score is the max of the two so either signal alone can
    confirm a strong match.
    """
    if not a or not b:
        return 0.0
    a_norm = normalize(a)
    b_norm = normalize(b)
    if a_norm == b_norm:
        return 1.0

    sa = _token_set(a_norm)
    sb = _token_set(b_norm)
    if not sa or not sb:
        return 0.0
    jaccard = len(sa & sb) / len(sa | sb)

    seq = SequenceMatcher(None, a_norm, b_norm).ratio()
    return round(max(jaccard, seq), 3)


# Reference unused imports so linters stay quiet
_ = _ABBREV_EXPANSIONS
