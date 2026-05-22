"""Best-card-for-merchant analyzer.

For each transaction in a window:
  - Identify the card it was charged to and that card's rewards profile.
  - Identify the OPTIMAL card among the user's other linked cards for
    the same category.
  - Compute the rewards earned vs. the rewards that could have been
    earned, and surface the difference as "left on the table."

Outputs aggregate to a :class:`RewardLeakageReport` that the API layer
returns to the UI.

Important non-goals
-------------------
* We do NOT recommend cards the user doesn't already have. This is an
  optimizer over the existing wallet, not an upsell engine.
* We do NOT model points-to-cents conversion variance (Sapphire Reserve
  points are worth more if redeemed via Chase Travel, etc.). Profiles
  in the YAML use 1pt = 1¢ as the conservative default; realistic
  redemption upside is in the per-card ``notes`` for the UI to surface.
* We do NOT enforce monthly caps (only annual). Caps below $500/month
  rarely bind for a personal user; tracking them adds complexity without
  meaningful accuracy gain. The YAML annual cap is the conservative model.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import Account, AccountType, Category, Transaction
from .profiles import CardRewardProfile, load_profiles


@dataclass
class TransactionAnalysis:
    """Per-transaction read-out: what was used, what was best, what's the gap."""

    transaction_id: int
    posted_date: date
    description: str
    amount_cents: int  # POSITIVE — purchase amount (we look at outflows only)
    category_slug: str | None
    used_account_id: int
    used_account_name: str
    used_multiplier: float
    used_value_cents: int
    best_account_id: int | None
    best_account_name: str | None
    best_multiplier: float
    best_value_cents: int
    left_on_table_cents: int


@dataclass
class CategoryLeakage:
    """Aggregate leakage for one spend category."""

    category_slug: str
    category_name: str
    total_spend_cents: int
    used_value_cents: int
    best_value_cents: int
    left_on_table_cents: int
    transactions: int


@dataclass
class RewardLeakageReport:
    """Top-level structure the API returns."""

    window_start: date
    window_end: date
    cards_analyzed: int
    total_spend_cents: int
    total_used_value_cents: int
    total_best_value_cents: int
    total_left_on_table_cents: int
    by_category: list[CategoryLeakage] = field(default_factory=list)
    top_misuses: list[TransactionAnalysis] = field(default_factory=list)
    unmatched_card_ids: list[int] = field(default_factory=list)


# -- internals ---------------------------------------------------------


def _resolve_profiles(
    cards: list[Account], profiles: list[CardRewardProfile]
) -> tuple[dict[int, CardRewardProfile], list[int]]:
    """Map account_id → profile for cards we can match. Return unmatched ids too."""
    matched: dict[int, CardRewardProfile] = {}
    unmatched: list[int] = []
    for c in cards:
        for p in profiles:
            if p.matches(c.name):
                matched[c.id] = p
                break
        else:
            unmatched.append(c.id)
    return matched, unmatched


def _slug_lookup(db: Session) -> tuple[dict[int, str], dict[int, str]]:
    """Return (id→slug, id→display_name) for the Category table."""
    rows = db.execute(select(Category.id, Category.slug, Category.name)).all()
    by_slug: dict[int, str] = {}
    by_name: dict[int, str] = {}
    for r in rows:
        by_slug[r.id] = r.slug
        by_name[r.id] = r.name
    return by_slug, by_name


def _best_card_for(
    category_slug: str | None,
    profiles_by_account: dict[int, CardRewardProfile],
    used_account_id: int,
) -> tuple[int | None, CardRewardProfile | None, float]:
    """Among the user's linked cards, which earns the most on this category?

    Returns (account_id, profile, multiplier). When no other card beats
    the one used, returns the used card itself — that means
    ``left_on_table = 0`` for that transaction, which is the correct
    semantics ("you used the best option you had").
    """
    best_id: int | None = None
    best_profile: CardRewardProfile | None = None
    best_mult: float = -1.0
    for acct_id, prof in profiles_by_account.items():
        m = prof.multiplier_for(category_slug)
        if m > best_mult:
            best_id = acct_id
            best_profile = prof
            best_mult = m
    # If used card ties for best, prefer used (no leakage flag).
    used_prof = profiles_by_account.get(used_account_id)
    if used_prof is not None:
        used_mult = used_prof.multiplier_for(category_slug)
        if used_mult >= best_mult:
            return used_account_id, used_prof, used_mult
    return best_id, best_profile, best_mult


# -- public API --------------------------------------------------------


def analyze_transactions(
    db: Session,
    *,
    since: date | None = None,
    until: date | None = None,
    profiles: list[CardRewardProfile] | None = None,
    top_n_misuses: int = 10,
) -> RewardLeakageReport:
    """Compute the rewards-leakage report.

    Defaults to the trailing 90 days. Only credit-card accounts are
    analyzed; debit/checking/etc. are excluded. Transactions where we
    couldn't match the card OR couldn't categorize are skipped (they
    can't meaningfully be optimized without more info).
    """
    if profiles is None:
        profiles = load_profiles()
    if until is None:
        until = date.today()
    if since is None:
        since = until - timedelta(days=90)

    # 1. Gather credit-card accounts + match each to a profile
    cards: list[Account] = list(
        db.execute(
            select(Account).where(Account.account_type == AccountType.credit_card)
        )
        .scalars()
        .all()
    )
    profiles_by_account, unmatched = _resolve_profiles(cards, profiles)
    if not profiles_by_account:
        return RewardLeakageReport(
            window_start=since,
            window_end=until,
            cards_analyzed=0,
            total_spend_cents=0,
            total_used_value_cents=0,
            total_best_value_cents=0,
            total_left_on_table_cents=0,
            unmatched_card_ids=[c.id for c in cards],
        )

    cat_slug_by_id, cat_name_by_id = _slug_lookup(db)

    # 2. Pull every outflow on the matched cards in window
    matched_ids = list(profiles_by_account.keys())
    txns: list[Transaction] = list(
        db.execute(
            select(Transaction)
            .where(Transaction.account_id.in_(matched_ids))
            .where(Transaction.posted_date >= since)
            .where(Transaction.posted_date <= until)
            .where(Transaction.amount_cents < 0)
        )
        .scalars()
        .all()
    )

    # 3. Annual-cap state per (account_id, slug). We track only spend
    #    that already counts toward each card's caps so the analyzer
    #    correctly reverts to base_multiplier after a cap binds.
    cap_spent: dict[tuple[int, str], int] = defaultdict(int)

    def _eff_mult(prof: CardRewardProfile, slug: str | None, spend: int, account_id: int) -> float:
        if slug is None or slug not in prof.category_multipliers:
            return prof.base_multiplier
        cap = prof.annual_caps_cents.get(slug)
        if cap is None:
            return prof.category_multipliers[slug]
        # If existing cap-spend would exhaust the cap before this txn,
        # revert to base for this txn. Approximation — a partial-bind
        # case (txn straddles the cap) gets the base rate too, which
        # slightly under-estimates the boosted earnings. Acceptable.
        already = cap_spent[(account_id, slug)]
        if already >= cap:
            return prof.base_multiplier
        return prof.category_multipliers[slug]

    by_cat: dict[str, CategoryLeakage] = {}
    rows: list[TransactionAnalysis] = []
    total_spend = 0
    total_used = 0
    total_best = 0

    for t in sorted(txns, key=lambda x: x.posted_date):
        spend = -t.amount_cents  # outflow as positive cents
        slug = cat_slug_by_id.get(t.category_id) if t.category_id else None
        used_id = t.account_id
        used_prof = profiles_by_account.get(used_id)
        if used_prof is None:
            continue  # shouldn't happen since we filtered, defensive
        used_m = _eff_mult(used_prof, slug, spend, used_id)
        used_value = int(round(spend * used_m / 100))  # cents earned (1pt = 1¢)

        best_id, best_prof, best_m = _best_card_for(slug, profiles_by_account, used_id)
        # Apply the cap to the BEST card too — it's the value Chris would
        # have earned IF he'd routed through that card (and would also
        # accumulate against its cap).
        if best_prof is not None:
            best_m = _eff_mult(best_prof, slug, spend, best_id) if best_id is not None else best_m
        best_value = int(round(spend * best_m / 100))

        leakage = max(0, best_value - used_value)
        cap_spent[(used_id, slug or "_none")] += spend
        if best_id != used_id and best_id is not None:
            cap_spent[(best_id, slug or "_none")] += spend  # hypothetical

        analysis = TransactionAnalysis(
            transaction_id=t.id,
            posted_date=t.posted_date,
            description=t.description_raw or "",
            amount_cents=spend,
            category_slug=slug,
            used_account_id=used_id,
            used_account_name=next(c.name for c in cards if c.id == used_id),
            used_multiplier=used_m,
            used_value_cents=used_value,
            best_account_id=best_id,
            best_account_name=(
                next((c.name for c in cards if c.id == best_id), None)
                if best_id is not None
                else None
            ),
            best_multiplier=best_m,
            best_value_cents=best_value,
            left_on_table_cents=leakage,
        )
        rows.append(analysis)

        cat_key = slug or "uncategorized"
        cat_disp_name = cat_name_by_id.get(t.category_id, "Uncategorized") if t.category_id else "Uncategorized"
        if cat_key not in by_cat:
            by_cat[cat_key] = CategoryLeakage(
                category_slug=cat_key,
                category_name=cat_disp_name,
                total_spend_cents=0,
                used_value_cents=0,
                best_value_cents=0,
                left_on_table_cents=0,
                transactions=0,
            )
        cl = by_cat[cat_key]
        cl.total_spend_cents += spend
        cl.used_value_cents += used_value
        cl.best_value_cents += best_value
        cl.left_on_table_cents += leakage
        cl.transactions += 1

        total_spend += spend
        total_used += used_value
        total_best += best_value

    # Sort categories by leakage desc, top misuses by individual leakage desc.
    sorted_cats = sorted(
        by_cat.values(), key=lambda c: c.left_on_table_cents, reverse=True
    )
    top_misuses = sorted(
        (r for r in rows if r.left_on_table_cents > 0),
        key=lambda r: r.left_on_table_cents,
        reverse=True,
    )[:top_n_misuses]

    return RewardLeakageReport(
        window_start=since,
        window_end=until,
        cards_analyzed=len(profiles_by_account),
        total_spend_cents=total_spend,
        total_used_value_cents=total_used,
        total_best_value_cents=total_best,
        total_left_on_table_cents=max(0, total_best - total_used),
        by_category=sorted_cats,
        top_misuses=top_misuses,
        unmatched_card_ids=unmatched,
    )
