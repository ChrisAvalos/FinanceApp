"""Chase Credit Journey scraper.

Credit Journey reports a VantageScore 3.0 from Experian, refreshed
roughly weekly. Accessible from the Chase dashboard after login at
``/web/auth/dashboard#/dashboard/creditJourney``.

The page is iframe-heavy historically — Chase loads Credit Journey
inside an iframe sourced from a different origin. We grab the parent
HTML AND any iframe content we can read; whichever yields a parseable
score first wins.
"""
from __future__ import annotations

import logging
import re
from datetime import date
from typing import Iterable

from bs4 import BeautifulSoup

from .base import CreditScoreScraperBase, ScrapedScore, auth_state_path

logger = logging.getLogger(__name__)

CREDIT_JOURNEY_URL = (
    "https://secure.chase.com/web/auth/dashboard#/dashboard/creditJourney/dashboard"
)

_NUMBER_RE = re.compile(r"\b([2-9]\d{2})\b")
_NEAR_TOKENS = ("credit journey", "experian", "vantagescore", "your score")


def _looks_like_score(n: int) -> bool:
    return 250 <= n <= 900


class CreditJourneyScraper(CreditScoreScraperBase):
    site_key = "credit_journey"
    name = "Chase Credit Journey"

    def parse(self, html: str) -> list[ScrapedScore]:
        if not html:
            return []
        soup = BeautifulSoup(html, "html.parser")
        today = date.today()

        # ------- Primary path: dedicated tile -------
        tile = soup.select_one(
            ".credit-journey-score, .score-display, [data-testid*='credit-score']"
        )
        if tile:
            num_el = tile.select_one(".value, .score, [data-testid*='score-value']")
            if num_el:
                m = _NUMBER_RE.search(num_el.get_text(" ", strip=True))
                if m and _looks_like_score(int(m.group(1))):
                    return [
                        ScrapedScore(
                            site_key=self.site_key,
                            score=int(m.group(1)),
                            bureau="experian",
                            scoring_model="vantagescore3",
                            as_of=today,
                            source_detail="Chase Credit Journey · Experian",
                            raw_text=tile.get_text(" ", strip=True)[:280],
                        )
                    ]

        # ------- Fallback: text-window search near "Credit Journey" / "Experian" -------
        body_text = soup.get_text(" ", strip=True)
        body_low = body_text.lower()
        for match in _NUMBER_RE.finditer(body_text):
            num = int(match.group(1))
            if not _looks_like_score(num):
                continue
            window = body_low[max(0, match.start() - 120) : match.end() + 120]
            if any(token in window for token in _NEAR_TOKENS):
                return [
                    ScrapedScore(
                        site_key=self.site_key,
                        score=num,
                        bureau="experian",
                        scoring_model="vantagescore3",
                        as_of=today,
                        source_detail="Chase Credit Journey · Experian (loose match)",
                        raw_text=window[:280],
                    )
                ]
        return []

    def fetch_html(self) -> Iterable[str]:
        """Live fetch. Yields parent HTML AND each readable iframe's HTML."""
        from playwright.sync_api import sync_playwright  # noqa: WPS433

        state_path = auth_state_path(self.site_key)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(storage_state=str(state_path))
            page = ctx.new_page()
            page.goto(CREDIT_JOURNEY_URL, wait_until="networkidle", timeout=30_000)
            page.wait_for_timeout(2500)
            yield page.content()
            # Try each iframe — Credit Journey loads its score widget in
            # an iframe historically. Cross-origin frames are unreadable;
            # same-origin ones give us a second chance to find the score.
            for frame in page.frames:
                if frame is page.main_frame:
                    continue
                try:
                    yield frame.content()
                except Exception:  # noqa: BLE001
                    logger.debug("Skipped unreadable iframe %s", frame.url)
                    continue
            ctx.close()
            browser.close()


SPEC_NAME = "credit_journey"
