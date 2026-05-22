"""TopClassActions.com listings scraper.

Why pick this site
------------------
TCA is one of the highest-velocity aggregators of US class-action
settlements — they post 5-15 new ones a week. The structure is a
predictable WordPress install (category/open-class-action-settlements/),
so a tiny scraper covers a lot of ground.

Strategy
--------
1. Hit ``/category/open-class-action-settlements/`` to get a list of
   recent post URLs.
2. For each post URL, fetch the detail page and parse:
   * Title → ``name``
   * The "Claim Form Deadline:" / "Deadline" line → ``claim_deadline``
   * The "Estimated Award:" line → ``estimated_payout_cents``
   * Body prose → run through ``classify_proof`` for the
     ``proof_status`` heuristic.
   * The "case_number" / "settlement administrator" lines → those
     fields if present.

Robustness
----------
TCA's markup drifts. We treat every extraction as best-effort: if we
can't find the title we ``return None`` and the coordinator counts it
as ``skipped`` rather than blowing up the whole run. The header-style
parser is loose-tolerant for the same reason — we look for keyword:
value patterns inside lists and paragraphs alike.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Iterable
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from .base import LegalClaimScraper, ScrapedClaim, ScrapedListing
from .proof_heuristic import classify_proof

logger = logging.getLogger(__name__)

LISTINGS_URL = "https://topclassactions.com/lawsuit-settlements/open-lawsuit-settlements/"

# Additional index pages to widen coverage. TCA splits listings across
# multiple feeds depending on stage / category — pulling all four
# captures ~3-5x more active settlements than the one-feed approach.
ADDITIONAL_INDEX_URLS: tuple[str, ...] = (
    "https://topclassactions.com/lawsuit-settlements/open-lawsuit-settlements/",
    "https://topclassactions.com/lawsuit-settlements/closed-settlements/",
    "https://topclassactions.com/lawsuit-settlements/consumer-products-product-liabilities/",
    "https://topclassactions.com/lawsuit-settlements/money/",
    "https://topclassactions.com/lawsuit-settlements/auto-news-class-actions/",
    "https://topclassactions.com/lawsuit-settlements/employment-labor/",
    # State-specific index pages — Settlemate's screenshot showed
    # California, Colorado, Connecticut tabs with 22-31 listings each;
    # those listings live on TCA but we weren't fanning out to them.
    # Hitting the per-state TCA tag pages dramatically widens coverage
    # of state-eligible no-proof claims (which is what Chris flagged
    # as missing). Top-population states first; add more as needed.
    "https://topclassactions.com/state/california/",
    "https://topclassactions.com/state/texas/",
    "https://topclassactions.com/state/florida/",
    "https://topclassactions.com/state/new-york/",
    "https://topclassactions.com/state/illinois/",
    "https://topclassactions.com/state/pennsylvania/",
    "https://topclassactions.com/state/ohio/",
    "https://topclassactions.com/state/georgia/",
    "https://topclassactions.com/state/michigan/",
    "https://topclassactions.com/state/north-carolina/",
    "https://topclassactions.com/state/colorado/",
    "https://topclassactions.com/state/connecticut/",
    "https://topclassactions.com/state/washington/",
    "https://topclassactions.com/state/massachusetts/",
    "https://topclassactions.com/state/arizona/",
)

# A "real" TCA settlement post URL is one of:
#   /lawsuit-settlements/<some-multi-word-slug>/
#   /lawsuit-settlements/<category>/<some-multi-word-slug>/
#   /news/<some-multi-word-slug>/  (TCA's newer post home)
#
# A "multi-word slug" requires at least one hyphen and ≥ 12 chars —
# that filters out single-word category nodes like
# /lawsuit-settlements/money/ which are index pages, not listings.
# The fallback selector previously grabbed those as ghost claims
# (#100 finding); this constraint is the primary defense, with
# the known-nav-title set as backup.
_LISTING_URL_RE = re.compile(
    r"^https?://(?:www\.)?topclassactions\.com/"
    # Accepted prefixes for canonical post URLs:
    #   /lawsuit-settlements/<slug>/
    #   /lawsuit-settlements/<category>/<slug>/
    #   /news/<slug>/
    #   /state/<state>/<slug>/  ← state index pages link to posts under
    #                             /state/<state>/ as well as canonical paths
    r"(?:lawsuit-settlements/(?:[a-z0-9][a-z0-9\-]+/)?|news/|state/[a-z\-]+/)"
    r"([a-z0-9][a-z0-9\-]{11,})/?$",
    re.I,
)

# Defense-in-depth: even if a URL slips past the shape check, drop
# anchors whose text is a known TCA category label. These titles get
# extracted from category-index pages and are NEVER actual claim names.
_KNOWN_NAV_TITLES: frozenset[str] = frozenset(
    s.lower() for s in (
        "open class action settlements",
        "open lawsuit settlements",
        "lawsuits to join",
        "legal news",
        "product recalls",
        "lawsuits and settlements",
        "lawsuit settlements",
        "investigations",
        "consumer news",
    )
)

# Money like "$25", "$1,250.50", "up to $125"
_MONEY_RE = re.compile(r"\$([\d,]+(?:\.\d+)?)")

# A few common keyword labels TCA uses inline. We match on the
# normalized text of the line / list item so spacing / nbsp drift
# doesn't matter.
_LABEL_PATTERNS: dict[str, re.Pattern[str]] = {
    "deadline": re.compile(
        r"(?:claim\s+form\s+)?deadline[:\s]\s*(.+)", re.I
    ),
    "payout": re.compile(
        r"(?:estimated\s+)?(?:award|payout|payment)[:\s]\s*(.+)", re.I
    ),
    "proof": re.compile(
        r"proof\s+of\s+purchase[:\s]\s*(.+)", re.I
    ),
    "administrator": re.compile(
        r"(?:settlement\s+)?administrator[:\s]\s*(.+)", re.I
    ),
    "case_number": re.compile(
        r"(?:case|docket)\s+(?:number|no\.?)[:\s]\s*(.+)", re.I
    ),
    "eligibility": re.compile(
        r"(?:class\s+members?|who(?:'s|\s+is)\s+eligible)[:\s]\s*(.+)", re.I
    ),
}


# Date formats TCA mixes — try them in order. None of these include
# year-less variants because that ambiguity isn't worth the false
# positives (we'd rather show "no deadline" than the wrong year).
_DATE_FORMATS: tuple[str, ...] = (
    "%B %d, %Y",      # "March 14, 2026"
    "%b %d, %Y",      # "Mar 14, 2026"
    "%m/%d/%Y",       # "03/14/2026"
    "%Y-%m-%d",       # "2026-03-14"
)


def _parse_date(text: str):
    """Best-effort date parse. Returns ``date`` or ``None``."""
    # Trim and strip stray punctuation that often trails dates.
    cleaned = re.sub(r"[\s,;\.]+$", "", text).strip()
    # Aggregator sites often write "March 14, 2026 (postmark)" — keep
    # only the leading date-shaped substring.
    m = re.search(
        r"\b(?:[A-Z][a-z]+\s+\d{1,2},\s+\d{4}|"
        r"\d{1,2}/\d{1,2}/\d{4}|"
        r"\d{4}-\d{2}-\d{2})\b",
        cleaned,
    )
    if not m:
        return None
    candidate = m.group(0)
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(candidate, fmt).date()
        except ValueError:
            continue
    return None


def _parse_money_cents(text: str) -> int | None:
    """First $-amount in the string, in cents. Returns None if nothing matches.

    "Up to $X" is normal aggregator phrasing — we capture X and let
    the proof heuristic flag the row as needing proof to actually get
    that high payout.
    """
    m = _MONEY_RE.search(text)
    if not m:
        return None
    raw = m.group(1).replace(",", "")
    try:
        return int(round(float(raw) * 100))
    except ValueError:
        return None


class TopClassActionsScraper:
    """Scraper for TopClassActions.com open-settlement listings."""

    name = "topclassactions"

    def __init__(
        self,
        listings_url: str = LISTINGS_URL,
        max_listings: int = 100,
        index_urls: tuple[str, ...] | None = None,
    ):
        # ``max_listings`` is a circuit breaker. Bumped 30 → 100 in the
        # multi-feed expansion (2026-04-27): with 6 index pages we
        # commonly see 50-80 active listings, and capping at 30 was
        # silently dropping half of them.
        self.listings_url = listings_url
        self.max_listings = max_listings
        self.index_urls = (
            tuple(index_urls)
            if index_urls is not None
            else ADDITIONAL_INDEX_URLS
        )

    # ------------------------------------------------------------------
    # Network layer
    # ------------------------------------------------------------------

    def fetch_pages(self, client: httpx.Client) -> Iterable[ScrapedListing]:
        """Fan out across every index URL, dedupe + cap, fetch detail pages.

        Pulls each index page, accumulates listing URLs, dedupes (some
        listings appear in multiple categories), and walks up to
        ``max_listings``. Detail-page fetch errors don't stop the run.
        """
        seen: set[str] = set()
        all_urls: list[str] = []
        for index_url in self.index_urls or (self.listings_url,):
            try:
                resp = client.get(index_url)
                resp.raise_for_status()
            except httpx.HTTPError as e:
                logger.warning("TCA index fetch failed for %s: %r", index_url, e)
                continue
            for url in self._extract_listing_urls(resp.text, base=index_url):
                if url in seen:
                    continue
                seen.add(url)
                all_urls.append(url)
        logger.info("TCA found %d unique listing URLs across %d index pages",
                    len(all_urls), len(self.index_urls or (self.listings_url,)))
        for url in all_urls[: self.max_listings]:
            try:
                detail = client.get(url)
                detail.raise_for_status()
            except httpx.HTTPError as e:
                logger.info("TCA detail fetch failed for %s: %r", url, e)
                continue
            yield ScrapedListing(url=url, html=detail.text)

    # ------------------------------------------------------------------
    # HTML extraction (pure functions — testable with fixtures)
    # ------------------------------------------------------------------

    def _extract_listing_urls(self, html: str, *, base: str) -> list[str]:
        """Find post URLs on the index page.

        TCA's WordPress theme exposes posts as ``<h2 class="entry-title">
        <a href="...">``. We pick those up first; if the markup has
        drifted, we fall back to any ``<a>`` whose href looks like a
        settlement post — but the href has to match the
        ``_LISTING_URL_RE`` shape (slug under /lawsuit-settlements/),
        and the anchor text can't be a known nav label. Without those
        guards the fallback grabbed TCA's own category links and
        produced ghost rows like "Open Class Action Settlements".
        """
        soup = BeautifulSoup(html, "html.parser")
        urls: list[str] = []
        seen: set[str] = set()

        def _accept(href: str | None, text: str | None) -> str | None:
            if not href:
                return None
            absolute = urljoin(base, href)
            if absolute in seen:
                return None
            if not _LISTING_URL_RE.match(absolute):
                return None
            if text and text.strip().lower() in _KNOWN_NAV_TITLES:
                return None
            return absolute

        # Primary selector — entry titles on the listings index.
        for h in soup.select("h2.entry-title a, h3.entry-title a"):
            absolute = _accept(h.get("href"), h.get_text(strip=True))
            if absolute:
                seen.add(absolute)
                urls.append(absolute)

        # Fallback if the theme changed. Same accept() guards apply,
        # so even a wider net can't readmit nav cruft.
        if not urls:
            for a in soup.find_all("a", href=True):
                absolute = _accept(a["href"], a.get_text(strip=True))
                if absolute:
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
        # Trim site-name suffix that <title> tags carry: "X | TopClassActions"
        name = re.sub(r"\s*[|\-–]\s*top\s*class\s*actions.*$", "", name, flags=re.I)

        # Body text — used both for label-line extraction and for the
        # proof-requirement classifier. We pull from the article body
        # if WordPress exposes one; otherwise fall back to the whole page.
        body = soup.find("article") or soup.find("div", class_="entry-content") or soup
        body_text = body.get_text(" ", strip=True)

        labels = _extract_labels(body)

        deadline = _parse_date(labels.get("deadline", "")) if labels.get("deadline") else None
        payout_cents = (
            _parse_money_cents(labels.get("payout", "")) if labels.get("payout") else None
        )
        # If the labelled extraction missed but the body has one $ amount
        # near the word "estimated", that's still good signal.
        if payout_cents is None:
            m = re.search(r"estimated\s+(?:award|payment)[^$]{0,40}\$([\d,]+)", body_text, re.I)
            if m:
                payout_cents = _parse_money_cents("$" + m.group(1))

        proof_status, _score = classify_proof(body_text)

        return ScrapedClaim(
            name=name,
            source_url=listing.url,
            administrator=labels.get("administrator"),
            case_number=labels.get("case_number"),
            description=_first_paragraph(body),
            eligibility=labels.get("eligibility"),
            proof_status=proof_status,
            estimated_payout_cents=payout_cents,
            claim_deadline=deadline,
        )


def _extract_labels(node) -> dict[str, str]:
    """Walk list items and paragraphs looking for ``Label: value`` pairs.

    Aggregator pages tend to mix bulleted-fact lists with prose. We
    iterate both, run the label regex on each chunk's text, and take
    the first match per label slot.
    """
    found: dict[str, str] = {}
    chunks: list[str] = []
    for tag in node.find_all(["li", "p", "strong"]):
        text = tag.get_text(" ", strip=True)
        if text:
            chunks.append(text)

    for chunk in chunks:
        for slot, pat in _LABEL_PATTERNS.items():
            if slot in found:
                continue
            m = pat.search(chunk)
            if m:
                value = m.group(1).strip()
                # If a "Deadline" label captured trailing context like
                # "March 14, 2026 (postmark deadline)", trim aggressively.
                value = re.sub(r"\s+", " ", value).strip()
                if value:
                    found[slot] = value
    return found


def _first_paragraph(node) -> str | None:
    """Pull the first non-trivial paragraph as the claim description.

    Skips paragraphs shorter than 30 chars (usually navigational like
    "Class action news"). Truncates at ~600 chars so the DB column
    stays manageable.
    """
    for p in node.find_all("p"):
        text = p.get_text(" ", strip=True)
        if len(text) < 30:
            continue
        return text[:600]
    return None
