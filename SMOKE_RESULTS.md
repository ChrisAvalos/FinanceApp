# Sandbox smoke-test pass — 2026-04-27

I ran all six backend smoke scripts from my Linux sandbox against the
Windows project tree. **Every script reported `PASSED`.** This validates
the engine-logic half of the app (the half that doesn't need a live
server) end-to-end, before the UI walkthrough.

Command pattern (each script seeds its own DB, redirected to `/tmp/`
because Windows-side `backend/finance.db` is owned by your dev box):

```
SMOKE_DB_PATH=/tmp/<scriptname>.db python scripts/<scriptname>.py
```

## Results

| # | Script | What it covers | Result |
|---|---|---|---|
| 1 | `smoke_test.py` | Phase A foundation: ingestion → categorization → stats → recurring detection. Plaid sandbox + Gmail mock. | **PASS** (Plaid live API call skipped — sandbox has no network access to `sandbox.plaid.com`; will run when you do it on your PC.) |
| 2 | `smoke_budget_credit.py` | Budgets CRUD, copy-from-prior-month, fill-from-average, /api/credit utilization + opportunity engine, MoM stats. | **PASS** — paydown opportunity fired correctly at 44% utilization with a 1-day window before statement close. |
| 3 | `smoke_legal_claims.py` | LegalClaim CRUD, 3-state proof status, dedupe-by-source-url 409, expired filter, status transitions, stats reconciliation. | **PASS** — total=$165 potential, $23 collected, 3-way split correct. |
| 4 | `smoke_legal_scrapers.py` | Scraper framework + proof heuristic + TopClassActions + ClassAction.org parsers + coordinator idempotency + per-source error isolation. | **PASS** — 5 created across both scrapers, second run added 0, user-advanced row preserved across re-scrape, CAO ran clean while TCA's index 500'd. |
| 5 | `smoke_phase_b.py` | Subscription type classifier + 2-pass detector (strict + loose for variable-amount bills) + price-change baseline-vs-tail + T2 promo/price-change parser + apply_pending_signals link + API confirm/dismiss/set-type. | **PASS** — Netflix price change `-999→-1599` applied idempotently, Adobe → SaaS, Disney+ dismissed cleanly, stats reconciled at total=3 monthly=−$126.58 confirmed_only=1. |
| 6 | `smoke_phase_d.py` | Phase D: surplus engine (historical + forecast + both modes), goal CRUD with auto-achieve, contribution reverse-on-delete, suggestion bundle (allocations + cancellations + debt strategies), before/after math. | **PASS** — historical surplus = $4322.02, forecast surplus = $4322.02, debt avalanche minimums $1740 → accelerated $1382.02 → saves $357.98. |

## What's NOT covered by these smoke tests

These are the things the smoke suite can't verify and that the UI
walkthrough in TESTING.md is designed to catch:

- React rendering — every panel actually paints data correctly, no console
  errors, no 500s in network tab.
- TanStack Query cache invalidation — confirming a sub on the
  Subscriptions panel properly bumps the surplus number on the Savings
  panel.
- Form UX — date pickers, dropdowns populated correctly, validation
  messages.
- Plaid Link sandbox flow (real OAuth window, `user_good`/`pass_good`).
- Gmail OAuth + token refresh round-trip.
- Vite hot-reload and the dev proxy (`/api` → `localhost:8000`).
- Anything router-related (bookmarks, deeplinks, browser back/forward).

## How to do the UI half

Quickest path: double-click `start-finance-app.bat` at the project root.
It spawns two cmd windows — one runs uvicorn on `:8000`, one runs Vite on
`:5173`. Once both windows show their "running" lines, hit
`http://localhost:5173` in your browser and walk §3 onward of TESTING.md.

If you'd rather start them by hand, the equivalent commands are at the
top of TESTING.md (§2a Backend / §2b Frontend) using the labeled-window
convention.

Once those servers are up I can drive the UI test from my side via the
Chrome MCP — every panel, every action, with a writeup of anything
broken — without needing you in the loop.
