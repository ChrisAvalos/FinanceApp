"""Tests for the one-shot historical bureau-body scrub.

Pin three behaviors:
1. Parsed credit-bureau rows get their body + snippet nulled and gain
   the body_stripped_for_privacy marker.
2. Non-bureau rows are untouched.
3. Re-running the scrub is a no-op (idempotent).
"""
from __future__ import annotations

from sqlalchemy import select

from finance_app.db.models import EmailMessage, ParserOutcome

# The script lives in backend/scripts/, which isn't on the test pythonpath.
# Add it explicitly so the import works regardless of where pytest runs from.
import os, sys
_BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_BACKEND, "scripts"))

from strip_historical_bureau_bodies import scrub

from factories import make_email_message


def test_scrub_nulls_bureau_bodies_and_adds_marker(db):
    em = make_email_message(
        db,
        parser_name="experian_report",
        parser_outcome=ParserOutcome.parsed,
        body_plain="FICO 752 — full report ...",
        snippet="score went up by 12",
        extra={"fico_score": 752},
    )
    stripped, clean = scrub(db)
    assert (stripped, clean) == (1, 0)

    db.refresh(em)
    assert em.body_plain is None
    assert em.snippet is None
    assert em.extra["body_stripped_for_privacy"] is True
    # Pre-existing payload (the structured score) is preserved.
    assert em.extra["fico_score"] == 752


def test_scrub_leaves_non_bureau_rows_alone(db):
    em = make_email_message(
        db,
        parser_name="chase_alerts",
        parser_outcome=ParserOutcome.parsed,
        body_plain="You spent $42 at Starbucks",
        snippet="charge alert",
    )
    stripped, clean = scrub(db)
    assert (stripped, clean) == (0, 0)

    db.refresh(em)
    assert em.body_plain == "You spent $42 at Starbucks"
    assert em.snippet == "charge alert"


def test_scrub_is_idempotent(db):
    make_email_message(
        db,
        parser_name="equifax_report",
        parser_outcome=ParserOutcome.parsed,
        body_plain="report body",
        snippet="snippet",
    )
    s1, c1 = scrub(db)
    assert (s1, c1) == (1, 0)
    # Second run sees the row as already-clean — no double-write.
    s2, c2 = scrub(db)
    assert (s2, c2) == (0, 1)


def test_scrub_skips_unparsed_bureau_rows(db):
    # A bureau-sender email that was IGNORED (e.g. marketing from
    # experian.com that no parser claimed) should not be stripped here —
    # only parsed-outcome rows are in scope.
    em = make_email_message(
        db,
        parser_name=None,
        parser_outcome=ParserOutcome.ignored,
        body_plain="experian marketing copy",
        snippet="promo",
        from_domain="experian.com",
    )
    stripped, clean = scrub(db)
    assert (stripped, clean) == (0, 0)
    db.refresh(em)
    assert em.body_plain == "experian marketing copy"
