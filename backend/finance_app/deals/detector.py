"""Deal detector — Phase 10 Slice D.

Given the user's RecurringPurchases + their PriceObservations,
surface "deals": observations that beat the user's typical price by
a meaningful margin.

Per-pattern algorithm
---------------------
1. Baseline = ``RecurringPurchase.typical_line_total_cents``. This is
   the median across receipt items, computed by the Slice B detector.
   (We don't recompute from receipts here — too expensive on every
   read, and the Slice B numbers are already cached.)

2. Filter to PriceObservations from the trailing window (default 30d).

3. For each (pattern, merchant) combo, take the cheapest in-stock
   observation in the window. This is the "current deal" for that
   merchant. If a merchant has no observations, it doesn't contribute.

4. A combo is a "deal" iff:
     observation.price_cents <= baseline × (1 - threshold)
   Default threshold = 0.15 (≥15% savings).

5. Rank deals by absolute savings_cents desc.

The output (DealOpportunity) carries the pattern, merchant, savings,
and the URL when available — exactly what the Money-on-the-Table
aggregator needs to surface as an opportunity.

Why per-merchant, not just "best deal across all stores":
  • A user might prefer Costco for paper goods and Target for groceries
    even when Walmart's cheaper this week.
  • The UI shows multiple deals per pattern — "Costco $19.99 / Target
    $17.49 / Walmart out of stock" — and lets the user decide.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    PriceObservation,
    RecurringPurchase,
    RecurringPurchaseStatus,
)


@dataclass
class DealOpportunity:
    """One deal — a beats-the-baseline observation worth surfacing."""
    pattern_id: int
    pattern_name: str
    pattern_merchant: str | None  # the user's typical merchant
    baseline_cents: int            # RecurringPurchase.typical_line_total_cents
    deal_merchant: str
    deal_price_cents: int
    savings_cents: int             # baseline - deal_price
    savings_pct: float             # 0.0 - 1.0
    observed_at: date
    product_url: str | None
    annual_savings_cents: int | None  # extrapolated by cadence


def find_deals(
    db: Session,
    *,
    threshold: float = 0.15,
    window_days: int = 30,
    today: date | None = None,
    min_baseline_cents: int = 200,
) -> list[DealOpportunity]:
    """Return ranked deal opportunities.

    Parameters
    ----------
    threshold       Minimum fractional savings vs baseline. 0.15 = ≥15%.
    window_days     Only consider observations from the trailing N days.
    today           Override "now" for testing.
    min_baseline_cents  Skip patterns whose baseline is < $2 — fluctuations
                    on tiny items aren't worth surfacing.
    """
    today = today or date.today()
    cutoff = today - timedelta(days=window_days)

    patterns = list(
        db.execute(
            select(RecurringPurchase).where(
                RecurringPurchase.status == RecurringPurchaseStatus.active
            )
        ).scalars().all()
    )

    out: list[DealOpportunity] = []
    for p in patterns:
        baseline = p.typical_line_total_cents or 0
        if baseline < min_baseline_cents:
            continue
        observations = list(
            db.execute(
                select(PriceObservation)
                .where(PriceObservation.recurring_purchase_id == p.id)
                .where(PriceObservation.observed_at >= cutoff)
                .where(PriceObservation.in_stock.is_(True))
            ).scalars().all()
        )
        if not observations:
            continue

        # Cheapest observation per merchant in the window.
        per_merchant: dict[str, PriceObservation] = {}
        for o in observations:
            existing = per_merchant.get(o.merchant)
            if existing is None or o.price_cents < existing.price_cents:
                per_merchant[o.merchant] = o

        for merchant, o in per_merchant.items():
            savings = baseline - o.price_cents
            if savings <= 0:
                continue
            pct = savings / baseline
            if pct < threshold:
                continue
            # Annualized savings — multiply per-trip savings by
            # purchase frequency. Skip if cadence unknown.
            annual: int | None = None
            if p.cadence_days and p.cadence_days > 0:
                annual = int(savings * 365 / p.cadence_days)
            out.append(
                DealOpportunity(
                    pattern_id=p.id,
                    pattern_name=p.canonical_name,
                    pattern_merchant=p.primary_merchant,
                    baseline_cents=baseline,
                    deal_merchant=merchant,
                    deal_price_cents=o.price_cents,
                    savings_cents=savings,
                    savings_pct=round(pct, 3),
                    observed_at=o.observed_at,
                    product_url=o.product_url,
                    annual_savings_cents=annual,
                )
            )

    out.sort(key=lambda d: d.savings_cents, reverse=True)
    return out
