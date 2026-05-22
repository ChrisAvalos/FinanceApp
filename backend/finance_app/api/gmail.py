"""Gmail endpoints.

Flow:

    1. GET  /gmail/status            → configured + authorized + last-sync info.
    2. POST /gmail/authorize         → run the OAuth installed-app flow (opens
                                       a browser on the *server* machine — same
                                       box as the backend. CLI-first by design).
    3. POST /gmail/sync              → search + fetch + parse + persist.
    4. GET  /gmail/messages          → list parsed emails, filter by outcome /
                                       parser / domain.
    5. GET  /gmail/parsers           → introspect registered parsers.

Why CLI-first OAuth (``/authorize`` opens a browser server-side, not
client-side)? Because the whole app is local: the backend and the user's
browser already live on the same machine. Driving the flow from a UI
button keeps the surface minimal — no need to implement redirect URIs,
state nonces, or web-server callback endpoints. It's the same pattern
Google's quickstart examples use.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from finance_app.db.models import EmailMessage, ParserOutcome
from finance_app.db.session import get_db
from finance_app.gmail import parsers as gmail_parsers
from finance_app.gmail.client import (
    GmailClient,
    GmailDependenciesMissing,
    GmailNotConfigured,
)
from finance_app.gmail.connector import GmailConnector

router = APIRouter(prefix="/gmail", tags=["gmail"])


# ---------------------------------------------------------------------
#  Schemas
# ---------------------------------------------------------------------


class GmailStatus(BaseModel):
    configured: bool  # credentials.json exists
    authorized: bool  # token.json exists (valid or refreshable)
    deps_installed: bool
    credentials_path: str
    token_path: str
    scopes: list[str]
    last_sync_at: datetime | None
    total_messages: int
    total_parsed: int
    total_failed: int


class AuthorizeResult(BaseModel):
    authorized: bool
    message: str


class SyncIn(BaseModel):
    newer_than_days: int | None = None
    extra_filters: str | None = None
    max_results: int = 500


class SyncResult(BaseModel):
    fetched: int
    new: int
    parsed: int
    ignored: int
    failed: int
    transactions_created: int
    bills_seen: int
    offers_seen: int
    reports_seen: int
    per_parser: dict[str, int]


class EmailMessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    gmail_message_id: str
    gmail_thread_id: str | None
    from_address: str
    from_domain: str
    subject: str | None
    received_at: datetime
    snippet: str | None
    parser_name: str | None
    parser_outcome: ParserOutcome
    parser_error: str | None
    transaction_id: int | None
    extra: dict | None
    created_at: datetime


class ParserOut(BaseModel):
    name: str
    label: str
    from_domains: list[str]
    subject_patterns: list[str]
    kind: str
    priority: int
    match_count: int  # number of EmailMessages attributed to this parser so far


# ---------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------


def _client() -> GmailClient:
    return GmailClient()


def _connector(db: Session, client: GmailClient | None = None) -> GmailConnector:
    return GmailConnector(db, client or _client())


# ---------------------------------------------------------------------
#  Endpoints
# ---------------------------------------------------------------------


@router.get("/status", response_model=GmailStatus)
def gmail_status(db: Session = Depends(get_db)) -> GmailStatus:
    client = _client()
    status = client.status()

    last_sync_row = db.execute(
        select(EmailMessage.created_at)
        .order_by(EmailMessage.created_at.desc())
        .limit(1)
    ).first()
    total = db.execute(select(func.count(EmailMessage.id))).scalar() or 0
    parsed = (
        db.execute(
            select(func.count(EmailMessage.id)).where(
                EmailMessage.parser_outcome == ParserOutcome.parsed
            )
        ).scalar()
        or 0
    )
    failed = (
        db.execute(
            select(func.count(EmailMessage.id)).where(
                EmailMessage.parser_outcome == ParserOutcome.failed
            )
        ).scalar()
        or 0
    )

    return GmailStatus(
        configured=status["credentials_present"],
        authorized=status["token_present"],
        deps_installed=status["deps_installed"],
        credentials_path=status["credentials_path"],
        token_path=status["token_path"],
        scopes=status["scopes"],
        last_sync_at=last_sync_row[0] if last_sync_row else None,
        total_messages=total,
        total_parsed=parsed,
        total_failed=failed,
    )


@router.post("/authorize", response_model=AuthorizeResult)
def authorize() -> AuthorizeResult:
    """Run the installed-app OAuth flow on the server. This will open a
    browser tab on the machine running the backend.
    """
    client = _client()
    try:
        client.authorize(interactive=True)
    except GmailDependenciesMissing as exc:
        raise HTTPException(503, str(exc)) from exc
    except GmailNotConfigured as exc:
        raise HTTPException(503, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Gmail authorize failed: {exc!r}") from exc
    return AuthorizeResult(authorized=True, message="Gmail access granted.")


@router.post("/sync", response_model=SyncResult)
def sync_gmail(
    payload: SyncIn | None = None, db: Session = Depends(get_db)
) -> SyncResult:
    payload = payload or SyncIn()
    client = _client()
    try:
        client.authorize(interactive=False)
    except GmailDependenciesMissing as exc:
        raise HTTPException(503, str(exc)) from exc
    except GmailNotConfigured as exc:
        raise HTTPException(
            503,
            "Gmail is not authorized yet. POST /gmail/authorize first "
            "(opens a browser on the backend machine).",
        ) from exc

    connector = GmailConnector(db, client)
    try:
        result = connector.sync(
            newer_than_days=payload.newer_than_days,
            extra_filters=payload.extra_filters,
            max_results=payload.max_results,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Gmail sync failed: {exc!r}") from exc
    return SyncResult(**result.as_dict())


@router.get("/messages", response_model=list[EmailMessageOut])
def list_messages(
    db: Session = Depends(get_db),
    outcome: ParserOutcome | None = Query(None, description="Filter by parser outcome"),
    parser: str | None = Query(None, description="Filter by parser name"),
    domain: str | None = Query(None, description="Filter by from_domain substring"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> list[EmailMessage]:
    stmt = select(EmailMessage).order_by(EmailMessage.received_at.desc())
    if outcome is not None:
        stmt = stmt.where(EmailMessage.parser_outcome == outcome)
    if parser:
        stmt = stmt.where(EmailMessage.parser_name == parser)
    if domain:
        stmt = stmt.where(EmailMessage.from_domain.like(f"%{domain}%"))
    stmt = stmt.limit(limit).offset(offset)
    return list(db.execute(stmt).scalars().all())


class ReparseResult(BaseModel):
    """Outcome of re-parsing already-ingested EmailMessages."""
    scanned: int
    re_parsed: int           # rows whose outcome changed from ignored→parsed
    still_ignored: int
    by_parser: dict[str, int]
    notes: list[str]


@router.post("/reparse", response_model=ReparseResult)
def reparse_messages(
    parser: str | None = Query(
        None, description="Only re-parse rows currently attributed to this "
        "parser name OR rows where the named parser would now match a "
        "previously-ignored message. If None, scans all ignored rows."
    ),
    db: Session = Depends(get_db),
) -> ReparseResult:
    """Re-run parsers against already-stored EmailMessage rows.

    Used after a parser bugfix (Sprint 7: Apple receipt format change)
    to retroactively classify messages that were marked ``ignored``
    only because the old parser failed to extract data from their body.
    """
    from finance_app.gmail import parsers as gmail_parsers
    from finance_app.gmail.client import GmailMessage as _GM

    stmt = select(EmailMessage)
    if parser:
        # When a parser name is supplied, scan rows that were either
        # ignored by everyone OR previously attributed to that parser
        # (catches the case where the old parser returned a partial
        # result we now want to refresh).
        stmt = stmt.where(
            (EmailMessage.parser_outcome == ParserOutcome.ignored)
            | (EmailMessage.parser_name == parser)
        )
    else:
        stmt = stmt.where(EmailMessage.parser_outcome == ParserOutcome.ignored)

    rows = list(db.execute(stmt).scalars().all())
    re_parsed = 0
    still_ignored = 0
    by_parser: dict[str, int] = {}
    notes: list[str] = []

    for row in rows:
        # Reconstruct a GmailMessage shim from the stored fields so the
        # parser registry can dispatch normally. HTML body isn't stored
        # (we lose it during HTML→text conversion), so parsers only get
        # body_plain — which is what they read anyway.
        msg = _GM(
            gmail_message_id=row.gmail_message_id,
            gmail_thread_id=row.gmail_thread_id,
            from_address=row.from_address,
            from_domain=row.from_domain,
            subject=row.subject or "",
            received_at=row.received_at,
            snippet=row.snippet or "",
            body_plain=row.body_plain or "",
            headers={},
        )
        try:
            result = gmail_parsers.dispatch(msg)
        except Exception as exc:  # noqa: BLE001
            notes.append(f"Row {row.id}: parser registry crashed: {exc!r}")
            still_ignored += 1
            continue
        if result is None:
            still_ignored += 1
            continue
        if "failed" in result.tags or result.payload.get("error"):
            still_ignored += 1
            continue
        # Mark parsed. We don't materialize a Transaction here — the
        # original sync path handles that, and re-parse is for repairing
        # `extra`/parser_name only.
        row.parser_name = result.parser_name
        row.parser_outcome = ParserOutcome.parsed
        row.parser_error = None
        # Preserve original ingest's `extra` keys, merge in fresh payload.
        existing_extra = dict(row.extra or {})
        existing_extra.update(result.payload or {})
        row.extra = existing_extra
        re_parsed += 1
        by_parser[result.parser_name] = by_parser.get(result.parser_name, 0) + 1

    db.commit()
    return ReparseResult(
        scanned=len(rows),
        re_parsed=re_parsed,
        still_ignored=still_ignored,
        by_parser=by_parser,
        notes=notes[:50],
    )


class MessageBodyOut(BaseModel):
    """Diagnostic view of one email's full stored body."""
    model_config = ConfigDict(from_attributes=True)

    id: int
    subject: str | None
    from_address: str
    from_domain: str
    snippet: str | None
    body_plain: str | None
    parser_name: str | None
    parser_outcome: ParserOutcome
    parser_error: str | None


@router.get("/messages/{message_id}/body", response_model=MessageBodyOut)
def get_message_body(
    message_id: int, db: Session = Depends(get_db)
) -> EmailMessage:
    """Return one email's full stored body. Diagnostic endpoint for
    debugging parsers that are mismatching real-world layouts."""
    row = db.get(EmailMessage, message_id)
    if not row:
        raise HTTPException(404, f"EmailMessage {message_id} not found")
    return row


@router.get("/parsers", response_model=list[ParserOut])
def list_parsers_endpoint(db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    # Per-parser match counts in one roundtrip
    rows = db.execute(
        select(EmailMessage.parser_name, func.count(EmailMessage.id))
        .where(EmailMessage.parser_name.isnot(None))
        .group_by(EmailMessage.parser_name)
    ).all()
    counts: dict[str, int] = {name: n for name, n in rows}

    out: list[dict[str, Any]] = []
    for spec in gmail_parsers.list_parsers():
        out.append(
            {
                "name": spec.name,
                "label": spec.label,
                "from_domains": list(spec.from_domains),
                "subject_patterns": list(spec.subject_patterns),
                "kind": spec.kind,
                "priority": spec.priority,
                "match_count": counts.get(spec.name, 0),
            }
        )
    return out
