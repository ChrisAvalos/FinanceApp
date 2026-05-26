"""Characterization tests for the credit-bureau body strip.

Audit 2026-05-22 #2: a parsed credit-bureau report has its raw
``body_plain`` and Gmail ``snippet`` dropped at persistence time so the
unencrypted finance.db (and its 60-day backups/) don't hold credit-report
plaintext. The structured fields the parser extracted live in ``extra``
and are unaffected.
"""
from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from finance_app.db.models import EmailMessage, ParserOutcome
from finance_app.gmail.client import GmailMessage
from finance_app.gmail.connector import GmailConnector


def _connector(db) -> GmailConnector:
    # The default GmailClient would try to load credentials; an opaque
    # sentinel is truthy, so __init__ keeps it as-is and we never hit
    # the network for tests that only exercise _persist_email.
    return GmailConnector(db, client=object())


def _msg(*, body: str = "full body text " * 200,
        snippet: str = "score ready") -> GmailMessage:
    return GmailMessage(
        gmail_message_id="gm-1",
        gmail_thread_id=None,
        from_address="alerts@experian.com",
        from_domain="experian.com",
        subject="Your score is ready",
        received_at=datetime(2026, 5, 15, 12, 0, 0),
        snippet=snippet,
        body_plain=body,
        headers={},
    )


def _parse_result(parser_name: str, payload: dict | None = None):
    return SimpleNamespace(
        parser_name=parser_name,
        payload=payload or {},
        tags=[],
        transaction=None,
    )


def test_parsed_credit_bureau_email_body_is_stripped(db):
    conn = _connector(db)
    conn._persist_email(
        msg=_msg(body="A" * 30000, snippet="FICO 752"),
        parser_name="experian_report",
        outcome=ParserOutcome.parsed,
        parse_result=_parse_result("experian_report", {"fico_score": 752}),
        transaction_id=None,
        error=None,
    )
    em = db.execute(select(EmailMessage)).scalars().one()
    assert em.parser_name == "experian_report"
    assert em.body_plain is None
    assert em.snippet is None
    assert em.extra is not None
    assert em.extra.get("body_stripped_for_privacy") is True
    # The structured fields the parser extracted are still there.
    assert em.extra.get("fico_score") == 752


@pytest.mark.parametrize("bureau_parser", [
    "credit_karma_report",
    "equifax_report",
    "experian_report",
    "smart_credit_report",
    "transunion_report",
])
def test_every_bureau_parser_triggers_strip(db, bureau_parser):
    conn = _connector(db)
    conn._persist_email(
        msg=_msg(),
        parser_name=bureau_parser,
        outcome=ParserOutcome.parsed,
        parse_result=_parse_result(bureau_parser, {"score": 700}),
        transaction_id=None,
        error=None,
    )
    em = db.execute(select(EmailMessage)).scalars().one()
    assert em.body_plain is None
    assert em.snippet is None
    assert em.extra["body_stripped_for_privacy"] is True


def test_parsed_non_bureau_email_keeps_body(db):
    # A parsed Chase alert (not a credit bureau) keeps its body intact —
    # the strip is deliberately targeted at credit bureaus only.
    conn = _connector(db)
    conn._persist_email(
        msg=_msg(body="You spent $42 at Starbucks", snippet="charge alert"),
        parser_name="chase_alerts",
        outcome=ParserOutcome.parsed,
        parse_result=_parse_result("chase_alerts", {"amount_cents": -4200}),
        transaction_id=None,
        error=None,
    )
    em = db.execute(select(EmailMessage)).scalars().one()
    assert em.parser_name == "chase_alerts"
    assert em.body_plain == "You spent $42 at Starbucks"
    assert em.snippet == "charge alert"
    assert "body_stripped_for_privacy" not in (em.extra or {})


def test_ignored_marketing_truncation_is_unchanged(db):
    # The pre-existing 2KB truncate for ignored marketing mail must still
    # apply — the new branch only handles parsed credit-bureau rows.
    conn = _connector(db)
    conn._persist_email(
        msg=_msg(body="x" * 50000),
        parser_name=None,
        outcome=ParserOutcome.ignored,
        parse_result=None,
        transaction_id=None,
        error=None,
    )
    em = db.execute(select(EmailMessage)).scalars().one()
    assert em.body_plain is not None
    assert len(em.body_plain) <= 2100  # 2000 + the truncation marker
    assert "truncated, ignored by parsers" in em.body_plain
