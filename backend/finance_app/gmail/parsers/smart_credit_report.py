"""Stub: SmartCredit monthly report."""
from __future__ import annotations

from ._stubs import make_stub

SPEC, parse = make_stub(
    name="smart_credit_report",
    label="SmartCredit — credit report",
    from_domains=["smartcredit.com"],
    subject_patterns=[
        r"(credit\s+report|score\s+update|monthly\s+report)",
    ],
    kind="report",
)
