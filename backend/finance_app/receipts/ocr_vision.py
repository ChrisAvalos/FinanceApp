"""Vision-model receipt OCR — Sprint 49.

Why a separate module
---------------------
``ocr.py`` already owns the Tesseract path. Vision-model OCR is a
different beast — it doesn't go through `pytesseract`, doesn't need a
binary install, and produces structured JSON directly rather than
plain text that we then have to regex apart. Keeping it in its own
module means the import graph stays one-directional (ingest reads
from one or the other) and we don't conflate the failure modes.

What this returns
-----------------
``vision_extract_receipt(path)`` returns a :class:`ParsedReceipt`
populated directly from the vision model's JSON response. We re-use
the same dataclass shape that ``parser.parse_receipt`` produces so
the persistence helper in ``ingest.py`` doesn't care which path the
data came from.

Why JSON-mode instead of free-text + parsing
--------------------------------------------
The vision model can see the receipt layout (line items with prices,
totals at the bottom, merchant in the header) better than tesseract
+ regex can reconstruct it. Asking for JSON skips the brittle text
parsing that fails on crumpled receipts, thermal-print fade, and
unusual line-item formats (multi-line items, weight-priced produce,
sale lines below regular price, etc).

Fallback
--------
On vision-model failure (Ollama not running, model not pulled, model
returns invalid JSON), the function raises one of:
  * :class:`OllamaUnavailable` — server unreachable / 5xx
  * :class:`VisionOcrFailed`   — model returned but output unusable

API callers catch both and surface a 503 / 422 with a clean message
so the UI shows "Vision OCR failed — try uploading a clearer photo
or pasting the receipt text" rather than a 500.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from finance_app.llm import get_client
from finance_app.llm.client import OllamaUnavailable

from .parser import ParsedReceipt, ParsedLineItem

logger = logging.getLogger(__name__)


class VisionOcrFailed(RuntimeError):
    """Raised when Ollama vision responded but the response was
    unusable (missing JSON, bogus fields, etc.). Distinct from
    :class:`OllamaUnavailable` so callers can give the user a more
    targeted error — "model output unusable" vs "server unreachable"."""


# Prompt is intentionally specific about the JSON shape — vision models
# free-wheel format when left to their own devices. Lifted from
# Sprint 16 (LLM-Gmail discovery) playbook: list every field
# explicitly, give examples for each, require strict JSON, no prose.
_SYSTEM_PROMPT = """\
You are a precise receipt-data extractor. Given a photo of a paper
receipt or screenshot of an order confirmation, return STRICT JSON
with exactly these top-level keys:

  merchant        — store name from the header (string or null)
  purchase_date   — YYYY-MM-DD, the date on the receipt (string or null)
  subtotal_cents  — pre-tax subtotal, integer cents (number or null)
  tax_cents       — total tax, integer cents (number or null)
  total_cents     — grand total, integer cents (number or null)
  items           — array of line items (see below; empty array if unreadable)

Each line item is:
  name              — product name as printed (string)
  quantity_units    — quantity as a decimal (e.g. 1, 2.5; null if not shown)
  unit_label        — "lb", "oz", "ea" if visible (string or null)
  unit_price_cents  — per-unit price in cents (number or null)
  line_total_cents  — line total in cents, always positive (number)
  discount_cents    — discount applied to this line in cents, positive
                      (number or null). Use for "SALE -$X" lines that
                      modify the line above them.
  sku               — barcode / item number if printed (string or null)

Rules:
  * Cents are integers. $4.99 → 499. NEVER include the dollar sign.
  * Skip non-item lines (subtotal, tax, total, thank-you, store address).
  * If a line is illegible, omit it from items rather than guessing.
  * If a value isn't visible, use null — don't invent.
  * Output ONLY the JSON object. No prose, no markdown fence, no comments.
"""

_USER_PROMPT = (
    "Extract the receipt data from the image. Return only the JSON."
)


# ----------------------------------------------------------------------
#  Helpers — defensive parsing of model output
# ----------------------------------------------------------------------

def _coerce_cents(value: Any) -> int | None:
    """Vision models occasionally return cents as strings ("499") or
    floats (4.99 — they forgot the cents unit). Coerce both back to
    int cents, return None on unusable input.
    """
    if value is None:
        return None
    if isinstance(value, bool):  # bool is a subclass of int — exclude
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        # Heuristic: if the float looks like a dollar amount (has
        # fractional part or is < 100), assume dollars and convert.
        # Otherwise assume the model meant cents-as-float (e.g. 499.0).
        if value != int(value) or value < 100:
            return int(round(value * 100))
        return int(value)
    if isinstance(value, str):
        # Strip "$", commas, whitespace. Try float first (handles "4.99").
        cleaned = value.replace("$", "").replace(",", "").strip()
        if not cleaned:
            return None
        try:
            return _coerce_cents(float(cleaned))
        except ValueError:
            return None
    return None


def _coerce_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        # Try the canonical YYYY-MM-DD first; then a couple of common
        # alternates the model occasionally produces.
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d"):
            try:
                return datetime.strptime(value.strip(), fmt).date()
            except ValueError:
                continue
    return None


def _strip_json_envelope(raw: str) -> str:
    """Some vision models prepend "Here's the JSON:" or wrap the
    response in a ```json fence even when told not to. Pull the first
    top-level { … } block out so json.loads has a chance.
    """
    s = raw.strip()
    # Strip markdown fences if present.
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*", "", s)
        s = re.sub(r"\s*```\s*$", "", s)
    # Find the first balanced { … } block. Cheap state machine — handles
    # nested objects (line items) correctly because we count braces.
    start = s.find("{")
    if start < 0:
        return s  # let json.loads raise so caller logs the original
    depth = 0
    for i in range(start, len(s)):
        if s[i] == "{":
            depth += 1
        elif s[i] == "}":
            depth -= 1
            if depth == 0:
                return s[start : i + 1]
    return s[start:]


def _items_from_payload(items_data: Any) -> list[ParsedLineItem]:
    if not isinstance(items_data, list):
        return []
    out: list[ParsedLineItem] = []
    for entry in items_data:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        line_total = _coerce_cents(entry.get("line_total_cents"))
        if line_total is None:
            # No usable price → drop the item; parser dataclass
            # requires line_total to be useful downstream.
            continue
        # quantity_units is stored as quantity * 1000 (integer) so we
        # don't lose precision on weight-priced items (e.g. 2.347 lbs).
        # Default = 1000 (one unit) matches what parser.parse_receipt
        # does for items without an explicit quantity.
        qty_raw = entry.get("quantity_units")
        quantity_units = 1000
        if isinstance(qty_raw, (int, float)) and not isinstance(qty_raw, bool):
            quantity_units = int(round(float(qty_raw) * 1000))
        elif isinstance(qty_raw, str):
            try:
                quantity_units = int(round(float(qty_raw) * 1000))
            except ValueError:
                quantity_units = 1000
        out.append(
            ParsedLineItem(
                raw_line=name.strip()[:500],
                name=name.strip(),
                quantity_units=max(quantity_units, 0),
                unit_label=_str_or_none(entry.get("unit_label")),
                unit_price_cents=_coerce_cents(entry.get("unit_price_cents")),
                line_total_cents=abs(line_total),
                discount_cents=_coerce_cents(entry.get("discount_cents")),
                sku=_str_or_none(entry.get("sku")),
                item_category=None,
            )
        )
    return out


def _str_or_none(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


# ----------------------------------------------------------------------
#  Public entry point
# ----------------------------------------------------------------------

def vision_extract_receipt(image_path: str | Path) -> ParsedReceipt:
    """Run the vision model on the receipt image and return a parsed
    receipt. Raises :class:`OllamaUnavailable` or :class:`VisionOcrFailed`.

    The returned ``ParsedReceipt`` has the same shape as
    ``parse_receipt`` so callers can persist via the existing
    ``ingest._persist`` path with no extra branching.

    Notes:
      * ``raw_text`` is set to a synthetic single-line label
        ("<vision OCR — N items>") so callers can tell the receipt
        came from this path. The original photo bytes still live at
        ``image_path`` for re-runs.
      * On failure, no fields are populated and we raise — we don't
        return an empty ParsedReceipt because the caller needs to
        distinguish "model said the receipt is empty" from "model
        choked".
    """
    p = Path(image_path)
    if not p.exists():
        raise FileNotFoundError(p)
    client = get_client()
    if not client.is_available():
        raise OllamaUnavailable("Ollama isn't running at the configured URL.")
    raw = client.generate_with_images(
        _USER_PROMPT,
        [p],
        system=_SYSTEM_PROMPT,
        json_mode=True,
        temperature=0.0,
        max_tokens=2048,
    )
    cleaned = _strip_json_envelope(raw)
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError as e:
        logger.warning(
            "Vision OCR returned unparseable JSON. raw=%r cleaned=%r",
            raw[:400], cleaned[:400],
        )
        raise VisionOcrFailed(
            f"Vision model returned non-JSON output: {e}"
        ) from e
    if not isinstance(payload, dict):
        raise VisionOcrFailed(
            f"Vision model returned non-object JSON: {type(payload).__name__}"
        )
    items = _items_from_payload(payload.get("items"))
    # Build a synthetic raw_text so we don't lose provenance — the
    # /receipts/{id}/ocr-vision endpoint stores this on the row so
    # the user can tell at a glance which OCR path produced it.
    synth_text = (
        f"<vision OCR — {len(items)} item(s) extracted by "
        f"{client.model if hasattr(client, 'model') else 'vision model'}>"
    )
    return ParsedReceipt(
        merchant=_str_or_none(payload.get("merchant")),
        purchase_date=_coerce_date(payload.get("purchase_date")),
        subtotal_cents=_coerce_cents(payload.get("subtotal_cents")),
        tax_cents=_coerce_cents(payload.get("tax_cents")),
        total_cents=_coerce_cents(payload.get("total_cents")),
        items=items,
        raw_text=synth_text,
    )
