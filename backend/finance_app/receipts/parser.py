"""Parse OCR'd receipt text into structured fields.

Receipt format heuristics
-------------------------
The pipeline is designed to be resilient to OCR drift. Real receipts
have wildly different layouts (Costco vs Walmart vs Target vs Whole
Foods), but they share enough structural cues that a small set of
heuristics covers ~80% of cases:

  • The MERCHANT is in the first 5 lines, all-caps, often the longest.
  • The DATE is somewhere in the top half, usually MM/DD/YY or
    MM/DD/YYYY format.
  • LINE ITEMS appear as "name ... price" rows in the middle.
    Most receipts left-align the name and right-align the price; OCR
    output preserves this if `preserve_interword_spaces=1` was set.
  • TOTALS (SUBTOTAL / TAX / TOTAL) appear in the bottom 10 lines,
    keyed by their literal labels.

What we DON'T try to do
-----------------------
We don't OCR-error-correct ("0" vs "O" inside item names), and we
don't normalize weird abbreviations (CHRMN → "Charmin"). Both of
those are jobs for the canonicalizer (Slice B). This parser's job
is to produce structured raw line items the user can correct
in the UI.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date as _date
from datetime import datetime as _dt


@dataclass
class ParsedLineItem:
    """One line on a receipt, post-parse."""
    raw_line: str
    name: str | None = None
    quantity_units: int = 1000  # 1.000 (×1000)
    unit_label: str | None = None
    unit_price_cents: int | None = None
    line_total_cents: int | None = None
    sku: str | None = None
    discount_cents: int | None = None
    item_category: str | None = None


@dataclass
class ParsedReceipt:
    """Structured view of an OCR'd receipt."""
    merchant: str | None = None
    purchase_date: _date | None = None
    subtotal_cents: int | None = None
    tax_cents: int | None = None
    total_cents: int | None = None
    items: list[ParsedLineItem] = field(default_factory=list)
    raw_text: str = ""


# --- Regex patterns ---

# Money: optional $, integer + 2-decimal. Only match end-of-line OR
# preceded by space — avoids hitting timestamps like "$10:30" (rare
# but receipts sometimes embed times next to prices).
_PRICE_RE = re.compile(r"(?<![\d.])\$?(\d+(?:,\d{3})*\.\d{2})\b")

# Lines with item + price separated by spaces/dots.
# Example matches:
#   "TOMATO BASIL SAUCE       4.99"
#   "CHRMN UL TP 24CT      $19.99"
#   "1234 BANANAS 2.5LB      1.78"
_LINE_ITEM_RE = re.compile(
    r"^\s*(?P<name>.+?)\s{2,}.*?\$?(?P<price>\d+(?:,\d{3})*\.\d{2})\s*[A-Z]?\s*$"
)

# Match a "weight × unit_price = total" pattern (Costco does this for
# produce, Whole Foods does this for everything).
_WEIGHT_RE = re.compile(
    r"(?P<qty>\d+(?:\.\d+)?)\s*(?P<unit>lb|oz|kg|g|ea|ct)\s*[@xX]\s*\$?(?P<unit_price>\d+\.\d{2})",
    re.I,
)

# Date: matches 4/15/26, 04/15/2026, 4-15-26, etc.
_DATE_PATTERNS = [
    re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b"),
    re.compile(r"\b(\d{1,2})-(\d{1,2})-(\d{2,4})\b"),
    re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"),
]

# Total / subtotal / tax labels. Variants seen across stores.
_LABELED_AMOUNT_RES: dict[str, re.Pattern[str]] = {
    "subtotal": re.compile(r"\b(?:sub\s*total|subtotal)\b[\s:]*\$?(\d+(?:,\d{3})*\.\d{2})", re.I),
    "tax": re.compile(r"\b(?:tax|sales\s+tax|state\s+tax)\b[\s:]*\$?(\d+(?:,\d{3})*\.\d{2})", re.I),
    "total": re.compile(r"\b(?:grand\s+total|total\s+due|amount\s+due|^total$|^\s*total\b)\b[\s:]*\$?(\d+(?:,\d{3})*\.\d{2})", re.I | re.M),
}

# Lines we should NEVER treat as line items even if they match the
# generic pattern. Catches "SUBTOTAL 12.99" sneaking into the items list.
_NON_ITEM_KEYWORDS: tuple[str, ...] = (
    "subtotal", "sub total", "tax", "total", "balance",
    "tender", "cash", "credit", "debit", "change due",
    "amount due", "auth code", "approval", "card",
    "thank you", "receipt", "savings", "member savings",
)

# "Total savings: $X.XX" / "Member savings: $X.XX" / "You saved $X"
_SAVINGS_RE = re.compile(
    r"\b(?:total\s+savings|member\s+savings|you\s+saved|store\s+savings)\b[\s:]*\$?(\d+(?:,\d{3})*\.\d{2})",
    re.I,
)


def _money_to_cents(s: str) -> int:
    """'12.99' -> 1299. Handles thousands commas."""
    return int(round(float(s.replace(",", "")) * 100))


def _parse_date_candidates(text: str) -> _date | None:
    """Find the first plausible date in the text. Receipts almost always
    have the purchase date in the first half — bias the search there."""
    head = text[:1000]  # top-half-ish
    for pat in _DATE_PATTERNS:
        m = pat.search(head)
        if not m:
            continue
        groups = m.groups()
        try:
            if pat.pattern.startswith(r"\b(\d{4})"):  # YYYY-MM-DD
                y, mo, d = int(groups[0]), int(groups[1]), int(groups[2])
            else:
                mo, d, y = int(groups[0]), int(groups[1]), int(groups[2])
                if y < 100:
                    # 26 → 2026, 99 → 1999. 70 is a reasonable cutoff.
                    y += 2000 if y < 70 else 1900
            return _date(y, mo, d)
        except (ValueError, IndexError):
            continue
    return None


def _detect_merchant(text: str) -> str | None:
    """Heuristic: merchant is in the first 5 non-empty lines, often
    all-caps, longer than 3 chars, and not a phone number/address."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    candidates: list[tuple[int, str]] = []
    for i, ln in enumerate(lines[:7]):
        # Skip phone numbers, addresses, ZIP-codes-y stuff
        if re.search(r"\d{3}[-.\s]\d{3}[-.\s]\d{4}", ln):
            continue
        if len(ln) < 4:
            continue
        # Score: prefer all-caps + early position + reasonable length.
        upper_ratio = sum(1 for c in ln if c.isupper()) / max(1, sum(1 for c in ln if c.isalpha()))
        score = (
            (1 if upper_ratio > 0.7 else 0) * 3
            + (10 - i) * 2  # earlier = better
            + min(len(ln), 30) // 5
        )
        # Penalize lines that look like "STORE #1234" — the bare number
        # is usually a different line. But if both are present in one
        # line, that's the merchant.
        candidates.append((score, ln))
    if not candidates:
        return None
    candidates.sort(reverse=True)
    return candidates[0][1]


def _is_non_item_line(line: str) -> bool:
    low = line.lower().strip()
    return any(k in low for k in _NON_ITEM_KEYWORDS)


def _extract_items(text: str) -> list[ParsedLineItem]:
    items: list[ParsedLineItem] = []
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        if _is_non_item_line(line):
            continue
        m = _LINE_ITEM_RE.match(line)
        if not m:
            continue
        name = m.group("name").strip()
        # Skip if name is a price-only line ("$5.99" alone)
        if not name or _PRICE_RE.fullmatch(name.strip("$ ")):
            continue
        # Strip a leading SKU/UPC if present (Costco / Target).
        sku: str | None = None
        sku_match = re.match(r"^(?P<sku>\d{4,14})\s+(?P<rest>.+)$", name)
        if sku_match:
            sku = sku_match.group("sku")
            name = sku_match.group("rest").strip()
        price_cents = _money_to_cents(m.group("price"))

        # Look for weight × unit_price patterns inside the line
        wm = _WEIGHT_RE.search(line)
        qty_units = 1000
        unit_label: str | None = None
        unit_price_cents: int | None = None
        if wm:
            qty_units = int(round(float(wm.group("qty")) * 1000))
            unit_label = wm.group("unit").lower()
            unit_price_cents = _money_to_cents(wm.group("unit_price"))

        items.append(
            ParsedLineItem(
                raw_line=raw,
                name=name,
                quantity_units=qty_units,
                unit_label=unit_label,
                unit_price_cents=unit_price_cents,
                line_total_cents=price_cents,
                sku=sku,
            )
        )
    return items


def parse_receipt(text: str) -> ParsedReceipt:
    """Top-level: OCR text → structured ParsedReceipt.

    Always returns a populated ``raw_text``; everything else is
    best-effort. Callers should expect that any field may be ``None``.
    """
    if not text:
        return ParsedReceipt(raw_text="")
    out = ParsedReceipt(raw_text=text[:50_000])  # cap stored size

    out.merchant = _detect_merchant(text)
    out.purchase_date = _parse_date_candidates(text)
    out.items = _extract_items(text)

    if (m := _LABELED_AMOUNT_RES["subtotal"].search(text)):
        out.subtotal_cents = _money_to_cents(m.group(1))
    if (m := _LABELED_AMOUNT_RES["tax"].search(text)):
        out.tax_cents = _money_to_cents(m.group(1))
    if (m := _LABELED_AMOUNT_RES["total"].search(text)):
        out.total_cents = _money_to_cents(m.group(1))

    return out


# Sanity helper for the smoke test — round-trips a small synthetic
# receipt and verifies the parser caught the obvious fields.
def _self_test() -> None:
    sample = """
    COSTCO WHOLESALE
    1234 Main St
    San Francisco CA 94105
    415-555-1234

    04/15/2026  10:30 AM

    1234567 CHRMN UL TP 24CT       19.99
    8901234 BANANAS 2.5lb @ 0.99   2.48
    5566778 ALMOND MILK 64OZ        4.99
    9988776 EGGS LRG 18CT           5.49

    SUBTOTAL                       32.95
    TAX                             0.00
    TOTAL                          32.95

    THANK YOU FOR SHOPPING!
    """
    r = parse_receipt(sample)
    assert r.merchant and "COSTCO" in r.merchant.upper(), f"merchant: {r.merchant!r}"
    assert r.purchase_date == _date(2026, 4, 15), f"date: {r.purchase_date}"
    assert r.subtotal_cents == 3295, f"subtotal: {r.subtotal_cents}"
    assert r.total_cents == 3295, f"total: {r.total_cents}"
    assert len(r.items) >= 3, f"items: {len(r.items)}\n{r.items}"
    print("parser._self_test OK")


if __name__ == "__main__":
    _self_test()
