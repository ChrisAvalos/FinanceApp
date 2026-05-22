"""Smoke test — Phase 9 features.

Covers:
  • 9.1 Investment holdings tracking (Empower-style portfolio)
  • 9.2 HSA receipt bank (decades-deferred reimbursement)
  • 9.3 Anomaly / unusual-transaction detection (3σ baseline)
  • 9.4 Spending heatmap (calendar grid)

Skipped: 9.5 free-trial → paid conversion alerts. That detector
runs inside the existing subscription smoke test (smoke_phase_b.py)
since it shares the Subscription model.

Run:  py -m scripts.smoke_phase_9
"""
from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

THROWAWAY_DB = Path(__file__).parent.parent / "smoke_phase_9.db"
os.environ["DATABASE_URL"] = f"sqlite:///{THROWAWAY_DB}"

from sqlalchemy import select  # noqa: E402

from finance_app.db.models import (  # noqa: E402
    Account,
    AccountType,
    Base,
    Category,
    HsaReceipt,
    HsaReceiptStatus,
    Holding,
    IngestSource,
    Institution,
    InstitutionKind,
    Security,
    SecurityType,
    Transaction,
    TransactionStatus,
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
    print("PHASE 9 — SMOKE TEST")
    print("=" * 60)
    setup_db()
    failures: list[str] = []

    db = SessionLocal()
    try:
        # Common seed: 1 brokerage account + 1 checking
        inst = Institution(name="Test Brokerage", kind=InstitutionKind.investment)
        db.add(inst)
        db.flush()
        brokerage = Account(
            institution_id=inst.id,
            name="Schwab Brokerage",
            account_type=AccountType.investment,
            current_balance_cents=10_000_000,
        )
        checking = Account(
            institution_id=inst.id,
            name="Checking",
            account_type=AccountType.checking,
            current_balance_cents=500_000,
        )
        db.add_all([brokerage, checking])
        db.flush()

        # ---- 9.1 Holdings + portfolio ----
        print()
        print("[9.1] Holdings + portfolio")
        # Two securities: VTI ETF + AAPL stock
        vti = Security(
            ticker="VTI", name="Vanguard Total Stock Market ETF",
            security_type=SecurityType.etf,
            latest_price_cents=24500,  # $245
            latest_price_at=datetime.utcnow(),
        )
        aapl = Security(
            ticker="AAPL", name="Apple Inc.",
            security_type=SecurityType.equity,
            latest_price_cents=18000,  # $180
            latest_price_at=datetime.utcnow(),
        )
        db.add_all([vti, aapl])
        db.flush()

        # Holdings: 100 VTI + 50 AAPL
        # quantity_units = qty × 10000
        h_vti = Holding(
            account_id=brokerage.id, security_id=vti.id,
            quantity_units=100 * 10000,
            cost_basis_cents=2_000_000,  # $20,000
            current_value_cents=100 * 24500,  # $24,500
            as_of=date.today(),
        )
        h_aapl = Holding(
            account_id=brokerage.id, security_id=aapl.id,
            quantity_units=50 * 10000,
            cost_basis_cents=750_000,  # $7,500
            current_value_cents=50 * 18000,  # $9,000
            as_of=date.today(),
        )
        db.add_all([h_vti, h_aapl])
        db.commit()

        from finance_app.api.holdings import get_portfolio
        portfolio = get_portfolio(db)
        print(f"  total_value=${portfolio.total_value_cents/100:.0f} cost_basis=${portfolio.total_cost_basis_cents/100:.0f} gain=${portfolio.total_unrealized_gain_cents/100:.0f}")
        # 24500 + 9000 = 33_500
        if portfolio.total_value_cents != 33_500 * 100:
            failures.append(f"9.1 total_value: {portfolio.total_value_cents}, expected 3_350_000")
        # 20000 + 7500 = 27_500 cost basis
        if portfolio.total_cost_basis_cents != 27_500 * 100:
            failures.append(f"9.1 cost basis: {portfolio.total_cost_basis_cents}, expected 2_750_000")
        # 33500 - 27500 = 6_000 gain
        if portfolio.total_unrealized_gain_cents != 6_000 * 100:
            failures.append(f"9.1 gain: {portfolio.total_unrealized_gain_cents}, expected 600_000")
        if portfolio.holdings_count != 2:
            failures.append(f"9.1 holdings count: {portfolio.holdings_count}")

        # ---- 9.2 HSA receipt bank ----
        print()
        print("[9.2] HSA receipt bank")
        # Seed 3 saved receipts + 1 reimbursed
        for i, (desc, amt) in enumerate([
            ("Annual physical — Dr. Smith", 35000),
            ("Pharmacy — birth control rx", 4500),
            ("Dental cleaning", 18000),
        ]):
            db.add(
                HsaReceipt(
                    expense_date=date.today() - timedelta(days=30 + i * 30),
                    amount_cents=amt,
                    description=desc,
                    status=HsaReceiptStatus.saved,
                )
            )
        # One reimbursed
        db.add(
            HsaReceipt(
                expense_date=date.today() - timedelta(days=200),
                amount_cents=12000,
                description="Old urgent care",
                status=HsaReceiptStatus.reimbursed,
                reimbursed_at=datetime.utcnow() - timedelta(days=10),
            )
        )
        db.commit()

        from finance_app.api.hsa import get_summary as hsa_summary
        summary = hsa_summary(db)
        print(f"  saved_count={summary.saved_count} saved_total=${summary.saved_total_cents/100:.0f} 30yr@7%=${summary.projected_at_30yr_7pct_cents/100:.0f}")
        if summary.saved_count != 3:
            failures.append(f"9.2 saved_count: {summary.saved_count}")
        # 35000 + 4500 + 18000 = 57_500
        if summary.saved_total_cents != 57_500:
            failures.append(f"9.2 saved_total: {summary.saved_total_cents}")
        # 30yr at 7% compounded ≈ 7.61x — sanity check it's >5x and <10x
        ratio = summary.projected_at_30yr_7pct_cents / max(1, summary.saved_total_cents)
        if not (5 < ratio < 10):
            failures.append(f"9.2 30yr projection ratio looks wrong: {ratio:.2f}")

        # ---- 9.3 Anomaly detection ----
        print()
        print("[9.3] Anomaly detection")
        # Seed 20 normal grocery transactions ~$60 each + 1 huge outlier
        cat = Category(name="Groceries", slug="food.groceries", is_discretionary=False)
        db.add(cat)
        db.flush()

        today = date.today()
        for i in range(20):
            db.add(
                Transaction(
                    account_id=checking.id,
                    posted_date=today - timedelta(days=i * 4),
                    amount_cents=-(5500 + (i % 5) * 200),  # ~$55-65
                    currency="USD",
                    description_raw=f"GROCERY STORE #{i}",
                    status=TransactionStatus.posted,
                    source=IngestSource.plaid,
                    external_id=f"groc-{i}",
                    category_id=cat.id,
                )
            )
        # Outlier: $400 grocery run (vs ~$60 mean — should fire ≥3σ)
        db.add(
            Transaction(
                account_id=checking.id, posted_date=today - timedelta(days=2),
                amount_cents=-40000, currency="USD",
                description_raw="GROCERY STORE BIG SHOP",
                status=TransactionStatus.posted, source=IngestSource.plaid,
                external_id="groc-outlier", category_id=cat.id,
            )
        )
        db.commit()

        from finance_app.api.anomaly import scan
        result = scan(days=180, threshold_sigma=3.0, fire_notifications=False, db=db)
        print(f"  scanned={result.transactions_scanned} anomalies={len(result.anomalies)}")
        # The $400 row should be flagged at 3σ (it's >5σ above $60 mean)
        if not result.anomalies:
            failures.append("9.3 detector found 0 anomalies — outlier should have fired")
        else:
            top = result.anomalies[0]
            if abs(top.amount_cents) != 40000:
                failures.append(f"9.3 top anomaly wasn't the outlier: amount={top.amount_cents}")

        # ---- 9.4 Spending heatmap ----
        print()
        print("[9.4] Spending heatmap")
        from finance_app.api.heatmap import daily as heatmap_daily

        heat = heatmap_daily(days=90, db=db)
        print(f"  days={heat.stats.total_days} days_with_spend={heat.stats.days_with_spend} biggest=${heat.stats.biggest_single_day_cents/100:.0f}")
        if heat.stats.total_days != 90:
            failures.append(f"9.4 expected 90 days, got {heat.stats.total_days}")
        if heat.stats.days_with_spend < 1:
            failures.append("9.4 no days_with_spend — heatmap is empty")
        # The $400 outlier should be the biggest single day
        if heat.stats.biggest_single_day_cents < 40_000:
            failures.append(f"9.4 biggest single day looks low: {heat.stats.biggest_single_day_cents}")
    finally:
        db.close()

    print()
    print("=" * 60)
    if failures:
        print(f"  FAILED ({len(failures)}):")
        for f in failures:
            print(f"    • {f}")
        teardown_db()
        return 1
    print("  PHASE 9 SMOKE TEST PASSED ✓")
    teardown_db()
    return 0


if __name__ == "__main__":
    sys.exit(run())
