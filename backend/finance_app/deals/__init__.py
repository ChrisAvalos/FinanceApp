"""Cross-store deal detection — Phase 10 Slice D.

Public entrypoints
------------------
``run_scrape(db)`` — fan out across all configured scrapers,
                     persist new PriceObservation rows, return summary.

``find_deals(db, savings_threshold=0.15)`` — for each RecurringPurchase,
                     surface the best recent observation across all
                     merchants that beats the user's typical price by
                     ≥threshold. Returns ranked list, doesn't persist.

``log_manual_observation(db, ...)`` — convenience for the API to write
                     a single user-typed observation.

Architecture mirrors the offers/ scraper coordinator: per-store stub
scrapers report ``auth_missing=True`` when they can't run, the
coordinator catches errors per-source so one site failing doesn't
sink the whole scrape.
"""
from .coordinator import (
    ScrapeRunResult,
    ScraperRunSummary,
    log_manual_observation,
    run_scrape,
)
from .detector import DealOpportunity, find_deals

__all__ = [
    "DealOpportunity",
    "ScrapeRunResult",
    "ScraperRunSummary",
    "find_deals",
    "log_manual_observation",
    "run_scrape",
]
