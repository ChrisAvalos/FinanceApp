"""Class-action scraper package.

Public entrypoint is ``run_scrapers(db, scrapers, client)`` from
``coordinator``. ``default_scrapers()`` returns the set we ship with —
TopClassActions + ClassAction.org — so callers (the API endpoint and
the weekly scheduler job) don't have to assemble it themselves.
"""
from __future__ import annotations

from .base import LegalClaimScraper, ScrapedClaim, ScrapedListing
from .class_action_org import ClassActionOrgScraper
from .class_action_rebates import ClassActionRebatesScraper
from .coordinator import run_one_scraper, run_scrapers
from .top_class_actions import TopClassActionsScraper

__all__ = [
    "ClassActionOrgScraper",
    "ClassActionRebatesScraper",
    "LegalClaimScraper",
    "ScrapedClaim",
    "ScrapedListing",
    "TopClassActionsScraper",
    "default_scrapers",
    "run_one_scraper",
    "run_scrapers",
]


def default_scrapers() -> list[LegalClaimScraper]:
    """The default scraper set wired into the API and the weekly job.

    Adding a new source means appending to this list — no API or
    scheduler changes needed.
    """
    return [
        TopClassActionsScraper(),
        ClassActionOrgScraper(),
        ClassActionRebatesScraper(),
    ]
