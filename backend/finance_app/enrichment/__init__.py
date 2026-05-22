"""finance_app.enrichment - one source of truth for what a txn means.

Sprint N: every consumer reads from EnrichmentService.enrich_batch(...)
instead of computing its own heuristics. New rules go in one place and
propagate everywhere.
"""
from __future__ import annotations

from finance_app.enrichment.classifiers import (
    is_catchall,
    is_other_income,
    is_payroll,
    is_rent_category,
    is_savings_transfer,
)
from finance_app.enrichment.effective_month import (
    RENT_SHIFT_DAY_CUTOFF,
    effective_month_for,
    find_rent_like_txns,
)
from finance_app.enrichment.service import (
    EnrichedTransaction,
    EnrichmentService,
)

__all__ = [
    "EnrichedTransaction",
    "EnrichmentService",
    "RENT_SHIFT_DAY_CUTOFF",
    "effective_month_for",
    "find_rent_like_txns",
    "is_catchall",
    "is_other_income",
    "is_payroll",
    "is_rent_category",
    "is_savings_transfer",
]
