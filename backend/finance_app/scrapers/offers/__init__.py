"""Chase/Amex Offers scrapers + offer-matching logic.

Subpackage layout
-----------------

* ``base.py``          — common Playwright runner + auth-state persistence
* ``chase_offers.py``  — Chase Offers (chase.com merchant offers tab)
* ``amex_offers.py``   — Amex Offers (americanexpress.com offers tab)
* ``matcher.py``       — cross-reference offers vs. user's spending →
                         estimated $ value of each available offer
* ``coordinator.py``   — runs all scrapers in sequence, stores results

The scrapers deliberately need a one-time interactive login per site
(MANUAL_TASKS.md item #4). After that, the saved auth-state cookies
let the daily APScheduler job run them headlessly.

Output flows into the existing ``Offer`` table. The matcher attaches
``estimated_value_cents`` based on Chris's last 90 days of spending at
the offer's merchant.
"""
from .base import (
    AuthStateMissing,
    OfferScraperBase,
    ScrapedOffer,
    auth_state_path,
)
from .matcher import OfferMatch, match_offers_to_spend

__all__ = [
    "AuthStateMissing",
    "OfferScraperBase",
    "ScrapedOffer",
    "auth_state_path",
    "OfferMatch",
    "match_offers_to_spend",
]
