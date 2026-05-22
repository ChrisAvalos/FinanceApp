"""Subscription service catalog — known prices for cross-reference.

Why this exists
---------------
When the engine detects a composite charge (APPLE.COM/BILL $10.99) the
user has to manually declare what's inside. The catalog turns "$10.99
on Apple" into a ranked guess like "this is likely Apple Music or
Apple TV+" by matching the charge amount against a registry of known
service prices.

Combined with Gmail signals (does this user actually have emails from
netflix.com? has Apple sent them a receipt mentioning Disney+?), the
suggester can produce surprisingly accurate proposals without ever
asking the user to type a name.

This is the "internet price check" feature done offline — no scraping,
no API calls, no live web traffic. The trade-off: prices go stale and
we have to refresh the catalog when services bump their rates. A
quarterly review is enough; consumer subscription prices move slowly.

Schema
------
Each entry declares:
    name              : "Netflix Standard" — the canonical display name
    monthly_cents     : 1549 — typical observed monthly charge (US, ad-free
                        unless otherwise noted). For tiered services, list
                        each tier as a separate entry.
    aggregators       : ("apple_app_store", "google_play", "direct") —
                        which billing paths typically settle as this row.
                        Used to suggest only catalog entries plausibly
                        billed by a given composite parent.
    email_domains     : ("netflix.com",) — sender domains the user would
                        receive correspondence from if signed up. Drives
                        Gmail cross-referencing.
    aliases           : optional list of secondary names the parser-
                        flagged emails might use ("hulu", "hulu plus").
    notes             : free-text hint shown alongside the suggestion.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Iterable


# Catalog freshness — bumped each time a human (or quarterly cron)
# verifies the price list. The /api/subscriptions/catalog/info
# endpoint exposes this so the UI can warn "catalog last verified
# X days ago — your suggestions may be stale." A useful 90-day
# default; consumer subscription prices move slowly enough that
# 90 days of drift is tolerable, 180+ starts to bite.
CATALOG_VERIFIED_AT = date(2026, 5, 11)
CATALOG_STALE_AFTER_DAYS = 120


@dataclass(frozen=True)
class CatalogEntry:
    name: str
    monthly_cents: int
    aggregators: tuple[str, ...]
    email_domains: tuple[str, ...] = ()
    aliases: tuple[str, ...] = ()
    notes: str = ""
    # Last-verified date overrides the module-level CATALOG_VERIFIED_AT
    # for entries that were updated more recently (e.g., the user noticed
    # a price bump on one service and we patched it without re-auditing
    # everything). Default is None → use the module date.
    last_verified: date | None = None


def catalog_age_days(today: date | None = None) -> int:
    """How many days since the catalog was last verified end-to-end."""
    today = today or date.today()
    return (today - CATALOG_VERIFIED_AT).days


def is_catalog_stale(today: date | None = None) -> bool:
    """True if the catalog hasn't been verified in CATALOG_STALE_AFTER_DAYS."""
    return catalog_age_days(today) >= CATALOG_STALE_AFTER_DAYS


# Prices reflect typical US ad-free / individual tier pricing as of
# 2026-05-11. Revisit quarterly. When you update a single entry's price
# mid-cycle, set its `last_verified` override so the UI can show "this
# specific entry was just refreshed" without resetting the whole
# catalog age.
#
# Where a service has multiple tiers, list each tier as a separate
# entry — the suggester ranks by exact-price match so all tiers compete
# fairly. Don't duplicate the same tier with a slightly-different
# price — the catalog should reflect what the merchant currently
# charges, not historical variations.
_CATALOG: tuple[CatalogEntry, ...] = (
    # ---- Streaming ----
    CatalogEntry("Netflix Basic", 799, ("apple_app_store", "google_play", "direct"),
                 email_domains=("netflix.com",),
                 aliases=("netflix",), notes="Ad-supported tier."),
    CatalogEntry("Netflix Standard", 1549, ("apple_app_store", "google_play", "direct"),
                 email_domains=("netflix.com",), aliases=("netflix",)),
    CatalogEntry("Netflix Premium", 2299, ("apple_app_store", "google_play", "direct"),
                 email_domains=("netflix.com",), aliases=("netflix",)),
    CatalogEntry("Hulu (with ads)", 799, ("apple_app_store", "google_play", "direct"),
                 email_domains=("hulu.com",), aliases=("hulu",)),
    CatalogEntry("Hulu (no ads)", 1799, ("apple_app_store", "google_play", "direct"),
                 email_domains=("hulu.com",), aliases=("hulu",)),
    CatalogEntry("Disney+", 999, ("apple_app_store", "google_play", "direct"),
                 email_domains=("disneyplus.com", "disney.com"),
                 aliases=("disney plus", "disney+")),
    CatalogEntry("Disney Bundle (Hulu+Disney+ESPN+)", 1999,
                 ("apple_app_store", "direct"),
                 email_domains=("disneyplus.com",), aliases=("disney bundle",)),
    CatalogEntry("Paramount+ Essential", 799,
                 ("apple_app_store", "google_play", "direct"),
                 email_domains=("paramountplus.com", "paramount.com"),
                 aliases=("paramount plus", "paramount+")),
    CatalogEntry("Paramount+ Premium", 1399,
                 ("apple_app_store", "google_play", "direct"),
                 email_domains=("paramountplus.com",),
                 aliases=("paramount plus", "paramount+", "paramount premium"),
                 notes="Premium tier (includes Showtime + live TV).",
                 last_verified=date(2026, 5, 11)),
    CatalogEntry("Peacock Premium (ad-supported)", 1099,
                 ("apple_app_store", "google_play", "direct"),
                 email_domains=("peacocktv.com", "nbcuni.com"),
                 aliases=("peacock",),
                 notes="Bumped from $7.99 in 2024; ad-supported tier.",
                 last_verified=date(2026, 5, 11)),
    CatalogEntry("Peacock Premium Plus (ad-free)", 1699,
                 ("apple_app_store", "google_play", "direct"),
                 email_domains=("peacocktv.com",), aliases=("peacock",),
                 notes="Ad-free tier; bumped from $13.99 in 2024.",
                 last_verified=date(2026, 5, 11)),
    CatalogEntry("ESPN+", 1199, ("apple_app_store", "google_play", "direct"),
                 email_domains=("espn.com", "espnplus.com"),
                 aliases=("espn plus", "espn+")),
    CatalogEntry("HBO Max / Max", 1599,
                 ("apple_app_store", "google_play", "direct"),
                 email_domains=("max.com", "hbomax.com"),
                 aliases=("hbo max", "max")),
    CatalogEntry("YouTube Premium", 1399,
                 ("apple_app_store", "google_play", "direct"),
                 email_domains=("youtube.com", "google.com"),
                 aliases=("youtube premium", "yt premium"),
                 notes="$13.99 direct; $20.99 when billed via Apple App Store "
                       "(Apple's 30% surcharge).",
                 last_verified=date(2026, 5, 11)),
    CatalogEntry("YouTube Premium (Apple billing)", 2099,
                 ("apple_app_store",),
                 email_domains=("youtube.com", "apple.com"),
                 aliases=("youtube premium",),
                 notes="Apple's 30% surcharge bumps the direct price to "
                       "$20.99 when billed through the App Store.",
                 last_verified=date(2026, 5, 11)),
    CatalogEntry("YouTube TV", 7299, ("direct",),
                 email_domains=("youtube.com",), aliases=("youtube tv", "yt tv")),

    # ---- Music ----
    CatalogEntry("Spotify Premium", 1199,
                 ("apple_app_store", "google_play", "direct"),
                 email_domains=("spotify.com",), aliases=("spotify",),
                 notes="Old grandfathered price (pre-Mar-2024 signup)."),
    CatalogEntry("Spotify Premium (current)", 1299,
                 ("apple_app_store", "google_play", "direct"),
                 email_domains=("spotify.com",), aliases=("spotify",),
                 notes="Current new-signup price (post-Mar-2024 bump).",
                 last_verified=date(2026, 5, 11)),
    CatalogEntry("Apple Music (Individual)", 1099, ("apple_app_store", "direct"),
                 email_domains=("apple.com",), aliases=("apple music",)),
    CatalogEntry("Apple Music (Family)", 1699, ("apple_app_store",),
                 email_domains=("apple.com",), aliases=("apple music",)),
    # Apple TV Channel — distinct from Apple TV+ (the streaming service).
    # Channel is the standalone "Apple TV app subscription bundle entry"
    # that came up in Chris's iPhone Subscriptions screen at $12.99.
    CatalogEntry("Apple TV Channel", 1299, ("apple_app_store",),
                 email_domains=("apple.com",),
                 aliases=("apple tv channel",),
                 notes="Distinct from Apple TV+ — this is the in-app "
                       "channel-store bundle.",
                 last_verified=date(2026, 5, 11)),

    # ---- Apple-native services ----
    CatalogEntry("iCloud+ 50GB", 99, ("apple_app_store",),
                 email_domains=("apple.com",),
                 aliases=("icloud", "icloud storage"),
                 notes="Apple's entry-tier storage."),
    CatalogEntry("iCloud+ 200GB", 299, ("apple_app_store",),
                 email_domains=("apple.com",),
                 aliases=("icloud", "icloud storage")),
    CatalogEntry("iCloud+ 2TB", 999, ("apple_app_store",),
                 email_domains=("apple.com",),
                 aliases=("icloud", "icloud storage")),
    CatalogEntry("iCloud+ 6TB", 2999, ("apple_app_store",),
                 email_domains=("apple.com",),
                 aliases=("icloud", "icloud storage")),
    CatalogEntry("Apple TV+", 999, ("apple_app_store",),
                 email_domains=("apple.com",), aliases=("apple tv plus", "tv+")),
    CatalogEntry("Apple Arcade", 699, ("apple_app_store",),
                 email_domains=("apple.com",), aliases=("arcade",)),
    CatalogEntry("Apple News+", 1299, ("apple_app_store",),
                 email_domains=("apple.com",), aliases=("news+", "news plus")),
    CatalogEntry("Apple Fitness+", 999, ("apple_app_store",),
                 email_domains=("apple.com",), aliases=("fitness+", "fitness plus")),
    CatalogEntry("Apple One (Individual)", 1995, ("apple_app_store",),
                 email_domains=("apple.com",), aliases=("apple one",),
                 notes="Bundles Music, TV+, Arcade, iCloud+ 50GB."),
    CatalogEntry("Apple One (Family)", 2595, ("apple_app_store",),
                 email_domains=("apple.com",), aliases=("apple one",),
                 notes="Bundles Music (Family), TV+, Arcade, iCloud+ 200GB."),
    CatalogEntry("Apple One (Premier)", 3295, ("apple_app_store",),
                 email_domains=("apple.com",), aliases=("apple one premier",),
                 notes="Music Family, TV+, Arcade, iCloud+ 2TB, News+, Fitness+."),

    # ---- Audio / books ----
    CatalogEntry("Audible Premium Plus", 1495, ("apple_app_store", "direct"),
                 email_domains=("audible.com", "amazon.com"),
                 aliases=("audible",)),
    CatalogEntry("Kindle Unlimited", 1199, ("apple_app_store", "direct"),
                 email_domains=("amazon.com",),
                 aliases=("kindle unlimited",)),

    # ---- Productivity / cloud ----
    CatalogEntry("Google One 100GB", 199, ("google_play", "direct"),
                 email_domains=("google.com",), aliases=("google one",)),
    CatalogEntry("Google One 200GB", 299, ("google_play", "direct"),
                 email_domains=("google.com",), aliases=("google one",)),
    CatalogEntry("Google One 2TB", 999, ("google_play", "direct"),
                 email_domains=("google.com",), aliases=("google one",)),
    CatalogEntry("Microsoft 365 Personal", 999, ("direct",),
                 email_domains=("microsoft.com",), aliases=("microsoft 365", "office 365")),
    CatalogEntry("Microsoft 365 Family", 1299, ("direct",),
                 email_domains=("microsoft.com",), aliases=("microsoft 365", "office 365")),
    CatalogEntry("Dropbox Plus", 1199, ("apple_app_store", "direct"),
                 email_domains=("dropbox.com",), aliases=("dropbox",)),

    # ---- AI / SaaS ----
    CatalogEntry("ChatGPT Plus", 2000, ("apple_app_store", "direct"),
                 email_domains=("openai.com",), aliases=("chatgpt", "openai plus")),
    CatalogEntry("Claude Pro (Anthropic)", 2000, ("apple_app_store", "direct"),
                 email_domains=("anthropic.com",),
                 aliases=("claude", "claude.ai", "anthropic"),
                 notes="Anthropic's individual paid tier."),
    CatalogEntry("Claude Max (Anthropic)", 10000, ("direct",),
                 email_domains=("anthropic.com",),
                 aliases=("claude max",),
                 notes="Higher-usage Anthropic tier."),
    CatalogEntry("Gemini Advanced", 1999, ("google_play", "direct"),
                 email_domains=("google.com",), aliases=("gemini",)),

    # ---- News / read ----
    CatalogEntry("NYT (All Access)", 2500, ("apple_app_store", "direct"),
                 email_domains=("nytimes.com",), aliases=("new york times", "nyt")),
    CatalogEntry("WSJ", 3899, ("apple_app_store", "direct"),
                 email_domains=("wsj.com",), aliases=("wall street journal", "wsj")),

    # ---- Fitness ----
    CatalogEntry("Peloton App", 1299, ("apple_app_store", "direct"),
                 email_domains=("onepeloton.com",), aliases=("peloton",)),
    CatalogEntry("Calm", 1499, ("apple_app_store", "direct"),
                 email_domains=("calm.com",), aliases=("calm",)),
    CatalogEntry("Headspace", 1299, ("apple_app_store", "direct"),
                 email_domains=("headspace.com",), aliases=("headspace",)),

    # ---- Other ----
    CatalogEntry("Amazon Prime", 1499, ("direct",),
                 email_domains=("amazon.com",), aliases=("amazon prime", "prime")),
    CatalogEntry("Patreon (typical)", 500, ("patreon",),
                 email_domains=("patreon.com",), aliases=("patreon",),
                 notes="$5 is the most common pledge tier; vary widely."),
)


def all_entries() -> tuple[CatalogEntry, ...]:
    """All known service catalog entries. Read-only."""
    return _CATALOG


def entries_for_aggregator(aggregator_key: str) -> list[CatalogEntry]:
    """Catalog entries plausibly billed by a given aggregator.

    aggregator_key is the AggregatorSpec.key string from
    composite_detector (e.g. "apple_app_store", "google_play").
    """
    return [e for e in _CATALOG if aggregator_key in e.aggregators]


def entries_matching_price(
    cents: int,
    *,
    aggregator_key: str | None = None,
    tolerance_cents: int = 10,
) -> list[CatalogEntry]:
    """All catalog entries whose monthly_cents is within `tolerance_cents`
    of `cents`. Optionally restrict to entries plausibly billed by
    `aggregator_key`. Sorted by price-match closeness (best first).
    """
    abs_target = abs(cents)
    pool: Iterable[CatalogEntry] = (
        entries_for_aggregator(aggregator_key) if aggregator_key else _CATALOG
    )
    matches = [
        e for e in pool
        if abs(abs(e.monthly_cents) - abs_target) <= tolerance_cents
    ]
    matches.sort(key=lambda e: abs(abs(e.monthly_cents) - abs_target))
    return matches
