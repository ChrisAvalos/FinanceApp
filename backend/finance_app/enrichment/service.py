"""EnrichmentService - one place that says what a transaction means.

This service is the architectural answer to the "two implementations
of the same rule, one drifts" bug class. Before Sprint N each endpoint
re-derived its own version of "is this rent?" / "is this savings?" /
"is this a catchall?" - and they drifted, which is how the rent
drawer ended up missing Valeria Zelle, the financial donut over-
counted catchalls, etc.

Sprint N rollout:
  N-1: dataclass, service skeleton, classifier delegation.
  N-2: real effective_month with rent-shift attribution.
  N-3 (this revision): real enrich_batch that pre-computes context
       and adds per-category aggregation for is_paid_committed.
  N-4..N-7: rewire each consumer to call enrich_batch.
  N-8: reasoning[] surfaced in UI tooltips.

Why a class, not module-level functions: context (category lookup,
rent-like ids, today's date) loads once on __init__. Per-txn
enrichment becomes O(1) - important for enrich_batch over the few
thousand txns a rollup typically scans.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import Category, Transaction
from finance_app.enrichment.classifiers import (
    is_catchall,
    is_payroll,
    is_rent_category,
    is_savings_transfer,
)
from finance_app.enrichment.effective_month import (
    effective_month_for,
    find_rent_like_txns,
)


# Threshold for is_paid_committed: this category has used at least
# ``PAID_COMMITTED_THRESHOLD`` of its cap and counts as "the bill got paid."
# Used by the Plan card + recommender to avoid suggesting cuts on bills
# already paid or about to clear.
PAID_COMMITTED_THRESHOLD = 0.80


@dataclass(frozen=True)
class EnrichedTransaction:
    """A transaction plus everything the app needs to know about it.

    Consumers iterate over ``list[EnrichedTransaction]`` instead of
    ``list[Transaction]`` and read ``.is_catchall`` etc. directly. No
    consumer should ever re-derive these fields - if you need a new
    one, add it here and compute it in the service.

    Why frozen: enrichment results are immutable snapshots of "what we
    knew at compute time." Mutating them downstream would re-introduce
    the drift problem this whole service exists to fix.
    """
    base: Transaction
    # Month this txn counts toward (YYYY-MM-01). First-of-posted-month
    # for most txns; shifted forward for rent-like txns posted on/after
    # day 25 of the prior month. Computed in N-2.
    effective_month: date
    # Catchall (Transfer / Uncategorized / CC Payment / Investment).
    # Money movement, not spending. Drives the "real budget" headline.
    is_catchall: bool
    # Paycheck-like inflow. Drives the income headline + expected-
    # remaining-income projection.
    is_payroll: bool
    # Self-transfer-to-savings outflow (Albert EDI etc.) - counted as
    # savings even though the destination account isn't on Plaid.
    is_savings_transfer: bool
    # Rent / mortgage / HOA - either by category name or by recurring-
    # pattern match against history. Drives the effective_month shift.
    is_rent_like: bool
    # True iff the category is committed (NOT is_discretionary) AND
    # the category's actual spend for this effective_month >=
    # PAID_COMMITTED_THRESHOLD of its budget cap. Requires aggregation
    # so it's only filled by ``enrich_batch`` with budgets context;
    # ``enrich`` always returns False here.
    is_paid_committed: bool
    # Provenance - one line per rule that fired. Console-loggable now,
    # surfaced as UI tooltips in Sprint P.
    reasoning: list[str] = field(default_factory=list)


class EnrichmentService:
    """Loads context once; enriches one or many transactions.

    Usage::

        svc = EnrichmentService(db)
        enriched = svc.enrich_batch(
            txns,
            budgets_by_cat_id={1: 50000, 7: 200000},  # cap in cents
        )
        for e in enriched:
            if e.is_catchall:
                continue
            month_bucket[e.effective_month] += e.base.amount_cents

    The service is cheap to instantiate - one Category SELECT plus one
    rent-like scan over a 360-day window. Reuse a single instance per
    request to amortize.
    """

    def __init__(
        self,
        db: Session,
        *,
        today: date | None = None,
        rent_like_window_days: int = 180,
    ) -> None:
        self._db = db
        self._today = today or date.today()
        # Category lookup. Loaded once; rollup scans 500-1500 txns and
        # would otherwise issue one SELECT per row to resolve names.
        self._categories_by_id: dict[int, Category] = {
            c.id: c
            for c in db.execute(select(Category)).scalars().all()
        }
        # Precompute rent-like txn ids over a wide window around `today`.
        # 180 days each side covers a year of rollup queries without
        # re-scanning per request. ``find_rent_like_txns`` does its own
        # +/-lookback_days expansion for the recurrence check, so this
        # window only needs to bracket txns the rollup might bucket.
        rent_start = self._today - timedelta(days=rent_like_window_days)
        rent_end = self._today + timedelta(days=rent_like_window_days)
        rent_like = find_rent_like_txns(
            db, start_date=rent_start, end_date=rent_end
        )
        self._rent_like_ids: frozenset[int] = frozenset(t.id for t in rent_like)

    # ---------- Public API ----------

    def enrich(self, tx: Transaction) -> EnrichedTransaction:
        """Enrich a single transaction.

        ``is_paid_committed`` is always False here - it requires
        aggregation across the category, which only ``enrich_batch``
        can do. Prefer ``enrich_batch`` when you have more than one
        transaction or when you care about ``is_paid_committed``.
        """
        return self._build_one(tx)

    def enrich_batch(
        self,
        txns: list[Transaction],
        *,
        budgets_by_cat_id: dict[int, int] | None = None,
    ) -> list[EnrichedTransaction]:
        """Enrich many transactions in one pass.

        Two passes internally:

          1. ``_build_one`` for each txn - sets every field EXCEPT
             ``is_paid_committed``, which defaults to False.
          2. If ``budgets_by_cat_id`` is provided, aggregate outflow
             per (category_id, effective_month) and re-emit any
             transactions whose category crossed
             ``PAID_COMMITTED_THRESHOLD`` of its cap with
             ``is_paid_committed=True``.

        Why a re-emit instead of mutation: ``EnrichedTransaction`` is
        frozen on purpose - mutating it downstream is exactly the
        drift problem Sprint N fixes. ``dataclasses.replace`` produces
        a new frozen instance with the one flag flipped, leaving the
        rest of the snapshot intact.

        Parameters
        ----------
        txns
            Transactions to enrich. Order is preserved in the result.
        budgets_by_cat_id
            Optional ``{category_id: cap_cents}`` for the effective
            month(s) in ``txns``. When omitted, ``is_paid_committed``
            stays False for everyone (sensible default - callers that
            don't care don't pay the cost).
        """
        if not txns:
            return []

        enriched = [self._build_one(t) for t in txns]
        if not budgets_by_cat_id:
            return enriched

        # Pass 2: aggregate per (category_id, effective_month) and
        # decide which categories crossed the threshold.
        spend_by_key: dict[tuple[int, date], int] = defaultdict(int)
        for e in enriched:
            cat_id = e.base.category_id
            if cat_id is None:
                continue
            if e.is_catchall:
                # Catchalls are money movement, not spending - don't
                # let a $5K credit-card payment look like "you blew
                # past your CC Payment budget."
                continue
            amt = e.base.amount_cents
            if amt < 0:  # outflow
                spend_by_key[(cat_id, e.effective_month)] += -amt

        paid_committed_cats: set[tuple[int, date]] = set()
        for (cat_id, month), spent in spend_by_key.items():
            cap = budgets_by_cat_id.get(cat_id)
            if cap is None or cap <= 0:
                continue
            cat = self._categories_by_id.get(cat_id)
            if cat is None:
                continue
            # A committed category is one we DON'T treat as
            # discretionary - rent, utilities, insurance, etc.
            if cat.is_discretionary:
                continue
            if spent / cap >= PAID_COMMITTED_THRESHOLD:
                paid_committed_cats.add((cat_id, month))

        if not paid_committed_cats:
            return enriched

        # Re-emit txns in paid-committed categories with the flag
        # flipped. Imports placed here to keep module-load cheap.
        from dataclasses import replace

        result: list[EnrichedTransaction] = []
        for e in enriched:
            key = (e.base.category_id, e.effective_month)
            if key in paid_committed_cats:
                reasoning = list(e.reasoning)
                reasoning.append(
                    f"is_paid_committed: spent >= "
                    f"{int(PAID_COMMITTED_THRESHOLD * 100)}% of cap "
                    f"on committed cat #{e.base.category_id}"
                )
                result.append(replace(
                    e,
                    is_paid_committed=True,
                    reasoning=reasoning,
                ))
            else:
                result.append(e)
        return result

    # ---------- Internals ----------

    def _build_one(self, tx: Transaction) -> EnrichedTransaction:
        """Compute every per-txn field. ``is_paid_committed`` is left
        False; aggregation belongs in the batch pass."""
        cat = self._categories_by_id.get(tx.category_id) if tx.category_id else None
        cat_name = cat.name if cat else None

        reasoning: list[str] = []
        # rent-like is the UNION of (a) category-name match and (b) the
        # recurring-payment heuristic preloaded in __init__. (b) is
        # what catches Chris's Zelle-to-landlord that Plaid tags as
        # Transfer.
        rent_by_category = is_rent_category(cat_name)
        rent_by_recurrence = tx.id in self._rent_like_ids
        rent_like = rent_by_category or rent_by_recurrence
        if rent_by_category:
            reasoning.append(f"rent: category='{cat_name}'")
        elif rent_by_recurrence:
            reasoning.append("rent: recurring-payment pattern matched")

        payroll = is_payroll(tx)
        if payroll:
            reasoning.append("payroll: description matched paycheck hints")
        savings = is_savings_transfer(tx)
        if savings:
            reasoning.append("savings: description matched savings-sweep hints")
        catchall = is_catchall(cat_name)
        if catchall:
            reasoning.append(f"catchall: category='{cat_name}'")

        eff_month = effective_month_for(tx, rent_like_ids=self._rent_like_ids)
        if eff_month != date(tx.posted_date.year, tx.posted_date.month, 1):
            reasoning.append(
                f"effective_month: shifted {tx.posted_date.isoformat()} -> "
                f"{eff_month.isoformat()} (rent-attribution)"
            )

        return EnrichedTransaction(
            base=tx,
            effective_month=eff_month,
            is_catchall=catchall,
            is_payroll=payroll,
            is_savings_transfer=savings,
            is_rent_like=rent_like,
            is_paid_committed=False,
            reasoning=reasoning,
        )
