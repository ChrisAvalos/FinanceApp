"""End-to-end smoke test for the receipts pipeline (Phase 10 Slice A).

Exercises:
  • parse_receipt() against a synthetic Costco-style receipt
  • ingest_text() → DB roundtrip
  • Receipt + ReceiptItem persistence and FK relationship
  • patch + delete via direct ORM access (no HTTP)

Skips OCR — that's what ``test_ocr_smoke`` (manual) is for. Run via:

    py -m scripts.smoke_receipts

Uses an isolated SQLite file in ``backend/smoke_receipts.db`` so the
real ``finance.db`` stays untouched. Cleans up the file at exit.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Make sure we use a throwaway DB. Set BEFORE importing the app.
THROWAWAY_DB = Path(__file__).parent.parent / "smoke_receipts.db"
os.environ["DATABASE_URL"] = f"sqlite:///{THROWAWAY_DB}"

from sqlalchemy import select  # noqa: E402

from finance_app.db.models import (  # noqa: E402
    Base,
    Receipt,
    ReceiptCoupon,
    ReceiptItem,
    ReceiptStatus,
)
from finance_app.db.session import SessionLocal, engine  # noqa: E402
from finance_app.receipts import ingest_text, parse_receipt  # noqa: E402


SAMPLE_RECEIPT = """COSTCO WHOLESALE
1234 Main St
San Francisco CA 94105

04/15/2026  10:30 AM

1234567 CHRMN UL TP 24CT       19.99
8901234 BANANAS 2.5lb @ 0.99   2.48
5566778 ALMOND MILK 64OZ        4.99
9988776 EGGS LRG 18CT           5.49

SUBTOTAL                       32.95
TAX                             0.00
TOTAL                          32.95

SAVE $5 ON YOUR NEXT VISIT
Code: SAVE5NOW
Expires 5/15/26

Take our survey at www.costcosurvey.com/12345
for a chance to win a $1000 gift card

THANK YOU FOR SHOPPING!
"""


def setup_db() -> None:
    """Create a fresh schema in the throwaway DB."""
    if THROWAWAY_DB.exists():
        THROWAWAY_DB.unlink()
    Base.metadata.create_all(bind=engine)


def teardown_db() -> None:
    # Windows holds SQLite files open through the engine's connection
    # pool. Dispose the engine before unlinking, otherwise we get
    # WinError 32 ("file in use") even after every session is closed.
    try:
        engine.dispose()
    except Exception:  # noqa: BLE001 — cleanup; never raise
        pass
    for path in [THROWAWAY_DB] + [
        THROWAWAY_DB.with_name(THROWAWAY_DB.name + ext)
        for ext in ("-shm", "-wal", "-journal")
    ]:
        try:
            if path.exists():
                path.unlink()
        except OSError:
            # Leave the file behind on Windows if it's still locked —
            # the test passed, and the next run wipes the throwaway DB
            # at setup_db() anyway. Better than failing the script.
            pass


def run() -> int:
    print("=" * 60)
    print("RECEIPTS SLICE A — SMOKE TEST")
    print("=" * 60)
    setup_db()
    failures: list[str] = []

    # ---- 1. Parser-only test ----
    parsed = parse_receipt(SAMPLE_RECEIPT)
    print(f"  Parsed merchant   : {parsed.merchant!r}")
    print(f"  Parsed date       : {parsed.purchase_date}")
    print(f"  Parsed totals     : sub={parsed.subtotal_cents} tax={parsed.tax_cents} tot={parsed.total_cents}")
    print(f"  Parsed line items : {len(parsed.items)}")
    if not parsed.merchant or "COSTCO" not in parsed.merchant.upper():
        failures.append(f"merchant: {parsed.merchant!r}")
    if not parsed.purchase_date:
        failures.append("date not parsed")
    if parsed.total_cents != 3295:
        failures.append(f"total: {parsed.total_cents}")
    if len(parsed.items) < 3:
        failures.append(f"items: {len(parsed.items)}")

    # ---- 2. Ingest into DB ----
    db = SessionLocal()
    try:
        result = ingest_text(SAMPLE_RECEIPT, db)
        print(f"  Ingest result     : id={result.receipt_id} status={result.status.value} items={result.items_added} coupons={result.coupons_added}")
        if result.items_added < 3:
            failures.append(f"ingest items_added: {result.items_added}")
        if result.status != ReceiptStatus.manual:
            failures.append(f"ingest status: {result.status}")
        if result.coupons_added < 2:
            failures.append(f"ingest coupons_added: {result.coupons_added} (expected ≥2)")

        # ---- Slice C — verify coupon rows ----
        coupons = list(db.execute(select(ReceiptCoupon).where(ReceiptCoupon.receipt_id == result.receipt_id)).scalars().all())
        print(f"  DB coupons        : {len(coupons)}")
        for c in coupons:
            print(f"    • {c.title!r}  code={c.code!r}  value={c.estimated_value_cents}  expires={c.expires_at}")
        save5 = next((c for c in coupons if c.code == "SAVE5NOW"), None)
        if save5 is None:
            failures.append("SAVE5NOW coupon not found in DB")
        elif save5.estimated_value_cents != 500:
            failures.append(f"SAVE5NOW value: {save5.estimated_value_cents}")

        # ---- 3. DB roundtrip ----
        rec = db.get(Receipt, result.receipt_id)
        assert rec is not None
        items = list(db.execute(select(ReceiptItem).where(ReceiptItem.receipt_id == rec.id)).scalars().all())
        print(f"  DB receipt        : merchant={rec.merchant!r} total={rec.total_cents}")
        print(f"  DB items          : {len(items)}")
        if len(items) != result.items_added:
            failures.append(f"FK mismatch: ingest reported {result.items_added}, DB has {len(items)}")

        # ---- 4. Patch ----
        if items:
            target = items[0]
            target.name = "Charmin Ultra Soft 24 Mega Rolls"
            target.item_category = "paper"
            db.commit()
            db.refresh(target)
            print(f"  Patch verified    : item.name={target.name!r}, item.item_category={target.item_category!r}")
            if target.name != "Charmin Ultra Soft 24 Mega Rolls":
                failures.append("patch did not persist")

        # ---- 5. Cascade delete ----
        db.delete(rec)
        db.commit()
        leftover = list(db.execute(select(ReceiptItem).where(ReceiptItem.receipt_id == result.receipt_id)).scalars().all())
        print(f"  Cascade verified  : {len(leftover)} items remaining (expected 0)")
        if leftover:
            failures.append(f"cascade delete left {len(leftover)} orphan items")
    finally:
        db.close()

    print("=" * 60)
    if failures:
        print(f"  FAILED ({len(failures)} issue(s)):")
        for f in failures:
            print(f"    • {f}")
        teardown_db()
        return 1
    print("  RECEIPTS SMOKE TEST PASSED ✓")
    teardown_db()
    return 0


if __name__ == "__main__":
    sys.exit(run())
