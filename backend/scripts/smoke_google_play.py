"""Smoke test for Sprint 21 — Google Play receipt parser.

Covers the three receipt shapes the parser is meant to handle:

  [1] Single-item receipt (Spotify Premium, multi-line block format)
  [2] Single-item receipt with parenthetical period marker
  [3] Batched receipt: multiple subscriptions on one order
  [4] Refusal: non-receipt google.com mail (security alert)

Self-contained: stubs ``finance_app.config`` and
``finance_app.gmail.client`` so the script runs on plain ``py``
without activating the .venv. Mirrors the pattern in
``smoke_gmail_parsers.py``.

Run::

    cd backend
    py scripts/smoke_google_play.py
"""
from __future__ import annotations

import sys
import types
from dataclasses import dataclass
from datetime import datetime, date, timezone
from pathlib import Path
from textwrap import dedent


# ---------------------------------------------------------------------
#  Module stubs (must run before importing the parser).
# ---------------------------------------------------------------------


@dataclass
class GmailMessage:
    gmail_message_id: str
    gmail_thread_id: str | None
    from_address: str
    from_domain: str
    subject: str
    received_at: datetime
    snippet: str
    body_plain: str
    headers: dict


_config_stub = types.ModuleType("finance_app.config")
_config_stub.settings = types.SimpleNamespace()  # type: ignore[attr-defined]
_client_stub = types.ModuleType("finance_app.gmail.client")
_client_stub.GmailMessage = GmailMessage  # type: ignore[attr-defined]
_finance_app = types.ModuleType("finance_app")
_finance_app.__path__ = [str(Path(__file__).resolve().parent.parent / "finance_app")]
_gmail_pkg = types.ModuleType("finance_app.gmail")
_gmail_pkg.__path__ = [str(Path(__file__).resolve().parent.parent / "finance_app" / "gmail")]

sys.modules.setdefault("finance_app", _finance_app)
sys.modules.setdefault("finance_app.config", _config_stub)
sys.modules.setdefault("finance_app.gmail", _gmail_pkg)
sys.modules.setdefault("finance_app.gmail.client", _client_stub)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from finance_app.gmail.parsers import google_play_receipt  # noqa: E402


def _msg(
    *,
    from_addr: str = "googleplay-noreply@google.com",
    from_domain: str = "google.com",
    subject: str = "Your Google Play Order Receipt",
    body: str,
    received: datetime | None = None,
) -> GmailMessage:
    return GmailMessage(
        gmail_message_id="test-gp",
        gmail_thread_id=None,
        from_address=from_addr,
        from_domain=from_domain,
        subject=subject,
        received_at=received or datetime(2026, 5, 12, 12, 0, 0, tzinfo=timezone.utc),
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
# Test 1: single-item Spotify receipt (multi-line block)
# ---------------------------------------------------------------------
def test_single_item_block() -> None:
    print("Single-item receipt — multi-line block (Spotify)")
    body = dedent("""\
        Google Play

        Order receipt
        Order number: GPA.1234-5678-9012-34567
        Order date: May 5, 2026

        Spotify Premium
        1-month subscription
        Spotify

        $9.99

        Subtotal: $9.99
        Tax: $0.85
        Order total: $10.84

        Payment method: Visa ****1234
        """)
    msg = _msg(body=body)
    expect(google_play_receipt.SPEC.matches(msg), "matches sender + subject")
    result = google_play_receipt.parse(msg)
    expect(result is not None, "parser returned a result")
    assert result is not None
    expect(result.transaction is None, "no transaction (composite receipt)")
    payload = result.payload
    expect(payload["composite"] == "google_play", "composite = google_play")
    expect(payload["aggregator_key"] == "google_play_store", "aggregator key set")
    items = payload["line_items"]
    expect(len(items) == 1, f"1 line item, got {len(items)}")
    expect(items[0]["title"] == "Spotify Premium",
           f"title = 'Spotify Premium', got {items[0]['title']!r}")
    expect(items[0]["amount_cents"] == 999,
           f"amount = 999, got {items[0]['amount_cents']}")
    expect(payload["grand_total_cents"] == 1084,
           f"total = 1084, got {payload['grand_total_cents']}")
    expect(payload["receipt_date"] == "2026-05-05",
           f"date = 2026-05-05, got {payload['receipt_date']!r}")


# ---------------------------------------------------------------------
# Test 2: single-item receipt with parenthetical period
# ---------------------------------------------------------------------
def test_single_item_paren() -> None:
    print("Single-item receipt — parenthetical period (YouTube Premium)")
    body = dedent("""\
        Google Play

        Order receipt
        Order date: May 8, 2026
        Order number: GPA.9876-5432-1098-76543

        YouTube Premium (1-month)
        Google LLC

        $13.99

        Subtotal: $13.99
        Tax: $1.19
        Order total: $15.18
        """)
    msg = _msg(body=body, subject="Your Google Play Order Receipt from May 8, 2026")
    expect(google_play_receipt.SPEC.matches(msg), "matches")
    result = google_play_receipt.parse(msg)
    assert result is not None
    items = result.payload["line_items"]
    expect(len(items) == 1, f"1 line item, got {len(items)}")
    expect(items[0]["title"] == "YouTube Premium",
           f"title = 'YouTube Premium', got {items[0]['title']!r}")
    expect(items[0]["period"] == "1-month",
           f"period = '1-month', got {items[0]['period']!r}")
    expect(items[0]["amount_cents"] == 1399,
           f"amount = 1399, got {items[0]['amount_cents']}")


# ---------------------------------------------------------------------
# Test 3: batched receipt (multiple items, single-line format)
# ---------------------------------------------------------------------
def test_batched_single_line() -> None:
    print("Batched receipt — single-line format (3 items)")
    body = dedent("""\
        Google Play

        Order receipt
        Order date: May 10, 2026
        Order number: GPA.1111-2222-3333-44444

        Spotify Premium - 1-month subscription            $9.99
        Calm Premium - 1-year subscription               $69.99
        Headspace Plus - 1-month subscription             $12.99

        Subtotal: $92.97
        Tax: $8.12
        Order total: $101.09
        """)
    msg = _msg(body=body)
    expect(google_play_receipt.SPEC.matches(msg), "matches")
    result = google_play_receipt.parse(msg)
    assert result is not None
    items = result.payload["line_items"]
    expect(len(items) == 3, f"3 line items, got {len(items)}")
    titles = {it["title"] for it in items}
    expect("Spotify Premium" in titles, f"Spotify in {titles}")
    expect("Calm Premium" in titles, f"Calm in {titles}")
    expect("Headspace Plus" in titles, f"Headspace in {titles}")
    amounts = sorted(it["amount_cents"] for it in items)
    expect(amounts == [999, 1299, 6999], f"amounts = [999, 1299, 6999], got {amounts}")
    # Subtotal/total/tax rows must NOT show up as line items.
    expect(not any("subtotal" in it["title"].lower() for it in items),
           "no 'subtotal' line item")
    expect(not any("total" in it["title"].lower() for it in items),
           "no 'total' line item")


# ---------------------------------------------------------------------
# Test 4: refusal on non-receipt google.com mail
# ---------------------------------------------------------------------
def test_refuses_non_receipt() -> None:
    print("Refuses non-receipt google.com mail (security alert)")
    body = dedent("""\
        New sign-in to your Google Account
        Hi Chris,

        We noticed a new sign-in from a Pixel 8 device in San Francisco.
        If this was you, you can ignore this email. If not, please review your
        account security at https://myaccount.google.com.

        Thanks,
        The Google Accounts team
        """)
    msg = _msg(
        from_addr="no-reply@accounts.google.com",
        from_domain="accounts.google.com",
        subject="Security alert",
        body=body,
    )
    # The sender may or may not match SPEC.matches — what we care about
    # is that parse() refuses if the body doesn't look like a Play
    # receipt. (No 'google play' marker and no GPA order number.)
    result = google_play_receipt.parse(msg)
    expect(result is None, "parse() returned None for non-receipt mail")


if __name__ == "__main__":
    print("=" * 60)
    print("Smoke: Google Play receipt parser")
    print("=" * 60)
    test_single_item_block()
    test_single_item_paren()
    test_batched_single_line()
    test_refuses_non_receipt()
    print()
    print("All checks passed.")
