"""Probe Target's server-rendered search HTML for embedded product data.

Why this exists
---------------
Target rotates the RedSky api_key + tightens anti-bot regularly, which
makes the JSON API path fragile. The HTML search page at
``https://www.target.com/s?searchTerm=...`` is rendered server-side
for SEO and embeds product data in stable formats (JSON-LD for Google,
__NEXT_DATA__ for the React hydration). Those formats don't rotate
because they're load-bearing for search engines.

This probe fetches one page, dumps the full HTML to disk, and prints
what kinds of structured data it found. Run from Chris's machine
(which has direct network) to capture the real shape — then share
the dump with me and I'll build the real HTML parser against it.

Usage::

    python -m scripts.probe_target_html             # default query: paper towels
    python -m scripts.probe_target_html "trash bags" # custom query
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
    out_path = out_dir / "target_search.html"

    url = "https://www.target.com/s"
    params = {"searchTerm": query}
    # Accept-Language is critical — without it Target serves a redirect
    # to the country-picker page on some IPs. The remaining headers
    # mirror what a real Chrome would send.
    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }

    print(f"GET {url}?searchTerm={query}")
    try:
        r = requests.get(url, params=params, headers=headers, timeout=15)
    except requests.RequestException as e:
        print(f"Network error: {e}")
        return 1

    print(f"  status: {r.status_code}")
    print(f"  final_url: {r.url}")
    print(f"  bytes: {len(r.text):,}")
    print()

    out_path.write_text(r.text, encoding="utf-8")
    print(f"HTML written to: {out_path}")
    print()

    if r.status_code != 200:
        print(
            "Non-200 response. If 403/429, Target is rate-limiting or "
            "fingerprinting. If 302 to a country-picker, the "
            "Accept-Language header didn't take."
        )
        return 1

    text = r.text

    # ---- What structured-data formats are present? ----
    print("Structured-data probes:")

    # __NEXT_DATA__ — Next.js React hydration blob.
    m = re.search(
        r'<script\s+id="__NEXT_DATA__"\s+type="application/json">(\{.*?\})</script>',
        text,
        re.DOTALL,
    )
    if m:
        blob_len = len(m.group(1))
        print(f"  ✓ __NEXT_DATA__ found  ({blob_len:,} chars)")
    else:
        print("  ✗ __NEXT_DATA__ not found")

    # JSON-LD — Google demands this for Product structured data.
    ld_blocks = re.findall(
        r'<script\s+type="application/ld\+json">(.*?)</script>',
        text,
        re.DOTALL,
    )
    print(f"  JSON-LD blocks: {len(ld_blocks)}")
    for i, block in enumerate(ld_blocks[:5]):
        snippet = block.strip()[:120].replace("\n", " ")
        print(f"    [{i}] {snippet}…")

    # Apollo / Redux state — sometimes inlined.
    if "__APOLLO_STATE__" in text:
        print("  ✓ __APOLLO_STATE__ marker present")
    if "window.__PRELOADED_STATE__" in text:
        print("  ✓ __PRELOADED_STATE__ marker present")

    # Quick heuristic: how many product links does the HTML reference?
    product_links = re.findall(r'/p/[^"]*?/-/A-(\d+)', text)
    unique_tcins = sorted(set(product_links))
    print(f"  product TCINs referenced: {len(unique_tcins)}")
    if unique_tcins[:5]:
        print(f"  first 5 TCINs: {unique_tcins[:5]}")

    # Currency / price tokens to confirm pricing data is in the HTML
    price_count = len(re.findall(r"\$\d+\.\d{2}", text))
    print(f"  $X.YZ tokens in body: {price_count}")

    print()
    print(
        "Share the .debug/target_search.html file (or just the "
        "__NEXT_DATA__ snippet & one JSON-LD block) and I'll parse "
        "from there."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
