"""Background refresh scheduler.

Uses APScheduler's BackgroundScheduler (daemon thread) started from the
FastAPI lifespan. Why BackgroundScheduler and not AsyncIOScheduler:

    * Our sync flow is blocking SQLAlchemy + blocking plaid-python — both run
      fine in a worker thread and keeping it off the main event loop keeps
      request latency deterministic.
    * Simpler lifecycle — we start/stop the scheduler in lifespan and it
      owns its own thread pool.

Jobs:

    plaid-refresh
        Every N hours, run PlaidConnector.sync_all() against every
        non-error PlaidItem. Configured via PLAID_REFRESH_INTERVAL_HOURS
        and PLAID_REFRESH_ENABLED.

Design notes:

    * We also schedule a first run 60 seconds after startup — handy for
      dev + makes "connect bank, wait 2 minutes, see fresh txns" true.
    * We use coalesce=True so if the host was asleep for 3 cycles, we only
      run once, not three times back-to-back.
    * max_instances=1 prevents two syncs from racing if the previous one
      is still going (e.g. Plaid slow day).
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from finance_app.config import settings
from finance_app.db.session import SessionLocal

logger = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def _refresh_plaid_items() -> None:
    """Background job body — run PlaidConnector.sync_all under its own session.

    Lazy-imports the connector so APScheduler can still be started if
    plaid-python isn't installed; the job will just fail gracefully.
    """
    logger.info("plaid-refresh job starting at %s", datetime.utcnow().isoformat())
    try:
        from finance_app.ingestion.plaid_connector import PlaidClient, PlaidConnector
    except ImportError as exc:
        logger.warning("plaid-refresh skipped — plaid-python not installed: %r", exc)
        return

    if not settings.plaid_client_id or not settings.plaid_secret:
        logger.info("plaid-refresh skipped — PLAID_CLIENT_ID / PLAID_SECRET unset")
        return

    db = SessionLocal()
    try:
        try:
            connector = PlaidConnector(db, PlaidClient())
        except Exception as exc:  # noqa: BLE001 — plaid-python can raise at ctor
            logger.error("plaid-refresh could not build client: %r", exc)
            return
        result = connector.sync_all()
        logger.info(
            "plaid-refresh done: %d items, per-item counts=%s",
            result["item_count"],
            result["items"],
        )
    finally:
        db.close()


def _scrape_legal_claims() -> None:
    """Weekly job — pull new class-action listings from configured sources.

    Lives behind ``LEGAL_CLAIMS_SCRAPE_ENABLED`` so users who don't
    want the background HTTP traffic can opt out without disabling the
    whole scheduler.
    """
    logger.info("legal-claims-scrape job starting at %s", datetime.utcnow().isoformat())
    try:
        from finance_app.scrapers.legal_claims import default_scrapers, run_scrapers
    except ImportError as exc:
        logger.warning("legal-claims-scrape skipped — missing deps: %r", exc)
        return

    db = SessionLocal()
    try:
        result = run_scrapers(db, default_scrapers())
        logger.info(
            "legal-claims-scrape done: created=%d updated=%d sources=%s",
            result.total_created,
            result.total_updated,
            [(s.source, s.rows_seen, s.error) for s in result.summaries],
        )
    finally:
        db.close()


def _scrape_credit_scores() -> None:
    """Daily job — pull scores from Credit Karma + CreditWise + Credit Journey.

    Skips silently when auth-state files aren't bootstrapped — coordinator
    surfaces that as a per-portal "auth_missing" flag rather than crashing.
    """
    logger.info("credit-scores-scrape job starting at %s", datetime.utcnow().isoformat())
    try:
        from finance_app.scrapers.credit_scores.coordinator import scrape_and_persist
    except ImportError as exc:
        logger.warning("credit-scores-scrape skipped — missing deps: %r", exc)
        return

    db = SessionLocal()
    try:
        result = scrape_and_persist(db)
        logger.info(
            "credit-scores-scrape done: new=%d sources=%s",
            len(result.new_scores),
            [(s.site_key, s.rows_seen, s.rows_created, s.auth_missing, s.error) for s in result.summaries],
        )
    except Exception:  # noqa: BLE001
        logger.exception("credit-scores-scrape failed")
    finally:
        db.close()


def _scrape_balances() -> None:
    """Sprint 51 — daily job: refresh Albert (and future) balance scrapers.
    Sprint 52 — also emits an auth-missing Notification per site that
    failed the auth check, so the user sees a clean prompt in the
    Notifications panel instead of having to grep scheduler logs.

    Mirrors the same shape as ``_scrape_offers`` / ``_scrape_credit_scores``:
    coordinator returns a ``ScraperRunResult`` with sites_succeeded,
    sites_auth_missing (bootstrap needed), and sites_failed. Each
    individual scraper is wrapped in try/except inside the coordinator
    so one site choking doesn't block the rest.
    """
    logger.info("balance-scrape job starting at %s", datetime.utcnow().isoformat())
    db = SessionLocal()
    try:
        from finance_app.scrapers.balances.coordinator import run_scrapers
        from finance_app.scrapers.balances.notify import emit_auth_missing_notifications
        result = run_scrapers(db)
        # Sprint 52 — emit auth-expired notifications. Weekly-deduped
        # via the notify module so a chronically-unbootstrapped site
        # produces one prompt per week, not per day.
        emitted = 0
        if result.sites_auth_missing:
            try:
                emitted = emit_auth_missing_notifications(db, result.sites_auth_missing)
                db.commit()
            except Exception:  # noqa: BLE001 — notifier failure shouldn't break the job
                logger.exception("balance-scrape auth-missing notify failed")
                db.rollback()
        logger.info(
            "balance-scrape done: %d/%d sites, %d balances written, %d new accounts. "
            "auth_missing=%s (new_notifications=%d) failed=%s",
            result.sites_succeeded,
            result.sites_attempted,
            result.balances_written,
            result.accounts_created,
            list(result.sites_auth_missing),
            emitted,
            [(s, e[:120]) for s, e in result.sites_failed],
        )
    except Exception:  # noqa: BLE001 — never let a Playwright crash kill the scheduler
        logger.exception("balance-scrape failed")
    finally:
        db.close()


def _scrape_offers() -> None:
    """Daily job — pull Chase + Amex Offers, value-rank against trailing spend."""
    logger.info("offers-scrape job starting at %s", datetime.utcnow().isoformat())
    db = SessionLocal()
    try:
        from finance_app.scrapers.offers.coordinator import scrape_and_match
        result = scrape_and_match(db)
        logger.info(
            "offers-scrape done: total_value=$%.2f matches=%d sources=%s",
            result.total_estimated_value_cents / 100,
            len(result.matches),
            [(s.site_key, s.rows_seen, s.auth_missing, s.error) for s in result.summaries],
        )
    except Exception:  # noqa: BLE001
        logger.exception("offers-scrape failed")
    finally:
        db.close()


def _run_backup() -> None:
    logger.info("backup job starting at %s", datetime.utcnow().isoformat())
    try:
        from finance_app.jobs import run_backup
        result = run_backup()
        logger.info("backup done: %s", result)
    except Exception:  # noqa: BLE001
        logger.exception("backup failed")


def _run_daily_digest() -> None:
    logger.info("daily-digest job starting at %s", datetime.utcnow().isoformat())
    try:
        from finance_app.jobs import write_daily_digest
        result = write_daily_digest()
        logger.info("daily-digest done: %s", result)
    except Exception:  # noqa: BLE001
        logger.exception("daily-digest failed")


def _run_milestones() -> None:
    """Quick check — runs every hour. Cheap (counts goals only)."""
    try:
        from finance_app.jobs import check_goal_milestones
        result = check_goal_milestones()
        if result["notifications_created"] > 0:
            logger.info("goal-milestones fired: %s", result)
    except Exception:  # noqa: BLE001
        logger.exception("goal-milestones failed")


def _refresh_yield_rates() -> None:
    """Daily job — pull fresh T-bill yields from FRED (or Treasury.gov
    fallback) and persist to the JSON cache so the yield-opt panel
    shows today's rates instead of a hardcoded 6-month-old snapshot.
    """
    try:
        from finance_app.yield_rates import refresh_rates_cache
        rates = refresh_rates_cache()
        if rates is not None:
            logger.info(
                "yield-rates refreshed via %s: 4w=%.2f%% 13w=%.2f%% 26w=%.2f%%",
                rates.source,
                rates.tbill_4wk_apy,
                rates.tbill_13wk_apy,
                rates.tbill_26wk_apy,
            )
        else:
            logger.warning("yield-rates refresh returned None — keeping hardcoded fallback")
    except Exception:  # noqa: BLE001
        logger.exception("yield-rates refresh failed")


def _run_signal_notifications() -> None:
    """Hourly check — emit notifications for new anomalies, subscription
    price changes, low-balance forecasts, and large recent charges.

    Each producer is itself idempotent (dedupes against existing
    notifications via payload['key']) so re-running every hour can
    only emit genuinely-new events.
    """
    try:
        from finance_app.jobs import emit_signal_notifications
        result = emit_signal_notifications()
        if result.get("total", 0) > 0:
            logger.info("signal-notifications fired: %s", result)
    except Exception:  # noqa: BLE001
        logger.exception("signal-notifications failed")


def _run_prime_everything() -> None:
    """Daily prime — fires the same endpoint the Overview "Prime everything"
    button calls. Wraps every detector + scraper that can run without
    external auth (categorization, subscription detector, shopping patterns,
    canonical products, deals scan, legal-claims scrape, offers scrape).

    Idempotent: each underlying task either upserts or no-ops on re-runs.
    Independent of the dedicated per-source jobs above (legal_claims,
    offers) — running the same scrape twice in a day is just an extra
    HTTP fetch that produces no new rows once the dedup hits.
    """
    from finance_app.api.prime import prime_run  # local import to avoid bootstrap-time import cycle
    db = SessionLocal()
    try:
        result = prime_run(db=db)
        ok = result.get("summary", {}).get("ok", 0)
        err = result.get("summary", {}).get("error", 0)
        total = result.get("summary", {}).get("total", 0)
        logger.info("prime-everything done: %d/%d ok, %d error", ok, total, err)
        if err > 0:
            failures = [
                f"{t['name']}: {t.get('error', '?')}"
                for t in result.get("tasks", [])
                if t.get("status") == "error"
            ]
            logger.warning("prime-everything had failures: %s", failures)
    except Exception:  # noqa: BLE001
        logger.exception("prime-everything failed")
    finally:
        db.close()


def _detect_subscriptions() -> None:
    """Wave F-9 — periodic subscription re-detect.

    Same code path the "Re-detect" button on the Subscriptions panel
    invokes. Picks up new recurring charges that have crossed the
    minimum-occurrence threshold, refreshes price-change deltas, and
    auto-tags aggregator parents (Apple App Store, Google Play, etc.)
    via the composite_detector. Idempotent: ``sync_to_db`` upserts by
    cluster key and never auto-flips user-confirmed rows.
    """
    logger.info("subscription-detect job starting at %s", datetime.utcnow().isoformat())
    db = SessionLocal()
    try:
        from finance_app.subscriptions.detector import SubscriptionDetector
        result = SubscriptionDetector(db).sync_to_db()
        logger.info(
            "subscription-detect done: created=%d updated=%d composite_tagged=%d total=%d",
            result.get("created", 0),
            result.get("updated", 0),
            result.get("composite_tagged", 0),
            result.get("total", 0),
        )
        # Chain the composite-receipt reconciler — if Apple/Google
        # receipts have been parsed since the last run, this is when
        # the line items get extruded into child Subscription rows.
        try:
            from finance_app.subscriptions.composite_reconciler import reconcile_composite_receipts
            recon = reconcile_composite_receipts(db)
            if recon.children_created or recon.children_updated:
                logger.info(
                    "composite-receipts done: created=%d updated=%d unlinked=%d",
                    recon.children_created,
                    recon.children_updated,
                    recon.receipts_unlinked,
                )
        except Exception:  # noqa: BLE001
            logger.exception("composite-receipts reconcile failed")
    except Exception:  # noqa: BLE001
        logger.exception("subscription-detect failed")
    finally:
        db.close()


def _snapshot_networth() -> None:
    """Daily NetWorthSnapshot for the historical chart."""
    db = SessionLocal()
    try:
        from finance_app.networth import snapshot_net_worth
        snap = snapshot_net_worth(db)
        logger.info(
            "net-worth snapshot %s: assets=$%.2f liabilities=$%.2f net=$%.2f",
            snap.as_of.isoformat(),
            snap.assets_cents / 100,
            snap.liabilities_cents / 100,
            snap.net_cents / 100,
        )
    except Exception:  # noqa: BLE001
        logger.exception("net-worth snapshot failed")
    finally:
        db.close()


def start_scheduler() -> BackgroundScheduler | None:
    """Start the singleton scheduler. Safe to call twice (returns the existing one).

    Each job is gated by its own enable flag in :class:`Settings`. We
    build the scheduler if ANY job is on so that adding a new job kind
    doesn't require touching this function — just flip its config flag.
    """
    global _scheduler
    if _scheduler is not None:
        return _scheduler

    plaid_on = settings.plaid_refresh_enabled
    scrape_on = settings.legal_claims_scrape_enabled
    digest_on = settings.daily_digest_enabled
    backup_on = settings.backup_enabled
    offers_on = settings.offers_scrape_enabled
    scores_on = settings.credit_scores_scrape_enabled
    sub_detect_on = settings.subscription_detect_enabled
    # Sprint 51 — Albert (and future) balance scrapers. Cheap (one
    # Playwright session per site) so it's enable-on by default; auth
    # bootstrap is per-site and the coordinator skips sites that
    # haven't been bootstrapped yet without raising.
    balances_on = settings.balance_scrapers_enabled
    if not any([plaid_on, scrape_on, digest_on, backup_on, offers_on, scores_on, sub_detect_on, balances_on]):
        logger.info("scheduler disabled — no jobs enabled")
        return None

    sched = BackgroundScheduler(daemon=True)

    if plaid_on:
        sched.add_job(
            _refresh_plaid_items,
            trigger=IntervalTrigger(hours=settings.plaid_refresh_interval_hours),
            id="plaid-refresh",
            name="Refresh Plaid items",
            coalesce=True,
            max_instances=1,
            next_run_time=datetime.utcnow() + timedelta(seconds=60),
        )

    if scrape_on:
        sched.add_job(
            _scrape_legal_claims,
            trigger=CronTrigger(
                day_of_week=settings.legal_claims_scrape_day,
                hour=settings.legal_claims_scrape_hour,
                minute=0,
            ),
            id="legal-claims-scrape",
            name="Scrape class-action settlements",
            coalesce=True,
            max_instances=1,
        )

    if digest_on:
        sched.add_job(
            _run_daily_digest,
            trigger=CronTrigger(hour=settings.daily_digest_hour, minute=0),
            id="daily-digest",
            name="Render daily digest",
            coalesce=True,
            max_instances=1,
        )

    if backup_on:
        sched.add_job(
            _run_backup,
            trigger=IntervalTrigger(hours=settings.backup_interval_hours),
            id="db-backup",
            name="SQLite backup snapshot",
            coalesce=True,
            max_instances=1,
            next_run_time=datetime.utcnow() + timedelta(minutes=5),
        )

    # Goal milestones: cheap hourly check. Always on if scheduler is on
    # — there's no reason a user would want to disable milestone
    # notifications for their own goals.
    sched.add_job(
        _run_milestones,
        trigger=IntervalTrigger(hours=1),
        id="goal-milestones",
        name="Check goal milestones",
        coalesce=True,
        max_instances=1,
    )

    # Signal-driven notifications: anomaly hits, subscription price
    # changes, low-balance forecasts, large recent charges. Each
    # producer dedupes by payload['key'] so re-running hourly only
    # emits genuinely-new events. Always on — the user can always
    # mark notifications read or dismiss them.
    sched.add_job(
        _run_signal_notifications,
        trigger=IntervalTrigger(hours=1),
        id="signal-notifications",
        name="Emit signal-driven notifications",
        coalesce=True,
        max_instances=1,
        next_run_time=datetime.utcnow() + timedelta(minutes=2),
    )

    # Net-worth snapshot — daily at 23:55 local so the snapshot reflects
    # the full day's activity. Cheap (one aggregated row).
    sched.add_job(
        _snapshot_networth,
        trigger=CronTrigger(hour=23, minute=55),
        id="net-worth-snapshot",
        name="Daily net-worth snapshot",
        coalesce=True,
        max_instances=1,
    )

    # Daily auto-prime — runs every detector + scraper at 04:00 local so
    # the user wakes up to fresh data (new class actions overnight, latest
    # subscription detections, etc.) without ever clicking the button
    # manually. Also fires once 5 minutes after startup so a fresh
    # backend doesn't sit idle waiting until 4am for its first prime.
    # Always on — there's no reason to disable it once you're past
    # first-run; each underlying task is best-effort wrapped.
    sched.add_job(
        _run_prime_everything,
        trigger=CronTrigger(hour=4, minute=0),
        id="prime-everything",
        name="Daily auto-prime (categorization + detectors + scrapers)",
        coalesce=True,
        max_instances=1,
        next_run_time=datetime.utcnow() + timedelta(minutes=5),
    )

    # Live yield-rate refresh — daily at 03:30, before the prime
    # everything cron at 04:00, so today's rates are in cache when
    # any subsequent yield-opt request comes in. Also a one-time
    # fire 3 minutes after startup so the very first opening of the
    # panel after a fresh install gets live numbers.
    sched.add_job(
        _refresh_yield_rates,
        trigger=CronTrigger(hour=3, minute=30),
        id="yield-rates-refresh",
        name="Refresh T-bill yield snapshot from FRED / Treasury.gov",
        coalesce=True,
        max_instances=1,
        next_run_time=datetime.utcnow() + timedelta(minutes=3),
    )

    if offers_on:
        sched.add_job(
            _scrape_offers,
            trigger=CronTrigger(hour=settings.offers_scrape_hour, minute=0),
            id="offers-scrape",
            name="Scrape Chase + Amex Offers",
            coalesce=True,
            max_instances=1,
        )

    if scores_on:
        sched.add_job(
            _scrape_credit_scores,
            trigger=CronTrigger(hour=settings.credit_scores_scrape_hour, minute=0),
            id="credit-scores-scrape",
            name="Scrape credit scores (CK + CreditWise + Credit Journey)",
            coalesce=True,
            max_instances=1,
        )

    if sub_detect_on:
        sched.add_job(
            _detect_subscriptions,
            trigger=IntervalTrigger(hours=settings.subscription_detect_interval_hours),
            id="subscription-detect",
            name="Re-detect subscriptions + reconcile composite receipts",
            coalesce=True,
            max_instances=1,
            # First run 90 seconds after startup so a fresh boot sees its
            # subscriptions auto-refreshed without the user clicking
            # "Re-detect." Sequenced after the Plaid 60-second first run
            # so we detect against the freshest transactions.
            next_run_time=datetime.utcnow() + timedelta(seconds=90),
        )

    if balances_on:
        sched.add_job(
            _scrape_balances,
            trigger=CronTrigger(
                hour=settings.balance_scrapers_scrape_hour,
                minute=0,
            ),
            id="balance-scrape",
            name="Scrape balances (Albert Savings + Investing, future neobanks)",
            coalesce=True,
            max_instances=1,
        )

    sched.start()
    _scheduler = sched
    logger.info(
        "scheduler started; plaid=%s scrape=%s digest=%s backup=%s offers=%s scores=%s sub_detect=%s balances=%s",
        plaid_on, scrape_on, digest_on, backup_on, offers_on, scores_on, sub_detect_on, balances_on,
    )
    return sched


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("scheduler stopped")
