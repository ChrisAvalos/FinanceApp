"""Smoke test for Wave D-5 Gmail parser promotions.

Covers the six parsers promoted from stub to real on 2026-05-06:

  [1] bofa_alerts        — labeled-field card alert
  [2] bofa_alerts        — narrative ("$X was made at Y on MM/DD/YYYY") form
  [3] wells_fargo_alerts — labeled-field form
  [4] netflix_receipt    — monthly receipt with service-period date
  [5] spotify_receipt    — Premium plan receipt with plan hint
  [6] pge_bill           — monthly energy statement with due date
  [7] water_bill         — generic municipal water bill
  [8] water_bill         — refuses unlabeled promo emails

Each test constructs a synthetic Gmail message, calls the parser's
``parse()`` directly, and asserts on the extracted fields. Pure-function
tests, no DB or HTTP.

Self-contained so it doesn't drag in the full backend stack: stubs out
``finance_app.gmail.client`` and ``finance_app.config`` in ``sys.modules``
*before* the parser modules import them. That means this script runs on
any Python that has just the stdlib — no need to activate the venv or
install pydantic-settings.

Run::

    cd backend
    py scripts/smoke_gmail_parsers.py
"""
from __future__ import annotations

import sys
import types
from dataclasses import dataclass
from datetime import datetime, date, timezone
from pathlib import Path
from textwrap import dedent

# ---------------------------------------------------------------------
#  Inject stubs BEFORE importing parsers, so the parsers' transitive
#  `from ..client import GmailMessage` and `from ..config import settings`
#  resolve against our shims instead of pulling in the real modules
#  (which need pydantic-settings, sqlalchemy, etc.).
# ---------------------------------------------------------------------


@dataclass
class GmailMessage:
    """Minimal shim — same shape as finance_app.gmail.client.GmailMessage,
    but with no dependencies on the real config/DB stack."""

    gmail_message_id: str
    gmail_thread_id: str | None
    from_address: str
    from_domain: str
    subject: str
    received_at: datetime
    snippet: str
    body_plain: str
    headers: dict


# Stub `finance_app.config` so `from ..config import settings` works.
_config_stub = types.ModuleType("finance_app.config")
_config_stub.settings = types.SimpleNamespace()  # type: ignore[attr-defined]

# Stub `finance_app.gmail.client` so `from ..client import GmailMessage`
# works without triggering the real client.py (which imports config).
_client_stub = types.ModuleType("finance_app.gmail.client")
_client_stub.GmailMessage = GmailMessage  # type: ignore[attr-defined]

# Empty parent packages so import resolution finds the stubs as
# attributes of their parent.
_finance_app = types.ModuleType("finance_app")
_finance_app.__path__ = [str(Path(__file__).resolve().parent.parent / "finance_app")]
_gmail_pkg = types.ModuleType("finance_app.gmail")
_gmail_pkg.__path__ = [str(Path(__file__).resolve().parent.parent / "finance_app" / "gmail")]

sys.modules.setdefault("finance_app", _finance_app)
sys.modules.setdefault("finance_app.config", _config_stub)
sys.modules.setdefault("finance_app.gmail", _gmail_pkg)
sys.modules.setdefault("finance_app.gmail.client", _client_stub)

# Add backend dir to path so `import finance_app.gmail.parsers...` resolves.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# NOW it's safe to import the real parser modules — their `from ..client
# import GmailMessage` will resolve to our stub above.
from finance_app.gmail.parsers import bofa_alerts, wells_fargo_alerts  # noqa: E402
from finance_app.gmail.parsers import netflix_receipt, spotify_receipt  # noqa: E402
from finance_app.gmail.parsers import pge_bill, water_bill  # noqa: E402
from finance_app.gmail.parsers import apple_receipt  # noqa: E402


def _msg(
    *,
    from_addr: str,
    from_domain: str,
    subject: str,
    body: str,
    received: datetime | None = None,
) -> GmailMessage:
    """Build a minimal GmailMessage for parser tests."""
    return GmailMessage(
        gmail_message_id="test-id",
        gmail_thread_id=None,
        from_address=from_addr,
        from_domain=from_domain,
        subject=subject,
        received_at=received or datetime(2026, 5, 6, 12, 0, 0, tzinfo=timezone.utc),
        snippet=body[:200],
        body_plain=body,
        headers={},
    )


def expect(condition: bool, label: str) -> None:
    status = "OK  " if condition else "FAIL"
    print(f"  [{status}] {label}")
    if not condition:
        sys.exit(1)


# ---------------------------------------------------------------------
# Test 1: BofA labeled form
# ---------------------------------------------------------------------
def test_bofa_labeled() -> None:
    print("BofA labeled form")
    body = dedent("""\
        Card transaction
        Account: Adv Plus Banking - 1234
        Card ending in 5678
        Amount: $42.50
        Merchant: STARBUCKS #2135 SEATTLE WA
        Posted: 04/22/2026
        """)
    msg = _msg(
        from_addr="alerts@bankofamerica.com",
        from_domain="bankofamerica.com",
        subject="Card transaction over $0",
        body=body,
    )
    expect(bofa_alerts.SPEC.matches(msg), "matches sender + subject")
    result = bofa_alerts.parse(msg)
    expect(result is not None, "parser returned a result")
    assert result is not None
    expect(result.transaction is not None, "produced a transaction")
    txn = result.transaction
    assert txn is not None
    expect(txn.amount_cents == -4250, f"amount = -4250, got {txn.amount_cents}")
    expect(txn.posted_date == date(2026, 4, 22), f"date = 2026-04-22, got {txn.posted_date}")
    expect(txn.card_last4 == "5678", f"last4 = 5678, got {txn.card_last4}")
    expect(
        txn.merchant is not None and "Starbucks" in txn.merchant,
        f"merchant has Starbucks, got {txn.merchant}",
    )


# ---------------------------------------------------------------------
# Test 2: BofA narrative form
# ---------------------------------------------------------------------
def test_bofa_narrative() -> None:
    print("BofA narrative form")
    body = "A purchase of $89.32 was made at WHOLE FOODS on 04/15/2026 using your card ending in 9911."
    msg = _msg(
        from_addr="customerservice@notification.bankofamerica.com",
        from_domain="notification.bankofamerica.com",
        subject="A charge was approved",
        body=body,
    )
    expect(bofa_alerts.SPEC.matches(msg), "matches")
    result = bofa_alerts.parse(msg)
    assert result is not None and result.transaction is not None
    expect(
        result.transaction.amount_cents == -8932,
        f"amount = -8932, got {result.transaction.amount_cents}",
    )
    expect(result.transaction.posted_date == date(2026, 4, 15), "date = 2026-04-15")
    expect(result.transaction.card_last4 == "9911", "last4 = 9911")
    expect(
        result.transaction.merchant is not None and "Whole Foods" in result.transaction.merchant,
        f"merchant cleaned, got {result.transaction.merchant}",
    )


# ---------------------------------------------------------------------
# Test 3: Wells Fargo labeled form
# ---------------------------------------------------------------------
def test_wells_fargo() -> None:
    print("Wells Fargo labeled form")
    body = dedent("""\
        Wells Fargo card alert
        Card ending in 4422
        Amount: $128.91
        Merchant: COSTCO WHOLESALE
        Date: 04/30/2026
        """)
    msg = _msg(
        from_addr="alerts@wellsfargo.com",
        from_domain="wellsfargo.com",
        subject="You made a purchase",
        body=body,
    )
    expect(wells_fargo_alerts.SPEC.matches(msg), "matches")
    result = wells_fargo_alerts.parse(msg)
    assert result is not None and result.transaction is not None
    expect(result.transaction.amount_cents == -12891, "amount = -12891")
    expect(result.transaction.posted_date == date(2026, 4, 30), "date = 2026-04-30")
    expect(result.transaction.card_last4 == "4422", "last4 = 4422")


# ---------------------------------------------------------------------
# Test 4: Netflix receipt
# ---------------------------------------------------------------------
def test_netflix() -> None:
    print("Netflix monthly receipt")
    body = dedent("""\
        Hi Chris,
        Here's a copy of your Netflix payment receipt.
        Total: $22.99
        Card: Visa ending in 1234
        Service period: Apr 22, 2026 - May 21, 2026
        Thanks for being a member!
        """)
    msg = _msg(
        from_addr="info@account.netflix.com",
        from_domain="account.netflix.com",
        subject="Your Netflix billing receipt",
        body=body,
    )
    expect(netflix_receipt.SPEC.matches(msg), "matches")
    result = netflix_receipt.parse(msg)
    assert result is not None and result.transaction is not None
    expect(result.transaction.amount_cents == -2299, "amount = -2299 (outflow)")
    expect(result.transaction.posted_date == date(2026, 4, 22), "date = service-period start")
    expect(result.transaction.merchant == "Netflix", "merchant = Netflix")
    expect(result.transaction.card_last4 == "1234", "last4 = 1234")
    expect("subscription" in result.tags, "tagged subscription")
    expect(
        result.payload.get("subscription_brand_hint") == "netflix",
        "brand hint set",
    )


# ---------------------------------------------------------------------
# Test 5: Spotify Premium receipt
# ---------------------------------------------------------------------
def test_spotify() -> None:
    print("Spotify Premium receipt")
    body = dedent("""\
        Receipt for your Spotify Premium plan
        Amount paid: $11.99
        Payment method: Visa ending in 5566
        Date of purchase: April 22, 2026
        Next payment date: May 22, 2026
        """)
    msg = _msg(
        from_addr="no-reply@spotify.com",
        from_domain="spotify.com",
        subject="Your Spotify Premium receipt",
        body=body,
    )
    expect(spotify_receipt.SPEC.matches(msg), "matches")
    result = spotify_receipt.parse(msg)
    assert result is not None and result.transaction is not None
    expect(result.transaction.amount_cents == -1199, "amount = -1199")
    expect(result.transaction.posted_date == date(2026, 4, 22), "date = 2026-04-22")
    expect(result.transaction.card_last4 == "5566", "last4 = 5566")
    expect(
        result.payload.get("plan") == "premium",
        f"plan = premium, got {result.payload.get('plan')}",
    )


# ---------------------------------------------------------------------
# Test 6: PG&E bill
# ---------------------------------------------------------------------
def test_pge() -> None:
    print("PG&E monthly bill")
    body = dedent("""\
        Your PG&E bill is ready
        Total amount due: $147.32
        Due date: May 22, 2026
        Service period: Mar 22, 2026 - Apr 21, 2026
        Account #: 1234567890
        """)
    msg = _msg(
        from_addr="DoNotReply@billpay.pge.com",
        from_domain="billpay.pge.com",
        subject="Your PG&E bill is ready",
        body=body,
    )
    expect(pge_bill.SPEC.matches(msg), "matches")
    result = pge_bill.parse(msg)
    assert result is not None
    expect(result.transaction is None, "no transaction (bills are future outflows)")
    expect(
        result.payload.get("bill_amount_cents") == 14732,
        "bill amount = 14732 cents",
    )
    expect(
        result.payload.get("due_date") == "2026-05-22",
        "due date = 2026-05-22",
    )
    expect("bill" in result.tags and "pge" in result.tags, "tagged bill/pge")


# ---------------------------------------------------------------------
# Test 7: water bill
# ---------------------------------------------------------------------
def test_water() -> None:
    print("Generic water utility bill")
    body = dedent("""\
        San Francisco Water Department
        Your water bill is ready
        Amount due: $58.42
        Due by: May 15, 2026
        """)
    msg = _msg(
        from_addr="billing@sfwater.org",
        from_domain="sfwater.org",
        subject="Your San Francisco Water bill is ready",
        body=body,
    )
    expect(water_bill.SPEC.matches(msg), "matches (subject-only)")
    result = water_bill.parse(msg)
    assert result is not None
    expect(
        result.payload.get("bill_amount_cents") == 5842,
        "bill amount = 5842 cents",
    )
    expect(
        result.payload.get("due_date") == "2026-05-15",
        "due date = 2026-05-15",
    )
    expect(
        "Water" in (result.payload.get("provider") or ""),
        f"provider includes Water, got {result.payload.get('provider')!r}",
    )


# ---------------------------------------------------------------------
# Test 8: water bill refuses unlabeled amounts
# ---------------------------------------------------------------------
def test_water_refuses_unlabeled() -> None:
    print("Water bill refuses promo with no labeled amount")
    body = "Save $10 on your water heater service! Valid through May 31."
    msg = _msg(
        from_addr="promos@somewatercompany.com",
        from_domain="somewatercompany.com",
        subject="Your water bill is ready (promotion!)",
        body=body,
    )
    expect(water_bill.SPEC.matches(msg), "subject still matches")
    result = water_bill.parse(msg)
    expect(result is None, "wildcard sender + no labeled total → returns None")


# ---------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------
# ---------------------------------------------------------------------
# Test 9: Apple monthly receipt — multiple line items
# ---------------------------------------------------------------------
def test_apple_receipt() -> None:
    print("Apple monthly receipt — extracts line items + grand total")
    body = dedent("""\
        Apple
        Receipt
        Date: Apr 22, 2026

        iCloud+ (50 GB)            Monthly                  $0.99
        Apple Music — Individual   Monthly                  $10.99
        Peacock Premium            Monthly                  $14.99
        Calm                       1-Year Subscription      $69.99

        Subtotal                                            $96.96
        Tax                                                  $8.04
        Order Total                                         $105.00
        """)
    msg = _msg(
        from_addr="no_reply@email.apple.com",
        from_domain="email.apple.com",
        subject="Your receipt from Apple",
        body=body,
    )
    expect(apple_receipt.SPEC.matches(msg), "matches sender + subject")
    result = apple_receipt.parse(msg)
    expect(result is not None, "parser returned a result")
    assert result is not None
    expect(result.transaction is None, "no synthesized transaction (parent charge already in bank)")
    payload = result.payload
    expect(payload.get("composite") == "apple", f"composite=apple, got {payload.get('composite')}")
    expect(
        payload.get("aggregator_key") == "apple_app_store",
        f"aggregator_key set, got {payload.get('aggregator_key')}",
    )
    line_items = payload.get("line_items") or []
    expect(
        len(line_items) == 4,
        f"expected 4 line items (iCloud+, Apple Music, Peacock, Calm), got {len(line_items)}",
    )
    titles = [li["title"].lower() for li in line_items]
    expect(any("peacock" in t for t in titles), f"Peacock found, titles={titles}")
    expect(any("icloud" in t for t in titles), f"iCloud found, titles={titles}")
    expect(any("calm" in t for t in titles), f"Calm found, titles={titles}")
    # Verify amounts
    by_title = {li["title"].lower(): li["amount_cents"] for li in line_items}
    peacock_amt = next(
        (cents for t, cents in by_title.items() if "peacock" in t), None
    )
    expect(peacock_amt == 1499, f"Peacock $14.99 → 1499 cents, got {peacock_amt}")
    expect(
        payload.get("grand_total_cents") == 10500,
        f"grand_total = 10500 cents, got {payload.get('grand_total_cents')}",
    )
    expect(
        "apple.com/bill" in (payload.get("parent_match_hints") or []),
        "parent_match_hints includes apple.com/bill",
    )


def main() -> None:
    print("=" * 64)
    print("Wave D-5 + F-2 Gmail parser smoke")
    print("=" * 64)
    test_bofa_labeled()
    test_bofa_narrative()
    test_wells_fargo()
    test_netflix()
    test_spotify()
    test_pge()
    test_water()
    test_water_refuses_unlabeled()
    test_apple_receipt()
    print()
    print("All 9 tests passed.")


if __name__ == "__main__":
    main()
