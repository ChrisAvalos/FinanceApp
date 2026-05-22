"""Interactive backup-restore CLI.

Usage::

    python -m finance_app.jobs.backup_restore           # list available backups
    python -m finance_app.jobs.backup_restore <path>    # restore from a specific snapshot

"Restore" = stop uvicorn first, copy the snapshot over the live DB.
This script does NOT stop uvicorn for you — it'll refuse to overwrite
the live DB if its mtime is fresher than 30 seconds (proxy for "the
server is probably writing to it"). Stop the server, retry.
"""
from __future__ import annotations

import shutil
import sys
import time
from pathlib import Path

from ..config import settings
from .backup import _backup_dir, _live_db_path


def _list_backups(out: Path) -> list[Path]:
    return sorted(out.glob("finance-*.db"), key=lambda p: p.name, reverse=True)


def main() -> None:
    out = _backup_dir()
    live = _live_db_path()
    backups = _list_backups(out)

    if len(sys.argv) == 1:
        print(f"Backups in {out}:")
        if not backups:
            print("  (none)")
            return
        for p in backups:
            size_kb = p.stat().st_size // 1024
            print(f"  {p.name}  ({size_kb:,} KB, mtime {time.ctime(p.stat().st_mtime)})")
        print(f"\nLive DB: {live}")
        print(
            f"\nRestore with: python -m finance_app.jobs.backup_restore {backups[0]}"
        )
        return

    target_arg = sys.argv[1]
    target = Path(target_arg).resolve()
    if not target.exists():
        print(f"ERROR: backup not found: {target}", file=sys.stderr)
        sys.exit(1)

    if live.exists():
        live_age = time.time() - live.stat().st_mtime
        if live_age < 30:
            print(
                f"ERROR: Live DB was modified {live_age:.1f}s ago — uvicorn likely "
                f"still running. Stop it first, then re-run.",
                file=sys.stderr,
            )
            sys.exit(2)
        # Save the current live as a "pre-restore" backup before clobbering.
        pre = out / f"finance-pre-restore-{int(time.time())}.db"
        shutil.copy2(live, pre)
        print(f"Saved current live DB as {pre.name} before restore.")

    shutil.copy2(target, live)
    # Also copy WAL/SHM files if present in the backup, so the restore
    # is internally consistent.
    for suffix in ("-wal", "-shm"):
        sidecar = target.with_name(target.name + suffix)
        if sidecar.exists():
            shutil.copy2(sidecar, live.with_name(live.name + suffix))
    print(f"Restored {target.name} → {live}")
    print("Start uvicorn to resume.")


if __name__ == "__main__":
    main()
