"""Receipts API — Phase 10 Slice A.

Endpoints
---------
GET    /receipts              list (newest first)
GET    /receipts/{id}         detail with line items
POST   /receipts/upload       multipart image upload → OCR + parse + persist
POST   /receipts/parse-text   paste OCR'd text directly (no image)
PATCH  /receipts/{id}         edit merchant / date / totals
PATCH  /receipts/items/{id}   edit a single line item
DELETE /receipts/items/{id}   delete a line item
DELETE /receipts/{id}         delete a receipt + its items (cascade)
GET    /receipts/ocr-status   probe whether tesseract is available

Storage
-------
Image files land in ``settings.receipts_upload_dir`` (defaults to
``backend/uploads/receipts``). The DB stores the relative path; the
binary stays on disk.
"""
from __future__ import annotations

import logging
import secrets
import shutil
from datetime import date, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.config import settings
from finance_app.db.models import (
    Receipt,
    ReceiptCoupon,
    ReceiptCouponStatus,
    ReceiptItem,
    ReceiptStatus,
)
from finance_app.db.session import get_db
from finance_app.receipts import (
    OCR_AVAILABLE,
    ingest_receipt,
    ingest_text,
)
# Sprint 49 — vision-model OCR fallback. Imported lazily inside the
# endpoint (not at module load) so the receipts module doesn't pay
# the llm-import cost on every cold start.

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/receipts", tags=["receipts"])


# ---------- Pydantic ----------


class ReceiptItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    receipt_id: int
    raw_line: str
    name: str | None
    brand: str | None
    quantity_units: int
    unit_label: str | None
    unit_price_cents: int | None
    line_total_cents: int | None
    discount_cents: int | None
    sku: str | None
    canonical_key: str | None
    item_category: str | None


class ReceiptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    image_path: str | None
    merchant: str | None
    purchase_date: date | None
    subtotal_cents: int | None
    tax_cents: int | None
    total_cents: int | None
    status: ReceiptStatus
    transaction_id: int | None
    notes: str | None
    created_at: datetime
    updated_at: datetime


class ReceiptCouponOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    receipt_id: int
    title: str
    code: str | None
    redemption_url: str | None
    estimated_value_cents: int | None
    merchant: str | None
    expires_at: date | None
    status: ReceiptCouponStatus
    raw_text: str | None
    notes: str | None
    created_at: datetime
    used_at: datetime | None


class ReceiptDetailOut(ReceiptOut):
    raw_text: str | None
    items: list[ReceiptItemOut]
    coupons: list[ReceiptCouponOut]


class ReceiptCouponPatch(BaseModel):
    status: ReceiptCouponStatus | None = None
    title: str | None = None
    code: str | None = None
    redemption_url: str | None = None
    estimated_value_cents: int | None = None
    expires_at: date | None = None
    notes: str | None = None


class ReceiptPatch(BaseModel):
    merchant: str | None = None
    purchase_date: date | None = None
    subtotal_cents: int | None = None
    tax_cents: int | None = None
    total_cents: int | None = None
    notes: str | None = None
    transaction_id: int | None = None


class ReceiptItemPatch(BaseModel):
    name: str | None = None
    brand: str | None = None
    quantity_units: int | None = None
    unit_label: str | None = None
    unit_price_cents: int | None = None
    line_total_cents: int | None = None
    discount_cents: int | None = None
    sku: str | None = None
    canonical_key: str | None = None
    item_category: str | None = None


class ParseTextIn(BaseModel):
    """Body for the manual paste endpoint."""
    text: str


class IngestOut(BaseModel):
    receipt_id: int
    status: ReceiptStatus
    items_added: int
    coupons_added: int = 0
    warnings: list[str]


class OcrStatusOut(BaseModel):
    """Probe so the UI can show install hint when tesseract missing."""
    available: bool
    install_hint: str | None


# Sprint 49 — vision-OCR status probe. Separate from tesseract because
# the two install paths are independent (one Python pkg + native bin
# for tesseract; an Ollama model pull for the vision LLM). UI uses
# both flags to drive separate install hints.
class VisionOcrStatusOut(BaseModel):
    ollama_running: bool        # is the Ollama server reachable
    vision_model_pulled: bool   # is the configured vision model installed
    model_name: str             # name of the vision model (for the hint)
    install_hint: str | None    # one-line CTA for the UI; null when ready


# ---------- Helpers ----------


def _uploads_dir() -> Path:
    """Resolve the receipts upload dir, creating if missing.

    Configurable via settings.receipts_upload_dir; defaults to
    ``<backend>/uploads/receipts``. Always relative-safe.
    """
    base = getattr(settings, "receipts_upload_dir", None) or "uploads/receipts"
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p


def _safe_filename(original: str) -> str:
    """Generate a non-clobbering filename. Preserve the extension."""
    suffix = Path(original).suffix.lower()
    # Whitelist common image + PDF extensions; default to .bin if weird.
    if suffix not in (".jpg", ".jpeg", ".png", ".webp", ".heic", ".pdf"):
        suffix = ".bin"
    token = secrets.token_hex(12)
    today = date.today().isoformat()
    return f"{today}_{token}{suffix}"


# ---------- Endpoints ----------


@router.get("/ocr-status", response_model=OcrStatusOut)
def ocr_status() -> OcrStatusOut:
    return OcrStatusOut(
        available=OCR_AVAILABLE,
        install_hint=None if OCR_AVAILABLE else (
            "Install Tesseract: `choco install tesseract` (Windows) or "
            "`brew install tesseract` (macOS), then `pip install pytesseract Pillow` "
            "in the backend venv. Or paste OCR'd text via POST /receipts/parse-text."
        ),
    )


@router.get("/vision-ocr-status", response_model=VisionOcrStatusOut)
def vision_ocr_status() -> VisionOcrStatusOut:
    """Sprint 49 — probe whether vision-model OCR is ready.

    Drives the Receipts panel's "Re-OCR with AI vision" button — when
    Ollama isn't running or the vision model isn't pulled, we render
    the button disabled with an install hint instead of letting the
    user click and wait through a 90s timeout.

    Registered before /{rid} so the literal path doesn't get caught by
    the int-typed receipt-detail route.
    """
    from finance_app.llm import get_client as _get_ollama
    model_name = settings.ollama_vision_model
    try:
        client = _get_ollama()
        running = client.is_available()
        pulled = client.is_vision_model_available(model_name) if running else False
    except Exception:  # noqa: BLE001 — config errors shouldn't 500 the status probe
        running = False
        pulled = False
    if running and pulled:
        hint = None
    elif not running:
        hint = (
            "Ollama isn't running. Install + start it from ollama.com, then "
            f"`ollama pull {model_name}`."
        )
    else:
        hint = f"Pull the vision model: `ollama pull {model_name}`"
    return VisionOcrStatusOut(
        ollama_running=running,
        vision_model_pulled=pulled,
        model_name=model_name,
        install_hint=hint,
    )


@router.get("", response_model=list[ReceiptOut])
def list_receipts(
    limit: int = 100,
    db: Session = Depends(get_db),
) -> list[Receipt]:
    return list(
        db.execute(
            select(Receipt).order_by(Receipt.created_at.desc()).limit(limit)
        ).scalars().all()
    )


@router.get("/{rid}", response_model=ReceiptDetailOut)
def get_receipt(rid: int, db: Session = Depends(get_db)) -> ReceiptDetailOut:
    r = db.get(Receipt, rid)
    if r is None:
        raise HTTPException(404, f"Receipt {rid} not found")
    # Coupons aren't a relationship on Receipt (kept the model decoupled
    # so the Money-on-the-Table aggregator can query the table without a
    # join). Pull them here as a separate query.
    coupons = list(
        db.execute(
            select(ReceiptCoupon)
            .where(ReceiptCoupon.receipt_id == rid)
            .order_by(ReceiptCoupon.created_at.desc())
        ).scalars().all()
    )
    return ReceiptDetailOut(
        id=r.id,
        image_path=r.image_path,
        merchant=r.merchant,
        purchase_date=r.purchase_date,
        subtotal_cents=r.subtotal_cents,
        tax_cents=r.tax_cents,
        total_cents=r.total_cents,
        status=r.status,
        transaction_id=r.transaction_id,
        notes=r.notes,
        created_at=r.created_at,
        updated_at=r.updated_at,
        raw_text=r.raw_text,
        items=[ReceiptItemOut.model_validate(it) for it in r.items],
        coupons=[ReceiptCouponOut.model_validate(c) for c in coupons],
    )


@router.post("/upload", response_model=IngestOut, status_code=201)
async def upload_receipt(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> IngestOut:
    """Upload a receipt image. Body is multipart with field name `file`."""
    if not file.filename:
        raise HTTPException(400, "No filename provided.")
    target_dir = _uploads_dir()
    target_name = _safe_filename(file.filename)
    target_path = target_dir / target_name

    with target_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    try:
        result = ingest_receipt(target_path, db)
    except Exception as e:  # noqa: BLE001 — surface in response
        logger.exception("Receipt ingest blew up: %r", e)
        raise HTTPException(500, f"Receipt ingest failed: {e}")
    return IngestOut(
        receipt_id=result.receipt_id,
        status=result.status,
        items_added=result.items_added,
        coupons_added=result.coupons_added,
        warnings=result.warnings,
    )


@router.post("/parse-text", response_model=IngestOut, status_code=201)
def parse_text(body: ParseTextIn, db: Session = Depends(get_db)) -> IngestOut:
    """Skip OCR — paste already-OCR'd text. Useful when tesseract isn't
    installed locally or the user has a copy/paste-friendly source."""
    if not body.text or not body.text.strip():
        raise HTTPException(400, "text is required and cannot be blank.")
    result = ingest_text(body.text, db)
    return IngestOut(
        receipt_id=result.receipt_id,
        status=result.status,
        items_added=result.items_added,
        coupons_added=result.coupons_added,
        warnings=result.warnings,
    )


@router.post("/{rid}/ocr-vision", response_model=IngestOut)
def ocr_vision_reparse(rid: int, db: Session = Depends(get_db)) -> IngestOut:
    """Sprint 49 — re-OCR an existing receipt using the Ollama vision
    model. Returns the same shape as /reparse but updates the receipt
    in place instead of creating a new row, because vision-OCR is the
    user-intended fix path ("the photo was crumpled, try again with the
    smarter model") — they want the same receipt to get better, not a
    new one to merge.

    Side effects: replaces the receipt's merchant / date / totals /
    raw_text and DELETES existing line items + coupons, then re-inserts
    fresh ones from the vision extraction. Hand-edits to line items on
    this receipt will be lost — same warning the /reparse endpoint
    surfaces, except here we're explicit about it because we're
    mutating the original row.
    """
    # Lazy imports — keeps module load cheap and isolates the LLM
    # dependency tree from the rest of the receipts API.
    from finance_app.llm.client import OllamaUnavailable
    from finance_app.receipts.ocr_vision import (
        VisionOcrFailed,
        vision_extract_receipt,
    )
    r = db.get(Receipt, rid)
    if r is None:
        raise HTTPException(404, f"Receipt {rid} not found")
    if not r.image_path:
        raise HTTPException(
            400, f"Receipt {rid} has no stored image; nothing to vision-OCR."
        )
    p = Path(r.image_path)
    if not p.exists():
        raise HTTPException(
            410, f"Stored image at {r.image_path} no longer exists on disk."
        )
    try:
        parsed = vision_extract_receipt(p)
    except OllamaUnavailable as exc:
        # 503 — server-side dependency unavailable. Same shape we use
        # for Plaid / Gmail dependency outages so the frontend's
        # generic "service unavailable" banner picks it up.
        raise HTTPException(
            503,
            f"Ollama vision is unavailable: {exc}. "
            f"Try `ollama pull {settings.ollama_vision_model}` and confirm Ollama is running.",
        ) from exc
    except VisionOcrFailed as exc:
        # 422 — server reached the model but it choked on this image.
        # User-actionable: usually means image is too blurry / glare /
        # cropped. Suggest re-shooting the photo.
        raise HTTPException(
            422,
            f"Vision OCR couldn't read this receipt: {exc}. "
            "Try a better-lit, less-rotated photo, or paste the text manually.",
        ) from exc
    # In-place replace: wipe items + coupons, repopulate from vision
    # output. We don't drop the Receipt row itself so any user-set
    # transaction_id linkage and notes survive.
    warnings: list[str] = []
    for it in list(r.items):
        db.delete(it)
    # Coupons are a separate relationship — coupon extraction needs
    # raw OCR text, which vision JSON doesn't surface, so we just
    # remove stale coupons rather than try to reproduce them.
    db.execute(
        ReceiptCoupon.__table__.delete().where(ReceiptCoupon.receipt_id == r.id)
    )
    r.merchant = parsed.merchant or r.merchant
    r.purchase_date = parsed.purchase_date or r.purchase_date
    r.subtotal_cents = parsed.subtotal_cents if parsed.subtotal_cents is not None else r.subtotal_cents
    r.tax_cents = parsed.tax_cents if parsed.tax_cents is not None else r.tax_cents
    r.total_cents = parsed.total_cents if parsed.total_cents is not None else r.total_cents
    r.raw_text = parsed.raw_text or r.raw_text
    items_added = 0
    for item in parsed.items:
        db.add(
            ReceiptItem(
                receipt_id=r.id,
                raw_line=item.raw_line[:500],
                name=item.name,
                quantity_units=item.quantity_units,
                unit_label=item.unit_label,
                unit_price_cents=item.unit_price_cents,
                line_total_cents=item.line_total_cents,
                discount_cents=item.discount_cents,
                sku=item.sku,
                item_category=item.item_category,
            )
        )
        items_added += 1
    if items_added == 0:
        warnings.append(
            "Vision model returned 0 line items — the receipt may be "
            "too blurry or cropped. Existing items were still cleared."
        )
        r.status = ReceiptStatus.failed
    else:
        r.status = ReceiptStatus.parsed
    db.commit()
    db.refresh(r)
    return IngestOut(
        receipt_id=r.id,
        status=r.status,
        items_added=items_added,
        coupons_added=0,
        warnings=warnings,
    )


@router.post("/{rid}/reparse", response_model=IngestOut)
def reparse(rid: int, db: Session = Depends(get_db)) -> IngestOut:
    """Re-run OCR + parse on a previously uploaded receipt's image.

    Useful after improving the parser heuristics — re-runs against the
    same stored image without forcing a new upload. Replaces existing
    line items with the new parse.
    """
    r = db.get(Receipt, rid)
    if r is None:
        raise HTTPException(404, f"Receipt {rid} not found")
    if not r.image_path:
        raise HTTPException(
            400, f"Receipt {rid} has no stored image; nothing to re-parse."
        )
    p = Path(r.image_path)
    if not p.exists():
        raise HTTPException(
            410, f"Stored image at {r.image_path} no longer exists on disk."
        )
    # Wipe existing items + run a fresh ingest into a NEW row.
    # The user can then merge the two rows manually if they want; we
    # don't auto-delete the old one to preserve their hand-edits.
    result = ingest_receipt(p, db)
    return IngestOut(
        receipt_id=result.receipt_id,
        status=result.status,
        items_added=result.items_added,
        coupons_added=result.coupons_added,
        warnings=[*result.warnings, f"Original receipt id={rid} preserved."],
    )


# Coupon endpoints — Slice C. Mounted before /{rid} so the literal
# /coupons path doesn't get caught by the integer route.
@router.get("/coupons", response_model=list[ReceiptCouponOut])
def list_coupons(
    status: ReceiptCouponStatus | None = None,
    limit: int = 200,
    db: Session = Depends(get_db),
) -> list[ReceiptCoupon]:
    """All coupons across all receipts. Filter by status."""
    stmt = select(ReceiptCoupon).order_by(ReceiptCoupon.created_at.desc()).limit(limit)
    if status is not None:
        stmt = stmt.where(ReceiptCoupon.status == status)
    return list(db.execute(stmt).scalars().all())


@router.patch("/coupons/{cid}", response_model=ReceiptCouponOut)
def patch_coupon(
    cid: int, body: ReceiptCouponPatch, db: Session = Depends(get_db)
) -> ReceiptCoupon:
    c = db.get(ReceiptCoupon, cid)
    if c is None:
        raise HTTPException(404, f"ReceiptCoupon {cid} not found")
    patch = body.model_dump(exclude_unset=True)
    new_status = patch.get("status")
    for k, v in patch.items():
        setattr(c, k, v)
    # Stamp used_at on transition to "used"
    if new_status == ReceiptCouponStatus.used and c.used_at is None:
        c.used_at = datetime.utcnow()
    db.commit()
    db.refresh(c)
    return c


@router.delete("/coupons/{cid}", status_code=204)
def delete_coupon(cid: int, db: Session = Depends(get_db)) -> None:
    c = db.get(ReceiptCoupon, cid)
    if c is None:
        raise HTTPException(404, f"ReceiptCoupon {cid} not found")
    db.delete(c)
    db.commit()


@router.patch("/{rid}", response_model=ReceiptOut)
def patch_receipt(
    rid: int, body: ReceiptPatch, db: Session = Depends(get_db)
) -> Receipt:
    r = db.get(Receipt, rid)
    if r is None:
        raise HTTPException(404, f"Receipt {rid} not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(r, k, v)
    db.commit()
    db.refresh(r)
    return r


@router.patch("/items/{iid}", response_model=ReceiptItemOut)
def patch_item(
    iid: int, body: ReceiptItemPatch, db: Session = Depends(get_db)
) -> ReceiptItem:
    it = db.get(ReceiptItem, iid)
    if it is None:
        raise HTTPException(404, f"ReceiptItem {iid} not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(it, k, v)
    db.commit()
    db.refresh(it)
    return it


@router.delete("/items/{iid}", status_code=204)
def delete_item(iid: int, db: Session = Depends(get_db)) -> None:
    it = db.get(ReceiptItem, iid)
    if it is None:
        raise HTTPException(404, f"ReceiptItem {iid} not found")
    db.delete(it)
    db.commit()


@router.delete("/{rid}", status_code=204)
def delete_receipt(rid: int, db: Session = Depends(get_db)) -> None:
    r = db.get(Receipt, rid)
    if r is None:
        raise HTTPException(404, f"Receipt {rid} not found")
    # Best-effort: also remove the image from disk if present.
    if r.image_path:
        try:
            Path(r.image_path).unlink(missing_ok=True)
        except OSError:
            pass  # don't block deletion on FS errors
    db.delete(r)
    db.commit()


# Reference unused imports so linters stay quiet on the Form usage path.
_ = Form
