"""Smoke test for Phase B — Subscription/bill intelligence.

Covers the parts of Phase B that have unit-testable seams without hitting
real Gmail or a real bank:

  [1] Type classifier accuracy (merchant patterns + category fallback +
      unknown).
  [2] Detector on streaming/SaaS clusters (strict 8% tolerance).
  [3] Detector on a variable-amount utility cluster (loose 50% tolerance,
      monthly cadence required).
  [4] Price-change detection — last-charge step relative to baseline.
  [5] Free-trial → paid — $0 first charge then full price reads as a price
      change (good enough until we split the signal in Phase C).
  [6] T2 ``subscription_promo`` Gmail parser — fires on price-change subject,
      extracts ``new_price_cents`` from the body.
  [7] ``apply_pending_signals`` — links a parsed promo email to a matching
      Subscription row and stamps prior/last/price_change_date idempotently.
  [8] Confirm / dismiss / set-type API transitions.
  [9] /subscriptions/stats — totals reconcile against the row data.

Runs against an isolated SQLite DB; safe to run repeatedly (the file is
deleted on entry).

Run::

    cd backend
    python scripts/smoke_phase_b.py
"""
from __future__ import annotations

import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Isolated DB. Override via SMOKE_DB_PATH for sandboxed runs.
TEST_DB_PATH = Path(
    os.environ.get("SMOKE_DB_PATH")
    or (Path(__file__).resolve().parent.parent / "smoke_phase_b.db")
)
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH}"
if TEST_DB_PATH.exists():
    TEST_DB_PATH.unlink()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from finance_app.api.main import app  # noqa: E402
from finance_app.db.models import (  # noqa: E402
    Account,
    AccountType,
    Base,
    Category,
    EmailMessage,
    IngestSource,
    Institution,
    InstitutionKind,
    ParserOutcome,
    Subscription,
    SubscriptionStatus,
    SubscriptionType,
    Transaction,
    TransactionStatus,
)
from finance_app.db.session import SessionLocal, engine  # noqa: E402
from finance_app.gmail.client import GmailMessage  # noqa: E402
from finance_app.gmail.parsers.subscription_promo import parse as parse_promo  # noqa: E402
from finance_app.subscriptions.detector import SubscriptionDetector  # noqa: E402
from finance_app.subscriptions.promo_applier import apply_pending_signals  # noqa: E402
from finance_app.subscriptions.type_classifier import classify_type  # noqa: E402


# ---------------------------------------------------------------------------
#  Helpers
# ---------------------------------------------------------------------------


# "Today" anchor for status-from-recency math. Matches the synthetic series
# anchors below so detector results are deterministic regardless of when the
# script runs.
SMOKE_TODAY = date(2026, 4, 25)


def _assert(cond: bool, msg: str) -> None:
    if not cond:
        print(f"  ✗ {msg}")
        raise SystemExit(1)


def _seed_skeleton() -> int:
    """Create a minimal Institution + Account + a few Categories.

    Returns the account id so the rest of the test can attach Transactions.
    """
    with SessionLocal() as db:
        inst = Institution(name="Smoke Bank", kind=InstitutionKind.bank)
        db.add(inst)
        db.flush()
        acct = Account(
            institution_id=inst.id,
            name="Checking",
            account_type=AccountType.checking,
            mask="0000",
        )
        db.add(acct)
        db.flush()

        # Categories the type classifier's category-fallback path expects.
        # We only need a couple for the tests below.
        cats = [
            Category(name="Streaming", slug="subscriptions.streaming", is_discretionary=True),
            Category(name="Utilities", slug="housing.utilities", is_discretionary=False),
            Category(name="Software",  slug="subscriptions.software",  is_discretionary=True),
        ]
        for c in cats:
            db.add(c)
        db.commit()
        return acct.id


def _add_series(
    db,
    *,
    account_id: int,
    description: str,
    amounts_cents: list[int],
    dates: list[date],
    tag: str,
) -> None:
    assert len(amounts_cents) == len(dates), "amounts/dates length mismatch"
    for i, (amt, d) in enumerate(zip(amounts_cents, dates)):
        db.add(
            Transaction(
                account_id=account_id,
                posted_date=d,
                amount_cents=amt,
                currency="USD",
                status=TransactionStatus.posted,
                description_raw=description,
                source=IngestSource.manual,
                external_id=f"phaseb-{tag}-{i}",
            )
        )


def _monthly_dates(anchor: date, n: int) -> list[date]:
    """N monthly anchor dates ending at `anchor` (most-recent last)."""
    return [anchor - timedelta(days=30 * (n - 1 - i)) for i in range(n)]


# ---------------------------------------------------------------------------
#  [1] Type classifier
# ---------------------------------------------------------------------------


def step_classifier() -> None:
    print("\n[1/9] Type classifier accuracy ...")
    cases: list[tuple[str, str | None, SubscriptionType, float]] = [
        # description, category_slug, expected_type, min_confidence
        ("NETFLIX.COM 866-579-7172",        None,                          SubscriptionType.streaming, 0.9),
        ("SPOTIFY USA NEW YORK NY",          None,                         SubscriptionType.streaming, 0.9),
        ("ADOBE *CREATIVE CLOUD",            None,                         SubscriptionType.saas,      0.85),
        ("OPENAI *CHATGPT",                  None,                         SubscriptionType.saas,      0.9),
        ("GITHUB INC",                       None,                         SubscriptionType.saas,      0.9),
        ("PG&E WEB ONLINE",                  None,                         SubscriptionType.utilities, 0.7),
        ("XFINITY COMCAST 800-266-2278",     None,                         SubscriptionType.internet,  0.7),
        ("PELOTON INTERACTIVE",              None,                         SubscriptionType.fitness,   0.7),
        ("RANDOM MERCHANT 12345",            "subscriptions.streaming",    SubscriptionType.streaming, 0.5),  # category fallback
        ("RANDOM MERCHANT 12345",            "housing.utilities",          SubscriptionType.utilities, 0.5),
        ("Some weird thing — no signal",     None,                         SubscriptionType.unknown,   0.0),
    ]
    for desc, slug, want_type, min_conf in cases:
        match = classify_type(desc, slug)
        _assert(
            match.type == want_type,
            f"classify_type({desc!r}, slug={slug!r}) → {match.type}, want {want_type}",
        )
        if want_type != SubscriptionType.unknown:
            _assert(
                match.confidence >= min_conf,
                f"classify_type({desc!r}) confidence {match.confidence} < {min_conf}",
            )
    print(f"  ✓ {len(cases)} cases passed")


# ---------------------------------------------------------------------------
#  [2] + [3] + [4] + [5] detector — seed data and check the persisted shapes
# ---------------------------------------------------------------------------


def step_detector(account_id: int) -> None:
    print("\n[2-5/9] Detector: streaming + utility + price-change + free-trial ...")

    # Anchor so the most recent charge is well within 1.5× cadence of SMOKE_TODAY.
    last = date(2026, 4, 10)

    # --- (a) Streaming: 5 months of $9.99 Netflix, dead-stable. Strict pass. ---
    netflix_amts = [-999, -999, -999, -999, -999]
    netflix_dates = _monthly_dates(last, 5)

    # --- (b) Streaming with price change: 4 months @ $9.99, last @ $14.99. ---
    adobe_amts = [-999, -999, -999, -999, -1499]
    adobe_dates = _monthly_dates(last, 5)

    # --- (c) Variable-amount utility: PG&E swinging $80–$140. Loose pass. ---
    pge_amts = [-8200, -10500, -9100, -13800, -11200]
    pge_dates = _monthly_dates(last, 5)

    # --- (d) Free-trial → paid: $0 first charge, then 4 full charges. The
    #         detector should still cluster these (cadence is consistent) and
    #         the last charge equals the baseline so this turns into a stable
    #         series — the price-change exits when the trial-to-paid bump
    #         lands as the FIRST → SECOND charge. We seed the first as $0 and
    #         leave the next 4 at full price; the baseline becomes the 4 paid
    #         charges + the $0 outlier, but our detector only flags a price
    #         change vs. the LAST charge. So instead, we structure this as 4
    #         paid charges with a $0 trial seed BEFORE them and check that:
    #           - the cluster is detected (gap classification doesn't reject
    #             it because of one off-amount, since the last 4 are stable)
    #           - the last_amount_cents reflects the steady-state paid price.
    trial_amts = [0, -1199, -1199, -1199, -1199]
    trial_dates = _monthly_dates(last, 5)

    # --- (e) MID-HISTORY price change: 1 charge at the OLD price, then 4
    #         charges at the new price (real Netflix pattern Jan→Feb 2024
    #         when they hiked from $9.99 to $15.99). Pre-2026-04-27 the
    #         detector rejected this because its only outlier-removal pass
    #         dropped the LAST charge — useless when the change happened
    #         at index 1, not the most recent month. After the
    #         find_price_change_split generalization both head- and
    #         tail-outlier patterns are caught.
    hbo_amts = [-999, -1599, -1599, -1599, -1599]
    hbo_dates = _monthly_dates(last, 5)

    with SessionLocal() as db:
        _add_series(
            db, account_id=account_id, description="NETFLIX.COM 866-579-7172",
            amounts_cents=netflix_amts, dates=netflix_dates, tag="netflix",
        )
        _add_series(
            db, account_id=account_id, description="ADOBE *CREATIVE CLOUD",
            amounts_cents=adobe_amts, dates=adobe_dates, tag="adobe",
        )
        _add_series(
            db, account_id=account_id, description="PG&E WEB ONLINE",
            amounts_cents=pge_amts, dates=pge_dates, tag="pge",
        )
        _add_series(
            db, account_id=account_id, description="DISNEY+ TRIAL TO PAID",
            amounts_cents=trial_amts, dates=trial_dates, tag="disney",
        )
        _add_series(
            db, account_id=account_id, description="HBO MAX",
            amounts_cents=hbo_amts, dates=hbo_dates, tag="hbo",
        )
        db.commit()

        # Run detector with a fixed "today" so status math is deterministic.
        result = SubscriptionDetector(db, today=SMOKE_TODAY).sync_to_db()
        print(f"  detector: {result}")
        rows = {s.name: s for s in db.query(Subscription).all()}

    # --- assertions ---
    # Netflix: stable, no price change, type=streaming, monthly.
    netflix = rows.get("NETFLIX COM")
    _assert(netflix is not None, f"NETFLIX COM not detected — got {list(rows)}")
    _assert(netflix.subscription_type == SubscriptionType.streaming,
            f"Netflix type={netflix.subscription_type}, want streaming")
    _assert(26 <= netflix.cadence_days <= 35,
            f"Netflix cadence={netflix.cadence_days}, want monthly")
    _assert(netflix.prior_amount_cents is None,
            f"Netflix should NOT have a price change; got prior={netflix.prior_amount_cents}")
    _assert(not netflix.is_variable_amount, "Netflix should not be flagged variable")
    _assert(netflix.confidence_score is not None and netflix.confidence_score >= 0.7,
            f"Netflix confidence too low: {netflix.confidence_score}")
    print(f"  ✓ Netflix: stable streaming, conf={netflix.confidence_score}")

    # Adobe: price-change last charge $9.99 → $14.99.
    adobe = rows.get("ADOBE CREATIVE CLOUD")
    _assert(adobe is not None, f"ADOBE CREATIVE CLOUD not detected — got {list(rows)}")
    _assert(adobe.subscription_type == SubscriptionType.saas,
            f"Adobe type={adobe.subscription_type}, want saas")
    _assert(adobe.prior_amount_cents is not None and adobe.last_amount_cents is not None,
            f"Adobe should have a price change: prior={adobe.prior_amount_cents}, last={adobe.last_amount_cents}")
    _assert(abs(adobe.prior_amount_cents) == 999,
            f"Adobe prior should be $9.99 (-999c), got {adobe.prior_amount_cents}")
    _assert(abs(adobe.last_amount_cents) == 1499,
            f"Adobe last should be $14.99 (-1499c), got {adobe.last_amount_cents}")
    _assert(adobe.price_change_date is not None,
            "Adobe price_change_date should be set")
    print(f"  ✓ Adobe: price change {adobe.prior_amount_cents}→{adobe.last_amount_cents} on {adobe.price_change_date}")

    # PG&E: detected via the loose pass; flagged variable.
    pge = rows.get("PG WEB ONLINE")  # normalize_key strips '&' as punctuation
    _assert(pge is not None, f"PG&E utility not detected — got {list(rows)}")
    _assert(pge.subscription_type == SubscriptionType.utilities,
            f"PG&E type={pge.subscription_type}, want utilities")
    _assert(pge.is_variable_amount, "PG&E should be flagged variable_amount")
    _assert(pge.prior_amount_cents is None and pge.last_amount_cents is not None,
            f"PG&E should NOT have a price-change alert (variable bill noise): prior={pge.prior_amount_cents}")
    _assert(26 <= pge.cadence_days <= 35,
            f"PG&E cadence={pge.cadence_days}, want monthly (loose pass requires monthly)")
    print(f"  ✓ PG&E: variable utility detected, no false price change")

    # Disney+ trial-to-paid: cluster present, last_amount = full price.
    disney = rows.get("DISNEY TRIAL TO")
    _assert(disney is not None, f"Disney trial-to-paid not detected — got {list(rows)}")
    _assert(abs(disney.last_amount_cents) == 1199,
            f"Disney last should be steady $11.99, got {disney.last_amount_cents}")
    print(f"  ✓ Disney trial-to-paid: detected with steady-state amount last={disney.last_amount_cents}")

    # HBO Max: mid-history price change ($9.99 → $15.99 at the SECOND
    # charge). Verifies find_price_change_split picks up head-outlier
    # patterns, not just tail-outlier ones.
    hbo = rows.get("HBO MAX")
    _assert(hbo is not None, f"HBO MAX mid-history price change not detected — got {list(rows)}")
    _assert(hbo.subscription_type == SubscriptionType.streaming,
            f"HBO type={hbo.subscription_type}, want streaming")
    _assert(hbo.prior_amount_cents is not None and hbo.last_amount_cents is not None,
            f"HBO should surface a price change: prior={hbo.prior_amount_cents}, last={hbo.last_amount_cents}")
    _assert(abs(hbo.prior_amount_cents) == 999,
            f"HBO prior should be $9.99 (-999c), got {hbo.prior_amount_cents}")
    _assert(abs(hbo.last_amount_cents) == 1599,
            f"HBO last should be $15.99 (-1599c), got {hbo.last_amount_cents}")
    # change_date should be the date of the FIRST $15.99 charge — index 1
    # in the series (one month before the most recent). Allow a +/- 7 day
    # window to absorb _monthly_dates' jitter.
    _assert(hbo.price_change_date is not None,
            "HBO price_change_date should be set on a mid-history change")
    expected_change_idx = 1  # first charge at the new price
    expected_change_date = hbo_dates[expected_change_idx]
    delta_days = abs((hbo.price_change_date - expected_change_date).days)
    _assert(delta_days <= 7,
            f"HBO change_date {hbo.price_change_date} should be near {expected_change_date} (idx 1), got delta={delta_days}d")
    print(f"  ✓ HBO mid-history change: {hbo.prior_amount_cents}→{hbo.last_amount_cents} on {hbo.price_change_date}")


# ---------------------------------------------------------------------------
#  [6] T2 promo parser
# ---------------------------------------------------------------------------


def step_promo_parser() -> None:
    print("\n[6/9] T2 promo/price-change parser ...")

    # --- price change ---
    price_msg = GmailMessage(
        gmail_message_id="phaseb-pc-1",
        gmail_thread_id=None,
        from_address="no-reply@email.netflix.com",
        from_domain="email.netflix.com",
        subject="Your Netflix price update",
        received_at=datetime(2026, 4, 1, tzinfo=timezone.utc),
        snippet="Your monthly rate will increase to $15.49 starting next month.",
        body_plain=(
            "Hi —\n\nYour monthly Netflix subscription rate will increase to "
            "$15.49 effective May 1. No action needed.\n\nThanks!"
        ),
        headers={},
    )
    res = parse_promo(price_msg)
    _assert(res is not None, "parse_promo returned None for clear price-change email")
    _assert("price_change" in res.tags, f"price_change tag missing — tags={res.tags}")
    new_price = res.payload.get("price_change", {}).get("new_price_cents")
    _assert(new_price == 1549, f"new_price_cents={new_price}, want 1549")
    _assert(res.payload.get("merchant_hint") == "netflix",
            f"merchant_hint={res.payload.get('merchant_hint')}, want netflix")
    print(f"  ✓ price-change: new={new_price}c, hint={res.payload['merchant_hint']}")

    # --- promo: 30% off ---
    promo_msg = GmailMessage(
        gmail_message_id="phaseb-promo-1",
        gmail_thread_id=None,
        from_address="offers@spotify.com",
        from_domain="spotify.com",
        subject="Limited-time: 30% off Premium for 3 months",
        received_at=datetime(2026, 4, 2, tzinfo=timezone.utc),
        snippet="Get 30% off Spotify Premium for the next 3 months.",
        body_plain="Limited-time offer: 30% off for the next 3 months. Redeem now.",
        headers={},
    )
    res2 = parse_promo(promo_msg)
    _assert(res2 is not None, "parse_promo returned None for clear promo email")
    _assert("promo" in res2.tags, f"promo tag missing — tags={res2.tags}")
    promo = res2.payload.get("promo") or {}
    _assert(promo.get("percent_off") == 30, f"percent_off={promo.get('percent_off')}, want 30")
    _assert(promo.get("duration_months") == 3,
            f"duration_months={promo.get('duration_months')}, want 3")
    print(f"  ✓ promo: {promo}")

    # --- trial ending ---
    trial_msg = GmailMessage(
        gmail_message_id="phaseb-trial-1",
        gmail_thread_id=None,
        from_address="billing@hulu.com",
        from_domain="hulu.com",
        subject="Your free trial will end soon",
        received_at=datetime(2026, 4, 3, tzinfo=timezone.utc),
        snippet="Your Hulu free trial ends April 10.",
        body_plain="Just a heads up — your free trial will end on April 10.",
        headers={},
    )
    res3 = parse_promo(trial_msg)
    _assert(res3 is not None, "parse_promo returned None for trial-ending email")
    _assert("trial_ending" in res3.tags, f"trial_ending tag missing — tags={res3.tags}")
    _assert(res3.payload.get("trial_ending") is True, "trial_ending payload flag missing")
    print(f"  ✓ trial-ending tagged correctly")

    # --- subject-only marketing should bail (no body data → return None) ---
    junk_msg = GmailMessage(
        gmail_message_id="phaseb-junk-1",
        gmail_thread_id=None,
        from_address="marketing@example.com",
        from_domain="example.com",
        subject="Limited-time deals just for you",
        received_at=datetime(2026, 4, 4, tzinfo=timezone.utc),
        snippet="Don't miss out!",
        body_plain="Some generic marketing copy with no numbers.",
        headers={},
    )
    res4 = parse_promo(junk_msg)
    _assert(res4 is None, "subject-only marketing should not produce a tagged result")
    print(f"  ✓ junk subject without numeric body returns None")


# ---------------------------------------------------------------------------
#  [7] apply_pending_signals
# ---------------------------------------------------------------------------


def step_apply_promos() -> None:
    print("\n[7/9] apply_pending_signals — link parsed email to subscription ...")

    # Seed an EmailMessage row that mimics what the connector would produce
    # after running the T2 parser on a Netflix price-change email.
    with SessionLocal() as db:
        em = EmailMessage(
            gmail_message_id="apply-pc-1",
            gmail_thread_id=None,
            from_address="no-reply@email.netflix.com",
            from_domain="email.netflix.com",
            subject="Your Netflix price update",
            received_at=datetime(2026, 4, 5, tzinfo=timezone.utc),
            snippet="Your rate will increase to $15.49.",
            body_plain="…",
            parser_name="subscription_promo",
            parser_outcome=ParserOutcome.parsed,
            extra={
                "from_domain": "email.netflix.com",
                "subject": "Your Netflix price update",
                "merchant_hint": "netflix",
                "tags": ["price_change"],
                "price_change": {
                    "new_price_cents": 1599,  # different from the $9.99 detector saw
                    "detected_at": "2026-04-05T00:00:00+00:00",
                },
            },
        )
        db.add(em)
        db.commit()

        # Confirm the Netflix Subscription row exists from step 2-5.
        netflix = db.query(Subscription).filter(Subscription.name == "NETFLIX COM").one()
        prior_before = netflix.prior_amount_cents
        amount_before = netflix.amount_cents

        result = apply_pending_signals(db, today=SMOKE_TODAY)
        print(f"  apply: {result.as_dict()}")
        _assert(result.scanned >= 1, "expected at least 1 scanned EmailMessage")
        _assert(result.price_changes_applied >= 1,
                f"expected ≥1 price_changes_applied, got {result.price_changes_applied}")

        db.refresh(netflix)
        # The applier should have set prior to the previous amount and last to the
        # new (signed negative) value. amount_cents itself stays put — detector
        # owns that.
        _assert(netflix.last_amount_cents == -1599,
                f"Netflix last_amount after apply = {netflix.last_amount_cents}, want -1599")
        _assert(netflix.prior_amount_cents == amount_before,
                f"Netflix prior_amount after apply = {netflix.prior_amount_cents}, want {amount_before}")
        _assert(netflix.amount_cents == amount_before,
                "applier should NOT touch amount_cents (detector owns that)")
        _assert(netflix.price_change_date is not None,
                "price_change_date should be set after apply")
        print(f"  ✓ Netflix updated: prior={netflix.prior_amount_cents} last={netflix.last_amount_cents}")

        # Idempotency: a second run should skip already-applied messages.
        result2 = apply_pending_signals(db, today=SMOKE_TODAY)
        _assert(result2.price_changes_applied == 0,
                f"second run should be idempotent, got {result2.price_changes_applied} new applies")
        print(f"  ✓ idempotent: second run applied {result2.price_changes_applied} new signals")


# ---------------------------------------------------------------------------
#  [8] API: confirm / dismiss / set-type / promos endpoint
# ---------------------------------------------------------------------------


def step_api_transitions() -> None:
    print("\n[8/9] API: confirm / dismiss / set-type / apply-promos ...")
    client = TestClient(app)

    # Pull current subscriptions so we can drive transitions on real ids.
    r = client.get("/api/subscriptions")
    _assert(r.status_code == 200, f"GET /subscriptions → {r.status_code}: {r.text}")
    rows = {row["name"]: row for row in r.json()}
    _assert("NETFLIX COM" in rows, f"NETFLIX COM missing from API list: {list(rows)}")

    netflix = rows["NETFLIX COM"]
    _assert(netflix["is_user_confirmed"] is False, "Netflix should start unconfirmed")

    # --- confirm Netflix ---
    r = client.post(f"/api/subscriptions/{netflix['id']}/confirm")
    _assert(r.status_code == 200, f"confirm → {r.status_code}: {r.text}")
    body = r.json()
    _assert(body["is_user_confirmed"] is True, f"confirm did not set flag: {body}")
    _assert(body["status"] in {"active", "suspected"}, f"unexpected status post-confirm: {body['status']}")
    print(f"  ✓ confirm: is_user_confirmed=True status={body['status']}")

    # --- dismiss the Disney+ trial row (we don't actually want it tracked) ---
    disney_id = rows["DISNEY TRIAL TO"]["id"]
    r = client.post(f"/api/subscriptions/{disney_id}/dismiss")
    _assert(r.status_code == 200, f"dismiss → {r.status_code}: {r.text}")
    _assert(r.json()["status"] == "dismissed", f"dismiss did not set status: {r.json()}")
    print(f"  ✓ dismiss: Disney+ now status=dismissed")

    # --- set-type: relabel Adobe to "saas" explicitly even though detector
    #    already classified it that way. Verifies the endpoint round-trips. ---
    adobe_id = rows["ADOBE CREATIVE CLOUD"]["id"]
    r = client.post(
        f"/api/subscriptions/{adobe_id}/type",
        json={"subscription_type": "saas"},
    )
    _assert(r.status_code == 200, f"set-type → {r.status_code}: {r.text}")
    _assert(r.json()["subscription_type"] == "saas",
            f"set-type did not stick: {r.json()['subscription_type']}")
    print(f"  ✓ set-type: Adobe → saas confirmed")

    # --- apply-promos endpoint should run cleanly with no remaining work
    #    (we already drained signals in step 7).
    r = client.post("/api/subscriptions/apply-promos")
    _assert(r.status_code == 200, f"apply-promos → {r.status_code}: {r.text}")
    body = r.json()
    _assert(body["price_changes_applied"] == 0,
            f"apply-promos should have nothing to do; got {body['price_changes_applied']}")
    print(f"  ✓ apply-promos endpoint idempotent: {body}")


# ---------------------------------------------------------------------------
#  [9] /subscriptions/stats reconciliation
# ---------------------------------------------------------------------------


def step_stats_reconciliation() -> None:
    print("\n[9/9] /subscriptions/stats reconciliation ...")
    client = TestClient(app)

    r = client.get("/api/subscriptions/stats")
    _assert(r.status_code == 200, f"GET /stats → {r.status_code}: {r.text}")
    stats = r.json()

    # Pull all non-dismissed rows so we can recompute monthly totals locally.
    r = client.get("/api/subscriptions")
    rows = [row for row in r.json() if row["status"] != "dismissed"]
    _assert(stats["total_count"] == len(rows),
            f"stats.total_count={stats['total_count']}, expected {len(rows)}")

    # Hand-roll the monthly projection and compare. Sign convention: outflows
    # are negative; weekly+annual subs should map onto the same scale.
    expected_monthly = 0
    for row in rows:
        cadence = row["cadence_days"] or 30
        expected_monthly += int(round(row["amount_cents"] * 30 / cadence))
    _assert(
        stats["monthly_cost_cents"] == expected_monthly,
        f"stats.monthly={stats['monthly_cost_cents']}, recomputed {expected_monthly}",
    )

    # confirmed_only=true should produce a subset.
    r2 = client.get("/api/subscriptions/stats?confirmed_only=true")
    _assert(r2.status_code == 200, f"GET /stats?confirmed_only → {r2.status_code}: {r2.text}")
    stats_conf = r2.json()
    _assert(stats_conf["total_count"] <= stats["total_count"],
            "confirmed_only count should be ≤ all-non-dismissed count")
    _assert(stats_conf["confirmed_count"] == stats_conf["total_count"],
            "in confirmed_only mode, confirmed_count should equal total_count")
    print(f"  ✓ stats: total={stats['total_count']} monthly={stats['monthly_cost_cents']/100:.2f} "
          f"confirmed_only_total={stats_conf['total_count']}")

    # /price-changes should include Adobe (with the prior/last delta).
    r3 = client.get("/api/subscriptions/price-changes")
    _assert(r3.status_code == 200, f"GET /price-changes → {r3.status_code}: {r3.text}")
    pc_rows = r3.json()
    pc_names = {row["name"] for row in pc_rows}
    _assert("ADOBE CREATIVE CLOUD" in pc_names,
            f"Adobe missing from /price-changes; got {pc_names}")
    print(f"  ✓ /price-changes returned {len(pc_rows)} row(s): {sorted(pc_names)}")


# ---------------------------------------------------------------------------
#  Driver
# ---------------------------------------------------------------------------


def main() -> int:
    print("=" * 64)
    print("PHASE B — SUBSCRIPTION/BILL INTELLIGENCE — SMOKE TEST")
    print("=" * 64)
    Base.metadata.create_all(bind=engine)

    step_classifier()
    account_id = _seed_skeleton()
    step_detector(account_id)
    step_promo_parser()
    step_apply_promos()
    step_api_transitions()
    step_stats_reconciliation()

    print("\n" + "=" * 64)
    print("ALL PHASE B SMOKE STEPS PASSED")
    print("=" * 64)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
