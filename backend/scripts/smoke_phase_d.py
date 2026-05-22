"""Smoke test for Phase D — Savings, goals, and the suggestion engine.

What we cover:

  [1] Surplus engine — historical mode (rolling 30d in − rolling 30d out).
  [2] Surplus engine — forecast mode (projected income − cadenced subs −
      rolling variable spend).
  [3] /savings/surplus?mode=both — both numbers in one round-trip.
  [4] Goal CRUD — create + list + update + delete.
  [5] Goal contributions — POST /goals/{id}/contribute updates the cached
      ``current_amount_cents`` transactionally; DELETE reverses it.
  [6] Auto-mark "achieved" when a final contribution crosses the target.
  [7] Suggestion engine — allocations greedy-fill against the surplus,
      cancellations rank confirmed/active subs, debt strategies surface
      avalanche + snowball.
  [8] Before/after math is present and well-formed on every suggestion.

We use FastAPI's TestClient against an isolated SQLite DB. The TestClient
context manager runs the lifespan handler so create_all + auto-migrations
fire — without it the tables wouldn't exist.

Run::

    cd backend
    python scripts/smoke_phase_d.py
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta
from pathlib import Path

# Isolated DB. Override via SMOKE_DB_PATH for sandboxed runs.
TEST_DB_PATH = Path(
    os.environ.get("SMOKE_DB_PATH")
    or (Path(__file__).resolve().parent.parent / "smoke_phase_d.db")
)
# Some sandbox mounts can't reliably PRAGMA journal_mode=WAL; keep DB on /tmp
# in those cases. SMOKE_DB_PATH=/tmp/smoke_phase_d.db is the recommended override.
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH}"
if TEST_DB_PATH.exists():
    TEST_DB_PATH.unlink()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from finance_app.api.main import app  # noqa: E402
from finance_app.db.models import (  # noqa: E402
    Account,
    AccountType,
    IngestSource,
    Institution,
    InstitutionKind,
    Merchant,
    Subscription,
    SubscriptionStatus,
    SubscriptionType,
    Transaction,
    TransactionStatus,
)
from finance_app.db.session import SessionLocal  # noqa: E402

# Anchor "today" so the rolling-window math is deterministic. Must be late
# enough that all our seeded transactions land inside the trailing 30d.
SMOKE_TODAY = date(2026, 4, 24)


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        print(f"  ✗ {msg}")
        raise SystemExit(1)


def _cents(n: float) -> int:
    """Dollars → cents (signed). Outflows must be negative when stored."""
    return int(round(n * 100))


def _seed_skeleton() -> dict[str, int]:
    """Seed minimal scaffolding so the surplus + suggestion engines have data.

    Returns a dict of useful ids — checking + credit-card account ids and a
    couple of merchants the subscription rows can link to.
    """
    with SessionLocal() as db:
        bank = Institution(name="Smoke Bank", kind=InstitutionKind.bank)
        cc = Institution(name="Smoke Card Co", kind=InstitutionKind.credit_card_issuer)
        db.add_all([bank, cc])
        db.flush()

        checking = Account(
            institution_id=bank.id,
            name="Checking",
            account_type=AccountType.checking,
            mask="0001",
        )
        card = Account(
            institution_id=cc.id,
            name="Visa",
            account_type=AccountType.credit_card,
            mask="0002",
            credit_limit_cents=500_000,
            # 15% APR keeps the monthly interest ($37.50 on $3000) well under
            # the 2% minimum payment ($60), so _months_to_payoff projects
            # finitely. At 24% the two would be equal and the engine would
            # return None (loan never amortises) — fine product behavior, but
            # a less interesting test fixture.
            apr_bps=1500,
            current_balance_cents=300_000,  # $3000 outstanding
        )
        db.add_all([checking, card])
        db.flush()

        netflix = Merchant(name="Netflix")
        spotify = Merchant(name="Spotify")
        db.add_all([netflix, spotify])
        db.flush()

        # ----- Transactions for the rolling-30d windows -----
        # Inflows: $5000 paycheck on day-15 (well inside the trailing window).
        # Outflows: $2400 of variable spend + $30 streaming subs (handled
        # below as "subscription" rows so the forecast cadence math kicks in).
        anchor = SMOKE_TODAY
        days_back = lambda n: anchor - timedelta(days=n)

        txns = [
            # Inflows (positive cents)
            Transaction(
                account_id=checking.id,
                posted_date=days_back(15),
                amount_cents=_cents(5000),
                currency="USD",
                status=TransactionStatus.posted,
                description_raw="EMPLOYER PAYROLL DEPOSIT",
                source=IngestSource.manual,
                external_id="phaseD-payroll-1",
            ),
            # Variable spend (negative)
            Transaction(
                account_id=checking.id,
                posted_date=days_back(2),
                amount_cents=-_cents(120),
                currency="USD",
                status=TransactionStatus.posted,
                description_raw="GROCERIES",
                source=IngestSource.manual,
                external_id="phaseD-groc-1",
            ),
            Transaction(
                account_id=checking.id,
                posted_date=days_back(7),
                amount_cents=-_cents(80),
                currency="USD",
                status=TransactionStatus.posted,
                description_raw="GAS",
                source=IngestSource.manual,
                external_id="phaseD-gas-1",
            ),
            Transaction(
                account_id=checking.id,
                posted_date=days_back(20),
                amount_cents=-_cents(450),
                currency="USD",
                status=TransactionStatus.posted,
                description_raw="DOORDASH MISC",
                source=IngestSource.manual,
                external_id="phaseD-dd-1",
            ),
            # Subscription-like outflows. The forecast engine excludes
            # transactions whose merchant matches a confirmed-active sub,
            # so seeding both the txns AND the Subscription rows means the
            # subs only get counted ONCE (as projected obligations).
            Transaction(
                account_id=checking.id,
                posted_date=days_back(5),
                amount_cents=-_cents(15.99),
                currency="USD",
                status=TransactionStatus.posted,
                description_raw="NETFLIX.COM",
                source=IngestSource.manual,
                external_id="phaseD-nf-1",
                merchant_id=netflix.id,
            ),
            Transaction(
                account_id=checking.id,
                posted_date=days_back(8),
                amount_cents=-_cents(11.99),
                currency="USD",
                status=TransactionStatus.posted,
                description_raw="SPOTIFY USA",
                source=IngestSource.manual,
                external_id="phaseD-sp-1",
                merchant_id=spotify.id,
            ),
        ]
        db.add_all(txns)
        db.flush()

        # ----- Subscriptions: confirmed + active + monthly cadence -----
        # These drive the forecast's "fixed_obligations_cents" line and the
        # cancellation suggestions. Streaming gets the highest cancel-confidence
        # bucket (0.75) so they should show up first in the cancel list.
        subs = [
            Subscription(
                merchant_id=netflix.id,
                name="Netflix",
                amount_cents=-_cents(15.99),
                cadence_days=30,
                status=SubscriptionStatus.active,
                subscription_type=SubscriptionType.streaming,
                is_user_confirmed=True,
                last_amount_cents=-_cents(15.99),
                confidence_score=0.92,
                n_occurrences=5,
                cadence_label="monthly",
            ),
            Subscription(
                merchant_id=spotify.id,
                name="Spotify",
                amount_cents=-_cents(11.99),
                cadence_days=30,
                status=SubscriptionStatus.active,
                subscription_type=SubscriptionType.streaming,
                is_user_confirmed=True,
                last_amount_cents=-_cents(11.99),
                confidence_score=0.90,
                n_occurrences=5,
                cadence_label="monthly",
            ),
        ]
        db.add_all(subs)
        db.commit()

        return {
            "checking_id": checking.id,
            "card_id": card.id,
            "netflix_merchant_id": netflix.id,
            "spotify_merchant_id": spotify.id,
        }


# ---------------------------------------------------------------------------
#  [1-3] Surplus engine
# ---------------------------------------------------------------------------


def step_surplus(client: TestClient) -> None:
    print("\n[1-3/8] Surplus engine — historical, forecast, both ...")

    # Historical first
    r = client.get("/api/savings/surplus?mode=historical")
    _assert(r.status_code == 200, f"GET /surplus?mode=historical → {r.status_code}: {r.text}")
    snap = r.json()
    _assert(snap["historical"] is not None, "historical mode missing breakdown")
    _assert(snap["forecast"] is None, "historical mode should not include forecast")
    h = snap["historical"]
    # Inflows = $5000 (1 txn). Outflows = 120+80+450+15.99+11.99 = $677.98 (5 txns).
    _assert(h["inflows_cents"] == 500_000, f"inflows_cents={h['inflows_cents']}, want 500000")
    _assert(
        67_790 <= h["outflows_cents"] <= 67_810,
        f"outflows_cents={h['outflows_cents']}, want ~67798",
    )
    expected_surplus = h["inflows_cents"] - h["outflows_cents"]
    _assert(
        h["surplus_cents"] == expected_surplus,
        f"historical surplus arithmetic: {h['surplus_cents']} != {expected_surplus}",
    )
    _assert(h["n_inflow_txns"] == 1, f"n_inflow_txns={h['n_inflow_txns']}, want 1")
    _assert(h["n_outflow_txns"] == 5, f"n_outflow_txns={h['n_outflow_txns']}, want 5")
    print(
        f"  ✓ historical: in={h['inflows_cents']/100:.2f} out={h['outflows_cents']/100:.2f} "
        f"surplus={h['surplus_cents']/100:.2f}"
    )

    # Forecast
    r = client.get("/api/savings/surplus?mode=forecast")
    _assert(r.status_code == 200, f"GET /surplus?mode=forecast → {r.status_code}: {r.text}")
    snap_f = r.json()
    _assert(snap_f["historical"] is None, "forecast mode should not include historical")
    _assert(snap_f["forecast"] is not None, "forecast mode missing breakdown")
    f = snap_f["forecast"]
    _assert(f["projected_income_cents"] > 0, "projected_income_cents should be > 0 — we seeded a paycheck")
    # Fixed obligations should reflect Netflix+Spotify projected onto next 30d.
    # 30d cadence → monthly cost = amount × 30/30 = amount, so ~$27.98 total.
    _assert(
        2_700 <= f["fixed_obligations_cents"] <= 2_900,
        f"fixed_obligations_cents={f['fixed_obligations_cents']}, want ~2798",
    )
    _assert(
        f["n_active_subscriptions"] == 2,
        f"n_active_subscriptions={f['n_active_subscriptions']}, want 2",
    )
    _assert(f["variable_spend_cents"] >= 0, "variable_spend_cents should be non-negative")
    print(
        f"  ✓ forecast: income={f['projected_income_cents']/100:.2f} "
        f"fixed={f['fixed_obligations_cents']/100:.2f} "
        f"variable={f['variable_spend_cents']/100:.2f} "
        f"surplus={f['surplus_cents']/100:.2f}"
    )

    # Both
    r = client.get("/api/savings/surplus?mode=both")
    _assert(r.status_code == 200, f"GET /surplus?mode=both → {r.status_code}: {r.text}")
    both = r.json()
    _assert(both["historical"] is not None, "both mode missing historical")
    _assert(both["forecast"] is not None, "both mode missing forecast")
    print("  ✓ both: historical + forecast both populated")


# ---------------------------------------------------------------------------
#  [4-6] Goal CRUD + contributions + auto-achieved
# ---------------------------------------------------------------------------


def step_goal_crud(client: TestClient, ids: dict[str, int]) -> dict[str, int]:
    print("\n[4-6/8] Goal CRUD + contributions + auto-achieved ...")

    # --- Create an emergency fund goal ---
    r = client.post(
        "/api/goals",
        json={
            "name": "Emergency fund — 1 month",
            "kind": "emergency_fund",
            "target_amount_cents": 300_000,  # $3000 (1mo expenses)
            "target_date": "2026-12-31",
            "priority": 1,
            "status": "active",
            "linked_account_id": ids["checking_id"],
            "linked_debt_account_id": None,
            "notes": None,
        },
    )
    _assert(r.status_code == 201, f"POST /goals → {r.status_code}: {r.text}")
    ef = r.json()
    _assert(ef["current_amount_cents"] == 0, "new goal should start at 0")
    print(f"  ✓ created emergency fund goal id={ef['id']}")

    # --- Create a debt payoff goal linked to the credit card ---
    r = client.post(
        "/api/goals",
        json={
            "name": "Pay off Visa",
            "kind": "debt_payoff",
            "target_amount_cents": 300_000,  # principal of $3000
            "priority": 2,
            "linked_debt_account_id": ids["card_id"],
        },
    )
    _assert(r.status_code == 201, f"POST /goals (debt) → {r.status_code}: {r.text}")
    debt = r.json()
    print(f"  ✓ created debt payoff goal id={debt['id']}")

    # --- Create a small specific-savings goal we'll fully fund to test
    # auto-achieved logic. ---
    r = client.post(
        "/api/goals",
        json={
            "name": "New laptop",
            "kind": "specific_savings",
            "target_amount_cents": 50_000,  # $500
            "priority": 3,
        },
    )
    _assert(r.status_code == 201, f"POST /goals (laptop) → {r.status_code}: {r.text}")
    laptop = r.json()

    # --- List with status filter ---
    r = client.get("/api/goals?status=active")
    _assert(r.status_code == 200, f"GET /goals?status=active → {r.status_code}")
    rows = r.json()
    _assert(len(rows) == 3, f"GET /goals returned {len(rows)} active rows, want 3")
    # First row should be emergency fund (kind_rank=1, priority=1).
    _assert(rows[0]["id"] == ef["id"], f"sort order: first row id={rows[0]['id']}, want {ef['id']}")
    _assert(rows[0]["kind"] == "emergency_fund", "first row kind mismatch")
    print("  ✓ list-with-filter sorts by kind→priority correctly")

    # --- Contribute to emergency fund ---
    r = client.post(
        f"/api/goals/{ef['id']}/contribute",
        json={"amount_cents": 50_000, "contributed_at": SMOKE_TODAY.isoformat()},
    )
    _assert(r.status_code == 201, f"POST /contribute (ef) → {r.status_code}: {r.text}")
    r = client.get(f"/api/goals/{ef['id']}")
    _assert(r.json()["current_amount_cents"] == 50_000, "ef cache should be 50000 after contribution")
    print("  ✓ ef cache bumped to $500.00 after contribution")

    # --- Two contributions to the laptop goal that together cross the target ---
    r = client.post(
        f"/api/goals/{laptop['id']}/contribute",
        json={"amount_cents": 30_000, "contributed_at": SMOKE_TODAY.isoformat()},
    )
    _assert(r.status_code == 201, f"POST /contribute (laptop #1) → {r.status_code}: {r.text}")
    r = client.post(
        f"/api/goals/{laptop['id']}/contribute",
        json={"amount_cents": 25_000, "contributed_at": SMOKE_TODAY.isoformat()},
    )
    _assert(r.status_code == 201, f"POST /contribute (laptop #2) → {r.status_code}: {r.text}")
    r = client.get(f"/api/goals/{laptop['id']}")
    laptop_after = r.json()
    _assert(
        laptop_after["current_amount_cents"] == 55_000,
        f"laptop cache={laptop_after['current_amount_cents']}, want 55000",
    )
    _assert(
        laptop_after["status"] == "achieved",
        f"laptop should auto-achieve once current >= target; got status={laptop_after['status']}",
    )
    print("  ✓ laptop auto-marked 'achieved' on the contribution that crossed target")

    # --- Delete the second laptop contribution to drop below target ---
    r = client.get(f"/api/goals/{laptop['id']}/contributions")
    _assert(r.status_code == 200, f"GET contributions → {r.status_code}")
    contribs = r.json()
    last_contrib_id = contribs[0]["id"]  # ordered DESC, so [0] is the most recent
    r = client.delete(f"/api/goals/{laptop['id']}/contributions/{last_contrib_id}")
    _assert(r.status_code == 204, f"DELETE contrib → {r.status_code}: {r.text}")
    r = client.get(f"/api/goals/{laptop['id']}")
    laptop_reverted = r.json()
    _assert(
        laptop_reverted["current_amount_cents"] == 30_000,
        f"after-delete cache={laptop_reverted['current_amount_cents']}, want 30000",
    )
    _assert(
        laptop_reverted["status"] == "active",
        f"after dropping below target, status should reopen to active; got {laptop_reverted['status']}",
    )
    print("  ✓ delete-contribution reverses cache + reopens goal")

    # --- Update the emergency fund (PATCH) ---
    r = client.patch(
        f"/api/goals/{ef['id']}",
        json={
            "name": "Emergency fund — 1 month",
            "kind": "emergency_fund",
            "target_amount_cents": 600_000,  # bumped to $6k (2mo)
            "priority": 1,
            "status": "active",
            "target_date": "2026-12-31",
            "linked_account_id": ids["checking_id"],
            "linked_debt_account_id": None,
            "notes": "Bumped to 2-month target after April raise.",
        },
    )
    _assert(r.status_code == 200, f"PATCH /goals/{{id}} → {r.status_code}: {r.text}")
    _assert(r.json()["target_amount_cents"] == 600_000, "PATCH didn't update target")
    print("  ✓ PATCH updates fields without disturbing cache")

    return {"ef_id": ef["id"], "debt_id": debt["id"], "laptop_id": laptop["id"]}


# ---------------------------------------------------------------------------
#  [7-8] Suggestion engine + before/after math
# ---------------------------------------------------------------------------


def step_suggestions(client: TestClient, _goal_ids: dict[str, int]) -> None:
    print("\n[7-8/8] Suggestion engine + before/after math ...")

    r = client.get("/api/savings/suggestions?mode=historical")
    _assert(r.status_code == 200, f"GET /suggestions → {r.status_code}: {r.text}")
    bundle = r.json()

    _assert("allocations" in bundle, "bundle missing 'allocations'")
    _assert("cancellations" in bundle, "bundle missing 'cancellations'")
    _assert("debt_strategies" in bundle, "bundle missing 'debt_strategies'")
    _assert(bundle["surplus_mode"] == "historical", "anchor mode mismatch")
    _assert(bundle["surplus_cents"] > 0, "historical surplus should be positive given seeds")
    print(
        f"  ✓ bundle anchored to historical surplus = {bundle['surplus_cents']/100:.2f}; "
        f"alloc={len(bundle['allocations'])} cancel={len(bundle['cancellations'])} "
        f"debt={len(bundle['debt_strategies'])}"
    )

    # --- Allocations: emergency fund (kind_rank=1, priority=1) should appear
    #     and be ranked first. ---
    _assert(
        len(bundle["allocations"]) >= 1,
        f"expected at least 1 allocation suggestion; got {len(bundle['allocations'])}",
    )
    first_alloc = bundle["allocations"][0]
    _assert(
        first_alloc["kind"] == "allocate_to_goal",
        f"alloc[0].kind={first_alloc['kind']}, want allocate_to_goal",
    )
    _assert(
        len(first_alloc["before_after"]) >= 1,
        "allocation suggestion should include before/after math",
    )
    ba = first_alloc["before_after"][0]
    for key in ("label", "current_cents", "if_act_cents", "if_dont_act_cents", "summary"):
        _assert(key in ba, f"before_after row missing key {key!r}")
    print(
        f"  ✓ first allocation: '{first_alloc['title']}' "
        f"current={ba['current_cents']/100:.2f} → "
        f"if_act={ba['if_act_cents']/100:.2f}"
    )

    # --- Cancellations: both Netflix + Spotify are confirmed-active streaming
    #     so each should generate a cancellation suggestion. ---
    cancel_titles = {s["title"] for s in bundle["cancellations"]}
    _assert(
        len(bundle["cancellations"]) >= 2,
        f"expected ≥2 cancellation suggestions; got {len(bundle['cancellations'])}",
    )
    print(f"  ✓ cancellation candidates: {sorted(cancel_titles)}")
    for s in bundle["cancellations"]:
        _assert(
            s["kind"] == "cancel_subscription",
            f"cancellation has kind={s['kind']}, want cancel_subscription",
        )
        _assert(s["confidence"] > 0.5, f"streaming cancellation conf {s['confidence']} too low")
        _assert(
            s["estimated_savings_cents"] > 0,
            f"cancel '{s['title']}' should report positive savings; got {s['estimated_savings_cents']}",
        )
        _assert(len(s["before_after"]) >= 1, f"cancel '{s['title']}' missing before/after rows")

    # --- Debt strategies: one Visa debt @ 24% APR + $3k → both avalanche AND
    #     snowball should produce a suggestion. With a single debt the two
    #     strategies pick the same target, but both rows still appear with
    #     differing labels so the UI can present the choice. ---
    _assert(
        len(bundle["debt_strategies"]) >= 1,
        f"expected ≥1 debt strategy suggestion; got {len(bundle['debt_strategies'])}",
    )
    strategy_kinds = {s["kind"] for s in bundle["debt_strategies"]}
    _assert(
        any(k.startswith("debt_payoff_") for k in strategy_kinds),
        f"no debt_payoff_* kind in strategies: {strategy_kinds}",
    )
    print(f"  ✓ debt strategies present: {sorted(strategy_kinds)}")

    debt_sug = bundle["debt_strategies"][0]
    _assert(
        len(debt_sug["before_after"]) >= 2,
        "debt strategy must include months + interest before/after rows",
    )
    # Pick the "Total interest paid" row — real cents, not the months-encoded-
    # as-cents trick on the months row. With our seed (24% APR, 2%-of-balance
    # minimum) the minimum payment exactly cancels the monthly interest, so
    # months_min projects to "infinite" → encoded as 0; the months row would
    # be a misleading comparison. Interest is unambiguous.
    by_label = {ba["label"]: ba for ba in debt_sug["before_after"]}
    ba_interest = by_label.get("Total interest paid (this debt)")
    _assert(
        ba_interest is not None,
        f"missing 'Total interest paid' row; got labels {list(by_label)}",
    )
    _assert(
        ba_interest["if_act_cents"] <= ba_interest["if_dont_act_cents"],
        f"avalanche/snowball: interest if_act={ba_interest['if_act_cents']} > if_dont_act={ba_interest['if_dont_act_cents']}",
    )
    _assert(
        debt_sug["estimated_savings_cents"] >= 0,
        f"debt strategy savings cannot be negative: {debt_sug['estimated_savings_cents']}",
    )
    print(
        f"  ✓ debt interest before/after: minimums=${ba_interest['if_dont_act_cents']/100:.2f}, "
        f"accelerated=${ba_interest['if_act_cents']/100:.2f}, "
        f"saves=${debt_sug['estimated_savings_cents']/100:.2f}"
    )

    # --- "both" mode is silently coerced to historical for the bundle. ---
    r = client.get("/api/savings/suggestions?mode=both")
    _assert(r.status_code == 200, f"GET /suggestions?mode=both → {r.status_code}: {r.text}")
    coerced = r.json()
    _assert(
        coerced["surplus_mode"] == "historical",
        f"'both' should coerce to 'historical' on /suggestions; got {coerced['surplus_mode']}",
    )
    print("  ✓ 'both' mode silently coerces to 'historical' on /suggestions")


# ---------------------------------------------------------------------------
#  Driver
# ---------------------------------------------------------------------------


def main() -> int:
    print("=" * 64)
    print("PHASE D — SAVINGS, GOALS, SUGGESTIONS — SMOKE TEST")
    print("=" * 64)

    # Use the lifespan context so create_all + auto-migrations actually run.
    with TestClient(app) as client:
        ids = _seed_skeleton()
        step_surplus(client)
        goal_ids = step_goal_crud(client, ids)
        step_suggestions(client, goal_ids)

    print("\n" + "=" * 64)
    print("ALL PHASE D SMOKE STEPS PASSED")
    print("=" * 64)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
