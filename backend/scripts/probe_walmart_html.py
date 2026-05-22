"""Probe Walmart's search HTML for embedded product data.

Mirrors probe_target_html.py but for Walmart. Captures the page,
prints what structured-data formats are present, and sniffs for
common anti-bot interstitials (Akamai, PerimeterX, Cloudflare).

Usage::

    python -m scripts.probe_walmart_html             # default: paper towels
    python -m scripts.probe_walmart_html "trash bags"
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import requests


_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/123.0.0.0 Safari/537.36"
)


def main() -> int:
    query = sys.argv[1] if len(sys.argv) > 1 else "paper towels"
    out_dir = Path(__file__).resolve().parents[1] / ".debug"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "walmart_search.html"

    url = "https://www.walmart.com/search"
    params = {"q": query}
    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
    }

    print(f"GET {url}?q={query}")
    try:
        r = requests.get(url, params=params, headers=headers, timeout=15)
    except requests.RequestException as e:
        print(f"Network error: {e}")
        return 1

    print(f"  status: {r.status_code}")
    print(f"  final_url: {r.url}")
    print(f"  bytes: {len(r.text):,}")
    out_path.write_text(r.text, encoding="utf-8")
    print(f"  wrote: {out_path}")
    print()

    text = r.text

    # ---- Anti-bot interstitials ----
    print("Anti-bot signatures:")
    bot_markers = {
        "akamai": ("Akamai", "BMP", "akam"),
        "perimeterx": ("PerimeterX", "px-captcha", "_px"),
        "cloudflare": ("Cloudflare", "cf-challenge", "cf_chl"),
        "captcha": ("captcha", "Are you human", "Press & Hold"),
        "robot_check": ("Robot Check", "robot or human", "verify you are not a robot"),
    }
    any_bot = False
    for label, needles in bot_markers.items():
        for needle in needles:
            if needle.lower() in text.lower():
                print(f"  ⚠ matched '{needle}' (suggests {label})")
                any_bot = True
                break
    if not any_bot:
        print("  ✓ none of Akamai/PerimeterX/Cloudflare/captcha markers found")

    print()
    print("Structured-data probes:")

    # __NEXT_DATA__
    m = re.search(
        r'<script[^>]*__NEXT_DATA__[^>]*>(.+?)</script>',
        text,
        re.DOTALL,
    )
    if m:
        blob_len = len(m.group(1))
        # Quick peek at what keys are present
        head = m.group(1)[:200]
        print(f"  ✓ __NEXT_DATA__ found  ({blob_len:,} chars)")
        print(f"    head: {head!r}")
    else:
        print("  ✗ __NEXT_DATA__ not found")

    # JSON-LD
    ld_blocks = re.findall(
        r'<script[^>]*application/ld\+json[^>]*>(.*?)</script>',
        text,
        re.DOTALL,
    )
    print(f"  JSON-LD blocks: {len(ld_blocks)}")
    for i, block in enumerate(ld_blocks[:5]):
        snippet = block.strip()[:120].replace("\n", " ")
        print(f"    [{i}] {snippet}…")

    # itemStacks marker (Walmart's product list root)
    if '"itemStacks"' in text:
        print("  ✓ 'itemStacks' marker present (Walmart's Next.js product container)")
    else:
        print("  ✗ 'itemStacks' marker absent — page likely rendered without products")

    # Quick price-token count
    price_count = len(re.findall(r"\$\d+\.\d{2}", text))
    print(f"  $X.YZ tokens in body: {price_count}")

    # If we got an interstitial, the body is usually small-ish
    title = re.search(r"<title>(.*?)</title>", text, re.DOTALL)
    print(f"  TITLE: {(title.group(1) if title else 'none').strip()[:120]!r}")

    print()
    print("If status=200 and itemStacks is present but the smoke test")
    print("returned None, the Next.js shape probably drifted — share the")
    print(".debug/walmart_search.html and I'll patch the parser walk.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
