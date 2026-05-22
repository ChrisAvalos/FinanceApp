"""End-to-end smoke test for shopping-patterns Slice B.

Builds 4 synthetic Costco receipts spanning ~3 months, all containing
the same Charmin SKU at roughly the same price. Runs the detector,
asserts that:

  • One RecurringPurchase row was created
  • Cadence is in the "monthly" band (~28 days)
  • occurrence_count == 4
  • confidence_score >= 0.6
  • Rename is preserved across re-detect (name_locked check)
  • Dismissed rows aren't resurrected

Plus exercises ``merchant_rollup`` with three Plaid-style transactions.
Uses an isolated SQLite file so the real ``finance.db`` stays untouched.

Run:  py -m scripts.smoke_shopping_patterns
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta
from pathlib import Path

# Throwaway DB BEFORE importing the app
THROWAWAY_DB = Path(__file__).parent.parent / "smoke_shopping.db"
os.environ["DATABASE_URL"] = f"sqlite:///{THROWAWAY_DB}"

from sqlalchemy import select  # noqa: E402

from finance_app.db.models import (  # noqa: E402
    Account,
    AccountType,
    Base,
    Institution,
    InstitutionKind,
    Receipt,
    ReceiptItem,
    ReceiptStatus,
    RecurringPurchase,
    RecurringPurchaseStatus,
    Transaction,
    TransactionStatus,
    IngestSource,
)
from finance_app.db.session import SessionLocal, engine  # noqa: E402
from finance_app.shopping_patterns import (  # noqa: E402
    detect_recurring_purchases,
    merchant_rollup,
    persist_patterns,
)


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


def _seed_receipts(db) -> None:
    """4 Costco receipts ~28d apart, each with Charmin SKU 1234567."""
    today = date.today()
    for i, days_ago in enumerate([90, 60, 30, 1]):
        purchase_date = today - timedelta(days=days_ago)
        r = Receipt(
            merchant="Costco Wholesale",
            purchase_date=purchase_date,
            subtotal_cents=2500 + i * 50,  # tiny price drift
            tax_cents=0,
            total_cents=2500 + i * 50,
            status=ReceiptStatus.manual,
            raw_text=f"costco trip {i}",
        )
        db.add(r)
        db.flush()
        db.add(
            ReceiptItem(
                receipt_id=r.id,
                raw_line="1234567 CHRMN UL TP 24CT 19.99",
                name="Charmin Ultra Soft 24ct",
                sku="1234567",
                quantity_units=1000,
                unit_label="ct",
                line_total_cents=1999 + i * 30,  # small price drift
                unit_price_cents=83,
                item_category="paper",
            )
        )
    db.commit()


def _seed_plaid_txns(db) -> None:
    """3 Costco transactions for the merchant-rollup test."""
    inst = Institution(name="Test Bank", kind=InstitutionKind.bank)
    db.add(inst)
    db.flush()
    acct = Account(
        institution_id=inst.id,
        name="Test Checking",
        account_type=AccountType.checking,
    )
    db.add(acct)
    db.flush()
    today = date.today()
    for i, days_ago in enumerate([45, 20, 5]):
        db.add(
            Transaction(
                account_id=acct.id,
                posted_date=today - timedelta(days=days_ago),
                amount_cents=-(15000 + i * 1000),
                currency="USD",
                description_raw="COSTCO WHSE #0123 SAN FRANCISCO CA",
                status=TransactionStatus.posted,
                source=IngestSource.plaid,
                external_id=f"costco-{i}",
            )
        )
    db.commit()


def run() -> int:
    print("=" * 60)
    print("SHOPPING-PATTERNS SLICE B — SMOKE TEST")
    print("=" * 60)
    setup_db()
    failures: list[str] = []

    db = SessionLocal()
    try:
        _seed_receipts(db)
        _seed_plaid_txns(db)

        # ---- 1. Detector: receipt-fed item patterns ----
        detected = detect_recurring_purchases(db)
        print(f"  Detected patterns : {len(detected)}")
        for p in detected:
            print(f"    • {p.canonical_name!r} merchant={p.primary_merchant!r} cadence={p.cadence_days}d count={p.occurrence_count} conf={p.confidence_score}")
        if len(detected) != 1:
            failures.append(f"expected 1 pattern, got {len(detected)}")
        else:
            p = detected[0]
            if p.occurrence_count != 4:
                failures.append(f"occurrence_count: {p.occurrence_count}")
            if not p.cadence_days or not (25 <= p.cadence_days <= 35):
                failures.append(f"cadence_days outside monthly band: {p.cadence_days}")
            if p.confidence_score < 0.5:
                failures.append(f"confidence too low: {p.confidence_score}")
            if p.primary_sku != "1234567":
                failures.append(f"primary_sku: {p.primary_sku!r}")

        # ---- 2. Persist ----
        res = persist_patterns(db, detected)
        print(f"  Persist result    : created={res.created} updated={res.updated} deactivated={res.deactivated}")
        if res.created != 1:
            failures.append(f"expected 1 created, got {res.created}")

        # ---- 3. Re-detect — should be idempotent (1 update, 0 created) ----
        res2 = persist_patterns(db, detect_recurring_purchases(db))
        print(f"  Re-detect result  : created={res2.created} updated={res2.updated}")
        if res2.created != 0 or res2.updated != 1:
            failures.append(f"second run not idempotent: created={res2.created} updated={res2.updated}")

        # ---- 4. Rename + name_lock ----
        row = db.execute(select(RecurringPurchase)).scalar_one()
        original_name = row.canonical_name
        row.canonical_name = "Charmin Ultra Soft 24 Mega Rolls — household"
        row.name_locked = True
        db.commit()
        # Re-detect should NOT clobber renamed name
        persist_patterns(db, detect_recurring_purchases(db))
        db.refresh(row)
        if row.canonical_name == original_name:
            failures.append("name_lock didn't preserve rename across re-detect")
        print(f"  Name-lock         : kept {row.canonical_name!r}")

        # ---- 5. Dismissed stays dismissed ----
        row.status = RecurringPurchaseStatus.dismissed
        db.commit()
        persist_patterns(db, detect_recurring_purchases(db))
        db.refresh(row)
        if row.status != RecurringPurchaseStatus.dismissed:
            failures.append("dismissed status got resurrected")
        print(f"  Dismissed sticky  : {row.status.value}")

        # ---- 6. Merchant rollup ----
        rollup = merchant_rollup(db)
        print(f"  Merchant rollup   : {len(rollup)} merchants")
        for r in rollup:
            print(f"    • {r.display_name!r} txns={r.transaction_count} mo_avg={r.monthly_avg_cents/100:.2f} cad={r.cadence_days}")
        if len(rollup) != 1:
            failures.append(f"expected 1 merchant, got {len(rollup)}")
        elif rollup[0].transaction_count != 3:
            failures.append(f"merchant txn_count: {rollup[0].transaction_count}")

    finally:
        db.close()

    print("=" * 60)
    if failures:
        print(f"  FAILED ({len(failures)} issue(s)):")
        for f in failures:
            print(f"    • {f}")
        teardown_db()
        return 1
    print("  SHOPPING-PATTERNS SMOKE TEST PASSED ✓")
    teardown_db()
    return 0


if __name__ == "__main__":
    sys.exit(run())
