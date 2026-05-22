"""Prime everything — first-run + on-demand orchestrator.

Why this exists:
    Most panels in the app derive from detector + scraper outputs that
    don't run on read — they need an explicit kick to populate. New
    users (or anyone hitting a fresh DB) see a sea of empty states:
    Subscriptions empty, Cash Flow forecast missing bills, Money on
    the Table missing cohorts, Legal claims empty, Card offers empty.

What this does:
    Runs every prime-able task that doesn't require external auth in
    sequence. Each task is wrapped — one failure can't tank the rest.
    Returns per-task status + counts so the UI can render a progress
    list ("Subscriptions: 3 detected · Class actions: 27 scraped …")
    and the user immediately sees the app populated.

Tasks NOT included here (need external setup):
    - Plaid sync — needs a connected Item.
    - Gmail-based parsers — need OAuth.
    - Playwright credit-score scrapers — need browser binaries.
    - Receipt OCR + canonicalize — only fires when receipts exist.
    - Offers scrape — included but reports auth_missing on every site
      until the user bootstraps Chase/Amex Playwright auth states.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Callable

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from finance_app.db.session import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/prime", tags=["prime"])


def _task(name: str, fn: Callable[[], Any]) -> dict[str, Any]:
    """Run one prime task, capture result/error in a uniform shape.

    Logs start/end so the operator can see which task is currently in
    flight if the request appears to hang. Without this, a hung scraper
    leaves the orchestrator silent and the only signal the user has is
    the spinner spinning forever.
    """
    logger.info("prime[%s] starting", name)
    start = time.perf_counter()
    try:
        result = fn()
        elapsed = time.perf_counter() - start
        logger.info("prime[%s] ok in %.2fs", name, elapsed)
        return {"name": name, "status": "ok", "result": result, "elapsed_s": round(elapsed, 2)}
    except Exception as exc:  # noqa: BLE001 — orchestrator must keep going
        elapsed = time.perf_counter() - start
        logger.exception("prime[%s] failed after %.2fs", name, elapsed)
        return {
            "name": name,
            "status": "error",
            "error": f"{type(exc).__name__}: {exc}",
            "elapsed_s": round(elapsed, 2),
        }


@router.post("/run")
def prime_run(db: Session = Depends(get_db)) -> dict[str, Any]:
    """Fire every detector + scraper that can run without external auth.

    Order matters: categorization first (so other detectors see proper
    categories), then merchant-derived detectors, then external
    scrapers. Each task wraps its own exception handling so a single
    failing module can't break the whole orchestration.
    """
    tasks: list[dict[str, Any]] = []

    # 1. Categorization — make sure rules → categories.
    # Sprint 15 — the LLM fallback is wired but off-by-default; the
    # setting is opt-in (Ollama must be installed + the model pulled).
    # When enabled, the engine routes any uncategorized merchant through
    # Ollama and pins a Rule with the answer so the next sync hits it
    # via the fast deterministic path.
    def run_categorization() -> dict[str, int]:
        from finance_app.categorization.engine import CategorizationEngine
        from finance_app.config import settings
        return CategorizationEngine(
            db,
            llm_fallback_enabled=settings.llm_fallback_enabled,
        ).categorize_all(only_unset=True)
    tasks.append(_task("categorization", run_categorization))

    # 2. Subscription detector — populates Subscriptions panel + Cash Flow events.
    def run_subscription_detect() -> dict[str, int]:
        from finance_app.subscriptions.detector import SubscriptionDetector
        return SubscriptionDetector(db).sync_to_db()
    tasks.append(_task("subscriptions", run_subscription_detect))

    # 3. Shopping patterns — only meaningful if receipts have been uploaded.
    def run_shopping_patterns() -> dict[str, Any]:
        from finance_app.db.models import Receipt
        if db.query(Receipt).count() == 0:
            return {"skipped": "no_receipts_uploaded"}
        from finance_app.shopping_patterns import (
            detect_recurring_purchases,
            persist_patterns,
        )
        detected = detect_recurring_purchases(db)
        res = persist_patterns(db, detected)
        return {
            "created": res.created,
            "updated": res.updated,
            "deactivated": res.deactivated,
        }
    tasks.append(_task("shopping_patterns", run_shopping_patterns))

    # 4. Canonical products — clusters receipt-item names.
    def run_canonicalize() -> dict[str, Any]:
        from finance_app.db.models import ReceiptItem
        if db.query(ReceiptItem).count() == 0:
            return {"skipped": "no_receipt_items"}
        from finance_app.canonicalization.canonicalizer import canonicalize_unmatched
        result = canonicalize_unmatched(db)
        return {"matched": result.matched, "created": result.created}
    tasks.append(_task("canonical_products", run_canonicalize))

    # 5. Deals — scan price observations vs user's median.
    def run_deals_scan() -> dict[str, Any]:
        from finance_app.deals import run_scrape
        result = run_scrape(db)
        return {
            "patterns_scanned": result.patterns_scanned,
            "observations_created": result.total_observations_created,
        }
    tasks.append(_task("deals", run_deals_scan))

    # 6. Legal claims scrape — TopClassActions + classaction.org.
    def run_legal_claims_scrape() -> dict[str, Any]:
        from finance_app.scrapers.legal_claims import default_scrapers, run_scrapers
        result = run_scrapers(db, default_scrapers())
        return {
            "scrapers_run": len(result.summaries) if hasattr(result, "summaries") else None,
            "claims_created": getattr(result, "total_created", None),
        }
    tasks.append(_task("legal_claims", run_legal_claims_scrape))

    # 7. Offers scrape — Chase + Amex Playwright. Will report
    # auth_missing on every site until the user bootstraps auth state.
    def run_offers_scrape() -> dict[str, Any]:
        from finance_app.scrapers.offers.coordinator import scrape_and_match
        result = scrape_and_match(db)
        return {
            "sites_run": len(result.summaries),
            "matches": len(result.matches),
            "auth_missing": sum(1 for s in result.summaries if s.auth_missing),
        }
    tasks.append(_task("offers", run_offers_scrape))

    # 8. Signal-driven notifications — emit Notification rows for new
    # anomalies, sub price increases, low-balance forecasts, and large
    # recent charges. Idempotent (dedupes by payload['key']).
    def run_signal_notifications() -> dict[str, Any]:
        from finance_app.jobs import emit_signal_notifications
        return emit_signal_notifications(db=db)
    tasks.append(_task("signal_notifications", run_signal_notifications))

    summary = {
        "ok": sum(1 for t in tasks if t["status"] == "ok"),
        "error": sum(1 for t in tasks if t["status"] == "error"),
        "total": len(tasks),
    }
    return {"summary": summary, "tasks": tasks}
