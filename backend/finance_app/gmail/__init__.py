"""Gmail ingestion — OAuth client, message fetcher, and parser registry.

Entry points:
- :class:`GmailClient`    — authenticate + fetch messages
- :class:`GmailConnector` — orchestrate search/fetch/parse/upsert
- ``parsers`` registry    — one parser per sender/subject pattern

The google-api-python-client stack is lazy-imported (in :mod:`client`) so
the rest of the app still boots cleanly even if the user hasn't run
``pip install -e ".[dev]"`` with Gmail deps yet.
"""
from __future__ import annotations
