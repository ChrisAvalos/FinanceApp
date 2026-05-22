"""One-time interactive auth-state bootstrap for credit-score portals.

Run from the project root::

    python -m finance_app.scrapers.credit_scores.bootstrap credit_karma
    python -m finance_app.scrapers.credit_scores.bootstrap creditwise
    python -m finance_app.scrapers.credit_scores.bootstrap credit_journey
    python -m finance_app.scrapers.credit_scores.bootstrap smartcredit

Opens a real Chromium window. Log in like normal — username, password,
2FA, etc. When the score-display page is loaded, hit Enter in the
terminal; storageState is saved to disk under
``backend/.auth_state/<site_key>.json``.

Re-run when the auth-state expires (cookies last 1-2 weeks for Chase,
~30 days for the consumer score sites). The scrapers raise
:class:`AuthStateMissing` when the file is gone, which the API
surfaces as a clean "log in again" badge rather than a 500.
"""
from __future__ import annotations

import sys
from pathlib import Path

from .base import AUTH_STATE_DIR, auth_state_path
from .credit_karma import CREDIT_KARMA_URL
from .creditwise import CREDITWISE_URL
from .credit_journey import CREDIT_JOURNEY_URL
from .smartcredit import SMARTCREDIT_URL


_LOGIN_URLS = {
    "credit_karma": "https://www.creditkarma.com/auth/logon",
    "creditwise": "https://verified.capitalone.com/auth/signin?Product=CreditWise",
    "credit_journey": "https://secure.chase.com/web/auth/dashboard",
    "smartcredit": "https://www.smartcredit.com/login/",
}

_TARGET_URLS = {
    "credit_karma": CREDIT_KARMA_URL,
    "creditwise": CREDITWISE_URL,
    "credit_journey": CREDIT_JOURNEY_URL,
    "smartcredit": SMARTCREDIT_URL,
}


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in _LOGIN_URLS:
        print(
            "Usage: python -m finance_app.scrapers.credit_scores.bootstrap "
            "[credit_karma|creditwise|credit_journey|smartcredit]"
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
            f"\nWhen you're logged in and the score-display page is loaded "
            f"({_TARGET_URLS[site_key]}), press Enter here to save the auth state."
        )
        input()
        ctx.storage_state(path=str(out_path))
        ctx.close()
        browser.close()
    print(f"Saved auth state to {out_path}")


if __name__ == "__main__":
    main()
