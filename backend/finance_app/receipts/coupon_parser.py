"""Coupon / offer extractor for receipts — Phase 10 Slice C.

Real-world receipts almost always have a "footer" section after the
total with one or more of:

  • "Save $X on your next visit. Code: ABCDE"
  • "Take our survey at survey.<store>.com/<code> for $Y off"
  • "20% off all electronics next visit — costco.com/promo2026"
  • "Manufacturer rebate: mail this receipt for $Z back"

This module extracts those into ``ParsedCoupon`` records that the
ingest pipeline persists into ``receipt_coupons``. Each coupon
becomes an opportunity in Money on the Table (Slice C wiring lands
in money_on_table.py).

Approach
--------
1. **Bottom-third bias**: coupons live below the TOTAL line. We skip
   the top 60% of the text (where line items live) so generic dollar
   amounts in the items section don't get false-positived as offer
   values. (A "$19.99 CHRMN UL" line item shouldn't turn into a coupon.)

2. **Per-paragraph scan**: split the footer into "stanzas" (groups of
   lines separated by blank lines or block markers). Each stanza is
   evaluated independently — multiple coupons per receipt are common.

3. **Title-first**: pick a reasonable title from the most info-dense
   line in the stanza (longest non-numeric line). This becomes the
   user-facing label.

4. **Value detection**: scan for "$X off" / "save $X" / "X% off"
   patterns. Percentage offers without a cap get ``estimated_value_cents``
   = NULL — we don't fabricate a number.

5. **Code detection**: standalone alphanumeric tokens of 4-12 chars,
   optionally preceded by "code:" / "promo:". Conservative — we'd
   rather miss a code than mistake a SKU for one.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date as _date

# --- Regex patterns ---

# Money offer: "$5 off", "save $10", "$5.00 off your next..."
_DOLLAR_OFFER_RE = re.compile(
    r"\$(?P<amt>\d+(?:\.\d{2})?)\s*(?:off|back|savings?|coupon|reward|credit)\b",
    re.I,
)
_SAVE_RE = re.compile(
    r"\b(?:save|earn|get)\s+\$(?P<amt>\d+(?:\.\d{2})?)\b",
    re.I,
)

# Percentage offer: "20% off", "20 percent off"
_PCT_OFFER_RE = re.compile(
    r"(?P<pct>\d{1,2})\s*(?:%|percent)\s+(?:off|savings|discount)",
    re.I,
)

# Promo code: "Code: ABC123", "Promo Code XYZ4567", "Use code ABC123"
_CODE_PATTERNS = [
    re.compile(r"\b(?:promo\s*code|coupon\s*code|use\s*code|code)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{3,15})\b", re.I),
    re.compile(r"\benter\s+(?:promo\s+)?code\s+([A-Z0-9][A-Z0-9\-]{3,15})\b", re.I),
]

# Redemption URL — usually a survey or offer landing page.
_URL_RE = re.compile(
    r"\b(?:https?://)?(?:www\.)?(?P<host>[a-z0-9][a-z0-9\-]*\.(?:com|net|org|co|io|us))(?:/[^\s]*)?",
    re.I,
)

# Survey-for-coupon — special case, very common on receipts.
_SURVEY_RE = re.compile(
    r"\b(?:take\s+our\s+survey|complete\s+(?:our|a)\s+survey|tell\s+us\s+about\s+your\s+visit)\b",
    re.I,
)

# Expiration: "Expires MM/DD/YY", "Valid through MM/DD/YYYY", "Use by MM/DD/YYYY"
_EXPIRY_RES = [
    re.compile(r"\b(?:expires?|valid\s+(?:through|until|to)|use\s+by|good\s+through)\s*[:.]?\s*(\d{1,2})/(\d{1,2})/(\d{2,4})\b", re.I),
    re.compile(r"\b(?:expires?|valid\s+(?:through|until|to)|use\s+by|good\s+through)\s*[:.]?\s*(\d{1,2})-(\d{1,2})-(\d{2,4})\b", re.I),
]

# Generic offer / coupon trigger words — at least one must appear in a
# stanza for it to be considered a coupon stanza.
_OFFER_TRIGGERS = re.compile(
    r"\b(?:coupon|promo|offer|discount|rebate|save|savings|reward|"
    r"survey|next\s+(?:visit|purchase|order)|free\s+shipping|"
    r"\$\d+\s+off|\d+%\s+off)\b",
    re.I,
)

# Lines we should treat as the END of the coupon section (footer noise).
_FOOTER_NOISE = re.compile(
    r"\b(?:thank\s+you|have\s+a\s+(?:great|nice)\s+(?:day|night)|"
    r"customer\s+service|return\s+policy|page\s+\d+\s+of\s+\d+)\b",
    re.I,
)

# --- Output ---


@dataclass
class ParsedCoupon:
    title: str
    code: str | None = None
    redemption_url: str | None = None
    estimated_value_cents: int | None = None
    expires_at: _date | None = None
    raw_text: str = ""


def _money_to_cents(s: str) -> int:
    return int(round(float(s) * 100))


def _parse_expiry(text: str) -> _date | None:
    for pat in _EXPIRY_RES:
        m = pat.search(text)
        if not m:
            continue
        try:
            mo, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if y < 100:
                y += 2000 if y < 70 else 1900
            return _date(y, mo, d)
        except (ValueError, IndexError):
            continue
    return None


def _bottom_third(text: str) -> str:
    """Slice off everything before the TOTAL line so we only scan the footer.

    Heuristic: find the LAST occurrence of a "total" label in the text;
    everything after it is the coupon-eligible footer. Falls back to
    the bottom 30% of lines if no TOTAL is detected.
    """
    if not text:
        return ""
    lines = text.splitlines()
    # Walk backwards looking for "TOTAL" / "GRAND TOTAL" / "TOTAL DUE"
    for i in range(len(lines) - 1, -1, -1):
        ln = lines[i].strip().lower()
        if (
            ln.startswith("total")
            or "grand total" in ln
            or "total due" in ln
            or "amount due" in ln
        ):
            return "\n".join(lines[i + 1:])
    # No total label — use bottom 30% as a safe default
    cutoff = max(0, int(len(lines) * 0.7))
    return "\n".join(lines[cutoff:])


def _split_stanzas(footer: str) -> list[str]:
    """Group consecutive non-empty lines into stanzas separated by blanks.

    Stanzas with a footer-noise line get truncated at that line so the
    "Thank you for shopping" banner doesn't drag through into a coupon
    stanza.
    """
    if not footer:
        return []
    stanzas: list[str] = []
    current: list[str] = []
    for line in footer.splitlines():
        if _FOOTER_NOISE.search(line):
            if current:
                stanzas.append("\n".join(current))
                current = []
            continue
        if line.strip():
            current.append(line)
        elif current:
            stanzas.append("\n".join(current))
            current = []
    if current:
        stanzas.append("\n".join(current))
    return [s for s in stanzas if s.strip()]


def _is_coupon_stanza(stanza: str) -> bool:
    """A stanza is a coupon if it contains an offer trigger word."""
    return bool(_OFFER_TRIGGERS.search(stanza))


def _extract_value(text: str) -> int | None:
    """Best-effort dollar value. Tries 'X off' patterns first, then SAVE,
    then percentage (which we don't translate to cents — returns None)."""
    for pat in (_DOLLAR_OFFER_RE, _SAVE_RE):
        m = pat.search(text)
        if m:
            return _money_to_cents(m.group("amt"))
    # Percent — no cents value
    return None


def _extract_code(text: str) -> str | None:
    for pat in _CODE_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(1).upper()
    return None


def _extract_url(text: str) -> str | None:
    """First plausible URL, normalized to https://… form."""
    for m in _URL_RE.finditer(text):
        host = m.group("host").lower()
        # Skip false positives from things that look like domains but aren't
        # offers — e.g., "recycle.com" footer or "store.com/help".
        if host in ("ftc.gov",) or host.startswith("recycle."):
            continue
        path = m.group(0)
        if not path.startswith("http"):
            path = "https://" + path.lstrip("/")
        return path
    return None


def _build_title(stanza: str) -> str:
    """Pick the most descriptive line of the stanza as the title.

    Heuristic: prefer the longest line that isn't a bare URL or a bare
    code line. Cap at 200 chars.
    """
    lines = [ln.strip() for ln in stanza.splitlines() if ln.strip()]
    if not lines:
        return ""
    # Score each line by length — but penalize URL-only and code-only.
    def score(ln: str) -> int:
        if _URL_RE.fullmatch(ln):
            return -100
        if re.fullmatch(r"[A-Z0-9\-]{4,15}", ln):
            return -100
        return min(len(ln), 200)
    lines.sort(key=score, reverse=True)
    return lines[0][:200]


def extract_coupons(receipt_text: str) -> list[ParsedCoupon]:
    """Top-level: receipt OCR text → list of ParsedCoupon.

    Always returns a (possibly empty) list; never raises. Each coupon
    has a title and optional code/url/value/expiry.
    """
    if not receipt_text:
        return []
    footer = _bottom_third(receipt_text)
    if not footer.strip():
        return []
    stanzas = _split_stanzas(footer)
    out: list[ParsedCoupon] = []
    seen_titles: set[str] = set()
    for s in stanzas:
        if not _is_coupon_stanza(s):
            continue
        title = _build_title(s)
        if not title or title.lower() in seen_titles:
            continue
        seen_titles.add(title.lower())
        out.append(
            ParsedCoupon(
                title=title,
                code=_extract_code(s),
                redemption_url=_extract_url(s),
                estimated_value_cents=_extract_value(s),
                expires_at=_parse_expiry(s),
                raw_text=s[:1000],
            )
        )
    return out


# --- Self-test ---


def _self_test() -> None:
    sample = """
    SUBTOTAL                       32.95
    TAX                             0.00
    TOTAL                          32.95

    SAVE $5 ON YOUR NEXT VISIT
    Code: SAVE5NOW
    Expires 5/15/26

    Take our survey at www.costcosurvey.com/12345
    for a chance to win $1000

    20% off all electronics next visit
    Visit costco.com/electronics-2026

    THANK YOU FOR SHOPPING!
    Have a great day!
    """
    coupons = extract_coupons(sample)
    print(f"Extracted {len(coupons)} coupons:")
    for c in coupons:
        print(f"  • {c.title!r}")
        print(f"    code={c.code!r}  url={c.redemption_url!r}  value={c.estimated_value_cents}  expires={c.expires_at}")
    assert len(coupons) >= 2, f"expected ≥2 coupons, got {len(coupons)}"
    save5 = next((c for c in coupons if c.code == "SAVE5NOW"), None)
    assert save5 is not None, "didn't find the SAVE5NOW coupon"
    assert save5.estimated_value_cents == 500, f"value: {save5.estimated_value_cents}"
    assert save5.expires_at == _date(2026, 5, 15), f"expires: {save5.expires_at}"
    print("\ncoupon_parser._self_test OK")


if __name__ == "__main__":
    _self_test()
