"""Sidecar JSON store for scraped plan tiers.

We deliberately don't add a SQL table for these in the MVP — the
snapshot fits in a single JSON file under ``backend/.plan_snapshots/``
and the bundle detector loads it on demand. Promote to a real table
when we have multiple users or want history.

File layout::

    {
      "xfinity_mobile": {
        "provider": "xfinity_mobile",
        "plan_name": "Unlimited Plus",
        "perk_keys": ["peacock"],
        "raw_text": "...",
        "scraped_at": "2026-05-07T...",
        "source_url": "https://www.xfinity.com/..."
      },
      "verizon_wireless": {...}
    }

Keyed by ``provider``. One snapshot per provider — newer scrapes
overwrite older ones. The file is created lazily; missing file ==
"no scraped data yet" and the detector falls back to bill-amount
heuristics.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from .base import ScrapedPlanTier

logger = logging.getLogger(__name__)

SNAPSHOT_DIR = (
    Path(__file__).resolve().parent.parent.parent.parent / ".plan_snapshots"
)
SNAPSHOT_PATH = SNAPSHOT_DIR / "snapshots.json"


def _ensure_dir() -> None:
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)


def load_snapshots(path: Path | None = None) -> dict[str, ScrapedPlanTier]:
    """Read the sidecar file and return ``{provider: ScrapedPlanTier}``.

    Returns an empty dict if the file is missing or unreadable —
    swallowing read errors keeps the detector working when the sidecar
    hasn't been created yet (fresh checkouts, CI, no Playwright).
    """
    target = path or SNAPSHOT_PATH
    if not target.exists():
        return {}
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.exception("Failed to read plan snapshots from %s", target)
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, ScrapedPlanTier] = {}
    for provider, payload in raw.items():
        if not isinstance(payload, dict):
            continue
        try:
            out[provider] = ScrapedPlanTier.from_dict(payload)
        except (KeyError, TypeError, ValueError):
            logger.exception("Bad snapshot entry for provider=%s", provider)
    return out


def save_snapshot(tier: ScrapedPlanTier, path: Path | None = None) -> None:
    """Upsert one provider's snapshot. Atomic-ish: read-merge-write."""
    target = path or SNAPSHOT_PATH
    _ensure_dir()
    current: dict = {}
    if target.exists():
        try:
            current = json.loads(target.read_text(encoding="utf-8")) or {}
        except (OSError, json.JSONDecodeError):
            current = {}
    current[tier.provider] = tier.to_dict()
    # Write atomically via a temp file + rename so a partial write
    # never corrupts the sidecar.
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(json.dumps(current, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(target)


def snapshot_for(provider: str, path: Path | None = None) -> ScrapedPlanTier | None:
    """Convenience: get one provider's snapshot or None."""
    return load_snapshots(path).get(provider)
