"""Background-job bodies (Phase 6).

Each function here is a thin wrapper that the scheduler calls on its
configured cadence. They open their own DB session and never raise
out — failures are logged and the next run tries again.

Layout:

  * :mod:`backup` — weekly snapshot of finance.db with retention pruning
  * :mod:`digest` — daily render of the weekly digest text + file output
  * :mod:`milestones` — goal-milestone notification check (50/75/100%)
  * :mod:`notify_signals` — anomaly / sub-price-up / low-balance /
    large-charge notification emitters
"""
from .backup import run_backup
from .digest import write_daily_digest
from .milestones import check_goal_milestones
from .notify_signals import emit_signal_notifications

__all__ = [
    "check_goal_milestones",
    "emit_signal_notifications",
    "run_backup",
    "write_daily_digest",
]
