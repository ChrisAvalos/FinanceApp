# Finance App

A local-first personal finance engine. Ingests everything you spend and earn, categorizes it, detects subscriptions and recurring bills, and — the part nobody else does well — cross-references your actual spending against available promos, card offers, and bundle deals so it can tell you *specifically* where you're leaving money on the table.

Built to be **better than Rocket Money** on the analysis side, without the subscription fee and without constant LLM API costs.

## Design principles

1. **Local-first, private by default.** SQLite on your machine. No third party ever sees your transaction history.
2. **No LLM tokens required to run.** The engine is rule-based + heuristic. A local LLM (Ollama) is an optional enhancement for fuzzy merchant matching and conversational queries — never required.
3. **Ingest from everywhere.** Plaid, CSV/OFX exports, Gmail statements + promo emails, Playwright automation for stubborn sites, and interactive Q&A for things the app can't see ("what's your Xfinity bill?").
4. **Every number is traceable.** Every transaction links back to its source (file, email, API call, manual entry). Every categorization links to the rule that produced it. No black boxes.
5. **Suggestions are quantified.** "Activate Chase Offer at Starbucks" becomes "Activate Chase Offer at Starbucks — based on your $85/mo spend, this is worth ~$8.50/quarter."

## Stack

| Layer | Choice | Why |
|---|---|---|
| Database | SQLite (via SQLAlchemy + Alembic) | Zero-config, single file, fast enough for personal finance, easy to back up |
| Backend | Python 3.11 + FastAPI | Chris's strongest language. FastAPI gives typed endpoints + OpenAPI for free |
| Data libs | pandas, rapidfuzz, ofxparse, python-dateutil | Statement parsing, fuzzy merchant matching |
| Web UI | React + Vite + TypeScript + TanStack Query + Tailwind | Fast dev loop; types generated from backend OpenAPI |
| Mobile (later) | React Native (Expo) | Shares business logic and TS types with web |
| Optional LLM | Ollama (llama3.1 or similar) | Local, free to run, used for edge cases only |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Ingestion Layer                          │
│                                                                 │
│  Plaid   │  CSV/OFX  │  Gmail   │  Playwright  │  Q&A Intake   │
│   ↓          ↓           ↓            ↓              ↓         │
│  staging tables (raw rows)  →  normalizer  →  canonical schema │
└─────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────┐
│                     Canonical Data Model (SQLite)               │
│  Institutions · Accounts · Merchants · Categories ·             │
│  Transactions · Balances · Subscriptions · Bills · Offers       │
└─────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────┐
│                        Analysis Engines                         │
│                                                                 │
│  Categorizer · Subscription detector · Recurring bill detector  │
│  Offer matcher · Budget tracker · Suggestion generator          │
└─────────────────────────────────────────────────────────────────┘
                                  ↓
┌─────────────────────────────────────────────────────────────────┐
│               FastAPI   →   React web   +   React Native        │
└─────────────────────────────────────────────────────────────────┘
```

## Repo layout

```
Finance App/
├── README.md                    (this file)
├── backend/
│   ├── pyproject.toml
│   ├── Makefile                 # make dev, make db, make seed, make test
│   ├── .env.example
│   ├── alembic.ini
│   ├── alembic/                 # migrations
│   ├── finance_app/
│   │   ├── config.py
│   │   ├── db/
│   │   │   ├── models.py        # SQLAlchemy schema
│   │   │   └── session.py
│   │   ├── ingestion/
│   │   │   ├── base.py          # Importer ABC
│   │   │   ├── csv_importer.py  # Chase, BofA, Amex, Discover, Citi adapters
│   │   │   ├── ofx_importer.py
│   │   │   ├── plaid_connector.py     # ✓ phase 2 done — sandbox + live
│   │   │   └── deduplication.py
│   │   ├── gmail/                     # ✓ phase 2 — OAuth client + parser registry
│   │   │   ├── client.py              # Gmail API wrapper (InstalledAppFlow)
│   │   │   ├── connector.py           # search → parse → persist orchestrator
│   │   │   └── parsers/               # one file per sender (Chase, Xfinity, …)
│   │   ├── categorization/
│   │   │   ├── engine.py
│   │   │   ├── rules.py
│   │   │   └── seed_rules.yaml
│   │   ├── subscriptions/       # phase 3
│   │   ├── offers/              # phase 4
│   │   ├── suggestions/         # phase 4
│   │   ├── intake/              # interactive Q&A, phase 2
│   │   └── api/
│   │       ├── main.py
│   │       ├── transactions.py
│   │       ├── accounts.py
│   │       ├── categories.py
│   │       ├── rules.py
│   │       └── ingest.py
│   ├── scripts/
│   │   └── smoke_test.py
│   └── tests/
├── web/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx
│       ├── api/                 # generated types + client
│       └── pages/Transactions.tsx
├── mobile/                      # phase 5 — Expo scaffold
└── sample_data/
    └── chase_example.csv
```

## Roadmap

### Phase 1 — Foundation (this scaffold)
Data model, CSV/OFX ingestion, rule-based categorization, FastAPI, minimal React page. Goal: import your Chase CSV, see every transaction correctly categorized, in a web UI, running on your machine.

### Phase 2 — Real-world connectors
- **Plaid integration (sandbox first, switch to live via `PLAID_ENV`) — ✓ done**
  - Link token → public-token exchange → `/transactions/sync` with cursor-based pagination
  - Sign-flip on ingest (Plaid positive = our negative)
  - APScheduler auto-refresh every `PLAID_REFRESH_INTERVAL_HOURS` (default 12h)
  - UI: "Connect a bank" button with Plaid Link (+ sandbox quick-connect shortcut in dev)
- Gmail parser for bank alerts, receipts, statements
- Interactive Q&A intake ("tell me about your monthly bills")
- CSV adapters for more institutions

#### Plaid setup
1. Get sandbox credentials at [dashboard.plaid.com](https://dashboard.plaid.com/signup).
2. Add to `backend/.env`:
   ```
   PLAID_CLIENT_ID=your_id
   PLAID_SECRET=your_sandbox_secret
   PLAID_ENV=sandbox
   ```
3. `pip install plaid-python` (already in `pyproject.toml`, so `pip install -e ".[dev]"` picks it up).
4. Restart the API. The UI's **Connect a bank** button uses Plaid Link; in sandbox you can also click **Sandbox quick-connect** to skip the UI entirely.

Endpoints (all under `/api/plaid`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/plaid/status` | Is Plaid configured? Returns env + credential presence. |
| GET | `/plaid/items` | List connected items. |
| POST | `/plaid/link-token` | Mint a link_token for Plaid Link. |
| POST | `/plaid/exchange` | Exchange a public_token for an access_token + PlaidItem. |
| POST | `/plaid/sync/{item_id}` | Run `/transactions/sync` for one item. |
| POST | `/plaid/sync-all` | Sync every non-error item. |
| DELETE | `/plaid/items/{item_id}` | Forget a connection (local-only; does not call `/item/remove` yet). |
| GET | `/plaid/schedule` | Background-refresh state + next run time. |
| POST | `/plaid/sandbox/public-token` | Sandbox-only public_token for scripted tests. |

#### Gmail setup

Goal: pull transaction alerts, bills, promo offers, and credit-report summaries from the user's Gmail inbox. Read-only scope, local-first — the token file never leaves the machine.

**Scope:** `https://www.googleapis.com/auth/gmail.readonly`. We deliberately do NOT request send/compose/modify.

**One-time Google Cloud Console setup:**
1. Open [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) and create a new project (or pick an existing personal one).
2. Click **Enable APIs and Services** → search for *Gmail API* → **Enable**.
3. Under **OAuth consent screen** pick *External* (since this isn't a Workspace app), fill in the required fields, and add your own Gmail address under **Test users**. You can stay in *Testing* status forever — Google only requires verification if you publish.
4. Back under **Credentials** click **Create Credentials → OAuth client ID → Desktop app**. Download the resulting JSON.
5. Save the file at the path from `backend/.env` (default `backend/gmail_credentials.json`). **Never commit it.**

**Authorize + sync:**
```bash
# Either use the API:
curl -X POST http://localhost:8000/api/gmail/authorize   # opens a browser
curl -X POST http://localhost:8000/api/gmail/sync -H 'content-type: application/json' -d '{}'

# Or use the UI: scroll to the "Gmail inbox" section and click Authorize → Sync Gmail.
```

First sync pulls the last 180 days (`GMAIL_INITIAL_LOOKBACK_DAYS`). Subsequent syncs default to the last 14 days — cheap enough to run on the Plaid scheduler's cadence later.

Endpoints (all under `/api/gmail`):

| Method | Path | Purpose |
|---|---|---|
| GET | `/gmail/status` | Configured? Authorized? Last sync + counts. |
| POST | `/gmail/authorize` | Run the installed-app OAuth flow (opens browser on the backend machine). |
| POST | `/gmail/sync` | Search + fetch + parse + persist. Body: `{newer_than_days, extra_filters, max_results}`. |
| GET | `/gmail/messages` | List parsed emails. Filters: `outcome`, `parser`, `domain`, `limit`, `offset`. |
| GET | `/gmail/parsers` | Introspect registered parsers + per-parser match counts. |

**Current parser coverage:** Chase transaction alerts (full) and Xfinity bills (full) are the two working pilots. Stubs (SPEC-only, no extraction logic yet) exist for: Amex, Bank of America, Wells Fargo, PG&E, generic water utilities, Netflix, Spotify, Credit Karma, SmartCredit, TransUnion, Equifax, Experian, Rocket Money digests, and student loan servicers (Nelnet / MOHELA / Aidvantage / Sallie Mae / Great Lakes). Stubs still pull their mail into the EmailMessage table so you can see what you'd be parsing — filling them in is a 30-line file per sender.

### Phase 3 — Subscription & recurring-bill detection
Scan transactions for recurring-amount + same-merchant + ~30-day cadence. Flag unused subscriptions (merchant not used often enough to justify). Track next-charge dates, missed charges, price increases.

### Phase 4 — Offer engine (the unique sauce)
- **Offer sources:** Chase Offers (scrape via Playwright), promo emails (Gmail parser), provider bundles (Xfinity → Peacock, T-Mobile → Apple TV, etc.), credit-card benefit databases
- **Offer matching:** for each offer, check (a) do I have the required card, (b) do I actually spend at that merchant, (c) what's the estimated value at my spend level
- **Suggestion generator:** ranks opportunities by dollar value, groups by type (activate offer vs. cancel subscription vs. switch plan vs. negotiate bill), explains the math

### Phase 5 — Mobile + sync
React Native (Expo) app. Local-network sync with the desktop backend, or self-hosted tiny server. Push notifications when new offers match your spend.

## How to run

### macOS / Linux

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
make seed        # creates finance.db + loads categories & rules
make smoke       # end-to-end test
make dev         # FastAPI at http://localhost:8000

# web
cd ../web && npm install && npm run dev   # Vite at http://localhost:5173
```

### Windows (PowerShell)

Windows doesn't have `make` by default, PowerShell 5.1 (the built-in version)
doesn't support `&&`, and Python is often invoked via the `py` launcher
instead of `python`. Use these commands instead:

```powershell
cd "C:\path\to\Finance App\backend"
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
copy .env.example .env

# equivalents to the Makefile targets:
py -m finance_app.db.seed              # make seed
py scripts\smoke_test.py               # make smoke
uvicorn finance_app.api.main:app --reload   # make dev
```

If `Activate.ps1` errors with *"running scripts is disabled on this system"*,
run this once (allows locally-authored scripts to run):

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Then close & reopen PowerShell. The prompt will show `(.venv)` at the start
once the virtual environment is active.

**If `python --version` fails but `py --version` works**, you have Python via
the py launcher — use `py` everywhere above (as shown). If both fail, install
Python: `winget install Python.Python.3.12`. Then close & reopen PowerShell.

**Nicer-to-have for Windows dev:** install PowerShell 7 (`winget install
Microsoft.PowerShell`) — it supports `&&` and Unix-ish syntax, so the macOS/Linux
commands above mostly just work. Or use WSL for a fully Unix environment.

### Smoke test

Either OS, the smoke test is the fastest way to confirm the pipeline works:

```
python scripts/smoke_test.py   # macOS/Linux — or:  py scripts\smoke_test.py
```

Expected output ends with:

```
SMOKE TEST PASSED ✓
```

## Design notes

**Why SQLite, not Postgres?** Personal finance is a small dataset (tens of thousands of transactions over a decade). SQLite handles this easily and gives us a single-file backup that's trivial to encrypt and move. If we ever outgrow it, SQLAlchemy makes the migration painless.

**Why rule-based categorization first?** An LLM call per transaction is both expensive and overkill — 95% of transactions are obvious from the merchant name. A rule engine with fuzzy merchant lookup handles them for free. The remaining 5% can optionally route to a local LLM (Ollama), which is still free to run.

**Why generate TypeScript types from OpenAPI?** Physics lesson in disguise: don't maintain the same schema in two places. The backend is the single source of truth. `openapi-typescript` turns the FastAPI spec into TS types automatically, so renaming a field on the backend produces compile errors on the frontend.

**Why an Importer ABC + per-institution adapters?** Every bank exports CSVs slightly differently (column order, date format, amount sign convention). One base class with per-institution subclasses keeps the weird formatting quirks contained and makes adding a new institution a 30-line PR.
