"""Capital One CreditWise scraper.

CreditWise reports a single VantageScore 3.0 from TransUnion. Lives at
the dashboard root after a Cap One login. Like Credit Karma it's a
heavily React-rendered page, so we wait briefly after navigation
before snapshotting HTML.

Dashboard structure (recent versions)::

    <div class="creditwise-score-display">
      <span class="value">748</span>
      <span class="label">VantageScore 3.0 from TransUnion</span>
    </div>

Cap One A/B-tests the layout less often than Credit Karma, but we
keep a loose-match fallback for safety.
"""
from __future__ import annotations

import logging
import re
from datetime import date
from typing import Iterable

from bs4 import BeautifulSoup

from .base import CreditScoreScraperBase, ScrapedScore, auth_state_path

logger = logging.getLogger(__name__)

# CreditWise lives at this URL once authed. Cap One redirects through
# their login if the session is stale.
CREDITWISE_URL = "https://verified.capitalone.com/auth/signin?Product=CreditWise"

_NUMBER_RE = re.compile(r"\b([2-9]\d{2})\b")
# Phrases we know live next to the headline score on CreditWise.
_NEAR_TOKENS = ("vantagescore", "transunion", "tu", "your score", "creditwise")


def _looks_like_score(n: int) -> bool:
    return 250 <= n <= 900


class CreditWiseScraper(CreditScoreScraperBase):
    site_key = "creditwise"
    name = "Capital One CreditWise"

    def parse(self, html: str) -> list[ScrapedScore]:
        if not html:
            return []
        soup = BeautifulSoup(html, "html.parser")
        today = date.today()

        # ------- Primary path: dedicated score-display tile -------
        tile = soup.select_one(
            ".creditwise-score-display, [data-testid*='credit-score'], "
            ".credit-score-display, .score-hero"
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
                            bureau="transunion",
                            scoring_model="vantagescore3",
                            as_of=today,
                            source_detail="Capital One CreditWise · TransUnion",
                            raw_text=tile.get_text(" ", strip=True)[:280],
                        )
                    ]

        # ------- Fallback: text-window search -------
        # Cap One's hero shows the number very prominently and the
        # words "VantageScore" or "TransUnion" within a short distance.
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
                        bureau="transunion",
                        scoring_model="vantagescore3",
                        as_of=today,
                        source_detail="Capital One CreditWise · TransUnion (loose match)",
                        raw_text=window[:280],
                    )
                ]
        return []

    def fetch_html(self) -> Iterable[str]:
        from playwright.sync_api import sync_playwright  # noqa: WPS433

        state_path = auth_state_path(self.site_key)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(storage_state=str(state_path))
            page = ctx.new_page()
            page.goto(CREDITWISE_URL, wait_until="networkidle", timeout=30_000)
            page.wait_for_timeout(2000)
            html = page.content()
            ctx.close()
            browser.close()
            yield html


SPEC_NAME = "creditwise"
