"""Smoke test — Phase 8 features.

Covers:
  • 8.1 Unclaimed property tracker (CRUD + stats roll-up)
  • 8.2 Card sign-up bonus + 5/24 tracker
  • 8.4 HYSA / T-bill yield-arb suggester
  • 8.5 CFPB / state-AG redress (catalog + match-spend)
  • 8.6 Money-on-the-table dashboard (cross-source aggregation)

Skipped: 8.3 card-benefit tracker — depends on a card_benefits.yaml
profile catalog the smoke seed-data doesn't easily replicate. Covered
by the per-card profile loader's own tests.

Run:  py -m scripts.smoke_phase_8
"""
from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

THROWAWAY_DB = Path(__file__).parent.parent / "smoke_phase_8.db"
os.environ["DATABASE_URL"] = f"sqlite:///{THROWAWAY_DB}"

from sqlalchemy import select  # noqa: E402

from finance_app.db.models import (  # noqa: E402
    Account,
    AccountType,
    Base,
    BalanceSnapshot,
    CardApplication,
    CardApplicationStatus,
    IngestSource,
    Institution,
    InstitutionKind,
    Transaction,
    TransactionStatus,
    UnclaimedProperty,
    UnclaimedPropertyStatus,
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
    print("PHASE 8 — SMOKE TEST")
    print("=" * 60)
    setup_db()
    failures: list[str] = []

    db = SessionLocal()
    try:
        # ---- 8.1 Unclaimed property ----
        print()
        print("[8.1] Unclaimed property")
        from finance_app.api.unclaimed import get_stats as unclaimed_stats

        # Seed 3 records — found, claimed, paid
        db.add_all([
            UnclaimedProperty(
                state="CA", owner_name="Chris Avalos", holder_name="PG&E",
                estimated_value_cents=12500,
                status=UnclaimedPropertyStatus.found,
            ),
            UnclaimedProperty(
                state="NY", owner_name="Chris Avalos", holder_name="MetLife",
                estimated_value_cents=80000,
                status=UnclaimedPropertyStatus.claimed,
            ),
            UnclaimedProperty(
                state="TX", owner_name="Chris Avalos", holder_name="Old Bank",
                estimated_value_cents=5000,
                status=UnclaimedPropertyStatus.paid,
                actual_payout_cents=4800,
            ),
        ])
        db.commit()

        stats = unclaimed_stats(db)
        print(f"  total={stats.total_count} pending={stats.estimated_pending_cents/100:.0f} collected={stats.actual_collected_cents/100:.0f}")
        if stats.total_count != 3:
            failures.append(f"8.1 total_count: {stats.total_count}")
        # Pending = found + claimed: 12500 + 80000 = 92_500
        if stats.estimated_pending_cents != 92_500:
            failures.append(f"8.1 pending: {stats.estimated_pending_cents} (expected 92_500)")
        # Collected = paid actual = 4_800
        if stats.actual_collected_cents != 4_800:
            failures.append(f"8.1 collected: {stats.actual_collected_cents} (expected 4_800)")

        # ---- 8.2 Card applications + 5/24 ----
        print()
        print("[8.2] Card applications + 5/24")
        # Seed 4 approved cards within last 24mo (under 5/24)
        today = datetime.utcnow()
        for i, card_name in enumerate(["Sapphire Preferred", "Amex Gold", "Capital One Venture X", "Citi Premier"]):
            db.add(
                CardApplication(
                    issuer="various",
                    card_name=card_name,
                    status=CardApplicationStatus.bonus_posted,
                    counts_toward_5_24=True,
                    bonus_value_cents=80_000,
                    minimum_spend_cents=400_000,
                    spend_to_date_cents=400_000,
                    minimum_spend_window_days=90,
                    approved_at=today - timedelta(days=200 + i * 60),
                    bonus_earned_at=today - timedelta(days=100 + i * 60),
                    bonus_posted_at=today - timedelta(days=80 + i * 60),
                )
            )
        db.commit()

        from finance_app.api.card_applications import eligibility as get_eligibility
        elig = get_eligibility(db)
        print(f"  5/24: {elig.chase_5_24.cards_opened_in_window}/5 (under: {elig.chase_5_24.is_under_5_24})")
        if elig.chase_5_24.cards_opened_in_window != 4:
            failures.append(f"8.2 5/24 count: {elig.chase_5_24.cards_opened_in_window}")
        if not elig.chase_5_24.is_under_5_24:
            failures.append("8.2 expected to be under 5/24 (4 cards)")

        # ---- 8.4 Yield arb ----
        print()
        print("[8.4] Yield arb")
        from finance_app.api.yield_opt import get_report as yield_report

        inst = Institution(name="Big Bank", kind=InstitutionKind.bank)
        db.add(inst)
        db.flush()
        # $50k in checking earning ~0.01% — should trigger arb
        savings = Account(
            institution_id=inst.id,
            name="Megabank Checking",
            account_type=AccountType.checking,
            current_balance_cents=5_000_000,
        )
        db.add(savings)
        db.flush()
        db.add(BalanceSnapshot(
            account_id=savings.id, as_of=date.today(),
            balance_cents=5_000_000, source=IngestSource.manual,
        ))
        db.commit()

        report = yield_report(db)
        print(f"  total idle={report.total_idle_balance_cents/100:.0f} potential delta=${report.total_yearly_potential_delta_cents/100:.0f}/yr")
        if report.total_idle_balance_cents != 5_000_000:
            failures.append(f"8.4 idle balance: {report.total_idle_balance_cents}")
        if report.total_yearly_potential_delta_cents <= 100_000:
            failures.append(f"8.4 potential delta seems low: {report.total_yearly_potential_delta_cents}")
        # Should have at least one qualifying account
        qualifying = [a for a in report.accounts if a.qualifies_for_arb]
        if not qualifying:
            failures.append("8.4 no qualifying accounts — $50k checking should arb")

        # ---- 8.5 CFPB redress ----
        print()
        print("[8.5] CFPB redress")
        from finance_app.api.redress import list_known, match_spend

        known = list_known(db)
        print(f"  catalog size: {len(known)}")
        if len(known) < 3:
            failures.append(f"8.5 catalog seems too small: {len(known)}")

        # Seed a Wells Fargo transaction so match_spend has something to find
        cat_dummy = None
        # Need an existing checking account for the txn — reuse the one above
        db.add(
            Transaction(
                account_id=savings.id,  # the bank account
                posted_date=date.today() - timedelta(days=30),
                amount_cents=-5000, currency="USD",
                description_raw="WELLS FARGO ATM FEE",
                status=TransactionStatus.posted, source=IngestSource.plaid,
                external_id="wf-1",
            )
        )
        db.commit()

        matches = match_spend(days=730, db=db)
        print(f"  matches found: {len(matches.matches)}")
        wf_match = [m for m in matches.matches if "Wells Fargo" in m.catalog_entry.company_name]
        if not wf_match:
            failures.append("8.5 Wells Fargo match should have fired against seeded txn")

        # ---- 8.6 Money on the Table — cross-source roll-up ----
        print()
        print("[8.6] Money on the Table aggregator")
        from finance_app.api.money_on_table import get_report as mot_report

        report = mot_report(db)
        print(f"  opportunities: {len(report.opportunities)}")
        print(f"  source kinds: {sorted(report.counts_by_kind.keys())}")
        # Should pull from at least: unclaimed, yield_arb, regulatory_redress, passive_check, bank_bonus, brokerage_bonus
        expected_kinds = {"unclaimed_property", "yield_arb", "regulatory_redress", "passive_check"}
        seen = set(report.counts_by_kind.keys())
        missing = expected_kinds - seen
        if missing:
            failures.append(f"8.6 missing source kinds: {sorted(missing)}")
        # Total claimable should be substantial — we seeded $80k claimed unclaimed + bunch of catalog entries
        if report.total_claimable_cents <= 0:
            failures.append("8.6 total_claimable_cents is 0 — aggregators didn't fire")
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
    print("  PHASE 8 SMOKE TEST PASSED ✓")
    teardown_db()
    return 0


if __name__ == "__main__":
    sys.exit(run())
