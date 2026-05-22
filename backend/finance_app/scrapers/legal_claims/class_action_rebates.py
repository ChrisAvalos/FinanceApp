"""ClassActionRebates.com scraper.

Third pilot source. CAR is a community-curated rebate aggregator —
their site lists settlements by tag (e.g. "no-proof") with the
estimated payout per claim in the listing card itself. That makes it
particularly good for surfacing "quick wins" (no-proof claims), which
is the most actionable bucket for the user.

Markup is simpler than TCA / CAO: a card grid of post titles with
explicit deadline + value tags. We extract:

* Title (h2/h3 inside .post-card)
* "Deadline" pill → ``claim_deadline``
* "$X" pill or inline value → ``estimated_payout_cents``
* "Proof Required: No" / "Yes" → forces the proof heuristic in that
  direction so we don't have to re-classify
* Outbound link to the official settlement page (when CAR links out)

We run multiple index pages (open / no-proof / paid out) like TCA.
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


# CAR has a few index views. The tag-filtered ones are the highest
# signal — esp. /tag/no-proof which lists exactly the quick-win
# claims the user wants.
INDEX_URLS: tuple[str, ...] = (
    "https://classactionrebates.com/open-class-action-settlements/",
    "https://classactionrebates.com/tag/no-proof/",
    "https://classactionrebates.com/tag/quick-claim/",
    "https://classactionrebates.com/category/data-breach/",
    "https://classactionrebates.com/category/consumer-products/",
)


# A "real" CAR settlement post URL is /<slug-with-hyphens>/ at the
# top level. Tag/category pages don't match (they're under /tag/ or
# /category/). Length floor of 12 weeds out short navigational links.
_LISTING_URL_RE = re.compile(
    r"^https?://(?:www\.)?classactionrebates\.com/"
    r"([a-z0-9][a-z0-9\-]{11,})/?$",
    re.I,
)

# Proof-required pill on the listing or detail page.
_PROOF_REQUIRED_RE = re.compile(
    r"proof\s+required[:\s]+(yes|no|none|n/a)", re.I
)


class ClassActionRebatesScraper:
    name = "class_action_rebates"

    def __init__(self, listings_url: str = INDEX_URLS[0], max_listings: int = 80):
        self.listings_url = listings_url
        self.max_listings = max_listings

    # ------------------------------------------------------------------

    def fetch_pages(self, client: httpx.Client) -> Iterable[ScrapedListing]:
        seen: set[str] = set()
        all_urls: list[str] = []
        for index_url in INDEX_URLS:
            try:
                resp = client.get(index_url)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                logger.warning("CAR index fetch failed for %s: %r", index_url, e)
                continue
            for url in self._extract_listing_urls(resp.text, base=index_url):
                if url in seen:
                    continue
                seen.add(url)
                all_urls.append(url)
        logger.info("CAR found %d unique listing URLs", len(all_urls))
        for url in all_urls[: self.max_listings]:
            try:
                detail = client.get(url)
                detail.raise_for_status()
            except httpx.HTTPError as e:
                logger.info("CAR detail fetch failed for %s: %r", url, e)
                continue
            yield ScrapedListing(url=url, html=detail.text)

    # ------------------------------------------------------------------

    def _extract_listing_urls(self, html: str, *, base: str) -> list[str]:
        soup = BeautifulSoup(html, "html.parser")
        urls: list[str] = []
        seen: set[str] = set()
        for a in soup.find_all("a", href=True):
            href = a["href"]
            absolute = urljoin(base, href)
            if absolute in seen:
                continue
            if not _LISTING_URL_RE.match(absolute):
                continue
            seen.add(absolute)
            urls.append(absolute)
        return urls

    def parse(self, listing: ScrapedListing) -> ScrapedClaim | None:
        soup = BeautifulSoup(listing.html, "html.parser")

        title_tag = (
            soup.find("h1", class_="entry-title")
            or soup.find("h1")
            or soup.find("title")
        )
        if title_tag is None:
            return None
        name = title_tag.get_text(strip=True)
        if not name:
            return None
        # Trim site-name suffix
        name = re.sub(
            r"\s*[|\-–]\s*class\s*action\s*rebates.*$", "", name, flags=re.I
        )

        body = (
            soup.find("article")
            or soup.find("div", class_="entry-content")
            or soup
        )
        body_text = body.get_text(" ", strip=True)

        # CAR explicit proof tag overrides the heuristic when present.
        m = _PROOF_REQUIRED_RE.search(body_text)
        if m:
            answer = m.group(1).lower()
            if answer in ("no", "none", "n/a"):
                proof_status_explicit = "not_required"
            else:
                proof_status_explicit = "required"
        else:
            proof_status_explicit = None

        # Use the heuristic as backup
        if proof_status_explicit:
            from .proof_heuristic import ProofRequirement
            proof_status = ProofRequirement(proof_status_explicit)
        else:
            proof_status, _ = classify_proof(body_text)

        # Money: look for the per-claimant pattern first.
        payout = _parse_money_cents(body_text)

        # Deadline
        deadline_re = re.search(
            r"(?:claim\s+form\s+|file\s+)?deadline[:\s]+(.+?)(?:\.|<|\n)",
            body_text,
            re.I,
        )
        deadline = _parse_date(deadline_re.group(1)) if deadline_re else None

        # First-paragraph description
        description: str | None = None
        for p in body.find_all("p"):
            text = p.get_text(" ", strip=True)
            if len(text) >= 30:
                description = text[:600]
                break

        return ScrapedClaim(
            name=name,
            source_url=listing.url,
            administrator=None,
            case_number=None,
            description=description,
            eligibility=None,
            proof_status=proof_status,
            estimated_payout_cents=payout,
            claim_deadline=deadline,
        )
