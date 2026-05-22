"""Debug helper: dump the SmartCredit dashboard HTML to disk.

Why this exists
---------------
When the SmartCredit scraper reports ``rows_seen: 0`` it means we hit
the dashboard with valid auth but the selector heuristics in
:mod:`finance_app.scrapers.credit_scores.smartcredit` didn't find the
score on the page. That almost always means the live React build uses
different class names than what we guessed. The fix is mechanical:
look at the real HTML, copy the actual classes / data attributes /
DOM structure, update the parser.

Run from the backend folder with the venv active::

    python -m scripts.debug_smartcredit_html

Writes ``backend/.debug/smartcredit_dashboard.html`` (raw HTML) and
prints a short summary of what we found at the candidate selectors.
The HTML file can then be opened in any browser or grep'd for the
score number — whichever is faster.

The script reuses the saved auth state from
``backend/.auth_state/smartcredit.json``, so it's safe to re-run as
long as that file is still fresh (cookies last ~30 days for
SmartCredit). No login, no 2FA needed.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from bs4 import BeautifulSoup

from finance_app.scrapers.credit_scores.base import auth_state_path
from finance_app.scrapers.credit_scores.smartcredit import (
    SMARTCREDIT_URL,
    SmartCreditScraper,
    _BUREAU_LABELS,
    _NUMBER_RE,
    _looks_like_score,
)


def main() -> int:
    state_path = auth_state_path("smartcredit")
    if not state_path.exists():
        print(
            f"No auth state at {state_path}. Run "
            "`python -m finance_app.scrapers.credit_scores.bootstrap smartcredit` first."
        )
        return 2

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright not installed. `pip install playwright` then retry.")
        return 2

    out_dir = Path(__file__).resolve().parents[1] / ".debug"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_html = out_dir / "smartcredit_dashboard.html"
    out_text = out_dir / "smartcredit_dashboard.txt"

    # We default to a HEADED browser here — when the headless run got
    # bounced to the OAuth login despite valid cookies, the most common
    # cause is SmartCredit's bot detection (navigator.webdriver, missing
    # chrome runtime, etc). A headed run with the same auth state is the
    # quickest way to disambiguate "auth-state genuinely expired" from
    # "headless was rejected at the door". Pass --headless to flip back.
    headless = "--headless" in sys.argv
    print(
        f"Loading {SMARTCREDIT_URL} "
        f"({'headless' if headless else 'HEADED — a Chromium window will appear'}) "
        f"using saved auth state..."
    )
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        ctx = browser.new_context(storage_state=str(state_path))
        page = ctx.new_page()
        page.goto(SMARTCREDIT_URL, wait_until="networkidle", timeout=30_000)
        # Hero is rendered after React hydrates — give it a full beat.
        page.wait_for_timeout(2500)
        html = page.content()
        # Also capture the final URL in case we got bounced to login.
        final_url = page.url
        # Save a screenshot too — when stuck on login, eyeballing the
        # page is faster than diffing HTML.
        screenshot_path = out_dir / "smartcredit_dashboard.png"
        try:
            page.screenshot(path=str(screenshot_path), full_page=True)
        except Exception as exc:  # noqa: BLE001
            print(f"(screenshot failed: {exc})")
            screenshot_path = None
        ctx.close()
        browser.close()

    out_html.write_text(html, encoding="utf-8")

    soup = BeautifulSoup(html, "html.parser")
    body_text = soup.get_text(" ", strip=True)
    out_text.write_text(body_text, encoding="utf-8")

    print()
    print(f"Final URL after navigation: {final_url}")
    print(f"HTML written to:   {out_html}  ({len(html):,} chars)")
    print(f"Body text written: {out_text}  ({len(body_text):,} chars)")
    if screenshot_path is not None:
        print(f"Screenshot:        {screenshot_path}")
    print()

    # ---------- Did we even land on the dashboard, or get bounced? ----------
    if "login" in final_url.lower() or "signin" in final_url.lower():
        print(
            "WARNING: ended up on a login page — auth state is probably stale.\n"
            "Re-run `python -m finance_app.scrapers.credit_scores.bootstrap smartcredit`."
        )

    # ---------- Bureau-label presence on the page ----------
    # The new parser is anchored on bureau labels (TransUnion / Experian /
    # Equifax). If those words don't appear on the page text, we know
    # we landed somewhere weird and the parser will have nothing to chew on.
    print("Bureau labels found in body text:")
    low = body_text.lower()
    for bureau, variants in _BUREAU_LABELS:
        hits = sum(low.count(v) for v in variants)
        print(f"  {bureau:12s} -> {hits} mention(s)")
    print()

    # ---------- Run the actual scraper parser against the fetched HTML ----------
    print("Parser output (what scrape_and_persist would see):")
    parsed = SmartCreditScraper().parse(html)
    if not parsed:
        print("  (none — parser found 0 scores; eyeball the HTML/screenshot)")
    for s in parsed:
        print(
            f"  {s.bureau:12s} {s.scoring_model:14s} score={s.score}  "
            f"detail='{s.source_detail}'"
        )
    print()

    # ---------- What 3-digit numbers in score range live in the page? ----------
    candidates = []
    for m in _NUMBER_RE.finditer(body_text):
        num = int(m.group(1))
        if not _looks_like_score(num):
            continue
        window = body_text[max(0, m.start() - 60) : m.end() + 60]
        candidates.append((num, window))
    # The 3B page should expose 3 score-shaped numbers near "TransUnion" /
    # "Experian" / "Equifax" labels. Flag those for easy verification.
    bureau_keywords = {v for _, vs in _BUREAU_LABELS for v in vs}
    print(f"Score-shaped numbers (250..900) found in body text: {len(candidates)}")
    for num, window in candidates[:20]:
        wl = window.lower()
        bureau_hint = next((b for b in bureau_keywords if b in wl), None)
        flag = f"  <-- near '{bureau_hint}'" if bureau_hint else ""
        # Compress whitespace for readable single-line snippets.
        snippet = re.sub(r"\s+", " ", window).strip()
        print(f"  {num}  ...{snippet}...{flag}")
    if len(candidates) > 20:
        print(f"  ... ({len(candidates) - 20} more — see full HTML)")

    print()
    if not parsed:
        print("Parser returned 0 scores. Most common causes:")
        print("  - Page bounced to login (see Final URL above)")
        print("  - 3B page wasn't fully rendered yet — try bumping the wait_for_timeout")
        print("  - Bureau labels are inside SVG/canvas elements (rare)")
        print(f"Inspect:  {out_html}  &  {screenshot_path}")
    else:
        print(f"Parser succeeded — {len(parsed)} bureau score(s) ready to persist.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
