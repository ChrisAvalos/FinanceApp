"""Stub: Student loan statement / autopay notice.

Covers common federal + private servicers (Nelnet, MOHELA, Aidvantage,
Sallie Mae, Great Lakes). We keep them in one stub because the body
formats will all need their own tweaks once samples arrive.
"""
from __future__ import annotations

from ._stubs import make_stub

SPEC, parse = make_stub(
    name="student_loan_statement",
    label="Student loan — statement",
    from_domains=[
        "nelnet.net",
        "mohela.com",
        "aidvantage.com",
        "salliemae.com",
        "mygreatlakes.org",
    ],
    subject_patterns=[
        r"(statement|payment\s+due|autopay|bill\s+ready)",
    ],
    kind="bill",
)
