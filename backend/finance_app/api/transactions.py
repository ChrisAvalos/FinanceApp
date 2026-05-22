"""Transaction list + detail + recategorize + dedup endpoints."""
from __future__ import annotations

import logging
from calendar import monthrange
from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from finance_app.api.schemas import (
    TransactionOneTimeUpdate,
    TransactionOut,
    TransactionRecategorize,
)
from finance_app.db.models import (
    Category,
    CategorySource,
    EmailMessage,
    GoalContribution,
    HsaReceipt,
    Receipt,
    Transaction,
)
from finance_app.db.session import get_db
from finance_app.enrichment import EnrichmentService, RENT_SHIFT_DAY_CUTOFF
from finance_app.util.txn_dedup import merchant_token as _merchant_token

logger = logging.getLogger(__name__)

router = APIRouter(tags=["transactions"])


# ---------- Sprint N-6 helpers ----------

# Canonical "Rent / Mortgage" names. When `category_id` filters on this
# category, the effective-month branch also pulls in rent-like txns whose
# actual category is something else (Plaid often tags landlord Zelle as
# Transfer). Same canonicalization the rollup uses.
_RENT_CANONICAL_NAMES = ("rent / mortgage", "rent/mortgage", "rent", "mortgage")


def _parse_effective_month(value: str) -> date:
    """Accept ``'2026-05'`` or ``'2026-05-01'``; return a YYYY-MM-01 date.

    Raises ``HTTPException(400)`` on anything else — the API gives the
    caller a useful error rather than a 500.
    """
    s = value.strip()
    try:
        if len(s) == 7:  # 'YYYY-MM'
            y, m = s.split("-")
            return date(int(y), int(m), 1)
        if len(s) == 10:  # 'YYYY-MM-DD'
            d = date.fromisoformat(s)
            return date(d.year, d.month, 1)
    except ValueError:
        pass
    raise HTTPException(
        status_code=400,
        detail=f"effective_month must be 'YYYY-MM' or 'YYYY-MM-DD'; got {value!r}",
    )


def _list_transactions_by_effective_month(
    *,
    db: Session,
    effective_month: str,
    account_id: int | None,
    category_id: int | None,
    category_ids: str | None,
    min_amount_cents: int | None,
    max_amount_cents: int | None,
    search: str | None,
    only_uncategorized: bool,
    limit: int,
    offset: int,
) -> list[Transaction]:
    """Effective-month transaction listing — the drawer's source of truth.

    Steps:
      1. Parse target month → ``ms`` (YYYY-MM-01) + ``me`` (last day).
      2. Scan posted_date in ``[ms - (31 - RENT_SHIFT_DAY_CUTOFF) .. me]``
         so we capture every txn that COULD rent-shift into ``ms``.
      3. Apply scalar filters that don't depend on enrichment
         (account, amount, search, uncategorized).
      4. Run the result through ``EnrichmentService`` and keep only txns
         whose ``effective_month == ms``.
      5. Apply category filter with rent-attribution awareness: if
         ``category_id`` points to the canonical Rent category, also
         keep txns whose ``is_rent_like`` is True regardless of their
         actual category.
      6. Sort by posted_date desc and apply offset/limit.
    """
    ms = _parse_effective_month(effective_month)
    last_dom = monthrange(ms.year, ms.month)[1]
    me = date(ms.year, ms.month, last_dom)

    # Scan window: ms minus (31 - cutoff) days on the lower bound covers
    # the day-25..31 of the prior month — anything earlier can't rent-shift
    # into ms by our rule.
    cushion_days = 31 - RENT_SHIFT_DAY_CUTOFF + 1   # tiny safety margin
    scan_start = ms - timedelta(days=cushion_days)
    scan_end = me

    stmt = select(Transaction).where(
        Transaction.posted_date >= scan_start,
        Transaction.posted_date <= scan_end,
    )
    if account_id is not None:
        stmt = stmt.where(Transaction.account_id == account_id)
    if min_amount_cents is not None:
        stmt = stmt.where(Transaction.amount_cents >= min_amount_cents)
    if max_amount_cents is not None:
        stmt = stmt.where(Transaction.amount_cents <= max_amount_cents)
    if search:
        stmt = stmt.where(Transaction.description_raw.ilike(f"%{search}%"))
    if only_uncategorized:
        stmt = stmt.where(
            Transaction.category_source.in_(
                [CategorySource.unset, CategorySource.default]
            )
        )

    # NOTE: we deliberately apply `category_id` / `category_ids` filters
    # AFTER enrichment — the rent-canonical case (see below) needs to
    # see all candidate txns to find rent-like ones miscategorized as
    # Transfer.
    candidates = db.execute(stmt).scalars().all()

    # Detect whether the caller is asking for the canonical Rent category.
    # This is what triggers "also pull in rent-like miscategorizations."
    rent_canonical_id: int | None = None
    if category_id is not None:
        cat = db.get(Category, category_id)
        if cat is not None and cat.name and cat.name.strip().lower() in _RENT_CANONICAL_NAMES:
            rent_canonical_id = category_id

    # Parse category_ids string into a set for fast membership check.
    explicit_cat_ids: set[int] | None = None
    if category_ids:
        explicit_cat_ids = set()
        for part in category_ids.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                explicit_cat_ids.add(int(part))
            except ValueError:
                continue
        if not explicit_cat_ids:
            explicit_cat_ids = None

    # Enrich the candidate batch in one pass.
    svc = EnrichmentService(db, today=ms)
    enriched = svc.enrich_batch(candidates)

    # Sprint N-8: surface reasoning[] for the txns whose effective_month
    # differs from posted_month — those are the ones the user might
    # ask "wait, why is this in May?" about. One log line per shifted
    # txn keeps it bounded; full per-txn reasoning still lives on each
    # EnrichedTransaction for future UI surfacing in Sprint P.
    for e in enriched:
        if e.effective_month == ms and e.base.posted_date.month != ms.month:
            desc = (
                e.base.description_clean
                or e.base.description_raw
                or ""
            )[:60]
            logger.info(
                "enrichment: txn #%d (%s, %s) shifted into %s; reasons=%s",
                e.base.id,
                e.base.posted_date.isoformat(),
                desc,
                ms.isoformat(),
                e.reasoning,
            )

    # Filter by effective_month + category constraints.
    keep: list[Transaction] = []
    for e in enriched:
        if e.effective_month != ms:
            continue

        # Category filter — with rent-canonical override.
        tx_cat_id = e.base.category_id
        if explicit_cat_ids is not None:
            # Caller passed category_ids[]: keep only if matches OR
            # is rent-like + caller asked for the rent canonical.
            if tx_cat_id in explicit_cat_ids:
                pass
            elif rent_canonical_id is not None and rent_canonical_id in explicit_cat_ids and e.is_rent_like:
                pass
            else:
                continue
        elif category_id is not None:
            if tx_cat_id == category_id:
                pass
            elif rent_canonical_id is not None and e.is_rent_like:
                pass
            else:
                continue
        # else: no category filter, keep.

        keep.append(e.base)

    # Sort newest first to match the non-effective_month code path.
    keep.sort(key=lambda t: (t.posted_date, t.id), reverse=True)
    return keep[offset : offset + limit]


@router.get("/transactions", response_model=list[TransactionOut])
def list_transactions(
    account_id: int | None = None,
    category_id: int | None = None,
    category_ids: str | None = Query(
        None,
        description=(
            "Comma-separated list of category ids. Used by the sunburst "
            "group drill-down (FU-4) to fetch transactions matching multiple "
            "categories at once (e.g. '12,18,22' for the Food group)."
        ),
    ),
    ids: str | None = Query(
        None,
        description=(
            "Comma-separated list of specific transaction ids to ALSO include. "
            "Unioned with the other filters via OR — used by CategoryDrawer "
            "to additionally fetch rent-attributed transactions from prior "
            "month-end that would otherwise be outside the date range. "
            "DEPRECATED by Sprint N-7 — prefer `effective_month` which handles "
            "rent-attribution structurally via the enrichment service."
        ),
    ),
    effective_month: str | None = Query(
        None,
        description=(
            "Sprint N-6: filter by the enrichment-derived 'effective month' "
            "instead of raw posted_date. Accepts 'YYYY-MM' or 'YYYY-MM-01'. "
            "When set, the server scans txns posted from (prev-month day 25) "
            "through end-of-month, runs them through EnrichmentService, and "
            "returns only those whose effective_month matches. Rent-like "
            "txns posted on the last few days of the prior month land HERE "
            "instead of in their raw-posted month — same semantic the rollup "
            "uses. Overrides start_date/end_date when present. "
            "If `category_id` matches the canonical Rent category, also "
            "includes rent-like txns whose actual category is something else "
            "(Zelle-tagged-Transfer, etc.) — this is what removes the "
            "extraTxIds workaround in the drawer."
        ),
    ),
    start_date: date | None = None,
    end_date: date | None = None,
    min_amount_cents: int | None = None,
    max_amount_cents: int | None = None,
    search: str | None = None,
    only_uncategorized: bool = False,
    limit: int = Query(200, le=1000),
    offset: int = 0,
    db: Session = Depends(get_db),
) -> list[Transaction]:
    # ---------- Sprint N-6: effective_month branch ----------
    # When `effective_month` is set, scan a slightly wider window so we
    # pick up txns rent-shifted FROM the prior month and skip txns shifted
    # OUT into next month. Then filter by enriched.effective_month so the
    # caller gets exactly what the rollup considers part of that month.
    if effective_month is not None:
        return _list_transactions_by_effective_month(
            db=db,
            effective_month=effective_month,
            account_id=account_id,
            category_id=category_id,
            category_ids=category_ids,
            min_amount_cents=min_amount_cents,
            max_amount_cents=max_amount_cents,
            search=search,
            only_uncategorized=only_uncategorized,
            limit=limit,
            offset=offset,
        )

    stmt = select(Transaction)
    if account_id is not None:
        stmt = stmt.where(Transaction.account_id == account_id)
    if category_id is not None:
        stmt = stmt.where(Transaction.category_id == category_id)
    if category_ids:
        # Parse comma-separated ids; drop anything non-integer for safety.
        _cat_id_list: list[int] = []
        for part in category_ids.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                _cat_id_list.append(int(part))
            except ValueError:
                continue
        if _cat_id_list:
            stmt = stmt.where(Transaction.category_id.in_(_cat_id_list))
    if start_date is not None:
        stmt = stmt.where(Transaction.posted_date >= start_date)
    if end_date is not None:
        stmt = stmt.where(Transaction.posted_date <= end_date)
    if min_amount_cents is not None:
        stmt = stmt.where(Transaction.amount_cents >= min_amount_cents)
    if max_amount_cents is not None:
        stmt = stmt.where(Transaction.amount_cents <= max_amount_cents)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(Transaction.description_raw.ilike(like))
    if only_uncategorized:
        stmt = stmt.where(
            Transaction.category_source.in_([CategorySource.unset, CategorySource.default])
        )
    stmt = stmt.order_by(Transaction.posted_date.desc(), Transaction.id.desc())
    stmt = stmt.limit(limit).offset(offset)
    results = db.execute(stmt).scalars().all()

    # Sprint M follow-up (2026-05-14): if explicit `ids` were passed,
    # union them into the result. CategoryDrawer uses this to also
    # include rent-attributed transactions from the prior month's
    # end (e.g. an Apr 30 Zelle to landlord shows up in May's Rent
    # category even though it's outside the date range).
    if ids:
        extra_ids: list[int] = []
        for part in ids.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                extra_ids.append(int(part))
            except ValueError:
                continue
        if extra_ids:
            already_seen = {t.id for t in results}
            missing_ids = [i for i in extra_ids if i not in already_seen]
            if missing_ids:
                extras = db.execute(
                    select(Transaction).where(Transaction.id.in_(missing_ids))
                ).scalars().all()
                results = list(results) + list(extras)
                # Re-sort the union by posted_date desc to keep the
                # date-grouped UI rendering happy.
                results.sort(
                    key=lambda t: (t.posted_date, t.id),
                    reverse=True,
                )
    return results


# ---------------------------------------------------------------------------
# Sprint Q-3 — similarity-based category suggestions
# ---------------------------------------------------------------------------
#
# For every UNCATEGORIZED transaction, guess the most-likely category by
# voting: build an index of merchant-token -> {category: count} from every
# transaction the user HAS categorized, then look each uncategorized row's
# token up in that index. The winning category is the suggestion.
#
# Why merchant-token and not the raw description: raw bank strings carry
# per-charge noise (store #, date, auth code). ``_merchant_token`` strips
# that down to a stable signature ("STARBUCKS", "AMZN MKTP") so charges
# from the same merchant collide into one vote bucket.
#
# This is deliberately simple — no embeddings, no ML lib. It only fires
# when the user has categorized that merchant before. Brand-new merchants
# get no suggestion (the card just stays a "?"). That's honest: we don't
# guess from thin air.
#
# NOTE: this route MUST be declared before "/transactions/{txn_id}" — a
# path like "/transactions/category-suggestions" would otherwise be
# captured by the {txn_id} route with txn_id="category-suggestions".


class CategorySuggestion(BaseModel):
    """One suggested placement for an uncategorized transaction."""
    txn_id: int
    category_id: int
    category_name: str
    # 0..1 — fraction of the merchant's historical votes that went to
    # the winning category. 1.0 = every prior charge from this merchant
    # was filed here; 0.6 = 60% were, the rest scattered.
    score: float
    # How many already-categorized transactions contributed votes.
    sample_count: int


class CategorySuggestionsResponse(BaseModel):
    suggestions: list[CategorySuggestion]


@router.get(
    "/transactions/category-suggestions",
    response_model=CategorySuggestionsResponse,
)
def category_suggestions(
    db: Session = Depends(get_db),
) -> CategorySuggestionsResponse:
    """Suggest a category for every currently-uncategorized transaction.

    Returns one suggestion per uncategorized row that has a merchant
    token we've seen categorized before. Rows with no historical match
    are simply omitted from the response.
    """
    categories_by_id: dict[int, Category] = {
        c.id: c for c in db.execute(select(Category)).scalars().all()
    }

    all_txns = db.execute(select(Transaction)).scalars().all()

    # ---- 1. Build the vote index from categorized rows ----
    # token -> {category_id: vote_count}
    vote_index: dict[str, defaultdict[int, int]] = {}
    uncategorized: list[Transaction] = []
    for tx in all_txns:
        token = _merchant_token(tx.description_raw or tx.description_clean or "")
        if tx.category_id is not None:
            if not token:
                continue
            bucket = vote_index.setdefault(token, defaultdict(int))
            bucket[tx.category_id] += 1
        else:
            uncategorized.append(tx)

    # ---- 2. Look up each uncategorized row ----
    suggestions: list[CategorySuggestion] = []
    for tx in uncategorized:
        token = _merchant_token(tx.description_raw or tx.description_clean or "")
        if not token:
            continue
        bucket = vote_index.get(token)
        if not bucket:
            continue
        total = sum(bucket.values())
        if total == 0:
            continue
        # Winning category = the one with the most votes.
        best_cat_id, best_count = max(bucket.items(), key=lambda kv: kv[1])
        cat = categories_by_id.get(best_cat_id)
        if cat is None:
            continue
        suggestions.append(
            CategorySuggestion(
                txn_id=tx.id,
                category_id=best_cat_id,
                category_name=cat.name,
                score=round(best_count / total, 3),
                sample_count=total,
            )
        )

    return CategorySuggestionsResponse(suggestions=suggestions)


@router.get("/transactions/{txn_id}", response_model=TransactionOut)
def get_transaction(txn_id: int, db: Session = Depends(get_db)) -> Transaction:
    txn = db.get(Transaction, txn_id)
    if not txn:
        raise HTTPException(404, f"Transaction {txn_id} not found")
    return txn


@router.post("/transactions/{txn_id}/recategorize", response_model=TransactionOut)
def recategorize(
    txn_id: int,
    payload: TransactionRecategorize,
    db: Session = Depends(get_db),
) -> Transaction:
    txn = db.get(Transaction, txn_id)
    if not txn:
        raise HTTPException(404, f"Transaction {txn_id} not found")
    txn.category_id = payload.category_id
    txn.merchant_id = payload.merchant_id
    txn.category_source = CategorySource.manual
    txn.category_rule_id = None
    db.commit()
    db.refresh(txn)
    return txn


@router.post("/transactions/{txn_id}/one-time", response_model=TransactionOut)
def set_one_time(
    txn_id: int,
    payload: TransactionOneTimeUpdate,
    db: Session = Depends(get_db),
) -> Transaction:
    """Mark a transaction as one-time, or clear the flag.

    A one-time transaction — a medical emergency, a car repair, a big
    one-off purchase — is excluded from the multi-month projection's
    rolling outflow rate, so a single spike is not extrapolated forward
    as if it recurred every month. It still counts toward this month's
    actuals and the EOM card; only the forward projection ignores it.
    """
    txn = db.get(Transaction, txn_id)
    if not txn:
        raise HTTPException(404, f"Transaction {txn_id} not found")
    txn.is_one_time = payload.is_one_time
    db.commit()
    db.refresh(txn)
    return txn


# ---------------------------------------------------------------------------
# Duplicate-transaction dedup (POST /transactions/dedup)
# ---------------------------------------------------------------------------
#
# Plaid creates duplicates in two flavors:
#
#   1. **Re-link generates new external_ids.** When a Plaid item is
#      removed and re-added (or refreshed in a way that rotates the
#      access token), Plaid hands out new transaction_ids for already-
#      synced transactions. Our upsert dedupes on (source, external_id,
#      account_id), so the new IDs slip past and we end up with
#      identical rows.
#   2. **Pending → posted transitions.** A pending transaction shows up
#      with description "POS DEBIT MERCHANT". When it posts, Plaid sometimes
#      replaces the description with "MERCHANT NAME CITY DATE" and gives
#      it a fresh external_id rather than mutating the pending one. The
#      pending row never gets cleaned up.
#
# The dedup logic uses a tiered match:
#
#   Tier A (exact)  : (account_id, posted_date, amount_cents, description_raw)
#                     — clearly the same transaction; safe to merge.
#   Tier B (fuzzy)  : (account_id, posted_date, amount_cents) AND descriptions
#                     share a normalized merchant token. Catches the
#                     pending → posted flip.
#
# Within a duplicate group, we keep the row with the latest
# ``created_at`` (most recent ingest is presumably the cleanest version)
# and migrate FKs from the dropped rows to the keeper before delete.
# Defaults to dry-run; pass ``apply=true`` to commit changes.
# ---------------------------------------------------------------------------


# FKs that reference Transaction.id. Update before delete to preserve links.
_TXN_FK_MODELS = (HsaReceipt, GoalContribution, EmailMessage, Receipt)

# _merchant_token lives in finance_app.util.txn_dedup so the ingestion
# layer (plaid_connector._upsert_txn) can use the same heuristic at
# insert time — that's the prevention layer; THIS endpoint is the
# cleanup layer for any rows that slipped past it.


class DedupSampleRow(BaseModel):
    """One row in the preview — paired with the ID we'd KEEP and the
    IDs we'd DROP, so the user can spot-check before applying."""
    keep_id: int
    keep_description: str
    drop_ids: list[int]
    drop_descriptions: list[str]
    posted_date: date
    amount_cents: int
    account_id: int
    match_tier: str  # "exact" or "fuzzy"


class DedupResult(BaseModel):
    dry_run: bool
    duplicate_groups: int
    total_rows_to_drop: int
    fks_to_repoint: dict[str, int]  # model name → count
    sample: list[DedupSampleRow]  # first ~20 for spot check


@router.post("/transactions/dedup", response_model=DedupResult)
def dedup_transactions(
    apply: bool = Query(False, description="When true, actually commits the dedup. Default is dry-run."),
    sample_size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
) -> DedupResult:
    """Find duplicate Plaid transactions and (optionally) merge them.

    Two-tier match: exact-description first, then fuzzy merchant-token
    fallback. Within each duplicate group we keep the row with the
    latest ``created_at`` and repoint FKs from droplets to the keeper
    before deletion. ``apply=false`` (default) returns a preview only.
    """
    # Pull every transaction once. For most users this is a few thousand
    # rows; sorting + grouping in Python is O(n) and avoids fighting SQLite
    # GROUP_CONCAT semantics.
    rows = list(db.execute(select(Transaction)).scalars().all())

    # ---------- Tier A: exact (account, date, amount, description) ----------
    exact_buckets: dict[tuple[int, date, int, str], list[Transaction]] = defaultdict(list)
    for r in rows:
        key = (r.account_id, r.posted_date, r.amount_cents, r.description_raw or "")
        exact_buckets[key].append(r)

    # ---------- Tier B: fuzzy (same account/date/amount, same merchant token) ----------
    # Build only AFTER excluding rows already paired in Tier A — otherwise
    # we'd double-count. We track "seen" by transaction id.
    paired_ids: set[int] = set()
    groups: list[tuple[str, list[Transaction]]] = []
    for bucket in exact_buckets.values():
        if len(bucket) >= 2:
            groups.append(("exact", bucket))
            for r in bucket:
                paired_ids.add(r.id)

    fuzzy_buckets: dict[tuple[int, date, int, str], list[Transaction]] = defaultdict(list)
    for r in rows:
        if r.id in paired_ids:
            continue
        token = _merchant_token(r.description_raw or "")
        if not token:
            continue
        key = (r.account_id, r.posted_date, r.amount_cents, token)
        fuzzy_buckets[key].append(r)
    for bucket in fuzzy_buckets.values():
        if len(bucket) >= 2:
            groups.append(("fuzzy", bucket))

    if not groups:
        return DedupResult(
            dry_run=not apply,
            duplicate_groups=0,
            total_rows_to_drop=0,
            fks_to_repoint={},
            sample=[],
        )

    # Within each group: pick the keeper (latest created_at; falls back
    # to highest id if created_at is null). Everything else gets dropped.
    drop_ids: list[int] = []
    keep_to_drop_map: dict[int, list[int]] = {}  # keeper_id → [drop_ids]
    sample: list[DedupSampleRow] = []
    for tier, bucket in groups:
        bucket.sort(
            key=lambda r: (r.created_at or 0, r.id),
            reverse=True,
        )
        keeper, *drops = bucket
        drop_ids_for_group = [d.id for d in drops]
        keep_to_drop_map[keeper.id] = drop_ids_for_group
        drop_ids.extend(drop_ids_for_group)
        if len(sample) < sample_size:
            sample.append(
                DedupSampleRow(
                    keep_id=keeper.id,
                    keep_description=keeper.description_raw or "",
                    drop_ids=drop_ids_for_group,
                    drop_descriptions=[d.description_raw or "" for d in drops],
                    posted_date=keeper.posted_date,
                    amount_cents=keeper.amount_cents,
                    account_id=keeper.account_id,
                    match_tier=tier,
                )
            )

    # Count FK repoints needed.
    fk_counts: dict[str, int] = {}
    for model in _TXN_FK_MODELS:
        if not drop_ids:
            fk_counts[model.__name__] = 0
            continue
        n = db.execute(
            select(model).where(model.transaction_id.in_(drop_ids))
        ).scalars().all()
        fk_counts[model.__name__] = len(n)

    if not apply:
        return DedupResult(
            dry_run=True,
            duplicate_groups=len(groups),
            total_rows_to_drop=len(drop_ids),
            fks_to_repoint=fk_counts,
            sample=sample,
        )

    # APPLY mode: repoint FKs from drops → keeper, then delete drops.
    # We do this in one pass per group so each FK row points to the
    # correct keeper (groups don't share keepers, but repoint per-group
    # is the safest semantic).
    for keeper_id, drops_in_group in keep_to_drop_map.items():
        if not drops_in_group:
            continue
        for model in _TXN_FK_MODELS:
            db.execute(
                update(model)
                .where(model.transaction_id.in_(drops_in_group))
                .values(transaction_id=keeper_id)
            )

    # Now safe to delete the drops. Use a single delete for efficiency.
    if drop_ids:
        for d in db.execute(
            select(Transaction).where(Transaction.id.in_(drop_ids))
        ).scalars().all():
            db.delete(d)
    db.commit()
    logger.info(
        "Dedup applied — dropped %d transaction rows across %d groups, "
        "repointed FKs: %s",
        len(drop_ids),
        len(groups),
        fk_counts,
    )
    return DedupResult(
        dry_run=False,
        duplicate_groups=len(groups),
        total_rows_to_drop=len(drop_ids),
        fks_to_repoint=fk_counts,
        sample=sample,
    )
