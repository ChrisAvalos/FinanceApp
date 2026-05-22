"""End-to-end smoke test for cross-store deals — Phase 10 Slice D.

Seeds:
  • 1 RecurringPurchase ("Charmin Ultra Soft 24ct" at Costco, baseline $19.99,
    monthly cadence)
  • 3 PriceObservations:
      - Walmart $19.50  (3% off — should NOT trigger a deal at default 15%)
      - Target  $16.99  (15% off — borderline, should trigger)
      - Walmart $13.99  (30% off — should trigger and rank higher)

Asserts:
  • find_deals(threshold=0.15) returns 2 deals (Target + Walmart)
  • Walmart deal ranks first (bigger absolute savings)
  • Annualized savings is computed (cadence × per-trip savings)
  • find_deals(threshold=0.20) returns just 1 deal (the 30% one)
  • find_deals(threshold=0.40) returns 0 deals
  • The Walmart deal cents math is correct
  • Money-on-the-Table _from_cross_store_deals picks them up

Run: py -m scripts.smoke_deals
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta
from pathlib import Path

THROWAWAY_DB = Path(__file__).parent.parent / "smoke_deals.db"
os.environ["DATABASE_URL"] = f"sqlite:///{THROWAWAY_DB}"

from finance_app.db.models import (  # noqa: E402
    Base,
    PriceObservation,
    PriceObservationSource,
    RecurringPurchase,
    RecurringPurchaseStatus,
)
from finance_app.db.session import SessionLocal, engine  # noqa: E402
from finance_app.deals import find_deals  # noqa: E402


def setup_db() -> None:
    if THROWAWAY_DB.exists():
        THROWAWAY_DB.unlink()
    Base.metadata.create_all(bind=engine)


def teardown_db() -> None:
    try:
        engine.dispose()
    except Exception:  # noqa: BLE001
        pass
    for path in [THROWAWAY_DB] + [
        THROWAWAY_DB.with_name(THROWAWAY_DB.name + ext)
        for ext in ("-shm", "-wal", "-journal")
    ]:
        try:
            if path.exists():
                path.unlink()
        except OSError:
            pass


def run() -> int:
    print("=" * 60)
    print("DEALS SLICE D — SMOKE TEST")
    print("=" * 60)
    setup_db()
    failures: list[str] = []

    db = SessionLocal()
    try:
        # ---- Seed pattern + observations ----
        pattern = RecurringPurchase(
            canonical_name="Charmin Ultra Soft 24ct",
            primary_merchant="Costco",
            primary_sku="1234567",
            typical_unit_price_cents=83,
            typical_line_total_cents=1999,
            typical_quantity_units=1000,
            cadence_days=28,  # ~monthly
            occurrence_count=4,
            confidence_score=0.85,
            category="paper",
            status=RecurringPurchaseStatus.active,
            first_purchased_at=date.today() - timedelta(days=120),
            last_purchased_at=date.today() - timedelta(days=5),
        )
        db.add(pattern)
        db.flush()

        today = date.today()
        for merchant, price_cents, days_ago in [
            ("Walmart", 1950, 5),  # 3% off — below threshold
            ("Target", 1699, 3),   # 15% off — at threshold
            ("Walmart", 1399, 2),  # 30% off — well above threshold
        ]:
            db.add(
                PriceObservation(
                    recurring_purchase_id=pattern.id,
                    merchant=merchant,
                    price_cents=price_cents,
                    observed_at=today - timedelta(days=days_ago),
                    source=PriceObservationSource.manual,
                    in_stock=True,
                )
            )
        db.commit()

        # ---- Test threshold = 0.15 (default) ----
        deals = find_deals(db, threshold=0.15)
        print(f"  threshold=0.15: {len(deals)} deals")
        for d in deals:
            print(f"    • {d.deal_merchant} ${d.deal_price_cents/100:.2f} (-${d.savings_cents/100:.2f}, {int(d.savings_pct*100)}%) annual=${(d.annual_savings_cents or 0)/100:.0f}")

        if len(deals) != 2:
            failures.append(f"expected 2 deals at 0.15, got {len(deals)}")
        else:
            # The cheapest Walmart obs ($13.99) should rank ahead of Target ($16.99)
            if deals[0].deal_merchant != "Walmart":
                failures.append(f"Walmart deal didn't rank first: top={deals[0].deal_merchant}")
            if deals[0].deal_price_cents != 1399:
                failures.append(f"Walmart deal price: {deals[0].deal_price_cents}")
            if deals[0].savings_cents != 600:
                failures.append(f"Walmart savings: {deals[0].savings_cents} (expected 600)")
            # Annualized: 600 cents × 365 / 28 = 7821
            if not deals[0].annual_savings_cents or abs(deals[0].annual_savings_cents - 7821) > 50:
                failures.append(f"Annual savings: {deals[0].annual_savings_cents} (expected ~7821)")

        # ---- Test threshold = 0.20 — only Walmart deal qualifies ----
        deals_20 = find_deals(db, threshold=0.20)
        print(f"  threshold=0.20: {len(deals_20)} deals")
        if len(deals_20) != 1:
            failures.append(f"expected 1 deal at 0.20, got {len(deals_20)}")

        # ---- Test threshold = 0.40 — nothing qualifies ----
        deals_40 = find_deals(db, threshold=0.40)
        print(f"  threshold=0.40: {len(deals_40)} deals (expected 0)")
        if len(deals_40) != 0:
            failures.append(f"expected 0 deals at 0.40, got {len(deals_40)}")

        # ---- Test that out-of-stock observations don't fire ----
        # Add an out-of-stock $5.00 observation; it shouldn't beat anything
        # because the detector filters in_stock=True.
        db.add(
            PriceObservation(
                recurring_purchase_id=pattern.id,
                merchant="Kroger",
                price_cents=500,
                observed_at=today,
                source=PriceObservationSource.manual,
                in_stock=False,
            )
        )
        db.commit()
        deals_again = find_deals(db, threshold=0.15)
        print(f"  out-of-stock filter check: {len(deals_again)} deals (still 2)")
        kroger_deal = [d for d in deals_again if d.deal_merchant == "Kroger"]
        if kroger_deal:
            failures.append("out-of-stock observation surfaced as deal")

        # ---- MoT integration check ----
        from finance_app.api.money_on_table import _from_cross_store_deals
        ops = _from_cross_store_deals(db)
        print(f"  MoT _from_cross_store_deals: {len(ops)} opportunities")
        if len(ops) != 2:
            failures.append(f"MoT picked up {len(ops)} ops, expected 2")
        else:
            # source_kind should be "cross_store_deal"
            if any(o.source_kind != "cross_store_deal" for o in ops):
                failures.append("MoT op had wrong source_kind")

    finally:
        db.close()

    print("=" * 60)
    if failures:
        print(f"  FAILED ({len(failures)} issue(s)):")
        for f in failures:
            print(f"    • {f}")
        teardown_db()
        return 1
    print("  DEALS SMOKE TEST PASSED ✓")
    teardown_db()
    return 0


if __name__ == "__main__":
    sys.exit(run())
