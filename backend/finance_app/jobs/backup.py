"""Weekly automatic SQLite backup.

What it does
------------
1. Snapshot the live ``finance.db`` to ``<backup_dir>/finance-YYYYMMDD-HHMM.db``.
2. Use SQLite's online ``.backup`` API rather than a flat ``copy`` —
   that way the snapshot is a consistent point-in-time even if writes
   are happening mid-job.
3. Prune any backup older than ``backup_retention_days``.

Restore
-------
There's no automatic restore from the daemon — that's a "you" decision.
A standalone CLI ``python -m finance_app.jobs.backup_restore`` lives
in the same package and walks you through it interactively.
"""
from __future__ import annotations

import logging
import os
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

from ..config import settings

logger = logging.getLogger(__name__)


def _live_db_path() -> Path:
    """Where the live finance.db lives, derived from DATABASE_URL."""
    parsed = urlparse(settings.database_url)
    if not parsed.scheme.startswith("sqlite"):
        raise RuntimeError(
            f"Backup job only supports sqlite databases. DATABASE_URL={settings.database_url}"
        )
    # sqlite:///./finance.db → "/./finance.db" on Linux, parsed.path gives "/./finance.db"
    raw = parsed.path or parsed.netloc
    if raw.startswith("/./"):
        raw = raw[1:]
    return Path(raw).resolve()


def _backup_dir() -> Path:
    """Resolved backup output directory, created if missing."""
    out = Path(settings.backup_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    return out


def _snapshot(src: Path, dst: Path) -> None:
    """Use SQLite's online backup API for a consistent point-in-time copy.

    This works even while the live DB is being written by uvicorn —
    SQLite handles the journal coordination internally. Faster + safer
    than a filesystem copy for a WAL-mode database.
    """
    src_conn = sqlite3.connect(str(src))
    try:
        dst_conn = sqlite3.connect(str(dst))
        try:
            src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
    finally:
        src_conn.close()


def _prune_old(out: Path, retention_days: int) -> int:
    """Delete backups older than ``retention_days``. Returns count pruned."""
    cutoff = datetime.utcnow() - timedelta(days=retention_days)
    n = 0
    for p in out.glob("finance-*.db"):
        try:
            mtime = datetime.utcfromtimestamp(p.stat().st_mtime)
        except OSError:
            continue
        if mtime < cutoff:
            try:
                p.unlink()
                n += 1
                logger.info("backup pruned %s (mtime=%s)", p.name, mtime.isoformat())
            except OSError as e:
                logger.warning("backup prune failed for %s: %r", p.name, e)
    return n


def run_backup() -> dict:
    """Take one snapshot and prune old ones. Returns a summary dict."""
    started = datetime.utcnow()
    src = _live_db_path()
    if not src.exists():
        logger.warning("backup skipped — source DB missing: %s", src)
        return {"snapshotted": False, "reason": "source DB missing", "pruned": 0}

    out = _backup_dir()
    suffix = started.strftime("%Y%m%d-%H%M")
    dst = out / f"finance-{suffix}.db"
    try:
        _snapshot(src, dst)
        size = dst.stat().st_size
    except Exception as e:  # noqa: BLE001
        logger.exception("backup snapshot failed")
        # Clean up any partial file
        if dst.exists():
            try:
                dst.unlink()
            except OSError:
                pass
        return {"snapshotted": False, "error": repr(e), "pruned": 0}

    pruned = _prune_old(out, settings.backup_retention_days)
    logger.info(
        "backup snapshot %s (%d bytes); pruned %d older backups",
        dst.name,
        size,
        pruned,
    )
    return {
        "snapshotted": True,
        "path": str(dst),
        "size_bytes": size,
        "pruned": pruned,
        "started_at": started.isoformat() + "Z",
    }
