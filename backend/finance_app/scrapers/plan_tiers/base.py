"""Base + types for plan-tier scrapers.

Mirrors the offers/credit_scores layout: per-portal subclass with a
``site_key``, ``parse(html)`` pure function, and ``fetch_html()``
Playwright runner. Auth state lives at
``backend/.auth_state/<site_key>.json`` (same directory the other
scrapers use; site keys must not collide).

Bootstrap once per site::

    python -m finance_app.scrapers.plan_tiers.bootstrap xfinity

…opens a Chromium window for first login (incl. 2FA), saves cookies,
and the daily run goes headless from then on.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable

logger = logging.getLogger(__name__)

# Same .auth_state dir used by offers/* and credit_scores/*. Site keys
# must remain unique across all three (xfinity is new).
AUTH_STATE_DIR = (
    Path(__file__).resolve().parent.parent.parent.parent / ".auth_state"
)


def auth_state_path(site_key: str) -> Path:
    """Path to the saved Playwright storageState for ``site_key``."""
    return AUTH_STATE_DIR / f"{site_key}.json"


def profile_dir_for(site_key: str) -> Path:
    """Persistent-context profile directory for ``site_key``.

    Carrier portals (Xfinity, Verizon, etc.) sit behind Akamai/Imperva
    bot-detection that flags Playwright's bundled Chromium even with a
    saved storage_state. Using a *persistent* Chrome profile (with
    history, font cache, indexedDB) raises the fingerprint past most of
    those checks. Living next to .auth_state/ keeps the .gitignore tidy.
    """
    return AUTH_STATE_DIR / f"{site_key}_profile"


# JavaScript injected on every page-init that strips the most-checked
# automation tells. Akamai's primary signal is `navigator.webdriver`;
# secondary tells (chrome.runtime, plugins.length, languages) are also
# normalized so the fingerprint looks like a regular Chrome session.
STEALTH_INIT_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
window.chrome = { runtime: {} };
const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
if (originalQuery) {
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters)
  );
}
"""


# Launch arguments that quiet the most-detectable Chromium signatures.
# `--disable-blink-features=AutomationControlled` removes the "Chrome
# is being controlled by automated test software" banner, which also
# clears the underlying CDP-targeting fingerprint.
STEALTH_LAUNCH_ARGS: list[str] = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--no-default-browser-check",
    "--no-first-run",
]


class AuthStateMissing(RuntimeError):
    """Raised when a scraper runs without a saved storage_state file.

    The coordinator catches and surfaces this as a clean
    "please run bootstrap once" error instead of a 500.
    """


@dataclass
class ScrapedPlanTier:
    """One snapshot of the user's actual plan + bundled perks at a portal.

    ``provider`` is a stable key that the detector uses to look up the
    corresponding bundles.yaml entry — must match a bundles.yaml
    ``provider`` field exactly so the override path is unambiguous.

    ``perk_keys`` is a list of canonical merchant keys (the same keys
    used in bundles.yaml ``perks[].merchant``). When the scraper sees
    "Peacock Premium" listed under "Included with your plan" we emit
    ``perk_keys=["peacock"]``. The detector then assigns 0.95
    confidence to any flagged overlap whose perk_merchant is in this
    list, regardless of bill-amount range.
    """

    provider: str                              # stable key, e.g. "xfinity_mobile"
    plan_name: str                             # human-readable, e.g. "Unlimited Plus"
    perk_keys: list[str] = field(default_factory=list)
    raw_text: str = ""                         # raw scraped chunk for debugging
    scraped_at: datetime = field(default_factory=datetime.utcnow)
    source_url: str = ""

    def to_dict(self) -> dict:
        """JSON-serializable form for the sidecar snapshot file."""
        return {
            "provider": self.provider,
            "plan_name": self.plan_name,
            "perk_keys": list(self.perk_keys),
            "raw_text": self.raw_text[:500],
            "scraped_at": self.scraped_at.isoformat(),
            "source_url": self.source_url,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "ScrapedPlanTier":
        ts_raw = d.get("scraped_at")
        if isinstance(ts_raw, str):
            try:
                ts = datetime.fromisoformat(ts_raw)
            except ValueError:
                ts = datetime.utcnow()
        else:
            ts = datetime.utcnow()
        return cls(
            provider=str(d["provider"]),
            plan_name=str(d.get("plan_name", "")),
            perk_keys=list(d.get("perk_keys") or []),
            raw_text=str(d.get("raw_text", "")),
            scraped_at=ts,
            source_url=str(d.get("source_url", "")),
        )


class PlanTierScraperBase:
    """Subclass-hooks contract for a per-portal plan-tier scraper.

    Concrete implementations live in :mod:`xfinity` (and later
    :mod:`verizon`, :mod:`t_mobile`, etc.). ``parse`` is the pure-
    function HTML→tier method (testable with fixtures). ``fetch_html``
    is the live Playwright navigation. ``run`` orchestrates.
    """

    site_key: str = ""                         # short stable key, e.g. "xfinity"
    name: str = ""                             # human label, e.g. "Xfinity"
    portal_url: str = ""                       # plan-detail URL on the carrier site

    # ------------------------------------------------------------------

    def fetch_html(self) -> Iterable[str]:
        """Pull the plan-detail page(s). Override in subclass."""
        raise NotImplementedError

    def parse(self, html: str) -> list[ScrapedPlanTier]:
        """HTML → tier snapshots. Subclass implements; pure function."""
        raise NotImplementedError

    # ------------------------------------------------------------------

    def run(self) -> list[ScrapedPlanTier]:
        """Live scrape: read auth-state, fetch, parse, return.

        Raises :class:`AuthStateMissing` if bootstrap hasn't been run.
        Coordinator catches and surfaces to UI as a "please log in" prompt.
        """
        if not auth_state_path(self.site_key).exists():
            raise AuthStateMissing(
                f"No saved auth state for {self.site_key}. Run "
                f"`python -m finance_app.scrapers.plan_tiers.bootstrap "
                f"{self.site_key}` once to log in."
            )
        out: list[ScrapedPlanTier] = []
        for html in self.fetch_html():
            try:
                out.extend(self.parse(html))
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Plan-tier parse failed for %s (HTML len=%d)",
                    self.site_key,
                    len(html or ""),
                )
        return out
