"""Stub: Rocket Money weekly digest.

Not a source of truth for individual transactions (Plaid already has
those), but useful for cross-checking their subscription-finding claims
against ours.
"""
from __future__ import annotations

from ._stubs import make_stub

SPEC, parse = make_stub(
    name="rocket_money_digest",
    label="Rocket Money — weekly digest",
    from_domains=["rocketmoney.com", "truebill.com"],
    subject_patterns=[
        r"(weekly\s+digest|your\s+week|spending\s+summary|subscription)",
    ],
    kind="report",
)
