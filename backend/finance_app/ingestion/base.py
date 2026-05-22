"""Base classes for ingesting transactions from any source.

Flow:
    raw rows (from parse)
        -> normalize()  produces list[NormalizedTxn]
        -> load()       inserts into DB, deduping on (source, external_id, account_id)
        -> returns an IngestBatch record so the caller can inspect outcomes.

Subclasses implement ``parse()`` and ``normalize_row()``.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from finance_app.db.models import (
    Account,
    CategorySource,
    IngestBatch,
    IngestSource,
    Transaction,
    TransactionStatus,
)
from finance_app.ingestion.deduplication import fingerprint


@dataclass
class NormalizedTxn:
    posted_date: date
    amount_cents: int  # signed: negative=outflow, positive=inflow
    description_raw: str
    description_clean: str | None = None
    memo: str | None = None
    status: TransactionStatus = TransactionStatus.posted
    external_id: str | None = None
    extra: dict[str, Any] | None = None


class Importer(ABC):
    """Subclass once per source format (Chase CSV, BofA CSV, OFX, Plaid...)."""

    source: IngestSource

    def __init__(self, db: Session, account: Account):
        self.db = db
        self.account = account

    # --- subclasses implement these two ---

    @abstractmethod
    def parse(self, source_ref: str) -> list[dict[str, Any]]:
        """Read the source into raw row dicts."""

    @abstractmethod
    def normalize_row(self, row: dict[str, Any]) -> NormalizedTxn | None:
        """Convert one raw row to a NormalizedTxn, or None to skip."""

    # --- shared plumbing below ---

    def run(self, source_ref: str) -> IngestBatch:
        batch = IngestBatch(
            source=self.source,
            account_id=self.account.id,
            source_ref=source_ref,
        )
        self.db.add(batch)
        self.db.flush()

        errors: list[str] = []
        created = 0
        duplicate = 0
        parsed = 0

        try:
            rows = self.parse(source_ref)
        except Exception as exc:  # surface the failure in the batch record
            batch.errors = f"parse failed: {exc!r}"
            batch.finished_at = datetime.utcnow()
            self.db.commit()
            return batch

        for row in rows:
            parsed += 1
            try:
                ntxn = self.normalize_row(row)
            except Exception as exc:
                errors.append(f"row {parsed}: {exc!r}")
                continue
            if ntxn is None:
                continue

            external_id = ntxn.external_id or fingerprint(
                account_id=self.account.id,
                posted_date=ntxn.posted_date,
                amount_cents=ntxn.amount_cents,
                description=ntxn.description_raw,
            )

            # SQLite upsert — "insert or ignore" on our composite uniqueness
            stmt = sqlite_insert(Transaction).values(
                account_id=self.account.id,
                posted_date=ntxn.posted_date,
                amount_cents=ntxn.amount_cents,
                currency=self.account.currency,
                status=ntxn.status,
                description_raw=ntxn.description_raw,
                description_clean=ntxn.description_clean,
                memo=ntxn.memo,
                source=self.source,
                external_id=external_id,
                ingest_batch_id=batch.id,
                category_source=CategorySource.unset,
                extra=ntxn.extra,
            )
            stmt = stmt.on_conflict_do_nothing(
                index_elements=["source", "external_id", "account_id"],
            )
            result = self.db.execute(stmt)
            if result.rowcount and result.rowcount > 0:
                created += 1
            else:
                duplicate += 1

        batch.rows_parsed = parsed
        batch.rows_created = created
        batch.rows_duplicate = duplicate
        batch.errors = "\n".join(errors) if errors else None
        batch.finished_at = datetime.utcnow()
        self.db.commit()
        return batch
