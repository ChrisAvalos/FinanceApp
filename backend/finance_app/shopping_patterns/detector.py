"""Recurring-purchase + merchant-rollup detection.

Two-tier architecture (mirrors the Subscription detector's split):

  Tier 1 — Receipt items (when available)
  --------------------------------------
  Best signal: SKU + line total + date triple. Group by SKU first;
  fall back to normalized name when SKU is empty (lots of grocery
  receipts skip SKUs).

  Tier 2 — Merchant rollup (Plaid Transaction history)
  ---------------------------------------------------
  Coarser. Groups by merchant_key (uppercased description prefix)
  and computes per-merchant cadence + monthly spend. Useful for
  the "you spend $X/mo at Costco" insight even with zero receipts.

Cadence math is identical to the Subscription detector's gap
analysis: median of consecutive deltas, then a stability score
based on how tight the gaps cluster around that median.
"""
from __future__ import annotations

import logging
import re
import statistics
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    Receipt,
    ReceiptItem,
    RecurringPurchase,
    RecurringPurchaseStatus,
    Transaction,
)

logger = logging.getLogger(__name__)


# Cluster requirements before a pattern qualifies as "recurring".
# Matched against the Subscription detector's thresholds: 3 occurrences
# is the minimum that lets us compute 2 gaps for cadence analysis.
_MIN_OCCURRENCES = 3
_MIN_SPAN_DAYS = 45
# Cadence-band classifier — used to label patterns ("weekly", "biweekly",
# "monthly", "quarterly"). Cadence outside the widest band is "irregular".
_CADENCE_BANDS: list[tuple[int, int, str]] = [
    (5, 10, "weekly"),
    (12, 17, "biweekly"),
    (25, 35, "monthly"),
    (40, 80, "every 6-8 weeks"),
    (85, 100, "quarterly"),
    (160, 200, "every 6 months"),
]

# Words that don't help identify the item — strip from normalized names.
_NOISE_TOKENS = frozenset({
    "ea", "ct", "pk", "pkg", "lb", "lbs", "oz", "fl", "gal", "qt",
    "the", "and", "or", "of", "with",
})


def normalize_item_name(s: str | None) -> str:
    """Lowercase, strip retailer abbreviation noise, collapse whitespace.

    Not aggressive — we want "CHRMN UL TP 24CT" and "Charmin Ultra Soft 24"
    to match (which they don't here without external data), but we do
    NOT want to over-merge ("MILK 1G" and "MILK 2OZ" are different items).

    Phase 10B (canonicalization) is the proper fix; this is a stop-gap.
    """
    if not s:
        return ""
    cleaned = re.sub(r"[^a-z0-9 ]+", " ", s.lower())
    tokens = [t for t in cleaned.split() if t and t not in _NOISE_TOKENS]
    # Drop pure-numeric tokens longer than 4 chars (likely SKUs that
    # leaked into the name)
    tokens = [t for t in tokens if not (t.isdigit() and len(t) > 4)]
    return " ".join(tokens)


def _classify_cadence(median_days: int) -> str | None:
    for lo, hi, label in _CADENCE_BANDS:
        if lo <= median_days <= hi:
            return label
    return None


def _cadence_stability(gaps_days: list[int], median: int) -> float:
    """0.0 - 1.0. 1.0 means every gap is within ±20% of median."""
    if not gaps_days or median == 0:
        return 0.0
    lo, hi = int(median * 0.8), int(median * 1.2) + 1
    in_band = sum(1 for g in gaps_days if lo <= g <= hi)
    return in_band / len(gaps_days)


def _price_stability(prices_cents: list[int]) -> float:
    """0.0 - 1.0. 1.0 means stdev < 10% of median price."""
    if len(prices_cents) < 2:
        return 0.5  # not enough data to judge
    med = statistics.median(prices_cents)
    if med == 0:
        return 0.5
    sd = statistics.pstdev(prices_cents)
    ratio = sd / med
    if ratio < 0.10:
        return 1.0
    if ratio < 0.20:
        return 0.8
    if ratio < 0.30:
        return 0.6
    if ratio < 0.50:
        return 0.4
    return 0.2


# --- Datatypes ---


@dataclass
class DetectedPattern:
    """One recurring-purchase pattern, pre-persistence."""
    canonical_name: str
    primary_merchant: str | None
    primary_sku: str | None
    typical_unit_price_cents: int | None
    typical_line_total_cents: int | None
    typical_quantity_units: int | None
    unit_label: str | None
    cadence_days: int | None
    occurrence_count: int
    first_purchased_at: date | None
    last_purchased_at: date | None
    confidence_score: float
    category: str | None
    cadence_label: str | None  # "weekly", "monthly", etc.
    item_ids: list[int] = field(default_factory=list)


@dataclass
class MerchantRollupRow:
    """Plaid-side merchant rollup."""
    merchant_key: str          # normalized description prefix
    display_name: str          # the description as it appears
    transaction_count: int
    monthly_avg_cents: int     # rolling 90d → ×30 / actual days
    median_per_visit_cents: int
    cadence_days: int | None
    last_seen: date | None
    total_lifetime_cents: int
    primary_category_id: int | None
    primary_category_name: str | None


@dataclass
class PersistResult:
    created: int = 0
    updated: int = 0
    deactivated: int = 0
    skipped_dismissed: int = 0


# --- Tier 1: receipt-item patterns ---


def _cluster_key(item: ReceiptItem) -> str | None:
    """The cluster bucket for a ReceiptItem.

    Prefer SKU when present (most stable identifier across visits).
    Fall back to normalized name. Returns None for unclusterable rows
    so the detector skips them.
    """
    if item.sku:
        return f"sku:{item.sku}"
    norm = normalize_item_name(item.name)
    if not norm:
        return None
    return f"name:{norm}"


def detect_recurring_purchases(
    db: Session,
    *,
    today: date | None = None,
) -> list[DetectedPattern]:
    """Walk ReceiptItems → cluster → return one DetectedPattern per
    cluster that meets the recurring threshold.

    Doesn't write to the DB — caller decides whether to persist.
    """
    today = today or date.today()
    cutoff = today - timedelta(days=730)  # ignore items > 2yr old

    # We need the item's purchase_date, which lives on the parent Receipt.
    rows = list(
        db.execute(
            select(ReceiptItem, Receipt)
            .join(Receipt, ReceiptItem.receipt_id == Receipt.id)
            .where(Receipt.purchase_date >= cutoff)
        ).all()
    )

    # Cluster
    clusters: dict[str, list[tuple[ReceiptItem, Receipt]]] = defaultdict(list)
    for item, receipt in rows:
        key = _cluster_key(item)
        if not key or not receipt.purchase_date:
            continue
        clusters[key].append((item, receipt))

    out: list[DetectedPattern] = []
    for key, members in clusters.items():
        if len(members) < _MIN_OCCURRENCES:
            continue
        # Sort by date asc for cadence math
        members.sort(key=lambda m: m[1].purchase_date or date.min)
        first_date = members[0][1].purchase_date
        last_date = members[-1][1].purchase_date
        if not first_date or not last_date:
            continue
        span = (last_date - first_date).days
        if span < _MIN_SPAN_DAYS:
            continue

        # Cadence — median consecutive gap
        dates = [m[1].purchase_date for m in members if m[1].purchase_date]
        gaps = [(dates[i] - dates[i - 1]).days for i in range(1, len(dates))]
        cadence_days = int(statistics.median(gaps)) if gaps else None
        cadence_lbl = _classify_cadence(cadence_days) if cadence_days else None

        # Price stats — line_total is the most reliable cross-receipt
        # column (unit_price isn't always present)
        line_totals = [
            m[0].line_total_cents
            for m in members
            if m[0].line_total_cents is not None
        ]
        unit_prices = [
            m[0].unit_price_cents
            for m in members
            if m[0].unit_price_cents is not None
        ]
        typical_line = int(statistics.median(line_totals)) if line_totals else None
        typical_unit = int(statistics.median(unit_prices)) if unit_prices else None

        # Quantity — most-common quantity_units across cluster
        qtys = [m[0].quantity_units for m in members]
        typical_qty = int(statistics.median(qtys)) if qtys else None

        # Most frequent merchant + unit_label + category — pick the mode
        merchants = [m[1].merchant for m in members if m[1].merchant]
        primary_merchant = (
            max(set(merchants), key=merchants.count) if merchants else None
        )
        units = [m[0].unit_label for m in members if m[0].unit_label]
        unit_label = max(set(units), key=units.count) if units else None
        cats = [m[0].item_category for m in members if m[0].item_category]
        category = max(set(cats), key=cats.count) if cats else None

        # Most frequent name → canonical_name (until user renames)
        names = [m[0].name for m in members if m[0].name]
        canonical_name = (
            max(set(names), key=names.count)
            if names
            else (members[0][0].name or "Unknown item")
        )

        # SKU — stable when keyed by SKU; otherwise pick the modal
        # SKU across the cluster (often empty)
        skus = [m[0].sku for m in members if m[0].sku]
        primary_sku = max(set(skus), key=skus.count) if skus else None

        # Confidence = blend of count, cadence stability, price stability
        count_score = min(1.0, len(members) / 10)
        cad_stab = _cadence_stability(gaps, cadence_days or 0) if cadence_days else 0.5
        price_stab = _price_stability(line_totals)
        confidence = round(0.4 * count_score + 0.3 * cad_stab + 0.3 * price_stab, 3)

        out.append(
            DetectedPattern(
                canonical_name=canonical_name[:200],
                primary_merchant=(primary_merchant or None),
                primary_sku=primary_sku,
                typical_unit_price_cents=typical_unit,
                typical_line_total_cents=typical_line,
                typical_quantity_units=typical_qty,
                unit_label=unit_label,
                cadence_days=cadence_days,
                occurrence_count=len(members),
                first_purchased_at=first_date,
                last_purchased_at=last_date,
                confidence_score=confidence,
                category=category,
                cadence_label=cadence_lbl,
                item_ids=[m[0].id for m in members],
            )
        )
    out.sort(key=lambda p: p.confidence_score, reverse=True)
    return out


def persist_patterns(
    db: Session,
    detected: list[DetectedPattern],
    *,
    today: date | None = None,
) -> PersistResult:
    """Upsert detected patterns into ``recurring_purchases``.

    Match key: primary_sku when present, else (canonical_name, primary_merchant).
    Existing rows with ``status = dismissed`` are left alone — the user
    explicitly said stop tracking, so a re-detect run won't resurrect.

    Existing rows with ``name_locked = True`` keep their canonical_name
    (the user renamed manually). Other fields update normally.

    Patterns whose last_purchased_at is older than 2× cadence get
    flagged ``status = inactive``. The user can re-activate manually.
    """
    today = today or date.today()
    res = PersistResult()

    # Index existing rows for fast lookup
    existing_by_sku: dict[str, RecurringPurchase] = {}
    existing_by_name: dict[tuple[str, str | None], RecurringPurchase] = {}
    all_existing = list(db.execute(select(RecurringPurchase)).scalars().all())
    for row in all_existing:
        if row.primary_sku:
            existing_by_sku[row.primary_sku] = row
        existing_by_name[(row.canonical_name.lower(), row.primary_merchant)] = row

    seen_existing_ids: set[int] = set()

    for d in detected:
        match: RecurringPurchase | None = None
        if d.primary_sku and d.primary_sku in existing_by_sku:
            match = existing_by_sku[d.primary_sku]
        else:
            match = existing_by_name.get((d.canonical_name.lower(), d.primary_merchant))

        # Compute the would-be status from recency
        new_status = RecurringPurchaseStatus.active
        if d.last_purchased_at and d.cadence_days:
            days_since = (today - d.last_purchased_at).days
            if days_since > d.cadence_days * 2:
                new_status = RecurringPurchaseStatus.inactive

        if match is None:
            row = RecurringPurchase(
                canonical_name=d.canonical_name,
                primary_merchant=d.primary_merchant,
                primary_sku=d.primary_sku,
                typical_unit_price_cents=d.typical_unit_price_cents,
                typical_line_total_cents=d.typical_line_total_cents,
                typical_quantity_units=d.typical_quantity_units,
                unit_label=d.unit_label,
                cadence_days=d.cadence_days,
                occurrence_count=d.occurrence_count,
                first_purchased_at=d.first_purchased_at,
                last_purchased_at=d.last_purchased_at,
                confidence_score=d.confidence_score,
                category=d.category,
                status=new_status,
            )
            db.add(row)
            res.created += 1
            continue

        seen_existing_ids.add(match.id)

        if match.status == RecurringPurchaseStatus.dismissed:
            res.skipped_dismissed += 1
            continue

        # Update — preserve user overrides (name_locked, manual category if set)
        if not match.name_locked:
            match.canonical_name = d.canonical_name
        match.primary_merchant = d.primary_merchant or match.primary_merchant
        if d.primary_sku and not match.primary_sku:
            match.primary_sku = d.primary_sku
        match.typical_unit_price_cents = d.typical_unit_price_cents
        match.typical_line_total_cents = d.typical_line_total_cents
        match.typical_quantity_units = d.typical_quantity_units
        match.unit_label = d.unit_label
        match.cadence_days = d.cadence_days
        match.occurrence_count = d.occurrence_count
        match.first_purchased_at = d.first_purchased_at
        match.last_purchased_at = d.last_purchased_at
        match.confidence_score = d.confidence_score
        if d.category and not match.category:
            match.category = d.category
        match.status = new_status
        res.updated += 1

    # Deactivate previously-active rows that didn't show up in this run
    # (might mean the user stopped buying that item — but DON'T mark
    # dismissed; the user owns that lifecycle).
    for row in all_existing:
        if (
            row.id not in seen_existing_ids
            and row.status == RecurringPurchaseStatus.active
        ):
            row.status = RecurringPurchaseStatus.inactive
            res.deactivated += 1

    db.commit()
    return res


# --- Tier 2: Plaid merchant rollup ---


# Reuse the Subscription detector's normalization since merchant naming
# conventions are the same (Plaid descriptions, OFX descriptions, etc.).
def _normalize_merchant(desc: str) -> str:
    """Cheap merchant-key normalization for grouping Plaid Transactions."""
    s = (desc or "").upper().strip()
    # Strip trailing transaction noise: city codes, dates, store numbers
    s = re.sub(r"\s+#\s*\d+", "", s)
    s = re.sub(r"\s+\d{4,}", "", s)
    s = re.sub(r"\s+CA|\s+TX|\s+NY|\s+FL|\s+IL|\s+WA", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def merchant_rollup(
    db: Session,
    *,
    days: int = 365,
    min_transactions: int = 3,
    today: date | None = None,
) -> list[MerchantRollupRow]:
    """Group recent transactions by merchant; surface the high-spend regulars.

    Uses Plaid Transaction history rather than receipts. Useful for
    users who haven't uploaded receipts yet — gives them a "Costco
    spend pattern" view from the get-go.
    """
    from finance_app.db.models import Category as CategoryModel

    today = today or date.today()
    cutoff = today - timedelta(days=days)
    rows = list(
        db.execute(
            select(Transaction)
            .where(Transaction.posted_date >= cutoff)
            .where(Transaction.amount_cents < 0)  # outflows only
        ).scalars().all()
    )

    by_merchant: dict[str, list[Transaction]] = defaultdict(list)
    for t in rows:
        key = _normalize_merchant(t.description_raw)
        if not key:
            continue
        by_merchant[key].append(t)

    cats = {c.id: c.name for c in db.execute(select(CategoryModel)).scalars().all()}

    out: list[MerchantRollupRow] = []
    for key, txns in by_merchant.items():
        if len(txns) < min_transactions:
            continue
        txns.sort(key=lambda t: t.posted_date)
        amounts = [-t.amount_cents for t in txns]
        first_date = txns[0].posted_date
        last_date = txns[-1].posted_date
        span_days = max(1, (last_date - first_date).days)
        # Monthly avg = total spend × (30 / span_days). Clamp the span to a
        # minimum of (min_transactions × 30) days so that a cluster of
        # same-day charges doesn't project to a bogus monthly rate. Example:
        # 3 charges of $205 on the same day would otherwise compute as
        # $615 × 30 / 1 = $18,450/mo. With min_span = 3 × 30 = 90, it
        # becomes $615 × 30 / 90 = $205/mo — much more honest given we
        # haven't actually observed a cadence yet.
        min_span = max(min_transactions, 1) * 30
        effective_span = max(span_days, min_span)
        total = sum(amounts)
        monthly_avg = int(total * 30 / effective_span)
        med_per = int(statistics.median(amounts))
        # Cadence = median gap between visits
        gaps = [(txns[i].posted_date - txns[i - 1].posted_date).days for i in range(1, len(txns))]
        cad = int(statistics.median(gaps)) if gaps else None

        cat_id_counts: dict[int | None, int] = defaultdict(int)
        for t in txns:
            cat_id_counts[t.category_id] += 1
        primary_cat_id = max(cat_id_counts, key=cat_id_counts.get) if cat_id_counts else None
        primary_cat_name = cats.get(primary_cat_id) if primary_cat_id else None

        # Display name — pick the most-frequent raw description
        descs = [t.description_raw for t in txns if t.description_raw]
        display = max(set(descs), key=descs.count) if descs else key

        out.append(
            MerchantRollupRow(
                merchant_key=key,
                display_name=display,
                transaction_count=len(txns),
                monthly_avg_cents=monthly_avg,
                median_per_visit_cents=med_per,
                cadence_days=cad,
                last_seen=last_date,
                total_lifetime_cents=total,
                primary_category_id=primary_cat_id,
                primary_category_name=primary_cat_name,
            )
        )
    out.sort(key=lambda r: r.monthly_avg_cents, reverse=True)
    return out
