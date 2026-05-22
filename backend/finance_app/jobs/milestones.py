"""Goal-milestone notifier.

Walks every active goal and emits a notification when a contribution
just crossed a 50% / 75% / 100% threshold since the last check.

Why "since last check" rather than "is currently above"
-------------------------------------------------------
The user shouldn't get a fresh notification every cron tick once a
goal sits over 50% — they should get ONE when they first cross. We
persist ``last_milestone_pct`` on the Goal so we know which thresholds
have already fired.

Notifications land in a new ``Notification`` table that the dashboard
reads. The notifier doesn't try to push them anywhere — it just
records the events. Future Phase 6 work can wire SMTP / system tray.
"""
from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy import select

from ..db.models import Goal, GoalStatus, Notification
from ..db.session import SessionLocal

logger = logging.getLogger(__name__)


# Crossing thresholds. Highest-fired wins so a goal that goes 0% → 100%
# in one contribution emits the 100% notification (not 50% or 75%).
_THRESHOLDS = (100, 75, 50)


def _highest_threshold_crossed(prev_pct: int, new_pct: int) -> int | None:
    """Return the highest threshold the progress just crossed, or None."""
    for t in _THRESHOLDS:
        if prev_pct < t <= new_pct:
            return t
    return None


def check_goal_milestones() -> dict:
    """One pass over all active goals. Idempotent.

    Returns a summary: how many goals checked, how many notifications
    created, per-threshold tally.
    """
    db = SessionLocal()
    started = datetime.utcnow()
    created_by_threshold: dict[int, int] = {}
    checked = 0
    try:
        goals = list(
            db.execute(
                select(Goal).where(Goal.status == GoalStatus.active)
            ).scalars().all()
        )
        for g in goals:
            checked += 1
            target = g.target_amount_cents or 0
            current = g.current_amount_cents or 0
            if target <= 0:
                continue
            new_pct = int(current / target * 100)
            prev_pct = g.last_milestone_pct or 0
            t = _highest_threshold_crossed(prev_pct, new_pct)
            if t is None:
                continue
            note = Notification(
                kind="goal_milestone",
                title=(
                    f"{g.name} hit {t}%"
                    if t < 100
                    else f"{g.name} reached its target!"
                ),
                body=(
                    f"You've contributed ${current/100:,.2f} toward your "
                    f"${target/100:,.2f} goal — that's {new_pct}% of the way there."
                ),
                payload={
                    "goal_id": g.id,
                    "threshold": t,
                    "current_amount_cents": current,
                    "target_amount_cents": target,
                    "current_pct": new_pct,
                },
            )
            db.add(note)
            g.last_milestone_pct = max(prev_pct, t)
            created_by_threshold[t] = created_by_threshold.get(t, 0) + 1
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("goal-milestone job failed")
        raise
    finally:
        db.close()

    finished = datetime.utcnow()
    summary = {
        "started_at": started.isoformat() + "Z",
        "finished_at": finished.isoformat() + "Z",
        "goals_checked": checked,
        "notifications_created": sum(created_by_threshold.values()),
        "by_threshold": created_by_threshold,
    }
    logger.info("goal-milestones done: %s", summary)
    return summary
