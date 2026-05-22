"""Shared stub-parser helper.

Every "planned but not yet implemented" parser reuses this factory so
we only need to edit one place when we decide how stubs should behave.
A stub declares its SPEC (so :func:`build_search_query` pulls its mail
into the sync) and a ``parse`` that always returns ``None`` — meaning
"header-level match, but I don't know how to extract yet."

When you're ready to implement a stub, delete the ``from ._stubs import
make_stub`` file and write a real module with real ``parse``.
"""
from __future__ import annotations

from typing import Callable

from ..client import GmailMessage
from .base import ParseResult, ParserSpec


def make_stub(
    *,
    name: str,
    label: str,
    from_domains: list[str],
    subject_patterns: list[str] | None = None,
    kind: str = "transaction",
    priority: int = 80,  # below pilots so a real parser always wins
) -> tuple[ParserSpec, Callable[[GmailMessage], ParseResult | None]]:
    spec = ParserSpec(
        name=name,
        label=label,
        from_domains=from_domains,
        subject_patterns=subject_patterns or [],
        kind=kind,
        priority=priority,
    )

    def parse(_msg: GmailMessage) -> ParseResult | None:
        return None

    return spec, parse
