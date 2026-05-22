"""Parser: Apple monthly purchase receipt.

Senders  : no_reply@email.apple.com (most common variants:
           do_not_reply@apple.com, noreply@apple.com)
Subjects : "Your receipt from Apple", "Your receipt #...",
           "Your invoice from Apple", "Subscription renewal"

Why this parser is different
----------------------------
Most Gmail parsers extract a *single* transaction. Apple's monthly
receipt enumerates several line items — one per app/subscription
charged in that billing cycle. We want to capture *all* of them so the
composite-charge unmasker on the Subscriptions panel can auto-populate
the children of the Apple parent.

The connector's existing TransactionDraft schema only carries one
entry, so we use the ``payload`` dict to ferry the full line-item list
back to the caller, like ``payload = {"composite": "apple", "line_items": [...]}``.
The caller (in this codebase, ``apply_pending_signals`` or a
followup reconciler in subscriptions/) is responsible for matching the
parent Subscription row by name (APPLE.COM/BILL etc.) and adding
child rows.

Body shape (HTML-stripped, abridged)::

    Apple
    Receipt
    Date: Apr 22, 2026

    iCloud+ (50 GB)            Monthly                  $0.99
    Calm                       1-Year Subscription      $69.99
    Apple Music — Individual   Monthly                  $10.99
    Peacock Premium            Monthly                  $14.99
    NYTimes                    Monthly                  $4.25

    Subtotal                                            $101.21
    Tax                                                  $8.30
    TOTAL                                              $109.51

The parser tolerates layout drift: it scans for lines that look like
``<title>  ...  <period>  ...  $<amount>`` (column-positional, but with
flexible whitespace) and emits one line item per match. Subtotal/Tax/
Total rows are filtered out by name.
"""
from __future__ import annotations

import re
from datetime import datetime

from ..client import GmailMessage
from .base import ParserSpec, ParseResult

SPEC = ParserSpec(
    name="apple_receipt",
    label="Apple — purchase receipt",
    from_domains=["email.apple.com", "apple.com"],
    subject_patterns=[
        r"your\s+receipt\s+from\s+apple",
        r"your\s+receipt\s+#\d",
        r"your\s+invoice\s+from\s+apple",
        r"apple.*subscription\s+(renewal|confirmation)",
        r"subscription\s+(confirmation|renewal)",
    ],
    kind="report",
    priority=160,
)


# -- Line-item parsing ------------------------------------------------

# A receipt line looks roughly like:
#   "iCloud+ (50 GB)   Monthly   $0.99"
#   "Apple Music   Subscription   $10.99"
# We grab the first $X.XX on the line as the amount and treat
# everything before the first "Monthly" / "Annual" / "Subscription" /
# "1-Year" / "1-Month" keyword as the title.
_LINE_AMOUNT_RE = re.compile(r"\$\s*([0-9][0-9,]*\.[0-9]{2})")
_PERIOD_KEYWORDS_RE = re.compile(
    r"\b(monthly|annual|annually|yearly|1-year|1-month|6-month|3-month|"
    r"subscription|in-app\s+purchase|renewal|family|individual|student)\b",
    re.IGNORECASE,
)
# Names of total/subtotal/tax rows we want to skip.
_NON_LINE_ITEM_RE = re.compile(
    r"\b(sub\s*total|subtotal|total|tax|gst|vat|order\s+id|order\s+number|invoice|"
    r"billed\s+to|payment\s+method|apple\s+account|store\s+credit)\b",
    re.IGNORECASE,
)

# Receipt-level date row.
_DATE_RE = re.compile(
    r"(?:date|order\s+date|purchase\s+date|billed\s+on)\s*[:\-]?\s*"
    r"(\w+\s+\d{1,2},?\s*\d{4})",
    re.IGNORECASE,
)

# Bottom-line "TOTAL $X.XX" row.
_TOTAL_RE = re.compile(
    r"\b(?:order\s+total|total|grand\s+total)\s*[:\-]?\s*\$?\s*"
    r"([0-9][0-9,]*\.[0-9]{2})",
    re.IGNORECASE,
)


def _parse_amount(s: str) -> int | None:
    try:
        return int(round(float(s.replace(",", "")) * 100))
    except (TypeError, ValueError):
        return None


# Multi-line block parsing — Apple's HTML-to-text conversion produces
# this format per line item:
#   "Peacock TV: Stream TV & Movies"     <- brand (skip)
#   "Peacock Premium (Monthly)"          <- title with period (capture)
#   "Renews June 3, 2026"                <- skip
#   "iPhone"                              <- skip (device)
#   "$10.99"                              <- amount on its own line
_AMOUNT_ONLY_RE = re.compile(r"^\s*\$?\s*([0-9][0-9,]*\.[0-9]{2})\s*$")
# Plan-title marker — parenthetical period info that signals "this
# line is the line-item title": "(Monthly)", "(Annual)", "(1-Year)",
# "(Family)", etc. Highest-confidence anchor for the title line.
_PLAN_PAREN_RE = re.compile(
    r"\(\s*(monthly|annual|annually|yearly|"
    r"\d+-(?:year|month)|family|individual|student|trial)\s*\)",
    re.IGNORECASE,
)
# Lines we want to skip when looking backwards for the title of an
# amount: dates, device names, billing-address rows, and the trailing
# subtotal/tax/total block. Apple receipts sometimes prefix device
# names with the owner's possessive ("Chris's iPad"), so we also
# check for device keywords anywhere in the line (not only at line
# start) when matching against this regex.
_SKIP_BACKWARDS_RE = re.compile(
    r"^("
    r"renews?\b|expires?\b|billed\b|"
    r"subtotal|tax|gst|vat|total|"
    r"order\s+id|document\b|apple\s+account|"
    r"billing\s+and|payment\s+method|visa\b|mastercard\b|amex\b"
    r")",
    re.IGNORECASE,
)
# Device names — matched anywhere in the line so possessives like
# "Chris's iPad" or "John's iPhone 15 Pro" get skipped too. Note
# "apple\s+tv" is here rather than the SKIP_BACKWARDS regex because
# the brand block "Apple TV: Stream TV & Movies" also contains
# "Apple TV" and we don't want to skip the brand line — but the
# device-only row "Apple TV" (no colon, no descriptor) is a skip.
_DEVICE_RE = re.compile(
    r"\b(iphone|ipad|ipod|macbook|imac|mac\s+mini|mac\s+pro|"
    r"apple\s+watch)\b",
    re.IGNORECASE,
)
# Stop processing line items once we hit Subtotal/Total — those rows
# carry $X.XX amounts but are roll-ups, not items. Without this, we'd
# pick up "Subtotal $10.99" as if it were a duplicate Peacock charge.
_TOTAL_SECTION_RE = re.compile(
    r"^(subtotal|tax|gst|vat|order\s+total|total|grand\s+total)\b",
    re.IGNORECASE,
)


def _extract_line_items(body: str) -> list[dict]:
    """Walk the receipt body and return one dict per line item.

    Apple's HTML→text conversion produces a multi-line *block* per
    line item: brand, plan-title (often with "(Monthly)"), renewal
    date, device, then the amount on its own line.

    Algorithm:
      1. Split into lines.
      2. Walk forward; once we hit the Subtotal section, stop. Amounts
         after that are roll-ups, not items.
      3. When we find a line that's *just* a $X.XX amount, scan backwards
         up to 8 non-empty lines to find the plan title. Prefer lines
         with "(Monthly)" / "(Annual)" markers (highest confidence);
         fall back to the nearest non-skip line.
      4. Skip if the resulting title looks like a header/subtotal row.

    Tolerates the legacy single-line format too: an amount and a period
    keyword on the same line still produces a clean line item.
    """
    items: list[dict] = []
    lines = [l.strip() for l in body.splitlines()]
    n = len(lines)
    in_totals_section = False

    for i, line in enumerate(lines):
        if not line:
            continue
        # Once we cross into Subtotal/Total/Tax, every subsequent
        # amount is a roll-up — bail out of line-item collection.
        if _TOTAL_SECTION_RE.match(line):
            in_totals_section = True
        if in_totals_section:
            continue

        # ---- Single-line format (legacy): "Apple Music Monthly $10.99"
        # Detected when one $ amount is on a line with period keywords.
        if not _AMOUNT_ONLY_RE.match(line):
            amounts_inline = _LINE_AMOUNT_RE.findall(line)
            if len(amounts_inline) == 1 and not _NON_LINE_ITEM_RE.search(line):
                amount_cents = _parse_amount(amounts_inline[0])
                if amount_cents is None or amount_cents <= 0:
                    continue
                period_match = _PERIOD_KEYWORDS_RE.search(line)
                if period_match:
                    title = line[: period_match.start()].strip()
                    period = period_match.group(0).lower()
                else:
                    title = line[: line.rfind("$")].strip()
                    period = ""
                title = re.sub(r"[\s\-:|·]+$", "", title)
                if title and 1 < len(title) <= 80:
                    items.append({"title": title, "period": period,
                                  "amount_cents": amount_cents})
            continue

        # ---- Multi-line block format: amount on its own line ----
        m = _AMOUNT_ONLY_RE.match(line)
        amount_cents = _parse_amount(m.group(1))
        if amount_cents is None or amount_cents <= 0:
            continue

        # Walk backwards through up to 8 lines looking for the title.
        # Prefer a line ending in "(Monthly)" / "(Annual)" / etc; fall
        # back to the nearest non-skip line.
        title: str | None = None
        period = ""
        backwards_budget = 8
        for j in range(i - 1, max(-1, i - backwards_budget - 1), -1):
            prev = lines[j]
            if not prev:
                continue
            if _SKIP_BACKWARDS_RE.match(prev):
                continue
            # Skip device-name lines like "iPad", "Chris's iPhone 15"
            # — these appear right above the amount and would be
            # mistaken for the line-item title.
            if _DEVICE_RE.search(prev) and not _PLAN_PAREN_RE.search(prev):
                continue
            # Prefer the parenthetical period marker — strongest signal.
            pm = _PLAN_PAREN_RE.search(prev)
            if pm:
                title = prev[: pm.start()].strip() or prev.strip()
                period = pm.group(1).lower()
                break
            # No parens — accept the first non-skip line. We don't
            # want pure number rows (e.g. "2") or dates as titles.
            if re.fullmatch(r"\d+", prev):
                continue
            if re.fullmatch(r"\w+\s+\d{1,2},?\s*\d{4}", prev):
                continue
            if len(prev) >= 3 and len(prev) <= 80:
                title = prev
                break

        if not title:
            continue
        title = re.sub(r"[\s\-:|·]+$", "", title)
        if _NON_LINE_ITEM_RE.search(title):
            continue
        if len(title) < 2 or len(title) > 80:
            continue
        items.append({"title": title, "period": period,
                      "amount_cents": amount_cents})

    return items


def _extract_receipt_date(body: str, fallback_dt) -> "datetime.date":
    m = _DATE_RE.search(body)
    if m:
        raw = m.group(1).replace(",", "").strip()
        for fmt in ("%b %d %Y", "%B %d %Y"):
            try:
                return datetime.strptime(raw, fmt).date()
            except ValueError:
                continue
    return fallback_dt.date() if hasattr(fallback_dt, "date") else fallback_dt


def parse(msg: GmailMessage) -> ParseResult | None:
    body = msg.body_plain or msg.snippet or ""
    if not body:
        return None

    items = _extract_line_items(body)
    if not items:
        # No line items found — probably a non-receipt apple email
        # (verification code, security alert, marketing). Refuse so a
        # downstream parser can take a shot.
        return None

    receipt_date = _extract_receipt_date(body, msg.received_at)
    total_match = _TOTAL_RE.search(body)
    grand_total_cents = _parse_amount(total_match.group(1)) if total_match else None

    # Carry the full line-item list in payload so the composite-unmask
    # reconciler can populate Apple's children. We deliberately do NOT
    # synthesize a TransactionDraft — the bank already records the
    # parent Apple charge; double-recording would inflate spend.
    return ParseResult(
        parser_name=SPEC.name,
        tags=["apple", "composite_receipt"],
        transaction=None,
        payload={
            "composite": "apple",
            "aggregator_key": "apple_app_store",
            "receipt_date": receipt_date.isoformat(),
            "line_items": items,
            "grand_total_cents": grand_total_cents,
            # Hint string that the reconciler can match against the
            # parent Subscription's name field.
            "parent_match_hints": ["apple.com/bill", "apl*itunes", "itunes.com/bill"],
        },
    )
