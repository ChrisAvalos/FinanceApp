"""Per-store deal scraper registry.

Each scraper module exposes:
    name: str                                     — short identifier
    scrape(query, auth_state) -> ScrapedPrice | None
    requires_auth: bool                           — does this need a logged-in session

Status (2026-05-05) — ON PAUSE
------------------------------
Cross-store deals as an HTTP-only project is non-viable. We confirmed
empirically (see scripts/probe_target_html.py + probe_walmart_html.py)
that:

* **Target** serves a JS-only SPA shell with isBot/isSeoPhantom flags
  and embeds zero product data in the SSR HTML.
* **Walmart** redirects non-browser clients to /blocked with a
  PerimeterX "Robot or human?" challenge.
* Costco/Kroger/Amazon Fresh have similar or stronger anti-bot
  posture (Costco requires login, Amazon's PX is the strongest of
  the bunch).

The durable path is **Playwright auth-state bootstraps**, mirroring
the offers + credit-scores scrapers. That's a focused future push,
deferred for now in favor of higher-leverage panel-polish work
(Wave A in audit-2026-05-05.md).

The walmart.py parser code is correct and reusable — a future
Playwright variant can keep the __NEXT_DATA__ + JSON-LD parsers
unchanged and just swap the ``requests.get`` call for a Playwright
``page.goto`` + ``page.content()``. Same for target.py.

Adding a new store later is one file in ``finance_app/deals/scrapers/``
plus an entry in ``default_scrapers()`` below.
"""
from __future__ import annotations

from .base import DealScraper, ScrapedPrice
from .stubs import (
    AmazonFreshScraper,
    CostcoScraper,
    KrogerScraper,
)
from .target import TargetScraper  # deferred — Playwright follow-up needed
from .walmart import WalmartScraper  # real HTTP-only implementation


def default_scrapers() -> list[DealScraper]:
    """The scraper set wired into the coordinator + scheduler.

    Order doesn't matter — coordinator runs all of them per pattern.
    Add a new store here once its scraper module ships.

    Live status (2026-05):
        walmart → REAL (HTTP-only, parses SSR Next.js blob)
        target  → DEFERRED (needs Playwright; see target.py docstring)
        costco, amazon_fresh, kroger → STUBS
    """
    return [
        WalmartScraper(),
        TargetScraper(),
        CostcoScraper(),
        AmazonFreshScraper(),
        KrogerScraper(),
    ]


__all__ = [
    "AmazonFreshScraper",
    "CostcoScraper",
    "DealScraper",
    "KrogerScraper",
    "ScrapedPrice",
    "TargetScraper",
    "WalmartScraper",
    "default_scrapers",
]
