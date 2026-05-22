"""Target deal scraper — DEFERRED to a Playwright implementation.

Status (2026-05)
----------------
Target is non-viable via plain HTTP. We tried two paths:

1. **RedSky JSON API** (``redsky.target.com/redsky_aggregations/...``).
   Returns 403 even with a valid api_key. Investigation showed the
   api_key in our code is identical to the one Target's own frontend
   uses live. The 403 isn't api_key rotation — Target rejects based
   on TLS fingerprint + UA + missing cookies. python-requests can't
   spoof TLS fingerprints; would need ``curl_cffi`` or similar.

2. **Server-rendered search HTML**
   (``target.com/s?searchTerm=...``). Returns 200 but the response
   is an empty SPA shell. Probe confirmed: ``__NEXT_DATA__`` is
   present but contains app state only, not product data. JSON-LD is
   present but only ``WebPage`` schema with breadcrumbs. The
   ``__NEXT_DATA__`` blob even includes ``isBot`` / ``isSeoPhantom``
   flags Target uses to gate non-browser clients. Without JS
   execution, no product data comes back.

The viable path is **Playwright with a saved auth state**, same
pattern as Chase Offers / SmartCredit. Bootstrap once, then
headless-render the search page so React executes and the DOM
fills in. That's significant additional work, deferred to a
follow-up.

For now this scraper reports ``auth_missing=True`` so the deals
panel surfaces "needs Playwright bootstrap" rather than silently
returning None.

To replace this with a real Playwright implementation
-----------------------------------------------------
Mirror the structure of ``finance_app.scrapers.offers.chase_offers``:

* Add an ``auth_state_path()`` probe (re-use the offers helper)
* Add a bootstrap CLI under
  ``finance_app/scrapers/deals/bootstrap.py``
* In ``scrape()``, launch Playwright with the saved storage state,
  navigate to ``https://www.target.com/s?searchTerm=...``, wait for
  network-idle + 2s for React, query the rendered DOM for product
  cards using ``data-test`` attributes (Target uses
  ``data-test="@web/site-top-of-funnel/ProductCardWrapper"`` for
  search result cards).

References
----------
* ``backend/scripts/probe_target_html.py`` — confirms SSR is a SPA shell
* ``backend/.debug/target_search.html`` — captured response (empty shell)
* See ``walmart.py`` for the working HTTP-only pattern.
"""
from __future__ import annotations

import logging
from pathlib import Path

from .base import ScrapedPrice

logger = logging.getLogger(__name__)


# Auth state file we'll create when the Playwright follow-up lands.
_AUTH_STATE_DIR = Path("backend/.auth_state")
_AUTH_FILENAME = "target.json"


class TargetScraper:
    """Stub. Replace with a Playwright implementation — see docstring."""

    name: str = "target"
    requires_auth: bool = True  # Playwright bootstrap required when implemented

    def auth_missing(self) -> bool:
        """Always True until the Playwright variant is built. The
        deals panel will show 'needs Playwright bootstrap' rather
        than False-implies-running."""
        if not (_AUTH_STATE_DIR / _AUTH_FILENAME).exists():
            return True
        # Even when an auth file is present, the scraper itself isn't
        # implemented yet — so still True. Once `scrape()` does real
        # work, replace this body with `return False`.
        return True

    def scrape(self, query: str) -> ScrapedPrice | None:
        """No-op until the Playwright variant lands."""
        logger.info(
            "Target scraper deferred — see target.py docstring. query=%r ignored.",
            query,
        )
        return None
