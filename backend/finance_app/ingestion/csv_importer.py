"""CSV importers for common US banks/cards.

Every bank's CSV differs in column names, date format, and sign convention.
We handle this with one base (``CsvImporter``) + per-institution adapters that
override a small set of methods.

Sign convention (our schema):
    - Outflow (money leaving account)  -> NEGATIVE amount_cents
    - Inflow  (money entering account) -> POSITIVE amount_cents

Different banks export differently; adapters normalize to the above.

Adding a new bank:
    class NewBankCsvImporter(CsvImporter):
        columns = ColumnMap(date="Date", amount="Amount", description="Desc")
        date_format = "%m/%d/%Y"
        def sign_amount(self, amt: Decimal, row: dict) -> Decimal: return amt
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from dateutil.parser import parse as parse_date

from finance_app.db.models import IngestSource, TransactionStatus
from finance_app.ingestion.base import Importer, NormalizedTxn


@dataclass
class ColumnMap:
    """Names of the columns as they appear in the bank's CSV."""
    date: str
    description: str
    amount: str | None = None
    # For banks that split debits/credits into separate columns
    debit: str | None = None
    credit: str | None = None
    memo: str | None = None
    category: str | None = None  # bank-suggested category (ignored by default)
    status: str | None = None


class CsvImporter(Importer):
    source = IngestSource.csv
    columns: ColumnMap = ColumnMap(date="Date", description="Description", amount="Amount")
    date_format: str | None = None  # None -> dateutil auto-parse
    skip_rows: int = 0

    def parse(self, source_ref: str) -> list[dict[str, Any]]:
        path = Path(source_ref)
        with path.open(newline="", encoding="utf-8-sig") as f:
            for _ in range(self.skip_rows):
                next(f, None)
            reader = csv.DictReader(f)
            return [dict(row) for row in reader]

    # Hooks subclasses can override -------------------------------------------

    def parse_amount(self, row: dict[str, Any]) -> Decimal:
        """Return the raw (unsigned-by-us) amount as Decimal."""
        col = self.columns
        if col.amount:
            raw = row.get(col.amount, "").replace("$", "").replace(",", "").strip()
            return Decimal(raw) if raw else Decimal(0)
        # Debit/credit split columns
        debit = row.get(col.debit or "", "").replace("$", "").replace(",", "").strip()
        credit = row.get(col.credit or "", "").replace("$", "").replace(",", "").strip()
        if debit:
            return -Decimal(debit)
        if credit:
            return Decimal(credit)
        return Decimal(0)

    def sign_amount(self, amount: Decimal, row: dict[str, Any]) -> Decimal:
        """Adapt the bank's sign convention to ours (outflow=negative).

        Default: trust the CSV. Subclasses override when needed.
        """
        return amount

    def parse_date_val(self, row: dict[str, Any]) -> Any:
        raw = row[self.columns.date].strip()
        if self.date_format:
            return datetime.strptime(raw, self.date_format).date()
        return parse_date(raw).date()

    def parse_description(self, row: dict[str, Any]) -> str:
        return row.get(self.columns.description, "").strip()

    def parse_memo(self, row: dict[str, Any]) -> str | None:
        if self.columns.memo:
            val = row.get(self.columns.memo)
            return val.strip() if val else None
        return None

    def parse_status(self, row: dict[str, Any]) -> TransactionStatus:
        if self.columns.status:
            raw = (row.get(self.columns.status) or "").lower()
            if "pending" in raw:
                return TransactionStatus.pending
        return TransactionStatus.posted

    # Normalize ----------------------------------------------------------------

    def normalize_row(self, row: dict[str, Any]) -> NormalizedTxn | None:
        desc = self.parse_description(row)
        if not desc:
            return None
        amt = self.parse_amount(row)
        amt = self.sign_amount(amt, row)
        amount_cents = int((amt * 100).to_integral_value())
        return NormalizedTxn(
            posted_date=self.parse_date_val(row),
            amount_cents=amount_cents,
            description_raw=desc,
            memo=self.parse_memo(row),
            status=self.parse_status(row),
        )


# ---- Adapters ---------------------------------------------------------------

class ChaseCsvImporter(CsvImporter):
    """Chase checking/credit card CSV.

    Columns typically: Transaction Date, Post Date, Description, Category, Type, Amount, Memo
    Amounts are already signed correctly (debits negative).
    """
    columns = ColumnMap(
        date="Post Date",
        description="Description",
        amount="Amount",
        memo="Memo",
        category="Category",
    )


class BofACsvImporter(CsvImporter):
    """Bank of America checking CSV.

    Columns: Date, Description, Amount, Running Bal.
    Amounts are signed correctly. BofA includes a header summary block — skip_rows
    might need bumping depending on the file.
    """
    columns = ColumnMap(date="Date", description="Description", amount="Amount")


class AmexCsvImporter(CsvImporter):
    """American Express CSV — charges are POSITIVE in their export. We flip to negative."""
    columns = ColumnMap(date="Date", description="Description", amount="Amount")

    def sign_amount(self, amount: Decimal, row: dict[str, Any]) -> Decimal:
        # Amex: +amount means a charge (outflow for cardholder); negative means payment/refund.
        return -amount


class DiscoverCsvImporter(CsvImporter):
    """Discover CSV — same inversion as Amex."""
    columns = ColumnMap(
        date="Trans. Date",
        description="Description",
        amount="Amount",
        category="Category",
    )

    def sign_amount(self, amount: Decimal, row: dict[str, Any]) -> Decimal:
        return -amount


class CitiCsvImporter(CsvImporter):
    """Citi credit card CSV — separate Debit/Credit columns."""
    columns = ColumnMap(
        date="Date",
        description="Description",
        debit="Debit",
        credit="Credit",
    )
    # parse_amount in base handles debit/credit correctly (debit -> negative).


class GenericCsvImporter(CsvImporter):
    """For manually-formatted CSVs: Date, Description, Amount (signed)."""
    columns = ColumnMap(date="Date", description="Description", amount="Amount")


IMPORTER_REGISTRY: dict[str, type[CsvImporter]] = {
    "chase": ChaseCsvImporter,
    "bofa": BofACsvImporter,
    "amex": AmexCsvImporter,
    "discover": DiscoverCsvImporter,
    "citi": CitiCsvImporter,
    "generic": GenericCsvImporter,
}


def get_importer(slug: str) -> type[CsvImporter]:
    slug = slug.lower()
    if slug not in IMPORTER_REGISTRY:
        raise ValueError(
            f"Unknown CSV format '{slug}'. Known: {sorted(IMPORTER_REGISTRY)}"
        )
    return IMPORTER_REGISTRY[slug]
