"""Tax-time export API — Phase 7.4.

GET /tax/report?year=YYYY            structured JSON report
GET /tax/export.csv?year=YYYY        CSV download (one row per txn + summary trailer)
GET /tax/buckets                     the bucket → slug map (for UI to render)
"""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from finance_app.db.session import get_db
from finance_app.tax import (
    TAX_BUCKETS,
    build_annual_tax_report,
    render_csv,
)

router = APIRouter(prefix="/tax", tags=["tax"])


class BucketRollupOut(BaseModel):
    bucket: str
    total_cents: int
    txn_count: int


class TaxReportOut(BaseModel):
    year: int
    by_bucket: list[BucketRollupOut]
    untagged_total_cents: int
    untagged_txn_count: int
    untagged_top_categories: list[tuple[str, int]]
    grand_total_outflow_cents: int
    grand_total_inflow_cents: int
    # Server-side roll-up timestamp — drives the SyncFreshnessChip on the
    # Tax Export panel.
    generated_at: datetime | None = None


@router.get("/buckets")
def list_buckets() -> dict:
    """Return the bucket → category-slug map. Read-only."""
    return {"buckets": TAX_BUCKETS}


@router.get("/report", response_model=TaxReportOut)
def get_report(
    year: int = Query(..., ge=2000, le=2100),
    db: Session = Depends(get_db),
) -> TaxReportOut:
    """Annual roll-up. Excludes per-transaction detail to keep the
    payload small; use the CSV export for that."""
    report = build_annual_tax_report(db, year=year)
    return TaxReportOut(
        year=report.year,
        by_bucket=[
            BucketRollupOut(
                bucket=b.bucket,
                total_cents=b.total_cents,
                txn_count=b.txn_count,
            )
            for b in report.by_bucket
        ],
        untagged_total_cents=report.untagged_total_cents,
        untagged_txn_count=report.untagged_txn_count,
        untagged_top_categories=report.untagged_top_categories,
        grand_total_outflow_cents=report.grand_total_outflow_cents,
        grand_total_inflow_cents=report.grand_total_inflow_cents,
        generated_at=datetime.utcnow(),
    )


@router.get("/export.csv", response_class=PlainTextResponse)
def export_csv(
    year: int = Query(..., ge=2000, le=2100),
    db: Session = Depends(get_db),
) -> PlainTextResponse:
    """Flat CSV: one row per transaction, with tax bucket attached.

    Set this URL up as a curl/wget target if you want to schedule the
    export from cron — no auth wrapping yet, so it's just a GET.
    """
    report = build_annual_tax_report(db, year=year)
    csv_text = render_csv(report)
    return PlainTextResponse(
        content=csv_text,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="tax-export-{year}.csv"'
        },
    )
