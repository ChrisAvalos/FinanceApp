"""Categorization rule CRUD + trigger batch-recategorize."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.api.schemas import RuleIn, RuleOut
from finance_app.categorization.engine import CategorizationEngine
from finance_app.db.models import Category, CategorySource, Rule, Transaction
from finance_app.db.session import get_db

router = APIRouter(tags=["rules"])


@router.get("/rules", response_model=list[RuleOut])
def list_rules(db: Session = Depends(get_db)) -> list[Rule]:
    return db.execute(select(Rule).order_by(Rule.priority.desc(), Rule.name)).scalars().all()


@router.post("/rules", response_model=RuleOut, status_code=201)
def create_rule(payload: RuleIn, db: Session = Depends(get_db)) -> Rule:
    rule = Rule(**payload.model_dump(), is_seed=False)
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


@router.put("/rules/{rule_id}", response_model=RuleOut)
def update_rule(rule_id: int, payload: RuleIn, db: Session = Depends(get_db)) -> Rule:
    rule = db.get(Rule, rule_id)
    if not rule:
        raise HTTPException(404, "Rule not found")
    for k, v in payload.model_dump().items():
        setattr(rule, k, v)
    db.commit()
    db.refresh(rule)
    return rule


@router.delete("/rules/{rule_id}", status_code=204)
def delete_rule(rule_id: int, db: Session = Depends(get_db)) -> None:
    rule = db.get(Rule, rule_id)
    if not rule:
        raise HTTPException(404, "Rule not found")
    db.delete(rule)
    db.commit()


@router.post("/rules/run", tags=["categorization"])
def run_categorization(
    only_unset: bool = True,
    use_llm: bool = False,
    db: Session = Depends(get_db),
) -> dict[str, int]:
    """Batch-run the categorization engine over existing transactions.

    Set ``use_llm=true`` to enable the T3 LLM fallback for transactions
    that the rules + merchant-fuzzy match couldn't classify. Requires a
    running Ollama instance (see MANUAL_TASKS.md item #3). When Ollama
    isn't reachable the fallback is a no-op — same result as use_llm=false.
    The LLM also pins a high-priority Rule for each merchant it
    classifies, so subsequent runs of the same merchant skip the LLM.
    """
    engine = CategorizationEngine(db, llm_fallback_enabled=use_llm)
    return engine.categorize_all(only_unset=only_unset)


def _derive_merchant_pattern(description: str) -> str:
    """Heuristic: strip noise and extract the merchant signature for a rule.

    Removes leading "POS DEBIT" / "POS PURCHASE" / "ACH DEBIT" prefixes,
    trailing date stamps (MM/DD or MMDD), trailing zip + state codes,
    and small noise tokens like account masks. The result is uppercased
    and passed to the rules engine as a substring match.

    Examples (input → output):
        "POS DEBIT TROJAN STORAGE OF SAN J 3103728600" → "TROJAN STORAGE"
        "STARBUCKS #1234 SAN JOSE CA 04/27"            → "STARBUCKS"
        "AMAZON MKTPL*BV70D30 Amzn.com/bill WA 04/30"  → "AMAZON MKTPL"
        "TST* MOUNTAIN WINERY"                         → "MOUNTAIN WINERY"
        "SQ *BLUE BOTTLE COFFEE"                       → "BLUE BOTTLE COFFEE"
        "PAYPAL *STEAMGAMES"                           → "STEAMGAMES"
    """
    s = description.strip().upper()
    # Strip common bank-encoded prefixes
    s = re.sub(r"^(POS\s+DEBIT|POS\s+PURCHASE|ACH\s+DEBIT|ACH\s+CREDIT|DEBIT\s+CARD)\s+", "", s)
    # Strip payment-processor prefixes. Toast charges land as
    # "TST* MERCHANT", Square as "SQ *MERCHANT", PayPal as
    # "PAYPAL *MERCHANT" — the processor isn't the merchant, so
    # "TST* MOUNTAIN WINERY" should derive to "MOUNTAIN WINERY".
    # PAYPAL is spelled out (6 chars) so it needs its own pattern;
    # the rest are 2-4 letter codes followed by '*'.
    s = re.sub(r"^PAYPAL\s*\*\s*", "", s)
    s = re.sub(r"^[A-Z]{2,4}\s*\*\s*", "", s)
    # Strip a trailing date stamp like " 04/27" or " 0427"
    s = re.sub(r"\s+\d{1,2}/\d{1,2}\b.*$", "", s)
    s = re.sub(r"\s+\d{6,}\s*$", "", s)  # trailing long numeric suffix
    # Strip a trailing 2-letter state + zip-ish tail (e.g. " CA 0108")
    s = re.sub(r"\s+[A-Z]{2}\s+\d+\s*$", "", s)
    # Strip a trailing all-numeric account-mask-looking token
    s = re.sub(r"\s+\d{3,}\s*$", "", s)
    # Strip store-number tokens ("#1234"). NOT end-anchored — once a
    # trailing date is removed, the "#1234" can end up mid-string
    # ("STARBUCKS #1234 SAN JOSE"), so match it anywhere. re.sub
    # replaces every occurrence.
    s = re.sub(r"\s+#\S+", "", s)
    # Take the first 1-3 word tokens — small enough to match consistently,
    # large enough to disambiguate from common substrings.
    tokens = [t for t in s.split() if t]
    head = tokens[:3] if len(tokens) >= 3 else tokens
    pattern = " ".join(head).strip()
    # Bail if we somehow ended up with too short a pattern — a 1- or 2-char
    # rule would over-match every transaction in the DB.
    if len(pattern) < 3:
        return s.split()[0] if s.split() else s
    return pattern


class RuleFromTransactionPayload(BaseModel):
    transaction_id: int = Field(..., description="The transaction we're categorizing")
    category_id: int = Field(..., description="Target category to assign")
    # Optional override — by default we derive a pattern from the txn's
    # description, but the user can hand-edit it before submitting.
    pattern_override: str | None = None
    name_override: str | None = None


class RuleFromTransactionResponse(BaseModel):
    rule_id: int
    pattern: str
    category_slug: str
    txns_now_matching: int
    counts: dict[str, int]


@router.post("/rules/from-transaction", response_model=RuleFromTransactionResponse, tags=["categorization"])
def create_rule_from_transaction(
    payload: RuleFromTransactionPayload,
    db: Session = Depends(get_db),
) -> RuleFromTransactionResponse:
    """One-click categorization: tag a row + create a rule that catches its kin.

    Backs the inline "Categorize this" UX on the Transactions panel:
    the user picks a category, we derive a substring pattern from the
    merchant string, store a non-seed Rule pinned at priority 230 (above
    most seed rules so it wins), apply it to the originating transaction
    immediately, and re-run categorization over remaining unset rows so
    other matching merchants get the same category.
    """
    txn = db.get(Transaction, payload.transaction_id)
    if not txn:
        raise HTTPException(404, "Transaction not found")
    cat = db.get(Category, payload.category_id)
    if not cat:
        raise HTTPException(404, "Category not found")

    desc = txn.description_raw or txn.description_clean or ""
    pattern = (payload.pattern_override or _derive_merchant_pattern(desc)).upper()
    if not pattern or len(pattern) < 3:
        raise HTTPException(
            400,
            f"Couldn't derive a useful pattern from {desc!r}. Edit the pattern manually.",
        )
    name = payload.name_override or pattern.title()

    # Don't double-up — if a non-seed rule already has this pattern, reuse it.
    existing = db.execute(
        select(Rule).where(
            Rule.pattern == pattern,
            Rule.is_seed.is_(False),
        )
    ).scalars().first()
    if existing:
        existing.category_id = cat.id
        existing.is_active = True
        rule = existing
    else:
        rule = Rule(
            name=name,
            pattern=pattern,
            is_regex=False,
            category_id=cat.id,
            priority=230,  # above most seed rules; user intent wins
            is_seed=False,
            is_active=True,
        )
        db.add(rule)
        db.flush()

    # Pin the originating transaction immediately as "manual" so the user
    # sees the change without waiting for batch — and so it's not later
    # over-written by another rule. The rule still serves future rows.
    txn.category_id = cat.id
    txn.category_source = CategorySource.manual
    txn.category_rule_id = rule.id
    db.commit()

    # Apply the new rule to other still-unset rows so the user sees the
    # cascade visually on the Transactions panel without a second click.
    counts = CategorizationEngine(db).categorize_all(only_unset=True)

    txns_now_matching = (
        db.execute(
            select(Transaction).where(Transaction.category_rule_id == rule.id)
        )
        .scalars()
        .all()
    )

    return RuleFromTransactionResponse(
        rule_id=rule.id,
        pattern=rule.pattern,
        category_slug=cat.slug,
        txns_now_matching=len(txns_now_matching),
        counts=counts,
    )


class UncategorizedGroup(BaseModel):
    """One row in the bulk-categorize triage list."""
    pattern: str          # derived merchant pattern (also used for the rule)
    sample_description: str  # one example raw description so the user knows what this is
    txn_count: int        # how many uncategorized rows this would catch
    total_outflow_cents: int  # negative — the dollar size of this group


@router.get(
    "/rules/uncategorized-groups",
    response_model=list[UncategorizedGroup],
    tags=["categorization"],
)
def list_uncategorized_groups(
    min_txn_count: int = 1,
    limit: int = 50,
    db: Session = Depends(get_db),
) -> list[UncategorizedGroup]:
    """Group uncategorized transactions by derived merchant pattern.

    Backs the bulk-categorize triage UX — instead of tagging 95 rows
    one-at-a-time, the user sees the top-N merchant signatures by row
    count and assigns a category to each in one shot.

    Each group's pattern is the same string ``_derive_merchant_pattern``
    would produce, so a follow-up POST to ``/rules/from-transaction``
    on any row in the group creates a rule that catches the rest.
    """
    from collections import defaultdict
    from finance_app.db.models import Category

    uncategorized_id = (
        db.execute(select(Category.id).where(Category.slug == "uncategorized"))
        .scalar_one_or_none()
    )
    stmt = select(Transaction).where(
        (Transaction.category_id == uncategorized_id) | (Transaction.category_id.is_(None))
    )
    rows = list(db.execute(stmt).scalars().all())
    groups: dict[str, dict] = defaultdict(
        lambda: {"sample": "", "txn_count": 0, "total_cents": 0, "first_txn_id": None}
    )
    for t in rows:
        desc = t.description_raw or t.description_clean or ""
        pattern = _derive_merchant_pattern(desc).upper()
        if not pattern or len(pattern) < 3:
            continue
        g = groups[pattern]
        if g["txn_count"] == 0:
            g["sample"] = desc
            g["first_txn_id"] = t.id
        g["txn_count"] += 1
        if t.amount_cents < 0:
            g["total_cents"] += t.amount_cents

    out = [
        UncategorizedGroup(
            pattern=p,
            sample_description=g["sample"],
            txn_count=g["txn_count"],
            total_outflow_cents=g["total_cents"],
        )
        for p, g in groups.items()
        if g["txn_count"] >= min_txn_count
    ]
    out.sort(key=lambda r: r.txn_count, reverse=True)
    return out[:limit]


class BulkCategorizeItem(BaseModel):
    pattern: str
    category_id: int


class BulkCategorizePayload(BaseModel):
    items: list[BulkCategorizeItem]


class BulkCategorizeResult(BaseModel):
    rules_created: int
    rules_updated: int
    txns_tagged: int


@router.post(
    "/rules/bulk-from-patterns",
    response_model=BulkCategorizeResult,
    tags=["categorization"],
)
def bulk_create_rules_from_patterns(
    payload: BulkCategorizePayload,
    db: Session = Depends(get_db),
) -> BulkCategorizeResult:
    """One-shot bulk-categorize: take N (pattern, category) pairs, create
    a Rule for each, then re-run categorize_all so every matching txn
    gets tagged in a single engine pass.

    Backs the "Categorize all uncategorized" wizard on Transactions
    where the user can triage the long tail in 30 seconds instead of
    clicking 50 individual + Categorize buttons.
    """
    rules_created = 0
    rules_updated = 0
    for item in payload.items:
        pattern = item.pattern.strip().upper()
        if len(pattern) < 3:
            continue
        cat = db.get(Category, item.category_id)
        if cat is None:
            continue
        existing = db.execute(
            select(Rule).where(Rule.pattern == pattern, Rule.is_seed.is_(False))
        ).scalars().first()
        if existing:
            existing.category_id = cat.id
            existing.is_active = True
            rules_updated += 1
        else:
            db.add(
                Rule(
                    name=pattern.title(),
                    pattern=pattern,
                    is_regex=False,
                    category_id=cat.id,
                    priority=230,  # above seed rules — user intent wins
                    is_seed=False,
                    is_active=True,
                )
            )
            rules_created += 1
    db.flush()
    counts = CategorizationEngine(db).categorize_all(only_unset=True)
    db.commit()
    return BulkCategorizeResult(
        rules_created=rules_created,
        rules_updated=rules_updated,
        txns_tagged=counts.get("rule", 0),
    )


@router.post("/rules/reload-seed", tags=["categorization"])
def reload_seed_rules(db: Session = Depends(get_db)) -> dict[str, int]:
    """Re-load rules from categorization/seed_rules.yaml.

    Idempotent — matches existing seed rules by ``name`` and updates them
    in place (pattern, regex flag, category, priority). New rules are
    inserted. Existing user-added (non-seed) rules are NOT touched.
    Useful when you've edited the YAML and want changes live without
    restarting the server.
    """
    from finance_app.db.seed import load_seed_rules
    from finance_app.db.models import Category as CategoryModel

    cats = {c.slug: c for c in db.execute(select(CategoryModel)).scalars().all()}
    before = db.execute(select(Rule).where(Rule.is_seed.is_(True))).scalars().all()
    load_seed_rules(db, cats)
    db.commit()
    after = db.execute(select(Rule).where(Rule.is_seed.is_(True))).scalars().all()
    return {"before": len(before), "after": len(after), "added": len(after) - len(before)}


class PatternCleanupChange(BaseModel):
    """One rule the cleanup pass would touch (or did touch)."""
    rule_id: int
    old_pattern: str
    new_pattern: str
    applied: bool
    skipped_reason: str | None = None


class PatternCleanupResult(BaseModel):
    dry_run: bool
    rules_scanned: int
    changes: list[PatternCleanupChange]


@router.post("/rules/cleanup-patterns", response_model=PatternCleanupResult, tags=["categorization"])
def cleanup_rule_patterns(
    apply: bool = False,
    db: Session = Depends(get_db),
) -> PatternCleanupResult:
    """Re-derive the pattern on every non-seed rule so old rules get the
    benefit of later improvements to ``_derive_merchant_pattern``
    (processor-prefix stripping, mid-string store-number stripping...).

    Running the deriver on an ALREADY-clean pattern is a no-op, so this
    is safe to run repeatedly. Seed rules are never touched.

    Defaults to dry-run; pass ``apply=true`` to commit. Collision-safe:
    if a re-derived pattern would collide with a pattern already in use
    by another rule, that change is skipped and reported with a reason.
    """
    non_seed = db.execute(
        select(Rule).where(Rule.is_seed.is_(False))
    ).scalars().all()

    patterns_in_use: set[str] = {
        r.pattern for r in db.execute(select(Rule)).scalars().all()
    }

    changes: list[PatternCleanupChange] = []
    for rule in non_seed:
        old_pattern = rule.pattern  # capture before any mutation
        new_pattern = _derive_merchant_pattern(old_pattern)
        if not new_pattern or new_pattern == old_pattern:
            continue  # already clean

        if new_pattern in patterns_in_use:
            changes.append(
                PatternCleanupChange(
                    rule_id=rule.id,
                    old_pattern=old_pattern,
                    new_pattern=new_pattern,
                    applied=False,
                    skipped_reason="another rule already uses the cleaned pattern",
                )
            )
            continue

        if apply:
            patterns_in_use.discard(old_pattern)
            patterns_in_use.add(new_pattern)
            rule.pattern = new_pattern
        changes.append(
            PatternCleanupChange(
                rule_id=rule.id,
                old_pattern=old_pattern,
                new_pattern=new_pattern,
                applied=apply,
            )
        )

    if apply:
        db.commit()

    return PatternCleanupResult(
        dry_run=not apply,
        rules_scanned=len(non_seed),
        changes=changes,
    )
