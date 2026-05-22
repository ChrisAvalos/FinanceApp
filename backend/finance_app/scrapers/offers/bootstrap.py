"""One-time interactive auth-state bootstrap.

Run from the project root::

    python -m finance_app.scrapers.offers.bootstrap chase
    python -m finance_app.scrapers.offers.bootstrap amex

Opens a real (visible) Chromium window. Log in to the site like
normal — username, password, 2FA, etc. When the offers page is loaded
hit Enter in the terminal; the helper saves storageState to disk.

After this runs once, the daily APScheduler job + ``/api/offers/scrape``
endpoint can scrape headlessly.

Re-run whenever the auth-state expires (cookies last ~7-30 days
depending on the site). The scraper raises :class:`AuthStateMissing`
when the file is gone or stale, which the API surfaces as a clean
"please log in again" prompt.
"""
from __future__ import annotations

import sys
from pathlib import Path

from .base import AUTH_STATE_DIR, auth_state_path
from .chase_offers import CHASE_OFFERS_URL
from .amex_offers import AMEX_OFFERS_URL


_LOGIN_URLS = {
    "chase": "https://secure.chase.com/web/auth/dashboard",
    "amex": "https://www.americanexpress.com/en-us/account/login/",
}

_OFFERS_URLS = {
    "chase": CHASE_OFFERS_URL,
    "amex": AMEX_OFFERS_URL,
}


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in _LOGIN_URLS:
        print("Usage: python -m finance_app.scrapers.offers.bootstrap [chase|amex]")
        sys.exit(2)

    site_key = sys.argv[1]
    AUTH_STATE_DIR.mkdir(parents=True, exist_ok=True)
    out_path: Path = auth_state_path(site_key)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "Playwright not installed. Run:\n"
            "  pip install playwright\n"
            "  python -m playwright install chromium\n"
            "(See MANUAL_TASKS.md item #2.)"
        )
        sys.exit(2)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        ctx = browser.new_context()
        page = ctx.new_page()
        print(f"Opening {site_key} login page. Log in normally (with 2FA if asked).")
        page.goto(_LOGIN_URLS[site_key])
        print(
            f"\nWhen you're logged in and the offers page is loaded "
            f"({_OFFERS_URLS[site_key]}), press Enter here to save the auth state."
        )
        input()
        ctx.storage_state(path=str(out_path))
        ctx.close()
        browser.close()
    print(f"Saved auth state to {out_path}")


if __name__ == "__main__":
    main()
