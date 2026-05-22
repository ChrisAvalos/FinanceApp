"""Smoke test — Phase 7 features.

Covers:
  • 7.1 Net worth tracker (current_net_worth + snapshot_net_worth)
  • 7.2 Cash flow forecast (build_forecast)
  • 7.4 Tax-time export (build_annual_tax_report + render_csv)
  • 7.5 Per-merchant deep-dive (api/merchants endpoint)

Skipped: 7.3 spending pace projection — already exercised by
smoke_budget_credit.py since it lives inside the budget rollup.
Skipped: 7.6 annual review — exercised indirectly via stats endpoints.

Each section seeds the minimum data needed to drive the code path,
then asserts key invariants. Doesn't try to be exhaustive — the goal
is "did the regression land?" not "are all edge cases covered."

Run:  py -m scripts.smoke_phase_7
"""
from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

THROWAWAY_DB = Path(__file__).parent.parent / "smoke_phase_7.db"
os.environ["DATABASE_URL"] = f"sqlite:///{THROWAWAY_DB}"

from sqlalchemy import select  # noqa: E402

from finance_app.cashflow import build_forecast  # noqa: E402
from finance_app.db.models import (  # noqa: E402
    Account,
    AccountType,
    BalanceSnapshot,
    Base,
    Category,
    IngestSource,
    Institution,
    InstitutionKind,
    NetWorthSnapshot,
    Subscription,
    SubscriptionStatus,
    SubscriptionType,
    Transaction,
    TransactionStatus,
)
from finance_app.db.session import SessionLocal, engine  # noqa: E402
from finance_app.networth import current_net_worth, snapshot_net_worth  # noqa: E402
from finance_app.tax import build_annual_tax_report, render_csv  # noqa: E402


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


def _seed_baseline(db) -> dict:
    """Seed an institution + checking + savings + credit-card account.

    Returns a dict of (key → object) so each test section can grab
    what it needs.
    """
    inst = Institution(name="Test Bank", kind=InstitutionKind.bank)
    db.add(inst)
    db.flush()

    checking = Account(
        institution_id=inst.id,
        name="Test Checking",
        account_type=AccountType.checking,
        current_balance_cents=250_000,  # $2,500
    )
    savings = Account(
        institution_id=inst.id,
        name="Test Savings",
        account_type=AccountType.savings,
        current_balance_cents=1_500_000,  # $15,000
    )
    credit = Account(
        institution_id=inst.id,
        name="Test Credit Card",
        account_type=AccountType.credit_card,
        current_balance_cents=-120_000,  # owe $1,200
    )
    db.add_all([checking, savings, credit])
    db.flush()

    # BalanceSnapshot rows so net-worth pulls "today's" balances.
    today = date.today()
    for acct, bal in [(checking, 250_000), (savings, 1_500_000), (credit, -120_000)]:
        db.add(
            BalanceSnapshot(
                account_id=acct.id,
                as_of=today,
                balance_cents=bal,
                source=IngestSource.manual,
            )
        )

    # A handful of transactions for tax + merchants tests.
    cat_groceries = Category(name="Groceries", slug="food.groceries", is_discretionary=False)
    cat_charity = Category(name="Charity", slug="giving.charitable", is_discretionary=True)
    cat_medical = Category(name="Medical", slug="health.medical", is_discretionary=False)
    cat_salary = Category(name="Salary", slug="income.salary", is_discretionary=False)
    db.add_all([cat_groceries, cat_charity, cat_medical, cat_salary])
    db.flush()

    year = today.year
    txns = [
        # Costco grocery run, 4 visits this year — drives merchant test
        Transaction(
            account_id=credit.id, posted_date=date(year, 2, 5),
            amount_cents=-15000, currency="USD",
            description_raw="COSTCO WHSE #0123 SAN FRANCISCO CA",
            status=TransactionStatus.posted, source=IngestSource.plaid,
            external_id="costco-feb", category_id=cat_groceries.id,
        ),
        Transaction(
            account_id=credit.id, posted_date=date(year, 3, 8),
            amount_cents=-18500, currency="USD",
            description_raw="COSTCO WHSE #0123 SAN FRANCISCO CA",
            status=TransactionStatus.posted, source=IngestSource.plaid,
            external_id="costco-mar", category_id=cat_groceries.id,
        ),
        Transaction(
            account_id=credit.id, posted_date=date(year, 4, 2),
            amount_cents=-16200, currency="USD",
            description_raw="COSTCO WHSE #0123 SAN FRANCISCO CA",
            status=TransactionStatus.posted, source=IngestSource.plaid,
            external_id="costco-apr", category_id=cat_groceries.id,
        ),
        Transaction(
            account_id=credit.id, posted_date=date(year, 4, 25),
            amount_cents=-17800, currency="USD",
            description_raw="COSTCO WHSE #0123 SAN FRANCISCO CA",
            status=TransactionStatus.posted, source=IngestSource.plaid,
            external_id="costco-apr2", category_id=cat_groceries.id,
        ),
        # Charitable donation — drives tax test
        Transaction(
            account_id=checking.id, posted_date=date(year, 12, 10),
            amount_cents=-50000, currency="USD",
            description_raw="REDCROSS DONATION",
            status=TransactionStatus.posted, source=IngestSource.plaid,
            external_id="charity-1", category_id=cat_charity.id,
        ),
        # Salary deposits — drives cashflow paycheck cadence + tax inflow total
        Transaction(
            account_id=checking.id, posted_date=date(year, 1, 5),
            amount_cents=400_000, currency="USD",
            description_raw="ACME PAYROLL DIRECT DEP",
            status=TransactionStatus.posted, source=IngestSource.plaid,
            external_id="salary-1", category_id=cat_salary.id,
        ),
        Transaction(
            account_id=checking.id, posted_date=date(year, 1, 19),
            amount_cents=400_000, currency="USD",
            description_raw="ACME PAYROLL DIRECT DEP",
            status=TransactionStatus.posted, source=IngestSource.plaid,
            external_id="salary-2", category_id=cat_salary.id,
        ),
        Transaction(
            account_id=checking.id, posted_date=date(year, 2, 2),
            amount_cents=400_000, currency="USD",
            description_raw="ACME PAYROLL DIRECT DEP",
            status=TransactionStatus.posted, source=IngestSource.plaid,
            external_id="salary-3", category_id=cat_salary.id,
        ),
    ]
    db.add_all(txns)

    # One subscription for the cashflow forecast
    db.add(
        Subscription(
            name="Netflix",
            amount_cents=-1999,
            cadence_days=30,
            next_expected_date=date.today() + timedelta(days=10),
            status=SubscriptionStatus.active,
            subscription_type=SubscriptionType.streaming,
            last_amount_cents=-1999,
            is_user_confirmed=True,
            confidence_score=0.95,
        )
    )

    db.commit()
    return {
        "checking": checking,
        "savings": savings,
        "credit": credit,
        "year": year,
    }


def run() -> int:
    print("=" * 60)
    print("PHASE 7 — SMOKE TEST")
    print("=" * 60)
    setup_db()
    failures: list[str] = []

    db = SessionLocal()
    try:
        seed = _seed_baseline(db)

        # ---- 7.1 Net worth ----
        print()
        print("[7.1] Net worth")
        nw = current_net_worth(db)
        print(f"  assets={nw.assets_cents/100:.0f} liabilities={nw.liabilities_cents/100:.0f} net={nw.net_cents/100:.0f}")
        # Expected: 250000 + 1500000 = 1750000 assets, -120000 liabilities
        # (signed — credit card stored as -1200), 1630000 net (= assets +
        # signed liabilities).
        if nw.assets_cents != 1_750_000:
            failures.append(f"7.1 assets: got {nw.assets_cents}, expected 1_750_000")
        if nw.liabilities_cents != -120_000:
            failures.append(f"7.1 liabilities: got {nw.liabilities_cents}, expected -120_000")
        if nw.net_cents != 1_630_000:
            failures.append(f"7.1 net: got {nw.net_cents}, expected 1_630_000")

        snap = snapshot_net_worth(db)
        print(f"  snapshot id={snap.id} as_of={snap.as_of}")
        if snap.net_cents != nw.net_cents:
            failures.append(f"7.1 snapshot net mismatch")
        # Verify it persisted
        rows = list(db.execute(select(NetWorthSnapshot)).scalars().all())
        if len(rows) != 1:
            failures.append(f"7.1 expected 1 snapshot row, got {len(rows)}")

        # ---- 7.2 Cash flow forecast ----
        print()
        print("[7.2] Cash flow forecast")
        fc = build_forecast(db, days=45)
        print(f"  events={len(fc.events)} starting_bal={fc.starting_balance_cents/100:.0f} crunch_days={len(fc.crunch_days)}")
        if not fc.events:
            failures.append("7.2 no forecast events generated")
        # The Netflix sub should appear at least once in the next 45 days
        netflix_events = [e for e in fc.events if "netflix" in e.label.lower()]
        if not netflix_events:
            failures.append("7.2 Netflix sub didn't surface in forecast events")

        # ---- 7.4 Tax export ----
        print()
        print("[7.4] Tax export")
        report = build_annual_tax_report(db, year=seed["year"])
        print(f"  buckets={len(report.by_bucket)} grand_outflow={report.grand_total_outflow_cents/100:.0f} grand_inflow={report.grand_total_inflow_cents/100:.0f}")
        # Salary inflows = 400_000 × 3 = 1_200_000
        if report.grand_total_inflow_cents != 1_200_000:
            failures.append(f"7.4 tax inflow total: got {report.grand_total_inflow_cents}, expected 1_200_000")
        # Outflow includes 4 Costco trips + charity = 67_500 + 50_000 = 117_500
        if report.grand_total_outflow_cents < 100_000:
            failures.append(f"7.4 tax outflow seems low: {report.grand_total_outflow_cents}")
        csv = render_csv(report)
        if not csv or "REDCROSS" not in csv:
            failures.append("7.4 CSV doesn't contain seeded REDCROSS row")
        print(f"  csv length: {len(csv)} chars")

        # ---- 7.5 Merchant deep-dive ----
        print()
        print("[7.5] Merchant deep-dive")
        from finance_app.api.merchants import get_merchant_detail
        try:
            detail = get_merchant_detail(
                merchant_key="COSTCO WHSE #0123 SAN FRANCISCO CA",
                months=24, txn_limit=50, db=db,
            )
            print(f"  visits={detail.transactions} lifetime={detail.lifetime_spend_cents/100:.0f} avg={detail.avg_per_visit_cents/100:.0f}")
            if detail.transactions != 4:
                failures.append(f"7.5 expected 4 visits, got {detail.transactions}")
            # 15000 + 18500 + 16200 + 17800 = 67_500
            if detail.lifetime_spend_cents != 67_500:
                failures.append(f"7.5 lifetime spend: got {detail.lifetime_spend_cents}, expected 67_500")
        except Exception as e:  # noqa: BLE001
            failures.append(f"7.5 merchant detail blew up: {e}")
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
    print("  PHASE 7 SMOKE TEST PASSED ✓")
    teardown_db()
    return 0


if __name__ == "__main__":
    sys.exit(run())
