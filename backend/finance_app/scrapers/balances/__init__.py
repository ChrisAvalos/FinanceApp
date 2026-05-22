"""Balance-only scrapers — Sprint 43.

Why this exists
---------------
Plaid is our primary balance source, but some neobanks (Albert,
Wealthfront, M1, etc.) only expose a subset of their products through
Plaid. Albert exposes Cash via Plaid; Savings and Investing are
walled off in their own app and inaccessible to any aggregator.

This package contains per-site Playwright scrapers that log into the
bank's web dashboard with stored auth state, read the displayed
balance(s), and write them to our DB as manual ``BalanceSnapshot``
rows. The accounts themselves are synthetic ``Account`` rows tied to
the same ``Institution`` as the Plaid item, with ``source=manual``.

Lifecycle (mirrors offers/ and credit_scores/)
----------------------------------------------
1. ``python -m finance_app.scrapers.balances.bootstrap albert`` — opens
   a real Chromium window so the user can log in once. The cookies are
   saved to ``backend/.auth_state/albert.json``.
2. ``coordinator.run_scrapers(db)`` — runs every registered scraper
   headlessly, upserts the synthetic Account rows, and writes one
   BalanceSnapshot per balance found.
3. The daily scheduler hits the coordinator alongside Plaid sync.

When the auth-state expires the user re-runs the bootstrap command.
"""
from .base import (
    AUTH_STATE_DIR,
    AuthStateMissing,
    BalanceScraperBase,
    ScrapedBalance,
    auth_state_path,
)
from .coordinator import run_scrapers

__all__ = [
    "AUTH_STATE_DIR",
    "AuthStateMissing",
    "BalanceScraperBase",
    "ScrapedBalance",
    "auth_state_path",
    "run_scrapers",
]
