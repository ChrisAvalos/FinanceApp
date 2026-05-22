"""Smoke test for the legal-claims (Phase F) endpoints.

In-process FastAPI TestClient against an isolated SQLite DB. Verifies:
* POST creates rows (not_required / required / unknown variants)
* GET filters by status / proof_status / include_expired
* Duplicate source_url returns a clean 409
* PATCH transitions status and stamps claimed_at / paid_at
* GET /stats sums potential & collected with the 3-way proof split
* DELETE removes the row

Run:
    cd backend
    python scripts/smoke_legal_claims.py
"""
from __future__ import annotations

import os
import sys
from datetime import date, timedelta
from pathlib import Path

TEST_DB_PATH = Path(
    os.environ.get("SMOKE_DB_PATH")
    or (Path(__file__).resolve().parent.parent / "smoke_legal.db")
)
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH}"
if TEST_DB_PATH.exists():
    TEST_DB_PATH.unlink()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from finance_app.api.main import app  # noqa: E402
from finance_app.db.models import Base  # noqa: E402
from finance_app.db.session import engine  # noqa: E402


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        print(f"  ✗ {msg}")
        raise SystemExit(1)


def main() -> int:
    print("=" * 60)
    print("LEGAL CLAIMS SMOKE TEST")
    print("=" * 60)
    Base.metadata.create_all(bind=engine)

    client = TestClient(app)
    today = date.today()

    # ------------------------------------------------------------------
    # [1] Create three variants — not_required, required, unknown
    # ------------------------------------------------------------------
    print("\n[1/6] POST /api/legal-claims (three variants) ...")
    no_proof = {
        "name": "Yahoo data breach 2012",
        "source_url": "https://example.com/yahoo-2012",
        "administrator": "Yahoo Settlement Admin",
        "description": "Yahoo accountholder during the breach period.",
        "eligibility": "Had a Yahoo account between 2012-2016",
        "proof_status": "not_required",
        "estimated_payout_cents": 2500,  # $25
        "claim_deadline": (today + timedelta(days=30)).isoformat(),
    }
    with_proof = {
        "name": "Equifax 2017 breach",
        "source_url": "https://example.com/equifax-2017",
        "administrator": "Equifax Settlement",
        "description": "Out-of-pocket losses tied to Equifax breach.",
        "eligibility": "Receipts required",
        "proof_status": "required",
        "estimated_payout_cents": 12500,  # $125 if approved
        "claim_deadline": (today + timedelta(days=60)).isoformat(),
    }
    unknown_proof = {
        "name": "Mystery TCPA settlement",
        "source_url": "https://example.com/mystery-tcpa",
        "description": "Scraper landed this one but couldn't tell.",
        "proof_status": "unknown",
        "estimated_payout_cents": 4000,  # $40 if approved
        "claim_deadline": (today + timedelta(days=45)).isoformat(),
        "source": "scraper:topclassactions",
    }

    r1 = client.post("/api/legal-claims", json=no_proof)
    _assert(r1.status_code == 201, f"create no-proof failed: {r1.status_code} {r1.text}")
    no_proof_id = r1.json()["id"]
    _assert(r1.json()["proof_status"] == "not_required", "not_required round-trip wrong")
    print(f"    not_required claim id={no_proof_id} status={r1.json()['status']}")

    r2 = client.post("/api/legal-claims", json=with_proof)
    _assert(r2.status_code == 201, f"create with-proof failed: {r2.status_code} {r2.text}")
    with_proof_id = r2.json()["id"]
    _assert(r2.json()["proof_status"] == "required", "required round-trip wrong")
    print(f"    required claim id={with_proof_id} status={r2.json()['status']}")

    r_unk = client.post("/api/legal-claims", json=unknown_proof)
    _assert(r_unk.status_code == 201, f"create unknown failed: {r_unk.status_code} {r_unk.text}")
    unknown_id = r_unk.json()["id"]
    _assert(r_unk.json()["proof_status"] == "unknown", "unknown round-trip wrong")
    print(f"    unknown claim id={unknown_id} status={r_unk.json()['status']}")

    # ------------------------------------------------------------------
    # [2] Duplicate source_url -> 409
    # ------------------------------------------------------------------
    print("\n[2/6] POST same source_url twice (expect 409) ...")
    dup = client.post("/api/legal-claims", json=no_proof)
    _assert(dup.status_code == 409, f"expected 409 dup, got {dup.status_code}")
    print(f"    ✓ duplicate guard fired: {dup.status_code}")

    # ------------------------------------------------------------------
    # [3] List + filter
    # ------------------------------------------------------------------
    print("\n[3/6] GET /api/legal-claims (filters) ...")
    all_rows = client.get("/api/legal-claims").json()
    _assert(len(all_rows) == 3, f"expected 3 rows, got {len(all_rows)}")

    quick = client.get("/api/legal-claims?proof_status=not_required").json()
    _assert(
        len(quick) == 1 and quick[0]["id"] == no_proof_id,
        f"not_required filter wrong: {[r['id'] for r in quick]}",
    )

    needs = client.get("/api/legal-claims?proof_status=required").json()
    _assert(
        len(needs) == 1 and needs[0]["id"] == with_proof_id,
        f"required filter wrong: {[r['id'] for r in needs]}",
    )

    unk = client.get("/api/legal-claims?proof_status=unknown").json()
    _assert(
        len(unk) == 1 and unk[0]["id"] == unknown_id,
        f"unknown filter wrong: {[r['id'] for r in unk]}",
    )

    # is_expired must be False for all — deadlines are in the future.
    _assert(all(not r["is_expired"] for r in all_rows), "no row should be expired yet")
    # days_until_deadline should be positive for all
    _assert(all((r["days_until_deadline"] or 0) > 0 for r in all_rows),
            "days_until_deadline should be positive")
    print(f"    ✓ list + 3-way proof_status filters + derived fields OK")

    # ------------------------------------------------------------------
    # [4] Insert an expired claim, verify include_expired toggle
    # ------------------------------------------------------------------
    print("\n[4/6] Expired-claim handling ...")
    expired_payload = {
        "name": "Expired test settlement",
        "source_url": "https://example.com/expired-test",
        "proof_status": "not_required",
        "estimated_payout_cents": 5000,
        "claim_deadline": (today - timedelta(days=5)).isoformat(),
    }
    r3 = client.post("/api/legal-claims", json=expired_payload)
    _assert(r3.status_code == 201, f"expired create failed: {r3.text}")
    expired_id = r3.json()["id"]

    full = client.get("/api/legal-claims").json()
    expired_row = next(x for x in full if x["id"] == expired_id)
    _assert(expired_row["is_expired"] is True, "expired row missing is_expired=True")
    _assert(expired_row["days_until_deadline"] == -5, "days_until_deadline should be -5")

    not_expired = client.get("/api/legal-claims?include_expired=false").json()
    _assert(all(x["id"] != expired_id for x in not_expired), "include_expired=false leaked")
    print(f"    ✓ expired flagged, include_expired=false hides it")

    # ------------------------------------------------------------------
    # [5] PATCH status transitions: available -> claimed -> paid
    # ------------------------------------------------------------------
    print("\n[5/6] PATCH status transitions ...")
    r = client.patch(
        f"/api/legal-claims/{no_proof_id}",
        json={"status": "claimed"},
    )
    _assert(r.status_code == 200, f"patch claimed: {r.text}")
    body = r.json()
    _assert(body["status"] == "claimed", "status didn't flip")
    _assert(body["claimed_at"] is not None, "claimed_at not stamped")
    _assert(body["paid_at"] is None, "paid_at stamped prematurely")
    print(f"    available → claimed: claimed_at={body['claimed_at']}")

    # Re-PATCHing the same status should be a no-op for the timestamp.
    r_again = client.patch(
        f"/api/legal-claims/{no_proof_id}",
        json={"status": "claimed", "notes": "filed via web form"},
    )
    _assert(r_again.json()["claimed_at"] == body["claimed_at"], "claimed_at clobbered on no-op transition")
    _assert(r_again.json()["notes"] == "filed via web form", "notes patch lost")

    r2 = client.patch(
        f"/api/legal-claims/{no_proof_id}",
        json={"status": "paid", "actual_payout_cents": 2300},
    )
    _assert(r2.status_code == 200, f"patch paid: {r2.text}")
    paid_body = r2.json()
    _assert(paid_body["status"] == "paid", "status didn't flip to paid")
    _assert(paid_body["paid_at"] is not None, "paid_at not stamped")
    _assert(paid_body["actual_payout_cents"] == 2300, "actual payout not saved")
    print(f"    claimed → paid: actual=$23.00, paid_at={paid_body['paid_at']}")

    # PATCH proof_status itself — user manually triages an "unknown" row.
    r_triage = client.patch(
        f"/api/legal-claims/{unknown_id}",
        json={"proof_status": "not_required"},
    )
    _assert(r_triage.status_code == 200, f"patch proof_status: {r_triage.text}")
    _assert(r_triage.json()["proof_status"] == "not_required", "proof_status patch didn't persist")
    print(f"    triage: unknown → not_required on id={unknown_id}")

    # ------------------------------------------------------------------
    # [6] Stats
    # ------------------------------------------------------------------
    print("\n[6/6] GET /api/legal-claims/stats ...")
    stats = client.get("/api/legal-claims/stats").json()
    print(f"    {stats}")
    # State at this point:
    #   - no_proof_id: paid, $23 collected
    #   - with_proof_id: available, required, $125 estimated, live
    #   - unknown_id: available, just-triaged to not_required, $40 estimated, live
    #   - expired_id: available, not_required, expired (excluded from pending)
    _assert(stats["total_count"] == 4, f"total_count wrong: {stats['total_count']}")
    _assert(stats["paid_count"] == 1, "paid_count wrong")
    _assert(stats["available_count"] == 3, "available_count wrong (counts expired)")
    _assert(stats["expired_count"] == 1, "expired_count wrong")
    _assert(stats["collected_cents"] == 2300, "collected sum wrong")
    # Pending = with-proof live ($125) + triaged unknown→not_required live ($40)
    _assert(
        stats["pending_potential_cents"] == 12500 + 4000,
        f"pending_potential wrong: {stats['pending_potential_cents']}",
    )
    # 3-way live counts:
    #   quick: just the triaged unknown (now not_required), the expired row is excluded
    #   with_proof: 1 (with_proof_id)
    #   unknown: 0 (we just triaged it)
    _assert(
        stats["available_quick_count"] == 1,
        f"available_quick_count wrong: {stats['available_quick_count']}",
    )
    _assert(
        stats["available_with_proof_count"] == 1,
        f"available_with_proof_count wrong: {stats['available_with_proof_count']}",
    )
    _assert(
        stats["available_unknown_count"] == 0,
        f"available_unknown_count wrong: {stats['available_unknown_count']}",
    )
    print(f"    ✓ stats reconcile (potential=$165, collected=$23, 3-way split)")

    # Clean up: DELETE the expired row, confirm 204
    d = client.delete(f"/api/legal-claims/{expired_id}")
    _assert(d.status_code == 204, f"delete expected 204, got {d.status_code}")
    after = client.get("/api/legal-claims").json()
    _assert(all(x["id"] != expired_id for x in after), "delete didn't remove row")
    print("    ✓ delete removes the row")

    print("\n" + "=" * 60)
    print("LEGAL CLAIMS SMOKE TEST PASSED ✓")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
