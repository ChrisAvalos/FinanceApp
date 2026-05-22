"""Tax-bucket roll-up + CSV exporter.

Buckets are commonly used Schedule A / Schedule C / 1040 line items;
the mapping below is conservative — if a category COULD plausibly be
deductible we put it in the right bucket, but we don't guess in
ambiguous cases. The user can post-process or hand the output to a
CPA who'll know which line items actually qualify for their situation.

Public entry points:

  * :func:`build_annual_tax_report(db, year)` — structured roll-up.
  * :func:`render_csv(report)` — CSV string suitable for import.

PDF rendering is intentionally not in scope — once the structured
report exists, any consumer (UI, headless render, AI summarizer) can
turn it into PDF if needed.
"""
from __future__ import annotations

import csv
import io
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import Category, Transaction


# Map: tax_bucket -> list of category slugs that flow into it.
# Edit here to add buckets. Slugs not in any bucket land in "untagged"
# in the report (so the user sees what's NOT being tagged).
TAX_BUCKETS: dict[str, list[str]] = {
    "charitable_donations": [
        # The default categorization rules surface qualifying charitable
        # transactions under ``giving.charitable`` (Red Cross, NPR
        # pledges, GoFundMe, religious institution donations, etc.).
        # Smoke_phase_7 caught the bucket being empty even though the
        # slug was already populated — wire the obvious mapping.
        "giving.charitable",
        "giving.tithe",
    ],
    "medical_health": [
        "health.medical",
        "health.pharmacy",
        # health.fitness intentionally excluded — gym memberships are
        # rarely deductible
    ],
    "hsa_fsa_contributions": [
        # User-tagged transactions toward HSA/FSA accounts. Currently
        # plumbed via account_type=hsa transfers, not a category slug.
    ],
    "mortgage_interest": [
        # Plaid usually splits mortgage payments into principal +
        # interest at the issuer level; we don't auto-split. User can
        # add a custom category + rule to flag the interest portion.
    ],
    "property_tax": [
        # Same as above — typically a separate annual or escrow line.
    ],
    "state_local_tax": [
        # Captured implicitly via paycheck deduction; not in transactions
    ],
    "education": [
        # Tuition / 1098-T amounts.
    ],
    "child_care": [
        # Daycare / afterschool / camp. No default category.
    ],
    "business_expenses": [
        # Schedule C / freelance. The user typically segregates these
        # via a dedicated card or manual flag — we don't try to guess.
        "subscriptions.software",  # often deductible if used for biz
    ],
    "self_employment_income": [
        "income.other",  # 1099-NEC / -MISC
    ],
    "investment_income": [
        "income.interest",
    ],
    "wages": [
        "income.salary",
    ],
}


# Reverse lookup: slug -> bucket
def _slug_to_bucket() -> dict[str, str]:
    out: dict[str, str] = {}
    for bucket, slugs in TAX_BUCKETS.items():
        for s in slugs:
            out[s] = bucket
    return out


@dataclass
class BucketRollup:
    bucket: str
    total_cents: int
    txn_count: int
    transactions: list[dict] = field(default_factory=list)


@dataclass
class AnnualTaxReport:
    year: int
    by_bucket: list[BucketRollup]
    untagged_total_cents: int
    untagged_txn_count: int
    untagged_top_categories: list[tuple[str, int]]  # (category_name, total)
    grand_total_outflow_cents: int
    grand_total_inflow_cents: int


def build_annual_tax_report(db: Session, year: int) -> AnnualTaxReport:
    """Walk every transaction in ``year`` and bucket by tax category."""
    start = date(year, 1, 1)
    end = date(year, 12, 31)

    # Slug + name lookup once.
    cats = {c.id: (c.slug, c.name) for c in db.execute(select(Category)).scalars().all()}
    slug_to_bucket = _slug_to_bucket()

    rows = list(
        db.execute(
            select(Transaction)
            .where(Transaction.posted_date >= start)
            .where(Transaction.posted_date <= end)
        ).scalars().all()
    )

    by_bucket: dict[str, BucketRollup] = {}
    untagged_by_cat: dict[str, int] = defaultdict(int)
    untagged_txn_count = 0
    untagged_total = 0
    grand_outflow = 0
    grand_inflow = 0

    for t in rows:
        cat_slug, cat_name = cats.get(
            t.category_id, ("uncategorized", "Uncategorized")
        ) if t.category_id else ("uncategorized", "Uncategorized")
        bucket = slug_to_bucket.get(cat_slug)

        if t.amount_cents < 0:
            grand_outflow += -t.amount_cents
        else:
            grand_inflow += t.amount_cents

        if bucket is None:
            # Only count OUTFLOWS toward untagged_total — counting inflows
            # too inflates the figure above grand_total_outflow_cents and
            # makes the panel look broken (e.g. "Untagged $64K of $56K").
            # We still count the transaction toward untagged_txn_count so
            # the "X txns to categorize" subtitle reflects total work.
            untagged_txn_count += 1
            if t.amount_cents < 0:
                untagged_total += -t.amount_cents
                untagged_by_cat[cat_name] += -t.amount_cents
            continue

        rollup = by_bucket.setdefault(
            bucket,
            BucketRollup(bucket=bucket, total_cents=0, txn_count=0, transactions=[]),
        )
        rollup.total_cents += abs(t.amount_cents)
        rollup.txn_count += 1
        rollup.transactions.append(
            {
                "date": t.posted_date.isoformat(),
                "description": t.description_raw or "",
                "amount_cents": t.amount_cents,
                "category": cat_name,
            }
        )

    untagged_top = sorted(
        untagged_by_cat.items(), key=lambda kv: kv[1], reverse=True
    )[:10]

    # Sort buckets by total descending so the biggest ones are first.
    bucket_list = sorted(
        by_bucket.values(), key=lambda b: b.total_cents, reverse=True
    )

    return AnnualTaxReport(
        year=year,
        by_bucket=bucket_list,
        untagged_total_cents=untagged_total,
        untagged_txn_count=untagged_txn_count,
        untagged_top_categories=untagged_top,
        grand_total_outflow_cents=grand_outflow,
        grand_total_inflow_cents=grand_inflow,
    )


def render_csv(report: AnnualTaxReport) -> str:
    """Render the report to a flat CSV string.

    Format: one row per transaction, with bucket attached. Suitable for
    import into spreadsheet apps or your CPA's intake template.
    """
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["date", "description", "amount_cents", "category", "tax_bucket"])
    for b in report.by_bucket:
        for t in b.transactions:
            writer.writerow(
                [
                    t["date"],
                    t["description"],
                    t["amount_cents"],
                    t["category"],
                    b.bucket,
                ]
            )
    # Followed by a trailer summary section so the CSV is self-describing.
    writer.writerow([])
    writer.writerow(["#summary", "year", report.year])
    writer.writerow(["#summary", "grand_total_outflow_cents", report.grand_total_outflow_cents])
    writer.writerow(["#summary", "grand_total_inflow_cents", report.grand_total_inflow_cents])
    writer.writerow(["#summary", "untagged_total_cents", report.untagged_total_cents])
    writer.writerow(["#summary", "untagged_txn_count", report.untagged_txn_count])
    for b in report.by_bucket:
        writer.writerow(["#bucket_total", b.bucket, b.total_cents, b.txn_count])
    return buf.getvalue()
