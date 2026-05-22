"""Net-worth tracker (Phase 7.1).

The asset side of the picture, complementing the existing transaction
ledger / spending side. ``current_net_worth(db)`` is the single
function that anchors everything — it computes the latest
(assets, liabilities, net) tuple from the most recent BalanceSnapshot
per account.

A daily scheduler job (Phase 6 plumbing) calls
``snapshot_net_worth(db)`` to persist a NetWorthSnapshot row used for
the historical chart.

Why aggregate-then-snapshot rather than derive-on-read every chart
load: Plaid sync writes one BalanceSnapshot per linked account per
day, and walking those joined to Account on every chart request
costs O(accounts × days). One pre-aggregated row per day keeps the
chart endpoint a range scan.
"""
from .service import (
    AccountKind,
    NetWorthBreakdown,
    NetWorthSummary,
    classify_account,
    current_net_worth,
    log_manual_balance,
    snapshot_net_worth,
)

__all__ = [
    "AccountKind",
    "NetWorthBreakdown",
    "NetWorthSummary",
    "classify_account",
    "current_net_worth",
    "log_manual_balance",
    "snapshot_net_worth",
]
