"""Audit 2026-05-22 #2 follow-up: scrub historical credit-bureau bodies.

The Gmail connector now strips ``body_plain`` and ``snippet`` from
newly-parsed credit-bureau emails (see `gmail/connector.py` and the
`_CREDIT_BUREAU_PARSERS` set). This one-shot script does the same to
rows that were PARSED BEFORE the fix landed, so the historical PII in
``finance.db`` gets the same treatment as new emails.

Run once::

    python backend/scripts/strip_historical_bureau_bodies.py
    # or, from anywhere:
    python -m finance_app  # NOT this; we don't expose it as a module entrypoint

Idempotent: re-runnable; it skips rows already stripped (i.e. body_plain
and snippet both NULL and ``extra.body_stripped_for_privacy is True``).
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make ``finance_app`` importable when this file is run directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import EmailMessage, ParserOutcome
from finance_app.db.session import SessionLocal
from finance_app.gmail.connector import _CREDIT_BUREAU_PARSERS


def scrub(db: Session) -> tuple[int, int]:
    """Strip body_plain + snippet from already-parsed credit-bureau rows.

    Returns ``(stripped_now, already_clean)``. Idempotent — running twice
    yields ``(0, total)``. Caller is responsible for committing.
    """
    rows = db.execute(
        select(EmailMessage).where(
            EmailMessage.parser_name.in_(_CREDIT_BUREAU_PARSERS),
            EmailMessage.parser_outcome == ParserOutcome.parsed,
        )
    ).scalars().all()
    stripped_now = 0
    already_clean = 0
    for em in rows:
        flag = (em.extra or {}).get("body_stripped_for_privacy") is True
        if em.body_plain is None and em.snippet is None and flag:
            already_clean += 1
            continue
        em.body_plain = None
        em.snippet = None
        # Reassign a fresh dict so SQLAlchemy's JSON-mutation tracking
        # picks the change up (in-place mutation of em.extra won't).
        extra = dict(em.extra or {})
        extra["body_stripped_for_privacy"] = True
        em.extra = extra
        stripped_now += 1
    # Flush so the caller (or db.refresh in tests) sees the changes
    # in the DB even before commit. main() still commits below.
    db.flush()
    return stripped_now, already_clean


def main() -> int:
    with SessionLocal() as db:
        stripped, clean = scrub(db)
        db.commit()
        total = stripped + clean
        if total == 0:
            print("No parsed credit-bureau emails found — nothing to strip.")
        else:
            print(
                f"Parsed credit-bureau emails: {total} total — "
                f"stripped {stripped}, already clean {clean}."
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
