"""Auth-state-expiry notifier — Sprint 52.

When the scheduled balance-scrape job runs and a site lands in
:attr:`ScraperRunResult.sites_auth_missing`, we want the user to find
out via the Notifications panel rather than by digging through
scheduler logs. This module owns that emission path.

Dedup strategy
--------------
One notification per ``(site_key, ISO-week)`` pair. The week granularity
means: if a user ignores the notification for a week we re-emit (in case
the original was buried in unrelated alerts), but a freshly-bootstrapped
site won't get spammed with a new notification each morning while the
old one is still unread.

We do NOT auto-clear the notification when a subsequent scrape succeeds.
The user dismissing it is the explicit signal that they're done with it.
That mirrors how the rest of the Notifications panel works — read/dismiss
is always user-driven, never auto.

Notification kind
-----------------
``scraper_auth_missing`` — new top-level kind. The Notifications panel
already renders any kind via the generic body/title shape, so no
frontend wiring is required beyond the existing /api/notifications
endpoint.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import Notification

logger = logging.getLogger(__name__)


_NOTIFICATION_KIND = "scraper_auth_missing"

# Per-site copy. Keyed by ``site_key`` so adding a new scraper (e.g.
# Wealthfront, Chime) means appending one entry here. Falls back to a
# generic message when an unknown site_key is encountered.
_SITE_LABELS: dict[str, tuple[str, str]] = {
    # (display_name, bootstrap_command_hint)
    "albert": (
        "Albert",
        "py -m finance_app.scrapers.balances.bootstrap albert",
    ),
}

_GENERIC_BOOTSTRAP_HINT = (
    "py -m finance_app.scrapers.balances.bootstrap <site>"
)


def _week_key(site_key: str, when: datetime | None = None) -> str:
    """Build a stable dedup key: ``<site>:<YYYY>-W<ISO week>``.

    ISO week number is the right granularity here: it rolls over on
    Monday morning, which is when the user is most likely to be
    triaging notifications anyway. Calendar-month would be too coarse
    (a user who ignores it for a month then bootstraps would never see
    the original prompt at the right time).
    """
    ts = when or datetime.utcnow()
    iso = ts.isocalendar()
    return f"{site_key}:{iso.year}-W{iso.week:02d}"


def _existing_key_index(db: Session) -> dict[str, Notification]:
    """Pull existing scraper_auth_missing notifications keyed by their
    payload key. We never re-emit a notification with the same key —
    that's the entire dedup contract.

    Returns a dict so callers can either check membership cheaply OR
    surface the existing row for a possible update (we don't currently
    update; the body copy is stable per site).
    """
    rows = db.execute(
        select(Notification).where(Notification.kind == _NOTIFICATION_KIND)
    ).scalars().all()
    out: dict[str, Notification] = {}
    for n in rows:
        key = (n.payload or {}).get("key")
        if isinstance(key, str):
            out[key] = n
    return out


def emit_auth_missing_notifications(
    db: Session,
    site_keys: Iterable[str],
    *,
    now: datetime | None = None,
) -> int:
    """Emit one notification per site_key (week-deduped). Returns the
    count of NEW rows actually inserted.

    Caller is responsible for committing the session. We flush before
    returning so the caller sees the new IDs if they care, but a single
    db.commit() at the end of the scheduler job is enough.
    """
    site_list = list(site_keys)
    if not site_list:
        return 0
    existing = _existing_key_index(db)
    emitted = 0
    now = now or datetime.utcnow()
    for site_key in site_list:
        key = _week_key(site_key, now)
        if key in existing:
            # Already notified this week. Don't re-emit; user either
            # hasn't seen it yet, has seen and is ignoring it, or
            # they're working through their inbox.
            continue
        display, hint = _SITE_LABELS.get(
            site_key, (site_key.title(), _GENERIC_BOOTSTRAP_HINT.replace("<site>", site_key)),
        )
        notification = Notification(
            kind=_NOTIFICATION_KIND,
            title=f"{display} needs re-auth for the balance scraper",
            body=(
                f"The headless {display} session expired or never finished bootstrap. "
                f"Run `{hint}` once to refresh the saved auth state, then the daily "
                "balance scrape will resume. While this is out, Plaid still covers "
                "anything it can see — only the scraper-only products (e.g. Savings "
                "+ Investing for Albert) are paused."
            ),
            payload={
                "key": key,
                "site_key": site_key,
                "bootstrap_hint": hint,
            },
        )
        db.add(notification)
        emitted += 1
    if emitted:
        db.flush()
        logger.info(
            "balance-scrape auth-missing notifications emitted: %d (sites=%s)",
            emitted, site_list,
        )
    return emitted


__all__ = ["emit_auth_missing_notifications"]
