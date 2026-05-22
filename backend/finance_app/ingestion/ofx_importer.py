"""OFX / QFX importer.

Many banks support OFX downloads which are more structured than CSVs. The
``ofxparse`` library extracts accounts, balances, and transactions for us.

If we're given multiple accounts in the file, we expect the caller to pre-select
the correct account by matching mask/institution.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from ofxparse import OfxParser

from finance_app.db.models import IngestSource, TransactionStatus
from finance_app.ingestion.base import Importer, NormalizedTxn


class OfxImporter(Importer):
    source = IngestSource.ofx

    def parse(self, source_ref: str) -> list[dict[str, Any]]:
        path = Path(source_ref)
        with path.open("rb") as f:
            ofx = OfxParser.parse(f)
        rows: list[dict[str, Any]] = []
        for acct in ofx.accounts:
            for txn in acct.statement.transactions:
                rows.append({
                    "id": txn.id,
                    "date": txn.date,
                    "amount": txn.amount,
                    "payee": txn.payee or "",
                    "memo": txn.memo or "",
                    "type": txn.type,
                })
        return rows

    def normalize_row(self, row: dict[str, Any]) -> NormalizedTxn | None:
        payee = row.get("payee") or ""
        memo = row.get("memo") or ""
        description = payee or memo
        if not description:
            return None
        amount_cents = int(round(float(row["amount"]) * 100))
        posted_date = row["date"].date() if hasattr(row["date"], "date") else row["date"]
        return NormalizedTxn(
            posted_date=posted_date,
            amount_cents=amount_cents,
            description_raw=description,
            memo=memo if memo and memo != payee else None,
            status=TransactionStatus.posted,
            external_id=row.get("id"),  # OFX gives us a stable ID — use it
        )
