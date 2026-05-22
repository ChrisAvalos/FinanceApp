"""Credit Karma scraper.

Approach
--------
Credit Karma's dashboard shows two scores: TransUnion + Equifax, both
on the VantageScore 3.0 model. We grab both. Layout drifts often,
so the parser is intentionally loose — it locates each score by
proximity to the bureau name rather than by a fragile selector chain.

Page structure historically looks like::

    <div class="score-card">
      <span class="bureau">TransUnion</span>
      <span class="score">742</span>
      <span class="model">VantageScore 3.0</span>
    </div>
    <div class="score-card">
      <span class="bureau">Equifax</span>
      <span class="score">738</span>
      ...

But CK ships A/B test variants frequently, so we fall back to a
"find a number 300..850 close to a bureau token" search if the
class-driven path returns nothing.
"""
from __future__ import annotations

import logging
import re
from datetime import date
from typing import Iterable

from bs4 import BeautifulSoup, Tag

from .base import CreditScoreScraperBase, ScrapedScore, auth_state_path

logger = logging.getLogger(__name__)

CREDIT_KARMA_URL = "https://www.creditkarma.com/credit-score"

# Tokens that appear near a score number — used by the loose fallback
# parser to attribute a number to a bureau.
_BUREAU_TOKENS = {
    "transunion": "transunion",
    "trans union": "transunion",
    "tu": "transunion",
    "equifax": "equifax",
    "ef": "equifax",
}

# A FICO/Vantage score is always 300..850, occasionally 250..900 across
# scoring models. Be permissive in the regex but validate the range.
_NUMBER_RE = re.compile(r"\b([2-9]\d{2})\b")


def _looks_like_score(n: int) -> bool:
    return 250 <= n <= 900


def _bureau_from_token(text: str) -> str | None:
    low = text.lower()
    for token, bureau in _BUREAU_TOKENS.items():
        if token in low:
            return bureau
    return None


class CreditKarmaScraper(CreditScoreScraperBase):
    site_key = "credit_karma"
    name = "Credit Karma"

    def parse(self, html: str) -> list[ScrapedScore]:
        if not html:
            return []
        soup = BeautifulSoup(html, "html.parser")
        scores: list[ScrapedScore] = []
        today = date.today()

        # ------- Primary path: class-keyed score-card tiles -------
        for tile in soup.select(".score-card, [data-testid*='score-card']"):
            bureau_el = tile.select_one(".bureau, [data-testid*='bureau']")
            score_el = tile.select_one(".score, [data-testid*='score-value']")
            if not (bureau_el and score_el):
                continue
            bureau = _bureau_from_token(bureau_el.get_text(" ", strip=True))
            num_match = _NUMBER_RE.search(score_el.get_text(" ", strip=True))
            if not (bureau and num_match):
                continue
            num = int(num_match.group(1))
            if not _looks_like_score(num):
                continue
            scores.append(
                ScrapedScore(
                    site_key=self.site_key,
                    score=num,
                    bureau=bureau,
                    scoring_model="vantagescore3",
                    as_of=today,
                    source_detail=f"Credit Karma · {bureau.title()}",
                    raw_text=tile.get_text(" ", strip=True)[:280],
                )
            )

        if scores:
            return scores

        # ------- Fallback path: scan body text for "<bureau> ... <num>" -------
        # Used when CK ships a layout we don't recognize. False-positive risk
        # is lowered by requiring the number to be score-shaped AND within 80
        # characters of a bureau token.
        body_text = soup.get_text(" ", strip=True)
        for match in _NUMBER_RE.finditer(body_text):
            num = int(match.group(1))
            if not _looks_like_score(num):
                continue
            window = body_text[max(0, match.start() - 80) : match.end() + 80]
            bureau = _bureau_from_token(window)
            if not bureau:
                continue
            # De-dupe: if we already captured this bureau on this page,
            # keep the first occurrence (closest to the dashboard's "your score" hero).
            if any(s.bureau == bureau for s in scores):
                continue
            scores.append(
                ScrapedScore(
                    site_key=self.site_key,
                    score=num,
                    bureau=bureau,
                    scoring_model="vantagescore3",
                    as_of=today,
                    source_detail=f"Credit Karma · {bureau.title()} (loose match)",
                    raw_text=window[:280],
                )
            )
            if len(scores) >= 2:  # CK only shows TU + EF
                break
        return scores

    def fetch_html(self) -> Iterable[str]:
        """Live fetch via Playwright using the saved auth state."""
        from playwright.sync_api import sync_playwright  # noqa: WPS433

        state_path = auth_state_path(self.site_key)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(storage_state=str(state_path))
            page = ctx.new_page()
            page.goto(CREDIT_KARMA_URL, wait_until="networkidle", timeout=30_000)
            # Score widgets render via React; give them a moment.
            page.wait_for_timeout(1500)
            html = page.content()
            ctx.close()
            browser.close()
            yield html


SPEC_NAME = "credit_karma"
