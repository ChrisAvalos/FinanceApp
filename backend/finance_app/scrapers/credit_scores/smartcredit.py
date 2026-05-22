"""SmartCredit.com credit-score scraper.

SmartCredit is a paid 3-bureau credit-monitoring service. It refreshes
the user's TransUnion + Experian + Equifax reports together and shows
**VantageScore 3.0** for each bureau on a single page. (The base
plan does NOT expose FICO scores — that's a different SmartCredit tier.
Don't try to scrape FICO from this page; it isn't there.)

Scope of THIS scraper
---------------------
Pull all three bureau VantageScore 3.0 scores in one fetch. We emit
three :class:`ScrapedScore` rows per scrape — one per bureau — with
``scoring_model = "vantagescore3"``. The natural-key dedupe on
(bureau, model, as_of, source) keeps re-runs idempotent.

Layout (observed 2026-05)
-------------------------
The "3B Report & VantageScores 3.0" page renders the three bureau
scores side by side under a single ``Credit Scores`` heading. Each
score is a large display number (~96px) with the bureau label as a
small caption directly above it::

    TransUnion®   Experian®   Equifax®
        702          699         707

We parse this with a label-anchored heuristic: find each bureau's
label in the rendered text, then pick the nearest score-shaped number
(250..900) within a short window. This is robust to React class-name
churn — the labels rarely change, the layout rarely changes, only
the wrapping classes do.

Dashboard URL after login
-------------------------
``https://www.smartcredit.com/member/credit-report/smart-3b/``

The post-login landing page is ``/member/home/`` (which shows a single
headline ScoreTracker number, also VantageScore 3.0). We deliberately
go to the 3B page instead so we get all three bureaus per fetch.

Auth-state bootstrap
--------------------
One-time::

    python -m finance_app.scrapers.credit_scores.bootstrap smartcredit

Opens a real Chromium window, the user logs in (with 2FA if the
account requires it), the helper saves the cookies. Daily cron does
the rest headlessly.
"""
from __future__ import annotations

import logging
import re
from datetime import date
from typing import Iterable

from bs4 import BeautifulSoup

from .base import CreditScoreScraperBase, ScrapedScore, auth_state_path

logger = logging.getLogger(__name__)

# 3B (three-bureau) report page — gives us TU + EX + EQ in one fetch.
SMARTCREDIT_URL = "https://www.smartcredit.com/member/credit-report/smart-3b/"

# A FICO/Vantage score is always 300..850; permissive regex + range guard.
# We match 3-digit numbers starting 2..9 to leave headroom for partial
# OCR-like off-by-ones, then range-check below.
_NUMBER_RE = re.compile(r"\b([2-9]\d{2})\b")


def _looks_like_score(n: int) -> bool:
    return 250 <= n <= 900


# Each bureau's display label on the 3B page. We match case-insensitively
# and tolerate the trademark glyph (the page renders "TransUnion®" etc).
# Order matters only for tie-breaking; otherwise these are independent.
_BUREAU_LABELS: list[tuple[str, list[str]]] = [
    ("transunion", ["transunion", "trans union"]),
    ("experian", ["experian"]),
    ("equifax", ["equifax"]),
]

# How far (in characters of compressed body text) to look for a score
# after seeing a bureau label. The 3B page renders them very close
# together — score appears within ~80 chars of its label — but we give
# ourselves a generous window in case SmartCredit injects a tooltip or
# legend between them. False-positive risk stays low because the score
# range filter (250..900) excludes most other 3-digit numbers.
_SCORE_WINDOW_CHARS = 200


class SmartCreditScraper(CreditScoreScraperBase):
    site_key = "smartcredit"
    name = "SmartCredit"

    def parse(self, html: str) -> list[ScrapedScore]:
        if not html:
            return []
        soup = BeautifulSoup(html, "html.parser")
        # We collapse whitespace because the 3B page wraps each score in
        # its own React component, producing odd spacing in the raw text.
        body_text = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))
        if not body_text:
            return []

        today = date.today()
        scores: list[ScrapedScore] = []
        seen_bureaus: set[str] = set()

        # --------- Label-anchored extraction ---------
        # For each bureau, find every occurrence of its label in the
        # body text and grab the first score-shaped number in the
        # SCORE_WINDOW_CHARS that follows. Stop at the first plausible
        # hit so we don't pick up the bureau's name appearing in
        # marketing copy further down the page.
        for bureau, label_variants in _BUREAU_LABELS:
            score = self._find_score_after_label(body_text, label_variants)
            if score is None:
                logger.debug("SmartCredit: no score found for %s", bureau)
                continue
            scores.append(
                ScrapedScore(
                    site_key=self.site_key,
                    score=score,
                    bureau=bureau,
                    scoring_model="vantagescore3",
                    as_of=today,
                    source_detail=f"SmartCredit · {bureau.title()} VantageScore 3.0",
                    raw_text=None,
                )
            )
            seen_bureaus.add(bureau)

        if scores:
            return scores

        # --------- Fallback: all three scores in a row ---------
        # If label anchoring fails (e.g. SmartCredit relabels "TransUnion"
        # to "TU" or wraps it in an SVG), look for the canonical
        # three-scores-in-a-row pattern: three score-shaped numbers
        # within ~120 chars of each other AND within reach of the
        # phrase "Credit Scores" or "VantageScore". Map them positionally
        # to TU/EX/EQ since that's the page's layout order.
        anchor_idx = self._find_anchor_idx(body_text)
        if anchor_idx is None:
            return scores

        # Search the 600 chars after the anchor for 3 score-shaped numbers.
        window = body_text[anchor_idx : anchor_idx + 600]
        triplet = self._first_score_triplet(window)
        if triplet is None:
            return scores
        bureaus_in_order = ["transunion", "experian", "equifax"]
        for bureau, score in zip(bureaus_in_order, triplet):
            if bureau in seen_bureaus:
                continue
            scores.append(
                ScrapedScore(
                    site_key=self.site_key,
                    score=score,
                    bureau=bureau,
                    scoring_model="vantagescore3",
                    as_of=today,
                    source_detail=(
                        f"SmartCredit · {bureau.title()} VantageScore 3.0 (positional)"
                    ),
                    raw_text=None,
                )
            )
        return scores

    # ----- helpers -----

    @staticmethod
    def _find_score_after_label(
        body_text: str, label_variants: list[str]
    ) -> int | None:
        """First score-shaped number within SCORE_WINDOW_CHARS of any
        matched bureau label. Case-insensitive, picks earliest match."""
        low = body_text.lower()
        best_pos: int | None = None
        best_score: int | None = None
        for variant in label_variants:
            start = 0
            while True:
                idx = low.find(variant, start)
                if idx == -1:
                    break
                window = body_text[idx + len(variant) : idx + len(variant) + _SCORE_WINDOW_CHARS]
                m = _NUMBER_RE.search(window)
                if m:
                    n = int(m.group(1))
                    if _looks_like_score(n):
                        # Prefer the earliest hit — labels later on the
                        # page are usually marketing/footer mentions.
                        if best_pos is None or idx < best_pos:
                            best_pos = idx
                            best_score = n
                        break  # stop scanning this variant; take first hit
                start = idx + len(variant)
        return best_score

    @staticmethod
    def _find_anchor_idx(body_text: str) -> int | None:
        """Index of the most likely 3B header in the page text.

        Anchors on phrases that bracket the score row above. Returns the
        earliest match so we anchor near the headline scores, not the
        recap section further down.
        """
        anchors = ["credit scores", "vantagescores", "vantage scores", "3b report"]
        low = body_text.lower()
        candidates: list[int] = []
        for a in anchors:
            i = low.find(a)
            if i != -1:
                candidates.append(i)
        return min(candidates) if candidates else None

    @staticmethod
    def _first_score_triplet(window: str) -> tuple[int, int, int] | None:
        """Three score-shaped ints in a row from a slice of body text.
        Used as the positional fallback when bureau labels are missing."""
        nums: list[int] = []
        for m in _NUMBER_RE.finditer(window):
            n = int(m.group(1))
            if _looks_like_score(n):
                nums.append(n)
                if len(nums) == 3:
                    return (nums[0], nums[1], nums[2])
        return None

    def fetch_html(self) -> Iterable[str]:
        """Live fetch via Playwright using the saved auth state.

        SmartCredit gates the dashboard behind login + sometimes a
        second-factor SMS. The bootstrap flow handles both — by the
        time we land here, ``smartcredit.json`` already encodes a
        fresh session.

        We add a soft retry on the post-login redirect: SmartCredit's
        auth provider sometimes 302's twice before serving the report.
        ``wait_until="networkidle"`` plus the React render delay
        below covers it.
        """
        from playwright.sync_api import sync_playwright  # noqa: WPS433

        state_path = auth_state_path(self.site_key)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(storage_state=str(state_path))
            page = ctx.new_page()
            page.goto(SMARTCREDIT_URL, wait_until="networkidle", timeout=30_000)
            # 3B page renders score numbers via React after a data fetch.
            # 2.5s is comfortable on broadband; bump if you see flaky
            # parses under load.
            page.wait_for_timeout(2500)
            html = page.content()
            ctx.close()
            browser.close()
            yield html


SPEC_NAME = "smartcredit"
