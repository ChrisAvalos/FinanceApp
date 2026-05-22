"""Orchestrates plan-tier scrapes across all registered sites.

Usage from the API::

    from finance_app.scrapers.plan_tiers.coordinator import run_all
    summary = run_all()  # returns {site_key: status_string}

Each scraper that succeeds saves a snapshot to the sidecar JSON via
``snapshots.save_snapshot``. The bundle detector loads from that
sidecar on next use, so no further plumbing is needed.

Auth-missing failures are surfaced as a clean status string so the UI
can prompt "run bootstrap once". Other exceptions are caught + logged
per-site so one bad scraper doesn't tank the whole run.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .base import AuthStateMissing, PlanTierScraperBase
from .snapshots import save_snapshot
from .xfinity import XfinityPlanTierScraper

logger = logging.getLogger(__name__)


# Registry — append new providers here as we add them (verizon, t_mobile…).
_SCRAPERS: list[type[PlanTierScraperBase]] = [
    XfinityPlanTierScraper,
]


@dataclass
class SiteRunResult:
    site_key: str
    status: str                                # "ok" | "auth_missing" | "no_data" | "error"
    snapshots_saved: int = 0
    error: str | None = None
    plan_summary: list[str] = field(default_factory=list)  # human-readable per-provider blurbs


@dataclass
class RunAllResult:
    sites: list[SiteRunResult]

    @property
    def total_snapshots(self) -> int:
        return sum(s.snapshots_saved for s in self.sites)


def run_all() -> RunAllResult:
    """Scrape every registered plan-tier site, save snapshots, return summary."""
    sites: list[SiteRunResult] = []
    for cls in _SCRAPERS:
        scraper = cls()
        result = SiteRunResult(site_key=scraper.site_key, status="error")
        try:
            tiers = scraper.run()
        except AuthStateMissing as exc:
            result.status = "auth_missing"
            result.error = str(exc)
            sites.append(result)
            continue
        except Exception as exc:  # noqa: BLE001
            logger.exception("Plan-tier scraper %s blew up", scraper.site_key)
            result.error = f"{type(exc).__name__}: {exc}"
            sites.append(result)
            continue

        if not tiers:
            result.status = "no_data"
            sites.append(result)
            continue

        # Dedup by provider key — fetch_html yields one HTML per URL,
        # and the parser may emit the same provider from multiple URLs.
        # Keep the richest snapshot per provider: most perk_keys first,
        # then longest plan_name as a tie-break.
        best_by_provider: dict[str, "type(tiers[0])"] = {}
        for tier in tiers:
            existing = best_by_provider.get(tier.provider)
            if existing is None:
                best_by_provider[tier.provider] = tier
                continue
            new_score = (len(tier.perk_keys), len(tier.plan_name))
            old_score = (len(existing.perk_keys), len(existing.plan_name))
            if new_score > old_score:
                best_by_provider[tier.provider] = tier

        for tier in best_by_provider.values():
            try:
                save_snapshot(tier)
                result.snapshots_saved += 1
                perks = ", ".join(tier.perk_keys) if tier.perk_keys else "no bundled perks detected"
                result.plan_summary.append(
                    f"{tier.provider}: {tier.plan_name} ({perks})"
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("Failed to save snapshot for %s", tier.provider)
                result.error = f"save_failed: {exc}"
        result.status = "ok" if result.snapshots_saved > 0 else "no_data"
        sites.append(result)

    return RunAllResult(sites=sites)
