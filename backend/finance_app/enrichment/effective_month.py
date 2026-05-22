"""effective_month — which month does this transaction count toward?

The interesting case is RENT. A Zelle to the landlord posted on Apr 30
is *paying for May rent*, not April rent. If the rollup buckets it by
``posted_date.month`` (April), the May rent row in the drawer shows
$0 and the April row shows an extra $2,075 — which is exactly the
bug Chris caught.

This module owns two things:

  1. ``find_rent_like_txns`` — the historical recurring-payment scan.
     Lifted from ``budgets.py`` unchanged so semantics are preserved.

  2. ``effective_month_for(tx, *, rent_like_ids)`` — a PURE function
     that takes the transaction plus the precomputed set of rent-like
     transaction ids and returns the effective YYYY-MM-01.

Why split it that way: the rent-like detection requires DB context
(history scan) so it happens once on service init. The per-tx
effective-month computation is then a fast, side-effect-free
transform — exactly the shape ``enrich_batch`` wants.
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import Category, Transaction
from finance_app.enrichment.classifiers import is_rent_category


# Day-of-month boundary for the rent-attribution shift. A payment on day
# >= this in the prior month is treated as the current month's rent.
# Day 25 is a safe cutoff — pay-period landings on the 26th-31st all get
# shifted forward, but the 15th doesn't (which would be a second
# mid-month payment, not a month-end rent).
RENT_SHIFT_DAY_CUTOFF = 25

# Minimum amount for the "is this transaction rent?" recurring-payment
# heuristic. Sub-$800 monthly recurring outflows are usually subscriptions
# or insurance, not rent.
_RENT_LIKE_MIN_CENTS = 80_000

# Description tokens that strongly suggest a transaction IS rent even
# when miscategorized. Match against (description_clean + description_raw),
# lowercased.
_RENT_LIKE_DESC_HINTS: tuple[str, ...] = ("rent",)


# ---------- Public functions ----------

def find_rent_like_txns(
    db: Session,
    *,
    start_date: date,
    end_date: date,
    lookback_days: int = 120,
) -> list[Transaction]:
    """Return outflow transactions in [start_date, end_date] that look
    like rent payments, even if they're miscategorized.

    A transaction qualifies as "rent-like" if EITHER:
      (a) its category name contains a rent/mortgage keyword, OR
      (b) its description matches a recurring monthly outflow pattern:
          - amount >= ``_RENT_LIKE_MIN_CENTS``
          - same merchant_id (or, if missing, same description-derived
            recipient slug) has 2+ outflows within ``lookback_days``
            within ~20% of this amount

    Why (b): many Plaid feeds tag person-to-person Zelle/Venmo transfers
    as "Transfer," not "Rent/Mortgage," because the aggregator can't tell
    intent. Without it, Chris's $2,075 Zelle to his landlord never gets
    attributed as rent and the drawer shows $261 instead of $2,336.
    """
    # 1. Candidate outflows in the window.
    candidates = db.execute(
        select(Transaction, Category)
        .join(Category, Category.id == Transaction.category_id, isouter=True)
        .where(
            Transaction.posted_date >= start_date,
            Transaction.posted_date <= end_date,
            Transaction.amount_cents < 0,
        )
    ).all()

    out: list[Transaction] = []
    # H-2 follow-up: look BIDIRECTIONALLY for recurrence — both before AND
    # after the current window. Recurrence is what makes something
    # "rent-like" regardless of when we happen to be looking at it.
    history_window_start = start_date - timedelta(days=lookback_days)
    history_window_end = end_date + timedelta(days=lookback_days)
    history = db.execute(
        select(Transaction)
        .where(Transaction.amount_cents < 0)
        .where(Transaction.posted_date >= history_window_start)
        .where(Transaction.posted_date <= history_window_end)
    ).scalars().all()

    for tx, cat in candidates:
        amt = -tx.amount_cents
        # Branch (a) — category name says rent.
        if cat and is_rent_category(cat.name):
            out.append(tx)
            continue
        # Branch (b) — large recurring outflow that LOOKS like rent.
        if amt < _RENT_LIKE_MIN_CENTS:
            continue
        # Cheap-to-match description tell.
        desc_text = (
            (tx.description_clean or "") + " " + (tx.description_raw or "")
        ).lower()
        has_rent_hint = any(p in desc_text for p in _RENT_LIKE_DESC_HINTS)
        # Or a recurring-payment pattern via merchant_id match.
        recurring_match = False
        if tx.merchant_id is not None:
            for h in history:
                if h.id == tx.id:
                    continue
                if h.merchant_id != tx.merchant_id:
                    continue
                h_amt = -h.amount_cents
                if h_amt >= _RENT_LIKE_MIN_CENTS and abs(h_amt - amt) / max(amt, 1) <= 0.20:
                    recurring_match = True
                    break
        # No merchant id? Fall back to a coarser description match
        # (same first ~25 chars + similar amount).
        if not recurring_match and not has_rent_hint:
            short_desc = desc_text[:25]
            if len(short_desc) >= 10:
                for h in history:
                    if h.id == tx.id:
                        continue
                    h_desc = (
                        (h.description_clean or "") + " " + (h.description_raw or "")
                    ).lower()
                    if short_desc not in h_desc:
                        continue
                    h_amt = -h.amount_cents
                    if h_amt >= _RENT_LIKE_MIN_CENTS and abs(h_amt - amt) / max(amt, 1) <= 0.20:
                        recurring_match = True
                        break
        if recurring_match or has_rent_hint:
            out.append(tx)
    return out


def first_of_next_month(d: date) -> date:
    """First day of the month after ``d``."""
    if d.month == 12:
        return date(d.year + 1, 1, 1)
    return date(d.year, d.month + 1, 1)


def effective_month_for(
    tx: Transaction,
    *,
    rent_like_ids: frozenset[int],
) -> date:
    """Return the YYYY-MM-01 that ``tx`` should be bucketed under.

    Pure function — no DB access. Caller is responsible for pre-
    computing the rent-like id set (typically via ``find_rent_like_txns``
    cached on ``EnrichmentService``).

    Rules:
      - Default: first of ``tx.posted_date``'s month.
      - If ``tx.id in rent_like_ids`` AND ``tx.posted_date.day >=
        RENT_SHIFT_DAY_CUTOFF``: shift forward to first of next month.

    Examples (with rent_like_ids = {tx_apr30.id}):
      - Apr 30 rent      → May 1
      - May 1  rent      → May 1
      - May 15 rent      → May 1   (mid-month, no shift even if rent-like)
      - Apr 30 groceries → Apr 1   (not rent-like, no shift)
    """
    posted = tx.posted_date
    first_this_month = date(posted.year, posted.month, 1)
    if tx.id in rent_like_ids and posted.day >= RENT_SHIFT_DAY_CUTOFF:
        return first_of_next_month(first_this_month)
    return first_this_month
