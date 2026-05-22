"""Plan-tier scrapers — Wave E-6.

Pulls the user's *actual* plan tier from the carrier's portal so the
bundle detector can stop guessing from bill-amount ranges and start
working from real data ("Xfinity Mobile Unlimited Plus" → "includes
Peacock Premium" with confidence 0.95).

Site keys parallel offers/credit_scores: ``"xfinity"`` lives here.
Persistence is a simple sidecar JSON at
``backend/.plan_snapshots/snapshots.json`` — no DB migration needed for
the MVP. The detector loads the sidecar; absent or stale, it falls back
to the bill-amount heuristic from bundles.yaml.
"""
from __future__ import annotations

from .base import (
    AUTH_STATE_DIR,
    AuthStateMissing,
    PlanTierScraperBase,
    ScrapedPlanTier,
    auth_state_path,
)
from .snapshots import (
    SNAPSHOT_PATH,
    load_snapshots,
    save_snapshot,
    snapshot_for,
)
from .xfinity import XfinityPlanTierScraper, parse_xfinity_html
from .coordinator import RunAllResult, SiteRunResult, run_all

__all__ = [
    "AUTH_STATE_DIR",
    "AuthStateMissing",
    "PlanTierScraperBase",
    "ScrapedPlanTier",
    "auth_state_path",
    "load_snapshots",
    "save_snapshot",
    "snapshot_for",
    "SNAPSHOT_PATH",
    "XfinityPlanTierScraper",
    "parse_xfinity_html",
    "run_all",
    "RunAllResult",
    "SiteRunResult",
]
