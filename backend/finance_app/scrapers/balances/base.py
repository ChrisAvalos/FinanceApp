"""Shared base + types for balance scrapers — Sprint 43.

Mirrors the shape of ``credit_scores/base.py`` since the lifecycle is
identical: stored Playwright auth state per site_key, headless run,
parse HTML, return structured records. The persistence target differs
(BalanceSnapshot + synthetic Account rather than CreditScoreSnapshot),
which the coordinator handles.

Why a separate package
----------------------
Could in theory live under ``scrapers/balances`` as just another
flavor. Splitting it out keeps the imports clean for callers that
only want balance scrapers (and avoids dragging credit-bureau parsing
helpers into the balance path).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Iterable

logger = logging.getLogger(__name__)


# Shared auth-state dir with the other scrapers. Site keys must not
# collide — `albert` vs `chase` / `credit_karma` / etc.
AUTH_STATE_DIR = (
    Path(__file__).resolve().parent.parent.parent.parent / ".auth_state"
)


def auth_state_path(site_key: str) -> Path:
    """Path to the saved Playwright storageState for ``site_key``."""
    return AUTH_STATE_DIR / f"{site_key}.json"


class AuthStateMissing(RuntimeError):
    """Raised when a scraper runs but its auth-state file isn't on disk.

    Caught by the coordinator and surfaced to the API as a clean
    "please log in once via bootstrap" rather than a 500.
    """


@dataclass(frozen=True)
class ScrapedBalance:
    """One balance observation pulled from a portal.

    The coordinator translates each ScrapedBalance into:
      * An ``Account`` row (created on first sight, keyed by
        ``site_key + account_label``).
      * A ``BalanceSnapshot`` row with the current value.

    ``account_type`` maps to our ``AccountType`` enum. The coordinator
    is responsible for converting the string to the enum and rejecting
    unknown values.
    """

    site_key: str               # e.g. "albert"
    institution_name: str       # display name — "Albert"
    account_label: str          # e.g. "Albert Savings"
    account_type: str           # "savings" | "investment" | "checking" | ...
    balance_cents: int          # signed (negative = liability)
    as_of: date
    notes: str | None = None
    raw_text: str = ""          # surrounding HTML/text snippet — debug only


class BalanceScraperBase:
    """Subclass-hooks contract for a per-site balance scraper.

    Concrete implementations override ``fetch_html`` (live navigation)
    and ``parse`` (pure HTML → balances). ``run`` orchestrates: read
    auth state, fetch, parse, return.
    """

    site_key: str = ""
    institution_name: str = ""  # display name shown in our DB

    def fetch_html(self) -> Iterable[str]:
        """Pull the balance-display page(s). Override in subclass."""
        raise NotImplementedError

    def parse(self, html: str) -> list[ScrapedBalance]:
        """HTML → balances. Pure function, unit-testable with fixtures."""
        raise NotImplementedError

    def run(self) -> list[ScrapedBalance]:
        """Read auth state, fetch, parse, return. Caller handles persistence."""
        if not auth_state_path(self.site_key).exists():
            raise AuthStateMissing(
                f"No saved auth state for {self.site_key}. Run "
                f"`python -m finance_app.scrapers.balances.bootstrap "
                f"{self.site_key}` once to log in."
            )
        results: list[ScrapedBalance] = []
        for html in self.fetch_html():
            try:
                results.extend(self.parse(html))
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Balance parse failed for %s (HTML len=%d)",
                    self.site_key,
                    len(html or ""),
                )
        return results
