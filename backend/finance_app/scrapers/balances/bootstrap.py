"""One-time interactive auth-state bootstrap for balance scrapers.

Run from the project root::

    python -m finance_app.scrapers.balances.bootstrap albert

Opens a real Chromium window. Log in to albert.com — username,
password, 2FA, whatever the flow requires. When the dashboard is
loaded and showing your balances, hit Enter in the terminal;
storageState is saved to ``backend/.auth_state/albert.json``.

Re-run when the auth-state expires (Albert cookies are typically
~30 days). The scrapers raise :class:`AuthStateMissing` when the file
is gone, which the API surfaces as a clean "log in again" badge.
"""
from __future__ import annotations

import sys
from pathlib import Path

from .base import AUTH_STATE_DIR, auth_state_path


# site_key → login URL. Add more entries when wiring new banks.
_LOGIN_URLS: dict[str, str] = {
    "albert": "https://albert.com/login",
}


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in _LOGIN_URLS:
        print(
            f"Usage: python -m finance_app.scrapers.balances.bootstrap "
            f"[{'|'.join(_LOGIN_URLS)}]"
        )
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
        )
        sys.exit(2)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        ctx = browser.new_context()
        page = ctx.new_page()
        print(f"Opening {site_key} login page. Log in normally (with 2FA if asked).")
        page.goto(_LOGIN_URLS[site_key])
        print(
            "\nWhen you're logged in and the dashboard with your balances "
            "is fully loaded, press Enter here to save the auth state."
        )
        input()
        # Capture the auth state AND the dashboard URL the user
        # landed on. Albert's actual dashboard lives on a different
        # host than albert.com (likely app.albert.com or similar);
        # without recording where the user ended up, the headless
        # scraper has no way to know the real URL on the next run.
        ctx.storage_state(path=str(out_path))
        dash_url = page.url
        url_path = out_path.with_name(f"{site_key}_dashboard_url.txt")
        url_path.write_text(dash_url, encoding="utf-8")
        ctx.close()
        browser.close()
    print(f"Saved auth state to {out_path}")
    print(f"Saved dashboard URL to {url_path}: {dash_url}")


if __name__ == "__main__":
    main()
