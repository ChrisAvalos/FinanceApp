# Manual tasks for Chris

Things only you can do — saved here so they don't get lost while I keep
building. Knock these out in any order whenever you have time at your
PC. Each one unblocks features I've already built or will build.

Last updated: 2026-04-27

---

## Open

### 1. Plaid production approval (highest leverage)

**Why it matters:** every feature I've built — surplus, suggestions,
categorization, statement-close optimizer, rewards leakage — runs on
sandbox data right now. Production approval swaps that to your real
spending. ~30 min of form, 1–2 business days of Plaid review.

**Steps:**
1. Go to https://dashboard.plaid.com/team/keys and sign in.
2. Click **Request Production Access** (top-right).
3. Fill the application:
   - Use case: "Personal finance dashboard for my own accounts. No
     other users. Read-only access to transactions and account
     balances for budgeting, credit utilization tracking, and
     recurring-charge detection. App never initiates transfers or
     moves money."
   - Data retention: "Locally, on my own machine, in an encrypted
     SQLite file. Never transmitted to any third party."
   - # of users: 1
   - # of Plaid Items: 5–8 (count Chase, Amex, savings, investment
     accounts you'll link)
4. Submit. Wait 1–2 business days for review.
5. When approved, paste me back: `PLAID_CLIENT_ID`, `PLAID_SECRET`
   (production-specific), and confirmation that env=production. I'll
   wire it into `backend/.env`.

Cost: ~$0.30/account/month under Item-based pricing. For 5–8 cards =
$1.50–$4/month total. Sandbox stays free forever for testing.

---

### 2. (Phase 4) Playwright credit-score scrapers — install + log in once

**Why it matters:** Phase 4.3 scrapers (Credit Karma, Capital One
CreditWise, Chase Credit Journey) need an interactive first-time login
to save the auth-state cookies. After that, the daily APScheduler job
runs them headlessly.

**When the scrapers are built (deferred), you'll need to:**
1. **In Window A — Backend PowerShell** (with venv active):
   ```powershell
   pip install playwright
   python -m playwright install chromium
   ```
2. Run the auth-bootstrap helper once per scraper (I'll provide the
   exact command when I build #110). It opens a real browser, you log
   in normally, the helper saves the cookie state to disk.
3. Confirm the daily APScheduler job is enabled in `.env`.

This is the single most-manual item on this list because of the
per-site auth flows. Plan for ~30 min total once #110 is built.

---

### 3. (Phase 5) Ollama install + llama3.1 model pull

**Why it matters:** Phase 5.3 (insights narrator) and 5.4 (T3 fallback
categorization) both run a local Ollama instance. The code I'm writing
gracefully degrades when Ollama isn't reachable, so this isn't a hard
blocker — features just become null until Ollama is up.

**Steps (one-time):**
1. Download Ollama for Windows from https://ollama.com/download.
2. Run the installer. Ollama runs as a background service on port
   11434 by default.
3. Pull the model. **In any PowerShell:**
   ```powershell
   ollama pull llama3.1
   ```
   (~4 GB download.)
4. Verify it's running:
   ```powershell
   curl http://localhost:11434/api/tags
   ```
   Should return JSON listing `llama3.1`.
5. Confirm in `backend/.env`:
   ```
   OLLAMA_URL=http://localhost:11434
   OLLAMA_MODEL=llama3.1
   ```

Hardware: your Windows PC has plenty of RAM for llama3.1; expect
1–3 sec/response for short prompts.

---

### 4. (Phase 5) Chase/Amex Offers — interactive Playwright login

**Why it matters:** Phase 5.1 scraper needs a logged-in browser session
for chase.com and americanexpress.com to scrape your available offers.

**Steps when #112 ships:**
1. Same Playwright install as #2 above (only needed once total).
2. Run the auth-bootstrap helper for Chase + Amex. Opens a real
   browser; you log in once with 2FA; cookies are saved.
3. Daily scheduler then scrapes headlessly.

---

### 5. (Phase 6) Optional: SQLCipher install for at-rest encryption

**Why it matters:** Encrypts the SQLite file at rest so a stolen
laptop / backup file isn't a plaintext financial dump. Required
before iPhone sync; optional for desktop-only use. The Phase 6
weekly-backup job works either way (just snapshots whatever the
live DB happens to be).

**Steps when ready (defer as long as you like — current behavior is
fine for a single Windows machine you control):**
1. **In Window A** (with venv active):
   ```powershell
   pip install pysqlcipher3 keyring
   ```
2. I'll provide a one-shot migration helper that:
   - prompts you for a passphrase
   - stores it in the Windows Credential Manager via `keyring`
   - re-encrypts `finance.db` → `finance-encrypted.db`
   - swaps it in
3. From then on, `finance.db` is encrypted; the app reads the
   passphrase out of the keychain on startup. Backups stay
   encrypted by default (you can decrypt one out via the same
   helper if you ever need to inspect a snapshot in DB Browser).

(The helper doesn't exist yet — I'll write it whenever you flip the
"do this now" switch. Doing the migration before you have meaningful
real data in the DB is overkill.)

---

### 6. (Mobile, deferred) iPhone setup

Already documented in detail at
[`MOBILE_SETUP.md`](computer:///sessions/dreamy-trusting-bell/mnt/Finance App/MOBILE_SETUP.md).
Whenever you want to actually load the app onto your phone:
- Install Expo Go from App Store.
- `cd mobile` → `npm install` (1–3 min).
- Copy `.env.example` to `.env`, set `EXPO_PUBLIC_API_URL` to your
  Tailscale hostname.
- Double-click `_start-mobile.bat`, scan the QR with iPhone Camera.

---

## Done

(Empty — first item to land here will be Plaid prod approval.)
