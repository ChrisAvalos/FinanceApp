"""Subscription / recurring-payment detector.

Algorithm (no LLM, no external lookups):

1. Pull all outflow transactions, excluding categories that are known non-
   subscriptions (credit-card payments, transfers, interest, fees).
2. Cluster transactions by a *stable description key* — uppercased, with digits
   and punctuation stripped, keeping only the first few significant tokens.
   So "NETFLIX.COM 866-579-7172" and "NETFLIX.COM 800-1111" both key to
   "NETFLIX COM".
3. For each cluster, run TWO passes:
      Pass 1 — fixed-amount (strict 8% tolerance). Applies to streaming/SaaS/
               news/fitness/storage/gaming and unknowns.
      Pass 2 — variable-amount (loose 50% tolerance, monthly-only cadence).
               Applies to clusters whose type classifier says
               utilities/internet/telecom/insurance.
4. For matched clusters, compute:
      - cadence (monthly/biweekly/annual etc.) by gap median
      - confidence_score from n_occurrences × amount_stability × cadence_agreement
      - price-change signal: if the last 1-2 charges' mean differs from the
        prior baseline by >5% AND outside the active tolerance window, flag
        ``last_amount_cents`` / ``prior_amount_cents`` / ``price_change_date``.
5. Run the type classifier on every detection.
6. Upsert into ``subscriptions`` table by name (normalized key).

Deliberate non-goals for v1 (still true):
    * Usage scoring ("do you actually use Netflix?") — needs richer signals
      (app activity, merchant activity beyond the recurring charge).
      ``usage_score`` stays null.
    * Free-trial → paid detection — handled here by virtue of price-change
      logic: the small/$0 first charge becomes ``prior_amount_cents`` once a
      full charge follows, and the UI surfaces the bump as a "trial ended"
      event indistinguishable from a generic price increase. Good enough for
      Phase B; we can split it out later.
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from statistics import mean, median, pstdev

from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    Category,
    Subscription,
    SubscriptionStatus,
    SubscriptionType,
    Transaction,
)
from finance_app.subscriptions.type_classifier import (
    classify_type,
    is_variable_amount_type,
)

# (min, max, typical, label) — windows chosen to allow ±2-4 day drift around
# common billing cadences without overlap.
CADENCE_BUCKETS: list[tuple[int, int, int, str]] = [
    (6, 8, 7, "weekly"),
    (13, 16, 14, "biweekly"),
    (26, 35, 30, "monthly"),
    (55, 70, 60, "bimonthly"),
    (85, 95, 90, "quarterly"),
    (175, 190, 180, "semiannual"),
    (355, 375, 365, "annual"),
]

# Category slugs that should NEVER produce a Subscription row even if they
# look periodic. These are either other categories of recurring events
# (a salary deposit looks like a monthly subscription) or financial
# movements that aren't subscriptions.
NON_SUBSCRIPTION_CATEGORY_SLUGS: set[str] = {
    "financial.payment",
    "financial.transfer",
    "financial.interest",
    "financial.fees",
    "financial.savings",
    "financial.investment",
    "income.salary",
    "income.interest",
    "income.refund",
    "income.other",
    # Real-life recurring outflows that aren't "subscriptions" in the
    # cancellable / negotiable sense. Rent recurs perfectly monthly, gas
    # fills happen on a near-monthly cadence at the same gas station, and
    # restaurants people frequent regularly cluster too — but none of
    # these are things the user wants surfaced under "Cancel or downgrade."
    # Added 2026-04-27 after the first UI test pass found rent+gas
    # showing up as 86–87%-confidence subs.
    "housing.rent_mortgage",
    "transport.gas",
    "food.restaurants",
}

# How many significant tokens from the description form the cluster key.
KEY_TOKENS = 3
# Strict tolerance for fixed-amount subscriptions (streaming/SaaS).
STRICT_AMOUNT_TOLERANCE = 0.08
# Loose tolerance for variable-amount bills (utilities, insurance).
LOOSE_AMOUNT_TOLERANCE = 0.50
# Minimum occurrences for a CONFIDENTLY-classified subscription (streaming,
# saas, fitness, news, etc. — anything classify_type returns a known label
# for). Two consistent monthly Netflix charges is enough to call it a sub.
MIN_OCCURRENCES = 2

# Minimum occurrences when the type classifier returns "unknown". Unknown
# means we don't recognize the merchant pattern, so two coincidental
# charges shouldn't promote to a Subscription row. Three forces the user's
# transaction history to genuinely repeat before we flag. This is what
# stops two-visits-a-month-apart Hog Island Oyster from looking like a sub.
MIN_OCCURRENCES_UNKNOWN_TYPE = 3
# Variable-amount bills require monthly cadence — too irregular to trust
# semi-annual or quarterly bills with 50% tolerance.
VARIABLE_AMOUNT_CADENCES = {"monthly", "bimonthly"}
# Minimum price-change magnitude (fraction). Smaller drifts are noise.
PRICE_CHANGE_THRESHOLD = 0.05


def normalize_key(desc: str) -> str:
    """Produce a stable grouping key from a raw transaction description.

    Strips digits and punctuation so that merchant identifiers, transaction
    codes, and phone numbers don't split a cluster.
    """
    if not desc:
        return ""
    s = desc.upper()
    s = re.sub(r"[^A-Z ]+", " ", s)  # drop digits & punctuation
    tokens = [t for t in s.split() if len(t) > 1]  # drop single letters
    return " ".join(tokens[:KEY_TOKENS])


def classify_cadence(gaps_days: list[int]) -> tuple[int, str] | None:
    """Given gaps between consecutive charges, identify the cadence.

    Returns ``(typical_days, label)`` or None if the gaps don't fit any bucket
    consistently.  We require at least 60% of gaps to agree on the bucket.
    """
    if not gaps_days:
        return None
    med = median(gaps_days)
    for lo, hi, typical, label in CADENCE_BUCKETS:
        if lo <= med <= hi:
            agree = sum(1 for g in gaps_days if lo <= g <= hi)
            if agree / len(gaps_days) >= 0.6:
                return typical, label
            return None
    return None


def cadence_agreement_score(gaps_days: list[int], cadence_lo: int, cadence_hi: int) -> float:
    if not gaps_days:
        return 0.0
    agree = sum(1 for g in gaps_days if cadence_lo <= g <= cadence_hi)
    return agree / len(gaps_days)


def amount_stability_score(amount_cents_list: list[int]) -> float:
    """0..1 — how stable the amounts are. Coefficient of variation inverted.

    For variable-amount bills this will be lower (~0.5) but that's still
    meaningful; the stability score feeds confidence_score, not the
    pass/fail decision.
    """
    if len(amount_cents_list) < 2:
        return 1.0
    abs_amounts = [abs(a) for a in amount_cents_list]
    m = mean(abs_amounts)
    if m == 0:
        return 0.0
    sd = pstdev(abs_amounts)
    cv = sd / m
    # Map CV=0 → 1.0, CV=1.0 → 0.0; clamp.
    return max(0.0, 1.0 - cv)


def amounts_within_tolerance(amount_cents_list: list[int], tolerance: float) -> bool:
    if len(amount_cents_list) < 2:
        return True
    abs_amounts = [abs(a) for a in amount_cents_list]
    m = mean(abs_amounts)
    if m == 0:
        return False
    return all(abs(a - m) / m <= tolerance for a in abs_amounts)


def find_price_change_split(
    amount_cents_list: list[int],
    tolerance: float,
) -> tuple[int, int, int] | None:
    """Look for a single step change in the amount series.

    Returns ``(prior_mean_abs, recent_mean_abs, split_index)`` if there is
    exactly one clean split point ``k`` such that ``amounts[:k]`` and
    ``amounts[k:]`` are each internally stable within ``tolerance`` AND the
    two halves' means differ by more than ``PRICE_CHANGE_THRESHOLD`` AND
    more than ``tolerance``. Returns ``None`` if no clean split exists.

    Generalizes the previous "tail-outlier" pattern (``amounts[:-1]`` is
    stable, last charge is the new price) to also catch "head-outlier"
    cases like Netflix going Jan $9.99 → Feb-Apr $15.99 — there the change
    happened at index 1, and the old code rejected the cluster because it
    only ever tried dropping the LAST charge.

    A few edge cases this is careful about:
      * Both halves must be at least 1 long. We don't accept k=0 or k=n.
      * Multiple price changes in the same series (e.g. $9.99 → $15.99 →
        $19.99) yield no split where both halves are stable, so we return
        None and let the cluster fail tolerance — correct: ambiguous data.
      * Variable-amount bills (utilities) won't have any clean split since
        every month differs. They land in the loose-tolerance pass instead.
    """
    n = len(amount_cents_list)
    if n < 3:
        # Need at least 3 points: a stable run on each side plus a clean
        # split. With only 2 points we can't tell a price change from
        # initial noise.
        return None

    abs_amounts = [abs(a) for a in amount_cents_list]
    best: tuple[int, int, int] | None = None
    best_delta = 0.0

    for k in range(1, n):
        prior = abs_amounts[:k]
        recent = abs_amounts[k:]
        if not amounts_within_tolerance(prior, tolerance):
            continue
        if not amounts_within_tolerance(recent, tolerance):
            continue
        prior_mean = mean(prior)
        recent_mean = mean(recent)
        if prior_mean == 0:
            continue
        delta = abs(recent_mean - prior_mean) / prior_mean
        if delta < PRICE_CHANGE_THRESHOLD:
            continue
        if delta <= tolerance:
            # Wobble within the active tolerance — call it noise.
            continue
        # Prefer the split with the largest delta (most decisive change).
        if delta > best_delta:
            best_delta = delta
            best = (int(prior_mean), int(recent_mean), k)

    return best


def detect_price_change(
    amount_cents_list: list[int],
    posted_dates: list[date],
    tolerance: float,
) -> tuple[int | None, int | None, date | None]:
    """Detect a step change in the recurring amount.

    Returns ``(last_amount_signed, prior_amount_signed, change_date)`` if
    a clean split exists, else ``(None, None, None)``. Wraps
    ``find_price_change_split`` and converts the index-based result back
    into the (signed amount, signed amount, date) shape callers expect.

    ``last_amount_signed`` is the recent (post-change) price; ``prior``
    is the pre-change price; ``change_date`` is the date of the FIRST
    transaction at the new price (so users see "price went up on
    Feb 17", not "price went up on the most recent charge").
    """
    split = find_price_change_split(amount_cents_list, tolerance)
    if split is None:
        return (None, None, None)
    prior_mean, recent_mean, k = split
    sign = -1 if amount_cents_list[-1] < 0 else 1
    # k is the index of the FIRST transaction at the new price — that's
    # the date the change took effect from the user's perspective.
    return (sign * recent_mean, sign * prior_mean, posted_dates[k])


def status_from_recency(last_charge: date, cadence: int, today: date | None = None) -> SubscriptionStatus:
    today = today or date.today()
    days_since = (today - last_charge).days
    if days_since <= cadence * 1.5:
        return SubscriptionStatus.active
    if days_since <= cadence * 3:
        return SubscriptionStatus.suspected
    return SubscriptionStatus.cancelled


def confidence_from(
    n_occurrences: int,
    stability: float,
    cadence_agreement: float,
) -> float:
    """Roll up signals into a 0..1 confidence score.

    Heuristic: occurrences term saturates after ~6 charges (more is barely
    more confidence). Multiplied by stability and cadence agreement so any
    single weak signal drags confidence down.
    """
    occ_term = min(1.0, n_occurrences / 6)
    return round(occ_term * 0.4 + stability * 0.3 + cadence_agreement * 0.3, 3)


@dataclass
class DetectedSubscription:
    key: str
    name: str
    amount_cents: int               # mean of full series (signed)
    last_amount_cents: int          # most recent charge
    prior_amount_cents: int | None  # baseline if price changed, else None
    price_change_date: date | None
    cadence_days: int
    cadence_label: str
    n_occurrences: int
    first_date: date
    last_date: date
    next_expected_date: date
    status: SubscriptionStatus
    subscription_type: SubscriptionType
    confidence_score: float
    is_variable_amount: bool
    merchant_id: int | None
    category_id: int | None
    example_description: str


class SubscriptionDetector:
    def __init__(self, db: Session, today: date | None = None):
        self.db = db
        self.today = today or date.today()

    # ---- helpers ----

    def _excluded_category_ids(self) -> set[int]:
        rows = self.db.execute(
            select(Category.id).where(Category.slug.in_(NON_SUBSCRIPTION_CATEGORY_SLUGS))
        ).all()
        return {r[0] for r in rows}

    def _category_slug_lookup(self) -> dict[int, str]:
        rows = self.db.execute(select(Category.id, Category.slug)).all()
        return {r[0]: r[1] for r in rows}

    def _build_clusters(
        self,
    ) -> tuple[dict[str, list[Transaction]], dict[int, str]]:
        excluded = self._excluded_category_ids()
        stmt = select(Transaction).where(Transaction.amount_cents < 0)
        txns = self.db.execute(stmt).scalars().all()
        txns = [t for t in txns if t.category_id not in excluded]

        clusters: dict[str, list[Transaction]] = defaultdict(list)
        for t in txns:
            key = normalize_key(t.description_raw)
            if key:
                clusters[key].append(t)
        return clusters, self._category_slug_lookup()

    def _try_cluster(
        self,
        key: str,
        group: list[Transaction],
        tolerance: float,
        category_lookup: dict[int, str],
        require_monthly: bool = False,
    ) -> DetectedSubscription | None:
        if len(group) < MIN_OCCURRENCES:
            return None
        group.sort(key=lambda x: x.posted_date)

        # Pre-classify type from the longest description in the cluster so we
        # can apply the higher unknown-type minimum BEFORE running the
        # cadence/tolerance pipeline. (We re-classify on the canonical
        # last-row sample below for the final returned value — both reads
        # give the same answer in practice; this earlier read is the gate.)
        sample = max(group, key=lambda t: len(t.description_raw or ""))
        sample_cat_slug = (
            category_lookup.get(sample.category_id) if sample.category_id else None
        )
        sample_type = classify_type(sample.description_raw, sample_cat_slug).type
        if sample_type == "unknown" and len(group) < MIN_OCCURRENCES_UNKNOWN_TYPE:
            return None

        amounts = [t.amount_cents for t in group]
        dates = [t.posted_date for t in group]

        gaps = [
            (group[i + 1].posted_date - group[i].posted_date).days
            for i in range(len(group) - 1)
        ]
        classified = classify_cadence(gaps)
        if classified is None:
            return None
        cadence_days, cadence_label = classified
        if require_monthly and cadence_label not in VARIABLE_AMOUNT_CADENCES:
            return None

        # Amount tolerance check. If the full series fails, look for a
        # single price-change split — could be at the END (price just
        # bumped, last charge is new) OR earlier in history (Netflix
        # Jan $9.99 → Feb-Apr $15.99, change at index 1). Either way,
        # if there's a clean split where both halves are internally
        # stable, accept the cluster and let detect_price_change surface
        # the transition.
        if not amounts_within_tolerance(amounts, tolerance):
            if find_price_change_split(amounts, tolerance) is None:
                return None
            # Clean split exists — fall through to the rest of the pipeline.

        # Price-change detection (only meaningful when tolerance is strict;
        # variable-amount bills don't generate price-change alerts because
        # noise dominates the signal).
        if tolerance == STRICT_AMOUNT_TOLERANCE:
            last_amt, prior_amt, change_date = detect_price_change(amounts, dates, tolerance)
        else:
            last_amt, prior_amt, change_date = (None, None, None)

        # Type classification + variable-amount flag.
        last = group[-1]
        cat_slug = category_lookup.get(last.category_id) if last.category_id else None
        type_match = classify_type(last.description_raw, cat_slug)
        is_variable = (
            tolerance == LOOSE_AMOUNT_TOLERANCE
            or is_variable_amount_type(type_match.type)
        )

        # Display name = longest description in the cluster.
        display_name = max((t.description_raw for t in group), key=len)

        # Confidence math.
        # cadence agreement: % of gaps falling within the matched bucket window.
        for lo, hi, typical, label in CADENCE_BUCKETS:
            if label == cadence_label:
                cad_agree = cadence_agreement_score(gaps, lo, hi)
                break
        else:
            cad_agree = 0.0
        stability = amount_stability_score(amounts)
        confidence = confidence_from(len(group), stability, cad_agree)

        return DetectedSubscription(
            key=key,
            name=display_name,
            amount_cents=int(mean(amounts)),
            last_amount_cents=amounts[-1],
            prior_amount_cents=prior_amt,
            price_change_date=change_date,
            cadence_days=cadence_days,
            cadence_label=cadence_label,
            n_occurrences=len(group),
            first_date=dates[0],
            last_date=dates[-1],
            next_expected_date=dates[-1] + timedelta(days=cadence_days),
            status=status_from_recency(dates[-1], cadence_days, self.today),
            subscription_type=type_match.type,
            confidence_score=confidence,
            is_variable_amount=is_variable,
            merchant_id=last.merchant_id,
            category_id=last.category_id,
            example_description=last.description_raw,
        )

    def _make_aggregator_subscription(
        self,
        key: str,
        group: list[Transaction],
        category_lookup: dict[int, str],
    ) -> DetectedSubscription | None:
        """Build a composite-parent subscription, bypassing strict tolerance.

        For known aggregators (Apple App Store, Google Play, PayPal,
        Patreon, Amazon S&S) we don't care that amounts vary 5×+ — that's
        precisely what defines them as aggregators. The whole point of
        the row is to be a parent that receipt parsing or manual unmask
        can attach children to.

        Heuristics:
            - amount_cents = monthly footprint (sum of charges ÷ months
              covered). So "Apple bills you $40/mo on average" rather
              than "Apple bills you the median single-charge amount".
            - cadence_days = 30 (aggregators almost always settle into
              monthly billing when summed, even if individual charges
              are staggered across the month).
            - is_variable_amount = True (each row legitimately varies).
            - confidence_score = 0.7 (below precision-detected subs but
              above the 0.5 floor — surfaces but signals "I think").
            - subscription_type comes from classify_type on the sample,
              which will typically return "unknown" for raw Apple billing
              text. That's correct — the type lives on the children.
        """
        if len(group) < MIN_OCCURRENCES:
            return None
        group.sort(key=lambda x: x.posted_date)
        dates = [t.posted_date for t in group]
        amounts = [t.amount_cents for t in group]
        sample = max(group, key=lambda t: len(t.description_raw or ""))
        cat_slug = category_lookup.get(sample.category_id) if sample.category_id else None
        type_match = classify_type(sample.description_raw, cat_slug)

        # Per-month footprint: total / months covered. Use max(1, ...)
        # so a single-month cluster still produces a sane number.
        span_days = max(1, (dates[-1] - dates[0]).days)
        months = max(1.0, span_days / 30.0)
        monthly_footprint_cents = int(sum(amounts) / months)

        display_name = max((t.description_raw for t in group), key=len)
        last = group[-1]

        return DetectedSubscription(
            key=key,
            name=display_name,
            amount_cents=monthly_footprint_cents,
            last_amount_cents=amounts[-1],
            prior_amount_cents=None,
            price_change_date=None,
            cadence_days=30,
            cadence_label="monthly",
            n_occurrences=len(group),
            first_date=dates[0],
            last_date=dates[-1],
            next_expected_date=dates[-1] + timedelta(days=30),
            status=status_from_recency(dates[-1], 30, self.today),
            subscription_type=type_match.type,
            confidence_score=0.7,
            is_variable_amount=True,
            merchant_id=last.merchant_id,
            category_id=last.category_id,
            example_description=last.description_raw,
        )

    # ---- public ----

    def detect(self) -> list[DetectedSubscription]:
        clusters, category_lookup = self._build_clusters()
        found: list[DetectedSubscription] = []
        seen_keys: set[str] = set()

        # Pass 1 — strict tolerance. Catches streaming/SaaS/news/fitness etc.
        for key, group in clusters.items():
            d = self._try_cluster(key, group, STRICT_AMOUNT_TOLERANCE, category_lookup)
            if d is not None:
                found.append(d)
                seen_keys.add(key)

        # Pass 2 — loose tolerance, monthly-only, restricted to clusters whose
        # type maps to a variable-amount class. Skip anything pass 1 already
        # claimed.
        for key, group in clusters.items():
            if key in seen_keys:
                continue
            if len(group) < MIN_OCCURRENCES:
                continue
            # Pre-classify with a representative description so we can decide
            # whether pass 2 should even consider this cluster.
            sample = max(group, key=lambda t: len(t.description_raw or ""))
            cat_slug = category_lookup.get(sample.category_id) if sample.category_id else None
            type_match = classify_type(sample.description_raw, cat_slug)
            if not is_variable_amount_type(type_match.type):
                continue
            d = self._try_cluster(
                key,
                group,
                LOOSE_AMOUNT_TOLERANCE,
                category_lookup,
                require_monthly=True,
            )
            if d is not None:
                found.append(d)
                seen_keys.add(key)

        # Pass 3 — aggregator-aware (Wave F-1.5, expanded in Sprint 4).
        #
        # Apple App Store, Google Play, PayPal, Patreon, Amazon S&S bundle
        # multiple individual subscriptions into one bank-line merchant.
        # Pass 1 rejects them on amount tolerance (charges legitimately
        # range 5x or more because each underlying sub has a different
        # price), Pass 2 rejects them on subscription_type. Pass 3
        # historically also failed because _try_cluster still ran the
        # amount-tolerance check even with LOOSE_AMOUNT_TOLERANCE — a
        # 50% window isn't enough when iCloud at $0.99 sits next to
        # Apple One Premier at $32.95 in the same merchant key.
        #
        # Fix: for confirmed aggregators, BYPASS amount tolerance
        # entirely. We just need a placeholder parent row so receipts
        # (F-2 Apple, F-3 Google) and manual user unmasking can attach
        # children. The parent's reported amount is the per-month sum
        # (so the panel's "monthly recurring" headline includes the
        # whole aggregator footprint), and cadence_days defaults to 30
        # since aggregators bill monthly even when individual charges
        # are staggered.
        from .composite_detector import detect_aggregator
        for key, group in clusters.items():
            if key in seen_keys:
                continue
            if len(group) < MIN_OCCURRENCES:
                continue
            sample = max(group, key=lambda t: len(t.description_raw or ""))
            agg = detect_aggregator(sample.description_raw or key)
            if agg is None:
                continue
            d = self._make_aggregator_subscription(key, group, category_lookup)
            if d is not None:
                found.append(d)
                seen_keys.add(key)

        # Sort by absolute amount desc (biggest first — likely most interesting).
        found.sort(key=lambda x: abs(x.amount_cents), reverse=True)
        return found

    def sync_to_db(self) -> dict[str, int]:
        """Upsert detected subscriptions into the DB keyed by cluster key (name).

        Phase B updates:
        - Always sync ``last_amount_cents``, ``prior_amount_cents``,
          ``price_change_date``, ``confidence_score``, ``n_occurrences``,
          ``cadence_label``, ``is_variable_amount`` from the detector.
        - ``subscription_type`` is *only* set if the row's current type is
          ``unknown`` — preserves user overrides. Same idea for status:
          confirmed-active rows don't get auto-flipped back to suspected.
        - ``is_user_confirmed`` is never touched by the detector.
        """
        # Lazy-imported to avoid a circular dep — composite_detector
        # imports nothing project-specific, but keeping this import local
        # mirrors how the rest of the file handles cross-module helpers.
        from .composite_detector import detect_aggregator

        detected = self.detect()
        existing = {
            s.name: s
            for s in self.db.execute(select(Subscription)).scalars().all()
        }
        created = 0
        updated = 0
        composite_tagged = 0
        # Track rows we've created within this run so that two distinct
        # clusters resolving to the same usage-aggregator label (e.g.
        # "CLAUDE AI SUBSCRIPTI" and "ANTHROPIC ANTHROPIC COM" both
        # mapping to "Anthropic (Claude API)") merge into one row
        # instead of creating duplicates. Without this, the two
        # Anthropic merchant variants would each get their own row.
        run_index: dict[str, Subscription] = {}

        for d in detected:
            row = existing.get(d.key)
            # Sprint 8 — usage aggregators get renamed to the curated
            # label (see below), so on subsequent re-runs the cluster
            # key no longer matches the row's name. Fall back to a
            # lookup by aggregator label, checking both pre-existing
            # rows and rows we created earlier in this same run.
            if row is None:
                _peek_agg = detect_aggregator(d.key) or detect_aggregator(
                    d.example_description or ""
                )
                if _peek_agg is not None and _peek_agg.kind == "usage":
                    row = existing.get(_peek_agg.label) or run_index.get(
                        _peek_agg.label
                    )
            # Phase F: known-aggregator name → tag as composite parent.
            # User can manually toggle via the API later if our regex was
            # wrong (e.g. some random "patreon" merchant that isn't the
            # real Patreon billing).
            #
            # We check both the cluster key AND the raw example
            # description. The key is run through normalize_key() which
            # strips punctuation — so "APPLE.COM/BILL CA 04/24" becomes
            # "APPLE COM BILL CA" and never matches the
            # "apple.com/bill" aggregator pattern. The raw description
            # still has the dot/slash and matches cleanly.
            agg_match = detect_aggregator(d.key) or detect_aggregator(
                d.example_description or ""
            )
            # For usage-kind aggregators (Anthropic, OpenAI, AWS, …),
            # prefer the aggregator's curated label over the raw cluster
            # key. The cluster key for Anthropic might be either
            # "CLAUDE AI SUBSCRIPTI" or "ANTHROPIC ANTHROPIC COM"
            # depending on which description variant won the
            # longest-line tiebreak — neither is a good display name.
            # The label "Anthropic (Claude API)" is much cleaner. For
            # bundle-kind composites we keep the raw key so each
            # aggregator instance (your Apple vs your spouse's Apple
            # under a shared finances tracker) stays distinct.
            display_name = d.key
            if agg_match is not None and agg_match.kind == "usage":
                display_name = agg_match.label
            if row is None:
                row = Subscription(
                    name=display_name,
                    merchant_id=d.merchant_id,
                    amount_cents=d.amount_cents,
                    cadence_days=d.cadence_days,
                    next_expected_date=d.next_expected_date,
                    status=d.status,
                    subscription_type=d.subscription_type,
                    confidence_score=d.confidence_score,
                    is_user_confirmed=False,
                    last_amount_cents=d.last_amount_cents,
                    prior_amount_cents=d.prior_amount_cents,
                    price_change_date=d.price_change_date,
                    n_occurrences=d.n_occurrences,
                    cadence_label=d.cadence_label,
                    is_variable_amount=d.is_variable_amount,
                    is_composite=agg_match is not None,
                    notes=f"{d.cadence_label}; {d.n_occurrences}x; e.g. {d.example_description}",
                )
                self.db.add(row)
                created += 1
                if agg_match is not None:
                    composite_tagged += 1
                    if agg_match.kind == "usage":
                        # Index the just-created row by aggregator label
                        # so a second cluster mapping to the same label
                        # merges into this row instead of creating a
                        # second one.
                        run_index[agg_match.label] = row
            else:
                # Auto-flip to composite if the row matches an aggregator
                # AND isn't currently flagged. We never auto-flip back to
                # False — once a row's been declared a composite (by the
                # detector or the user), keep it that way; the user can
                # manually unflag via the API if needed.
                if agg_match is not None and not row.is_composite:
                    row.is_composite = True
                    composite_tagged += 1
                row.merchant_id = d.merchant_id
                # Sprint 8 — usage-aggregator merge: when two cluster
                # variants (e.g. "CLAUDE AI SUBSCRIPTI" and "ANTHROPIC
                # ANTHROPIC COM") both map to "Anthropic (Claude API)",
                # they share one row. If this is the SECOND+ cluster
                # we're folding into the row this run, accumulate
                # amounts and occurrence counts rather than overwriting
                # — otherwise the second variant clobbers the first.
                already_seen_this_run = (
                    agg_match is not None
                    and agg_match.kind == "usage"
                    and run_index.get(agg_match.label) is row
                )
                if already_seen_this_run:
                    # n_occurrences is accumulated later in this same
                    # block — keep this branch focused on amount_cents
                    # so we don't double-count the count.
                    row.amount_cents = (row.amount_cents or 0) + d.amount_cents
                else:
                    row.amount_cents = d.amount_cents
                if agg_match is not None and agg_match.kind == "usage":
                    # Mark this row as seen-in-run so the next matching
                    # cluster knows to accumulate instead of overwrite.
                    run_index[agg_match.label] = row
                row.cadence_days = d.cadence_days
                row.next_expected_date = d.next_expected_date
                row.last_amount_cents = d.last_amount_cents
                # Only overwrite prior_amount_cents/price_change_date if the
                # detector found a change in this run; otherwise preserve the
                # previously-recorded change so the UI keeps the alert until
                # the user dismisses it.
                if d.prior_amount_cents is not None:
                    row.prior_amount_cents = d.prior_amount_cents
                    row.price_change_date = d.price_change_date
                row.confidence_score = d.confidence_score
                if already_seen_this_run:
                    # Don't clobber the accumulated count from earlier
                    # variants in this same run.
                    row.n_occurrences = (
                        (row.n_occurrences or 0) + d.n_occurrences
                    )
                else:
                    row.n_occurrences = d.n_occurrences
                row.cadence_label = d.cadence_label
                row.is_variable_amount = d.is_variable_amount
                # Preserve user-set type; auto-fill only if still unknown.
                if row.subscription_type == SubscriptionType.unknown:
                    row.subscription_type = d.subscription_type
                # Only auto-update status for previously-suspected rows.
                if row.status == SubscriptionStatus.suspected:
                    row.status = d.status
                row.notes = f"{d.cadence_label}; {d.n_occurrences}x; e.g. {d.example_description}"
                updated += 1
        self.db.commit()
        return {
            "created": created,
            "updated": updated,
            "total": created + updated,
            "composite_tagged": composite_tagged,
        }
