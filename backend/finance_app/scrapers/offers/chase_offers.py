"""Chase Offers scraper.

Approach
--------
Chase Offers live on the per-card "Merchant Offers" page after login.
The page is heavily JS-rendered; we use Playwright with a saved
storageState cookie jar (see ``base.py``) to load it post-auth.

The DOM structure tends to be:

    <ul class="offers-list">
      <li class="offer-tile">
        <span class="merchant-name">Sunglass Hut</span>
        <span class="reward">10% cash back, up to $30</span>
        <span class="expires">Expires Jun 30, 2026</span>
        <button data-offer-id="...">Activate</button>
      </li>
      ...
    </ul>

Chase has rotated this layout twice in the last year. The parser is
written defensively: pull merchant + reward by class first, fall back
to looser heuristics if the primary selector misses.

Reward strings come in three shapes:

  * "10% cash back, up to $30"
  * "$10 cash back when you spend $50"
  * "Free month of Peacock when you spend $25"

Mapped to ``reward_type``:
  ``percent_back`` (with reward_value_bps + cap),
  ``fixed_amount`` (reward_value_bps overloaded as cents, plus minimum_spend),
  ``bundle`` (free thing — value not numeric, surface as raw text).
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Iterator

from bs4 import BeautifulSoup

from .base import OfferScraperBase, ScrapedOffer, auth_state_path

logger = logging.getLogger(__name__)

CHASE_OFFERS_URL = "https://secure.chase.com/web/auth/dashboard#/dashboard/offers/all"


_PERCENT_RE = re.compile(r"(\d{1,2}(?:\.\d{1,2})?)\s*%", re.I)
_DOLLAR_BACK_RE = re.compile(
    r"\$([\d,]+(?:\.\d{1,2})?)\s+(?:cash\s+)?back", re.I
)
_DOLLAR_OFF_WHEN_RE = re.compile(
    r"\$([\d,]+(?:\.\d{1,2})?)\s+(?:cash\s+)?back.*?spend\s+\$([\d,]+(?:\.\d{1,2})?)",
    re.I,
)
_MIN_SPEND_RE = re.compile(
    r"(?:when\s+you\s+spend|spend\s+at\s+least|min(?:imum)?\s+\$)\s*\$?([\d,]+(?:\.\d{1,2})?)",
    re.I,
)
_CAP_RE = re.compile(
    r"up\s+to\s+\$([\d,]+(?:\.\d{1,2})?)|max(?:imum)?\s+\$([\d,]+(?:\.\d{1,2})?)",
    re.I,
)
_EXPIRES_RE = re.compile(
    r"(?:expires?|valid\s+through|good\s+through)\s*[:\s]\s*"
    r"(\w+\s+\d{1,2},?\s+\d{4}|\d{1,2}/\d{1,2}/\d{4})",
    re.I,
)


def _to_cents(s: str) -> int | None:
    try:
        return int(round(float(s.replace(",", "")) * 100))
    except ValueError:
        return None


def _parse_reward(reward_text: str) -> tuple[str, int | None, int | None, int | None]:
    """Return ``(reward_type, reward_value_bps, reward_cap_cents, minimum_spend_cents)``.

    ``reward_value_bps`` semantics depend on type:
      - percent_back : true bps (10% → 1000)
      - fixed_amount : cents (overloaded — $10 → 1000)
      - bundle       : None
    """
    text = reward_text or ""
    # Try the "X% back, up to $Y" form first.
    pm = _PERCENT_RE.search(text)
    cap_m = _CAP_RE.search(text)
    cap_cents: int | None = None
    if cap_m:
        cap_str = cap_m.group(1) or cap_m.group(2)
        if cap_str:
            cap_cents = _to_cents(cap_str)
    if pm:
        try:
            pct = float(pm.group(1))
            return "percent_back", int(round(pct * 100)), cap_cents, None
        except ValueError:
            pass
    # "$X back when you spend $Y" → fixed_amount + minimum
    dwhen = _DOLLAR_OFF_WHEN_RE.search(text)
    if dwhen:
        back_cents = _to_cents(dwhen.group(1))
        min_cents = _to_cents(dwhen.group(2))
        return "fixed_amount", back_cents, None, min_cents
    # "$X back" alone (rarer) → fixed_amount, no minimum
    dback = _DOLLAR_BACK_RE.search(text)
    if dback:
        return "fixed_amount", _to_cents(dback.group(1)), None, None
    # Anything else (bundles, free upgrades) — bundle, no numeric value
    return "bundle", None, None, None


def _parse_expires(text: str):
    m = _EXPIRES_RE.search(text or "")
    if not m:
        return None
    raw = m.group(1).strip()
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%B %d %Y", "%b %d %Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


class ChaseOffersScraper(OfferScraperBase):
    """Chase Offers scraper. Auth-state-file driven."""

    site_key = "chase"
    name = "Chase Offers"

    def parse(self, html: str) -> list[ScrapedOffer]:
        if not html:
            return []
        soup = BeautifulSoup(html, "html.parser")
        offers: list[ScrapedOffer] = []

        # Primary selector: tile-style li / div with merchant-name span.
        tiles = soup.select(".offer-tile, li.offer, div[data-offer-id]")
        if not tiles:
            # Fallback: look for any element with a "merchant-name" class.
            tiles = [n.parent for n in soup.select(".merchant-name") if n.parent]

        for tile in tiles:
            merchant_el = tile.select_one(".merchant-name") or tile.select_one("h3, h4")
            reward_el = tile.select_one(".reward, .reward-text, .offer-reward")
            expires_el = tile.select_one(".expires, .expiration")
            link_el = tile.select_one("a[href]") or tile.select_one("button[data-offer-url]")
            if merchant_el is None:
                continue
            merchant = merchant_el.get_text(strip=True)
            reward_text = reward_el.get_text(" ", strip=True) if reward_el else ""
            full_text = tile.get_text(" ", strip=True)
            reward_type, value_bps, cap_cents, min_spend = _parse_reward(reward_text or full_text)
            expires = (
                _parse_expires(expires_el.get_text(" ", strip=True))
                if expires_el
                else _parse_expires(full_text)
            )
            url = (
                link_el.get("href")
                if link_el and link_el.has_attr("href")
                else (link_el.get("data-offer-url") if link_el else None)
            )
            offers.append(
                ScrapedOffer(
                    site_key=self.site_key,
                    merchant_name=merchant,
                    title=f"{reward_text or 'Offer'} at {merchant}",
                    reward_type=reward_type,
                    reward_value_bps=value_bps,
                    reward_cap_cents=cap_cents,
                    minimum_spend_cents=min_spend,
                    expires_at=expires,
                    activation_url=url if isinstance(url, str) else None,
                    raw_text=full_text,
                )
            )
        return offers

    def fetch_html(self) -> Iterator[str]:
        """Live fetch via Playwright. Imports lazily so non-Playwright
        environments can still import this module for the parser tests.
        """
        from playwright.sync_api import sync_playwright  # noqa: WPS433

        state_path = auth_state_path(self.site_key)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(storage_state=str(state_path))
            page = ctx.new_page()
            page.goto(CHASE_OFFERS_URL, wait_until="networkidle", timeout=30_000)
            # Chase paginates lazily; scroll to bottom to flush all tiles.
            for _ in range(8):
                page.mouse.wheel(0, 4000)
                page.wait_for_timeout(400)
            html = page.content()
            ctx.close()
            browser.close()
            yield html


SPEC_NAME = "chase_offers"
