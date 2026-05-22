"""Walmart deal scraper — HTTP-only PARSER, anti-bot intercept likely.

Status (2026-05)
----------------
The parser code below works correctly against captured HTML. But in
production from a non-residential IP, walmart.com redirects to
``/blocked`` with a PerimeterX "Robot or human?" challenge before we
ever see a search result page. The scraper's ``scrape()`` returns
None on the redirect (graceful), but in practice this means Walmart
never produces hits via plain HTTP from most IPs.

We keep this code in place because:

  1. Some user IPs (residential, certain ISPs) DO get past the PX
     gate. The parser will work for them.
  2. The parser is the right shape if we later run Walmart through
     Playwright — same DOM, same __NEXT_DATA__ blob, same JSON-LD
     fallback. Migration cost is just swapping the HTTP fetch for
     a Playwright headless render.

For the durable path, see target.py for the Playwright migration
plan — Walmart should follow the same shape (bootstrap once, save
storage state, headless-render the search page, parse the rendered
DOM with the helpers below).

Embedded data shapes
--------------------
Walmart embeds product data in two stable places per search page:

1. **``__NEXT_DATA__`` JSON blob** — Walmart uses Next.js. The
   ``props.pageProps.initialData.searchResult.itemStacks[0].items``
   array contains the full product list with prices, images, URLs.
   This is the primary parse target.

2. **JSON-LD ``ItemList`` with embedded ``Product`` items** — emitted
   for Google Shopping. Subset of the above but a stable fallback
   when Walmart shifts the Next.js shape.

We try ``__NEXT_DATA__`` first (richer), fall back to JSON-LD if
that fails (more durable). This belt-and-suspenders approach is the
same pattern as the SmartCredit parser.

Failure modes we handle
-----------------------
* Network error / timeout → return None
* 4xx (Walmart never 401s for keyword search; 403 means anti-bot
  tripped) → return None, log loud
* 200 with no data (empty search) → return None
* JSON shape drift → log + return None (caller treats as no-match)

We deliberately avoid raising. Coordinator contract is "return None
on no-match, raise on system error", and every error here is
recoverable.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date
from typing import Any

import requests

from .base import ScrapedPrice

logger = logging.getLogger(__name__)


_SEARCH_URL = "https://www.walmart.com/search"

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/123.0.0.0 Safari/537.36"
)

_REQUEST_TIMEOUT = 12  # seconds — Walmart usually answers in 1-3s


class WalmartScraper:
    """Real Walmart scraper — parses the SSR search page."""

    name: str = "walmart"
    requires_auth: bool = False

    def auth_missing(self) -> bool:
        """Walmart browsing requires no auth."""
        return False

    def scrape(self, query: str) -> ScrapedPrice | None:
        """Best-effort top-hit price for ``query`` at Walmart.

        Strategy: GET the SSR search page, parse the embedded
        ``__NEXT_DATA__`` Next.js blob for product cards. Pick the
        first non-sponsored card. Sponsored cards are tagged in the
        data and we skip them — they tend to be unrelated to the query.
        """
        clean_query = (query or "").strip()
        if not clean_query:
            return None

        headers = {
            "User-Agent": _USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
        }
        params = {"q": clean_query}

        try:
            resp = requests.get(
                _SEARCH_URL,
                params=params,
                headers=headers,
                timeout=_REQUEST_TIMEOUT,
            )
        except requests.RequestException as exc:
            logger.info("Walmart scraper: network error for %r — %s", query, exc)
            return None

        if resp.status_code == 403:
            logger.warning(
                "Walmart scraper: 403 for %r — anti-bot tripped. "
                "Try varying the User-Agent or adding cookies.",
                query,
            )
            return None
        if resp.status_code == 429:
            logger.info("Walmart scraper: rate limited (429) for %r", query)
            return None
        # PerimeterX 200-redirect-to-/blocked — Walmart's preferred way
        # of telling us we're a bot. Detect explicitly so the log line
        # is informative; without this we'd silently look like a no-match.
        if "/blocked" in resp.url or "Robot or human" in resp.text[:2000]:
            logger.warning(
                "Walmart scraper: PerimeterX intercepted (final_url=%s). "
                "Plain-HTTP scraping is non-viable from this IP. See "
                "walmart.py docstring for Playwright migration plan.",
                resp.url,
            )
            return None
        if not resp.ok:
            logger.info(
                "Walmart scraper: %s for %r — %s",
                resp.status_code,
                query,
                resp.text[:200],
            )
            return None

        text = resp.text

        # Try __NEXT_DATA__ first (richer + more reliable).
        product = _first_product_from_next_data(text)
        if product is None:
            # Fall back to JSON-LD ItemList → Product entries.
            product = _first_product_from_jsonld(text)
        if product is None:
            logger.info(
                "Walmart scraper: no parsable product card for %r "
                "(both __NEXT_DATA__ and JSON-LD paths failed)",
                query,
            )
            return None

        return ScrapedPrice(
            merchant="walmart",
            price_cents=product["price_cents"],
            observed_at=date.today(),
            in_stock=product.get("in_stock", True),
            product_url=product.get("product_url"),
            notes=product.get("title"),
        )


# ---------------------------------------------------------------------------
# Parsers — kept small + private so they're easy to unit-test on fixtures.
# ---------------------------------------------------------------------------


def _first_product_from_next_data(html: str) -> dict | None:
    """Pull the first non-sponsored product from Walmart's __NEXT_DATA__ blob.

    Schema (best as observed 2026-05):
        props.pageProps.initialData.searchResult.itemStacks[i].items[j] = {
            "name": "...",
            "canonicalUrl": "/ip/...",
            "priceInfo": {
                "currentPrice": {"price": 14.97, "priceString": "$14.97"},
                ...
            },
            "availabilityStatusV2": {"value": "IN_STOCK"|"OUT_OF_STOCK"},
            "isSponsoredFlag": false,
            ...
        }

    We walk every itemStack and collect items in order, skipping
    sponsored. Returns dict with our normalized fields or None.
    """
    m = re.search(
        r'<script[^>]*__NEXT_DATA__[^>]*>(.+?)</script>',
        html,
        re.DOTALL,
    )
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError as exc:
        logger.info("Walmart: __NEXT_DATA__ JSON parse error: %s", exc)
        return None

    items = _walk_to_items(data)
    if not items:
        return None

    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("isSponsoredFlag") or item.get("sponsoredProduct"):
            continue
        normalized = _normalize_next_data_item(item)
        if normalized is not None:
            return normalized
    return None


def _walk_to_items(data: Any) -> list:
    """Defensive walk to ``...itemStacks[*].items`` flattened.

    Walmart sometimes nests under different ``initialData`` keys
    depending on the page variant; we look in the most common spot
    first, then scan more broadly if needed.
    """
    try:
        stacks = data["props"]["pageProps"]["initialData"]["searchResult"]["itemStacks"]
        if isinstance(stacks, list):
            out: list = []
            for stack in stacks:
                items = stack.get("items") if isinstance(stack, dict) else None
                if isinstance(items, list):
                    out.extend(items)
            if out:
                return out
    except (KeyError, TypeError):
        pass

    # Loose fallback: walk for any "itemStacks" key anywhere in the tree.
    found: list = []

    def visit(obj: Any, depth: int = 0) -> None:
        if depth > 8 or len(found) >= 50:
            return
        if isinstance(obj, dict):
            stacks = obj.get("itemStacks")
            if isinstance(stacks, list):
                for stack in stacks:
                    items = stack.get("items") if isinstance(stack, dict) else None
                    if isinstance(items, list):
                        found.extend(items)
            for v in obj.values():
                visit(v, depth + 1)
        elif isinstance(obj, list):
            for v in obj:
                visit(v, depth + 1)

    visit(data)
    return found


def _normalize_next_data_item(item: dict) -> dict | None:
    """Pull our normalized fields out of a Walmart product card.

    Returns None if the item is missing essential fields (price or
    name); caller skips and tries the next item.
    """
    name = item.get("name")
    if not isinstance(name, str) or not name.strip():
        return None

    # Price: ``priceInfo.currentPrice.price`` is the dollar value,
    # ``priceInfo.currentPrice.priceString`` is the formatted display.
    price_info = item.get("priceInfo")
    if not isinstance(price_info, dict):
        return None
    cur = price_info.get("currentPrice")
    if not isinstance(cur, dict):
        return None
    raw_price = cur.get("price")
    try:
        dollars = float(raw_price)
    except (TypeError, ValueError):
        return None
    if dollars <= 0:
        return None
    price_cents = int(round(dollars * 100))

    in_stock = True
    avail = item.get("availabilityStatusV2")
    if isinstance(avail, dict):
        value = avail.get("value")
        if value and value != "IN_STOCK":
            in_stock = False

    canonical = item.get("canonicalUrl")
    product_url: str | None = None
    if isinstance(canonical, str) and canonical:
        product_url = (
            canonical
            if canonical.startswith("http")
            else f"https://www.walmart.com{canonical}"
        )

    return {
        "title": name.strip()[:240],
        "price_cents": price_cents,
        "in_stock": in_stock,
        "product_url": product_url,
    }


def _first_product_from_jsonld(html: str) -> dict | None:
    """Fallback: scan ``<script type="application/ld+json">`` blocks for
    an ``ItemList`` whose ``itemListElement`` are ``Product`` entries.

    Walmart emits this for Google Shopping. Less rich than the
    Next.js blob (no in-stock detail in some variants) but more
    structurally stable.
    """
    blocks = re.findall(
        r'<script[^>]*application/ld\+json[^>]*>(.+?)</script>',
        html,
        re.DOTALL,
    )
    for block in blocks:
        try:
            payload = json.loads(block)
        except json.JSONDecodeError:
            continue
        # Could be a single object or an array of root objects.
        candidates = payload if isinstance(payload, list) else [payload]
        for root in candidates:
            if not isinstance(root, dict):
                continue
            if root.get("@type") not in ("ItemList", "ItemListElement"):
                continue
            elements = root.get("itemListElement")
            if not isinstance(elements, list):
                continue
            for el in elements:
                if not isinstance(el, dict):
                    continue
                product = el.get("item") if isinstance(el.get("item"), dict) else el
                if not isinstance(product, dict):
                    continue
                if product.get("@type") != "Product":
                    continue
                name = product.get("name")
                offers = product.get("offers")
                if isinstance(offers, list) and offers:
                    offers = offers[0]
                if not isinstance(offers, dict):
                    continue
                price_raw = offers.get("price") or offers.get("lowPrice")
                try:
                    dollars = float(price_raw)
                except (TypeError, ValueError):
                    continue
                if dollars <= 0:
                    continue
                url = product.get("url") or offers.get("url")
                avail = offers.get("availability", "")
                in_stock = "InStock" in avail if isinstance(avail, str) else True
                return {
                    "title": (name or "").strip()[:240] or None,
                    "price_cents": int(round(dollars * 100)),
                    "in_stock": in_stock,
                    "product_url": url if isinstance(url, str) else None,
                }
    return None
