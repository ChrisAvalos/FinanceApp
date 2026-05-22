"""Gmail content scanner — find explicit signup signals.

Sprint 6 (Path 2). Complements the existing sender-domain check used by
the unmask suggester: instead of just "user has any email from
netflix.com" (which is weak — Netflix mails non-subscribers all the
time), this reads the email *subject and snippet* for explicit signup,
welcome, renewal, or billing-confirmation phrases mentioning the
service by name.

Strong content signals dramatically boost suggestion confidence — a
"Welcome to Apple TV+" email is near-proof the user has Apple TV+.

This module is pure data: no DB writes, no Gmail API calls. It takes a
SQLAlchemy Session, queries EmailMessage rows, and returns a structured
report of matched signals per catalog entry.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import EmailMessage
from finance_app.subscriptions.service_catalog import CatalogEntry, all_entries


# Pattern groups, strongest signal first. Each pattern is a compiled
# regex that gets ``.format(name=...)`` rendered from a catalog entry's
# name + aliases. Weight is the multiplicative confidence boost the
# match contributes (1.0 = neutral, >1 = boost).
@dataclass(frozen=True)
class _SignalPattern:
    pattern: str  # rendered with {name} placeholder before regex compile
    weight: float  # confidence multiplier — higher = stronger evidence
    label: str  # human-readable category for UI display


# Order doesn't matter for matching (we take the strongest match per
# email), but stronger weights toward the top makes it easier to reason
# about. {name} gets replaced by each alias before compilation.
#
# Patterns dropped the "your" prefix requirement after Sprint 6
# diagnostics — real-world emails say "YouTube Premium Price Update"
# and "Unclaimed: Your included Peacock Premium", not the cleanly
# possessive "Your YouTube Premium subscription". Apple receipts say
# "Your receipt from Apple." in the subject and list service names in
# the snippet ("Peacock Premium $10.99 · Apple Music $10.99 · …"), so
# we want any mention of {name} adjacent to billing-context words to
# count as evidence.
_PATTERNS: tuple[_SignalPattern, ...] = (
    # Strong: explicit welcome / signup language
    _SignalPattern(r"welcome to {name}", 0.40, "welcome"),
    _SignalPattern(r"thanks for subscribing to {name}", 0.40, "signup"),
    _SignalPattern(r"thank you for subscribing to {name}", 0.40, "signup"),
    _SignalPattern(r"you'?re in[\s,.].*{name}", 0.35, "signup"),
    _SignalPattern(r"{name}.*(subscription|account|membership) is (now )?active", 0.35, "active"),
    _SignalPattern(r"{name} subscription confirmed", 0.35, "confirmation"),
    # Medium: billing-context words after the service name (no "your"
    # required — catches "YouTube Premium Price Update", "Disney+
    # renewal reminder", "Apple Music receipt", etc.)
    _SignalPattern(r"{name}\s+(subscription|account|membership|premium|trial|plan)\b", 0.30, "subscription_mention"),
    _SignalPattern(r"{name}.*(renewal|will renew|renewing)", 0.30, "renewal"),
    _SignalPattern(r"{name}.*(payment|charged|billed|invoice|receipt)", 0.25, "payment"),
    _SignalPattern(r"{name}.*price (increase|update|change)", 0.25, "price_update"),
    _SignalPattern(r"{name} (price|charge|bill)", 0.20, "billing_mention"),
    # Soft: name alone in a billing-flavored email. We trust this only
    # when paired with sender-domain or price-match signal — the
    # confidence model handles that combining in the caller.
    _SignalPattern(r"\b{name}\b", 0.15, "name_mention"),
)


@dataclass(frozen=True)
class ContentSignal:
    """One supporting email for a catalog entry."""
    email_id: int
    received_at: datetime
    subject: str | None
    snippet: str | None
    from_domain: str
    weight: float  # contribution to confidence boost (0..1)
    label: str  # which pattern matched (e.g. "welcome", "renewal")


@dataclass(frozen=True)
class EntrySignals:
    """All content signals matched against one catalog entry."""
    entry: CatalogEntry
    signals: list[ContentSignal]

    @property
    def best_signal(self) -> ContentSignal | None:
        if not self.signals:
            return None
        return max(self.signals, key=lambda s: s.weight)

    @property
    def total_boost(self) -> float:
        """Sum of unique-pattern weights (capped). Multiple
        independent signal types stack but cap at +0.45 so a single
        catalog entry can't dominate the suggestion list.

        Same pattern matched twice contributes once — we dedupe by
        label here so e.g. 5 monthly renewal emails don't 5× the
        confidence boost. Distinct labels stack (welcome + renewal
        + payment all add up to high confidence).
        """
        seen_labels: dict[str, float] = {}
        for s in self.signals:
            if s.label not in seen_labels or s.weight > seen_labels[s.label]:
                seen_labels[s.label] = s.weight
        return min(0.45, sum(seen_labels.values()))


def _build_regex_for_entry(entry: CatalogEntry) -> re.Pattern[str]:
    """One compiled regex per catalog entry, matching any pattern x any
    alias of the service name. Case-insensitive.

    Aliases include the entry's display name (with parenthetical tier
    text stripped — "Apple Music (Individual)" → "Apple Music") plus
    any explicit aliases on the entry.
    """
    base = entry.name
    # Strip parenthetical tier info — match against the base service
    # name. Pricing-tier differentiation happens via the price match,
    # not the name regex.
    base_no_parens = re.sub(r"\s*\([^)]+\)\s*$", "", base).strip()
    name_variants = {base, base_no_parens, *entry.aliases}
    escaped = [re.escape(v.lower()) for v in name_variants if v]
    name_alt = "(?:" + "|".join(escaped) + ")"

    pattern_strs = []
    for i, p in enumerate(_PATTERNS):
        # Render the {name} placeholder. We compile a single combined
        # regex per entry so the row scan is one regex search not 12.
        rendered = p.pattern.replace("{name}", name_alt)
        # Wrap in named group so we can recover which pattern matched.
        # Suffix the label with the pattern's index so multiple patterns
        # that share a logical label (e.g. two "signup" variants) don't
        # collide on group names — Python regex requires unique named
        # groups in a single compiled pattern.
        pattern_strs.append(f"(?P<{p.label}_{i}>{rendered})")

    combined = "|".join(pattern_strs)
    return re.compile(combined, re.IGNORECASE)


# Cache compiled regexes — they don't change at runtime, and there are
# ~50 catalog entries each with a 12-pattern regex. Cheap upfront, fast
# on every scan.
_REGEX_CACHE: dict[str, re.Pattern[str]] = {}


def _regex_for(entry: CatalogEntry) -> re.Pattern[str]:
    if entry.name not in _REGEX_CACHE:
        _REGEX_CACHE[entry.name] = _build_regex_for_entry(entry)
    return _REGEX_CACHE[entry.name]


def _pattern_label_to_weight() -> dict[str, float]:
    return {p.label: p.weight for p in _PATTERNS}


def scan_for_content_signals(
    db: Session,
    *,
    lookback_days: int = 365,
    entries: tuple[CatalogEntry, ...] | None = None,
) -> list[EntrySignals]:
    """Walk recent EmailMessage rows and return content signals matching
    each catalog entry.

    Performance: one DB pull (~hundreds of rows), then a regex search
    per (email, entry). For 500 emails × 50 entries that's 25k regex
    runs, sub-second on any modern laptop.

    Only entries with at least one matched signal are returned, sorted
    by total boost descending.
    """
    if entries is None:
        entries = all_entries()
    label_to_weight = _pattern_label_to_weight()

    cutoff = datetime.utcnow() - timedelta(days=lookback_days)
    emails = list(
        db.execute(
            select(EmailMessage).where(EmailMessage.received_at >= cutoff)
        ).scalars().all()
    )

    by_entry: dict[str, list[ContentSignal]] = {}
    for e in entries:
        regex = _regex_for(e)
        signals: list[ContentSignal] = []
        for m in emails:
            # Build the haystack from subject + snippet. Lowercased so
            # the regex's IGNORECASE flag is fully redundant but cheap.
            haystack = " ".join(
                filter(None, [m.subject or "", m.snippet or ""])
            ).lower()
            if not haystack:
                continue
            match = regex.search(haystack)
            if not match:
                continue
            # Recover which pattern type matched — the named group that
            # has a non-None value. Group names are "<label>_<idx>" so
            # split on the trailing _N to get back the logical label.
            raw_group = next(
                (k for k, v in match.groupdict().items() if v is not None),
                "subscription_mention_0",
            )
            matched_label = raw_group.rsplit("_", 1)[0]
            weight = label_to_weight.get(matched_label, 0.15)
            signals.append(
                ContentSignal(
                    email_id=m.id,
                    received_at=m.received_at,
                    subject=m.subject,
                    snippet=m.snippet,
                    from_domain=m.from_domain,
                    weight=weight,
                    label=matched_label,
                )
            )
        if signals:
            by_entry[e.name] = signals

    out = [
        EntrySignals(entry=e, signals=by_entry[e.name])
        for e in entries
        if e.name in by_entry
    ]
    out.sort(key=lambda x: x.total_boost, reverse=True)
    return out


def signal_boost_for(
    entry: CatalogEntry,
    cached_signals: dict[str, EntrySignals],
) -> tuple[float, ContentSignal | None]:
    """Cheap lookup used by the unmask-suggestions endpoint.

    Returns (boost, best_signal). Boost ∈ [0, 0.45]. best_signal is the
    strongest individual ContentSignal supporting this entry, or None
    if there are no signals.
    """
    if entry.name not in cached_signals:
        return (0.0, None)
    bundle = cached_signals[entry.name]
    return (bundle.total_boost, bundle.best_signal)
