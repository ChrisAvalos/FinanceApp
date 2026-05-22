"""Albert balance scraper — Sprint 43.

Why Albert
----------
Plaid's coverage of Albert only includes the Cash account. Savings
(Genius Savings) and Investing live at separate custodians that Albert
hasn't integrated with Plaid. The values are visible on the Albert web
dashboard at albert.com after login, so we scrape them.

Approach
--------
Standard Playwright pattern, mirroring the credit-score scrapers:

  1. Auth state lives at ``backend/.auth_state/albert.json``. The user
     bootstraps it once via
     ``python -m finance_app.scrapers.balances.bootstrap albert``.
  2. ``fetch_html`` headlessly opens albert.com, waits for the
     dashboard to render, returns the page HTML.
  3. ``parse`` extracts the per-product balances using a loose
     "find a dollar amount near the product name" strategy — same
     resilience trade-off Credit Karma's parser uses. Albert ships
     A/B variants, so we prefer attribute-keyed selectors but fall
     back to text scanning.

Output
------
Up to three :class:`ScrapedBalance` records per run (Cash, Savings,
Investing). The coordinator decides which to persist — typically just
Savings + Investing since Cash already comes from Plaid.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date
from typing import Iterable

from bs4 import BeautifulSoup

from .base import BalanceScraperBase, ScrapedBalance, auth_state_path

logger = logging.getLogger(__name__)


ALBERT_HOME_URL = "https://albert.com/"
# Per-product pages — confirmed by user-supplied screenshots
# 2026-05-12. The dashboard at albert.com/ shows rounded values
# ($234, $305) but the dedicated pages show precise cents ($234.33,
# $304.51). Hitting the dedicated pages also avoids the multi-tile
# parsing problem on the dashboard.
ALBERT_SAVINGS_URL = "https://albert.com/savings"
ALBERT_INVESTING_URL = "https://albert.com/investing"

# Headline-label patterns per product page. Each page is its own
# fetch, so we only need to find one balance per page — the heading
# label disambiguates which product we're on.
_LABEL_BALANCE = re.compile(r"\bbalance\b", re.IGNORECASE)
_LABEL_PORTFOLIO_VALUE = re.compile(r"\bportfolio\s+value\b", re.IGNORECASE)


# Dollar amount with cents. Permissive about whitespace because
# BeautifulSoup's get_text(" ", strip=True) inserts spaces between
# DOM nodes — Albert renders the cents portion ($234^.33) in a
# separate <sup>/<span> element, so the extracted text can read
# "$234 .33" rather than "$234.33". The optional whitespace + the
# explicit cents block handles both shapes.
_DOLLAR_RE = re.compile(
    r"-?\$\s*([0-9][0-9,]*)\s*\.\s*([0-9]{2})\b"
)
# Fallback when no cents portion is present ("$15", "$0").
_DOLLAR_INT_RE = re.compile(r"-?\$\s*([0-9][0-9,]*)(?!\s*[.\d])")


def _parse_dollars(text: str) -> int | None:
    """Convert the FIRST ``$X.XX`` or ``$X`` substring in ``text`` to cents.

    Handles Albert's split-cents rendering (``"$234 .33"``) by allowing
    arbitrary whitespace between the dollars and the decimal point.
    """
    if not text:
        return None
    m = _DOLLAR_RE.search(text)
    if m:
        dollars = m.group(1).replace(",", "")
        cents = m.group(2)
        try:
            return int(dollars) * 100 + int(cents)
        except ValueError:
            return None
    m2 = _DOLLAR_INT_RE.search(text)
    if m2:
        dollars = m2.group(1).replace(",", "")
        try:
            return int(dollars) * 100
        except ValueError:
            return None
    return None


@dataclass(frozen=True)
class _ProductPage:
    """One product-page fetch spec — URL + the label that anchors
    the balance + the canonical account fields we emit."""
    url: str
    label_pattern: re.Pattern[str]
    account_label: str
    account_type: str


_PRODUCT_PAGES: list[_ProductPage] = [
    _ProductPage(
        url=ALBERT_SAVINGS_URL,
        label_pattern=_LABEL_BALANCE,
        account_label="Albert Savings",
        account_type="savings",
    ),
    _ProductPage(
        url=ALBERT_INVESTING_URL,
        label_pattern=_LABEL_PORTFOLIO_VALUE,
        account_label="Albert Investing",
        account_type="investment",
    ),
]


class AlbertScraper(BalanceScraperBase):
    site_key = "albert"
    institution_name = "Albert"

    # Per-run state — populated by ``fetch_html`` so ``parse`` knows
    # which product page each yielded HTML chunk came from. This is
    # the cleanest way to thread the page context through the
    # base class's "iterate over yielded HTMLs and call parse on each"
    # contract without breaking the base API.
    _current_page: _ProductPage | None = None

    def parse(self, html: str) -> list[ScrapedBalance]:
        """Extract one balance from a single product-page's HTML.

        ``self._current_page`` tells us which product page this HTML
        is from. We anchor on that page's ``label_pattern`` (e.g.
        "Balance" on /savings, "Portfolio value" on /investing) and
        take the FIRST dollar amount that appears AFTER the label in
        the body text.

        Why "after the label" instead of "in the same tag": Albert
        renders the label and the value as siblings, not as parent +
        child, and the cents portion is in a separate <sup>/<span>
        element. The flattened body-text scan with a windowed search
        survives both these layout choices.
        """
        if not html or self._current_page is None:
            return []
        soup = BeautifulSoup(html, "html.parser")
        body_text = soup.get_text(" ", strip=True)
        page = self._current_page

        # Detect the "I'm not logged in" / 404 case early — if neither
        # the label NOR a generic dashboard-nav element appears, we're
        # on a marketing/error page and there's no balance to find.
        if not page.label_pattern.search(body_text):
            logger.warning(
                "Albert scraper: label %r not found on %s — likely "
                "auth-state didn't apply or layout changed",
                page.label_pattern.pattern, page.url,
            )
            return []

        # Take the first dollar amount that appears AFTER the label in
        # the flattened text. Search window is 200 chars — covers the
        # label-to-value gap with margin without picking up an
        # unrelated value from a card below.
        m = page.label_pattern.search(body_text)
        if not m:
            return []
        window = body_text[m.end(): m.end() + 200]
        cents = _parse_dollars(window)
        if cents is None:
            logger.warning(
                "Albert scraper: label %r found on %s but no $ amount "
                "in the 200-char window after it. Body excerpt: %r",
                page.label_pattern.pattern, page.url, window[:160],
            )
            return []
        return [
            ScrapedBalance(
                site_key=self.site_key,
                institution_name=self.institution_name,
                account_label=page.account_label,
                account_type=page.account_type,
                balance_cents=cents,
                as_of=date.today(),
                raw_text=(m.group(0) + " " + window)[:240],
            )
        ]

    def fetch_html(self) -> Iterable[str]:
        """Navigate each product page in turn, yield its HTML. Sets
        ``self._current_page`` BEFORE yielding so the base class's
        loop hands the right HTML to ``parse``.

        Each page also writes a per-page debug HTML + screenshot so
        we can inspect any individual page's parse failure
        independently. Files live at
        ``.auth_state/albert_debug_savings.{html,png}`` etc.
        """
        from playwright.sync_api import sync_playwright  # noqa: WPS433

        state_path = auth_state_path(self.site_key)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(storage_state=str(state_path))
            try:
                for page_cfg in _PRODUCT_PAGES:
                    self._current_page = page_cfg
                    slug = page_cfg.account_label.split()[-1].lower()
                    debug_html = state_path.with_name(
                        f"albert_debug_{slug}.html"
                    )
                    debug_png = state_path.with_name(
                        f"albert_debug_{slug}.png"
                    )
                    debug_url = state_path.with_name(
                        f"albert_debug_{slug}.url.txt"
                    )
                    page = ctx.new_page()
                    try:
                        page.goto(
                            page_cfg.url,
                            wait_until="networkidle",
                            timeout=30_000,
                        )
                        # React SPA — let the balance API round-trip.
                        page.wait_for_timeout(3_500)
                        html = page.content()
                        try:
                            debug_html.write_text(html, encoding="utf-8")
                            debug_url.write_text(page.url, encoding="utf-8")
                            page.screenshot(
                                path=str(debug_png), full_page=True,
                            )
                        except Exception:  # noqa: BLE001
                            logger.exception(
                                "Failed writing Albert debug artifacts for %s",
                                slug,
                            )
                        yield html
                    finally:
                        page.close()
            finally:
                ctx.close()
                browser.close()
                self._current_page = None


SPEC_NAME = "albert"
