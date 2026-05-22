"""OCR backend for receipts.

We use ``pytesseract`` (Python bindings to Tesseract) when it's
available. Tesseract is a separate native binary the user has to
install — on Windows that's a one-time:

    choco install tesseract

or download the installer from the project's GitHub.

If tesseract isn't installed (or the bindings are missing), the
module exposes ``OCR_AVAILABLE = False`` and ``ocr_image`` raises
``RuntimeError`` with an actionable error. The API layer catches
this and returns 501 Not Implemented with the install hint, so
the user sees a clean "install tesseract" message rather than a
500. They can also paste OCR'd text manually via the parse-only
endpoint.
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# Probe pytesseract at import time so the API knows whether to surface
# the upload UI or the manual-paste fallback. Re-probed on every call
# would be slow; this is fine because either pytesseract is installed
# at server-start or it's not.
try:
    import pytesseract  # type: ignore[import-not-found]
    from PIL import Image  # type: ignore[import-not-found]
    OCR_AVAILABLE = True
except ImportError:  # pytesseract or Pillow missing
    pytesseract = None  # type: ignore[assignment]
    Image = None  # type: ignore[assignment]
    OCR_AVAILABLE = False


# Tesseract config tuned for receipts:
#   --psm 4  → assume a single column of variable-sized text
#             (receipts ARE that — one column of left-aligned items)
#   --oem 1  → use the LSTM-only engine (better than legacy on
#             small low-contrast prints; default is "best of both"
#             which is slower for marginal gain)
# -c preserve_interword_spaces=1 keeps the column alignment usable
# for downstream parsing of "ITEM NAME ........ $9.99" rows.
_TESSERACT_CONFIG = (
    "--psm 4 --oem 1 -c preserve_interword_spaces=1"
)


def ocr_image(path: str | Path) -> str:
    """Run OCR on a receipt image. Returns the raw text.

    Raises ``RuntimeError`` if tesseract isn't available; raises
    ``FileNotFoundError`` if the path doesn't exist.
    """
    if not OCR_AVAILABLE:
        raise RuntimeError(
            "Tesseract OCR is not installed. Install it with "
            "`choco install tesseract` (Windows) or "
            "`brew install tesseract` (macOS), then "
            "`pip install pytesseract Pillow` in the backend venv. "
            "Alternatively, paste the receipt text manually via "
            "POST /api/receipts/parse-text."
        )
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(p)
    img = Image.open(p)
    # Auto-rotate based on EXIF — phone photos of receipts are very
    # commonly mis-oriented and tesseract handles upright text best.
    try:
        from PIL import ImageOps  # type: ignore[import-not-found]
        img = ImageOps.exif_transpose(img)
    except Exception:  # noqa: BLE001 — exif handling is best-effort
        pass
    text: str = pytesseract.image_to_string(img, config=_TESSERACT_CONFIG)
    return text
