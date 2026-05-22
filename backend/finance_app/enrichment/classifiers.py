"""Per-transaction classifiers.

Each function in this module answers ONE yes/no question about a
transaction — "is this a paycheck?", "is this rent?", etc. The
classifiers are pure functions of the transaction (and, for category
classifiers, the category name string). No DB access, no context.

Why pure: callers can run them inside loops without worrying about
N+1 queries or surprise state. Anything that needs DB context (rent
attribution, recurring-payment matching) lives in
``finance_app.enrichment.effective_month`` (N-2) instead.

Sprint N-1 origin: these are direct lifts from ``budgets.py``. The
old names are kept there as aliases so existing callers don't break
during the migration. Once every caller imports from here, the
aliases come out.
"""
from __future__ import annotations

from finance_app.db.models import Transaction


# ---------- Pattern tables ----------
#
# These four tuples are the WHOLE rulebook for "what kind of transaction
# is this." Anything that affects how a txn is classified should go here
# — no string literals buried in callers, no per-endpoint copies.

# Categories whose "budget cap" is structurally a catch-all (not a real
# planned spending cap). Catchalls represent money MOVEMENT (between
# accounts, paying down a card, contributing to a brokerage), not
# spending. They get summed into total_budget for backward compatibility
# but excluded from real_budget_cents — the headline the user sees.
_CATCHALL_CATEGORY_PATTERNS: tuple[str, ...] = (
    "transfer",
    "uncategorized",
    "credit card payment",       # paying down a card isn't "spending"
    "investment contribution",   # surfaced separately under Savings
)

# Categories whose monthly recurrence pattern means a late-of-prior-month
# payment is actually for THIS month — rent, mortgage, HOA, etc. Used by
# the rent-attribution shift (effective_month).
_RECURRING_NEXT_MONTH_PATTERNS: tuple[str, ...] = ("rent", "mortgage")

# Substrings checked against (description_clean + description_raw + memo).
# If ANY match (case-insensitive), the inflow is treated as income, not
# a peer transfer / class-action settlement / Venmo gift / etc.
#
# Extend if Chris picks up a side job, a second W-2, or 1099 income.
_PAYROLL_DESC_HINTS: tuple[str, ...] = ("livio",)

# Substrings that mean "this outflow IS a savings transfer" — the
# corresponding inflow lands in an account Plaid doesn't see (Albert
# is scraped via Playwright, no Plaid feed). Extend with care: a
# false-positive here would over-count savings.
_SAVINGS_OUTFLOW_DESC_HINTS: tuple[str, ...] = (
    "albert edi",       # Albert "Smart Save" auto-sweeps from checking
)


# Sprint O-1 follow-up (2026-05-15): infrastructure for "other income" —
# windfalls / settlement payouts the user wants counted on the monthly
# Income headline but NOT extrapolated into recurring projection math.
#
# Currently empty per user direction (2026-05-15): "income should just
# be Livio paychecks." The Brigit class-action settlement arrived as a
# Zelle from a peer account so it wouldn't match anyway; Chris doesn't
# want any other one-time inflow surfaced as income for now.
#
# To re-enable: add unambiguous substrings here. Keep them specific
# enough to avoid matching peer transfers (don't add generic "zelle"
# or "ach"). Example: ("labaton", "stretto", "kroll").
_OTHER_INCOME_DESC_HINTS: tuple[str, ...] = ()


# ---------- Helpers ----------

def _tx_description_blob(tx: Transaction) -> str:
    """Concatenate the three description sources, lowercased.

    Aggregator feeds populate these inconsistently — Plaid puts the
    most useful info in ``description_clean``, OFX dumps it in
    ``description_raw``, manual entries land in ``memo``. We check all
    three so a hint match works regardless of source.
    """
    parts = (
        (tx.description_clean or ""),
        (tx.description_raw or ""),
        (tx.memo or ""),
    )
    return " ".join(parts).lower()


# ---------- Public classifiers ----------

def is_catchall(category_name: str | None) -> bool:
    """True if the category is a money-movement bucket, not real spending.

    Catchalls: Transfer, Uncategorized, Credit Card Payment, Investment
    Contribution. These inflate the "spent" headline if not filtered.
    """
    if not category_name:
        return False
    lower = category_name.lower()
    return any(p in lower for p in _CATCHALL_CATEGORY_PATTERNS)


def is_rent_category(category_name: str | None) -> bool:
    """True if the category name says rent / mortgage / HOA.

    Used by the effective_month rent-shift heuristic. Note: a txn can
    be "rent-like" even if its category is wrong (e.g. Zelle to
    landlord categorized as Transfer). That broader heuristic lives in
    ``effective_month.py`` and uses this classifier as one of its
    inputs.
    """
    if not category_name:
        return False
    lower = category_name.lower()
    return any(p in lower for p in _RECURRING_NEXT_MONTH_PATTERNS)


def is_payroll(tx: Transaction) -> bool:
    """True if this transaction's description suggests a paycheck.

    Match by substring rather than merchant_id because aggregator feeds
    rarely assign a merchant to a FEDWIRE inbound — it lands as raw
    text from the originator (e.g. "FEDWIRE CREDIT VIA: BMO BANK
    N.A./071000288 B/O: LIVIO BUILDING SYSTEMS INC ...").
    """
    blob = _tx_description_blob(tx)
    return any(p in blob for p in _PAYROLL_DESC_HINTS)


def is_savings_transfer(tx: Transaction) -> bool:
    """True if this outflow is a self-transfer to a savings app.

    The destination account isn't on Plaid (e.g. Albert is Playwright-
    scraped per Sprint 43), so the inflow side never registers via the
    inflow-sum path. This classifier lets the rollup count the OUTFLOW
    as savings instead.
    """
    blob = _tx_description_blob(tx)
    return any(p in blob for p in _SAVINGS_OUTFLOW_DESC_HINTS)


def is_other_income(tx: Transaction) -> bool:
    """True if this inflow is "other income" — windfalls / one-time
    payouts the user wants counted on the monthly Income headline but
    NOT extrapolated as recurring (Brigit / Labaton settlements, etc.).

    Excludes: peer Zelle/Venmo (we don't count those as income), and
    Livio paychecks (those are ``is_payroll``).
    """
    blob = _tx_description_blob(tx)
    return any(p in blob for p in _OTHER_INCOME_DESC_HINTS)
