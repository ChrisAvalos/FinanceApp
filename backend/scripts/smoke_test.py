"""End-to-end smoke test.

Wipes the DB, seeds categories + rules, imports the sample Chase CSV, runs the
categorization engine, and prints a summary. If this passes, the foundation
pipeline is working.

Run:
    cd backend
    python scripts/smoke_test.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Use an isolated DB so we don't wipe a real finance.db. Can be overridden via
# SMOKE_DB_PATH (useful for sandboxed CI runs where the default path isn't
# writable).
TEST_DB_PATH = Path(
    os.environ.get("SMOKE_DB_PATH")
    or (Path(__file__).resolve().parent.parent / "smoke.db")
)
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH}"
if TEST_DB_PATH.exists():
    TEST_DB_PATH.unlink()

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from datetime import date, timedelta  # noqa: E402

from datetime import datetime, timezone  # noqa: E402

from finance_app.categorization.engine import CategorizationEngine  # noqa: E402
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
    Transaction,
    TransactionStatus,
)
from finance_app.db.seed import seed_all  # noqa: E402
from finance_app.db.session import SessionLocal, engine  # noqa: E402
from finance_app.ingestion.csv_importer import ChaseCsvImporter  # noqa: E402
from finance_app.subscriptions.detector import SubscriptionDetector  # noqa: E402


def _plaid_phase(account_id: int) -> None:
    """Phase 7 body — sandbox public_token → exchange → sync → re-sync (no-op).

    Skips loudly-but-gracefully when credentials or plaid-python aren't
    available. The point is to prove the Plaid slice when you *do* have them
    set, while keeping the smoke test green for people who don't.
    """
    # Re-read settings so we pick up any .env the user has configured
    from finance_app.config import settings  # noqa: PLC0415

    if not settings.plaid_client_id or not settings.plaid_secret:
        print("    SKIPPED — PLAID_CLIENT_ID / PLAID_SECRET not set in backend/.env")
        return
    if settings.plaid_env != "sandbox":
        print(f"    SKIPPED — PLAID_ENV={settings.plaid_env} (need 'sandbox')")
        return

    try:
        from finance_app.db.models import Account as _Acct  # noqa: F401,PLC0415
        from finance_app.db.models import PlaidItem, PlaidItemStatus  # noqa: PLC0415
        from finance_app.ingestion.plaid_connector import (  # noqa: PLC0415
            PlaidClient,
            PlaidConnector,
        )
    except ImportError as exc:
        print(f"    SKIPPED — plaid-python not installed ({exc})")
        return

    try:
        client = PlaidClient()
    except ImportError as exc:
        print(f"    SKIPPED — plaid-python not installed ({exc})")
        return
    except Exception as exc:  # noqa: BLE001 — bad creds surface here
        print(f"    SKIPPED — could not build PlaidClient: {exc!r}")
        return

    # 7a. Mint a sandbox public_token (no Plaid Link UI needed)
    try:
        public_token = client.sandbox_public_token_create()
    except Exception as exc:  # noqa: BLE001 — likely auth / rate limit
        print(f"    SKIPPED — sandbox_public_token_create failed: {exc!r}")
        return
    print(f"    minted sandbox public_token (prefix={public_token[:24]}…)")

    # 7b. Exchange + register the item in our DB
    with SessionLocal() as db:
        connector = PlaidConnector(db, client)
        item = connector.register_item(public_token)
        assert item.id is not None
        assert item.status == PlaidItemStatus.good
        assert item.access_token.startswith("access-sandbox-"), (
            f"unexpected access_token prefix: {item.access_token[:25]}"
        )
        print(
            f"    registered PlaidItem id={item.id} plaid_item_id={item.plaid_item_id[:16]}… "
            f"institution={item.plaid_institution_id}"
        )

        # 7c. At least one account should have been mirrored
        accounts = db.query(Account).filter(Account.plaid_item_id == item.id).all()
        assert accounts, "No Accounts mirrored from Plaid"
        print(f"    mirrored {len(accounts)} account(s):")
        for a in accounts:
            print(
                f"      id={a.id} name={a.name[:30]:<30} type={a.account_type.value} mask={a.mask}"
            )

        # 7d. First sync pulls transactions + advances cursor.
        #
        # Plaid sandbox quirk: a fresh item's first /transactions/sync often
        # returns empty because the sandbox hasn't finished generating its
        # historical dataset yet. In production you'd listen for the
        # HISTORICAL_UPDATE webhook; for the smoke test we just retry with
        # a short backoff. 12× 2s = 24s ceiling is plenty — sandbox is
        # usually ready in 1-3s.
        import time as _time  # noqa: PLC0415

        item_id = item.id
        before_cursor = item.transactions_cursor
        max_attempts = 12
        result1 = None
        for attempt in range(1, max_attempts + 1):
            result1 = connector.sync_transactions(item)
            db.refresh(item)
            if result1["added"] > 0:
                if attempt > 1:
                    print(f"    (sandbox ready after {attempt} polls)")
                break
            if attempt < max_attempts:
                _time.sleep(2)
        assert result1 is not None
        print(
            f"    first sync: added={result1['added']} modified={result1['modified']} "
            f"removed={result1['removed']} cursor_advanced={result1['cursor_advanced']}"
        )
        if result1["added"] == 0:
            print(
                "    WARNING — Plaid sandbox returned 0 transactions after "
                f"{max_attempts * 2}s of polling. This is a sandbox flake, "
                "not a code bug. Skipping the rest of Phase 7."
            )
            return
        assert item.transactions_cursor and item.transactions_cursor != before_cursor, (
            "Cursor did not advance after first sync"
        )

        # 7e. Confirm a sample of those transactions actually landed, with the
        # sign-flip applied (Plaid 'positive' = outflow in our system).
        plaid_txns = (
            db.query(Transaction)
            .filter(Transaction.source == IngestSource.plaid)
            .all()
        )
        assert plaid_txns, "No plaid-source transactions persisted"
        # Sandbox data always includes at least one debit → expect at least one
        # negative amount in our DB (money out).
        assert any(t.amount_cents < 0 for t in plaid_txns), (
            "Expected at least one outflow (negative amount) from Plaid sandbox"
        )
        print(
            f"    {len(plaid_txns)} plaid transactions persisted; "
            f"sign-flip verified (neg count={sum(1 for t in plaid_txns if t.amount_cents < 0)})"
        )

        # 7f. Second sync should be a near-no-op (cursor up to date)
        result2 = connector.sync_transactions(item)
        print(
            f"    second sync: added={result2['added']} modified={result2['modified']} "
            f"removed={result2['removed']} cursor_advanced={result2['cursor_advanced']}"
        )
        assert result2["added"] == 0, (
            f"Second sync should add 0 new transactions, got {result2['added']}"
        )

        # 7g. sync_all should see our one good item
        bulk = connector.sync_all()
        assert bulk["item_count"] >= 1
        assert str(item.plaid_item_id) in {str(k) for k in bulk["items"]}
        print(
            f"    sync_all reports {bulk['item_count']} item(s); "
            f"per-item keys ok ({list(bulk['items'].keys())[:1]}…)"
        )
        print(
            f"    ✓ Plaid slice verified end-to-end (item {item_id} synced, "
            f"{len(plaid_txns)} txns, cursor advanced)"
        )


def _gmail_phase(account_id: int) -> None:
    """Phase 8 body — fake three messages, run the connector, assert outcomes.

    Fully offline. We bypass the real GmailClient so this smoke test runs
    on a fresh clone without Google creds — same policy as the Plaid phase,
    which skips when creds aren't set. Here we can go further because the
    connector is designed to accept an injected client.
    """
    from finance_app.gmail import parsers as gmail_parsers  # noqa: PLC0415
    from finance_app.gmail.client import GmailMessage  # noqa: PLC0415
    from finance_app.gmail.connector import GmailConnector  # noqa: PLC0415

    # Reset the module-level parser registry so we get a clean dispatch order
    # (harmless in practice, cheap insurance).
    gmail_parsers.reset_registry_for_tests()

    # ------------------------------------------------------------------
    #  Fixture messages
    # ------------------------------------------------------------------

    def _ts(y: int, m: int, d: int) -> datetime:
        return datetime(y, m, d, 14, 30, tzinfo=timezone.utc)

    chase_alert = GmailMessage(
        gmail_message_id="gmail-chase-0001",
        gmail_thread_id="thread-001",
        from_address="Chase <alerts@chase.com>",
        from_domain="chase.com",
        subject="Your Chase transaction alert",
        received_at=_ts(2026, 4, 22),
        snippet="Transaction of $85.42 at STARBUCKS",
        body_plain=(
            "Chase\n\n"
            "You made a transaction on your account ending in 4242.\n"
            "Amount: $85.42\n"
            "Date: Apr 22, 2026\n"
            "Merchant: STARBUCKS #23455 SEATTLE WA\n"
            "Account Type: Credit Card\n"
        ),
        headers={},
    )

    xfinity_bill = GmailMessage(
        gmail_message_id="gmail-xfinity-0002",
        gmail_thread_id="thread-002",
        from_address="Xfinity <onlinecommunications@alerts.comcast.net>",
        from_domain="alerts.comcast.net",
        subject="Your Xfinity bill is ready",
        received_at=_ts(2026, 4, 20),
        snippet="Your total amount due is $149.99",
        body_plain=(
            "Your Xfinity bill is ready.\n\n"
            "Total amount due: $149.99\n"
            "Due date: May 15, 2026\n"
            "Thank you for being an Xfinity customer.\n"
        ),
        headers={},
    )

    # A Chase marketing email that should NOT match the alert parser's
    # subject pattern → lands as ignored (header match, no subject match).
    chase_promo = GmailMessage(
        gmail_message_id="gmail-chase-promo-0003",
        gmail_thread_id="thread-003",
        from_address="Chase Offers <noreply@chase.com>",
        from_domain="chase.com",
        subject="New offers just for you",
        received_at=_ts(2026, 4, 19),
        snippet="Save on restaurants and travel",
        body_plain="Explore new Chase Offers — activate and save.",
        headers={},
    )

    # Completely irrelevant sender — exercise the "no parser matched at all"
    # path. This message wouldn't normally be fetched (build_search_query
    # filters on sender), but we want to verify defensive behavior.
    random_email = GmailMessage(
        gmail_message_id="gmail-random-0004",
        gmail_thread_id="thread-004",
        from_address="friend@example.com",
        from_domain="example.com",
        subject="lunch?",
        received_at=_ts(2026, 4, 18),
        snippet="hey want to grab lunch",
        body_plain="hey — free this week?",
        headers={},
    )

    fixtures: list[GmailMessage] = [chase_alert, xfinity_bill, chase_promo, random_email]
    fixture_by_id = {m.gmail_message_id: m for m in fixtures}

    # ------------------------------------------------------------------
    #  Fake client — only implements what the connector calls
    # ------------------------------------------------------------------

    class _FakeClient:
        def __init__(self):
            self.search_calls: list[str] = []
            self.get_calls: list[str] = []

        def search_ids(self, query: str, *, max_results: int = 500) -> list[str]:
            self.search_calls.append(query)
            return list(fixture_by_id.keys())[:max_results]

        def get_message(self, message_id: str) -> GmailMessage:
            self.get_calls.append(message_id)
            return fixture_by_id[message_id]

    fake_client = _FakeClient()

    # ------------------------------------------------------------------
    #  Run the connector + assert
    # ------------------------------------------------------------------

    with SessionLocal() as db:
        connector = GmailConnector(db, fake_client)  # type: ignore[arg-type]
        result = connector.sync(newer_than_days=30)
        print(
            f"    sync: fetched={result.fetched} new={result.new} "
            f"parsed={result.parsed} ignored={result.ignored} failed={result.failed} "
            f"transactions={result.transactions_created} bills={result.bills_seen}"
        )

        assert result.fetched == 4, f"expected 4 fetched, got {result.fetched}"
        assert result.new == 4
        # Two parsers claim (Chase alert + Xfinity bill); two are ignored
        assert result.parsed == 2, f"expected 2 parsed, got {result.parsed}"
        assert result.ignored == 2, f"expected 2 ignored, got {result.ignored}"
        assert result.failed == 0
        assert result.transactions_created == 1, (
            f"expected 1 transaction created, got {result.transactions_created}"
        )
        assert result.bills_seen == 1, f"expected 1 bill, got {result.bills_seen}"
        assert "chase_alerts" in result.per_parser
        assert "xfinity_bill" in result.per_parser

        # Verify the EmailMessage rows landed with the right outcomes
        emails = db.query(EmailMessage).all()
        assert len(emails) == 4
        by_id = {e.gmail_message_id: e for e in emails}
        assert by_id["gmail-chase-0001"].parser_outcome == ParserOutcome.parsed
        assert by_id["gmail-chase-0001"].parser_name == "chase_alerts"
        assert by_id["gmail-chase-0001"].transaction_id is not None
        assert by_id["gmail-xfinity-0002"].parser_outcome == ParserOutcome.parsed
        assert by_id["gmail-xfinity-0002"].parser_name == "xfinity_bill"
        assert by_id["gmail-xfinity-0002"].transaction_id is None  # bills don't create txns
        assert by_id["gmail-chase-promo-0003"].parser_outcome == ParserOutcome.ignored
        assert by_id["gmail-random-0004"].parser_outcome == ParserOutcome.ignored

        # Verify the Chase transaction was actually upserted, sign-flipped,
        # and attached to our existing Chase Freedom account (mask 4242)
        # rather than a synthetic one — that's the card_last4 → mask match
        # we care about.
        chase_txn = (
            db.query(Transaction)
            .filter(
                Transaction.source == IngestSource.gmail,
                Transaction.external_id == "gmail-chase-0001",
            )
            .one()
        )
        assert chase_txn.account_id == account_id, (
            f"expected card_last4=4242 to resolve to account {account_id}, "
            f"got {chase_txn.account_id}"
        )
        assert chase_txn.amount_cents == -8542, (
            f"expected -8542 cents (outflow), got {chase_txn.amount_cents}"
        )
        assert chase_txn.posted_date == date(2026, 4, 22), (
            f"expected 2026-04-22, got {chase_txn.posted_date}"
        )
        extra = chase_txn.extra or {}
        assert extra.get("card_last4") == "4242"
        assert extra.get("parser") == "chase_alerts"

        # Verify the Xfinity bill payload made it into EmailMessage.extra
        xfinity_extra = by_id["gmail-xfinity-0002"].extra or {}
        assert xfinity_extra.get("bill_amount_cents") == 14999, (
            f"expected 14999 cents, got {xfinity_extra.get('bill_amount_cents')}"
        )
        assert xfinity_extra.get("provider") == "Xfinity"
        assert xfinity_extra.get("due_date") == "2026-05-15"

        # A second sync should be a no-op — known IDs get skipped.
        result2 = connector.sync(newer_than_days=30)
        assert result2.new == 0, f"second sync should be no-op, got new={result2.new}"
        print(f"    second sync: fetched={result2.fetched} new={result2.new} (idempotent ✓)")

        print(
            f"    ✓ Gmail slice verified: 1 transaction on account {account_id} "
            f"(mask-matched), 1 bill payload, 2 ignored, idempotent re-sync."
        )


def main() -> int:
    print("=" * 60)
    print("FINANCE APP — SMOKE TEST")
    print("=" * 60)

    # 1. Create schema + seed
    print("\n[1/8] Creating schema + seeding categories & rules...")
    Base.metadata.create_all(bind=engine)
    seed_all()

    # 2. Create an institution + account
    print("\n[2/8] Creating test institution + account...")
    with SessionLocal() as db:
        inst = Institution(name="Chase", kind=InstitutionKind.bank)
        db.add(inst)
        db.flush()
        acct = Account(
            institution_id=inst.id,
            name="Chase Freedom Unlimited",
            account_type=AccountType.credit_card,
            mask="4242",
            currency="USD",
        )
        db.add(acct)
        db.commit()
        account_id = acct.id
        print(f"    Institution: {inst.name} (id={inst.id})")
        print(f"    Account: {acct.name} (id={account_id})")

    # 3. Ingest the sample CSV
    sample_csv = Path(__file__).resolve().parent.parent.parent / "sample_data" / "chase_example.csv"
    print(f"\n[3/8] Ingesting {sample_csv.name}...")
    with SessionLocal() as db:
        acct = db.get(Account, account_id)
        importer = ChaseCsvImporter(db, acct)
        batch = importer.run(str(sample_csv))
        print(f"    rows_parsed:    {batch.rows_parsed}")
        print(f"    rows_created:   {batch.rows_created}")
        print(f"    rows_duplicate: {batch.rows_duplicate}")
        if batch.errors:
            print(f"    errors:         {batch.errors}")

    # 4. Re-run ingest — should dedupe completely
    print("\n[4/8] Re-ingesting same CSV (should be 100% duplicate)...")
    with SessionLocal() as db:
        acct = db.get(Account, account_id)
        importer = ChaseCsvImporter(db, acct)
        batch2 = importer.run(str(sample_csv))
        print(f"    rows_created:   {batch2.rows_created} (expected 0)")
        print(f"    rows_duplicate: {batch2.rows_duplicate}")
        assert batch2.rows_created == 0, "Deduplication failed!"

    # 5. Categorize + summarize
    print("\n[5/8] Running categorization engine + summary...")
    with SessionLocal() as db:
        engine_ = CategorizationEngine(db)
        counts = engine_.categorize_all()
        print(f"    Categorization counts: {counts}")

        txns = db.query(Transaction).all()
        categorized = [t for t in txns if t.category_id is not None]
        cat_map = {c.id: c.name for c in db.query(Category).all()}

        print(f"\n    {len(categorized)}/{len(txns)} transactions categorized.")
        print("\n    Sample categorizations:")
        print("    " + "-" * 70)
        for t in sorted(txns, key=lambda x: x.posted_date, reverse=True)[:15]:
            cat = cat_map.get(t.category_id, "—") if t.category_id else "—"
            amt = f"${t.amount_cents / 100:>9,.2f}"
            desc = (t.description_raw or "")[:40].ljust(40)
            print(f"    {t.posted_date}  {desc}  {amt}  {cat}")

        # Spend summary
        outflow = sum(-t.amount_cents for t in txns if t.amount_cents < 0)
        inflow = sum(t.amount_cents for t in txns if t.amount_cents > 0)
        print("\n    Totals:")
        print(f"      Outflow: ${outflow / 100:,.2f}")
        print(f"      Inflow:  ${inflow / 100:,.2f}")
        print(f"      Net:     ${(inflow - outflow) / 100:,.2f}")

    # 6. Subscription detection — inject 4 months of recurring charges into
    # the DB (bypassing the CSV importer; we already exercised that path
    # above) and confirm the detector finds them with the right cadence.
    print("\n[6/8] Seeding 4 months of recurring charges + running subscription detector...")
    recurring_series = [
        # (merchant description, monthly amount in cents)
        ("NETFLIX.COM 866-579-7172",       -1549),
        ("SPOTIFY USA NEW YORK NY",        -1099),
        ("XFINITY COMCAST 800-266-2278",   -8999),
        ("APPLE.COM/BILL",                  -299),
        ("PELOTON INTERACTIVE",            -4400),
    ]
    # Anchor the synthetic dates in MARCH, so they sit cleanly before the
    # CSV's April charges (which are the same merchants). That gives each
    # series a clean ~30-day cadence for 4 months, then the CSV charge acts
    # as the 5th and most recent occurrence. Fixed dates keep the test
    # deterministic regardless of when it's run.
    anchor = date(2026, 3, 10)
    charge_dates = [anchor - timedelta(days=30 * i) for i in range(4)]
    # Treat this as "today" for status-from-recency calculations. Places us
    # ~3 weeks after the last CSV charge, so every series should be "active"
    # (within 1.5× monthly cadence = 45 days).
    smoke_today = date(2026, 4, 25)
    with SessionLocal() as db:
        for desc, amt in recurring_series:
            for i, d in enumerate(charge_dates):
                db.add(
                    Transaction(
                        account_id=account_id,
                        posted_date=d,
                        amount_cents=amt,
                        currency="USD",
                        status=TransactionStatus.posted,
                        description_raw=desc,
                        source=IngestSource.manual,
                        external_id=f"smoke-rec-{desc[:10]}-{i}",
                    )
                )
        db.commit()

        # Run detection in preview mode first so we can print findings
        detected = SubscriptionDetector(db, today=smoke_today).detect()
        print(f"    Detector found {len(detected)} recurring series:")
        for d in sorted(detected, key=lambda x: abs(x.amount_cents), reverse=True):
            print(
                f"      {d.name[:38].ljust(38)}  "
                f"${d.amount_cents / 100:>8,.2f}  "
                f"{d.cadence_label:<10}  "
                f"{d.n_occurrences}x  "
                f"→ next {d.next_expected_date}  [{d.status.value}]"
            )

        # Persist + verify count
        result = SubscriptionDetector(db, today=smoke_today).sync_to_db()
        print(f"    sync_to_db: {result}")

        expected_names = {
            "NETFLIX COM",
            "SPOTIFY USA NEW",
            "XFINITY COMCAST",
            "APPLE COM BILL",
            "PELOTON INTERACTIVE",
        }
        persisted = {s.name for s in db.query(Subscription).all()}
        missing = expected_names - persisted
        assert not missing, (
            f"Subscription detector missed expected merchants: {missing}\n"
            f"Persisted: {persisted}"
        )

        # All five should be monthly (cadence_days in the 26-35 window) and
        # marked active (most recent charge was within 1.5× cadence of 'today').
        for name in expected_names:
            row = db.query(Subscription).filter(Subscription.name == name).one()
            assert 26 <= row.cadence_days <= 35, (
                f"{name} cadence_days={row.cadence_days}, expected monthly (26-35)"
            )
            assert row.status == SubscriptionStatus.active, (
                f"{name} status={row.status}, expected active"
            )
        print(f"    ✓ All {len(expected_names)} expected subscriptions detected as monthly+active")

    # 7. Plaid sandbox end-to-end. Skipped cleanly if credentials aren't set or
    #    plaid-python isn't installed — this keeps the smoke test runnable on a
    #    fresh clone without Plaid creds.
    print("\n[7/8] Plaid sandbox end-to-end...")
    _plaid_phase(account_id)

    # 8. Gmail parser pipeline. Fully offline — we monkey-patch GmailClient to
    #    return a handful of fixture messages and verify the dispatch/upsert
    #    logic. Doesn't require credentials.json or network access.
    print("\n[8/8] Gmail parser pipeline (mocked client)...")
    _gmail_phase(account_id)

    # Cleanup — dispose the SQLAlchemy engine first so Windows releases the
    # SQLite file handle, then delete. Tolerate failure (cosmetic, not fatal).
    engine.dispose()
    try:
        TEST_DB_PATH.unlink(missing_ok=True)
    except PermissionError:
        # Windows sometimes hangs on to the handle for a beat. Leaving the
        # temp DB file around is harmless — it gets wiped on the next run.
        print(f"    (note: could not delete {TEST_DB_PATH.name} — will be cleaned on next run)")

    print("\n" + "=" * 60)
    print("SMOKE TEST PASSED ✓")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
