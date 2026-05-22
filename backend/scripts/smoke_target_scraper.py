"""Smoke test for the Target deal scraper.

Runs in two phases:

  1. PARSER FIXTURES — exercises every helper against a hand-built
     RedSky-shaped payload. No network. Catches schema-shift bugs.

  2. LIVE PROBE (only if --live is passed) — hits the real RedSky
     endpoint with a benign query. Skip in CI; useful when verifying
     after an api_key rotation.

Run from the backend folder with the venv active::

    python -m scripts.smoke_target_scraper          # parser only
    python -m scripts.smoke_target_scraper --live   # parser + 1 live probe
"""
from __future__ import annotations

import sys

from finance_app.deals.scrapers.target import (
    TargetScraper,
    _extract_in_stock,
    _extract_price_cents,
    _extract_product_url,
    _extract_title,
    _first_product,
)


def _fixture_one_hit() -> dict:
    """Realistic RedSky payload with one product hit at $14.99."""
    return {
        "data": {
            "search": {
                "products": [
                    {
                        "tcin": "12345678",
                        "item": {
                            "product_description": {
                                "title": "Tide&trade; Liquid Laundry Detergent — 92 oz"
                            },
                            "enrichment": {
                                "buy_url": "https://www.target.com/p/tide-liquid-detergent-92-oz/-/A-12345678"
                            },
                            "eligibility_rules": {
                                "ship_to_guest": {"is_active": True}
                            },
                        },
                        "price": {
                            "current_retail": 14.99,
                            "formatted_current_price": "$14.99",
                            "reg_retail": 16.99,
                            "is_current_price_range": False,
                        },
                    }
                ]
            }
        }
    }


def _fixture_no_results() -> dict:
    """RedSky shape when nothing matches the query."""
    return {"data": {"search": {"products": []}}}


def _fixture_variant_range() -> dict:
    """Product with a price range (size variants) — current_retail null,
    current_retail_min populated."""
    return {
        "data": {
            "search": {
                "products": [
                    {
                        "tcin": "99999999",
                        "item": {
                            "product_description": {"title": "Variant Pack"}
                        },
                        "price": {
                            "current_retail": None,
                            "current_retail_min": 9.49,
                            "current_retail_max": 19.99,
                            "is_current_price_range": True,
                        },
                    }
                ]
            }
        }
    }


def _fixture_out_of_stock() -> dict:
    """Top hit exists but isn't shippable."""
    return {
        "data": {
            "search": {
                "products": [
                    {
                        "tcin": "55555555",
                        "item": {
                            "product_description": {"title": "OOS Item"},
                            "eligibility_rules": {
                                "ship_to_guest": {"is_active": False}
                            },
                        },
                        "price": {"current_retail": 4.99},
                    }
                ]
            }
        }
    }


def run_parser_phase() -> int:
    """Returns 0 on success, nonzero on first failure."""
    failures = 0

    # ---- One-hit baseline ----
    payload = _fixture_one_hit()
    product = _first_product(payload)
    if product is None:
        print("FAIL: _first_product returned None on a known-good payload")
        return 1

    cents = _extract_price_cents(product)
    if cents != 1499:
        print(f"FAIL: _extract_price_cents expected 1499, got {cents}")
        failures += 1

    title = _extract_title(product)
    expected = "Tide™ Liquid Laundry Detergent — 92 oz"
    if title != expected:
        print(f"FAIL: _extract_title expected {expected!r}, got {title!r}")
        failures += 1

    url = _extract_product_url(product)
    if url is None or "A-12345678" not in url:
        print(f"FAIL: _extract_product_url got {url!r}")
        failures += 1

    if not _extract_in_stock(product):
        print("FAIL: _extract_in_stock returned False on shippable item")
        failures += 1

    # ---- No results ----
    if _first_product(_fixture_no_results()) is not None:
        print("FAIL: _first_product should return None when products is empty")
        failures += 1

    # ---- Variant range — should fall back to min ----
    variant = _first_product(_fixture_variant_range())
    assert variant is not None
    variant_cents = _extract_price_cents(variant)
    if variant_cents != 949:
        print(f"FAIL: variant range expected 949, got {variant_cents}")
        failures += 1

    # ---- Out-of-stock detection ----
    oos = _first_product(_fixture_out_of_stock())
    assert oos is not None
    if _extract_in_stock(oos):
        print("FAIL: _extract_in_stock returned True on OOS item")
        failures += 1

    # ---- Garbage in ----
    if _first_product({}) is not None:
        print("FAIL: _first_product on empty dict should be None")
        failures += 1
    if _first_product({"data": "not a dict"}) is not None:
        print("FAIL: _first_product on garbage data should be None")
        failures += 1

    if failures == 0:
        print("Parser phase: all 9 assertions passed")
        return 0
    print(f"Parser phase: {failures} failure(s)")
    return 1


def run_live_phase() -> int:
    """Hits RedSky once with a benign query.

    Note (2026-05): RedSky is increasingly fingerprint-gated even with
    a valid api_key. If you hit a persistent 403 here, the api_key is
    likely fine — Target is rejecting based on TLS fingerprint or
    missing browser cookies. The durable fix is the HTML scraper
    (see scripts/probe_target_html.py for the migration path).
    """
    print("\nLive probe — hitting RedSky for query='paper towels'...")
    scraper = TargetScraper()
    result = scraper.scrape("paper towels")
    if result is None:
        print(
            "Live probe returned None. Possible causes (ranked by likelihood):\n"
            "  1. Target's anti-bot rejected our request shape (most likely\n"
            "     even when the api_key is fresh — they fingerprint TLS / UA / etc).\n"
            "     Fix: pivot to HTML scraping. Run scripts/probe_target_html.py\n"
            "     to capture the SSR page, share with Claude.\n"
            "  2. RedSky api_key actually rotated. Pull fresh value from\n"
            "     target.com DevTools (any redsky.target.com request → key=).\n"
            "  3. Target genuinely has no match for 'paper towels'. Unlikely."
        )
        return 0  # not a hard failure — None is a legal result
    print(
        f"Live probe OK: ${result.price_cents/100:.2f} at {result.merchant} "
        f"({result.notes!r})"
    )
    return 0


def main() -> int:
    rc = run_parser_phase()
    if rc != 0:
        return rc
    if "--live" in sys.argv:
        return run_live_phase()
    print("\n(Skipping live probe — pass --live to hit the real endpoint.)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
