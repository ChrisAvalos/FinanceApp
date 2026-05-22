"""Smoke test for the Walmart deal scraper.

Two phases:

  1. PARSER FIXTURES — exercises the __NEXT_DATA__ + JSON-LD parsers
     against hand-built payloads. No network. Catches schema-shift bugs.

  2. LIVE PROBE (only with --live) — hits walmart.com/search with a
     benign query. Useful for confirming the SSR shape after Walmart
     ships a frontend update.

Usage::

    python -m scripts.smoke_walmart_scraper          # parser only
    python -m scripts.smoke_walmart_scraper --live   # +1 live probe
"""
from __future__ import annotations

import json
import sys

from finance_app.deals.scrapers.walmart import (
    WalmartScraper,
    _first_product_from_jsonld,
    _first_product_from_next_data,
    _normalize_next_data_item,
    _walk_to_items,
)


def _next_data_html(payload: dict) -> str:
    """Build a minimal HTML wrapper around a __NEXT_DATA__ payload."""
    return f'<html><body><script id="__NEXT_DATA__" type="application/json">{json.dumps(payload)}</script></body></html>'


def _jsonld_html(payload: dict | list) -> str:
    return f'<html><body><script type="application/ld+json">{json.dumps(payload)}</script></body></html>'


def _fixture_next_data_one_hit() -> dict:
    """Realistic Walmart __NEXT_DATA__ shape with one in-stock product."""
    return {
        "props": {
            "pageProps": {
                "initialData": {
                    "searchResult": {
                        "itemStacks": [
                            {
                                "items": [
                                    {
                                        "name": "Bounty Select-A-Size Paper Towels, 12 Mega Rolls",
                                        "canonicalUrl": "/ip/Bounty-Paper-Towels-12-Mega/123456789",
                                        "priceInfo": {
                                            "currentPrice": {
                                                "price": 24.97,
                                                "priceString": "$24.97",
                                            }
                                        },
                                        "availabilityStatusV2": {"value": "IN_STOCK"},
                                        "isSponsoredFlag": False,
                                    }
                                ]
                            }
                        ]
                    }
                }
            }
        }
    }


def _fixture_next_data_skip_sponsored() -> dict:
    """Sponsored card first, real card second — parser should skip the
    sponsored one and return the second."""
    payload = _fixture_next_data_one_hit()
    sponsored = {
        "name": "AD: Sponsored Soap",
        "canonicalUrl": "/ip/sponsored-soap/999",
        "priceInfo": {"currentPrice": {"price": 4.99}},
        "isSponsoredFlag": True,
    }
    payload["props"]["pageProps"]["initialData"]["searchResult"]["itemStacks"][0][
        "items"
    ].insert(0, sponsored)
    return payload


def _fixture_jsonld_one_hit() -> dict:
    return {
        "@type": "ItemList",
        "itemListElement": [
            {
                "@type": "ListItem",
                "position": 1,
                "item": {
                    "@type": "Product",
                    "name": "Bounty Paper Towels 12-pack",
                    "url": "https://www.walmart.com/ip/abc/12345",
                    "offers": {
                        "@type": "Offer",
                        "price": "24.97",
                        "priceCurrency": "USD",
                        "availability": "https://schema.org/InStock",
                    },
                },
            }
        ],
    }


def run_parser_phase() -> int:
    failures = 0

    # ---- __NEXT_DATA__ baseline ----
    html = _next_data_html(_fixture_next_data_one_hit())
    product = _first_product_from_next_data(html)
    if product is None:
        print("FAIL: __NEXT_DATA__ baseline returned None")
        return 1
    if product["price_cents"] != 2497:
        print(f"FAIL: expected 2497 cents, got {product['price_cents']}")
        failures += 1
    if "Bounty" not in (product.get("title") or ""):
        print(f"FAIL: title missing 'Bounty', got {product.get('title')!r}")
        failures += 1
    if not product.get("in_stock"):
        print("FAIL: in_stock should be True for IN_STOCK item")
        failures += 1
    if not (product.get("product_url") or "").startswith("https://www.walmart.com/ip/"):
        print(f"FAIL: product_url malformed: {product.get('product_url')!r}")
        failures += 1

    # ---- Skip sponsored ----
    html = _next_data_html(_fixture_next_data_skip_sponsored())
    product = _first_product_from_next_data(html)
    if product is None or "Sponsored" in (product.get("title") or ""):
        print(f"FAIL: should have skipped sponsored — got {product}")
        failures += 1

    # ---- Empty itemStacks ----
    if _first_product_from_next_data(_next_data_html({"props": {}})) is not None:
        print("FAIL: empty payload should return None")
        failures += 1

    # ---- _walk_to_items loose fallback ----
    weird = {"random": {"itemStacks": [{"items": [{"name": "X", "priceInfo": {"currentPrice": {"price": 1}}}]}]}}
    items = _walk_to_items(weird)
    if not items or items[0].get("name") != "X":
        print(f"FAIL: loose walk fallback didn't find item, got {items!r}")
        failures += 1

    # ---- Normalizer rejects malformed price ----
    if _normalize_next_data_item({"name": "Test", "priceInfo": {"currentPrice": {"price": "junk"}}}) is not None:
        print("FAIL: normalizer should reject junk price")
        failures += 1

    # ---- JSON-LD fallback ----
    html = _jsonld_html(_fixture_jsonld_one_hit())
    product = _first_product_from_jsonld(html)
    if product is None:
        print("FAIL: JSON-LD baseline returned None")
        failures += 1
    elif product["price_cents"] != 2497:
        print(f"FAIL: JSON-LD price expected 2497, got {product['price_cents']}")
        failures += 1

    # ---- Garbage HTML ----
    if _first_product_from_next_data("<html><body>nothing</body></html>") is not None:
        print("FAIL: HTML without __NEXT_DATA__ should return None")
        failures += 1
    if _first_product_from_jsonld("<html><body>nothing</body></html>") is not None:
        print("FAIL: HTML without JSON-LD should return None")
        failures += 1

    if failures == 0:
        print("Parser phase: all 9 assertions passed")
        return 0
    print(f"Parser phase: {failures} failure(s)")
    return 1


def run_live_phase() -> int:
    print("\nLive probe — hitting walmart.com/search for 'paper towels'...")
    scraper = WalmartScraper()
    result = scraper.scrape("paper towels")
    if result is None:
        print(
            "Live probe returned None. Possible causes:\n"
            "  1. Walmart's anti-bot tripped on our request shape (uncommon —\n"
            "     try changing _USER_AGENT in walmart.py first).\n"
            "  2. The Next.js shape drifted (props.pageProps.initialData."
            "searchResult.itemStacks). Run scripts/probe_target_html.py with\n"
            "     a Walmart URL to capture the response and compare.\n"
            "  3. Empty result page (rare for common queries like 'paper towels')."
        )
        return 0
    print(
        f"Live probe OK: ${result.price_cents/100:.2f} at {result.merchant} "
        f"({(result.notes or '')[:80]!r}) "
        f"{'in stock' if result.in_stock else 'OUT OF STOCK'}"
    )
    if result.product_url:
        print(f"  → {result.product_url}")
    return 0


def main() -> int:
    rc = run_parser_phase()
    if rc != 0:
        return rc
    if "--live" in sys.argv:
        return run_live_phase()
    print("\n(Skipping live probe — pass --live to hit walmart.com.)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
