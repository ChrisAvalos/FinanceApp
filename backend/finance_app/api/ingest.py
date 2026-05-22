"""Ingest endpoints — upload a CSV/OFX file, route to the right importer."""
from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy.orm import Session

from finance_app.api.schemas import IngestCsvResponse
from finance_app.categorization.engine import CategorizationEngine
from finance_app.db.models import Account
from finance_app.db.session import get_db
from finance_app.ingestion.csv_importer import IMPORTER_REGISTRY, get_importer
from finance_app.ingestion.ofx_importer import OfxImporter

router = APIRouter(tags=["ingest"])


@router.get("/ingest/formats")
def list_formats() -> dict[str, list[str]]:
    """Let the frontend discover what importer slugs are available."""
    return {"csv": sorted(IMPORTER_REGISTRY.keys()), "ofx": ["ofx", "qfx"]}


@router.post("/ingest/csv", response_model=IngestCsvResponse)
def ingest_csv(
    account_id: int = Form(...),
    format_slug: str = Form("generic"),
    auto_categorize: bool = Form(True),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> IngestCsvResponse:
    acct = db.get(Account, account_id)
    if not acct:
        raise HTTPException(404, f"Account {account_id} not found")
    try:
        ImporterCls = get_importer(format_slug)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    # Stream the upload to a tempfile so the importer can open it by path.
    with tempfile.NamedTemporaryFile(delete=False, suffix=".csv") as tmp:
        tmp.write(file.file.read())
        tmp_path = tmp.name

    try:
        importer = ImporterCls(db, acct)
        batch = importer.run(tmp_path)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    if auto_categorize and batch.rows_created > 0:
        CategorizationEngine(db).categorize_all(only_unset=True)

    return IngestCsvResponse(
        batch_id=batch.id,
        rows_parsed=batch.rows_parsed,
        rows_created=batch.rows_created,
        rows_duplicate=batch.rows_duplicate,
        errors=batch.errors,
    )


@router.post("/ingest/ofx", response_model=IngestCsvResponse)
def ingest_ofx(
    account_id: int = Form(...),
    auto_categorize: bool = Form(True),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> IngestCsvResponse:
    acct = db.get(Account, account_id)
    if not acct:
        raise HTTPException(404, f"Account {account_id} not found")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".ofx") as tmp:
        tmp.write(file.file.read())
        tmp_path = tmp.name

    try:
        importer = OfxImporter(db, acct)
        batch = importer.run(tmp_path)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    if auto_categorize and batch.rows_created > 0:
        CategorizationEngine(db).categorize_all(only_unset=True)

    return IngestCsvResponse(
        batch_id=batch.id,
        rows_parsed=batch.rows_parsed,
        rows_created=batch.rows_created,
        rows_duplicate=batch.rows_duplicate,
        errors=batch.errors,
    )
