"""LLM-Gmail subscription discovery — Sprint 16 / Layer 2b.

Walks the user's Gmail history and, for each email from a known
subscription-service domain, asks Ollama:

    "Does this email indicate the user has an active subscription /
    just started a free trial / just signed up for a recurring service?
    If yes, what service, what price, what cadence?"

Cross-references the LLM's answers against the existing Subscription
rows. For any service the LLM found in Gmail that we DON'T already
track, emits a ``DiscoveredSubscription`` record. The active-prompt
system surfaces these as "Did you start using X? Want me to track
it?" questions in the F-6 banner — one click adds the row.

Why LLM
-------
Regex-based "Welcome to X" matching (Sprint 6's content scanner)
caught the obvious cases. The LLM catches:
  * renewal-reminder emails where the service isn't named in the
    subject ("Your monthly subscription will renew on June 5")
  * trial-ending emails ("Your 7-day trial expires Friday")
  * promo emails that mention an active account ("Hi Chris, your
    Disney+ account has new content this week")
  * receipt emails from non-standard senders that mention service
    + price + cadence in the snippet

Idempotency
-----------
We mark EmailMessage.extra["discovered_at"] after each scan. Re-runs
skip already-scanned rows, so a daily cron is cheap.

The LLM is opt-in via ``settings.llm_fallback_enabled`` — same flag
that controls T3 categorization. When Ollama isn't reachable this
module returns an empty list (no errors surfaced; the regex content
scanner is still doing its job from Sprint 6).
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.config import settings
from finance_app.db.models import (
    EmailMessage,
    ParserOutcome,
    Subscription,
    SubscriptionStatus,
)
from finance_app.llm import OllamaUnavailable, get_client
from finance_app.subscriptions.service_catalog import all_entries

logger = logging.getLogger(__name__)


# How far back to scan when computing discoveries. Pre-existing prompts
# already cover the obvious "this just renewed" emails; a 180-day
# window catches both renewals and the long-tail of welcome emails
# from earlier in the user's history.
_DEFAULT_LOOKBACK_DAYS = 180
# Hard cap on emails we ask the LLM about per run. Each call is
# 1-3 seconds on a warm Ollama, so 50 = a few minutes wall-clock
# worst case. Sufficient for a typical user's Gmail history.
_MAX_LLM_CALLS = 50


@dataclass(frozen=True)
class DiscoveredSubscription:
    """One subscription the LLM found in Gmail that we don't track yet."""
    service_name: str           # e.g. "Netflix Standard"
    monthly_cents: int | None   # estimated; None if the email didn't say
    cadence_label: str          # "monthly" | "annual" | "weekly" | "unknown"
    source_email_id: int        # the EmailMessage.id that triggered detection
    source_subject: str | None
    source_received_at: datetime
    confidence: float           # 0..1 — how sure the LLM was
    rationale: str              # short prose from the LLM
    matched_catalog_name: str | None = None  # if it lined up with service_catalog


_DISCOVERY_PROMPT = """\
You are reading a personal-finance email and extracting subscription information.

The user is trying to find subscriptions they have but aren't tracking yet.

Read the email subject and snippet, and decide:
1. Does this email indicate the user CURRENTLY has an active subscription, free trial, or recurring billing relationship with a specific service?
2. If yes, what's the service name (clean: "Netflix" not "Netflix 7-Day Trial")?
3. What's the monthly cost in US dollars? (Estimate from snippet; null if unclear.)
4. What's the cadence: "monthly", "annual", "weekly", "quarterly", or "unknown"?

DO consider these signals as "yes, active subscription":
  - "Welcome to ..." emails
  - "Your <service> trial is ending" emails
  - "Your <service> subscription will renew" emails
  - Receipt / invoice emails that mention service + price
  - "Thanks for signing up for ..."

DO NOT consider these as active subscriptions:
  - Marketing / promo emails for services the user has NOT explicitly signed up for
  - One-time purchase confirmations (Amazon order, Walmart pickup, etc.)
  - Account-update emails ("Password changed", "Login from new device")
  - Newsletters / digests from sites the user only reads (unless they're paid)

Reply with ONLY a JSON object:
{{"is_subscription": true|false, "service": "<name or null>", "monthly_usd": <number or null>, "cadence": "<monthly|annual|weekly|quarterly|unknown>", "confidence": 0.0-1.0, "why": "<one-sentence rationale>"}}

Email metadata:
  From: {from_address}
  Subject: {subject}
  Snippet: {snippet}

Reply (JSON only):
"""


def _email_domains_from_catalog() -> set[str]:
    """Set of sender domains worth scanning — pulled from
    ``service_catalog.email_domains``. Skipping unknown domains keeps
    LLM costs bounded; the catalog covers the common subscription
    services and is the same dataset the suggester uses."""
    out: set[str] = set()
    for entry in all_entries():
        for d in entry.email_domains:
            out.add(d.lower())
    # Common bank / financial domains aren't worth scanning here —
    # they're transactional, not subscription-signup. We explicitly
    # exclude them to avoid wasting LLM calls on irrelevant signals.
    return out - {
        "chase.com", "americanexpress.com", "bankofamerica.com",
        "wellsfargo.com", "capitalone.com", "discover.com",
    }


def _canonicalize_service_name(name: str) -> str:
    """Resolve a free-form service string to its catalog canonical name.

    The catalog ships aliases — "Peacock TV", "Peacock Premium", and
    "Peacock Premium Plus" all canonicalize to "Peacock". Without this
    step, the dedupe set sees "peacock premium" and "peacock tv" as
    different strings and creates duplicate Subscription rows when the
    LLM uses a different phrasing than what's already in the DB.
    Falls back to the input (lowercased) when no catalog match exists.
    """
    raw = (name or "").lower().strip()
    if not raw:
        return ""
    for entry in all_entries():
        if entry.name.lower() == raw:
            return entry.name.lower()
        for alias in entry.aliases:
            if alias.lower() == raw:
                return entry.name.lower()
        # Substring fallback — "peacock premium plus" still resolves to
        # "peacock" when the catalog has the bare name. Guard with a
        # minimum overlap so single-word coincidences don't merge
        # unrelated services.
        ename = entry.name.lower()
        if len(ename) >= 4 and (ename in raw or raw in ename):
            return ename
    return raw


def _existing_subscription_names(db: Session) -> set[str]:
    """Lowercased+stripped names of every non-dismissed subscription
    the user already has, plus their canonical catalog names. We use
    this to skip discoveries the engine already knows about — no point
    asking 'add Netflix?' when there's already a Netflix row, and no
    point asking 'add Peacock TV?' when there's a 'Peacock Premium'
    row that resolves to the same catalog entry."""
    rows = db.execute(
        select(Subscription.name, Subscription.notes).where(
            Subscription.status != SubscriptionStatus.dismissed
        )
    ).all()
    seen: set[str] = set()
    for name, notes in rows:
        lname = (name or "").lower().strip()
        seen.add(lname)
        # Also add the catalog-canonical name so a future "Peacock TV"
        # discovery matches an existing "Peacock Premium" row.
        canon = _canonicalize_service_name(name or "")
        if canon:
            seen.add(canon)
        # Notes often contain service names too (e.g., the unmask flow
        # writes "Paramount+ Premium (annual). Renews May 24 ...").
        if notes:
            for tok in re.split(r"[\s,/—\-]+", notes.lower()):
                if len(tok) > 4:
                    seen.add(tok.strip())
    return seen


def _parse_llm_response(raw: str) -> dict | None:
    """Extract the JSON object the LLM produced. Returns the dict on
    success, None on parse failure."""
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Sometimes the model wraps with prose despite our "JSON only"
        # instruction. Grab the first JSON-shaped object.
        m = re.search(r"\{[^{}]*\}", raw)
        if not m:
            return None
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return None


def discover_subscriptions_from_gmail(
    db: Session, *, lookback_days: int = _DEFAULT_LOOKBACK_DAYS,
    max_calls: int = _MAX_LLM_CALLS,
) -> list[DiscoveredSubscription]:
    """Walk recent Gmail messages, ask LLM about each, return
    discoveries the user doesn't already track.

    Idempotent — emails with ``extra["discovered_at"]`` set are skipped.
    Caller should commit() the marker writes after consuming the list.
    """
    if not getattr(settings, "llm_fallback_enabled", False):
        logger.info("LLM-Gmail discovery skipped — LLM fallback disabled")
        return []

    relevant_domains = _email_domains_from_catalog()
    if not relevant_domains:
        return []

    cutoff = datetime.utcnow() - timedelta(days=lookback_days)
    rows = list(
        db.execute(
            select(EmailMessage)
            .where(EmailMessage.received_at >= cutoff)
            .where(EmailMessage.parser_outcome.in_(
                [ParserOutcome.parsed, ParserOutcome.ignored]
            ))
            .order_by(EmailMessage.received_at.desc())
        ).scalars().all()
    )

    # Filter to emails from catalog domains, skipping already-discovered.
    candidates: list[EmailMessage] = []
    for r in rows:
        if not r.from_domain:
            continue
        dom = r.from_domain.lower()
        if not any(d in dom for d in relevant_domains):
            continue
        extra = r.extra or {}
        if extra.get("discovered_at"):
            continue
        candidates.append(r)

    if not candidates:
        return []

    known_names = _existing_subscription_names(db)
    client = get_client()
    discoveries: list[DiscoveredSubscription] = []
    calls = 0
    for em in candidates:
        if calls >= max_calls:
            break
        calls += 1
        prompt = _DISCOVERY_PROMPT.format(
            from_address=(em.from_address or "")[:200],
            subject=(em.subject or "")[:300],
            snippet=(em.snippet or "")[:500],
        )
        try:
            raw = client.generate(prompt, json_mode=True, temperature=0.0,
                                  max_tokens=200)
        except OllamaUnavailable as exc:
            logger.info("LLM-Gmail discovery aborted — Ollama unavailable: %s", exc)
            break
        parsed = _parse_llm_response(raw)
        # Mark scanned regardless of whether we found anything — the
        # answer for this email won't change on re-runs unless the
        # message itself changes.
        new_extra = dict(em.extra or {})
        new_extra["discovered_at"] = datetime.utcnow().isoformat()
        new_extra["discovery_raw"] = (raw or "")[:500]
        em.extra = new_extra

        if not parsed or not parsed.get("is_subscription"):
            continue
        service = (parsed.get("service") or "").strip()
        if not service:
            continue
        # Skip discoveries the user already has tracked. Canonicalize
        # the LLM's free-form service string before comparing so
        # "Peacock TV" and "Peacock Premium" (different aliases of the
        # same catalog entry) don't both end up as standalone rows.
        service_lower = service.lower().strip()
        service_canon = _canonicalize_service_name(service)
        if service_lower in known_names or service_canon in known_names:
            continue
        if any(service_lower in known for known in known_names):
            continue
        if service_canon and any(
            service_canon in known or known in service_canon
            for known in known_names
            if len(known) >= 4
        ):
            continue

        cadence = (parsed.get("cadence") or "unknown").lower().strip()
        monthly_usd = parsed.get("monthly_usd")
        if isinstance(monthly_usd, (int, float)) and monthly_usd > 0:
            # Convert to monthly equivalent based on cadence.
            if cadence == "annual":
                monthly_cents = int(round((float(monthly_usd) / 12) * 100))
            elif cadence == "quarterly":
                monthly_cents = int(round((float(monthly_usd) / 3) * 100))
            elif cadence == "weekly":
                monthly_cents = int(round(float(monthly_usd) * 52 / 12 * 100))
            else:
                monthly_cents = int(round(float(monthly_usd) * 100))
        else:
            monthly_cents = None

        # Try to match to a catalog entry (cosmetic — gives the prompt
        # UI a clean canonical name).
        matched: str | None = None
        for entry in all_entries():
            if entry.name.lower() == service.lower():
                matched = entry.name
                break
            for alias in entry.aliases:
                if alias.lower() == service.lower():
                    matched = entry.name
                    break
            if matched:
                break

        confidence = parsed.get("confidence", 0.7)
        if not isinstance(confidence, (int, float)):
            confidence = 0.7

        discoveries.append(
            DiscoveredSubscription(
                service_name=matched or service,
                monthly_cents=monthly_cents,
                cadence_label=cadence,
                source_email_id=em.id,
                source_subject=em.subject,
                source_received_at=em.received_at,
                confidence=float(confidence),
                rationale=(parsed.get("why") or "")[:200],
                matched_catalog_name=matched,
            )
        )
        # Add to known set so subsequent emails about the SAME service
        # in this batch don't double-discover. Include the canonical
        # name too so aliasing across emails doesn't sneak through.
        known_names.add(service_lower)
        if service_canon:
            known_names.add(service_canon)

    db.commit()
    discoveries.sort(key=lambda d: d.confidence, reverse=True)
    return discoveries
