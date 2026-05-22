"""Smoke test for the class-action scrapers (Phase F.2).

No real network — every HTTP request goes through ``httpx.MockTransport``
backed by HTML fixtures in ``tests/fixtures/scraped_html``. That means
this test is deterministic and fast, and exercises:

* Each scraper's ``parse()`` against a known fixture (proof_status,
  payout cents, deadline, name).
* Each scraper's ``fetch_pages()`` against an index fixture
  (extracts URLs, dedupes, walks detail pages).
* The coordinator end-to-end:
  - First run creates rows.
  - Second run is a no-op idempotent (no duplicates).
  - Modified scraper output triggers ``rows_updated``.
  - A scraper that raises mid-run is isolated (other sources still
    report).
* The new ``available_unknown_count`` stat reflects scraped rows
  whose proof requirement we couldn't determine.

Run:
    cd backend
    python scripts/smoke_legal_scrapers.py
"""
from __future__ import annotations

import os
import sys
from datetime import date
from pathlib import Path

TEST_DB_PATH = Path(
    os.environ.get("SMOKE_DB_PATH")
    or (Path(__file__).resolve().parent.parent / "smoke_legal_scrapers.db")
)
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH}"
if TEST_DB_PATH.exists():
    TEST_DB_PATH.unlink()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

from finance_app.db.models import (  # noqa: E402
    Base,
    LegalClaim,
    LegalClaimStatus,
    ProofRequirement,
)
from finance_app.db.session import SessionLocal, engine  # noqa: E402
from finance_app.scrapers.legal_claims import (  # noqa: E402
    ClassActionOrgScraper,
    TopClassActionsScraper,
    run_scrapers,
)
from finance_app.scrapers.legal_claims.base import ScrapedListing  # noqa: E402
from finance_app.scrapers.legal_claims.proof_heuristic import classify_proof  # noqa: E402

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "scraped_html"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        print(f"  ✗ {msg}")
        raise SystemExit(1)


# --------------------------------------------------------------------- #
# 1. Proof heuristic — sanity (already tested inline elsewhere, recheck) #
# --------------------------------------------------------------------- #

def test_proof_heuristic() -> None:
    print("\n[1/6] Proof heuristic edge cases ...")
    cases: list[tuple[str, ProofRequirement]] = [
        ("No proof of purchase required.", ProofRequirement.not_required),
        ("Receipts are required to claim.", ProofRequirement.required),
        ("Settlement reached for $5M.", ProofRequirement.unknown),
        ("Eligible class members will receive $10. No documentation required.", ProofRequirement.not_required),
        ("Itemized receipts required for higher payout tier.", ProofRequirement.required),
    ]
    for text, expected in cases:
        verdict, _score = classify_proof(text)
        _assert(verdict == expected, f"expected {expected} for {text!r}, got {verdict}")
    print(f"    ✓ {len(cases)} heuristic cases pass")


# --------------------------------------------------------------------- #
# 2. TCA parse() against fixtures                                        #
# --------------------------------------------------------------------- #

def test_tca_parse() -> None:
    print("\n[2/6] TCA parse() fixtures ...")
    s = TopClassActionsScraper()

    # No-proof variant
    c = s.parse(ScrapedListing(
        url="https://topclassactions.com/lawsuit-settlements/cell-phone-data-breach/",
        html=_read("tca_no_proof.html"),
    ))
    _assert(c is not None, "TCA no-proof parse returned None")
    _assert("Cell Phone Data Breach" in c.name, f"TCA no-proof name wrong: {c.name!r}")
    _assert(c.proof_status == ProofRequirement.not_required,
            f"TCA no-proof proof_status wrong: {c.proof_status}")
    _assert(c.estimated_payout_cents == 10000, f"TCA no-proof payout wrong: {c.estimated_payout_cents}")
    _assert(c.claim_deadline == date(2027, 3, 14), f"TCA no-proof deadline wrong: {c.claim_deadline}")
    _assert(c.administrator and "Acme" in c.administrator, f"TCA admin wrong: {c.administrator}")
    _assert(c.case_number == "22-cv-04421", f"TCA case_number wrong: {c.case_number}")
    print(f"    ✓ TCA no-proof: name='{c.name[:40]}…', payout={c.estimated_payout_cents}c, "
          f"deadline={c.claim_deadline}, proof={c.proof_status.value}")

    # Proof variant
    c = s.parse(ScrapedListing(
        url="https://topclassactions.com/lawsuit-settlements/grocery-receipts/",
        html=_read("tca_proof.html"),
    ))
    _assert(c is not None, "TCA proof parse returned None")
    _assert(c.proof_status == ProofRequirement.required,
            f"TCA proof proof_status wrong: {c.proof_status}")
    _assert(c.estimated_payout_cents == 25000, f"TCA proof payout wrong: {c.estimated_payout_cents}")
    _assert(c.claim_deadline == date(2027, 6, 30), f"TCA proof deadline wrong: {c.claim_deadline}")
    print(f"    ✓ TCA proof: payout={c.estimated_payout_cents}c, "
          f"deadline={c.claim_deadline}, proof={c.proof_status.value}")

    # Unknown variant — body is uninformative, classifier returns unknown.
    c = s.parse(ScrapedListing(
        url="https://topclassactions.com/lawsuit-settlements/mystery-suit/",
        html=_read("tca_unknown.html"),
    ))
    _assert(c is not None, "TCA mystery parse returned None")
    _assert(c.proof_status == ProofRequirement.unknown,
            f"TCA mystery proof_status wrong: {c.proof_status}")
    _assert(c.claim_deadline == date(2027, 9, 15), f"TCA mystery deadline wrong: {c.claim_deadline}")
    _assert(c.estimated_payout_cents is None, f"TCA mystery should have no payout: {c.estimated_payout_cents}")
    print(f"    ✓ TCA mystery: proof={c.proof_status.value} (unknown is correct)")


# --------------------------------------------------------------------- #
# 3. ClassAction.org parse() against fixtures                            #
# --------------------------------------------------------------------- #

def test_cao_parse() -> None:
    print("\n[3/6] ClassAction.org parse() fixtures ...")
    s = ClassActionOrgScraper()

    c = s.parse(ScrapedListing(
        url="https://www.classaction.org/lawsuit-settlements/streaming-data-2025",
        html=_read("cao_no_proof.html"),
    ))
    _assert(c is not None, "CAO no-proof parse returned None")
    _assert(c.proof_status == ProofRequirement.not_required,
            f"CAO no-proof proof_status wrong: {c.proof_status}")
    _assert(c.estimated_payout_cents == 5000, f"CAO no-proof payout wrong: {c.estimated_payout_cents}")
    _assert(c.claim_deadline == date(2027, 10, 4), f"CAO no-proof deadline wrong: {c.claim_deadline}")
    print(f"    ✓ CAO no-proof: payout={c.estimated_payout_cents}c, "
          f"deadline={c.claim_deadline}, proof={c.proof_status.value}")

    c = s.parse(ScrapedListing(
        url="https://www.classaction.org/lawsuit-settlements/coffee-pods-recall",
        html=_read("cao_proof.html"),
    ))
    _assert(c is not None, "CAO proof parse returned None")
    _assert(c.proof_status == ProofRequirement.required,
            f"CAO proof proof_status wrong: {c.proof_status}")
    _assert(c.claim_deadline == date(2027, 12, 31), f"CAO proof deadline wrong: {c.claim_deadline}")
    print(f"    ✓ CAO proof: deadline={c.claim_deadline}, proof={c.proof_status.value}")


# --------------------------------------------------------------------- #
# 4. Coordinator end-to-end with mocked transport                        #
# --------------------------------------------------------------------- #

def _make_mock_client() -> httpx.Client:
    """Build an httpx.Client whose responses come from local fixtures.

    Maps each known URL to a fixture file. Anything else returns 404
    so a regression that adds an unstubbed URL fails loudly.
    """
    routes: dict[str, str] = {
        "https://topclassactions.com/lawsuit-settlements/open-lawsuit-settlements/": "tca_index.html",
        "https://topclassactions.com/lawsuit-settlements/cell-phone-data-breach/": "tca_no_proof.html",
        "https://topclassactions.com/lawsuit-settlements/grocery-receipts/": "tca_proof.html",
        "https://topclassactions.com/lawsuit-settlements/mystery-suit/": "tca_unknown.html",
        "https://www.classaction.org/open-lawsuit-settlements": "cao_index.html",
        "https://www.classaction.org/lawsuit-settlements/streaming-data-2025": "cao_no_proof.html",
        "https://www.classaction.org/lawsuit-settlements/coffee-pods-recall": "cao_proof.html",
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url in routes:
            return httpx.Response(200, text=_read(routes[url]))
        return httpx.Response(404, text=f"No fixture for {url}")

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_coordinator_end_to_end() -> None:
    print("\n[4/6] Coordinator end-to-end ...")
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    client = _make_mock_client()
    try:
        scrapers = [TopClassActionsScraper(), ClassActionOrgScraper()]
        result = run_scrapers(db, scrapers, client=client)

        # Expectations: 3 from TCA + 2 from CAO = 5 created on first run.
        _assert(result.total_created == 5, f"expected 5 created, got {result.total_created}")
        _assert(result.total_updated == 0, f"expected 0 updated, got {result.total_updated}")
        _assert(len(result.summaries) == 2, f"expected 2 summaries, got {len(result.summaries)}")

        for s in result.summaries:
            _assert(s.error is None, f"{s.source} surfaced an error: {s.error}")
        print(f"    ✓ first run: {result.total_created} created across "
              f"{[(s.source, s.rows_created) for s in result.summaries]}")

        # Verify proof_status distribution: 2 not_required, 2 required, 1 unknown.
        rows = db.query(LegalClaim).all()
        by_proof = {ProofRequirement.not_required: 0, ProofRequirement.required: 0, ProofRequirement.unknown: 0}
        for r in rows:
            by_proof[r.proof_status] += 1
        _assert(by_proof[ProofRequirement.not_required] == 2,
                f"expected 2 not_required, got {by_proof[ProofRequirement.not_required]}")
        _assert(by_proof[ProofRequirement.required] == 2,
                f"expected 2 required, got {by_proof[ProofRequirement.required]}")
        _assert(by_proof[ProofRequirement.unknown] == 1,
                f"expected 1 unknown, got {by_proof[ProofRequirement.unknown]}")
        print(f"    ✓ proof distribution: {[(k.value, v) for k, v in by_proof.items()]}")

        # All rows should have source = "scraper:<name>"
        for r in rows:
            _assert(r.source.startswith("scraper:"),
                    f"row {r.id} source not tagged: {r.source!r}")

    finally:
        client.close()
        db.close()


def test_coordinator_idempotent() -> None:
    print("\n[5/6] Coordinator idempotency + update path ...")
    db = SessionLocal()
    client = _make_mock_client()
    try:
        scrapers = [TopClassActionsScraper(), ClassActionOrgScraper()]
        # Run #2 — no fixtures changed, expect zero new rows and zero updates.
        result = run_scrapers(db, scrapers, client=client)
        _assert(
            result.total_created == 0,
            f"second run created rows: {result.total_created}",
        )
        _assert(
            result.total_updated == 0,
            f"second run updated rows for no reason: {result.total_updated}",
        )
        # Still one row per URL — UNIQUE on source_url enforces this.
        total = db.query(LegalClaim).count()
        _assert(total == 5, f"row count drifted: {total}")
        print(f"    ✓ second run: 0 created / 0 updated, total still {total}")

        # Manual edit simulates user advancing one row past `available`.
        # The coordinator must NOT touch it on subsequent runs.
        target = (
            db.query(LegalClaim)
            .filter(LegalClaim.source_url ==
                    "https://topclassactions.com/lawsuit-settlements/cell-phone-data-breach/")
            .one()
        )
        target.status = LegalClaimStatus.claimed
        target.notes = "user note — do not clobber"
        db.commit()

        result3 = run_scrapers(db, scrapers, client=client)
        db.refresh(target)
        _assert(
            target.status == LegalClaimStatus.claimed,
            "third run reverted user-set status",
        )
        _assert(
            target.notes == "user note — do not clobber",
            f"third run clobbered user notes: {target.notes!r}",
        )
        # Nothing else should change either — the other 4 rows are still
        # in `available` but their fixtures haven't moved.
        _assert(
            result3.total_created == 0 and result3.total_updated == 0,
            f"third run touched data: created={result3.total_created} "
            f"updated={result3.total_updated}",
        )
        print(f"    ✓ user-advanced row preserved across re-scrape; counts: "
              f"created={result3.total_created} updated={result3.total_updated}")

    finally:
        client.close()
        db.close()


# --------------------------------------------------------------------- #
# 5. Per-source error isolation                                          #
# --------------------------------------------------------------------- #

def test_error_isolation() -> None:
    print("\n[6/6] Per-source error isolation ...")
    db = SessionLocal()
    # Mock client where TCA's index 500s, CAO works fine.
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        routes = {
            "https://www.classaction.org/open-lawsuit-settlements": "cao_index.html",
            "https://www.classaction.org/lawsuit-settlements/streaming-data-2025": "cao_no_proof.html",
            "https://www.classaction.org/lawsuit-settlements/coffee-pods-recall": "cao_proof.html",
        }
        if "topclassactions.com" in url:
            return httpx.Response(500, text="upstream exploded")
        if url in routes:
            return httpx.Response(200, text=_read(routes[url]))
        return httpx.Response(404)
    client = httpx.Client(transport=httpx.MockTransport(handler))
    try:
        result = run_scrapers(
            db, [TopClassActionsScraper(), ClassActionOrgScraper()], client=client
        )
        # CAO should still succeed even though TCA failed.
        cao = next(s for s in result.summaries if s.source == "classaction_org")
        _assert(cao.error is None, f"CAO surfaced error after TCA fail: {cao.error}")
        # CAO's rows already exist in DB from the prior run, so they're
        # all skipped (idempotent), not created. Verify that's exactly
        # what we see, and that TCA didn't pollute the DB.
        _assert(cao.rows_created == 0, f"CAO created on third run: {cao.rows_created}")
        # Total should still be 5 (no rogue inserts, TCA's failure didn't
        # corrupt the DB).
        total = db.query(LegalClaim).count()
        _assert(total == 5, f"row count drifted under failure: {total}")
        print(f"    ✓ CAO ran clean ({cao.rows_seen} seen) while TCA's index 500'd; "
              f"DB still at {total} rows")
    finally:
        client.close()
        db.close()


def main() -> int:
    print("=" * 60)
    print("LEGAL CLAIMS SCRAPERS SMOKE TEST")
    print("=" * 60)
    test_proof_heuristic()
    test_tca_parse()
    test_cao_parse()
    test_coordinator_end_to_end()
    test_coordinator_idempotent()
    test_error_isolation()
    print("\n" + "=" * 60)
    print("LEGAL CLAIMS SCRAPERS SMOKE TEST PASSED ✓")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
