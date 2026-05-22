"""ClassAction.org settlements scraper.

ClassAction.org is the second pilot source. Markup differs noticeably
from TopClassActions: the listings index lives at
``/lawsuit-settlements/`` and detail pages tend to be longer-form
articles with a "How to File a Claim" sidebar. The label-extraction
approach still works — different selectors, same idea.

What we extract
---------------
* Title (h1) → ``name``
* Detail page prose → proof heuristic + first paragraph as description
* Embedded "Eligible Class Members" / "Settlement Deadline" sections
  → eligibility / deadline if present
* Money pattern in headline "X agrees to $Y settlement" or
  "Up to $Z per class member" → estimated_payout_cents (per-claimant
  estimate where extractable; otherwise None — better than wrong)

ClassAction.org tends to write payouts as fund totals more than
TCA does — we've biased toward only capturing values that look
per-claimant ("per class member", "up to $X"). A multi-million-dollar
fund total isn't useful as ``estimated_payout_cents`` for any one
filer.
"""
from __future__ import annotations

import logging
import re
from typing import Iterable
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from .base import LegalClaimScraper, ScrapedClaim, ScrapedListing
from .proof_heuristic import classify_proof
from .top_class_actions import _parse_date, _parse_money_cents

logger = logging.getLogger(__name__)

LISTINGS_URL = "https://www.classaction.org/open-lawsuit-settlements"

# Per-claimant phrasing patterns. Capture only the first $-amount
# that's followed by an obviously-personal qualifier.
_PER_CLAIMANT_RE = re.compile(
    r"(?:up\s+to\s+)?\$([\d,]+(?:\.\d+)?)\s+"
    r"(?:per\s+(?:class\s+member|claimant|household|user|consumer)|"
    r"each)",
    re.I,
)


class ClassActionOrgScraper:
    name = "classaction_org"

    def __init__(self, listings_url: str = LISTINGS_URL, max_listings: int = 80):
        # Bumped 30 → 80 in the multi-feed expansion (2026-04-27).
        # Coordinator caps total runtime so this doesn't slow scrapes;
        # it just means we're not silently dropping half the feed.
        self.listings_url = listings_url
        self.max_listings = max_listings

    # ------------------------------------------------------------------
    # Network
    # ------------------------------------------------------------------

    def fetch_pages(self, client: httpx.Client) -> Iterable[ScrapedListing]:
        try:
            resp = client.get(self.listings_url)
            resp.raise_for_status()
        except httpx.HTTPError as e:
            logger.warning("ClassAction.org index fetch failed: %r", e)
            return

        urls = self._extract_listing_urls(resp.text, base=self.listings_url)
        for url in urls[: self.max_listings]:
            try:
                detail = client.get(url)
                detail.raise_for_status()
            except httpx.HTTPError as e:
                logger.info("ClassAction.org detail fetch failed for %s: %r", url, e)
                continue
            yield ScrapedListing(url=url, html=detail.text)

    # ------------------------------------------------------------------
    # Pure HTML → ScrapedClaim
    # ------------------------------------------------------------------

    def _extract_listing_urls(self, html: str, *, base: str) -> list[str]:
        """Pull settlement detail URLs off the listings index.

        ClassAction.org renders cards like ``<a class="card" href="...">``;
        we ignore non-settlement links by requiring "settlement" or
        "class-action" in the slug.
        """
        soup = BeautifulSoup(html, "html.parser")
        urls: list[str] = []
        seen: set[str] = set()
        for a in soup.find_all("a", href=True):
            href = a["href"]
            absolute = urljoin(base, href)
            if absolute in seen:
                continue
            slug = href.lower()
            # Heuristic: detail pages live under /lawsuit-settlements/<name>
            # or /open-lawsuit-settlements/<name>.
            if "/lawsuit-settlements/" not in slug and "open-lawsuit-settlements" not in slug:
                continue
            # Skip the listings index itself.
            if absolute.rstrip("/") == base.rstrip("/"):
                continue
            seen.add(absolute)
            urls.append(absolute)
        return urls

    def parse(self, listing: ScrapedListing) -> ScrapedClaim | None:
        soup = BeautifulSoup(listing.html, "html.parser")

        title_tag = soup.find("h1") or soup.find("title")
        if title_tag is None:
            return None
        name = title_tag.get_text(strip=True)
        if not name:
            return None
        name = re.sub(r"\s*[|\-–]\s*classaction\.org.*$", "", name, flags=re.I)

        body = (
            soup.find("article")
            or soup.find("main")
            or soup.find("div", class_="entry-content")
            or soup
        )
        body_text = body.get_text(" ", strip=True)

        # Deadline — look for "Deadline:" or "Claim Deadline:" headings.
        deadline = None
        m_deadline = re.search(
            r"(?:claim\s+(?:form\s+)?)?deadline[:\s]+([^.]+)",
            body_text,
            re.I,
        )
        if m_deadline:
            deadline = _parse_date(m_deadline.group(1))

        # Per-claimant payout — only capture amounts that look personal.
        payout_cents: int | None = None
        m_per = _PER_CLAIMANT_RE.search(body_text)
        if m_per:
            payout_cents = _parse_money_cents("$" + m_per.group(1))

        proof_status, _score = classify_proof(body_text)

        eligibility = None
        m_elig = re.search(
            r"(?:who\s+(?:is|qualifies)|eligible\s+class\s+members?)[:\s]+([^.]{20,300})",
            body_text,
            re.I,
        )
        if m_elig:
            eligibility = m_elig.group(1).strip()

        # Description — first long paragraph.
        description = None
        for p in body.find_all("p"):
            text = p.get_text(" ", strip=True)
            if len(text) >= 40:
                description = text[:600]
                break

        return ScrapedClaim(
            name=name,
            source_url=listing.url,
            description=description,
            eligibility=eligibility,
            proof_status=proof_status,
            estimated_payout_cents=payout_cents,
            claim_deadline=deadline,
        )


# Required for Protocol conformance check at registration time
_: LegalClaimScraper = ClassActionOrgScraper()
