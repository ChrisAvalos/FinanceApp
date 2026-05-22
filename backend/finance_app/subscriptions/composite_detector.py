"""Composite-charge detector — Wave F-1.

Identifies *aggregator* subscriptions: merchants that bundle multiple
individual services into a single recurring bank charge. Apple App Store,
Google Play, PayPal recurring, Patreon, Amazon Subscribe&Save are the
canonical examples.

Why composites need special handling
------------------------------------
A single ``APPLE.COM/BILL $40.96`` charge can hide 5 different
subscriptions (Peacock, iCloud+, Apple Music, Calm, Audible…). The base
recurring-charge detector treats it as one mystery sub. Without
unmasking it into its line items, the bundle-overlap detector can't
flag "Peacock is in your Apple bundle AND your Xfinity Mobile already
includes it" — because Peacock is invisible to it.

This module is purely an *identifier*: given a Subscription row, decide
whether it's a known aggregator. Setting the row's ``is_composite``
column is the caller's job (the API endpoint does it). User-declared
line items + Gmail receipt parsers add child rows separately.

Detection model
---------------
Pure regex-based for now. Each aggregator has:
  * one or more ``name_patterns`` (case-insensitive substring) that
    match against ``Subscription.name``;
  * a friendly ``label`` for the UI; and
  * a list of ``hint_questions`` the Q&A intake UI can pose to the user
    when they unmask the row ("What Apple subscriptions are you paying
    for?").
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AggregatorSpec:
    """One aggregator's detection rule + UX copy.

    ``kind`` distinguishes two flavors of variable-amount merchants:
    - ``"bundle"``: aggregates multiple distinct subscriptions (Apple
      App Store, Google Play, etc.) — the user can unmask into
      individual children, and bundle-overlap detection runs against
      those children.
    - ``"usage"``: meters a single service whose amount varies with
      consumption (Anthropic Claude API, OpenAI API, AWS, GCP, etc.).
      No children to declare — the parent IS the subscription, just
      with a variable amount. The unmask prompt is suppressed for
      these; the user only needs to see them in the list.
    """

    key: str                                   # stable id, e.g. "apple_app_store"
    label: str                                 # display name, e.g. "Apple App Store"
    name_patterns: tuple[str, ...]             # case-insensitive substring match
    hint_questions: tuple[str, ...]            # prompts surfaced in the unmask modal
    receipt_sender: str | None = None          # Gmail from-domain that emails monthly receipts
    kind: str = "bundle"                       # "bundle" | "usage" — see class docstring


# Order matters for the matcher — first match wins. Keep the tightly-
# scoped patterns ahead of generic ones so "amzn marketplace" doesn't
# get swallowed by a too-broad "amazon" match.
_AGGREGATORS: tuple[AggregatorSpec, ...] = (
    AggregatorSpec(
        key="apple_app_store",
        label="Apple App Store",
        name_patterns=(
            "apple.com/bill",
            "apl*itunes",
            "apple subscription",
            "itunes.com/bill",
        ),
        hint_questions=(
            "What Apple subscriptions are bundled into this charge?",
            "Common ones: iCloud+, Apple Music, Apple TV+, Apple Arcade, plus any third-party app subs (Peacock, Calm, Audible…) you signed up for via the iPhone.",
        ),
        receipt_sender="apple.com",
    ),
    AggregatorSpec(
        key="google_play",
        label="Google Play",
        name_patterns=(
            "google *",          # GOOGLE *PEACOCK, GOOGLE *YOUTUBE etc.
            "google play",
            "googleplay",
        ),
        hint_questions=(
            "What Google Play subscriptions are inside this charge?",
            "YouTube Premium, Google One, third-party app subs purchased via Android.",
        ),
        receipt_sender="google.com",
    ),
    AggregatorSpec(
        key="paypal",
        label="PayPal recurring",
        name_patterns=("paypal *", "paypal subscription", "paypal inst xfer"),
        hint_questions=(
            "What is this PayPal recurring charge for?",
            "PayPal aggregates subscriptions for merchants that don't accept cards directly — Patreon, Discord Nitro, some indie services.",
        ),
        receipt_sender="paypal.com",
    ),
    AggregatorSpec(
        key="patreon",
        label="Patreon",
        name_patterns=("patreon",),
        hint_questions=(
            "Which creators are you supporting through this Patreon charge?",
            "Patreon bundles all of your monthly pledges into a single charge.",
        ),
        receipt_sender="patreon.com",
    ),
    AggregatorSpec(
        key="amazon_subscribe_save",
        label="Amazon Subscribe & Save",
        name_patterns=("amzn mktp us*subscr", "amazon subscribe", "amzn s&s"),
        hint_questions=(
            "What Subscribe & Save items are in this Amazon order?",
            "Pantry / household items on a recurring delivery — toothpaste, dish soap, vitamins, etc.",
        ),
        receipt_sender="amazon.com",
    ),

    # -------- Usage-metered services (variable-amount, single service) ----
    #
    # These bill a single service whose monthly amount swings with
    # consumption (API tokens, compute hours, etc.). Without these
    # patterns the recurring-charge detector rejects them on amount
    # tolerance — Anthropic charges $5, $25, $96, $190 in different
    # months and nothing groups them. With ``kind="usage"`` the
    # detector's aggregator-bypass pass picks them up and creates a
    # variable-amount parent showing the monthly footprint, and the
    # UI suppresses the "what's bundled inside?" prompt since there's
    # nothing to declare beyond the meter itself.
    AggregatorSpec(
        key="anthropic_api",
        label="Anthropic (Claude API)",
        name_patterns=("anthropic", "claude.ai", "claude ai"),
        hint_questions=(
            "Anthropic bills monthly based on API token usage.",
            "If you see this growing, consider whether the use-case "
            "justifies the spend or if a flat-rate plan would be cheaper.",
        ),
        receipt_sender="anthropic.com",
        kind="usage",
    ),
    AggregatorSpec(
        key="openai_api",
        label="OpenAI (ChatGPT / API)",
        name_patterns=("openai", "chatgpt"),
        hint_questions=(
            "OpenAI bills monthly based on API token usage.",
            "If you see this growing month-over-month, evaluate ROI on "
            "the use-case.",
        ),
        receipt_sender="openai.com",
        kind="usage",
    ),
    AggregatorSpec(
        key="aws",
        label="Amazon Web Services",
        name_patterns=("amazon web services", "aws.amazon", "amzn aws"),
        hint_questions=(
            "AWS bills monthly based on resource usage (EC2 hours, S3 "
            "storage, transfer, etc.).",
            "Track this against your project budgets; idle resources can "
            "drift the monthly footprint.",
        ),
        receipt_sender="amazon.com",
        kind="usage",
    ),
    AggregatorSpec(
        key="gcp",
        label="Google Cloud Platform",
        name_patterns=("google cloud", "google*svcs", "googlecloud"),
        hint_questions=(
            "GCP bills monthly based on resource usage.",
        ),
        receipt_sender="google.com",
        kind="usage",
    ),
    AggregatorSpec(
        key="azure",
        label="Microsoft Azure",
        name_patterns=("microsoft azure", "msft*azure", "azure cloud"),
        hint_questions=(
            "Azure bills monthly based on resource usage.",
        ),
        receipt_sender="microsoft.com",
        kind="usage",
    ),
    AggregatorSpec(
        key="vercel",
        label="Vercel",
        name_patterns=("vercel",),
        hint_questions=(
            "Vercel bills monthly for hosting + bandwidth.",
        ),
        receipt_sender="vercel.com",
        kind="usage",
    ),
    AggregatorSpec(
        key="cursor_ai",
        label="Cursor AI",
        name_patterns=("cursor ai", "cursor.so", "cursor.com"),
        hint_questions=(
            "Cursor's Pro / Business plans bill monthly; usage-based "
            "tiers swing with token consumption.",
        ),
        receipt_sender="cursor.com",
        kind="usage",
    ),
    AggregatorSpec(
        key="replicate",
        label="Replicate",
        name_patterns=("replicate.com", "replicate ai"),
        hint_questions=(
            "Replicate bills per inference — usage scales with model runs.",
        ),
        receipt_sender="replicate.com",
        kind="usage",
    ),
)


def _normalize(name: str) -> str:
    return (name or "").lower()


def detect_aggregator(name: str) -> AggregatorSpec | None:
    """Return the matching :class:`AggregatorSpec` for ``name`` or None.

    Pure function — no DB / IO. Match is case-insensitive substring.
    """
    if not name:
        return None
    n = _normalize(name)
    for agg in _AGGREGATORS:
        for pattern in agg.name_patterns:
            if pattern in n:
                return agg
    return None


def list_aggregators() -> list[AggregatorSpec]:
    """Return all known aggregators (UI uses this for the unmask modal hints)."""
    return list(_AGGREGATORS)


def is_known_composite_name(name: str) -> bool:
    """Convenience: True iff ``name`` matches any known aggregator."""
    return detect_aggregator(name) is not None
