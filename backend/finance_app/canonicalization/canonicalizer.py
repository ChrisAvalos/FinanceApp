"""Canonicalize unmatched ReceiptItems into CanonicalProduct rows.

Algorithm
---------
For each ReceiptItem with ``canonical_product_id IS NULL``:

  1. Compute (brand, size_value, size_unit, form, normalized_key) from
     the raw line + parsed name.
  2. Look for an existing CanonicalProduct with:
     a. ``primary_upc == sku``  (when both present)
     b. else ``brand == brand AND size_value/unit match AND fuzzy_match
        on normalized name >= 0.7``
     c. else ``normalized_key == normalized_key`` exact
  3. If found, link the ReceiptItem to that canonical and we're done.
  4. Else create a new CanonicalProduct, derive its display name from
     the ReceiptItem.name (longest readable form), and link.

Re-running is idempotent: items that already have a canonical_product_id
are skipped, and the matcher finds existing canonicals before creating
new ones.

Also walks RecurringPurchase rows — same logic, slightly different
field set (canonical_name + primary_sku come from the pattern itself).
"""
from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    CanonicalProduct,
    ReceiptItem,
    RecurringPurchase,
)

from .normalizer import extract_brand, extract_size, fuzzy_match, normalize

logger = logging.getLogger(__name__)


# Confidence threshold for the fuzzy-match step. Tuned to 0.65
# because the brand+size pre-filter is already strict: same brand
# AND same size_value AND same size_unit means we're comparing
# variants of one product, where 0.65 is plenty of name-similarity
# to confirm. Without the pre-filter we'd want 0.75+; with it, 0.65
# is the sweet spot between false-merges (rare) and false-splits
# (common, easily fixed via the merge endpoint).
_FUZZY_MATCH_THRESHOLD = 0.65


@dataclass
class CanonicalizeResult:
    items_processed: int
    items_linked: int
    patterns_processed: int
    patterns_linked: int
    canonicals_created: int


def _build_normalized_key(text: str | None) -> str:
    return normalize(text or "")


def _find_match(
    db: Session,
    *,
    brand: str | None,
    size_value: float | None,
    size_unit: str | None,
    normalized_key: str,
    sku: str | None,
) -> CanonicalProduct | None:
    """Three-tier lookup. Returns the first hit or None.

    The order matters — UPC is the strongest identity, brand+size
    is next, exact key match is the fallback. We never use weaker
    signals when stronger ones produced no hit.
    """
    # --- Tier 1: UPC ---
    if sku:
        hit = db.execute(
            select(CanonicalProduct).where(CanonicalProduct.primary_upc == sku)
        ).scalar_one_or_none()
        if hit is not None:
            return hit

    # --- Tier 2: brand + size + fuzzy name ---
    if brand and size_value is not None and size_unit:
        candidates = list(
            db.execute(
                select(CanonicalProduct)
                .where(CanonicalProduct.brand == brand)
                .where(CanonicalProduct.size_value == size_value)
                .where(CanonicalProduct.size_unit == size_unit)
            ).scalars().all()
        )
        for c in candidates:
            score = fuzzy_match(c.normalized_key, normalized_key)
            if score >= _FUZZY_MATCH_THRESHOLD:
                return c

    # --- Tier 3: exact normalized-key match ---
    if normalized_key:
        hit = db.execute(
            select(CanonicalProduct).where(
                CanonicalProduct.normalized_key == normalized_key
            )
        ).scalar_one_or_none()
        if hit is not None:
            return hit

    return None


def _create_from_item(
    db: Session,
    *,
    display_name: str,
    brand: str | None,
    size_value: float | None,
    size_unit: str | None,
    form: str | None,
    normalized_key: str,
    sku: str | None,
    category: str | None,
) -> CanonicalProduct:
    """Materialize a new CanonicalProduct."""
    row = CanonicalProduct(
        name=display_name[:200],
        brand=brand,
        category=category,
        size_value=size_value,
        size_unit=size_unit,
        form=form,
        normalized_key=normalized_key[:300],
        primary_upc=sku if sku else None,
    )
    db.add(row)
    db.flush()  # populate row.id for back-linking
    return row


def canonicalize_unmatched(db: Session) -> CanonicalizeResult:
    """Process every unlinked ReceiptItem + RecurringPurchase.

    Idempotent: items already linked to a canonical are skipped, and
    when a brand/size cluster of items matches an existing canonical
    we link rather than duplicate.

    Commits at the end. Per-row exceptions get logged + skipped so
    one bad row doesn't sink the whole pass.
    """
    result = CanonicalizeResult(0, 0, 0, 0, 0)

    # ---- Receipt items ----
    items = list(
        db.execute(
            select(ReceiptItem).where(ReceiptItem.canonical_product_id.is_(None))
        ).scalars().all()
    )
    for item in items:
        result.items_processed += 1
        try:
            text_for_match = " ".join(filter(None, [item.name or "", item.raw_line]))
            brand = extract_brand(text_for_match)
            size_v, size_u, form = extract_size(text_for_match)
            norm = _build_normalized_key(text_for_match)
            if not norm:
                continue
            existing = _find_match(
                db,
                brand=brand,
                size_value=size_v,
                size_unit=size_u,
                normalized_key=norm,
                sku=item.sku,
            )
            if existing is None:
                display = item.name or item.raw_line[:60]
                existing = _create_from_item(
                    db,
                    display_name=display,
                    brand=brand,
                    size_value=size_v,
                    size_unit=size_u,
                    form=form,
                    normalized_key=norm,
                    sku=item.sku,
                    category=item.item_category,
                )
                result.canonicals_created += 1
            item.canonical_product_id = existing.id
            item.canonical_key = norm
            result.items_linked += 1
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "canonicalize: receipt_item %d failed: %r", item.id, e
            )

    # ---- Recurring purchases ----
    patterns = list(
        db.execute(
            select(RecurringPurchase).where(
                RecurringPurchase.canonical_product_id.is_(None)
            )
        ).scalars().all()
    )
    for p in patterns:
        result.patterns_processed += 1
        try:
            text_for_match = p.canonical_name
            brand = extract_brand(text_for_match)
            size_v, size_u, form = extract_size(text_for_match)
            norm = _build_normalized_key(text_for_match)
            if not norm:
                continue
            existing = _find_match(
                db,
                brand=brand,
                size_value=size_v,
                size_unit=size_u,
                normalized_key=norm,
                sku=p.primary_sku,
            )
            if existing is None:
                existing = _create_from_item(
                    db,
                    display_name=p.canonical_name,
                    brand=brand,
                    size_value=size_v,
                    size_unit=size_u,
                    form=form,
                    normalized_key=norm,
                    sku=p.primary_sku,
                    category=p.category,
                )
                result.canonicals_created += 1
            p.canonical_product_id = existing.id
            result.patterns_linked += 1
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "canonicalize: pattern %d failed: %r", p.id, e
            )

    db.commit()
    return result


# Used in the API merge endpoint — not strictly part of canonicalization
# but lives here to avoid a circular import.
def merge_canonicals(
    db: Session, *, keep_id: int, drop_id: int
) -> CanonicalProduct:
    """Merge the ``drop_id`` canonical into ``keep_id``.

    Re-points every ReceiptItem and RecurringPurchase from drop → keep,
    then deletes the dropped row. Used when the canonicalizer over-fragments
    (e.g., creates separate "Charmin Ultra Soft 24" and "Charmin US 24" rows
    that should be one).
    """
    if keep_id == drop_id:
        raise ValueError("keep_id and drop_id must differ")
    keep = db.get(CanonicalProduct, keep_id)
    drop = db.get(CanonicalProduct, drop_id)
    if keep is None or drop is None:
        raise ValueError("canonical not found")

    db.execute(
        ReceiptItem.__table__.update()
        .where(ReceiptItem.canonical_product_id == drop_id)
        .values(canonical_product_id=keep_id)
    )
    db.execute(
        RecurringPurchase.__table__.update()
        .where(RecurringPurchase.canonical_product_id == drop_id)
        .values(canonical_product_id=keep_id)
    )
    db.delete(drop)
    db.commit()
    db.refresh(keep)
    return keep


# Reference unused imports so linters stay quiet
_ = Counter
