"""Smoke test for the Phase 4.3 credit-score scrapers.

No real network or Playwright — we exercise:

1. Each scraper's pure ``parse()`` against inline HTML fixtures
   (primary class-keyed path + loose fallback).
2. The coordinator end-to-end against a throwaway SQLite DB:
   - Persist new scores with ``source = scraped``.
   - Same-day re-run is a no-op (natural-key dedupe).
   - A scraper that raises is isolated from the rest.
   - ``AuthStateMissing`` shows up as ``auth_missing=True`` in the
     summary, not a 500.

Run::

    cd backend
    python scripts/smoke_credit_score_scrapers.py
"""
from __future__ import annotations

import os
import sys
from datetime import date
from pathlib import Path
from unittest.mock import patch

# Default to /tmp because some host filesystems (e.g. workspace-mounted
# folders on Cowork sandboxes, or network shares) don't expose the
# fcntl-locking semantics SQLite needs in WAL mode. /tmp is local tmpfs
# on every supported dev machine. Override via SMOKE_DB_PATH if needed.
THROWAWAY_DB = Path(
    os.environ.get("SMOKE_DB_PATH")
    or "/tmp/smoke_credit_score_scrapers.db"
)
os.environ["DATABASE_URL"] = f"sqlite:///{THROWAWAY_DB}"

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from finance_app.db.models import (  # noqa: E402
    Base,
    CreditBureau,
    CreditScoreSnapshot,
    CreditScoringModel,
    ScoreSource,
)
from finance_app.db.session import SessionLocal, engine  # noqa: E402
from finance_app.scrapers.credit_scores import coordinator  # noqa: E402
from finance_app.scrapers.credit_scores.base import (  # noqa: E402
    AuthStateMissing,
    ScrapedScore,
)
from finance_app.scrapers.credit_scores.credit_journey import (  # noqa: E402
    CreditJourneyScraper,
)
from finance_app.scrapers.credit_scores.credit_karma import (  # noqa: E402
    CreditKarmaScraper,
)
from finance_app.scrapers.credit_scores.creditwise import (  # noqa: E402
    CreditWiseScraper,
)


# --------------------------------------------------------------------- #
#  Tiny inline fixtures — keep them small + close to what the live HTML
#  actually looks like for each portal.
# --------------------------------------------------------------------- #

CK_FIXTURE_PRIMARY = """
<html><body>
<div class="dashboard">
  <div class="score-card">
    <span class="bureau">TransUnion</span>
    <span class="score">742</span>
    <span class="model">VantageScore 3.0</span>
  </div>
  <div class="score-card">
    <span class="bureau">Equifax</span>
    <span class="score">738</span>
    <span class="model">VantageScore 3.0</span>
  </div>
</div>
</body></html>
"""

CK_FIXTURE_LOOSE = """
<html><body>
<header>Welcome back, Chris</header>
<main>Your TransUnion score is 742 (VantageScore 3.0).
And your Equifax score is 738 as of today.</main>
</body></html>
"""

CW_FIXTURE_PRIMARY = """
<html><body>
<div class="creditwise-score-display">
  <span class="value">748</span>
  <span class="label">VantageScore 3.0 from TransUnion</span>
</div>
</body></html>
"""

CW_FIXTURE_LOOSE = """
<html><body>
<h1>CreditWise dashboard</h1>
<p>Your VantageScore is 748 from TransUnion. Updated weekly.</p>
</body></html>
"""

CJ_FIXTURE_PRIMARY = """
<html><body>
<div class="credit-journey-score">
  <span class="value">763</span>
  <span class="label">VantageScore 3.0 from Experian</span>
</div>
</body></html>
"""

CJ_FIXTURE_LOOSE = """
<html><body>
<h2>Credit Journey</h2>
<p>Your latest Experian VantageScore is 763. Refreshed weekly.</p>
</body></html>
"""


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        print(f"  ✗ {msg}")
        raise SystemExit(1)


def setup_db() -> None:
    # Unlink first inside setup so any leftover -wal/-shm/-journal sidecar
    # files don't trip SQLite open. (They're created during test runs and
    # SQLite can choke on stale WALs from a crashed prior run.)
    for path in [THROWAWAY_DB] + [
        THROWAWAY_DB.with_name(THROWAWAY_DB.name + ext)
        for ext in ("-shm", "-wal", "-journal")
    ]:
        try:
            if path.exists():
                path.unlink()
        except OSError:
            pass
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


# --------------------------------------------------------------------- #
#  1. Per-scraper parsers — primary path + loose fallback
# --------------------------------------------------------------------- #


def test_credit_karma_parser() -> None:
    print("\n[1/5] Credit Karma parser (primary + loose) ...")
    s = CreditKarmaScraper()

    # Primary path — yields TU + EF, both VS3.
    out = s.parse(CK_FIXTURE_PRIMARY)
    _assert(len(out) == 2, f"expected 2 scores from primary, got {len(out)}")
    by_bureau = {x.bureau: x for x in out}
    _assert("transunion" in by_bureau, "TU score missing")
    _assert("equifax" in by_bureau, "EF score missing")
    _assert(by_bureau["transunion"].score == 742, "TU score wrong")
    _assert(by_bureau["equifax"].score == 738, "EF score wrong")
    _assert(
        all(x.scoring_model == "vantagescore3" for x in out),
        "scoring_model should be vantagescore3 for CK",
    )
    _assert(by_bureau["transunion"].as_of == date.today(), "as_of should default to today")
    print("  ✓ primary path yields TU=742 + EF=738 / vantagescore3")

    # Loose fallback — used when CK ships an A/B layout we don't recognize.
    out2 = s.parse(CK_FIXTURE_LOOSE)
    _assert(len(out2) >= 1, "loose fallback found nothing")
    bureaus = {x.bureau for x in out2}
    _assert(
        "transunion" in bureaus or "equifax" in bureaus,
        "loose fallback didn't attribute to any bureau",
    )
    print(f"  ✓ loose fallback found {len(out2)} score(s)")

    # Sanity: empty input yields no scores, no crash.
    _assert(s.parse("") == [], "empty input should yield no scores")
    _assert(s.parse("<html></html>") == [], "empty page should yield no scores")
    print("  ✓ empty inputs handled gracefully")


def test_creditwise_parser() -> None:
    print("\n[2/5] CreditWise parser (primary + loose) ...")
    s = CreditWiseScraper()

    out = s.parse(CW_FIXTURE_PRIMARY)
    _assert(len(out) == 1, f"expected 1 score from primary, got {len(out)}")
    _assert(out[0].score == 748, "score should be 748")
    _assert(out[0].bureau == "transunion", "CreditWise = TransUnion only")
    _assert(out[0].scoring_model == "vantagescore3", "should be VS3")
    print("  ✓ primary path: 748 / TU / VS3")

    out2 = s.parse(CW_FIXTURE_LOOSE)
    _assert(len(out2) == 1, f"expected 1 score from loose, got {len(out2)}")
    _assert(out2[0].score == 748, "loose-match score wrong")
    print("  ✓ loose fallback: 748 / TU / VS3")

    _assert(s.parse("") == [], "empty input handled")
    print("  ✓ empty inputs handled gracefully")


def test_credit_journey_parser() -> None:
    print("\n[3/5] Credit Journey parser (primary + loose) ...")
    s = CreditJourneyScraper()

    out = s.parse(CJ_FIXTURE_PRIMARY)
    _assert(len(out) == 1, f"expected 1 score, got {len(out)}")
    _assert(out[0].score == 763, "score should be 763")
    _assert(out[0].bureau == "experian", "Credit Journey = Experian")
    _assert(out[0].scoring_model == "vantagescore3", "should be VS3")
    print("  ✓ primary path: 763 / Experian / VS3")

    out2 = s.parse(CJ_FIXTURE_LOOSE)
    _assert(len(out2) == 1, f"expected 1 from loose, got {len(out2)}")
    _assert(out2[0].score == 763, "loose-match score wrong")
    print("  ✓ loose fallback: 763 / Experian / VS3")

    _assert(s.parse("") == [], "empty input handled")
    print("  ✓ empty inputs handled gracefully")


# --------------------------------------------------------------------- #
#  4. Coordinator — persist, dedupe, isolate failures, surface auth-missing
# --------------------------------------------------------------------- #


class _StubScraper:
    """Minimal in-memory scraper that returns a fixed list, no Playwright."""

    site_key = "stub"
    name = "Stub"

    def __init__(self, scores: list[ScrapedScore], raise_with: Exception | None = None) -> None:
        self._scores = scores
        self._raise_with = raise_with

    def run(self) -> list[ScrapedScore]:
        if self._raise_with is not None:
            raise self._raise_with
        return list(self._scores)


def test_coordinator_persistence_and_dedupe() -> None:
    print("\n[4/5] Coordinator: persistence + dedupe + crash isolation ...")
    today = date.today()
    ck_scores = [
        ScrapedScore(
            site_key="credit_karma",
            score=742,
            bureau="transunion",
            scoring_model="vantagescore3",
            as_of=today,
            source_detail="Credit Karma · TransUnion",
        ),
        ScrapedScore(
            site_key="credit_karma",
            score=738,
            bureau="equifax",
            scoring_model="vantagescore3",
            as_of=today,
            source_detail="Credit Karma · Equifax",
        ),
    ]
    cw_scores = [
        ScrapedScore(
            site_key="creditwise",
            score=748,
            bureau="transunion",
            scoring_model="vantagescore3",
            as_of=today,
            source_detail="Capital One CreditWise · TransUnion",
        ),
    ]

    healthy_ck = _StubScraper(ck_scores)
    healthy_cw = _StubScraper(cw_scores)
    crashing = _StubScraper([], raise_with=RuntimeError("cookie expired"))
    crashing.site_key = "credit_journey"
    crashing.name = "Chase Credit Journey"
    healthy_ck.site_key = "credit_karma"
    healthy_ck.name = "Credit Karma"
    healthy_cw.site_key = "creditwise"
    healthy_cw.name = "Capital One CreditWise"

    # ---- First run: 3 scores expected, but Journey crashes mid-run.
    with patch.object(coordinator, "_SCRAPERS", [healthy_ck, healthy_cw, crashing]):
        db = SessionLocal()
        try:
            r = coordinator.scrape_and_persist(db)
        finally:
            db.close()
    _assert(len(r.summaries) == 3, "should have 3 per-portal summaries")
    by_key = {s.site_key: s for s in r.summaries}
    _assert(by_key["credit_karma"].rows_created == 2, "CK should have created 2 rows")
    _assert(by_key["creditwise"].rows_created == 1, "CW should have created 1 row")
    _assert(by_key["credit_journey"].error is not None, "CJ should report its crash")
    _assert(by_key["credit_journey"].rows_created == 0, "CJ should have created 0 rows")
    _assert(len(r.new_scores) == 3, "new_scores should hold the 3 created")
    print("  ✓ first run: CK +2, CW +1, CJ crashed but isolated")

    # ---- DB sanity: 3 rows across the per-portal scraped sources.
    scraped_sources = {
        ScoreSource.scraped,
        ScoreSource.scraped_credit_karma,
        ScoreSource.scraped_creditwise,
        ScoreSource.scraped_credit_journey,
    }
    db = SessionLocal()
    try:
        rows = (
            db.query(CreditScoreSnapshot)
            .filter(CreditScoreSnapshot.source.in_(scraped_sources))
            .all()
        )
    finally:
        db.close()
    _assert(len(rows) == 3, f"expected 3 scraped rows in DB, got {len(rows)}")
    score_set = {(r.bureau.value, r.score, r.source.value) for r in rows}
    _assert(
        ("transunion", 742, "scraped_credit_karma") in score_set,
        "CK TU 742 not persisted under scraped_credit_karma",
    )
    _assert(
        ("equifax", 738, "scraped_credit_karma") in score_set,
        "CK EF 738 not persisted under scraped_credit_karma",
    )
    _assert(
        ("transunion", 748, "scraped_creditwise") in score_set,
        "CW TU 748 not persisted under scraped_creditwise (this is the bug "
        "the per-portal sources fix — CK + CW both pull TU/VS3 same day)",
    )
    print("  ✓ DB has 3 rows under correct per-portal source enum values")

    # ---- Second run with same scores: should be a no-op (natural-key dedupe).
    with patch.object(coordinator, "_SCRAPERS", [healthy_ck, healthy_cw]):
        db = SessionLocal()
        try:
            r2 = coordinator.scrape_and_persist(db)
        finally:
            db.close()
    by_key2 = {s.site_key: s for s in r2.summaries}
    _assert(by_key2["credit_karma"].rows_created == 0, "second-run CK should be no-op")
    _assert(by_key2["credit_karma"].rows_skipped_existing == 2, "CK should report 2 skipped")
    _assert(by_key2["creditwise"].rows_skipped_existing == 1, "CW should report 1 skipped")
    print("  ✓ same-day re-run is idempotent (0 created, all skipped)")


def test_coordinator_auth_missing() -> None:
    print("\n[5/5] Coordinator: auth-missing surfaces cleanly ...")
    needs_login = _StubScraper(
        [], raise_with=AuthStateMissing("login expired for stub")
    )
    needs_login.site_key = "credit_journey"
    needs_login.name = "Chase Credit Journey"

    with patch.object(coordinator, "_SCRAPERS", [needs_login]):
        db = SessionLocal()
        try:
            r = coordinator.scrape_and_persist(db)
        finally:
            db.close()
    _assert(len(r.summaries) == 1, "expected 1 summary")
    s = r.summaries[0]
    _assert(s.auth_missing is True, "should have auth_missing=True")
    _assert(s.rows_created == 0, "no rows created when auth missing")
    _assert(s.error is not None, "error message should explain auth")
    print(f"  ✓ auth_missing surfaces as a flag, error msg: {s.error[:60]}…")


def main() -> None:
    print("=== smoke_credit_score_scrapers (Phase 4.3) ===")
    setup_db()
    try:
        test_credit_karma_parser()
        test_creditwise_parser()
        test_credit_journey_parser()
        test_coordinator_persistence_and_dedupe()
        test_coordinator_auth_missing()
    finally:
        teardown_db()
    print("\n✅ All Phase 4.3 credit-score scraper checks passed.")


if __name__ == "__main__":
    main()
