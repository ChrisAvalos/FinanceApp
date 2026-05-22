"""Transaction deduplication.

Reimporting the same CSV must not create duplicate rows. Native unique IDs from
Plaid can be trusted; for CSVs we don't have one, so we derive a stable fingerprint
from the fields a bank can't easily change between exports:

    hash(account_id | posted_date | amount_cents | normalized_description)

The ``normalized_description`` strips whitespace, uppercases, and collapses runs
of non-alphanumeric characters so "STARBUCKS  #1234  CA" and
"Starbucks #1234 CA" hash to the same value.
"""
from __future__ import annotations

import hashlib
import re
from datetime import date

_NORMALIZE_RE = re.compile(r"[^A-Z0-9]+")


def normalize_description(desc: str) -> str:
    return _NORMALIZE_RE.sub(" ", desc.upper()).strip()


def fingerprint(
    *,
    account_id: int,
    posted_date: date,
    amount_cents: int,
    description: str,
) -> str:
    normalized = normalize_description(description)
    payload = f"{account_id}|{posted_date.isoformat()}|{amount_cents}|{normalized}"
    return hashlib.sha256(payload.encode()).hexdigest()[:32]
