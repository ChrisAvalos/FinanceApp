"""Receipt OCR + line-item parsing pipeline.

Public entrypoints
------------------
``ocr_image(path)``  — OCR a receipt image to plain text. Falls back
                       cleanly when tesseract isn't installed.
``parse_receipt(text)`` — split OCR output into a structured
                       (merchant, date, line_items, totals) tuple.
``ingest(path, db)`` — upload-to-DB orchestrator: OCR + parse + persist.

The split exists so the pipeline can be partially used: a user can
paste an existing OCR'd text block (skipping the OCR step) and still
get structured line items via ``parse_receipt`` directly.
"""
from .ocr import OCR_AVAILABLE, ocr_image
from .parser import parse_receipt, ParsedReceipt, ParsedLineItem
from .coupon_parser import extract_coupons, ParsedCoupon
from .ingest import ingest_receipt, ingest_text, IngestResult

__all__ = [
    "OCR_AVAILABLE",
    "ocr_image",
    "parse_receipt",
    "ParsedReceipt",
    "ParsedLineItem",
    "extract_coupons",
    "ParsedCoupon",
    "ingest_receipt",
    "ingest_text",
    "IngestResult",
]
