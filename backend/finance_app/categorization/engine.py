"""Rule-based categorization engine.

Strategy, in order:
    1. If the transaction already has a manual category (``CategorySource.manual``),
       leave it alone. Users outrank rules.
    2. Check active Rules, highest-priority first. First match wins.
    3. Fall back to MerchantAlias fuzzy lookup (rapidfuzz) — if we find a known
       merchant with a default category, use that.
    4. Otherwise mark as default (Uncategorized).

This runs fast — SQLite + regex + fuzzy match with a tight candidate set. No
LLM calls. A future ``llm_fallback`` hook can route the residual ~5% to Ollama.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime

from rapidfuzz import fuzz, process
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from finance_app.db.models import (
    Category,
    CategorySource,
    Merchant,
    MerchantAlias,
    Rule,
    Transaction,
)

UNCATEGORIZED_SLUG = "uncategorized"


@dataclass
class CategorizationResult:
    category_id: int | None
    merchant_id: int | None
    source: CategorySource
    rule_id: int | None = None


class CategorizationEngine:
    def __init__(
        self,
        db: Session,
        fuzzy_threshold: int = 88,
        llm_fallback_enabled: bool = False,
    ):
        self.db = db
        self.fuzzy_threshold = fuzzy_threshold
        # T3 LLM fallback (Phase 5.4). Off by default so existing call
        # sites get the fast deterministic behavior they expect. Flip
        # to True (or pass via constructor) to route Uncategorized
        # transactions through Ollama. When Ollama isn't reachable the
        # fallback returns None and we fall through to the default
        # bucket — same as before. The categorize_all() loop and the
        # /api/rules/run endpoint can opt in via a query flag.
        self.llm_fallback_enabled = llm_fallback_enabled
        self._rules: list[Rule] | None = None
        self._aliases: list[MerchantAlias] | None = None
        self._uncategorized_id: int | None = None

    # --- lazy caches; rebuild per batch ---

    def refresh(self) -> None:
        self._rules = (
            self.db.execute(
                select(Rule).where(Rule.is_active.is_(True)).order_by(Rule.priority.desc())
            )
            .scalars()
            .all()
        )
        self._aliases = self.db.execute(select(MerchantAlias)).scalars().all()
        cat = self.db.execute(
            select(Category).where(Category.slug == UNCATEGORIZED_SLUG)
        ).scalar_one_or_none()
        self._uncategorized_id = cat.id if cat else None

    @property
    def rules(self) -> list[Rule]:
        if self._rules is None:
            self.refresh()
        return self._rules or []

    @property
    def aliases(self) -> list[MerchantAlias]:
        if self._aliases is None:
            self.refresh()
        return self._aliases or []

    # --- matching ---

    def _rule_matches(self, rule: Rule, txn: Transaction) -> bool:
        # Amount gate
        amt = abs(txn.amount_cents)
        if rule.min_amount_cents is not None and amt < rule.min_amount_cents:
            return False
        if rule.max_amount_cents is not None and amt > rule.max_amount_cents:
            return False
        desc = f"{txn.description_raw or ''} {txn.description_clean or ''}".upper()
        pattern = rule.pattern
        if rule.is_regex:
            try:
                return bool(re.search(pattern, desc, re.IGNORECASE))
            except re.error:
                return False
        # Simple substring match (case-insensitive)
        return pattern.upper() in desc

    def _first_rule_match(self, txn: Transaction) -> Rule | None:
        for r in self.rules:
            if self._rule_matches(r, txn):
                return r
        return None

    def _fuzzy_merchant(self, txn: Transaction) -> Merchant | None:
        if not self.aliases:
            return None
        desc = (txn.description_raw or "").upper()
        patterns = [a.pattern.upper() for a in self.aliases]
        match = process.extractOne(desc, patterns, scorer=fuzz.partial_ratio)
        if match and match[1] >= self.fuzzy_threshold:
            _, _, idx = match
            alias = self.aliases[idx]
            return self.db.get(Merchant, alias.merchant_id)
        return None

    def categorize(self, txn: Transaction) -> CategorizationResult:
        # 1. Respect manual overrides
        if txn.category_source == CategorySource.manual:
            return CategorizationResult(
                category_id=txn.category_id,
                merchant_id=txn.merchant_id,
                source=CategorySource.manual,
                rule_id=txn.category_rule_id,
            )

        # 2. Rule match
        rule = self._first_rule_match(txn)
        if rule is not None:
            return CategorizationResult(
                category_id=rule.category_id,
                merchant_id=rule.merchant_id,
                source=CategorySource.rule,
                rule_id=rule.id,
            )

        # 3. Merchant alias fuzzy match
        merchant = self._fuzzy_merchant(txn)
        if merchant is not None:
            return CategorizationResult(
                category_id=merchant.default_category_id,
                merchant_id=merchant.id,
                source=CategorySource.rule,  # attributable to the merchant mapping
                rule_id=None,
            )

        # 3.5 Plaid Personal Finance Category mapper (Sprint 12).
        # Plaid already labels every transaction with a detailed category
        # like "TRANSPORTATION_GAS_STATIONS" or "FOOD_AND_DRINK_RESTAURANT".
        # We store it in extra and translate it to our taxonomy here.
        # Higher leverage than the LLM fallback because the data is
        # already on disk — no inference latency, no Ollama dependency.
        # Slotted between merchant-alias and LLM so manual rules and
        # explicit alias mappings still win, but the PFC fills the gap
        # before we fall through to the language-model guess.
        try:
            from .plaid_pfc_mapper import infer_category_id_from_pfc
            pfc_cat_id = infer_category_id_from_pfc(txn, self.db)
            if pfc_cat_id is not None:
                return CategorizationResult(
                    category_id=pfc_cat_id,
                    merchant_id=None,
                    source=CategorySource.rule,
                    rule_id=None,
                )
        except Exception:  # noqa: BLE001 — never let PFC mapper tank the engine
            pass

        # 4. T3 LLM fallback (Phase 5.4). Disabled by default — flip
        # ``self.llm_fallback_enabled`` on the engine instance to turn
        # it on. The fallback gracefully degrades to None when Ollama
        # isn't reachable, so a flipped flag with no Ollama instance
        # is harmless. When the LLM nails a category it ALSO pins a
        # high-priority Rule for next time so we don't re-pay per txn.
        if getattr(self, "llm_fallback_enabled", False):
            try:
                from .llm_fallback import classify_unknown_merchant
                desc = txn.description_clean or txn.description_raw or ""
                cat_id = classify_unknown_merchant(self.db, merchant_text=desc)
                if cat_id is not None:
                    return CategorizationResult(
                        category_id=cat_id,
                        merchant_id=None,
                        source=CategorySource.rule,
                        rule_id=None,
                    )
            except Exception:  # noqa: BLE001 — never let LLM tank categorization
                pass

        # 5. Default bucket
        return CategorizationResult(
            category_id=self._uncategorized_id,
            merchant_id=None,
            source=CategorySource.default,
        )

    # --- batch ---

    def categorize_all(self, only_unset: bool = True) -> dict[str, int]:
        """Run categorization over every eligible transaction.

        Returns counts: {rule, default, manual_skipped, unchanged}.
        Side effect: increments ``Rule.hit_count`` for every rule that
        actually wins a transaction in this batch, and stamps
        ``Rule.last_hit_at``. Hits are accumulated in a Counter and
        flushed in one UPDATE per rule at the end of the loop so we
        don't generate N round-trips when N is in the thousands.
        """
        self.refresh()
        stmt = select(Transaction)
        if only_unset:
            stmt = stmt.where(
                Transaction.category_source.in_([CategorySource.unset, CategorySource.default])
            )
        counts = {"rule": 0, "default": 0, "manual_skipped": 0, "unchanged": 0}
        rule_hits: Counter[int] = Counter()

        for txn in self.db.execute(stmt).scalars():
            if txn.category_source == CategorySource.manual:
                counts["manual_skipped"] += 1
                continue
            result = self.categorize(txn)
            changed = (
                txn.category_id != result.category_id
                or txn.merchant_id != result.merchant_id
                or txn.category_source != result.source
            )
            if changed:
                txn.category_id = result.category_id
                txn.merchant_id = result.merchant_id
                txn.category_source = result.source
                txn.category_rule_id = result.rule_id
                counts[result.source.value if result.source.value in counts else "default"] += 1
            else:
                counts["unchanged"] += 1
            # Tally the rule that produced THIS categorization (if any),
            # whether or not the row changed — a rule that re-matches the
            # same transaction is still doing work. Only count
            # rule-source hits with a real rule_id (skip merchant-fuzzy
            # paths and default fallbacks).
            if result.source == CategorySource.rule and result.rule_id is not None:
                rule_hits[result.rule_id] += 1

        # Batch-flush hit counters. One UPDATE per rule that fired —
        # cheap because hits-per-rule is bounded by len(rules) << len(txns).
        if rule_hits:
            now = datetime.utcnow()
            try:
                for rid, n in rule_hits.items():
                    self.db.execute(
                        update(Rule)
                        .where(Rule.id == rid)
                        .values(
                            hit_count=Rule.hit_count + n,
                            last_hit_at=now,
                        )
                    )
            except Exception:  # noqa: BLE001 — best-effort metric
                # Don't let a hit-counter SQL error tank a categorization
                # run. Worst case the metric is stale; the categorizations
                # themselves were already applied above.
                pass
        self.db.commit()
        return counts
