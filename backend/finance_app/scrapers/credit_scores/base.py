"""Shared base + types for credit-score portal scrapers.

Auth-state lifecycle (parallel to offers/base.py)
-------------------------------------------------
Each scraper owns a ``site_key`` (e.g. ``"credit_karma"``,
``"creditwise"``, ``"credit_journey"``). At runtime it expects a
Playwright auth-state JSON saved at
``backend/.auth_state/<site_key>.json`` — same directory as the offers
scrapers, just with non-colliding keys.

Bootstrap once per site::

    python -m finance_app.scrapers.credit_scores.bootstrap credit_karma
    python -m finance_app.scrapers.credit_scores.bootstrap creditwise
    python -m finance_app.scrapers.credit_scores.bootstrap credit_journey

…opens a real Chromium window, you log in (with 2FA if asked), the
helper saves the cookies, and the daily cron scrapes headlessly from
then on.

Why mirror the offers shape instead of fold-into-shared-base
------------------------------------------------------------
The two domains share 95% of their plumbing but diverge on:

  * The output dataclass (offers vs scores).
  * The persistence target (Offer rows vs CreditScoreSnapshot rows).
  * What a "match" / dedupe key looks like.

Sharing a base class would force generic typing or duplicate fields
into a Frankenstein superclass. Two 100-line bases that both copy from
the same well-trodden pattern is easier to reason about than one
abstract 250-line base full of optional hooks. The auth-state directory
+ the ``AuthStateMissing`` semantics are reused verbatim from offers.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable

logger = logging.getLogger(__name__)


# Same .auth_state dir that the offers scrapers use. Site keys must not
# collide (they don't — offers uses chase / amex; we use credit_karma /
# creditwise / credit_journey).
AUTH_STATE_DIR = (
    Path(__file__).resolve().parent.parent.parent.parent / ".auth_state"
)


def auth_state_path(site_key: str) -> Path:
    """Path to the saved Playwright storageState for ``site_key``."""
    return AUTH_STATE_DIR / f"{site_key}.json"


class AuthStateMissing(RuntimeError):
    """Raised when a scraper runs but its auth-state file isn't on disk.

    Caught in the coordinator and surfaced to the API as a clean
    "please log in once via bootstrap" rather than a 500.
    """


@dataclass
class ScrapedScore:
    """One credit-score observation pulled from a portal.

    Mirrors :class:`finance_app.db.models.CreditScoreSnapshot` loosely.
    The coordinator writes one CreditScoreSnapshot per ScrapedScore,
    skipping if the (bureau, scoring_model, as_of, source) tuple is
    already on file (the existing model uniqueness contract).
    """

    site_key: str  # "credit_karma" | "creditwise" | "credit_journey"
    score: int  # 300..900 typical
    bureau: str  # "experian" | "transunion" | "equifax"
    scoring_model: str  # "fico8" | "vantagescore3" | etc.
    as_of: date
    source_detail: str = ""  # the portal name shown to the user (e.g. "Credit Karma · TU")
    notes: str | None = None  # free text — captured raw caveats / context
    raw_text: str = ""  # the surrounding HTML text, kept for debugging


class CreditScoreScraperBase:
    """Subclass-hooks contract for a per-portal credit-score scraper.

    Concrete implementations live in :mod:`credit_karma`, :mod:`creditwise`,
    :mod:`credit_journey`. ``parse`` is the pure-function HTML → score
    method (unit-testable with fixtures, no Playwright). ``fetch_html``
    is the live navigation. ``run`` orchestrates: read auth-state,
    fetch, parse, return.
    """

    site_key: str = ""
    name: str = ""  # human-readable label, e.g. "Credit Karma"

    # ------------------------------------------------------------------
    #  Hooks subclasses implement
    # ------------------------------------------------------------------

    def fetch_html(self) -> Iterable[str]:
        """Pull the score-display page(s). Override in subclass."""
        raise NotImplementedError

    def parse(self, html: str) -> list[ScrapedScore]:
        """HTML → scores. Subclass implements; pure function."""
        raise NotImplementedError

    # ------------------------------------------------------------------
    #  Live runner
    # ------------------------------------------------------------------

    def run(self) -> list[ScrapedScore]:
        """Live scrape. Reads auth state, fetches, parses, returns scores.

        Raises :class:`AuthStateMissing` if the bootstrap hasn't been
        run for this site_key. Coordinator catches and surfaces to UI.
        """
        if not auth_state_path(self.site_key).exists():
            raise AuthStateMissing(
                f"No saved auth state for {self.site_key}. Run "
                f"`python -m finance_app.scrapers.credit_scores.bootstrap "
                f"{self.site_key}` once to log in."
            )
        results: list[ScrapedScore] = []
        for html in self.fetch_html():
            try:
                results.extend(self.parse(html))
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Score parse failed for %s (HTML len=%d)",
                    self.site_key,
                    len(html or ""),
                )
        return results
