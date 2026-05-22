"""Shared base + types for offer-portal scrapers.

Auth-state lifecycle
--------------------
Each scraper owns a ``site_key`` (e.g. "chase", "amex"). At runtime it
expects a Playwright auth-state JSON saved at
``backend/.auth_state/<site_key>.json``. That file holds the logged-in
cookies + localStorage from a real browser session.

Bootstrap flow (manual, one-time per site):

  python -m finance_app.scrapers.offers.bootstrap chase

…opens a real Chromium window, you log in normally (with 2FA if
prompted), and the helper saves the auth state. From then on the daily
APScheduler job loads that state and scrapes headlessly.

Why this shape
--------------
Banks routinely break on simple ``requests``-based scrapers — they
ship aggressive CSP, mTLS, JS-rendered content. Playwright with a
saved authenticated session is the smallest setup that actually works
on Chase + Amex. The cost is one manual login per site per device.

We DON'T store passwords. The auth-state JSON contains only cookies
and localStorage entries — same artifacts the browser would have
anyway. They expire when the bank's session expires (usually 1-2
weeks for Chase, 30 days for Amex), at which point the scraper fails
gracefully and emits a "needs re-auth" notice.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Iterator

logger = logging.getLogger(__name__)


# Where auth-state files live. Lives at the repo root rather than under
# the package so it doesn't ship into wheels.
AUTH_STATE_DIR = (
    Path(__file__).resolve().parent.parent.parent.parent / ".auth_state"
)


def auth_state_path(site_key: str) -> Path:
    """Path to the saved Playwright storageState for ``site_key``."""
    return AUTH_STATE_DIR / f"{site_key}.json"


class AuthStateMissing(RuntimeError):
    """Raised when a scraper runs but its auth-state file isn't on disk.

    Catch in coordinator code and surface to the user as a "log in once"
    prompt. NOT a hard error — just means the scraper hasn't been
    bootstrapped yet.
    """


@dataclass
class ScrapedOffer:
    """One offer pulled from a card portal.

    Mirrors the user-facing ``Offer`` table loosely. Fields the table
    has but the scraper can't fill (account_id, merchant_id resolution)
    are populated downstream by the coordinator.
    """

    site_key: str  # "chase" | "amex"
    merchant_name: str
    title: str
    reward_type: str  # "percent_back" | "fixed_amount" | "bundle"
    reward_value_bps: int | None  # 1000 = 10% (only meaningful for percent_back)
    reward_cap_cents: int | None
    minimum_spend_cents: int | None
    expires_at: date | None
    activation_url: str | None
    raw_text: str = ""  # the offer description verbatim, for the UI


class OfferScraperBase:
    """Subclass-hooks contract for a per-site scraper.

    Concrete implementations live in :mod:`chase_offers` and
    :mod:`amex_offers`. Both read from the saved auth-state and yield
    :class:`ScrapedOffer` instances.

    The ``parse`` helper is split out from ``run`` so we can unit-test
    HTML → ScrapedOffer in isolation with fixtures, no Playwright
    needed. ``run`` orchestrates the live navigation.
    """

    site_key: str = ""  # subclass must set
    name: str = ""  # human-readable

    # ------------------------------------------------------------------
    #  Hooks subclasses implement
    # ------------------------------------------------------------------

    def fetch_html(self) -> Iterable[str]:  # type: ignore[name-defined]
        """Pull the offer-list page(s). Override in subclass.

        Default raises NotImplementedError so the abstract gate is
        explicit. Real implementations open Playwright with the saved
        auth state, navigate to the offers tab, return the HTML for
        each relevant page.
        """
        raise NotImplementedError

    def parse(self, html: str) -> list[ScrapedOffer]:
        """HTML → offers. Subclass implements; pure function."""
        raise NotImplementedError

    # ------------------------------------------------------------------
    #  Live runner
    # ------------------------------------------------------------------

    def run(self) -> list[ScrapedOffer]:
        """Live scrape entry point. Reads auth state, fetches, parses.

        Raises :class:`AuthStateMissing` if the bootstrap hasn't been
        run. Wrap this call in the coordinator and surface a clean
        error UI instead of letting the exception bubble to API.
        """
        if not auth_state_path(self.site_key).exists():
            raise AuthStateMissing(
                f"No saved auth state for {self.site_key}. Run "
                f"`python -m finance_app.scrapers.offers.bootstrap "
                f"{self.site_key}` once to log in."
            )
        results: list[ScrapedOffer] = []
        for html in self.fetch_html():
            try:
                results.extend(self.parse(html))
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Offer parse failed for %s (HTML len=%d)",
                    self.site_key,
                    len(html or ""),
                )
        return results


# Iterable type-import workaround so the base file doesn't need to
# import every typing helper at the top.
from typing import Iterable  # noqa: E402
