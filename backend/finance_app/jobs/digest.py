"""Daily digest renderer — writes the weekly digest text to a dated file.

We don't ship an SMTP-sender by default because Chris doesn't have
mail credentials wired in. Instead we render to disk and let the user
choose how to surface it: dashboard tile, cron-mailed, piped into an
external script, etc.

Output format
-------------
One file per day under ``<daily_digest_output_dir>/digest-YYYYMMDD.txt``.
Format is plain text — easy to ``cat`` or pipe.
"""
from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

from ..config import settings
from ..db.session import SessionLocal
from ..insights import build_weekly_digest, render_digest

logger = logging.getLogger(__name__)


def _output_dir() -> Path:
    out = Path(settings.daily_digest_output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    return out


def write_daily_digest() -> dict:
    """Build today's digest and write it to disk. Returns a summary dict."""
    started = datetime.utcnow()
    db = SessionLocal()
    try:
        digest = build_weekly_digest(db)
        text = render_digest(digest)
    except Exception as e:  # noqa: BLE001
        logger.exception("daily-digest render failed")
        return {"written": False, "error": repr(e)}
    finally:
        db.close()

    out = _output_dir()
    fname = f"digest-{datetime.utcnow().strftime('%Y%m%d')}.txt"
    target = out / fname
    header = (
        f"Finance App daily digest\n"
        f"Generated: {started.isoformat()}Z\n"
        f"Window: {digest.week_start.isoformat()} → {digest.week_end.isoformat()}\n"
        f"{'=' * 50}\n\n"
    )
    try:
        target.write_text(header + text + "\n")
    except OSError as e:
        logger.exception("daily-digest write failed for %s", target)
        return {"written": False, "error": repr(e)}

    logger.info("daily-digest wrote %s (%d chars)", target.name, len(text))
    return {
        "written": True,
        "path": str(target),
        "chars": len(text),
        "window_start": digest.week_start.isoformat(),
        "window_end": digest.week_end.isoformat(),
    }
