"""Subscriptions API.

GET    /subscriptions               list all stored subscriptions (filterable)
GET    /subscriptions/detect        run the detector WITHOUT persisting — for preview
POST   /subscriptions/detect        run the detector AND upsert into DB
GET    /subscriptions/stats         monthly + annual totals broken down by type
GET    /subscriptions/price-changes rows where last_amount != prior_amount
POST   /subscriptions/{id}/confirm  user accepts: status=active, is_user_confirmed=true
POST   /subscriptions/{id}/dismiss  user rejects: status=dismissed
POST   /subscriptions/{id}/status   change status (legacy — kept for clients that use it)
POST   /subscriptions/{id}/type     manually set the SubscriptionType
POST   /subscriptions/apply-promos  scan recent T2-parsed emails, apply price-change signals
GET    /subscriptions/{id}/playbook generate a retention-negotiation script (Phase 5.2)
GET    /subscriptions/{id}/retention-attempts list past retention call outcomes
POST   /subscriptions/{id}/retention-attempts log a new retention call outcome
DELETE /subscriptions/{id}          delete one (false positive)
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from finance_app.db.models import (
    RetentionAttempt,
    RetentionChannel,
    RetentionOutcome,
    Subscription,
    SubscriptionStatus,
    SubscriptionType,
)
from finance_app.db.session import get_db
from finance_app.subscriptions.detector import SubscriptionDetector
from finance_app.subscriptions.promo_applier import (
    PromoApplyResult,
    apply_pending_signals,
)
from finance_app.subscriptions.composite_reconciler import (
    CompositeReconcileResult,
    reconcile_composite_receipts,
)
from finance_app.subscriptions.retention_playbook import build_playbook

router = APIRouter(tags=["subscriptions"])


# ---------------------------------------------------------------------
#  Pydantic shapes
# ---------------------------------------------------------------------


class SubscriptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    merchant_id: int | None
    amount_cents: int
    cadence_days: int
    next_expected_date: date | None
    status: SubscriptionStatus
    usage_score: float | None
    notes: str | None
    # Phase B fields
    subscription_type: SubscriptionType
    confidence_score: float | None
    is_user_confirmed: bool
    last_amount_cents: int | None
    prior_amount_cents: int | None
    price_change_date: date | None
    n_occurrences: int | None
    cadence_label: str | None
    is_variable_amount: bool
    # Phase F — composite-charge unmasking. ``is_composite`` flags
    # aggregator parents (Apple App Store, Google Play, etc.); children
    # have ``parent_subscription_id`` set to the parent row's id.
    is_composite: bool = False
    parent_subscription_id: int | None = None
    # Sprint 9 — derived field. For composite rows, surfaces the
    # aggregator's "kind" ("bundle" or "usage") so the frontend can
    # render bundle composites with an UNMASK badge but suppress it
    # for usage meters (Anthropic, OpenAI, etc.) where there's nothing
    # to declare. Computed server-side via composite_detector lookup;
    # None for non-composite rows.
    composite_kind: str | None = None


class CompositeChildIn(BaseModel):
    """User-declared line item inside a composite parent."""
    name: str
    amount_cents: int                          # signed; negative = outflow
    subscription_type: SubscriptionType = SubscriptionType.unknown
    notes: str | None = None


class CompositeUnmaskOut(BaseModel):
    """Snapshot of a composite parent + everything we know about its children."""
    parent: SubscriptionOut
    children: list[SubscriptionOut]
    aggregator_label: str | None               # e.g. "Apple App Store"
    hint_questions: list[str]                  # UX prompts for the unmask modal
    declared_total_cents: int                  # sum of children
    parent_total_cents: int                    # what the user actually paid
    unaccounted_cents: int                     # parent − declared (could be tax / new sub / forgotten line)


class DetectedSubscriptionOut(BaseModel):
    """What the detector returns in preview mode — not yet persisted."""
    key: str
    name: str
    amount_cents: int
    last_amount_cents: int
    prior_amount_cents: int | None
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
    example_description: str


class StatusUpdate(BaseModel):
    status: SubscriptionStatus


class TypeUpdate(BaseModel):
    subscription_type: SubscriptionType


class TypeBreakdown(BaseModel):
    """Per-type rollup for the stats endpoint."""
    subscription_type: SubscriptionType
    count: int
    monthly_cost_cents: int   # negative = outflow (matches transaction sign convention)
    annual_cost_cents: int


class SubscriptionStats(BaseModel):
    total_count: int
    confirmed_count: int
    needs_review_count: int   # status==suspected OR subscription_type==unknown
    monthly_cost_cents: int   # negative
    annual_cost_cents: int    # negative
    by_type: list[TypeBreakdown]
    price_change_count: int


class PromoApplyOut(BaseModel):
    scanned: int
    price_changes_applied: int
    promos_seen: int
    trials_ending: int
    unlinked: int
    notes: list[str]


# ---------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------


def _to_monthly_annual(amount_cents: int, cadence_days: int) -> tuple[int, int]:
    """Project a per-charge amount onto monthly + annual totals.

    Sign-preserving (negative outflows stay negative). For weekly/biweekly we
    spread evenly across the month; for monthly we pass through; for annual
    we divide.
    """
    if cadence_days <= 0:
        cadence_days = 30
    monthly = int(round(amount_cents * 30 / cadence_days))
    annual = int(round(amount_cents * 365 / cadence_days))
    return monthly, annual


def _has_price_change(sub: Subscription) -> bool:
    return (
        sub.prior_amount_cents is not None
        and sub.last_amount_cents is not None
        and sub.prior_amount_cents != sub.last_amount_cents
    )


# ---------------------------------------------------------------------
#  Routes
# ---------------------------------------------------------------------


def _to_out(sub: Subscription) -> SubscriptionOut:
    """Convert a Subscription row to SubscriptionOut with composite_kind
    populated. Called from every endpoint that returns SubscriptionOut
    so the frontend gets the bundle-vs-usage distinction without an
    extra roundtrip.
    """
    from finance_app.subscriptions.composite_detector import (
        detect_aggregator as _detect_agg,
    )

    kind: str | None = None
    if sub.is_composite:
        agg = _detect_agg(sub.name) or _detect_agg(sub.notes or "")
        kind = agg.kind if agg else None
    out = SubscriptionOut.model_validate(sub)
    out.composite_kind = kind
    return out


@router.get("/subscriptions", response_model=list[SubscriptionOut])
def list_subscriptions(
    status: SubscriptionStatus | None = None,
    subscription_type: SubscriptionType | None = None,
    confirmed_only: bool = False,
    include_children: bool = False,
    db: Session = Depends(get_db),
) -> list[SubscriptionOut]:
    stmt = select(Subscription).order_by(Subscription.amount_cents)  # most negative first
    if status is not None:
        stmt = stmt.where(Subscription.status == status)
    if subscription_type is not None:
        stmt = stmt.where(Subscription.subscription_type == subscription_type)
    if confirmed_only:
        stmt = stmt.where(Subscription.is_user_confirmed.is_(True))
    if not include_children:
        # Phase F: by default the main list shows only top-level rows.
        # Children of composites are visible inside the unmask modal
        # (GET /subscriptions/{id}/unmask) and to the bundle detector,
        # but excluding them here prevents double-counting in the total
        # and keeps the table compact.
        stmt = stmt.where(Subscription.parent_subscription_id.is_(None))
    return [_to_out(s) for s in db.execute(stmt).scalars().all()]


class SubscriptionCreate(BaseModel):
    """Body for POST /subscriptions — manually add a known subscription.

    The detector only auto-creates a subscription once it sees 2+ charges
    at a stable cadence. A subscription the user already knows about but
    that has billed only once (e.g. HealthTrackRx) needs this manual path.
    """
    name: str = Field(min_length=1, max_length=160)
    # Per-charge amount in cents. Sign is normalised to a negative outflow
    # server-side, so the caller may send 2500 or -2500.
    amount_cents: int
    cadence_days: int = Field(30, ge=1, le=400)
    subscription_type: SubscriptionType = SubscriptionType.unknown
    notes: str | None = None


@router.post("/subscriptions", response_model=SubscriptionOut, status_code=201)
def create_subscription(
    body: SubscriptionCreate,
    db: Session = Depends(get_db),
) -> SubscriptionOut:
    """Manually create a subscription.

    A manually-added subscription is ``active`` + ``is_user_confirmed``
    immediately — the user explicitly told us it exists, so the surplus
    and cash-flow engines should count it right away. There is no
    ``suspected`` triage step; that state only makes sense for detector
    guesses, not for something the user typed in by hand.
    """
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Subscription name cannot be blank")

    amount = -abs(body.amount_cents)  # stored as a negative outflow
    cd = body.cadence_days
    if cd <= 8:
        cadence_label = "weekly"
    elif cd >= 360:
        cadence_label = "annual"
    elif 26 <= cd <= 32:
        cadence_label = "monthly"
    else:
        cadence_label = None

    sub = Subscription(
        name=name,
        amount_cents=amount,
        last_amount_cents=amount,
        cadence_days=cd,
        cadence_label=cadence_label,
        next_expected_date=date.today() + timedelta(days=cd),
        status=SubscriptionStatus.active,
        is_user_confirmed=True,
        subscription_type=body.subscription_type,
        notes=body.notes or "Manually added.",
    )
    db.add(sub)
    db.commit()
    db.refresh(sub)
    return _to_out(sub)


@router.get("/subscriptions/detect", response_model=list[DetectedSubscriptionOut])
def preview_detect(db: Session = Depends(get_db)) -> list[DetectedSubscriptionOut]:
    """Preview what the detector would find, without writing anything."""
    detected = SubscriptionDetector(db).detect()
    return [
        DetectedSubscriptionOut(
            key=d.key,
            name=d.name,
            amount_cents=d.amount_cents,
            last_amount_cents=d.last_amount_cents,
            prior_amount_cents=d.prior_amount_cents,
            price_change_date=d.price_change_date,
            cadence_days=d.cadence_days,
            cadence_label=d.cadence_label,
            n_occurrences=d.n_occurrences,
            first_date=d.first_date,
            last_date=d.last_date,
            next_expected_date=d.next_expected_date,
            status=d.status,
            subscription_type=d.subscription_type,
            confidence_score=d.confidence_score,
            is_variable_amount=d.is_variable_amount,
            example_description=d.example_description,
        )
        for d in detected
    ]


@router.post("/subscriptions/detect")
def run_detect(db: Session = Depends(get_db)) -> dict[str, int]:
    """Run detection and upsert results into the DB."""
    return SubscriptionDetector(db).sync_to_db()


@router.get("/subscriptions/stats", response_model=SubscriptionStats)
def get_stats(
    confirmed_only: bool = False,
    db: Session = Depends(get_db),
) -> SubscriptionStats:
    """Aggregate cost rollup. By default counts ALL non-dismissed subs;
    pass ``confirmed_only=true`` to count only user-confirmed ones (the
    surplus engine should use confirmed_only).
    """
    stmt = select(Subscription).where(Subscription.status != SubscriptionStatus.dismissed)
    # Stats roll up *parent-level* spend only — children's amounts are
    # already inside the parent's bank charge, so summing both
    # double-counts the recurring total.
    stmt = stmt.where(Subscription.parent_subscription_id.is_(None))
    if confirmed_only:
        stmt = stmt.where(Subscription.is_user_confirmed.is_(True))
    rows = db.execute(stmt).scalars().all()

    total_count = len(rows)
    confirmed_count = sum(1 for r in rows if r.is_user_confirmed)
    needs_review_count = sum(
        1
        for r in rows
        if r.status == SubscriptionStatus.suspected
        or r.subscription_type == SubscriptionType.unknown
    )
    monthly_total = 0
    annual_total = 0
    type_buckets: dict[SubscriptionType, dict[str, int]] = {}
    for r in rows:
        m, a = _to_monthly_annual(r.amount_cents, r.cadence_days)
        monthly_total += m
        annual_total += a
        bucket = type_buckets.setdefault(
            r.subscription_type,
            {"count": 0, "monthly_cost_cents": 0, "annual_cost_cents": 0},
        )
        bucket["count"] += 1
        bucket["monthly_cost_cents"] += m
        bucket["annual_cost_cents"] += a

    breakdown = [
        TypeBreakdown(
            subscription_type=t,
            count=v["count"],
            monthly_cost_cents=v["monthly_cost_cents"],
            annual_cost_cents=v["annual_cost_cents"],
        )
        for t, v in sorted(type_buckets.items(), key=lambda kv: kv[1]["monthly_cost_cents"])
    ]
    return SubscriptionStats(
        total_count=total_count,
        confirmed_count=confirmed_count,
        needs_review_count=needs_review_count,
        monthly_cost_cents=monthly_total,
        annual_cost_cents=annual_total,
        by_type=breakdown,
        price_change_count=sum(1 for r in rows if _has_price_change(r)),
    )


# ---------------------------------------------------------------------
#  Active prompts (Phase F-6)
# ---------------------------------------------------------------------
#
# The Subscriptions panel shows ranked questions the engine wants the
# user to answer: "Is X a real subscription?", "What's bundled inside
# this Apple charge?". Each answer feeds back into detection — confirmed
# rows count toward surplus math, unmasked composites populate bundle
# overlap detection, dismissals stop the prompt from re-appearing.
#
# Two prompt kinds in v1:
#   * confirm_sub      → suspected sub with confidence ≥ 0.75 awaiting user OK
#   * unmask_composite → composite parent (Apple/Google/etc.) with zero children
#
# No new persistence layer — the answer maps to existing endpoints
# (confirm/dismiss/unmask), and once the underlying state changes the
# prompt simply no longer applies on the next refresh.


class PromptAction(BaseModel):
    label: str
    # Frontend dispatch keys. Stable strings so the Subscriptions panel
    # can map each action to a mutation without server-side state.
    kind: str  # "confirm_sub" | "dismiss_sub" | "open_unmask_modal" | "set_not_composite"


class SubscriptionPrompt(BaseModel):
    """One ranked question for the user. Stable `id` so React Query can
    cache and the frontend can remember dismissals across re-renders.

    `subscription_id` is null for ``discovered_subscription`` prompts —
    those propose CREATING a new row, so there's no row to point at yet.
    Sprint 16 added the discovery kind; the older two kinds always
    set subscription_id.
    """
    id: str
    kind: str  # "confirm_sub" | "unmask_composite" | "discovered_subscription"
    subscription_id: int | None = None
    title: str
    body: str
    primary: PromptAction
    secondary: PromptAction | None = None
    priority: float
    # Sprint 16 — discovered_subscription prompts ship the proposed
    # row's fields here so the accept action can create the
    # Subscription without a second roundtrip. None for other kinds.
    payload: dict | None = None


class SubscriptionPromptsOut(BaseModel):
    prompts: list[SubscriptionPrompt]
    total: int
    generated_at: datetime | None = None


_HIGH_CONFIDENCE_THRESHOLD = 0.75
_MAX_PROMPTS = 10


def _format_amount(cents: int) -> str:
    """Cents → "$12.34" (always positive — sign is implied by context)."""
    return f"${abs(cents) / 100:,.2f}"


def _build_confirm_prompt(s: Subscription) -> SubscriptionPrompt:
    amt = _format_amount(s.last_amount_cents or s.amount_cents)
    cadence = s.cadence_label or f"every {s.cadence_days}d"
    conf_pct = int(round((s.confidence_score or 0) * 100))
    return SubscriptionPrompt(
        id=f"confirm-sub-{s.id}",
        kind="confirm_sub",
        subscription_id=s.id,
        title=f"Is {s.name} an active subscription?",
        body=(
            f"Detected {amt} {cadence} (confidence {conf_pct}%). "
            "Confirming it factors into your surplus + cash-flow math."
        ),
        primary=PromptAction(label="Yes, confirm", kind="confirm_sub"),
        secondary=PromptAction(label="No, dismiss", kind="dismiss_sub"),
        # Higher confidence + larger amount = higher priority. Cap conf
        # contribution at 1.0 so it doesn't dominate.
        priority=(s.confidence_score or 0) * 100
        + abs(s.last_amount_cents or s.amount_cents) / 100,
    )


def _build_unmask_prompt(s: Subscription) -> SubscriptionPrompt:
    # For composites, `amount_cents` is the monthly footprint (sum of
    # all aggregator charges ÷ months). That's the meaningful number
    # for the user — "Apple is taking $79.59 from you every month" is
    # what motivates the unmask click. `last_amount_cents` is just the
    # most recent single charge (e.g. one $10.99 iCloud line), which
    # understates the parent's true bundled footprint.
    amt = _format_amount(s.amount_cents or s.last_amount_cents or 0)
    cadence = s.cadence_label or f"every {s.cadence_days}d"
    return SubscriptionPrompt(
        id=f"unmask-sub-{s.id}",
        kind="unmask_composite",
        subscription_id=s.id,
        title=f"What's bundled inside {s.name}?",
        body=(
            f"This looks like an aggregator charge — {amt} {cadence}. "
            "Tell me which subscriptions are inside (e.g. iCloud, "
            "Peacock) so bundle detection can find duplicates you're "
            "paying for elsewhere."
        ),
        primary=PromptAction(label="Unmask", kind="open_unmask_modal"),
        secondary=PromptAction(label="Not a bundle", kind="set_not_composite"),
        # Composite unmask is high value (each child unlocks bundle
        # detection) so it always beats confirm prompts at equal $.
        priority=500.0 + abs(s.last_amount_cents or s.amount_cents) / 100,
    )


# ---------------------------------------------------------------------
#  Service-catalog freshness (Sprint 10)
# ---------------------------------------------------------------------
#
# The catalog of known subscription prices needs periodic verification
# — consumer prices drift (Peacock jumped from $7.99 to $10.99 in 2024
# and we didn't notice for months, which caused the unmask suggester
# to confidently propose the wrong service for a $10.99 Apple charge).
# This endpoint exposes the catalog's age so the UI can warn when
# suggestions might be stale, and so future automation has a hook to
# trigger a refresh.


class CatalogInfoOut(BaseModel):
    verified_at: date
    age_days: int
    stale_after_days: int
    is_stale: bool
    entry_count: int
    # Count of entries with their own `last_verified` override that's
    # *newer* than the module-level CATALOG_VERIFIED_AT. Surfaces how
    # much of the catalog has been individually patched mid-cycle.
    individually_refreshed_count: int


@router.get("/subscriptions/catalog/info", response_model=CatalogInfoOut)
def catalog_info() -> CatalogInfoOut:
    """Return service-catalog age + freshness flag.

    UI surfaces this in the Subscriptions panel header — "Catalog
    verified X days ago" — and flags stale (>120 days) catalogs so
    users know the suggester's price-matching may be off.
    """
    from finance_app.subscriptions.service_catalog import (
        CATALOG_STALE_AFTER_DAYS,
        CATALOG_VERIFIED_AT,
        all_entries,
        catalog_age_days,
        is_catalog_stale,
    )
    entries = all_entries()
    individually_refreshed = sum(
        1 for e in entries
        if e.last_verified is not None and e.last_verified > CATALOG_VERIFIED_AT
    )
    return CatalogInfoOut(
        verified_at=CATALOG_VERIFIED_AT,
        age_days=catalog_age_days(),
        stale_after_days=CATALOG_STALE_AFTER_DAYS,
        is_stale=is_catalog_stale(),
        entry_count=len(entries),
        individually_refreshed_count=individually_refreshed,
    )


@router.get("/subscriptions/prompts", response_model=SubscriptionPromptsOut)
def list_prompts(db: Session = Depends(get_db)) -> SubscriptionPromptsOut:
    """Ranked list of questions the engine wants the user to answer.

    See module docstring for the two prompt kinds. The list excludes
    children of composite parents (they're not directly user-facing —
    the parent's unmask prompt covers them) and dismissed rows (the
    user already said no).
    """
    # Composite parents that have no children yet → unmask prompt
    composite_parents = list(
        db.execute(
            select(Subscription)
            .where(Subscription.is_composite.is_(True))
            .where(Subscription.parent_subscription_id.is_(None))
            .where(Subscription.status != SubscriptionStatus.dismissed)
        ).scalars().all()
    )

    # Cheap "has children?" check via a single group-by. Loading all
    # children up front beats N+1 individual count queries.
    child_counts: dict[int, int] = {}
    if composite_parents:
        rows = db.execute(
            select(
                Subscription.parent_subscription_id,
            ).where(
                Subscription.parent_subscription_id.in_(
                    [p.id for p in composite_parents]
                )
            )
        ).all()
        for (pid,) in rows:
            if pid is not None:
                child_counts[pid] = child_counts.get(pid, 0) + 1

    # High-confidence rows awaiting user OK → confirm prompt.
    #
    # Matches the frontend's "Needs review" tab semantics: not dismissed,
    # not yet user-confirmed, AND either still `suspected` by the
    # detector or auto-promoted to `active` but never classified
    # (subscription_type='unknown'). The auto-promoted case is the
    # common one — the detector often lands at high enough confidence
    # to set status=active immediately, but the row still needs the
    # user's eyeballs on "yes this is a real subscription" before it
    # factors into surplus math.
    #
    # Excludes children (parent_subscription_id IS NOT NULL) so we
    # don't ask about Peacock-as-Apple-line-item separately from its
    # composite parent.
    confirm_candidates = list(
        db.execute(
            select(Subscription)
            .where(Subscription.is_user_confirmed.is_(False))
            .where(Subscription.status != SubscriptionStatus.dismissed)
            .where(Subscription.parent_subscription_id.is_(None))
            .where(Subscription.confidence_score.is_not(None))
            .where(Subscription.confidence_score >= _HIGH_CONFIDENCE_THRESHOLD)
        ).scalars().all()
    )

    # Skip usage-meter composites — they don't have children to declare.
    # An Anthropic API charge is the meter itself; there's no "what's
    # inside" to unmask. Bundle composites (Apple App Store, etc.) keep
    # the prompt since the whole point is enumerating their contents.
    from finance_app.subscriptions.composite_detector import (
        detect_aggregator as _detect_agg,
    )

    prompts: list[SubscriptionPrompt] = []
    for parent in composite_parents:
        if child_counts.get(parent.id, 0) > 0:
            continue
        agg = _detect_agg(parent.name) or _detect_agg(parent.notes or "")
        if agg is not None and agg.kind == "usage":
            # Usage meters have no children to declare — suppress the
            # "what's bundled inside?" prompt. They still show up in
            # the main subscriptions list with their monthly footprint.
            continue
        prompts.append(_build_unmask_prompt(parent))
    for s in confirm_candidates:
        prompts.append(_build_confirm_prompt(s))

    # Sprint 16 — surface LLM-discovered subscriptions from Gmail.
    # Pulls EmailMessage rows whose `extra.discovery` field was
    # populated by the gmail_discovery module AND whose user_decision
    # is still null (not yet accepted/rejected). One prompt per
    # discovery; user clicks accept → we create the Subscription.
    from finance_app.db.models import EmailMessage as _Em
    discovery_rows = list(
        db.execute(
            select(_Em).where(_Em.extra.is_not(None))
        ).scalars().all()
    )
    for em in discovery_rows:
        extra = em.extra or {}
        discovery = extra.get("discovery")
        if not discovery or extra.get("user_decision"):
            continue
        if not discovery.get("is_subscription"):
            continue
        service = (discovery.get("service") or "").strip()
        if not service:
            continue
        monthly_cents = discovery.get("monthly_cents")
        conf = float(discovery.get("confidence") or 0.7)
        amt_str = (
            f" ~{_format_amount(monthly_cents)}/mo equivalent"
            if isinstance(monthly_cents, int) and monthly_cents > 0
            else ""
        )
        prompts.append(
            SubscriptionPrompt(
                id=f"discovery-{em.id}",
                kind="discovered_subscription",
                subscription_id=None,
                title=f"Looks like you have a {service} subscription — track it?",
                body=(
                    f"Found a Gmail signal from "
                    f"{em.from_domain} on "
                    f"{em.received_at.date().isoformat() if em.received_at else 'recently'}"
                    f"{amt_str}. "
                    f"{discovery.get('rationale', '')}"
                ).strip(),
                primary=PromptAction(label="Yes, add it", kind="accept_discovery"),
                secondary=PromptAction(label="No, not mine", kind="reject_discovery"),
                priority=200.0 + conf * 50.0,
                payload={
                    "email_id": em.id,
                    "service_name": service,
                    "monthly_cents": monthly_cents,
                    "cadence": discovery.get("cadence", "monthly"),
                    "rationale": discovery.get("rationale", ""),
                    "from_domain": em.from_domain,
                    "subject": em.subject,
                },
            )
        )

    # Sprint 23a — "needs price" prompts. The LLM-Gmail discovery flow
    # creates Subscription rows when the user accepts a discovery, but
    # the model can't always extract a price from a snippet ("Kaiser
    # has extended your Calm subscription" doesn't include $X). Those
    # rows land in the DB with amount_cents=0 and silently disappear
    # from the monthly-spend rollup. Surface them here so the user can
    # type the price and bring the row back to life.
    zero_price_subs = list(
        db.execute(
            select(Subscription)
            .where(Subscription.amount_cents == 0)
            .where(Subscription.status == SubscriptionStatus.active)
            .where(Subscription.parent_subscription_id.is_(None))
        ).scalars().all()
    )
    for s in zero_price_subs:
        prompts.append(
            SubscriptionPrompt(
                id=f"price-{s.id}",
                kind="needs_price",
                subscription_id=s.id,
                title=f"What does {s.name} cost per month?",
                body=(
                    "We tracked this from a Gmail signal but couldn't read a price "
                    "out of the email. Type the monthly amount and we'll fold it "
                    "into your subscription totals. Use 0 to leave it untracked, "
                    "or dismiss it if it isn't really a subscription."
                ),
                primary=PromptAction(label="Save price", kind="set_price"),
                secondary=PromptAction(label="Dismiss", kind="dismiss_sub"),
                # Below confirm-prompts (~240) and below discoveries (~245-250)
                # so they don't crowd out the more decisive prompts.
                priority=220.0,
                payload={
                    "subscription_id": s.id,
                    "subscription_name": s.name,
                    "current_amount_cents": s.amount_cents or 0,
                    "cadence_label": getattr(s, "cadence_label", None) or "monthly",
                },
            )
        )

    prompts.sort(key=lambda p: p.priority, reverse=True)
    capped = prompts[:_MAX_PROMPTS]
    return SubscriptionPromptsOut(
        prompts=capped,
        total=len(prompts),
        generated_at=datetime.utcnow(),
    )


# ---------------------------------------------------------------------
#  LLM-Gmail discovery endpoints (Sprint 16)
# ---------------------------------------------------------------------


class DiscoveryRunOut(BaseModel):
    """Result of triggering the LLM-Gmail scan."""
    scanned: int        # emails examined
    discovered: int     # new findings this run
    notes: list[str] = []


@router.post(
    "/subscriptions/discover-from-gmail",
    response_model=DiscoveryRunOut,
)
def discover_from_gmail(
    lookback_days: int = 180,
    max_calls: int = 50,
    db: Session = Depends(get_db),
) -> DiscoveryRunOut:
    """Run the LLM-Gmail discovery scan.

    Walks recent Gmail messages from known subscription-service
    domains, asks Ollama if each indicates an active subscription
    the user has, and stores findings on EmailMessage.extra. The
    next /subscriptions/prompts call will surface unresolved
    discoveries as actionable banner prompts.
    """
    from finance_app.subscriptions.gmail_discovery import (
        discover_subscriptions_from_gmail,
    )
    from finance_app.db.models import EmailMessage as _Em

    discoveries = discover_subscriptions_from_gmail(
        db, lookback_days=lookback_days, max_calls=max_calls
    )

    # Translate the dataclass list into EmailMessage.extra updates
    # so the prompts endpoint can read them on next fetch. We do this
    # write-through here (the discovery function already wrote
    # `discovered_at` + `discovery_raw`; we add the structured
    # `discovery` dict the prompts endpoint reads).
    notes: list[str] = []
    for d in discoveries:
        em = db.get(_Em, d.source_email_id)
        if em is None:
            continue
        new_extra = dict(em.extra or {})
        new_extra["discovery"] = {
            "is_subscription": True,
            "service": d.service_name,
            "monthly_cents": d.monthly_cents,
            "cadence": d.cadence_label,
            "confidence": d.confidence,
            "rationale": d.rationale,
        }
        em.extra = new_extra
    db.commit()

    return DiscoveryRunOut(
        scanned=len(discoveries),  # we only see the survivors here
        discovered=len(discoveries),
        notes=notes,
    )


class DiscoveryDecisionIn(BaseModel):
    accept: bool


@router.post(
    "/subscriptions/discoveries/{email_id}/decide",
    response_model=SubscriptionOut | None,
)
def decide_discovery(
    email_id: int,
    decision: DiscoveryDecisionIn,
    db: Session = Depends(get_db),
) -> SubscriptionOut | None:
    """Accept or reject a discovered subscription.

    Accept: creates a new Subscription row from the discovery payload,
            marks the email as accepted.
    Reject: marks the email as rejected — the prompt drops off
            future /subscriptions/prompts fetches.
    """
    from finance_app.db.models import EmailMessage as _Em

    em = db.get(_Em, email_id)
    if em is None:
        raise HTTPException(404, f"EmailMessage {email_id} not found")
    extra = em.extra or {}
    discovery = extra.get("discovery") or {}
    if not discovery:
        raise HTTPException(404, "No discovery recorded for this email")

    if not decision.accept:
        new_extra = dict(extra)
        new_extra["user_decision"] = "rejected"
        em.extra = new_extra
        db.commit()
        return None

    # Accept — create the Subscription row.
    cadence_to_days = {
        "monthly": 30, "annual": 365, "yearly": 365,
        "quarterly": 90, "weekly": 7,
    }
    cadence_label = discovery.get("cadence", "monthly")
    cadence_days = cadence_to_days.get(cadence_label, 30)
    monthly_cents = discovery.get("monthly_cents") or 0
    new_row = Subscription(
        name=discovery.get("service") or "Unknown service",
        amount_cents=-abs(monthly_cents) if monthly_cents else 0,
        cadence_days=cadence_days,
        cadence_label=cadence_label,
        status=SubscriptionStatus.active,
        subscription_type=SubscriptionType.unknown,
        is_user_confirmed=True,
        last_amount_cents=-abs(monthly_cents) if monthly_cents else None,
        confidence_score=float(discovery.get("confidence", 0.85)),
        notes=(
            f"Discovered from Gmail email #{email_id} ({em.from_domain}). "
            f"{discovery.get('rationale', '')}"
        )[:500],
    )
    db.add(new_row)
    new_extra = dict(extra)
    new_extra["user_decision"] = "accepted"
    em.extra = new_extra
    db.commit()
    db.refresh(new_row)
    return _to_out(new_row)


# ---------------------------------------------------------------------
#  Unmask suggestions (Sprint 5)
# ---------------------------------------------------------------------
#
# Given a composite parent (Apple bundle, Google Play, etc.), return
# ranked guesses for what's inside. Cross-references:
#   1. Unique charge amounts on the parent → service_catalog
#   2. Gmail messages from known service domains → "user uses this"
#   3. Apple/Google receipts (if parsed) → exact line-item match
#
# Each suggestion is a clickable chip in the UnmaskModal — one click
# pre-fills the manual-add form so the user doesn't have to type the
# name or remember the price. The hard work of matching prices and
# scanning email signals all happens server-side.


class UnmaskSuggestionEvidence(BaseModel):
    """One supporting Gmail email that backs a suggestion."""
    subject: str | None
    snippet: str | None
    received_at: datetime
    from_domain: str
    label: str  # "welcome" | "renewal" | "active" | ...


class UnmaskSuggestion(BaseModel):
    """One ranked guess for what's inside a composite parent."""
    id: str  # stable for React keying, e.g. "apple-music-1099"
    name: str  # display name, e.g. "Apple Music (Individual)"
    amount_cents: int  # negative — matches Subscription sign convention
    confidence: float  # 0..1 — how confident we are in this guess
    reason: str  # short hint, e.g. "Price match + Gmail signal"
    notes: str | None = None
    # Sprint 6 — strongest content-signal email backing this guess.
    # When present, it's near-proof the user actually has this service
    # (e.g. a "Welcome to Apple TV+" or "Your Disney+ subscription is
    # active" email). The frontend renders this inline on the chip.
    evidence: UnmaskSuggestionEvidence | None = None


class UnmaskSuggestionsOut(BaseModel):
    suggestions: list[UnmaskSuggestion]
    generated_at: datetime | None = None


def _gmail_signal_domains(db: Session, lookback_days: int = 365) -> set[str]:
    """Set of from-domains the user has received email from recently.

    Used to boost catalog suggestions when the user actually has
    correspondence with that service. Cached as a single set so the
    suggester can check membership in O(1) regardless of catalog size.
    """
    from finance_app.db.models import EmailMessage as _Em
    from datetime import timedelta

    cutoff = datetime.utcnow() - timedelta(days=lookback_days)
    rows = db.execute(
        select(_Em.from_domain)
        .where(_Em.received_at >= cutoff)
        .where(_Em.from_domain.is_not(None))
    ).scalars().all()
    return {(d or "").lower() for d in rows if d}


@router.get(
    "/subscriptions/{sub_id}/unmask-suggestions",
    response_model=UnmaskSuggestionsOut,
)
def unmask_suggestions(
    sub_id: int, db: Session = Depends(get_db)
) -> UnmaskSuggestionsOut:
    """Ranked guesses for what's inside a composite parent's charges.

    Walks the underlying transactions to find unique charge amounts,
    matches each against ``service_catalog`` entries plausibly billed
    by the parent's aggregator, then boosts matches that have Gmail
    signal (user has received email from that service's domain).

    Returns up to ~12 suggestions, ranked by confidence.
    """
    from finance_app.db.models import Transaction as _Tx
    from finance_app.subscriptions.composite_detector import detect_aggregator
    from finance_app.subscriptions.gmail_content_signals import (
        scan_for_content_signals,
    )
    from finance_app.subscriptions.service_catalog import (
        entries_matching_price,
    )

    parent = db.get(Subscription, sub_id)
    if not parent:
        raise HTTPException(404, f"Subscription {sub_id} not found")
    if not parent.is_composite:
        raise HTTPException(
            400,
            "Subscription is not flagged as composite — no aggregator "
            "context for the suggester. Flip is_composite first if you "
            "expect this to be an aggregator.",
        )

    # Resolve which aggregator this parent represents (drives catalog
    # filtering — only suggest entries plausibly billed by Apple if the
    # parent IS Apple, etc.).
    agg_spec = detect_aggregator(parent.name) or detect_aggregator(
        # Fall back to the example description from notes when the
        # cluster key got stripped of punctuation.
        parent.notes or ""
    )
    aggregator_key = agg_spec.key if agg_spec else None

    # Pull unique amounts from the parent's underlying transactions.
    # We don't store a direct FK from Transaction → Subscription, so
    # we re-derive by matching merchant token + sign on the cluster.
    # Use the example description from notes (set by sync_to_db as
    # "monthly; 4x; e.g. APPLE.COM/BILL CA 04/24"). Extract everything
    # after "e.g. " up to the first numeric postfix.
    txns = db.execute(
        select(_Tx)
        .where(_Tx.amount_cents < 0)
        .where(_Tx.description_raw.like(f"%{parent.name.split()[0]}%"))
    ).scalars().all()
    # Filter more tightly: any of the aggregator's name patterns must
    # match the description. Avoids accidentally pulling in unrelated
    # rows that happen to share a prefix.
    if agg_spec:
        wanted_patterns = tuple(p.lower() for p in agg_spec.name_patterns)
        txns = [
            t for t in txns
            if any(p in (t.description_raw or "").lower() for p in wanted_patterns)
        ]
    # Get unique amounts (rounded to cents).
    unique_amounts: dict[int, int] = {}  # cents → occurrence count
    for t in txns:
        unique_amounts[t.amount_cents] = unique_amounts.get(t.amount_cents, 0) + 1

    gmail_domains = _gmail_signal_domains(db)

    # Sprint 6 — scan Gmail bodies/subjects for explicit signup,
    # welcome, renewal, active-account phrases mentioning each catalog
    # entry by name. Strong content signals ("Welcome to Apple TV+")
    # are near-proof and dramatically outrank price-match-only guesses.
    content_bundles = scan_for_content_signals(db)
    content_signals_by_name = {b.entry.name: b for b in content_bundles}

    suggestions: list[UnmaskSuggestion] = []
    seen_keys: set[str] = set()

    for amount_cents, occurrences in sorted(
        unique_amounts.items(), key=lambda p: p[1], reverse=True
    ):
        matches = entries_matching_price(
            amount_cents, aggregator_key=aggregator_key
        )
        for entry in matches:
            # Dedupe by (entry name, amount) — same service may match
            # multiple charge amounts but we only need one chip per
            # (service, plan) combo.
            key = f"{entry.name}@{abs(amount_cents)}"
            if key in seen_keys:
                continue
            seen_keys.add(key)

            # Confidence model:
            #   0.45 baseline for any catalog price match
            #   +0.25 if sender-domain signal (weak — promo emails too)
            #   +up to 0.45 if content signal (welcome/renewal/active
            #               phrase in subject/snippet — near-proof)
            #   +up to 0.10 for additional observed charges
            has_gmail_domain = any(d in gmail_domains for d in entry.email_domains)
            content_bundle = content_signals_by_name.get(entry.name)
            content_boost = content_bundle.total_boost if content_bundle else 0.0
            best_signal = (
                content_bundle.best_signal if content_bundle else None
            )

            confidence = 0.45
            if has_gmail_domain:
                confidence += 0.25
            confidence += content_boost
            confidence += min(0.10, 0.05 * (occurrences - 1))
            confidence = min(0.99, confidence)

            reason_bits = [f"Price match (${abs(amount_cents) / 100:.2f})"]
            if best_signal:
                # Lead the reason with the strongest content signal —
                # it's the most actionable evidence the user can verify.
                phrase_map = {
                    "welcome": "Welcome email found",
                    "signup": "Signup confirmation found",
                    "active": "Account-active email found",
                    "confirmation": "Subscription-confirmed email",
                    "renewal": "Renewal email found",
                    "payment": "Payment receipt found",
                    "receipt": "Receipt found",
                    "subscription_mention": "Subscription mentioned in email",
                    "account_mention": "Account email found",
                }
                phrase = phrase_map.get(best_signal.label, "Email signal found")
                reason_bits.insert(0, phrase)
            elif has_gmail_domain:
                signal_domain = next(
                    (d for d in entry.email_domains if d in gmail_domains),
                    None,
                )
                if signal_domain:
                    reason_bits.append(f"Sender signal from {signal_domain}")
            if occurrences > 1:
                reason_bits.append(f"{occurrences} charges in window")

            evidence = None
            if best_signal:
                evidence = UnmaskSuggestionEvidence(
                    subject=best_signal.subject,
                    snippet=best_signal.snippet,
                    received_at=best_signal.received_at,
                    from_domain=best_signal.from_domain,
                    label=best_signal.label,
                )

            suggestions.append(
                UnmaskSuggestion(
                    id=f"{entry.name.lower().replace(' ', '-')}-{abs(amount_cents)}",
                    name=entry.name,
                    amount_cents=-abs(amount_cents),  # outflow sign
                    confidence=round(confidence, 2),
                    reason=" · ".join(reason_bits),
                    notes=entry.notes or None,
                    evidence=evidence,
                )
            )

    suggestions.sort(key=lambda s: s.confidence, reverse=True)
    # Cap at ~12 — enough to cover most realistic Apple bundles
    # (Music + TV+ + iCloud + Netflix + Hulu + Disney+ + ESPN+ + ...)
    # without overwhelming the modal.
    capped = suggestions[:12]
    return UnmaskSuggestionsOut(
        suggestions=capped, generated_at=datetime.utcnow()
    )


@router.get("/subscriptions/price-changes", response_model=list[SubscriptionOut])
def list_price_changes(db: Session = Depends(get_db)) -> list[Subscription]:
    """Subscriptions whose last observed amount differs from the prior baseline.

    Order: most recent change first.
    """
    stmt = (
        select(Subscription)
        .where(Subscription.prior_amount_cents.is_not(None))
        .where(Subscription.last_amount_cents.is_not(None))
        .where(Subscription.prior_amount_cents != Subscription.last_amount_cents)
        .order_by(Subscription.price_change_date.desc().nulls_last())
    )
    return db.execute(stmt).scalars().all()


# ---------------------------------------------------------------------
# /subscriptions/trends — Sprint 22
# Surfaces the MoM growth alerts computed by Sprint 11's trend detector.
# Notifications are already emitted into the notifications table by
# notify_signals — this endpoint runs the detector live so the UI sees
# fresh numbers even between job runs. Cheap (~5 SQL queries per active
# subscription, <100ms on a typical DB).
# ---------------------------------------------------------------------


class TrendAlertOut(BaseModel):
    subscription_id: int
    subscription_name: str
    growth_ratio: float
    growth_pct: float
    recent_avg_cents: int
    baseline_avg_cents: int
    months_observed: int
    headline: str


class TrendAlertsResponse(BaseModel):
    alerts: list[TrendAlertOut]
    # Sprint 24 — informational fastest-growing subs even when no alert
    # passes the 20% / 6-month threshold. Frontend shows these in a
    # calmer "preview" mode when alerts is empty.
    top_movers: list[TrendAlertOut] = Field(default_factory=list)
    total_monthly_delta_cents: int     # sum of (recent - baseline) across alerts
    generated_at: str


def _to_trend_out(a) -> TrendAlertOut:
    """Map a TrendAlert dataclass to its TrendAlertOut wire shape."""
    return TrendAlertOut(
        subscription_id=a.subscription_id,
        subscription_name=a.subscription_name,
        growth_ratio=round(a.growth_ratio, 3),
        growth_pct=round(a.growth_pct, 1),
        recent_avg_cents=a.recent_avg_cents,
        baseline_avg_cents=a.baseline_avg_cents,
        months_observed=a.months_observed,
        headline=a.headline(),
    )


@router.get("/subscriptions/trends", response_model=TrendAlertsResponse)
def subscription_trends(db: Session = Depends(get_db)) -> TrendAlertsResponse:
    """Subscriptions whose recent 3-month average is materially above
    their trailing-12-month baseline. Used by the Subscriptions panel
    to surface usage-creep on metered services (Anthropic, OpenAI,
    AWS) and bundle composites that quietly grow.

    Always returns a ``top_movers`` list as well — the N fastest
    growers regardless of threshold, so the panel can show a calmer
    "here's what's trending up" surface when no real alerts fire
    (e.g. on accounts without 6+ months of subscription history).
    """
    from finance_app.subscriptions.trend_detector import (
        detect_trends, top_movers,
    )
    from datetime import datetime

    alerts_raw = detect_trends(db)
    movers_raw = top_movers(db, limit=3)
    # If a sub appears in alerts AND top_movers, omit from top_movers
    # (no point showing the same row twice in two different banners).
    alert_ids = {a.subscription_id for a in alerts_raw}
    movers_filtered = [m for m in movers_raw if m.subscription_id not in alert_ids]

    total_delta = 0
    alerts_out: list[TrendAlertOut] = []
    for a in alerts_raw:
        delta = a.recent_avg_cents - a.baseline_avg_cents
        total_delta += max(delta, 0)
        alerts_out.append(_to_trend_out(a))

    return TrendAlertsResponse(
        alerts=alerts_out,
        top_movers=[_to_trend_out(m) for m in movers_filtered],
        total_monthly_delta_cents=total_delta,
        generated_at=datetime.utcnow().isoformat(),
    )


class SetPriceIn(BaseModel):
    monthly_cents: int = Field(..., ge=0, le=10_000_00)  # cap at $10k/mo
    cadence_label: str | None = None      # "monthly" | "annual" | "weekly" | ...


@router.post("/subscriptions/{sub_id}/price", response_model=SubscriptionOut)
def set_subscription_price(
    sub_id: int,
    payload: SetPriceIn,
    db: Session = Depends(get_db),
) -> Subscription:
    """Set or update the monthly price for a subscription.

    Used by the needs-price prompt flow (Sprint 23a) to fix up rows
    that the LLM-Gmail discovery couldn't extract a price for. Stores
    a negative amount (project sign convention: outflow = negative).
    Also updates last_amount_cents so the stats endpoint reflects the
    user-supplied number on the next refresh.

    Idempotent — calling twice with the same price is a no-op (besides
    the trailing updated_at refresh that happens via the row write).
    """
    sub = db.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(404, f"Subscription {sub_id} not found")
    cents = abs(int(payload.monthly_cents))
    sub.amount_cents = -cents
    sub.last_amount_cents = -cents
    if payload.cadence_label:
        # Keep the human label + the days-cadence in sync. Falls back
        # to monthly for unknown labels rather than crashing.
        cadence_days = {
            "monthly": 30, "annual": 365, "yearly": 365,
            "quarterly": 90, "weekly": 7, "biweekly": 14,
        }.get(payload.cadence_label.lower(), 30)
        sub.cadence_days = cadence_days
        if hasattr(sub, "cadence_label"):
            sub.cadence_label = payload.cadence_label
    # Treat a price-update as user confirmation — the user clearly
    # knows about this row well enough to type a number in.
    sub.is_user_confirmed = True
    db.commit()
    db.refresh(sub)
    return sub


@router.post("/subscriptions/{sub_id}/confirm", response_model=SubscriptionOut)
def confirm_subscription(sub_id: int, db: Session = Depends(get_db)) -> Subscription:
    sub = db.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(404, f"Subscription {sub_id} not found")
    sub.is_user_confirmed = True
    if sub.status == SubscriptionStatus.suspected:
        sub.status = SubscriptionStatus.active
    db.commit()
    db.refresh(sub)
    return sub


@router.post("/subscriptions/{sub_id}/dismiss", response_model=SubscriptionOut)
def dismiss_subscription(sub_id: int, db: Session = Depends(get_db)) -> Subscription:
    sub = db.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(404, f"Subscription {sub_id} not found")
    sub.status = SubscriptionStatus.dismissed
    sub.is_user_confirmed = False
    db.commit()
    db.refresh(sub)
    return sub


@router.post("/subscriptions/{sub_id}/status", response_model=SubscriptionOut)
def update_status(
    sub_id: int, payload: StatusUpdate, db: Session = Depends(get_db)
) -> Subscription:
    sub = db.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(404, f"Subscription {sub_id} not found")
    sub.status = payload.status
    db.commit()
    db.refresh(sub)
    return sub


@router.post("/subscriptions/{sub_id}/type", response_model=SubscriptionOut)
def update_type(
    sub_id: int, payload: TypeUpdate, db: Session = Depends(get_db)
) -> Subscription:
    """Manually re-classify a subscription's type. Useful when the heuristic
    lands on ``unknown`` or when the user disagrees with auto-classification.
    """
    sub = db.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(404, f"Subscription {sub_id} not found")
    sub.subscription_type = payload.subscription_type
    db.commit()
    db.refresh(sub)
    return sub


@router.post("/subscriptions/apply-promos", response_model=PromoApplyOut)
def apply_promos(db: Session = Depends(get_db)) -> PromoApplyOut:
    """Scan recent T2-parsed Gmail messages and apply promo/price-change
    signals to matching subscriptions. Idempotent.
    """
    res: PromoApplyResult = apply_pending_signals(db)
    return PromoApplyOut(**res.as_dict())


class CompositeApplyOut(BaseModel):
    receipts_scanned: int
    children_created: int
    children_updated: int
    receipts_unlinked: int
    notes: list[str]


@router.post(
    "/subscriptions/apply-composite-receipts",
    response_model=CompositeApplyOut,
    tags=["composite"],
)
def apply_composite_receipts(db: Session = Depends(get_db)) -> CompositeApplyOut:
    """Walk recently-parsed Apple/Google receipt emails and create child
    Subscription rows for each declared line item.

    Idempotent — once a receipt has been applied, ``extra["composite_applied"] = True``
    on the EmailMessage prevents re-processing. Run this after each
    Gmail sync (or on demand from the UI's "Apply email signals" button).
    """
    res: CompositeReconcileResult = reconcile_composite_receipts(db)
    return CompositeApplyOut(**res.as_dict())


@router.delete("/subscriptions/{sub_id}", status_code=204)
def delete_subscription(sub_id: int, db: Session = Depends(get_db)) -> None:
    sub = db.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(404, f"Subscription {sub_id} not found")
    db.delete(sub)
    db.commit()


# ---------------------------------------------------------------------
#  Phase F — composite-charge unmasking
# ---------------------------------------------------------------------


@router.get(
    "/subscriptions/{sub_id}/unmask",
    response_model=CompositeUnmaskOut,
    tags=["composite"],
)
def unmask(sub_id: int, db: Session = Depends(get_db)) -> CompositeUnmaskOut:
    """Snapshot of a composite parent + its declared children.

    Backs the "Unmask" modal on the Subscriptions panel. Includes UX
    copy from the matched aggregator (hint questions, friendly label)
    so the modal can prompt the user with provider-aware language.
    """
    from finance_app.subscriptions.composite_detector import detect_aggregator

    parent = db.get(Subscription, sub_id)
    if not parent:
        raise HTTPException(404, f"Subscription {sub_id} not found")

    children_rows = list(
        db.execute(
            select(Subscription).where(Subscription.parent_subscription_id == sub_id)
        ).scalars().all()
    )

    declared = sum(abs(c.last_amount_cents or c.amount_cents or 0) for c in children_rows)
    # For composite parents, `amount_cents` is the monthly footprint
    # (sum of all aggregator charges ÷ months), which is what the user
    # is actually paying Apple/Google per month. `last_amount_cents` is
    # just the most recent single charge (e.g. one $10.99 iCloud line) —
    # using that would massively understate the bundle and make the
    # unaccounted gap look smaller than reality.
    if parent.is_composite:
        parent_total = abs(parent.amount_cents or parent.last_amount_cents or 0)
    else:
        parent_total = abs(parent.last_amount_cents or parent.amount_cents or 0)

    agg = detect_aggregator(parent.name)
    return CompositeUnmaskOut(
        parent=SubscriptionOut.model_validate(parent),
        children=[SubscriptionOut.model_validate(c) for c in children_rows],
        aggregator_label=agg.label if agg else None,
        hint_questions=list(agg.hint_questions) if agg else [],
        declared_total_cents=declared,
        parent_total_cents=parent_total,
        unaccounted_cents=parent_total - declared,
    )


@router.post(
    "/subscriptions/{sub_id}/children",
    response_model=SubscriptionOut,
    tags=["composite"],
)
def add_child(
    sub_id: int,
    payload: CompositeChildIn,
    db: Session = Depends(get_db),
) -> SubscriptionOut:
    """Declare a new line item inside a composite parent.

    Creates a Subscription row with ``parent_subscription_id=sub_id``
    inheriting the parent's cadence. The new row is auto-confirmed
    (``is_user_confirmed=True``) since the user is explicitly declaring
    it — no need to nudge them through the suspected → confirmed flow
    again.
    """
    parent = db.get(Subscription, sub_id)
    if not parent:
        raise HTTPException(404, f"Subscription {sub_id} not found")
    if not parent.is_composite:
        # Auto-flip on first child add — a row that never matched our
        # aggregator regex but the user has declared a child for is, by
        # definition, a composite from the user's POV.
        parent.is_composite = True

    # Children are stored as outflows (negative cents) regardless of
    # what the user typed. Coerce here so downstream sign math works.
    signed_amount = -abs(payload.amount_cents)

    child = Subscription(
        name=payload.name.strip()[:160],
        merchant_id=None,
        amount_cents=signed_amount,
        last_amount_cents=signed_amount,
        cadence_days=parent.cadence_days,
        cadence_label=parent.cadence_label,
        next_expected_date=parent.next_expected_date,
        status=SubscriptionStatus.active,
        subscription_type=payload.subscription_type,
        confidence_score=1.0,
        is_user_confirmed=True,
        is_variable_amount=False,
        is_composite=False,
        parent_subscription_id=parent.id,
        notes=(payload.notes or "").strip()[:600] or f"Declared inside {parent.name}",
    )
    db.add(child)
    db.commit()
    db.refresh(child)
    return SubscriptionOut.model_validate(child)


@router.post(
    "/subscriptions/{sub_id}/composite",
    response_model=SubscriptionOut,
    tags=["composite"],
)
def set_composite(
    sub_id: int,
    is_composite: bool,
    db: Session = Depends(get_db),
) -> SubscriptionOut:
    """Manually toggle the composite flag on a parent row.

    Useful when the auto-tagger guessed wrong (e.g. a one-off Patreon
    pledge the user knows isn't really an aggregator, or conversely a
    weird PayPal alias the regex missed).
    """
    sub = db.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(404, f"Subscription {sub_id} not found")
    sub.is_composite = is_composite
    db.commit()
    db.refresh(sub)
    return SubscriptionOut.model_validate(sub)


# ---------------------------------------------------------------------
#  Phase 5.2 — retention playbook + attempt log
# ---------------------------------------------------------------------


class RetentionPlaybookOut(BaseModel):
    """Generated negotiation script returned by GET /playbook."""
    subscription_id: int
    merchant: str
    current_monthly_cents: int
    opening_line: str
    leverage_points: list[str]
    counter_offers: list[str]
    walkaway_line: str
    estimated_success_pct: int
    estimated_savings_min_cents: int
    estimated_savings_max_cents: int
    notes: list[str]


class RetentionAttemptIn(BaseModel):
    """Outcome log input."""
    channel: RetentionChannel = RetentionChannel.phone
    outcome: RetentionOutcome
    opening_offer: str | None = None
    counter_asked: str | None = None
    monthly_savings_cents: int | None = None
    duration_months: int | None = None
    notes: str | None = None


class RetentionAttemptOut(BaseModel):
    """Outcome log output (one row per attempt)."""
    model_config = ConfigDict(from_attributes=True)

    id: int
    subscription_id: int
    contacted_at: datetime
    channel: RetentionChannel
    outcome: RetentionOutcome
    opening_offer: str | None
    counter_asked: str | None
    monthly_savings_cents: int | None
    duration_months: int | None
    notes: str | None
    created_at: datetime


@router.get(
    "/subscriptions/{sub_id}/playbook",
    response_model=RetentionPlaybookOut,
    tags=["retention"],
)
def get_playbook(sub_id: int, db: Session = Depends(get_db)) -> RetentionPlaybookOut:
    """Generate a retention-negotiation script for one subscription.

    Stateless — pure function of the Subscription row + per-type
    baselines. Doesn't persist anything; the user calls / chats / emails
    based on the output, then logs the outcome via POST below.
    """
    sub = db.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(404, f"Subscription {sub_id} not found")
    pb = build_playbook(sub)
    return RetentionPlaybookOut(
        subscription_id=pb.subscription_id,
        merchant=pb.merchant,
        current_monthly_cents=pb.current_monthly_cents,
        opening_line=pb.opening_line,
        leverage_points=pb.leverage_points,
        counter_offers=pb.counter_offers,
        walkaway_line=pb.walkaway_line,
        estimated_success_pct=pb.estimated_success_pct,
        estimated_savings_min_cents=pb.estimated_savings_min_cents,
        estimated_savings_max_cents=pb.estimated_savings_max_cents,
        notes=pb.notes,
    )


@router.get(
    "/subscriptions/{sub_id}/retention-attempts",
    response_model=list[RetentionAttemptOut],
    tags=["retention"],
)
def list_retention_attempts(
    sub_id: int, db: Session = Depends(get_db)
) -> list[RetentionAttempt]:
    """List every retention call/chat attempt for one subscription, newest first."""
    if not db.get(Subscription, sub_id):
        raise HTTPException(404, f"Subscription {sub_id} not found")
    return list(
        db.execute(
            select(RetentionAttempt)
            .where(RetentionAttempt.subscription_id == sub_id)
            .order_by(RetentionAttempt.contacted_at.desc())
        )
        .scalars()
        .all()
    )


@router.post(
    "/subscriptions/{sub_id}/retention-attempts",
    response_model=RetentionAttemptOut,
    status_code=201,
    tags=["retention"],
)
def log_retention_attempt(
    sub_id: int, body: RetentionAttemptIn, db: Session = Depends(get_db)
) -> RetentionAttempt:
    """Persist one retention-attempt outcome.

    The user has already had the call/chat — this just records what
    happened so the playbook gets smarter over time. If outcome is
    ``cancelled``, you may also want to call POST /subscriptions/{id}/dismiss
    in the same flow to mark the sub itself dismissed.
    """
    sub = db.get(Subscription, sub_id)
    if not sub:
        raise HTTPException(404, f"Subscription {sub_id} not found")
    attempt = RetentionAttempt(
        subscription_id=sub_id,
        channel=body.channel,
        outcome=body.outcome,
        opening_offer=body.opening_offer,
        counter_asked=body.counter_asked,
        monthly_savings_cents=body.monthly_savings_cents,
        duration_months=body.duration_months,
        notes=body.notes,
    )
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    return attempt
