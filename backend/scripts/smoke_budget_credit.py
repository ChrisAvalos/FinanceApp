"""Smoke test for the new Budget / Credit / MoM endpoints.

Runs FastAPI in-process (TestClient) against an isolated sqlite DB. Verifies
that the date-refactored Budget + MoM contracts return what the frontend
expects, and that the Credit utilization + opportunities math still works.

Run:
    cd backend
    python scripts/smoke_budget_credit.py
"""
from __future__ import annotations

import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

TEST_DB_PATH = Path(
    os.environ.get("SMOKE_DB_PATH")
    or (Path(__file__).resolve().parent.parent / "smoke_bc.db")
)
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH}"
if TEST_DB_PATH.exists():
    TEST_DB_PATH.unlink()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from finance_app.api.main import app  # noqa: E402
from finance_app.db.models import (  # noqa: E402
    Account,
    AccountType,
    Base,
    Category,
    CreditBureau,
    CreditScoringModel,
    IngestSource,
    Institution,
    InstitutionKind,
    ScoreSource,
    Transaction,
    TransactionStatus,
)
from finance_app.db.seed import seed_all  # noqa: E402
from finance_app.db.session import SessionLocal, engine  # noqa: E402


def _slug(s: str) -> str:
    return s.lower().replace(" ", "_").replace("&", "and")


def main() -> int:
    print("=" * 60)
    print("BUDGET + CREDIT + MOM SMOKE TEST")
    print("=" * 60)

    Base.metadata.create_all(bind=engine)
    seed_all()

    with SessionLocal() as db:
        inst = Institution(name="Chase", kind=InstitutionKind.bank)
        db.add(inst)
        db.flush()

        card = Account(
            institution_id=inst.id,
            name="Chase Freedom Unlimited",
            account_type=AccountType.credit_card,
            mask="4242",
            currency="USD",
            credit_limit_cents=500_000,  # $5,000
            current_balance_cents=220_000,  # $2,200 live balance → 44% util
            last_statement_balance_cents=220_000,
            last_statement_date=date(2026, 4, 1),
            statement_close_day=28,
            statement_due_day=25,
        )
        db.add(card)
        db.flush()
        card_id = card.id

        # Seed two categories for the budget test
        dining = db.query(Category).filter(Category.slug == _slug("Dining")).one_or_none()
        groc = db.query(Category).filter(Category.slug == _slug("Groceries")).one_or_none()
        if dining is None:
            dining = Category(name="Dining", slug="dining", is_discretionary=True)
            db.add(dining)
        if groc is None:
            groc = Category(name="Groceries", slug="groceries", is_discretionary=False)
            db.add(groc)
        db.commit()
        dining_id = dining.id
        groc_id = groc.id

        # Seed transactions in April + March + February 2026 so MoM has data
        def _txn(d: date, cents: int, desc: str, cat_id: int | None, ext: str) -> None:
            db.add(
                Transaction(
                    account_id=card_id,
                    posted_date=d,
                    amount_cents=cents,
                    currency="USD",
                    status=TransactionStatus.posted,
                    description_raw=desc,
                    source=IngestSource.manual,
                    external_id=ext,
                    category_id=cat_id,
                )
            )

        # April (current month, half-elapsed) — dining is over, groceries is on track
        _txn(date(2026, 4, 5), -30_000, "Sushi", dining_id, "s1")   # $300
        _txn(date(2026, 4, 12), -10_700, "Steakhouse", dining_id, "s2")  # $107 → 407
        _txn(date(2026, 4, 8), -8_000, "Safeway", groc_id, "s3")   # $80
        _txn(date(2026, 4, 18), -4_700, "Trader Joes", groc_id, "s4")  # $47 → 127
        # Uncategorized spending in April → shows up in unbudgeted_spending
        _txn(date(2026, 4, 10), -15_000, "Mystery Charge", None, "s5")  # $150

        # March
        _txn(date(2026, 3, 5), -12_000, "Sushi", dining_id, "m1")
        _txn(date(2026, 3, 14), -9_500, "Safeway", groc_id, "m2")

        # February
        _txn(date(2026, 2, 9), -20_000, "Sushi", dining_id, "f1")
        _txn(date(2026, 2, 22), -7_000, "Safeway", groc_id, "f2")

        db.commit()

    client = TestClient(app)

    # ---- 1. Create two budgets for April 2026 ----
    print("\n[1/5] POST /api/budgets (Dining $300, Groceries $800) ...")
    r = client.post(
        "/api/budgets",
        json={
            "category_id": dining_id,
            "month_start": "2026-04-15",  # deliberately mid-month → normalized
            "amount_cents": 30_000,
            "rollover": False,
            "notes": None,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["month_start"] == "2026-04-01", r.json()
    print(f"    dining budget ok: month_start={r.json()['month_start']}")

    r = client.post(
        "/api/budgets",
        json={
            "category_id": groc_id,
            "month_start": "2026-04-01",
            "amount_cents": 80_000,
            "rollover": False,
            "notes": None,
        },
    )
    assert r.status_code == 200, r.text
    print("    groceries budget ok")

    # Upsert: re-POST the dining one, it should update in place
    r = client.post(
        "/api/budgets",
        json={
            "category_id": dining_id,
            "month_start": "2026-04-01",
            "amount_cents": 35_000,  # bumped to $350
            "rollover": False,
            "notes": "bumped",
        },
    )
    assert r.status_code == 200
    assert r.json()["amount_cents"] == 35_000
    print("    upsert replaced amount correctly")

    # ---- 2. GET rollup ----
    print("\n[2/5] GET /api/budgets/rollup?month_start=2026-04-01 ...")
    r = client.get("/api/budgets/rollup", params={"month_start": "2026-04-01"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["month_start"] == "2026-04-01"
    print(f"    pace={body['pace']}  total_budget=${body['total_budget_cents']/100:.2f}  "
          f"total_actual=${body['total_actual_cents']/100:.2f}")
    for row in body["rows"]:
        print(f"      {row['category_name']:<12} "
              f"budget=${row['budget_cents']/100:>7.2f}  "
              f"actual=${row['actual_outflow_cents']/100:>7.2f}  "
              f"pct={row['pct_used']:>5.1f}%  status={row['status']}")
    print(f"    unbudgeted: {len(body['unbudgeted_spending'])} row(s)")
    for u in body["unbudgeted_spending"]:
        print(f"      {u['category_name']:<14} ${u['actual_outflow_cents']/100:>7.2f}")

    # Dining should be OVER (407 > 350). Groceries should be on_track (127 / 800).
    dining_row = next(r for r in body["rows"] if r["category_name"] == "Dining")
    groc_row = next(r for r in body["rows"] if r["category_name"] == "Groceries")
    assert dining_row["status"] == "over", dining_row
    assert dining_row["actual_outflow_cents"] == 40_700
    assert groc_row["actual_outflow_cents"] == 12_700
    # The Mystery Charge should be in unbudgeted_spending
    unbudgeted_amounts = [u["actual_outflow_cents"] for u in body["unbudgeted_spending"]]
    assert 15_000 in unbudgeted_amounts, body["unbudgeted_spending"]
    print("    ✓ budget math + unbudgeted detection verified")

    # ---- 3. GET /stats/month-over-month ----
    print("\n[3/5] GET /api/stats/month-over-month?months=3 ...")
    r = client.get("/api/stats/month-over-month", params={"months": 3})
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["months"]) == 3
    for m in body["months"]:
        assert "month_start" in m and "year" not in m, m  # date refactor check
        print(f"      {m['month_start']}  outflow=${m['outflow_cents']/100:,.2f}")
    print(f"    categories: {len(body['categories'])}")
    for c in body["categories"][:5]:
        trend = f"{c['trend_pct_vs_avg']:+.1f}%" if c["trend_pct_vs_avg"] is not None else "n/a"
        print(f"      {c['category_name'] or '(uncat)':<14} "
              f"series={c['outflow_by_month_cents']} avg=${c['avg_outflow_cents']/100:,.2f} "
              f"trend={trend}")
    print("    ✓ MoM response uses month_start dates")

    # ---- 4. Credit scores CRUD ----
    print("\n[4/5] POST /api/credit/scores ...")
    r = client.post(
        "/api/credit/scores",
        json={
            "score": 715,
            "bureau": CreditBureau.experian.value,
            "scoring_model": CreditScoringModel.fico8.value,
            "as_of": "2026-04-20",
            "source": ScoreSource.manual.value,
            "source_detail": "chase dashboard",
            "notes": None,
        },
    )
    assert r.status_code == 200, r.text
    score_id = r.json()["id"]
    print(f"    created score id={score_id}  value={r.json()['score']}")

    r = client.get("/api/credit/scores")
    assert r.status_code == 200, r.text
    assert len(r.json()) >= 1

    # ---- 4b. Budget templates: copy + fill-from-average ----
    print("\n[4b] POST /api/budgets/copy-from-prior (April → May) ...")
    r = client.post(
        "/api/budgets/copy-from-prior",
        json={"target_month_start": "2026-05-01", "overwrite": False},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["target_month_start"] == "2026-05-01"
    assert body["source_month_start"] == "2026-04-01"
    # Two April budgets exist — both should be copied to May
    assert body["created"] == 2, body
    assert body["updated"] == 0
    assert body["skipped"] == 0
    print(f"    created={body['created']} updated={body['updated']} skipped={body['skipped']}")

    # Re-running the copy should be idempotent (everything skipped)
    r2 = client.post(
        "/api/budgets/copy-from-prior",
        json={"target_month_start": "2026-05-01", "overwrite": False},
    )
    body2 = r2.json()
    assert body2["created"] == 0 and body2["skipped"] == 2, body2
    print(f"    idempotent re-run: created={body2['created']} skipped={body2['skipped']} ✓")

    # Now overwrite=true should update both
    r3 = client.post(
        "/api/budgets/copy-from-prior",
        json={"target_month_start": "2026-05-01", "overwrite": True},
    )
    body3 = r3.json()
    assert body3["updated"] == 2, body3
    print(f"    overwrite re-run: updated={body3['updated']} ✓")

    print("\n[4c] POST /api/budgets/fill-from-average (June, 3-mo lookback) ...")
    r = client.post(
        "/api/budgets/fill-from-average",
        json={
            "target_month_start": "2026-06-01",
            "lookback_months": 3,
            "round_up_to_cents": 2_500,
            "overwrite": False,
            "min_avg_cents": 500,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["target_month_start"] == "2026-06-01"
    assert body["lookback_months"] == 3
    assert body["source_month_start"] is None
    print(f"    created={body['created']} skipped={body['skipped']}")
    for row in body["rows"]:
        print(f"      [{row['action']:<18}] {row['category_name']:<14} ${row['amount_cents']/100:>7.2f}")
    # Lookback for June = the 3 months preceding it: Mar, Apr, May.
    # May has no transactions in this fixture, so:
    #   Dining   = (Mar 120 + Apr 407 + May 0) / 3 = $175.67 → ceil-$25 = $200
    #   Groceries = (Mar 95 + Apr 127 + May 0) / 3 = $74.00  → ceil-$25 = $75
    dining_row = next(r for r in body["rows"] if r["category_name"] == "Dining")
    assert dining_row["action"] in ("created", "updated"), dining_row
    assert dining_row["amount_cents"] == 20_000, dining_row  # $200
    groc_row = next(r for r in body["rows"] if r["category_name"] == "Groceries")
    assert groc_row["amount_cents"] == 7_500, groc_row  # $75
    print("    ✓ averages rounded up to $25 granularity correctly")

    # ---- 5. Utilization + opportunities ----
    print("\n[5/5] GET /api/credit/utilization and /opportunities ...")
    r = client.get("/api/credit/utilization")
    assert r.status_code == 200, r.text
    u = r.json()
    print(f"    aggregate_live={u['aggregate_live_utilization_pct']}%  "
          f"aggregate_reported={u['aggregate_reported_utilization_pct']}%")
    for row in u["rows"]:
        print(f"      {row['account_name']:<30} "
              f"live={row['live_utilization_pct']:>5.1f}%  "
              f"reported={row['last_statement_balance_cents']/100:>8.2f}  "
              f"days_until_close={row['days_until_close']}")
    # Should be 44% utilization on the card
    assert u["rows"], u
    card_row = u["rows"][0]
    assert 43 <= card_row["live_utilization_pct"] <= 45, card_row

    r = client.get("/api/credit/opportunities")
    assert r.status_code == 200, r.text
    opps = r.json()["opportunities"]
    print(f"    {len(opps)} opportunity/ies:")
    for o in opps:
        print(f"      [{o['kind']}] {o['title']}")
        print(f"         rationale: {o['rationale']}")
        print(f"         before: {o['before_state']}")
        print(f"         if_acted: {o['projected_after_if_acted']}")
        print(f"         delta: {o['estimated_score_delta']}  confidence: {o['confidence']}")
    # At 44% we should get a paydown suggestion (to cross the 30% cliff)
    assert any(o["kind"] == "paydown_before_close" for o in opps), opps
    print("    ✓ paydown opportunity fired for 44% utilization")

    engine.dispose()
    try:
        TEST_DB_PATH.unlink(missing_ok=True)
    except PermissionError:
        pass

    print("\n" + "=" * 60)
    print("BUDGET + CREDIT + MOM SMOKE TEST PASSED ✓")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
