"""Xfinity (Comcast) plan-tier scraper.

Pulls the user's Mobile + Internet plan tiers from xfinity.com so the
bundle detector knows for sure which Peacock entitlement they have.

What we look for
----------------
Xfinity's account dashboard renders different plan summaries depending
on what the user has linked. Common shapes:

* **Mobile plan card** — "Unlimited Plus" / "Unlimited Premium" /
  "By the Gig". The Premium tier explicitly bundles Peacock Premium.
* **Internet plan card** — "Connect", "Connect More", "Fast",
  "Superfast", "Gigabit", "Gigabit Extra", "Gigabit X2". Peacock
  Premium bundles in on Gigabit Extra and higher.
* **"Included with your plan"** strip listing perks (Peacock, NOW Sports,
  Apple TV+ promos). When present, this is the gold-standard signal
  and we use it directly.

Approach: prefer the explicit perks strip if found; otherwise infer
perks from the plan name via a small lookup table. Both paths emit one
``ScrapedPlanTier`` per detected provider key.

Provider keys emitted (must match bundles.yaml):
  - ``xfinity_mobile``
  - ``xfinity_internet``
"""
from __future__ import annotations

import logging
import re
from typing import Iterable

from bs4 import BeautifulSoup

from .base import (
    PlanTierScraperBase,
    ScrapedPlanTier,
    STEALTH_INIT_SCRIPT,
    STEALTH_LAUNCH_ARGS,
    auth_state_path,
    profile_dir_for,
)

logger = logging.getLogger(__name__)

XFINITY_PLAN_URL = "https://www.xfinity.com/learn/account-management"
XFINITY_ACCOUNT_URL = "https://customer.xfinity.com/#/account"

# Plan-detail URLs — the previous URLs both redirect to a generic
# member-celebration landing page that has no plan-name text. These
# go directly to the relevant plan summary pages.
XFINITY_INTERNET_PLAN_URL = "https://www.xfinity.com/myaccount/services"
XFINITY_MOBILE_PLAN_URL = "https://www.xfinity.com/mobile/account/plan"
# Legacy/fallback URLs — kept because some account types still resolve
# the plan card on these older paths.
XFINITY_DEVICES_URL = "https://customer.xfinity.com/#/devices/internet"

# Plan-name → bundled-perk lookup. Scraped plan name (lowercased) is
# matched against these substrings; all matches contribute their perks.
# Last reviewed 2026-05-07 against xfinity.com plan pages.
_MOBILE_PERKS_BY_PLAN: dict[str, list[str]] = {
    # Most-specific keys first conceptually; the parser picks the
    # longest matching key so "unlimited premium" wins over "unlimited".
    "unlimited premium":      ["peacock"],
    "unlimited plus":         ["peacock"],
    "unlimited intro":        [],          # no Peacock on lower tiers
    "unlimited shareable":    ["peacock"], # 2025 rebrand of Unlimited
    "unlimited":              ["peacock"], # generic "Unlimited" line
    "by the gig":             [],
    # Older tier names that still appear on legacy accounts:
    "1gb shared":             [],
    "3gb shared":             [],
    "10gb shared":            [],
}
_INTERNET_PERKS_BY_PLAN: dict[str, list[str]] = {
    "gigabit x2":             ["peacock"],
    "gigabit extra":          ["peacock"],
    "gigabit":                [],          # base gigabit doesn't bundle
    "superfast":              [],
    "fast":                   [],
    "connect more":           [],
    "connect":                [],
}

# Tokens that identify which product card we're looking at. Some
# Xfinity layouts use a tabbed dashboard; others render both cards.
_MOBILE_TOKENS = ("xfinity mobile", "mobile line", "byop", "wireless")
_INTERNET_TOKENS = ("internet", "xfinity gateway", "modem", "wifi")

# Generic "included with your plan" headers we look for. Xfinity uses
# several variants depending on layout.
_INCLUDED_HEADERS = (
    "included with your plan",
    "included on your plan",
    "your plan includes",
    "free with your plan",
)


def _normalize(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _match_plan_name(text: str, lookup: dict[str, list[str]]) -> tuple[str, list[str]]:
    """Find the most-specific plan-name substring in ``text``.

    Returns (plan_name_display, perk_keys). Specificity is approximated
    by the longest matching key (so "unlimited premium" wins over
    plain "unlimited"). Perks are deduped.
    """
    norm = _normalize(text)
    matches = [k for k in lookup if k in norm]
    if not matches:
        return "", []
    # Longest key wins — most specific.
    best = max(matches, key=len)
    return best, list(dict.fromkeys(lookup[best]))


def _parse_included_strip(soup: BeautifulSoup) -> list[str]:
    """If Xfinity renders an explicit perks strip, harvest those merchant keys.

    We map known perk vendor names → canonical keys here so the
    detector's bundles.yaml lookup succeeds.
    """
    text = _normalize(soup.get_text(" ", strip=True))
    # Look for an "included" header. If absent, return empty (caller
    # falls back to plan-name inference).
    if not any(h in text for h in _INCLUDED_HEADERS):
        return []
    perks: list[str] = []
    if "peacock" in text:
        perks.append("peacock")
    if "apple tv" in text:
        perks.append("apple_tv_plus")
    if "now sports" in text:
        # Not a bundles.yaml perk yet, but useful debug info.
        perks.append("now_sports")
    return list(dict.fromkeys(perks))


def parse_xfinity_html(html: str) -> list[ScrapedPlanTier]:
    """Pure function: HTML → list of ``ScrapedPlanTier``.

    Public name + module-level so it's easy to import from a smoke test
    without instantiating the Playwright-dependent class.
    """
    if not html:
        return []
    soup = BeautifulSoup(html, "html.parser")
    # Pull text from visible body PLUS aria-labels and data-* attributes
    # since Xfinity's React app sometimes renders plan names only as
    # screen-reader text or as data props on hidden divs.
    body_text_parts = [soup.get_text(" ", strip=True)]
    for el in soup.find_all(attrs={"aria-label": True}):
        body_text_parts.append(str(el.get("aria-label", "")))
    for attr in ("data-plan-name", "data-product-name", "data-tier"):
        for el in soup.find_all(attrs={attr: True}):
            body_text_parts.append(str(el.get(attr, "")))
    body_text = " ".join(p for p in body_text_parts if p)
    body_norm = _normalize(body_text)

    explicit_perks = _parse_included_strip(soup)

    out: list[ScrapedPlanTier] = []

    # Mobile detection. Look for either the tokens OR a Mobile plan-name
    # match — both are evidence the page has a mobile plan summary.
    mobile_plan_name, mobile_perks = _match_plan_name(body_text, _MOBILE_PERKS_BY_PLAN)
    has_mobile_signal = (
        mobile_plan_name
        or any(t in body_norm for t in _MOBILE_TOKENS)
    )
    if has_mobile_signal:
        # Prefer the explicit strip when present (gold-standard signal).
        perks = explicit_perks or mobile_perks
        out.append(
            ScrapedPlanTier(
                provider="xfinity_mobile",
                plan_name=(mobile_plan_name or "Xfinity Mobile (plan name not found)"),
                perk_keys=perks,
                raw_text=body_text[:500],
                source_url=XFINITY_PLAN_URL,
            )
        )

    # Internet detection.
    internet_plan_name, internet_perks = _match_plan_name(body_text, _INTERNET_PERKS_BY_PLAN)
    has_internet_signal = (
        internet_plan_name
        or any(t in body_norm for t in _INTERNET_TOKENS)
    )
    if has_internet_signal:
        # Don't double-emit if mobile already claimed the explicit strip
        # (Xfinity sometimes renders one combined "your plan" panel).
        # Heuristic: if both signals present and only one explicit strip,
        # attribute the strip to whichever plan the lookup matched.
        if mobile_plan_name and not internet_plan_name:
            perks = []
        else:
            perks = explicit_perks or internet_perks
        out.append(
            ScrapedPlanTier(
                provider="xfinity_internet",
                plan_name=(internet_plan_name or "Xfinity Internet (plan name not found)"),
                perk_keys=perks,
                raw_text=body_text[:500],
                source_url=XFINITY_PLAN_URL,
            )
        )

    return out


class XfinityPlanTierScraper(PlanTierScraperBase):
    """Live Xfinity plan-tier scraper. Headless after first bootstrap."""

    site_key = "xfinity"
    name = "Xfinity"
    portal_url = XFINITY_PLAN_URL

    def parse(self, html: str) -> list[ScrapedPlanTier]:
        return parse_xfinity_html(html)

    def fetch_html(self) -> Iterable[str]:
        """Pull the account dashboard HTML using the persistent profile.

        We deliberately do NOT run headless against Xfinity. Akamai
        flags headless Chromium even with the stealth init script;
        running headed-but-tiny is the most reliable option. The
        bootstrap script created a profile with the user's cookies +
        font cache + history; reusing it is what gets us past the WAF.
        """
        from playwright.sync_api import sync_playwright  # noqa: WPS433

        profile_dir = profile_dir_for(self.site_key)
        if not profile_dir.exists() or not any(profile_dir.iterdir()):
            # Profile dir is empty — bootstrap hasn't run yet. Raise the
            # same error the base class would have on a missing
            # storage_state JSON, so the coordinator surfaces a clean
            # auth_missing status to the API.
            from .base import AuthStateMissing
            raise AuthStateMissing(
                f"No saved profile for {self.site_key}. Run "
                f"`python -m finance_app.scrapers.plan_tiers.bootstrap "
                f"{self.site_key}` once to log in."
            )

        with sync_playwright() as p:
            try:
                ctx = p.chromium.launch_persistent_context(
                    user_data_dir=str(profile_dir),
                    channel="chrome",
                    headless=False,
                    args=STEALTH_LAUNCH_ARGS,
                    viewport={"width": 1280, "height": 800},
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/126.0.0.0 Safari/537.36"
                    ),
                )
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Failed to launch system Chrome — falling back to bundled Chromium"
                )
                ctx = p.chromium.launch_persistent_context(
                    user_data_dir=str(profile_dir),
                    headless=False,
                    args=STEALTH_LAUNCH_ARGS,
                    viewport={"width": 1280, "height": 800},
                )
            ctx.add_init_script(STEALTH_INIT_SCRIPT)
            page = ctx.new_page() if not ctx.pages else ctx.pages[0]
            # Plan-detail URLs walked in priority order. Mobile +
            # Internet have separate plan pages; both need to be hit
            # so we can extract perk-strip text from each. The legacy
            # fallbacks are kept for account types that still route
            # through the older customer.xfinity.com SPA.
            urls = (
                XFINITY_MOBILE_PLAN_URL,
                XFINITY_INTERNET_PLAN_URL,
                XFINITY_DEVICES_URL,
                XFINITY_ACCOUNT_URL,
                XFINITY_PLAN_URL,
            )
            for url in urls:
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=30_000)
                    # Plan widgets are React-rendered; let the SPA settle.
                    page.wait_for_timeout(3500)
                    html = page.content()
                    # If Akamai still blocked us, the HTML will be the
                    # short "Access Denied" page. Don't yield that —
                    # parsers would silently emit empty snapshots.
                    if "access denied" in html.lower() and len(html) < 8000:
                        logger.warning(
                            "Xfinity returned Access Denied page at %s — "
                            "Akamai is still blocking. Try re-running bootstrap.",
                            url,
                        )
                        continue
                    yield html
                except Exception:  # noqa: BLE001
                    logger.exception("Xfinity fetch failed at %s", url)
            ctx.close()


SPEC_NAME = "xfinity"
