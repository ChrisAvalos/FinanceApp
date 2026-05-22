"""Per-store stub scrapers — Phase 10 Slice D.

These exist as scaffolding. Each one reports ``auth_missing=True``
until a real Playwright (or HTTP-only) implementation lands. The
coordinator handles the missing-auth case gracefully — you'll see
the per-store auth-missing flags in the UI and can prioritize which
to bootstrap first.

To replace a stub with a real scraper, implement ``scrape(query)``:
    1. Probe for the auth-state file (mirror offers/auth_state.py).
    2. Hit the store's search endpoint (Playwright for SPA stores
       like Costco; HTTP for stores with REST search like Target).
    3. Parse the first product card; return ScrapedPrice with merchant
       set to the canonical store name (matches RecurringPurchase.primary_merchant
       so the deal detector can pivot).
    4. Return None on no-match; raise on system error.

The auth bootstrap is one-time-per-site: open Playwright with
``HEADFUL=1``, log in, save the storage state JSON, and you're done.
Same flow as the offers scrapers in Phase 5.1.
"""
from __future__ import annotations

import logging
from pathlib import Path

from .base import ScrapedPrice

logger = logging.getLogger(__name__)


# Auth state files live alongside the offer scraper auth states.
# Keep them in ``backend/.auth_state/`` so .gitignore catches them.
_AUTH_STATE_DIR = Path("backend/.auth_state")


def _auth_state_present(filename: str) -> bool:
    """Cheap probe — does a saved auth state exist for this store?"""
    return (_AUTH_STATE_DIR / filename).exists()


class _StubBase:
    """Common boilerplate for the not-yet-implemented scrapers.

    Each subclass overrides ``name`` + ``_auth_filename``. ``scrape()``
    always returns None until someone replaces the implementation.
    """
    name: str = "stub"
    requires_auth: bool = True
    _auth_filename: str = ""

    def auth_missing(self) -> bool:
        if not self.requires_auth:
            return False
        if not self._auth_filename:
            return True
        return not _auth_state_present(self._auth_filename)

    def scrape(self, query: str) -> ScrapedPrice | None:
        # Stubs never produce a hit. Replace this method when wiring
        # up the real scraper. Logged at INFO so the coordinator's
        # summary reads cleanly without per-call noise.
        logger.info("%s scraper stub — returning None for query=%r", self.name, query)
        return None


class CostcoScraper(_StubBase):
    """Costco deal scraper — stub.

    Real implementation: Costco aggressively requires login for both
    in-store and online prices (member-only). Playwright + saved auth
    state is the only viable path. Member-only pricing means a real
    "deal" check has to happen post-auth.
    """
    name = "costco"
    requires_auth = True
    _auth_filename = "costco.json"


class AmazonFreshScraper(_StubBase):
    """Amazon Fresh deal scraper — stub.

    Real implementation: Amazon's bot detection is the strongest of
    the bunch. Playwright with stealth plugin + residential-class
    fingerprinting OR a Whole Foods Market alternate path. Significant
    engineering effort; lowest priority of the five.
    """
    name = "amazon_fresh"
    requires_auth = True
    _auth_filename = "amazon_fresh.json"


class KrogerScraper(_StubBase):
    """Kroger deal scraper — stub.

    Real implementation: Kroger has a partner API that returns
    digital-coupon prices for logged-in users. Easier than Costco
    because most stores route under the same auth. Decent priority
    because Kroger covers Ralph's, Fred Meyer, King Soopers, etc.
    under the hood.
    """
    name = "kroger"
    requires_auth = True
    _auth_filename = "kroger.json"
