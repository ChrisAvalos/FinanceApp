"""Orchestrates Gmail search → fetch → parse → persist.

Flow per sync::

    1. Build a Gmail query from the registry (`from:chase.com OR from:…`).
    2. Page through messages.list to collect candidate IDs.
    3. Skip any ID we've already stored in EmailMessage.
    4. For each new ID: fetch full message, normalize, dispatch to parsers.
    5. Persist an EmailMessage row for every message (including ``ignored``)
       so the next sync doesn't re-fetch it.
    6. If the matching parser produced a TransactionDraft, resolve it to an
       Account (matching on card_last4 → mask when possible, else falling
       back to a synthetic "Gmail alerts" account) and upsert a Transaction.

Design notes:

* **External-id strategy.** For Gmail-sourced transactions,
  ``external_id = gmail_message_id``. Gmail message IDs are stable and
  globally unique per account, which makes our UniqueConstraint on
  ``(source, external_id, account_id)`` do the right thing automatically.
* **Dedup vs Plaid.** We intentionally keep email-derived transactions
  separate from Plaid transactions for the same real-world charge —
  cross-referencing them (Phase 3) is much easier when both rows exist.
* **Transaction account resolution.** If the parser extracted a
  ``card_last4``, we look for an existing Account with matching ``mask``.
  Otherwise we find-or-create a synthetic account scoped to the
  sender's institution so the transaction isn't orphaned.
* **Failure isolation.** Parser exceptions are caught per-message; one
  bad email can't poison the whole sync. The traceback lands in
  ``EmailMessage.parser_error`` for debugging.
"""
from __future__ import annotations

import logging
import traceback
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..config import settings
from ..db.models import (
    Account,
    AccountType,
    CategorySource,
    EmailMessage,
    IngestSource,
    Institution,
    InstitutionKind,
    ParserOutcome,
    Transaction,
    TransactionStatus,
)
from . import parsers
from .client import GmailClient, GmailMessage

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------
#  Audit 2026-05-22 #2 — credit-bureau body strip
# ---------------------------------------------------------------------
#
# Once a credit-bureau parser has matched, the structured fields
# (score, deltas, account fragments) live in EmailMessage.extra.
# The raw body and Gmail snippet are then redundant copies of the
# same data — but the SQLite file is unencrypted and gets copied
# verbatim into backend/backups/ for 60 days, which made a casual
# leak (the SmartCredit dashboard in git history, surfaced 2026-05-22)
# a structural exposure rather than a one-off. After a parsed match
# here, body_plain and snippet are dropped and a marker is added to
# extra so the redaction is auditable.
_CREDIT_BUREAU_PARSERS: frozenset[str] = frozenset({
    "credit_karma_report",
    "equifax_report",
    "experian_report",
    "smart_credit_report",
    "transunion_report",
})


# A synthetic catch-all institution + account for email-sourced transactions
# that we can't map to a real account (no card_last4 extracted, or card_last4
# didn't match any known Account.mask).
_FALLBACK_INSTITUTION_NAME = "Gmail (email-derived)"
_FALLBACK_ACCOUNT_NAME = "Gmail inbox"


# Map a parser's from-domain pattern to an institution name we create/match
# on so email alerts land on real-looking accounts. Order matters — the
# first key whose substring appears in ``from_domain`` wins.
_DOMAIN_TO_INSTITUTION = [
    ("chase.com", ("Chase", InstitutionKind.credit_card_issuer)),
    ("americanexpress.com", ("American Express", InstitutionKind.credit_card_issuer)),
    ("aexp.com", ("American Express", InstitutionKind.credit_card_issuer)),
    ("bankofamerica.com", ("Bank of America", InstitutionKind.bank)),
    ("bofa.com", ("Bank of America", InstitutionKind.bank)),
    ("wellsfargo.com", ("Wells Fargo", InstitutionKind.bank)),
    ("xfinity.com", ("Xfinity", InstitutionKind.service_provider)),
    ("comcast.net", ("Xfinity", InstitutionKind.service_provider)),
    ("pge.com", ("PG&E", InstitutionKind.utility)),
    ("netflix.com", ("Netflix", InstitutionKind.service_provider)),
    ("spotify.com", ("Spotify", InstitutionKind.service_provider)),
]


@dataclass
class GmailSyncResult:
    fetched: int = 0
    new: int = 0
    parsed: int = 0
    ignored: int = 0
    failed: int = 0
    transactions_created: int = 0
    bills_seen: int = 0
    offers_seen: int = 0
    reports_seen: int = 0
    per_parser: dict[str, int] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "fetched": self.fetched,
            "new": self.new,
            "parsed": self.parsed,
            "ignored": self.ignored,
            "failed": self.failed,
            "transactions_created": self.transactions_created,
            "bills_seen": self.bills_seen,
            "offers_seen": self.offers_seen,
            "reports_seen": self.reports_seen,
            "per_parser": self.per_parser,
        }


# ----------------------------------------------------------------------
#  Connector
# ----------------------------------------------------------------------


class GmailConnector:
    source = IngestSource.gmail

    def __init__(self, db: Session, client: GmailClient | None = None):
        self.db = db
        self.client = client or GmailClient()

    # ------------------------------------------------------------------
    #  Public entry points
    # ------------------------------------------------------------------

    def sync(
        self,
        *,
        newer_than_days: int | None = None,
        extra_filters: str | None = None,
        max_results: int = 500,
    ) -> GmailSyncResult:
        """Search, fetch, parse, persist.

        ``newer_than_days`` defaults to ``settings.gmail_initial_lookback_days``
        on the first sync; subsequent syncs default to 7 days (cheap top-up).
        """
        lookback = newer_than_days
        if lookback is None:
            lookback = (
                settings.gmail_initial_lookback_days
                if self._is_first_sync()
                else 14
            )

        query = parsers.build_search_query(
            newer_than_days=lookback, extra_filters=extra_filters
        )
        logger.info("Gmail sync query: %s", query)

        ids = self.client.search_ids(query, max_results=max_results)
        result = GmailSyncResult(fetched=len(ids))

        # Short-circuit: find IDs we've already seen so we don't re-fetch.
        known_ids = set(
            self.db.execute(
                select(EmailMessage.gmail_message_id).where(
                    EmailMessage.gmail_message_id.in_(ids)
                )
            )
            .scalars()
            .all()
        ) if ids else set()

        new_ids = [i for i in ids if i not in known_ids]
        result.new = len(new_ids)

        for message_id in new_ids:
            try:
                msg = self.client.get_message(message_id)
            except Exception:
                logger.exception("Gmail get_message failed for %s", message_id)
                continue
            self._process_message(msg, result)

        self.db.commit()
        return result

    # ------------------------------------------------------------------
    #  Per-message processing
    # ------------------------------------------------------------------

    def _process_message(self, msg: GmailMessage, result: GmailSyncResult) -> None:
        parse_result = None
        parser_error: str | None = None
        try:
            parse_result = parsers.dispatch(msg)
        except Exception:  # parser registry shouldn't raise, but belt + suspenders
            parser_error = traceback.format_exc(limit=5)
            logger.exception("Gmail parser registry crashed on %s", msg.gmail_message_id)

        # Decide outcome
        if parse_result is None:
            outcome = ParserOutcome.ignored
            parser_name: str | None = None
            result.ignored += 1
        elif "failed" in parse_result.tags or parse_result.payload.get("error"):
            outcome = ParserOutcome.failed
            parser_name = parse_result.parser_name
            parser_error = (
                parse_result.payload.get("error") or parser_error or "parser returned failed"
            )
            result.failed += 1
        else:
            outcome = ParserOutcome.parsed
            parser_name = parse_result.parser_name
            result.parsed += 1
            if parser_name:
                result.per_parser[parser_name] = result.per_parser.get(parser_name, 0) + 1
            # Roll up by kind for UI headline stats
            kind = _spec_kind(parser_name)
            if kind == "bill":
                result.bills_seen += 1
            elif kind == "offer":
                result.offers_seen += 1
            elif kind == "report":
                result.reports_seen += 1

        # Materialize the transaction (if any) BEFORE saving EmailMessage so
        # we can set the FK.
        transaction_id: int | None = None
        if (
            parse_result is not None
            and parse_result.transaction is not None
            and outcome == ParserOutcome.parsed
        ):
            try:
                transaction_id = self._upsert_transaction(msg, parse_result)
                if transaction_id is not None:
                    result.transactions_created += 1
            except Exception:
                logger.exception(
                    "Failed to upsert transaction for Gmail msg %s",
                    msg.gmail_message_id,
                )
                parser_error = traceback.format_exc(limit=5)
                outcome = ParserOutcome.failed
                # We already bumped parsed; undo + bump failed
                result.parsed -= 1
                result.failed += 1

        # Persist the EmailMessage row (always, even for ignored)
        self._persist_email(
            msg=msg,
            parser_name=parser_name,
            outcome=outcome,
            parse_result=parse_result,
            transaction_id=transaction_id,
            error=parser_error,
        )

    # ------------------------------------------------------------------
    #  Persistence helpers
    # ------------------------------------------------------------------

    def _persist_email(
        self,
        *,
        msg: GmailMessage,
        parser_name: str | None,
        outcome: ParserOutcome,
        parse_result,
        transaction_id: int | None,
        error: str | None,
    ) -> None:
        extra: dict = {}
        if parse_result is not None:
            extra.update(parse_result.payload)
            if parse_result.tags:
                extra["tags"] = parse_result.tags

        # Truncate body if outcome is ignored — no reason to keep a 40KB
        # marketing email indefinitely. We can always re-fetch.
        body = msg.body_plain
        snippet = msg.snippet
        if outcome == ParserOutcome.ignored and body and len(body) > 2000:
            body = body[:2000] + "\n\n…[truncated, ignored by parsers]"
        elif (
            outcome == ParserOutcome.parsed
            and parser_name in _CREDIT_BUREAU_PARSERS
        ):
            # Parsed credit-bureau report: structured fields are already in
            # ``extra``. Drop the raw body + snippet so the unencrypted
            # finance.db (and its 60-day backups/) don't keep credit-report
            # plaintext. See the module-level note above.
            body = None
            snippet = None
            extra["body_stripped_for_privacy"] = True

        stmt = sqlite_insert(EmailMessage).values(
            gmail_message_id=msg.gmail_message_id,
            gmail_thread_id=msg.gmail_thread_id,
            from_address=msg.from_address[:320],
            from_domain=msg.from_domain[:255],
            subject=(msg.subject or "")[:500],
            received_at=msg.received_at.replace(tzinfo=None),  # SQLite DateTime
            snippet=(snippet[:500] if snippet else None),
            body_plain=body,
            parser_name=parser_name,
            parser_outcome=outcome,
            parser_error=error,
            transaction_id=transaction_id,
            extra=extra or None,
        )
        # On re-sync (shouldn't happen — we filter known IDs — but defensive),
        # update the parser bookkeeping only. Never overwrite transaction_id
        # if we already have one linked.
        stmt = stmt.on_conflict_do_update(
            index_elements=["gmail_message_id"],
            set_={
                "parser_name": parser_name,
                "parser_outcome": outcome,
                "parser_error": error,
                "extra": extra or None,
            },
        )
        self.db.execute(stmt)

    def _upsert_transaction(self, msg: GmailMessage, parse_result) -> int | None:
        """Upsert a Transaction from a parsed email. Returns the row id."""
        draft = parse_result.transaction
        if draft is None:
            return None

        account_id = self._resolve_account(msg, draft)
        values = {
            "account_id": account_id,
            "posted_date": draft.posted_date,
            "amount_cents": draft.amount_cents,
            "currency": "USD",
            "status": TransactionStatus.posted,
            "description_raw": draft.description_raw[:500],
            "description_clean": (draft.merchant or None),
            "memo": (draft.memo or None),
            "source": IngestSource.gmail,
            "external_id": msg.gmail_message_id,
            "category_source": CategorySource.unset,
            "extra": {
                "gmail_message_id": msg.gmail_message_id,
                "gmail_thread_id": msg.gmail_thread_id,
                "parser": parse_result.parser_name,
                "tags": parse_result.tags,
                "card_last4": draft.card_last4,
                "from_domain": msg.from_domain,
                **(draft.extra or {}),
            },
        }

        stmt = sqlite_insert(Transaction).values(**values)
        stmt = stmt.on_conflict_do_update(
            index_elements=["source", "external_id", "account_id"],
            set_={
                "amount_cents": values["amount_cents"],
                "posted_date": values["posted_date"],
                "description_raw": values["description_raw"],
                "description_clean": values["description_clean"],
                "memo": values["memo"],
                "extra": values["extra"],
            },
        )
        self.db.execute(stmt)

        # Pull the id back so we can link EmailMessage → Transaction.
        row = self.db.execute(
            select(Transaction.id).where(
                Transaction.source == IngestSource.gmail,
                Transaction.external_id == msg.gmail_message_id,
                Transaction.account_id == account_id,
            )
        ).first()
        return row[0] if row else None

    # ------------------------------------------------------------------
    #  Account resolution
    # ------------------------------------------------------------------

    def _resolve_account(self, msg: GmailMessage, draft) -> int:
        """Find the Account this transaction should attach to.

        Priority:
          1. If the parser extracted a card_last4, look for an existing
             Account with that ``mask`` — across all institutions. First
             match wins. This handles the common case where the user has
             already imported a Chase CSV or connected Chase via Plaid.
          2. Else find-or-create an email-scoped Account for the sender's
             institution (``Chase (email-only)``, etc.).
          3. Else fall back to the global ``Gmail inbox`` account.
        """
        # (1) Match by card_last4
        if draft.card_last4:
            hit = (
                self.db.execute(
                    select(Account).where(Account.mask == draft.card_last4)
                )
                .scalars()
                .first()
            )
            if hit is not None:
                return hit.id

        # (2) Institution-scoped email account
        inst_name, inst_kind = _match_institution(msg.from_domain)
        institution = self._get_or_create_institution(inst_name, inst_kind)
        account_name = f"{inst_name} (email-only)"
        acct = (
            self.db.execute(
                select(Account).where(
                    Account.institution_id == institution.id,
                    Account.name == account_name,
                )
            )
            .scalars()
            .first()
        )
        if acct is None:
            acct = Account(
                institution_id=institution.id,
                name=account_name,
                account_type=_default_account_type_for_kind(inst_kind),
                mask=draft.card_last4,
                notes="Synthetic — populated from Gmail parsing when no real account matched.",
            )
            self.db.add(acct)
            self.db.flush()
        return acct.id

    def _get_or_create_institution(
        self, name: str, kind: InstitutionKind
    ) -> Institution:
        existing = (
            self.db.execute(select(Institution).where(Institution.name == name))
            .scalars()
            .first()
        )
        if existing is not None:
            return existing
        inst = Institution(name=name, kind=kind)
        self.db.add(inst)
        self.db.flush()
        return inst

    # ------------------------------------------------------------------
    #  Diagnostics
    # ------------------------------------------------------------------

    def _is_first_sync(self) -> bool:
        row = self.db.execute(select(EmailMessage.id).limit(1)).first()
        return row is None

    def last_sync_time(self) -> datetime | None:
        row = self.db.execute(
            select(EmailMessage.received_at)
            .order_by(EmailMessage.received_at.desc())
            .limit(1)
        ).first()
        return row[0] if row else None


# ----------------------------------------------------------------------
#  Helpers
# ----------------------------------------------------------------------


def _match_institution(from_domain: str) -> tuple[str, InstitutionKind]:
    for substring, (name, kind) in _DOMAIN_TO_INSTITUTION:
        if substring in from_domain:
            return name, kind
    return _FALLBACK_INSTITUTION_NAME, InstitutionKind.other


def _default_account_type_for_kind(kind: InstitutionKind) -> AccountType:
    if kind == InstitutionKind.credit_card_issuer:
        return AccountType.credit_card
    if kind == InstitutionKind.utility or kind == InstitutionKind.service_provider:
        # Bills don't live on "utility accounts" — they show up on whatever
        # card/account pays them. The fake container just needs a type.
        return AccountType.other
    if kind == InstitutionKind.bank:
        return AccountType.checking
    return AccountType.other


def _spec_kind(parser_name: str | None) -> str:
    if not parser_name:
        return ""
    for spec in parsers.list_parsers():
        if spec.name == parser_name:
            return spec.kind
    return ""
