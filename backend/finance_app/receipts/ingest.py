"""Orchestrator: image-or-text → DB rows.

Two entry points:

    ingest_receipt(image_path, db)      — full path: OCR + parse + persist
    ingest_text(text, db, image_path?)  — skip OCR; parse already-OCR'd text

Both return an ``IngestResult`` with the new Receipt id, item count,
and whatever warnings the parser bubbled up. Errors don't raise —
the receipt always lands in the DB so the user can see and edit it,
even if OCR failed entirely (status = ``failed``).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from finance_app.db.models import (
    Receipt,
    ReceiptCoupon,
    ReceiptCouponStatus,
    ReceiptItem,
    ReceiptStatus,
)

from .coupon_parser import extract_coupons
from .ocr import OCR_AVAILABLE, ocr_image
from .parser import ParsedReceipt, parse_receipt


@dataclass
class IngestResult:
    receipt_id: int
    status: ReceiptStatus
    items_added: int
    coupons_added: int
    warnings: list[str]


def _persist(
    db: Session,
    parsed: ParsedReceipt,
    *,
    image_path: str | None,
    status: ReceiptStatus,
) -> tuple[Receipt, int]:
    """Persist receipt + items + coupons. Returns (row, coupons_added)."""
    row = Receipt(
        image_path=image_path,
        merchant=parsed.merchant,
        purchase_date=parsed.purchase_date,
        subtotal_cents=parsed.subtotal_cents,
        tax_cents=parsed.tax_cents,
        total_cents=parsed.total_cents,
        raw_text=parsed.raw_text,
        status=status,
    )
    db.add(row)
    db.flush()  # populate row.id so we can attach items
    for item in parsed.items:
        db.add(
            ReceiptItem(
                receipt_id=row.id,
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
    # Slice C — extract coupons from the same OCR text and persist as
    # ReceiptCoupon rows. The Money-on-the-Table aggregator picks them
    # up automatically via _from_receipt_coupons.
    coupons_added = 0
    if parsed.raw_text:
        for coupon in extract_coupons(parsed.raw_text):
            db.add(
                ReceiptCoupon(
                    receipt_id=row.id,
                    title=coupon.title,
                    code=coupon.code,
                    redemption_url=coupon.redemption_url,
                    estimated_value_cents=coupon.estimated_value_cents,
                    expires_at=coupon.expires_at,
                    merchant=parsed.merchant,
                    raw_text=coupon.raw_text,
                    status=ReceiptCouponStatus.available,
                )
            )
            coupons_added += 1
    db.commit()
    db.refresh(row)
    return row, coupons_added


def ingest_receipt(image_path: str | Path, db: Session) -> IngestResult:
    """OCR + parse + persist. Always commits a row, even on OCR failure.

    The on-failure path stores the receipt with status=``failed`` and
    no items so the user can paste OCR text manually via the
    ``/receipts/{id}/parse-text`` endpoint.
    """
    warnings: list[str] = []
    text = ""
    status = ReceiptStatus.parsed
    if not OCR_AVAILABLE:
        warnings.append(
            "OCR is not available — install tesseract + pytesseract. "
            "Receipt saved as 'failed'; paste text manually to populate items."
        )
        status = ReceiptStatus.failed
    else:
        try:
            text = ocr_image(image_path)
        except FileNotFoundError:
            raise
        except Exception as e:  # noqa: BLE001
            warnings.append(f"OCR failed: {type(e).__name__}: {e}")
            status = ReceiptStatus.failed
    parsed = parse_receipt(text) if text else ParsedReceipt(raw_text="")
    if not parsed.items and status == ReceiptStatus.parsed:
        # OCR ran but produced no parseable items — fall back to failed
        # so the UI nudges the user to retry / paste text.
        status = ReceiptStatus.failed
        warnings.append("OCR text didn't yield any line items.")
    row, coupons_added = _persist(db, parsed, image_path=str(image_path), status=status)
    return IngestResult(
        receipt_id=row.id,
        status=row.status,
        items_added=len(parsed.items),
        coupons_added=coupons_added,
        warnings=warnings,
    )


def ingest_text(
    text: str, db: Session, *, image_path: str | None = None
) -> IngestResult:
    """Parse-only path: caller already has the receipt text.

    Useful when (a) tesseract isn't installed and the user pastes the
    OCR output from another tool, or (b) a future email-parser pulls
    receipt text directly from order-confirmation emails.
    """
    warnings: list[str] = []
    parsed = parse_receipt(text)
    status = ReceiptStatus.manual
    if not parsed.items:
        warnings.append(
            "No line items detected. Receipt saved with raw text — "
            "you can hand-edit items in the UI."
        )
    row, coupons_added = _persist(db, parsed, image_path=image_path, status=status)
    return IngestResult(
        receipt_id=row.id,
        status=row.status,
        items_added=len(parsed.items),
        coupons_added=coupons_added,
        warnings=warnings,
    )
