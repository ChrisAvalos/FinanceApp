"""T3 fallback: classify uncategorized merchants via local Ollama.

Position in the pipeline
------------------------
The categorization engine tries, in order:

  1. Manual user override (CategorySource.manual) — wins absolutely.
  2. Active rules — first-match-by-priority.
  3. Merchant-alias fuzzy match.
  4. **This T3 LLM fallback** — only if 1-3 all came up empty.
  5. Default to "uncategorized" if even the LLM is unavailable / unsure.

Why a separate file (vs. inline in engine.py)
---------------------------------------------
Keeps the engine free of httpx + Ollama prompt-engineering details.
The engine just calls :func:`classify_unknown_merchant` and gets back
a category_id (or None for "I don't know either"). This file owns the
prompt template, the slug→id resolution, and the graceful degradation
on Ollama unavailability.

Caching
-------
We DON'T cache the LLM response in-process because the engine writes
the result back as a high-priority user-rule before re-running. So
the next time the same merchant shows up, the rule layer catches it
and we never reach this fallback. The LLM is paid for once per novel
merchant.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import Category, Rule
from ..llm import OllamaUnavailable, get_client

logger = logging.getLogger(__name__)


# Slugs we surface to the LLM. These are the leaf-level categories from
# CATEGORY_SEED, minus the catch-alls ("uncategorized", "other") which
# are NEVER what we want from the LLM (the whole point is to LEAVE the
# uncategorized bucket).
_LEAF_SLUGS_QUERY_FILTER = """
    slug NOT IN ('uncategorized', 'other')
    AND parent_id IS NOT NULL
"""


_PROMPT_TEMPLATE = """\
You are a categorization assistant for a personal finance app. Your job is to read a bank-statement merchant description and pick the single best matching category from the list.

You MUST pick one of the slugs. Educated guesses based on partial signals are expected and valued — for example:
- "TST* DISTRICT SJ" → food.restaurants (TST is the Toast restaurant POS terminal prefix)
- "AVOKATO ATO SJO ALAJUELA" → food.restaurants (SJO is San José Costa Rica's IATA code; this is a local merchant abroad)
- "ALBERT CASH" → financial.transfer (Albert is a fintech savings/cash-management app; "cash" implies a transfer in/out)
- "ZELLE PAYMENT FROM..." → financial.transfer
- "AMZN MKTP" / "AMAZON.COM" → shopping.online
- "POS DEBIT 7-ELEVEN" → shopping.household (convenience store)
- "FEDWIRE CREDIT" → financial.transfer
- "STARBUCKS" → food.coffee
- "FOODMAXX" → food.groceries
- "CHEVRON" / "ARCO" / "SHELL" → transport.gas

Available category slugs (pick exactly one — case-sensitive):
{slug_list}

Reply with ONLY a JSON object of the shape:
  {{"slug": "<category-slug>"}}
No prose, no explanations. Even if uncertain, commit to your best guess — "other" is acceptable as a last resort but should be rare.

Merchant description:
"{merchant}"

Reply (JSON only):
"""


_SLUG_RE = re.compile(r'"slug"\s*:\s*"?([a-z0-9_.]+)"?', re.IGNORECASE)


def _list_leaf_categories(db: Session) -> list[Category]:
    """All non-catch-all leaf categories PLUS the top-level "other"
    bucket. Used to constrain the LLM's choices.

    Note: "other" is included even though it's a top-level (not a
    leaf) because we want the LLM to have a legitimate escape hatch
    for merchants that genuinely don't fit any leaf — better to land
    in "Other" than to silently null-answer and bounce back to
    "Uncategorized". Llama 3.1 was bailing to null too eagerly when
    we excluded "other" from the menu.
    """
    rows = db.execute(
        select(Category).where(
            Category.slug.notin_(["uncategorized"]),
        )
    ).scalars().all()
    # Keep only leaf categories + the explicit "other" top-level.
    return [c for c in rows if c.parent_id is not None or c.slug == "other"]


def classify_unknown_merchant(
    db: Session,
    *,
    merchant_text: str,
    available_categories: Iterable[Category] | None = None,
) -> int | None:
    """Return a category_id for ``merchant_text`` via Ollama, or None.

    None means: Ollama unavailable, response unparseable, or model
    answered "I don't know." Caller should leave the transaction
    Uncategorized so the user can triage manually.

    Side effect: when the LLM returns a confident answer, persist a
    new high-priority Rule pinning this merchant to that category. Next
    time the same merchant shows up the rule layer catches it (~1 ms),
    no LLM round-trip needed.
    """
    cats = list(available_categories) if available_categories is not None else _list_leaf_categories(db)
    if not cats:
        return None
    by_slug = {c.slug: c for c in cats}
    slug_list = "\n".join(f"  - {c.slug}" for c in cats)
    prompt = _PROMPT_TEMPLATE.format(slug_list=slug_list, merchant=merchant_text)

    client = get_client()
    try:
        raw = client.generate(prompt, json_mode=True, temperature=0.0, max_tokens=80)
    except OllamaUnavailable as e:
        logger.info("LLM fallback skipped — Ollama unavailable: %s", e)
        return None

    slug = _parse_slug(raw)
    if slug is None or slug not in by_slug:
        logger.info(
            "LLM fallback returned unusable answer for %r: %r", merchant_text, raw
        )
        return None

    cat = by_slug[slug]
    # Pin a rule so we never re-ask the LLM for this merchant.
    _pin_rule(db, merchant_text=merchant_text, category=cat)
    return cat.id


def _parse_slug(raw: str) -> str | None:
    """Extract the slug from the LLM's response.

    json_mode usually returns clean ``{"slug": "..."}`` but llama3.1
    occasionally adds prose. Regex is a forgiving second line of defense.
    """
    if not raw:
        return None
    # Try clean JSON first.
    import json
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            v = parsed.get("slug")
            if v is None:
                return None
            return str(v).strip().lower()
    except json.JSONDecodeError:
        pass
    # Fall back to regex.
    m = _SLUG_RE.search(raw)
    if not m:
        return None
    val = m.group(1).strip().lower()
    if val in ("null", "none", ""):
        return None
    return val


def _pin_rule(db: Session, *, merchant_text: str, category: Category) -> None:
    """Persist a Rule that maps this merchant to ``category`` going forward.

    Pattern is the merchant string upper-cased and trimmed. is_seed=False
    + a high priority (199) so user-edits and seed rules of the same
    priority still win. Idempotent — duplicate insert is swallowed.
    """
    pattern = (merchant_text or "").upper().strip()
    if not pattern:
        return
    # Skip if a rule with this exact pattern + category already exists.
    existing = db.execute(
        select(Rule).where(
            Rule.pattern == pattern, Rule.category_id == category.id
        ).limit(1)
    ).scalar_one_or_none()
    if existing is not None:
        return
    rule = Rule(
        name=f"LLM-pinned · {pattern[:60]}",
        pattern=pattern,
        is_regex=False,
        category_id=category.id,
        priority=199,  # higher than seed rules (most are 200, but we want
                      # below explicit user edits if those exist at 250+)
        is_active=True,
        is_seed=False,
        notes=f"Pinned by LLM fallback at {datetime.utcnow().isoformat()}Z.",
    )
    try:
        db.add(rule)
        db.commit()
    except Exception:  # noqa: BLE001 — best effort
        db.rollback()
        logger.exception("Failed to pin LLM-derived rule for %r", pattern)
