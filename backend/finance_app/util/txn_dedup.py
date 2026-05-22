"""Shared transaction-dedup heuristics.

Used in two places:

* :mod:`finance_app.api.transactions` — the cleanup endpoint that
  finds-and-merges existing duplicates.
* :mod:`finance_app.ingestion.plaid_connector` — the ingest-time
  guard that prevents duplicates from being created in the first
  place when Plaid hands us a transaction we already have under
  a different external_id.

Plaid creates duplicates two ways:

  1. **Re-link generates new external_ids.** Removing + re-adding a
     Plaid item issues new transaction_ids for already-synced rows.
     Our exact (source, external_id, account_id) dedup misses these
     because the new external_id is different.
  2. **Pending → posted transitions.** A pending transaction shows up
     as "POS DEBIT MERCHANT" with one external_id. When it posts,
     Plaid sometimes replaces the description with the cleaner
     "MERCHANT NAME CITY DATE" form AND issues a new external_id —
     leaving the pending row orphaned in the DB.

The merchant-token extractor below is the join key that catches both
cases. We strip stop-words + digit-only tokens and return the first
remaining identifier, so "POS DEBIT APPLE.COM/BILL" and
"APPLE.COM/BILL CA 04/28" both resolve to "APPLE.COM/BILL".

Fuzzy matching is risky in general (e.g. two coffee shop visits on
the same day for the same amount aren't dupes), so callers should
ALWAYS combine the merchant token with (account_id, posted_date,
amount_cents) — three real-world coincidences in addition to a
matching merchant token is a strong enough signal in practice.
"""
from __future__ import annotations

import re

# Common bank-description stop-words. These appear in raw descriptions
# but don't help identify the merchant. Stripped during token extraction.
_DESC_STOPWORDS = frozenset({
    "POS", "DEBIT", "CREDIT", "PURCHASE", "PAYMENT", "PMT", "WITHDRAWAL",
    "DEP", "DEPOSIT", "ACH", "CHK", "TXN", "TRANS", "TRANSACTION",
    "ONLINE", "MOBILE", "WEB", "AUTH", "AUTHORIZED",
})

# Punctuation we want to keep INSIDE a token (so APPLE.COM/BILL stays
# as one logical identifier rather than three). We strip leading and
# trailing punctuation but leave dots/slashes/dashes inside.
_PUNCT_STRIP = re.compile(r"^[^\w./]+|[^\w./]+$")
# A token that's just digits/dots/slashes/dashes — almost certainly a
# date or amount, not a merchant identifier. Skip.
_NUMERIC_RE = re.compile(r"[\d./\-]+")


def merchant_token(description: str) -> str:
    """Extract the most distinctive merchant-identifying token from a
    description. Used as a fuzzy join key for cross-external_id dedup.

    Strategy: uppercase, split on whitespace, strip surrounding
    punctuation, drop stop-words and pure-digit tokens. Return the
    FIRST remaining non-empty token. Returns "" when no usable token
    survives — callers should treat empty as "don't fuzzy-match this
    row" rather than as a key.

    Examples::

        merchant_token("APPLE.COM/BILL CA 04/28")          # "APPLE.COM/BILL"
        merchant_token("POS DEBIT APPLE.COM/BILL")         # "APPLE.COM/BILL"
        merchant_token("Dave Inc dave.com 04/10")          # "DAVE"
        merchant_token("GMASS (WWW.GMASS.CO) GMASS.CO OH") # "GMASS"
        merchant_token("POS DEBIT")                        # ""  (no merchant)
        merchant_token("")                                 # ""
    """
    if not description:
        return ""
    for raw in description.upper().split():
        cleaned = _PUNCT_STRIP.sub("", raw)
        if not cleaned:
            continue
        if cleaned in _DESC_STOPWORDS:
            continue
        if _NUMERIC_RE.fullmatch(cleaned):
            continue
        return cleaned
    return ""


def merchant_group_key(description: str, max_tokens: int = 2) -> str:
    """Stable grouping key — the first ``max_tokens`` significant tokens.

    ``merchant_token`` returns only the FIRST token, which is too coarse
    for grouping ("AMAZON MARKETPLACE" and "AMAZON PRIME" would collapse).
    A raw ``description[:25]`` prefix is the opposite problem — too
    granular: banks vary the TAIL of a description per-charge (store #,
    city, date, processor code) so the same merchant gets two keys.

    The first 2 significant tokens are the sweet spot: stable across a
    merchant's charges, specific enough to separate distinct merchants.

    Examples::

        merchant_group_key("MOVEMENT MOUNTAIN VIE CA 05/01")
            # "MOVEMENT MOUNTAIN"
        merchant_group_key("MOVEMENT MOUNTAIN VI WWW.MOVEMENTG CO 04/01")
            # "MOVEMENT MOUNTAIN"  ← same key despite the different tail
        merchant_group_key("POS DEBIT TROJAN STORAGE OF SAN J 310...")
            # "TROJAN STORAGE"
    """
    tokens: list[str] = []
    for raw in description.upper().split():
        cleaned = _PUNCT_STRIP.sub("", raw)
        if not cleaned:
            continue
        if cleaned in _DESC_STOPWORDS:
            continue
        if _NUMERIC_RE.fullmatch(cleaned):
            continue
        tokens.append(cleaned)
        if len(tokens) >= max_tokens:
            break
    return " ".join(tokens)


__all__ = ["merchant_token", "merchant_group_key"]
