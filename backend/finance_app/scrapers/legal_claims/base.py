"""Shared types for class-action scrapers.

Every scraper boils a website down to the same `ScrapedClaim` record —
a normalized intermediate that the coordinator can persist without
caring which site it came from. The shape mirrors the columns on
``LegalClaim`` minus the lifecycle fields the user controls
(`status`, `claimed_at`, `paid_at`, `actual_payout_cents`).

Why a Protocol instead of a base class
--------------------------------------
The two pilot scrapers share almost no logic — TopClassActions is a
WordPress index with predictable post structure, ClassAction.org has a
hand-built listings index with very different markup. Forcing them
through a base class would invite leaky abstractions that need
overriding anyway. A Protocol keeps duck-typing honest and makes it
trivial to register a 3rd scraper later (or a fake for tests).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Iterable, Protocol, runtime_checkable

import httpx

from finance_app.db.models import ProofRequirement


@dataclass
class ScrapedListing:
    """One detail-page URL pulled off an index/listing page.

    Carrying the raw HTML alongside the URL lets a scraper batch its
    HTTP fetches in one place and hand the parsed soup to ``parse()``
    without re-fetching. For tests we feed in pre-saved HTML fixtures.
    """
    url: str
    html: str


@dataclass
class ScrapedClaim:
    """Normalized listing record. Everything except ``source_url`` and
    ``name`` is optional — scrapers should err on the side of leaving
    fields blank rather than guessing wrong. The triage UI handles the
    long tail.

    ``source`` is set by the coordinator from the scraper's ``name``
    attribute, prefixed with ``scraper:`` so manual entries (``source =
    "manual"``) and scraped entries are easy to tell apart on the row.
    """
    name: str
    source_url: str
    administrator: str | None = None
    case_number: str | None = None
    description: str | None = None
    eligibility: str | None = None
    proof_status: ProofRequirement = ProofRequirement.unknown
    estimated_payout_cents: int | None = None
    claim_deadline: date | None = None
    notes: str | None = None
    # State eligibility — comma-separated postal codes (``"CA,FL"``)
    # or ``"nationwide"``. Defaults to nationwide; the coordinator
    # may override using ``state_parser.extract_states()`` on the
    # scraped text if the scraper itself didn't populate the field.
    state_eligibility: str = "nationwide"
    # Free-form extra metadata the scraper picked up but doesn't have a
    # column for. Preserved into ``notes`` if the column is empty.
    extras: dict[str, str] = field(default_factory=dict)


@runtime_checkable
class LegalClaimScraper(Protocol):
    """Contract every scraper must satisfy.

    The split between ``fetch_pages`` and ``parse`` is deliberate:

    * ``fetch_pages(client)`` does network — easy to swap in an
      ``httpx.MockTransport`` or skip entirely in tests.
    * ``parse(listing)`` is a pure function from HTML to
      ``ScrapedClaim`` (or ``None``) — directly unit-testable with HTML
      fixtures, no network, no DB.
    """
    name: str

    def fetch_pages(self, client: httpx.Client) -> Iterable[ScrapedListing]:
        """Yield (url, html) tuples for each detail page worth parsing."""
        ...

    def parse(self, listing: ScrapedListing) -> ScrapedClaim | None:
        """Parse one detail page; return None to skip a malformed/irrelevant row."""
        ...
