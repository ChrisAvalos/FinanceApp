"""Application configuration loaded from environment."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False, extra="ignore")

    database_url: str = "sqlite:///./finance.db"
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    cors_origins: str = "http://localhost:5173"

    # Phase 2+
    plaid_client_id: str = ""
    plaid_secret: str = ""
    plaid_env: str = "sandbox"

    # Gmail — CLI-first OAuth. credentials.json is the OAuth "Desktop app"
    # client you download from Google Cloud Console; token.json is written
    # the first time the user authorizes and refreshed automatically after.
    gmail_credentials_path: str = "./gmail_credentials.json"
    gmail_token_path: str = "./gmail_token.json"
    # Default scope — read-only is all we need. Never request send/compose.
    gmail_scopes: str = "https://www.googleapis.com/auth/gmail.readonly"
    # How far back to look on first sync (days). Subsequent syncs use the
    # last seen message's internalDate as the lower bound.
    gmail_initial_lookback_days: int = 180

    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.1"
    # Sprint 49 — vision-model receipt OCR fallback. Uses Ollama's
    # /api/generate "images" field with a multimodal model (llama3.2-vision
    # by default). Activated by the user clicking "Re-OCR with AI vision"
    # on a receipt — not auto-applied on upload, because pulling the
    # 8GB vision model isn't free and not every user wants it.
    #
    # Install hint (for the UI): `ollama pull llama3.2-vision`.
    ollama_vision_model: str = "llama3.2-vision"
    # Sprint 15 — T3 LLM categorization fallback. When True, the
    # CategorizationEngine calls Ollama for transactions that don't
    # match any Rule, MerchantAlias, or Plaid PFC mapping. Fail-open:
    # Ollama not running → silent fall-through to "Uncategorized".
    # After Sprint 12's PFC mapper, only ~3 of 400 typical txns reach
    # this fallback, so enabling it costs ~3 LLM calls per category
    # sync. Set OLLAMA_ENABLED=true (or set this to True) once Ollama
    # is installed + `ollama pull llama3.1` has been run.
    llm_fallback_enabled: bool = False

    # Scheduler
    plaid_refresh_enabled: bool = True
    plaid_refresh_interval_hours: int = 12  # twice a day is plenty for personal use
    # Wave F — scheduled subscription detection. Runs the same
    # SubscriptionDetector.sync_to_db that the "Re-detect" button calls,
    # so newly-detected aggregators get tagged and any price changes
    # land without manual prompting. Cheap (one DB pass), idempotent
    # (sync_to_db dedupes by name).
    subscription_detect_enabled: bool = True
    subscription_detect_interval_hours: int = 6
    # Class-action scraper schedule. Off by default in case the user
    # doesn't want background HTTP traffic until they've opted in.
    legal_claims_scrape_enabled: bool = True
    # Day-of-week for the cron trigger ("sun", "mon", ..., or "0"-"6").
    # APScheduler accepts both the abbreviation and the integer.
    legal_claims_scrape_day: str = "sun"
    legal_claims_scrape_hour: int = 6  # 6 AM local — fresh listings ready for Monday

    # Phase 6 — daily digest. Renders the weekly digest text via Ollama
    # (or the deterministic template fallback) and writes it to a dated
    # file under ``digest_output_dir``. Email delivery is the user's
    # choice — pipe the file into mail / forward via cron / etc.
    daily_digest_enabled: bool = True
    daily_digest_hour: int = 7  # 7 AM local
    daily_digest_output_dir: str = "./digest"

    # Phase 6 — automatic SQLite backups. Every ``backup_interval_hours``
    # we copy the live ``finance.db`` to ``backup_dir`` with a date
    # suffix and prune older than ``backup_retention_days``. Independent
    # of SQLCipher — runs whether the DB is encrypted or not.
    backup_enabled: bool = True
    backup_interval_hours: int = 168  # weekly
    backup_dir: str = "./backups"
    backup_retention_days: int = 60   # keep ~2 months of weekly snapshots

    # Phase 6 — offer scrapers (Chase + Amex). Off by default since the
    # auth-state files have to be bootstrapped manually first
    # (MANUAL_TASKS.md item #4). Once bootstrapped, flip this on in
    # .env and the scheduler runs the daily scrape headlessly.
    offers_scrape_enabled: bool = False
    offers_scrape_hour: int = 2  # 2 AM local

    # Phase 4.3 — credit-score scrapers (Credit Karma + CreditWise +
    # Chase Credit Journey). Same auth-state-file bootstrap pattern as
    # offers — see MANUAL_TASKS.md. Daily cron because consumer score
    # portals refresh roughly weekly anyway, so anything more frequent
    # is wasted requests + bot-detection risk.
    credit_scores_scrape_enabled: bool = False

    # FRED API key for the live yield-rate fetcher. Free 30-second
    # signup at https://fred.stlouisfed.org/docs/api/api_key.html.
    # When unset we fall back to Treasury.gov's public daily yield
    # curve XML feed, which is also free but slightly less granular.
    fred_api_key: str = ""
    credit_scores_scrape_hour: int = 3  # 3 AM local — after offers (2 AM), before digest

    # Sprint 51 — Albert balance scraper schedule. Same Playwright +
    # stored-auth pattern as offers / credit_scores: bootstrap once via
    # `py -m finance_app.scrapers.balances.bootstrap albert`, then the
    # scheduled job uses the saved state to read Savings + Investing
    # balances headlessly each morning. Default ON because Albert
    # exposes only Cash via Plaid and the scrape is the only way to
    # see the other products. Auth-state expiry is handled
    # gracefully — the coordinator returns it in `sites_auth_missing`
    # rather than raising. Sprint 52 turns that into a Notification.
    balance_scrapers_enabled: bool = True
    balance_scrapers_scrape_hour: int = 5  # 5 AM local — after prime (4 AM)

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
