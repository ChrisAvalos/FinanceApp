"""Smoke test for Sprint 52 — auth-state expiry notifier.

Exercises ``finance_app.scrapers.balances.notify.emit_auth_missing_notifications``
against an in-memory SQLite DB (NOT the user's real one — this is
self-contained so it can run via ``py scripts/smoke_balance_auth_notify.py``
without activating the .venv or touching live data).

Test cases:
  [1] Empty input → 0 emitted, no DB writes.
  [2] One new site → 1 notification with the right kind, title shape,
      body containing the bootstrap command, payload['key'] formatted
      "<site>:<YYYY>-W<NN>".
  [3] Same site twice in one run → 1 emitted (the second call sees the
      first row already in the DB).
  [4] Same site, second call in a DIFFERENT ISO week → 1 emitted (week
      rollover re-emits — exactly the dedup contract we want).
  [5] Unknown site_key uses the generic fallback hint with the site
      name substituted in.
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Stub-out the settings import path that some of the package's modules
# touch at import time. The notify module itself doesn't need config,
# but Base/models do via the session machinery, and we want to avoid
# requiring a real .env file just to run this test.
import os
os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")

from sqlalchemy import create_engine, select  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from finance_app.db.models import Base, Notification  # noqa: E402
from finance_app.scrapers.balances.notify import (  # noqa: E402
    emit_auth_missing_notifications,
)


def _fresh_db():
    """Build an in-memory SQLite session bound to the production Base.

    Using create_all() instead of alembic — smoke tests just need the
    schema to exist, not migration history.
    """
    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(eng)
    Session = sessionmaker(bind=eng)
    return Session()


def _all_notifications(db):
    return db.execute(select(Notification)).scalars().all()


def test_empty_input() -> None:
    db = _fresh_db()
    emitted = emit_auth_missing_notifications(db, [])
    assert emitted == 0, f"empty input should emit 0, got {emitted}"
    assert len(_all_notifications(db)) == 0
    print("[1] empty input → 0 emitted (PASS)")


def test_single_site_emits_correct_shape() -> None:
    db = _fresh_db()
    now = datetime(2026, 5, 13)  # known Wednesday → ISO week 20
    emitted = emit_auth_missing_notifications(db, ["albert"], now=now)
    assert emitted == 1, f"expected 1 emission, got {emitted}"
    notifs = _all_notifications(db)
    assert len(notifs) == 1
    n = notifs[0]
    assert n.kind == "scraper_auth_missing", f"unexpected kind: {n.kind}"
    assert "Albert" in n.title, f"title missing 'Albert': {n.title!r}"
    assert "re-auth" in n.title, f"title missing 're-auth': {n.title!r}"
    assert "bootstrap" in (n.body or "").lower(), f"body missing 'bootstrap': {n.body!r}"
    assert "py -m finance_app.scrapers.balances.bootstrap albert" in (n.body or ""), \
        f"body missing bootstrap command"
    payload = n.payload or {}
    assert payload.get("site_key") == "albert"
    assert payload.get("key") == "albert:2026-W20", f"unexpected key {payload.get('key')!r}"
    assert n.is_read is False
    print("[2] single site emits correct kind/title/body/payload (PASS)")


def test_same_week_dedup() -> None:
    db = _fresh_db()
    now = datetime(2026, 5, 13)
    e1 = emit_auth_missing_notifications(db, ["albert"], now=now)
    db.commit()
    # Second call same week — should dedupe.
    e2 = emit_auth_missing_notifications(db, ["albert"], now=now)
    db.commit()
    assert e1 == 1 and e2 == 0, f"first should emit 1, second 0; got {e1}/{e2}"
    assert len(_all_notifications(db)) == 1
    print("[3] same-week call dedupes (PASS)")


def test_different_week_re_emits() -> None:
    db = _fresh_db()
    e1 = emit_auth_missing_notifications(
        db, ["albert"], now=datetime(2026, 5, 13),  # week 20
    )
    db.commit()
    e2 = emit_auth_missing_notifications(
        db, ["albert"], now=datetime(2026, 5, 20),  # week 21
    )
    db.commit()
    assert e1 == 1 and e2 == 1, f"week rollover should re-emit; got {e1}/{e2}"
    assert len(_all_notifications(db)) == 2
    print("[4] different ISO week re-emits (PASS)")


def test_unknown_site_uses_generic_hint() -> None:
    db = _fresh_db()
    emitted = emit_auth_missing_notifications(db, ["wealthfront"])
    db.commit()
    assert emitted == 1
    n = _all_notifications(db)[0]
    assert "Wealthfront" in n.title, f"unknown site should title-case name; got {n.title!r}"
    assert (n.payload or {}).get("bootstrap_hint", "").endswith("wealthfront"), \
        f"bootstrap_hint should substitute site name; got {n.payload}"
    print("[5] unknown site uses generic hint with name substituted (PASS)")


def main() -> int:
    tests = [
        test_empty_input,
        test_single_site_emits_correct_shape,
        test_same_week_dedup,
        test_different_week_re_emits,
        test_unknown_site_uses_generic_hint,
    ]
    failures = 0
    for fn in tests:
        try:
            fn()
        except AssertionError as e:
            print(f"[FAIL] {fn.__name__}: {e}")
            failures += 1
    if failures:
        print(f"\n{failures}/{len(tests)} test(s) FAILED")
        return 1
    print(f"\nAll {len(tests)} tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
