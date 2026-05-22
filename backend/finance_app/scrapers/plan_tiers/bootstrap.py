"""Bootstrap one-time login for plan-tier scrapers.

Usage::

    python -m finance_app.scrapers.plan_tiers.bootstrap xfinity

Opens a real Chrome window so the user can log in (with 2FA if
prompted), then persists the *whole* browser profile (cookies + cache +
fingerprint) so the headless run can reuse it. Profile lives at
``backend/.auth_state/<site_key>_profile/``.

Why a persistent profile instead of a storage_state JSON
--------------------------------------------------------
Carrier portals (Xfinity, Verizon, T-Mobile, etc.) sit behind Akamai /
Imperva enterprise WAFs that fingerprint Playwright's bundled Chromium
within milliseconds and serve a generic "Access Denied" page instead
of the login form. The fix isn't a smarter storage_state — those
defenses look at the browser binary, not just cookies. We sidestep by:

1. Using the user's real Chrome via ``channel="chrome"``. The bundled
   Playwright Chromium is what's blacklisted; system Chrome isn't.
2. Persisting the full profile (``launch_persistent_context``) so
   indexedDB / fontconfig / GPU fingerprint look like a returning user.
3. Patching ``navigator.webdriver``, ``navigator.plugins``, etc. via an
   init script (``STEALTH_INIT_SCRIPT`` in base.py). These are the
   highest-signal automation tells.
4. Removing the "controlled by automated software" Chrome banner with
   ``--disable-blink-features=AutomationControlled``.

This recipe gets past Akamai for the common carrier portals as of
2026-05. If a portal *still* blocks (some have moved to BotDefender),
the fallback is a manual cookie export from the user's real Chrome —
documented in ``finance_app/scrapers/plan_tiers/MANUAL_COOKIES.md``
(TODO: write if Akamai still blocks after this).
"""
from __future__ import annotations

import sys

from .base import AUTH_STATE_DIR, STEALTH_INIT_SCRIPT, STEALTH_LAUNCH_ARGS, profile_dir_for
from .xfinity import XFINITY_ACCOUNT_URL


# site_key → (display name, login start URL).
_SITES: dict[str, tuple[str, str]] = {
    "xfinity": ("Xfinity", XFINITY_ACCOUNT_URL),
}


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if len(argv) != 1 or argv[0] not in _SITES:
        sites = ", ".join(sorted(_SITES))
        print("Usage: python -m finance_app.scrapers.plan_tiers.bootstrap <site>")
        print(f"Available sites: {sites}")
        return 1

    site_key = argv[0]
    name, url = _SITES[site_key]
    AUTH_STATE_DIR.mkdir(parents=True, exist_ok=True)
    profile_dir = profile_dir_for(site_key)
    profile_dir.mkdir(parents=True, exist_ok=True)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "Playwright is not installed. Run:\n"
            "    pip install playwright\n"
            "    python -m playwright install chromium"
        )
        return 2

    print(f"Opening {name} login at {url}")
    print("• Browser: system Chrome (channel='chrome'); profile persists at")
    print(f"  {profile_dir}")
    print("• Log in (incl. 2FA if prompted), navigate to your account/plan page,")
    print("  then close the browser window when you're done.")
    print()
    print("If you hit 'Access Denied' it means Akamai still detected automation —")
    print("that's a known issue. Re-run bootstrap once more (sometimes the second")
    print("attempt succeeds because cookies from the first attempt soften the check),")
    print("or check that you have a non-managed Chrome installed on this machine.")
    print()

    with sync_playwright() as p:
        try:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                channel="chrome",  # use system Chrome, not bundled Chromium
                headless=False,
                args=STEALTH_LAUNCH_ARGS,
                viewport={"width": 1280, "height": 800},
                # Looking like a real user-agent matters less than the
                # CDP fingerprint, but supply a recent Chrome UA anyway
                # for completeness.
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/126.0.0.0 Safari/537.36"
                ),
            )
        except Exception as exc:  # noqa: BLE001
            print(f"Failed to launch system Chrome: {exc}")
            print("Falling back to bundled Chromium (less likely to evade Akamai).")
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                headless=False,
                args=STEALTH_LAUNCH_ARGS,
                viewport={"width": 1280, "height": 800},
            )
        ctx.add_init_script(STEALTH_INIT_SCRIPT)
        page = ctx.new_page() if not ctx.pages else ctx.pages[0]
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        except Exception as exc:  # noqa: BLE001
            print(f"Initial navigation failed: {exc}. The browser is still open;")
            print("paste the URL manually and continue.")
        # Wait until the user closes the window. Persistent context
        # exposes a `close` event on the context itself.
        try:
            page.wait_for_event("close", timeout=0)
        except Exception:  # noqa: BLE001
            pass
        # Don't call ctx.close() before the user does — they're driving.
        # Profile persists automatically because launch_persistent_context
        # writes to disk on shutdown.
    print(f"Profile saved for {site_key} → {profile_dir}")
    print("You can now run 'Sync plan tiers' from the Subscriptions panel,")
    print("or POST /api/bundles/scrape-tiers from curl.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
