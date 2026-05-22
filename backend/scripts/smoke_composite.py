"""Smoke test for Wave F composite-charge unmasking.

Pure-function tests on the composite_detector + the bundle detector's
integration with composite children. Exercises:

  [1] Aggregator detection — APPLE.COM/BILL → apple_app_store
  [2] Aggregator detection — GOOGLE *PEACOCK → google_play
  [3] Aggregator detection — non-aggregator merchant → None
  [4] Bundle detector finds Peacock-as-Apple-line-item — child of an
      Apple parent matches the xfinity_mobile bundle's peacock perk
  [5] Bundle detector ignores the Apple parent itself for perk matching
      (it's not Peacock — only the child is)
  [6] Hint questions are populated for known aggregators (UX wiring)

Self-contained — same pattern as smoke_bundles.py / smoke_plan_tiers.py.
Runs via `py scripts/smoke_composite.py` without activating the .venv.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from finance_app.subscriptions.composite_detector import (  # noqa: E402
    detect_aggregator,
    is_known_composite_name,
    list_aggregators,
)
from finance_app.bundles import _detect_from_subs, loader  # noqa: E402


@dataclass
class FakeSub:
    """Mirror of db.models.Subscription's attribute surface for the bundle detector."""
    id: int
    name: str
    status: str = "active"
    last_amount_cents: int | None = None
    amount_cents: int | None = None
    last_seen_date: date | None = None
    is_composite: bool = False
    parent_subscription_id: int | None = None


def expect(condition: bool, label: str) -> None:
    status = "OK  " if condition else "FAIL"
    print(f"  [{status}] {label}")
    if not condition:
        sys.exit(1)


TODAY = date(2026, 5, 7)


def _sub(
    id: int,
    name: str,
    monthly: int,
    *,
    status: str = "active",
    is_composite: bool = False,
    parent_subscription_id: int | None = None,
    days_ago: int = 5,
) -> FakeSub:
    return FakeSub(
        id=id,
        name=name,
        status=status,
        last_amount_cents=-monthly,
        last_seen_date=date.fromordinal(TODAY.toordinal() - days_ago),
        is_composite=is_composite,
        parent_subscription_id=parent_subscription_id,
    )


# ---------------------------------------------------------------------
def test_aggregator_apple() -> None:
    print("APPLE.COM/BILL → apple_app_store aggregator")
    agg = detect_aggregator("APPLE.COM/BILL")
    expect(agg is not None, "found a match")
    assert agg is not None
    expect(agg.key == "apple_app_store", f"key={agg.key}")
    expect(len(agg.hint_questions) >= 1, "hint_questions populated")
    expect(agg.receipt_sender == "apple.com", "receipt_sender set")


def test_aggregator_google() -> None:
    print("GOOGLE *PEACOCK → google_play aggregator")
    agg = detect_aggregator("GOOGLE *PEACOCK")
    expect(agg is not None, "found a match")
    assert agg is not None
    expect(agg.key == "google_play", f"key={agg.key}")


def test_aggregator_paypal() -> None:
    print("PAYPAL *DISCORDNITRO → paypal aggregator")
    agg = detect_aggregator("PAYPAL *DISCORDNITRO")
    expect(agg is not None, "found a match")
    assert agg is not None
    expect(agg.key == "paypal", f"key={agg.key}")


def test_non_aggregator() -> None:
    print("STARBUCKS → no aggregator match")
    expect(detect_aggregator("STARBUCKS #2135") is None, "Starbucks isn't an aggregator")
    expect(not is_known_composite_name("WALMART GROCERY"), "Walmart isn't either")


def test_aggregator_listing() -> None:
    print("list_aggregators returns ≥5 entries with non-empty fields")
    aggs = list_aggregators()
    expect(len(aggs) >= 5, f"expected ≥5, got {len(aggs)}")
    for a in aggs:
        expect(bool(a.key), f"key set: {a}")
        expect(bool(a.label), f"label set: {a.label}")
        expect(len(a.name_patterns) > 0, f"patterns set: {a.key}")


# ---------------------------------------------------------------------
def test_bundle_detector_finds_peacock_in_apple_parent() -> None:
    print("Bundle detector flags Peacock-as-Apple-line-item against Xfinity Mobile")
    loader.reset_cache_for_tests()
    subs = [
        # Xfinity Mobile parent in user's data
        _sub(1, "XFINITY MOBILE PA", 6000),
        # Apple App Store parent (composite)
        _sub(2, "APPLE.COM/BILL", 4096, is_composite=True),
        # Peacock declared as a child of the Apple parent
        _sub(
            3,
            "Peacock Premium",
            1499,
            parent_subscription_id=2,
        ),
    ]
    findings = _detect_from_subs(subs, today=TODAY)
    expect(len(findings) == 1, f"expected 1 finding, got {len(findings)}")
    f = findings[0]
    expect(f.parent_label == "Xfinity Mobile", f"parent_label={f.parent_label}")
    expect(
        f.perk_subscription_id == 3,
        f"perk_subscription_id should point to the Peacock CHILD (3), got {f.perk_subscription_id}",
    )
    expect(
        f.annual_savings_cents == 1499 * 12,
        f"savings={f.annual_savings_cents}",
    )


def test_bundle_detector_ignores_apple_parent_for_perk() -> None:
    print("Bundle detector does NOT match the Apple parent itself as a Peacock perk")
    loader.reset_cache_for_tests()
    # Same data as above but with NO Peacock child — only the Apple
    # parent. The detector should not flag anything because Apple's
    # name doesn't match the peacock perk pattern.
    subs = [
        _sub(1, "XFINITY MOBILE PA", 6000),
        _sub(2, "APPLE.COM/BILL", 4096, is_composite=True),
    ]
    findings = _detect_from_subs(subs, today=TODAY)
    expect(len(findings) == 0, f"expected 0 findings, got {len(findings)}")


# ---------------------------------------------------------------------
def main() -> None:
    print("=" * 64)
    print("Wave F composite + bundle-integration smoke")
    print("=" * 64)
    test_aggregator_apple()
    test_aggregator_google()
    test_aggregator_paypal()
    test_non_aggregator()
    test_aggregator_listing()
    test_bundle_detector_finds_peacock_in_apple_parent()
    test_bundle_detector_ignores_apple_parent_for_perk()
    print()
    print("All 7 tests passed.")


if __name__ == "__main__":
    main()
