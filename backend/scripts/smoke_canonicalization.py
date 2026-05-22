"""End-to-end smoke test for canonicalization — Phase 10 Slice E.

Seeds 2 receipts at different stores with the same Charmin item under
different name spellings, plus a different-size variant. Asserts:

  • The canonicalizer collapses both Charmin 24ct lines into ONE
    CanonicalProduct (cross-store identity).
  • The 12ct variant becomes a SEPARATE CanonicalProduct (different size).
  • Re-running is idempotent — no new canonicals on second pass.
  • merge_canonicals() correctly re-points receipt items.
  • Brand + size extraction are wired correctly.

Run: py -m scripts.smoke_canonicalization
"""
from __future__ import annotations

import os
import sys
from datetime import date
from pathlib import Path

THROWAWAY_DB = Path(__file__).parent.parent / "smoke_canonical.db"
os.environ["DATABASE_URL"] = f"sqlite:///{THROWAWAY_DB}"

from sqlalchemy import select  # noqa: E402

from finance_app.canonicalization import (  # noqa: E402
    canonicalize_unmatched,
    extract_brand,
    extract_size,
    fuzzy_match,
    normalize,
)
from finance_app.canonicalization.canonicalizer import merge_canonicals  # noqa: E402
from finance_app.db.models import (  # noqa: E402
    Base,
    CanonicalProduct,
    Receipt,
    ReceiptItem,
    ReceiptStatus,
)
from finance_app.db.session import SessionLocal, engine  # noqa: E402


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
    print("CANONICALIZATION SLICE E — SMOKE TEST")
    print("=" * 60)
    setup_db()
    failures: list[str] = []

    # ---- Pure-function checks first (no DB) ----
    print("  Brand extraction:")
    for raw, expected in [
        ("CHRMN UL TP 24CT", "Charmin"),
        ("Bounty 12 mega rolls", "Bounty"),
        ("Generic store-brand toilet paper", None),
    ]:
        b = extract_brand(raw)
        ok = "✓" if b == expected else "✗"
        print(f"    {ok}  {raw!r} → {b!r} (expected {expected!r})")
        if b != expected:
            failures.append(f"brand extract: {raw!r} → {b!r}")

    print("  Size extraction:")
    for raw, expected in [
        ("CHRMN UL TP 24CT", (24.0, "ct", None)),
        ("Coca-Cola 64 fl oz", (64.0, "oz", None)),
        ("Eggs 18ct large", (18.0, "ct", None)),
    ]:
        v, u, f = extract_size(raw)
        ok = "✓" if (v, u) == (expected[0], expected[1]) else "✗"
        print(f"    {ok}  {raw!r} → ({v}, {u}, {f}) (expected {expected})")
        if (v, u) != (expected[0], expected[1]):
            failures.append(f"size extract: {raw!r} → ({v}, {u})")

    print("  Fuzzy match:")
    for a, b, threshold, should_match in [
        ("CHRMN UL TP 24CT", "Charmin Ultra Soft 24ct", 0.65, True),
        ("CHRMN UL TP 24CT", "Charmin Ultra 24ct", 0.65, True),
        ("Charmin 24ct", "Bounty 24ct", 0.65, False),
    ]:
        score = fuzzy_match(a, b)
        verdict = score >= threshold
        ok = "✓" if verdict == should_match else "✗"
        print(f"    {ok}  {a!r} vs {b!r} → {score} (>= {threshold}: {verdict}, want {should_match})")
        if verdict != should_match:
            failures.append(f"fuzzy: {a!r} vs {b!r} → {score}")

    # ---- DB-backed canonicalization ----
    db = SessionLocal()
    try:
        # Seed 2 receipts at different stores
        costco = Receipt(
            merchant="Costco Wholesale",
            purchase_date=date(2026, 4, 15),
            status=ReceiptStatus.manual,
        )
        target = Receipt(
            merchant="Target",
            purchase_date=date(2026, 4, 20),
            status=ReceiptStatus.manual,
        )
        db.add_all([costco, target])
        db.flush()

        # Same Charmin 24ct under different spellings
        item_costco_charmin = ReceiptItem(
            receipt_id=costco.id,
            raw_line="1234567 CHRMN UL TP 24CT 19.99",
            name="CHRMN UL TP 24CT",
            sku="1234567",
            quantity_units=1000,
            line_total_cents=1999,
        )
        item_target_charmin = ReceiptItem(
            receipt_id=target.id,
            raw_line="Charmin Ultra Soft 24ct 17.49",
            name="Charmin Ultra Soft 24ct",
            sku=None,
            quantity_units=1000,
            line_total_cents=1749,
        )
        # Different-size variant — should become its own canonical
        item_costco_charmin_12 = ReceiptItem(
            receipt_id=costco.id,
            raw_line="9988776 CHRMN ULT 12CT 11.99",
            name="CHRMN ULT 12CT",
            sku="9988776",
            quantity_units=1000,
            line_total_cents=1199,
        )
        # Different brand — should become its own canonical
        item_target_bounty = ReceiptItem(
            receipt_id=target.id,
            raw_line="Bounty Select-A-Size 12 Mega Rolls 21.99",
            name="Bounty Select-A-Size 12 Mega Rolls",
            sku=None,
            quantity_units=1000,
            line_total_cents=2199,
        )
        db.add_all([
            item_costco_charmin,
            item_target_charmin,
            item_costco_charmin_12,
            item_target_bounty,
        ])
        db.commit()

        # ---- Run canonicalizer ----
        result = canonicalize_unmatched(db)
        print()
        print(f"  Canonicalize run 1: {result.items_processed} processed, {result.items_linked} linked, {result.canonicals_created} canonicals created")
        if result.items_processed != 4:
            failures.append(f"items_processed: {result.items_processed}")
        if result.items_linked != 4:
            failures.append(f"items_linked: {result.items_linked}")

        canonicals = list(db.execute(select(CanonicalProduct)).scalars().all())
        print(f"  Canonicals after run 1: {len(canonicals)}")
        for c in canonicals:
            print(f"    • [{c.id}] {c.name!r} brand={c.brand!r} size=({c.size_value}, {c.size_unit}) key={c.normalized_key!r}")

        # Both Charmin 24ct items should share one canonical
        c_costco = db.get(ReceiptItem, item_costco_charmin.id).canonical_product_id
        c_target = db.get(ReceiptItem, item_target_charmin.id).canonical_product_id
        if c_costco != c_target:
            failures.append(f"Charmin 24ct cross-store: costco={c_costco}, target={c_target}")
        else:
            print(f"  ✓ Cross-store Charmin 24ct: both linked to canonical #{c_costco}")

        # Different-size Charmin should be different canonical
        c_charmin_12 = db.get(ReceiptItem, item_costco_charmin_12.id).canonical_product_id
        if c_charmin_12 == c_costco:
            failures.append("Charmin 12ct merged with 24ct (wrong)")
        else:
            print(f"  ✓ Charmin 12ct vs 24ct: different canonicals (#{c_charmin_12} vs #{c_costco})")

        # Bounty should be different canonical
        c_bounty = db.get(ReceiptItem, item_target_bounty.id).canonical_product_id
        if c_bounty == c_costco:
            failures.append("Bounty merged with Charmin (wrong)")
        else:
            print(f"  ✓ Bounty vs Charmin: different canonicals (#{c_bounty} vs #{c_costco})")

        # Total canonicals should be 3 (Charmin 24ct, Charmin 12ct, Bounty)
        if len(canonicals) != 3:
            failures.append(f"expected 3 canonicals, got {len(canonicals)}")

        # ---- Re-run idempotency ----
        result2 = canonicalize_unmatched(db)
        print(f"  Canonicalize run 2 (idempotent): {result2.items_processed} processed, {result2.canonicals_created} created")
        if result2.items_processed != 0:
            failures.append(f"re-run found {result2.items_processed} unprocessed items (expected 0)")
        if result2.canonicals_created != 0:
            failures.append(f"re-run created {result2.canonicals_created} new canonicals (expected 0)")

        # ---- Merge ----
        if c_costco and c_charmin_12 and c_costco != c_charmin_12:
            merge_canonicals(db, keep_id=c_costco, drop_id=c_charmin_12)
            after_merge = list(db.execute(select(CanonicalProduct)).scalars().all())
            print(f"  After merge: {len(after_merge)} canonicals")
            if len(after_merge) != 2:
                failures.append(f"merge: expected 2 after, got {len(after_merge)}")
            # Verify the dropped canonical's items were re-pointed
            re_pointed = db.get(ReceiptItem, item_costco_charmin_12.id)
            if re_pointed.canonical_product_id != c_costco:
                failures.append(
                    f"merge re-point failed: {re_pointed.canonical_product_id} != {c_costco}"
                )
            else:
                print(f"  ✓ Merge re-pointed item to canonical #{c_costco}")
    finally:
        db.close()

    print("=" * 60)
    if failures:
        print(f"  FAILED ({len(failures)} issue(s)):")
        for f in failures:
            print(f"    • {f}")
        teardown_db()
        return 1
    print("  CANONICALIZATION SMOKE TEST PASSED ✓")
    teardown_db()
    return 0


if __name__ == "__main__":
    sys.exit(run())
