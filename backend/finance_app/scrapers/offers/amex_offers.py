"""Amex Offers scraper.

Amex Offers ("Amex Offers For You") follow a similar pattern to
Chase: per-card grid of merchant tiles, JS-rendered, post-auth.
Layout differs in selector classnames but the reward-string parsing
is shared via :mod:`chase_offers`.

The tile HTML typically looks like:

    <div class="offer-card">
      <div class="merchant">Best Buy</div>
      <div class="offer-text">Earn 10% back, up to $30</div>
      <div class="offer-expiration">Expires May 15, 2026</div>
      <a class="offer-cta" href="...">Add to Card</a>
    </div>

We re-use the reward-parser from chase_offers since the language is
near-identical across portals.
"""
from __future__ import annotations

import logging
from typing import Iterator

from bs4 import BeautifulSoup

from .base import OfferScraperBase, ScrapedOffer, auth_state_path
from .chase_offers import _parse_expires, _parse_reward  # shared parsers

logger = logging.getLogger(__name__)

AMEX_OFFERS_URL = "https://global.americanexpress.com/offers/eligible"


class AmexOffersScraper(OfferScraperBase):
    site_key = "amex"
    name = "Amex Offers"

    def parse(self, html: str) -> list[ScrapedOffer]:
        if not html:
            return []
        soup = BeautifulSoup(html, "html.parser")
        offers: list[ScrapedOffer] = []
        tiles = soup.select(".offer-card, .offer-tile, [data-offer-id]")
        if not tiles:
            tiles = [n.parent for n in soup.select(".merchant, .merchant-name") if n.parent]

        for tile in tiles:
            merchant_el = tile.select_one(".merchant, .merchant-name, h3, h4")
            reward_el = tile.select_one(".offer-text, .reward, .offer-reward")
            expires_el = tile.select_one(".offer-expiration, .expires")
            link_el = tile.select_one("a.offer-cta, a[href]")
            if merchant_el is None:
                continue
            merchant = merchant_el.get_text(strip=True)
            reward_text = reward_el.get_text(" ", strip=True) if reward_el else ""
            full_text = tile.get_text(" ", strip=True)
            reward_type, value_bps, cap_cents, min_spend = _parse_reward(
                reward_text or full_text
            )
            expires = (
                _parse_expires(expires_el.get_text(" ", strip=True))
                if expires_el
                else _parse_expires(full_text)
            )
            url = (
                link_el.get("href")
                if link_el and link_el.has_attr("href")
                else None
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
        from playwright.sync_api import sync_playwright  # noqa: WPS433

        state_path = auth_state_path(self.site_key)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(storage_state=str(state_path))
            page = ctx.new_page()
            page.goto(AMEX_OFFERS_URL, wait_until="networkidle", timeout=30_000)
            for _ in range(8):
                page.mouse.wheel(0, 4000)
                page.wait_for_timeout(400)
            html = page.content()
            ctx.close()
            browser.close()
            yield html


SPEC_NAME = "amex_offers"
