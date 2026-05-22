"""Shopping-pattern detection — Phase 10 Slice B.

Public entry points:

    detect_recurring_purchases(db) -> list[DetectedPattern]
        Walks ReceiptItem rows, clusters by SKU/normalized-name, and
        returns one DetectedPattern per recurring item. Pure function:
        does NOT write to the DB.

    persist_patterns(db, detected) -> PersistResult
        Upserts the DetectedPattern list into ``recurring_purchases``.
        Honors name_locked (user-renamed rows aren't clobbered) and
        skips dismissed patterns.

    merchant_rollup(db) -> list[MerchantRollupRow]
        Plaid-fed alternative for users without receipt data — groups
        Transaction history by merchant, finds spend cadences and
        per-trip averages. Doesn't write; the API endpoint serves it
        directly.

The two paths complement each other: receipt-fed patterns are
*item-level* ("you buy toilet paper every 6 weeks at Costco for
$19.99"), merchant-fed are *trip-level* ("you spend $180/mo at
Costco on average").
"""
from .detector import (
    DetectedPattern,
    MerchantRollupRow,
    PersistResult,
    detect_recurring_purchases,
    merchant_rollup,
    normalize_item_name,
    persist_patterns,
)

__all__ = [
    "DetectedPattern",
    "MerchantRollupRow",
    "PersistResult",
    "detect_recurring_purchases",
    "merchant_rollup",
    "normalize_item_name",
    "persist_patterns",
]
