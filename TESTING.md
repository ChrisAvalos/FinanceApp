# Finance App — End-to-End Testing Guide

This is a sit-down-with-the-app, top-to-bottom checklist for verifying the
whole pipeline from a clean state. Work through it in order. Steps are
sequenced so each one builds on data created earlier — skipping ahead can
leave panels empty.

Estimated time: **~45 minutes** for the full pass (longer if you connect a
live Plaid sandbox or real Gmail account).

This guide is written for **Windows PowerShell**. If `Activate.ps1` fails
the first time you try to activate the venv, run this once and reopen the
shell:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

> **Before you start.** Close any existing `uvicorn` or `vite` processes so
> the test instances bind clean (a quick way: in any PowerShell, run
> `Get-Process python, node -ErrorAction SilentlyContinue | Stop-Process`).
> The DB lives at `backend\finance.db` by default; the steps below assume
> you're working from that file. If you want to throw it away, delete it
> before step 1 — schema is recreated on first request via
> `Base.metadata.create_all` + the additive auto-migrator.

---

## You will use TWO PowerShell windows for this whole guide

Open them now, side-by-side. From here on every command block tells you
which window to type into.

- **Window A — Backend PowerShell.** Will run smoke tests, then `uvicorn`.
- **Window B — Frontend PowerShell.** Will run `npm run dev` (Vite).

In **both windows** activate the Python venv before doing anything else
(yes, the frontend window too — it's harmless and means you can run
backend commands from either side without re-activating). The prompt
should show `(.venv)` at the very start once active. Run, in **each
window**:

```powershell
# Window A AND Window B (run in both)
cd "C:\Users\Chris\Documents\Claude\Projects\Finance App\backend"
.\.venv\Scripts\Activate.ps1
```

Then in Window B only, also `cd` over to the frontend folder (the venv
stays active across the cd):

```powershell
# Window B only — switch to the web folder
cd ..\web
```

If the prompt does not show `(.venv)` after `Activate.ps1`, fix that
before continuing — most failures below trace back to a missing venv.

---

## 0. Prerequisites

A one-time setup check. Skip if you've already done it on this machine.

- [ ] **Python 3.11+** active (in Window A: `py --version`)
- [ ] **Node 20+** active (in Window B: `node --version`)
- [ ] Backend deps installed (in Window A, with `(.venv)` prompt): `pip install -e ".[dev]"`
- [ ] Frontend deps installed (in Window B, in `web\`): `npm install`
- [ ] `.env` exists in `backend\` (in Window A: `copy .env.example .env` if
      missing). Set at minimum:
  - `DATABASE_URL=sqlite:///./finance.db`
  - `CORS_ORIGINS=http://localhost:5173`
  - Plaid keys + Google OAuth `client.json` are optional — skip those
    phases if not configured (the panels will show empty states cleanly).

---

## 1. Run the automated smoke suite first

These run in seconds and tell you whether the engines themselves are
healthy. If any of these fail, fix them before bothering with the UI —
manual testing past a broken engine is wasted effort.

> **All six commands in this section run in Window A — Backend PowerShell.**
> Do **not** start `uvicorn` yet; the smoke tests use FastAPI's TestClient
> internally and don't need a running server. Run them one at a time,
> waiting for `ALL ... SMOKE STEPS PASSED` between each.

```powershell
# Window A — Backend PowerShell  (prompt shows (.venv))
# Make sure you're in the backend folder:
cd "C:\Users\Chris\Documents\Claude\Projects\Finance App\backend"

# Phase A foundation: ingestion → categorization → stats
py scripts\smoke_test.py

# Phase 3 budgets + credit utilization + opportunities
py scripts\smoke_budget_credit.py

# Legal claims (settlements + scraper)
py scripts\smoke_legal_claims.py
py scripts\smoke_legal_scrapers.py

# Phase B subscription detector + Gmail promo parser
py scripts\smoke_phase_b.py

# Phase D surplus + suggestion engine + goals (NEW)
py scripts\smoke_phase_d.py
```

Each script prints `ALL ... SMOKE STEPS PASSED` on success.

> **If a smoke test fails with "disk I/O error" or a SQLite-WAL complaint**
> (rare on Windows but happens on some OneDrive-synced folders), redirect
> the test DB to your `%TEMP%` folder. Still in **Window A**:
>
> ```powershell
> $env:SMOKE_DB_PATH = "$env:TEMP\smoke.db"
> py scripts\smoke_phase_d.py
> Remove-Item Env:\SMOKE_DB_PATH   # clean up after
> ```

- [ ] All six smoke scripts pass.

---

## 2. Start the app

Now you'll start the live backend and frontend processes and leave them
running for the rest of the guide.

### 2a. Start the backend — Window A

In **Window A — Backend PowerShell**:

```powershell
# Window A — Backend PowerShell  (prompt shows (.venv))
cd "C:\Users\Chris\Documents\Claude\Projects\Finance App\backend"
uvicorn finance_app.api.main:app --reload --host 0.0.0.0 --port 8000
```

This **blocks Window A** for the rest of the session — that's expected.
Look for:

- `[auto-migrations] ...: added columns ...` — only on a stale DB; should be
  silent on a fresh one.
- `Application startup complete.`
- `Uvicorn running on http://0.0.0.0:8000`.

### 2b. Start the frontend — Window B

In **Window B — Frontend PowerShell** (you should already be in the
`web\` folder from the setup above):

```powershell
# Window B — Frontend PowerShell
npm run dev
```

This **blocks Window B** for the rest of the session — also expected.
Look for `Local: http://localhost:5173/` in the output.

Then open http://localhost:5173 in a browser.

- [ ] Header shows `Finance` and `Secure · Local-only` once the first query
      lands.
- [ ] No red errors in the browser DevTools console (F12 → Console).
- [ ] http://localhost:8000/docs renders FastAPI's interactive API page.
- [ ] http://localhost:8000/health returns `{"status":"ok"}`.

> **Need to run an ad-hoc backend command later?** Don't kill uvicorn —
> open a **third PowerShell**, `cd` into `backend`, run
> `.\.venv\Scripts\Activate.ps1`, and you have a free shell for one-off
> `py` commands while the live server keeps running.

---

## 3. Seed some data via the API docs

Before walking the UI we need transactions on file. Easiest path: use the
ingest endpoint at `/docs` to upload a CSV, OR hit the seed endpoint if you
have one wired up. If you need a quick one, paste this into Swagger UI's
`POST /api/ingest/csv` (it accepts the Chase format):

```csv
Posting Date,Description,Amount,Type
04/01/2026,EMPLOYER PAYROLL DEPOSIT,5000.00,ACH_CREDIT
04/02/2026,WHOLE FOODS MARKET,-128.43,DEBIT_CARD
04/03/2026,NETFLIX.COM,-15.99,DEBIT_CARD
04/05/2026,SPOTIFY USA,-11.99,DEBIT_CARD
04/06/2026,CHEVRON 0123,-58.40,DEBIT_CARD
04/08/2026,SHELL GAS STATION,-44.10,DEBIT_CARD
04/10/2026,DOORDASH,-34.50,DEBIT_CARD
04/12/2026,DOORDASH,-28.90,DEBIT_CARD
04/14/2026,PG&E WEB ONLINE,-94.20,DEBIT_CARD
04/15/2026,REI #145,-189.00,DEBIT_CARD
04/18/2026,EMPLOYER PAYROLL DEPOSIT,5000.00,ACH_CREDIT
04/19/2026,DOORDASH,-41.20,DEBIT_CARD
04/20/2026,XFINITY COMCAST,-89.00,DEBIT_CARD
04/22/2026,NETFLIX.COM,-15.99,DEBIT_CARD
```

Pick `account_id=1` (the seed creates one) or whichever exists.

- [ ] `POST /api/ingest/csv` returns 200 with an `inserted: N` count > 0.
- [ ] `GET /api/transactions?limit=20` returns the rows back.

Then run categorization once: `POST /api/categories/run` (or use the
"Run categorization" button in the UI later).

- [ ] Categorization endpoint returns a count of categorized transactions.

---

## 4. UI walkthrough — top to bottom

For each panel: glance at the snapshot card at the top, then expand any
detail drawers and verify the math.

### 4.1 Overview snapshot cards

At the very top of the page.

- [ ] **Money in · 90d** is green and ≥ $10,000 (two paychecks above).
- [ ] **Money out · 90d** is red and reflects the seeded debits.
- [ ] **Net · 90d** equals in − out, colored green if positive.
- [ ] **Recurring · monthly** is non-zero ONLY if you've already confirmed
      subscriptions (see §4.9). It's expected to read $0 on a fresh seed.

### 4.2 Budgets

Click `Budgets` in the nav.

- [ ] Month picker defaults to the current month (April 2026).
- [ ] "New budget" form shows up with the category dropdown populated.
- [ ] Add a budget: e.g. **Groceries — $400/mo**. The row should appear in
      the rollup with progress bar showing actual spend vs. limit.
- [ ] Pace badge: a budget that's burned faster than the month is passing
      shows a **warning** color, not at an arbitrary 80%. Test with a small
      number (e.g. set Groceries to $50) and confirm it goes red/warn.
- [ ] **Copy from previous month** and **Average-fill from history** buttons
      both produce sensible budgets — copy mirrors last month's amounts;
      average uses the trailing 3-month mean.
- [ ] Delete a budget — row disappears and stats recompute.

### 4.3 Savings & goals (Phase D — the new bit)

Click `Savings` in the nav.

**Surplus card (top):**

- [ ] Toggle defaults to **Both**, showing two figures side by side.
- [ ] Last-30-day surplus = inflows − outflows from your seeded txns
      (~$9k − $750 = ~$8,250 on the seed above).
- [ ] Click **Show breakdown ↓**: drawer shows the inflows / outflows / surplus
      breakdown for historical mode AND projected income / fixed obligations
      / variable spend / surplus for forecast mode.
- [ ] Switch to **Last 30d only** then **Next 30d only** — the value
      updates and only one breakdown card shows.
- [ ] If your forecast surplus is negative, a yellow note appears at the
      bottom of the card.

**Suggestions section:**

- [ ] **Allocate surplus**: shows up to 3 cards. Each card title is
      `Allocate $X to <goal>`. Click one — the before/after drawer opens
      showing current goal balance, projected if you act, projected if
      you don't act.
- [ ] **Cancel or downgrade**: empty until you confirm at least one
      subscription (see §4.9). Once confirmed, streaming subs should rank
      with conf ≥ 0.75; SaaS at ≈ 0.55; utilities at ≈ 0.20.
- [ ] **Debt payoff strategy**: empty until you create a debt-payoff goal
      with a linked credit account (next bullet). Once you do, both
      avalanche and snowball appear.

**Goals list:**

- [ ] Click **+ New goal**. Create:
  - Name: `Emergency fund — 1 month`
  - Kind: Emergency fund
  - Target: $3000
  - Target date: 6 months out
  - Priority: 1
  - Status: Active
- [ ] Card appears with progress bar at 0% and "remaining $3,000.00".
- [ ] Click **Log contribution** → enter $500 → Record.
- [ ] Card refreshes: bar at ~17%, current=$500.
- [ ] Click **Show history ↓** under the goal → contribution row appears.
      Delete it → card returns to 0% and history is empty.
- [ ] Re-log $500. Then create a second goal with target $400 and
      contribute $400. It should auto-mark **Achieved** and move to the
      "Achieved" section below.
- [ ] Edit a goal — change priority or notes — confirm cache is preserved.
- [ ] Create a **debt payoff** goal with linked debt account = your credit
      card. Refresh suggestions: an avalanche + snowball card should
      appear with months-to-payoff and interest-saved math.
- [ ] Verify the project rule: nowhere in the panel is there a button to
      transfer money. Every action records what *you* already did.

### 4.4 Credit

Click `Credit`.

- [ ] Three score cards (Experian, Equifax, TransUnion). All read `—` on a
      fresh DB.
- [ ] Add a score via the form: 720, Experian, fico8, today, source
      "Chase dashboard". Card flips to 720 with band "Good".
- [ ] Add a second score 30 days later (slightly higher) — sparkline
      appears next to the score history table.
- [ ] **Utilization table**: empty unless you set `credit_limit_cents` on
      a credit-card account. Use Swagger to PATCH an account with
      `credit_limit_cents`, `current_balance_cents`,
      `last_statement_balance_cents`, and `statement_close_day`. Refresh.
- [ ] Cliff markers visible on each utilization bar at 1, 10, 30, 50, 75%.
- [ ] **Opportunities** appear if any card is over a cliff. Click a card —
      it expands to show "what to do" steps, plus the Now / If you act /
      If you don't projection panels.

### 4.5 Spending trends

Click `Trends`.

- [ ] Month-over-month outflow by category. Big swings should sort to
      the top.
- [ ] Hovering / clicking a category should drill in (or not — depends on
      what's been wired; verify the panel renders without errors at minimum).

### 4.6 Class-action settlements

Click `Claims`.

- [ ] Three-state proof tabs: **No proof needed**, **Proof helpful**,
      **Proof required**. Default tab is "No proof needed" (the easy ones).
- [ ] Click **Run scraper** to refresh from TopClassActions + ClassAction.org.
      This actually fetches live HTML so it'll take a few seconds; expect a
      success notice with a count.
- [ ] Each card shows estimated payout, deadline, and an external link to
      the official settlement form. Verify the link goes to the correct
      domain before clicking through (the scraper does proof-heuristic
      classification but doesn't verify endpoints).

### 4.7 Bank connections (Plaid)

Click `Connect`.

- [ ] If Plaid creds are configured: **Link a bank** opens the Plaid Link
      modal and you can use the sandbox flow (`user_good` / `pass_good`).
- [ ] After link: at least one PlaidItem row appears. Click **Sync now** →
      transactions land in the DB and propagate to the Transactions panel.
- [ ] If creds aren't configured, the panel shows a helpful empty state
      with a link to `.env.example`. (Confirm no console error.)

### 4.8 Gmail

Click `Gmail`.

- [ ] If `client.json` is configured: **Connect Gmail** opens the OAuth
      flow. After consent, an EmailMessage row appears for any seeded label.
- [ ] Run a parse: it should produce structured rows for bank alerts,
      promo emails, statement closings. Check that one of the parsers fires
      against a real email body (Netflix promo, Adobe price-change, etc.).
- [ ] If creds aren't configured, the panel shows the empty state with
      setup instructions. (No console error.)

### 4.9 Recent transactions

Scroll down to **Recent transactions**.

- [ ] All seeded txns appear, most recent first.
- [ ] Each row shows date, description, category badge (or "Uncategorized"),
      amount (red for debits, green for credits), and source.
- [ ] Click **Run categorization** in the header — uncategorized rows pick
      up category badges based on the rule set.

### 4.10 Subscriptions & recurring charges

Scroll to **Subscriptions & recurring charges**.

- [ ] Detector should have flagged `NETFLIX.COM`, `SPOTIFY USA`,
      `XFINITY COMCAST`, and `PG&E WEB ONLINE` from the seed. (PG&E is
      variable-amount; should be flagged as such.)
- [ ] Type tabs across the top: Streaming / SaaS / Utilities / All. Each
      tab filters cleanly.
- [ ] Each row shows: name, type badge, confidence score, monthly cost,
      next expected date, and **Confirm / Dismiss** actions.
- [ ] **Confirm** Netflix → it now contributes to "Recurring · monthly" on
      the overview AND counts toward forecast surplus's fixed obligations.
- [ ] **Dismiss** PG&E → it disappears from the list (filter to "All" to
      see archived).
- [ ] If a price-change was detected (Adobe in the smoke test, or any
      observed live), it surfaces in **Price changes** with the
      prior → last comparison.

---

## 5. Cross-cutting checks

Things that should be true at every page, not just one:

- [ ] No red errors in DevTools console anywhere.
- [ ] No 500s in the backend log when navigating between panels.
- [ ] No "stale cache" — actions in one panel (e.g. confirm a sub) update
      the affected widgets in other panels (e.g. the surplus number on
      Savings) within a couple of seconds. (TanStack Query invalidations
      are wired across mutations.)
- [ ] Refreshing the browser doesn't lose state — everything is server-side
      in SQLite.
- [ ] Stop and restart the backend. **In Window A — Backend PowerShell:**
      press `Ctrl-C` to kill `uvicorn`, then re-run the same command from
      §2a:
      `uvicorn finance_app.api.main:app --reload --host 0.0.0.0 --port 8000`.
      On the first request after restart, the auto-migration line is silent
      (schema already current). Data persists.

---

## 6. Money-movement guardrail (the project rule)

This is a hard project rule and worth confirming explicitly:

- [ ] **Nowhere in the UI is there a button or workflow that transfers
      real money.** Every "Log contribution", "Cancel subscription",
      "Activate offer" action is either a record of what you already did
      or a deeplink to the merchant's own site. The app never executes
      financial transactions.

If you ever find a place that violates this rule, that's a bug — the
suggestion engine is supposed to be advisory only.

---

## 7. Known sharp edges

A short list of things that are still rough so you don't waste time
debugging known issues:

- **APR exactly = monthly interest charge**: For a debt with min-payment
  exactly equal to monthly interest (e.g. 24% APR + 2% min payment), the
  payoff projector returns `None` and the months are encoded as 0 in the
  before/after drawer. The interest comparison still works correctly.
  Real-world cards rarely sit on this exact edge.
- **Forecast variable-spend** uses the trailing 30-day average minus
  confirmed-active subs. If you've just confirmed a bunch of subs but
  haven't seen them charge yet, the forecast might double-count for the
  first 30 days until the trailing window flushes.
- **Vite hot-reload** sometimes loses the React Query devtools — full
  refresh fixes it.

---

## 8. When you're done

If everything passed: the app is ready for whatever's next on the roadmap
(Phase E — offer matching is the natural follow-on, since the surplus
engine now gives us a real "value-of-an-offer" anchor).

If something failed: capture the failing step number, the panel name, the
console error if any, and the relevant backend log line. That's enough for
a clean bug-fix loop.
