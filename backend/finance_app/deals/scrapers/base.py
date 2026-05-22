"""Shared types for deal scrapers — Phase 10 Slice D.

A scraper takes a search query (typically the canonical name of a
RecurringPurchase) and returns ``ScrapedPrice | None``. None means
"the search didn't yield a confident match" (NOT an error — that
gets raised). The coordinator turns a None into a ``rows_skipped``
in the summary.

Scrapers live behind a ``requires_auth`` flag. When auth-state is
missing, the coordinator records ``auth_missing=True`` in the
summary instead of running the scraper. This mirrors the offers
scraper pattern Phase 5.1 already proved.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Protocol, runtime_checkable


@dataclass
class ScrapedPrice:
    """One price hit for a given query against a store."""
    merchant: str
    price_cents: int
    observed_at: date
    in_stock: bool = True
    product_url: str | None = None
    notes: str | None = None


@runtime_checkable
class DealScraper(Protocol):
    """Per-store deal scraper contract.

    Implementations either:
      * Return a populated ScrapedPrice when the query matched.
      * Return None when no confident match (out-of-stock variant,
        weird search result page, etc.).
      * Raise an exception — the coordinator catches it and marks
        the run as errored.
      * Set auth_missing on the SCRAPER (queried by the coordinator
        BEFORE scraping) when the user hasn't bootstrapped auth.

    The query is typically RecurringPurchase.canonical_name. SKU is
    available on the pattern when present and a future scraper can
    use it for tighter matching, but most stores' search APIs are
    name-based anyway.
    """
    name: str
    requires_auth: bool

    def auth_missing(self) -> bool:
        """True when the scraper can't run because per-site auth-state
        hasn't been bootstrapped yet. The coordinator checks this
        BEFORE calling ``scrape`` so the run is fast when auth is
        missing across the board."""
        ...

    def scrape(self, query: str) -> ScrapedPrice | None:
        """Best-effort price lookup for ``query`` at this store.
        Implementations should be tolerant — return None rather than
        raising on any "no result" variant."""
        ...
