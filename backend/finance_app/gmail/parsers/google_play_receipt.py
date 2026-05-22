"""Parser: Google Play order receipt — Sprint 21 / Wave F-3.

Senders  : googleplay-noreply@google.com (also payments-noreply@google.com)
Subjects : "Your Google Play Order Receipt", "Order receipt from Google Play"

Position vs. the Apple parser
-----------------------------
F-2's :mod:`apple_receipt` exists because Apple bills every subscription
the user has through a single ``APPLE.COM/BILL`` charge — one bank
transaction, many child services. The parser extracts the children so
the composite-charge unmasker can split that parent row.

Google Play works differently. Each subscription generates its own
transaction tagged ``GOOGLE *<service>`` on the bank statement
(``GOOGLE *Spotify``, ``GOOGLE *Calm``, etc.). So we usually DON'T have
a composite to unmask — we have N separate transactions that each
*could* be a subscription row but are easy to misread as one-off
shopping.

What this parser produces, then, is a per-receipt record that the
downstream reconciler can use to:

  1. Match the receipt against the corresponding ``GOOGLE *Service``
     transaction in the bank feed (by date proximity + amount).
  2. Promote that transaction's merchant from "GOOGLE *Spotify" to
     "Spotify" on the subscription row, so the panel shows clean
     service names instead of the Google Play wrapper.
  3. Carry cadence (monthly/annual) for confidence scoring.

Some Google Play receipts DO batch multiple items into one email —
typically when the user buys several apps in a day, or when one renewal
+ one in-app purchase land in the same window. We handle that by
emitting a line-item list (parallel to Apple's payload shape) so the
reconciler code path is the same for both vendors.

Body shape (HTML-stripped, abridged)::

    Google Play

    Order receipt
    Order number: GPA.1234-5678-9012-34567
    Order date: May 5, 2026

    Spotify Premium
    1-month subscription
    Spotify

    $9.99

    Subtotal:                                  $9.99
    Tax:                                        $0.85
    Order total:                              $10.84

    Payment method: Visa ****1234

Batched format::

    Order date: May 5, 2026

    Spotify Premium — 1-month subscription            $9.99
    YouTube Premium — 1-month subscription           $13.99
    Calm — 1-year subscription                       $69.99

    Subtotal:                                        $93.97
    ...
"""
from __future__ import annotations

import re
from datetime import datetime

from ..client import GmailMessage
from .base import ParserSpec, ParseResult


SPEC = ParserSpec(
    name="google_play_receipt",
    label="Google Play — order receipt",
    # ParserSpec.matches does substring containment against the
    # message's `from_domain`. Google Play's receipt mails come from
    # `googleplay-noreply@google.com` and similar — the `from_domain`
    # surfaced by the Gmail client is "google.com", so we list the
    # bare domain. The subject_patterns below are what narrows
    # general google.com mail down to actual receipts; the parse()
    # function has a body sanity check as a final guard.
    from_domains=["google.com"],
    subject_patterns=[
        r"your\s+google\s+play\s+order\s+receipt",
        r"order\s+receipt\s+from\s+google\s+play",
        r"google\s+play.*receipt",
        # Renewal-style subjects sometimes elide the "Receipt" word.
        r"your\s+subscription\s+(?:to|for).*has\s+renewed",
    ],
    kind="report",
    priority=160,  # same tier as apple_receipt; both compete for the
                  # same email shape, parser.matches narrows by sender
)


# ---------------------------------------------------------------------------
#  Regexes — mostly mirrored from apple_receipt for layout parity
# ---------------------------------------------------------------------------

# $9.99 / $14.95 etc. Apple's parser uses the same shape — keep them in
# sync so a generic helper could later merge them.
_LINE_AMOUNT_RE = re.compile(r"\$\s*([0-9][0-9,]*\.[0-9]{2})")
_AMOUNT_ONLY_RE = re.compile(r"^\s*\$?\s*([0-9][0-9,]*\.[0-9]{2})\s*$")

# Cadence keywords that appear right next to titles. "1-month subscription"
# is the dominant Google Play phrasing; we also accept yearly variants.
# IMPORTANT: this is intentionally MORE restrictive than the Apple parser
# — we do NOT include "premium" or "individual" here because those words
# show up in brand titles ("Spotify Premium", "YouTube Premium",
# "Headspace Individual"). The inline-format path uses
# :data:`_INLINE_CADENCE_TRAIL_RE` (anchored at end-of-line) for the
# title/cadence split; this keyword set is only used as a soft signal
# elsewhere.
_PERIOD_KEYWORDS_RE = re.compile(
    r"\b(monthly|annual|annually|yearly|"
    r"\d+-(?:year|month|week)|"
    r"\d+\s*(?:month|year|week)\s*subscription|"
    r"subscription|in-app\s+purchase|renewal|trial)\b",
    re.IGNORECASE,
)

# Cadence phrase anchored at the END of a stripped line. Use this to
# split title from cadence in the inline single-line format:
#   "Spotify Premium - 1-month subscription"  → title "Spotify Premium",
#                                                 cadence "1-month subscription"
# Optional leading dash / em-dash separator. The phrase must hug the
# right edge (after we've already stripped the price).
_INLINE_CADENCE_TRAIL_RE = re.compile(
    r"\s*[-—–]?\s*("
    r"\d+-(?:year|month|week)(?:\s+subscription)?"
    r"|(?:monthly|annual|annually|yearly|weekly)(?:\s+subscription)?"
    r"|\(\s*(?:monthly|annual|annually|yearly|"
    r"\d+-(?:year|month|week)|family|individual)\s*\)"
    r"|subscription"
    r")\s*$",
    re.IGNORECASE,
)

# "(1-month subscription)" parenthetical — strongest title anchor.
_PLAN_PAREN_RE = re.compile(
    r"\(\s*("
    r"monthly|annual|annually|yearly|"
    r"\d+-(?:year|month|week)|"
    r"\d+\s*(?:month|year|week)\s*subscription|"
    r"family|individual|premium|trial"
    r")\s*\)",
    re.IGNORECASE,
)

# A line that consists *entirely* of a cadence phrase. This is the
# Google Play multi-line format anchor: "1-month subscription" or
# "Monthly" alone on its own line, sandwiched between the product
# title above and the developer name below. Matching the WHOLE line
# (with anchors) is the right test — `_PERIOD_KEYWORDS_RE.search` is
# too loose because it would also match the word "Premium" inside
# "Spotify Premium" and treat that as a cadence anchor.
_CADENCE_LINE_RE = re.compile(
    r"^\s*("
    r"\d+-(?:year|month|week)\s+subscription|"
    r"\d+-(?:year|month|week)|"
    r"(?:monthly|annually|yearly|weekly|annual)\s+subscription|"
    r"(?:monthly|annually|yearly|weekly|annual)|"
    r"subscription|in-app\s+purchase"
    r")\s*$",
    re.IGNORECASE,
)

# Subtotal / total / tax / non-item rows.
_NON_LINE_ITEM_RE = re.compile(
    r"\b(sub\s*total|subtotal|total|tax|gst|vat|"
    r"order\s+(?:id|number|total)|invoice|"
    r"billed\s+to|payment\s+method|google\s+account|"
    r"store\s+credit|promotional\s+credit)\b",
    re.IGNORECASE,
)

# Lines to skip when looking *backwards* for a title anchored on an
# amount-only line (matches Apple's _SKIP_BACKWARDS_RE).
_SKIP_BACKWARDS_RE = re.compile(
    r"^("
    r"renews?\b|expires?\b|billed\b|"
    r"subtotal|tax|gst|vat|total|"
    r"order\s+(?:id|number|total|date)|"
    r"google\s+(?:play|account|llc)|"
    r"developer\b|publisher\b|"
    r"billing\s+and|payment\s+method|visa\b|mastercard\b|amex\b"
    r")",
    re.IGNORECASE,
)

# Device keywords appear in some receipts too ("Installed on Pixel 8").
_DEVICE_RE = re.compile(
    r"\b(pixel|nexus|chromebook|android\s+tv|google\s+tv|wear\s+os)\b",
    re.IGNORECASE,
)

# Stop processing once we hit Subtotal — same logic as Apple parser.
_TOTAL_SECTION_RE = re.compile(
    r"^(subtotal|tax|gst|vat|order\s+total|total|grand\s+total)\b",
    re.IGNORECASE,
)

# Receipt-level date row.
_DATE_RE = re.compile(
    r"(?:order\s+date|purchase\s+date|date)\s*[:\-]?\s*"
    r"(\w+\s+\d{1,2},?\s*\d{4})",
    re.IGNORECASE,
)

# Final "Order total: $X.XX" row.
_TOTAL_RE = re.compile(
    r"\b(?:order\s+total|grand\s+total|total)\s*[:\-]?\s*\$?\s*"
    r"([0-9][0-9,]*\.[0-9]{2})",
    re.IGNORECASE,
)


def _parse_amount(s: str) -> int | None:
    try:
        return int(round(float(s.replace(",", "")) * 100))
    except (TypeError, ValueError):
        return None


def _extract_line_items(body: str) -> list[dict]:
    """Walk the receipt body and return one dict per line item.

    Handles both shapes Google Play emits:
      * Single-item per receipt (most common): title, plan, dev,
        then an amount-only line.
      * Batched: title + plan + amount on the same line.

    Algorithm mirrors :func:`apple_receipt._extract_line_items` — once
    we hit the Subtotal/Total block, every subsequent amount is a
    roll-up, not an item.
    """
    items: list[dict] = []
    lines = [l.strip() for l in body.splitlines()]
    in_totals_section = False

    for i, line in enumerate(lines):
        if not line:
            continue
        if _TOTAL_SECTION_RE.match(line):
            in_totals_section = True
        if in_totals_section:
            continue

        # ---- Single-line ("Spotify Premium — 1-month subscription  $9.99")
        if not _AMOUNT_ONLY_RE.match(line):
            amounts_inline = _LINE_AMOUNT_RE.findall(line)
            if len(amounts_inline) == 1 and not _NON_LINE_ITEM_RE.search(line):
                amount_cents = _parse_amount(amounts_inline[0])
                if amount_cents is None or amount_cents <= 0:
                    continue
                # Strip the $X.XX off the right edge.
                price_idx = line.rfind("$")
                left = line[:price_idx].rstrip() if price_idx >= 0 else line
                # Anchor the cadence at the END of `left` — this avoids
                # the bug where a brand-name keyword inside the title
                # (e.g. "Spotify Premium") gets mistaken for the cadence
                # split point. The Apple parser doesn't hit this because
                # Apple receipts use mostly per-line blocks, but Google
                # Play's inline format does.
                trail = _INLINE_CADENCE_TRAIL_RE.search(left)
                if trail:
                    title = left[: trail.start()].rstrip()
                    period = trail.group(1).lower()
                else:
                    title = left
                    period = ""
                # Clean trailing punctuation / dashes used as separators.
                title = re.sub(r"[\s\-:|—·]+$", "", title)
                if title and 1 < len(title) <= 80:
                    items.append({"title": title, "period": period,
                                  "amount_cents": amount_cents})
            continue

        # ---- Multi-line block: amount on its own line ----
        m = _AMOUNT_ONLY_RE.match(line)
        amount_cents = _parse_amount(m.group(1))
        if amount_cents is None or amount_cents <= 0:
            continue

        # Two-pass scan above the amount:
        #
        # Pass 1: find an anchor — either a parenthetical cadence on
        #         the title line ("YouTube Premium (1-month)") or a
        #         cadence-only line ("1-month subscription"). Stop at
        #         skip-section markers (Subtotal/Order ID/etc.).
        # Pass 2: derive the title.
        #         - Parenthetical anchor → title is on the same line.
        #         - Cadence-only anchor → title is the first
        #           non-skip, non-device line ABOVE the cadence line
        #           (developer name is between the cadence and the
        #           amount and gets skipped by the walk direction).
        # Fallback: no anchor → take the nearest non-skip line below.
        backwards_budget = 10
        anchor_j: int | None = None
        anchor_kind: str = ""   # "paren" | "cadence_line"
        anchor_period: str = ""
        anchor_title_inline: str = ""  # set when anchor_kind == "paren"

        # _SKIP_BACKWARDS_RE matches include things like "Google LLC"
        # (developer name) and "Order date" — these should be SKIPPED,
        # not used as a break-out condition, because the title can sit
        # on the other side of them. Mirrors the Apple parser's
        # `continue` semantics.
        for j in range(i - 1, max(-1, i - backwards_budget - 1), -1):
            prev = lines[j]
            if not prev:
                continue
            if _SKIP_BACKWARDS_RE.match(prev):
                continue

            pm = _PLAN_PAREN_RE.search(prev)
            if pm:
                anchor_j = j
                anchor_kind = "paren"
                anchor_period = pm.group(1).lower()
                anchor_title_inline = prev[: pm.start()].strip() or prev.strip()
                break

            if _CADENCE_LINE_RE.match(prev):
                anchor_j = j
                anchor_kind = "cadence_line"
                anchor_period = prev.strip().lower()
                break

        title: str | None = None
        period = ""

        if anchor_kind == "paren":
            title = anchor_title_inline
            period = anchor_period
        elif anchor_kind == "cadence_line":
            period = anchor_period
            # Title is the first usable line ABOVE the cadence anchor.
            assert anchor_j is not None
            for k in range(anchor_j - 1, max(-1, anchor_j - 5), -1):
                prev = lines[k]
                if not prev:
                    continue
                if _SKIP_BACKWARDS_RE.match(prev):
                    continue
                if _DEVICE_RE.search(prev):
                    continue
                if re.fullmatch(r"\d+", prev):
                    continue
                if re.fullmatch(r"\w+\s+\d{1,2},?\s*\d{4}", prev):
                    continue
                if 3 <= len(prev) <= 80:
                    title = prev
                    break
        else:
            # No cadence anchor — pick nearest non-skip line below.
            for j in range(i - 1, max(-1, i - backwards_budget - 1), -1):
                prev = lines[j]
                if not prev:
                    continue
                if _SKIP_BACKWARDS_RE.match(prev):
                    continue
                if _DEVICE_RE.search(prev):
                    continue
                if re.fullmatch(r"\d+", prev):
                    continue
                if re.fullmatch(r"\w+\s+\d{1,2},?\s*\d{4}", prev):
                    continue
                if 3 <= len(prev) <= 80:
                    title = prev
                    break

        if not title:
            continue
        title = re.sub(r"[\s\-:|—·]+$", "", title)
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
    """Extract line items from a Google Play receipt.

    Returns ``None`` for emails that look Google-ish but aren't actually
    Play receipts (security alerts, ToS updates, marketing, etc.) — a
    later parser is welcome to try.
    """
    body = msg.body_plain or msg.snippet or ""
    if not body:
        return None

    # Quick header sanity check — body must mention "Google Play" or an
    # order-number pattern. Without this, marketing emails from
    # google.com slip through and we emit garbage line items.
    if (
        "google play" not in body.lower()
        and not re.search(r"\bGPA\.\d", body)
    ):
        return None

    items = _extract_line_items(body)
    if not items:
        return None

    receipt_date = _extract_receipt_date(body, msg.received_at)
    total_match = _TOTAL_RE.search(body)
    grand_total_cents = _parse_amount(total_match.group(1)) if total_match else None

    return ParseResult(
        parser_name=SPEC.name,
        tags=["google_play", "composite_receipt"],
        transaction=None,
        payload={
            "composite": "google_play",
            "aggregator_key": "google_play_store",
            "receipt_date": receipt_date.isoformat(),
            "line_items": items,
            "grand_total_cents": grand_total_cents,
            # Bank-statement merchant patterns the reconciler can match
            # against. Google Play charges show up as "GOOGLE *Service"
            # for subscriptions and "GOOGLE *YOUTUBEPREMIUM" etc. for
            # YouTube. Wildcards (the "*") aren't in the patterns; the
            # reconciler does a case-insensitive substring match.
            "parent_match_hints": ["google *", "google*", "google play"],
        },
    )
