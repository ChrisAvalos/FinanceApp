"""Smoke test for Wave E bundle-overlap detector.

Pure-function tests on `bundles.detector._detect_from_subs`. Exercises:

  [1] Xfinity Mobile + Peacock standalone → flagged, high confidence
  [2] Xfinity Internet at $50/mo (below Gigabit tier) + Peacock → flagged,
      LOW confidence (parent bill below tier-with-Peacock range)
  [3] Verizon + Disney+ standalone → flagged
  [4] Just a standalone Peacock with no parent bundle → no finding
  [5] Just an Xfinity bill with no Peacock → no finding
  [6] Cancelled Peacock row → not flagged (caller filters by status)
  [7] Findings sorted by annual_savings_cents desc

Self-contained — only imports needed are the bundles.detector pure
function and yaml (which `loader.py` uses). Runs via `py
scripts/smoke_bundles.py` without activating the .venv.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from finance_app.bundles import _detect_from_subs, loader  # noqa: E402


@dataclass
class FakeSub:
    """Stand-in for db.models.Subscription. Same attrs the detector reads."""
    id: int
    name: str
    status: str = "active"
    last_amount_cents: int | None = None
    amount_cents: int | None = None
    last_seen_date: date | None = None


def expect(condition: bool, label: str) -> None:
    status = "OK  " if condition else "FAIL"
    print(f"  [{status}] {label}")
    if not condition:
        sys.exit(1)


# ---------------------------------------------------------------------
TODAY = date(2026, 5, 7)


def _sub(
    id: int,
    name: str,
    monthly: int,
    days_ago: int = 5,
    status: str = "active",
) -> FakeSub:
    return FakeSub(
        id=id,
        name=name,
        status=status,
        last_amount_cents=-monthly,
        last_seen_date=date.fromordinal(TODAY.toordinal() - days_ago),
    )


def _active(subs: list[FakeSub]) -> list[FakeSub]:
    """Mirror the wrapper's status filter — caller's responsibility."""
    return [s for s in subs if s.status in ("active", "suspected")]


# ---------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------
def test_xfinity_mobile_plus_peacock_high_confidence() -> None:
    print("Xfinity Mobile + standalone Peacock — high confidence")
    loader.reset_cache_for_tests()
    subs = [
        _sub(1, "XFINITY MOBILE PA", 6000),  # $60/mo, in [$35, $80] range
        _sub(2, "PEACOCK TV", 1499),
    ]
    findings = _detect_from_subs(_active(subs), today=TODAY)
    expect(len(findings) == 1, f"expected 1 finding, got {len(findings)}")
    f = findings[0]
    expect(f.parent_label == "Xfinity Mobile", f"parent={f.parent_label}")
    expect(f.perk_merchant == "peacock", f"perk={f.perk_merchant}")
    expect(f.annual_savings_cents == 1499 * 12, f"savings={f.annual_savings_cents}")
    expect(f.confidence >= 0.85, f"confidence={f.confidence} should be high")


def test_xfinity_internet_low_tier_bill_low_confidence() -> None:
    print("Xfinity Internet at $50/mo (below Gigabit tier) + Peacock — low confidence")
    loader.reset_cache_for_tests()
    subs = [
        _sub(1, "COMCAST INTERNET", 5000),  # $50/mo, below [$90, $200]
        _sub(2, "PEACOCK", 1499),
    ]
    findings = _detect_from_subs(_active(subs), today=TODAY)
    expect(len(findings) == 1, "still flagged, but low confidence")
    expect(
        findings[0].confidence <= 0.55,
        f"confidence={findings[0].confidence} should signal needs-verification",
    )
    expect(
        "below" in findings[0].rationale,
        f"rationale should explain the tier mismatch: {findings[0].rationale}",
    )


def test_verizon_disney_plus() -> None:
    print("Verizon Wireless + Disney+ standalone")
    loader.reset_cache_for_tests()
    subs = [
        _sub(1, "VERIZON WIRELESS", 9000),
        _sub(2, "DISNEY PLUS", 999),
    ]
    findings = _detect_from_subs(_active(subs), today=TODAY)
    # Verizon entry has 4 perks, but only Disney+ is in the user's data
    expect(len(findings) == 1, f"expected 1 finding, got {len(findings)}")
    expect(findings[0].perk_merchant == "disney_plus", "matched Disney+")


def test_no_parent_no_finding() -> None:
    print("Standalone Peacock with no parent bundle → no finding")
    loader.reset_cache_for_tests()
    subs = [_sub(1, "PEACOCK", 1499)]
    findings = _detect_from_subs(_active(subs), today=TODAY)
    expect(len(findings) == 0, f"expected 0 findings, got {len(findings)}")


def test_no_perk_no_finding() -> None:
    print("Just an Xfinity bill, no Peacock → no finding")
    loader.reset_cache_for_tests()
    subs = [_sub(1, "XFINITY MOBILE", 6000)]
    findings = _detect_from_subs(_active(subs), today=TODAY)
    expect(len(findings) == 0, f"expected 0 findings, got {len(findings)}")


def test_cancelled_perk_excluded() -> None:
    print("Cancelled Peacock + active Xfinity → not flagged")
    loader.reset_cache_for_tests()
    subs = [
        _sub(1, "XFINITY MOBILE", 6000),
        _sub(2, "PEACOCK", 1499, status="cancelled"),
    ]
    # _active filters out cancelled — same as the production wrapper.
    findings = _detect_from_subs(_active(subs), today=TODAY)
    expect(len(findings) == 0, "cancelled rows excluded from active+suspected filter")


def test_findings_sorted_by_savings() -> None:
    print("Findings sorted by annual_savings_cents desc")
    loader.reset_cache_for_tests()
    subs = [
        # Verizon parent + Apple Music perk ($10.99/mo = $131.88/yr)
        _sub(1, "VERIZON WIRELESS", 9000),
        _sub(2, "APPLE MUSIC", 1099),
        # Xfinity Mobile parent + Peacock perk ($14.99/mo = $179.88/yr) — bigger
        _sub(3, "XFINITY MOBILE", 6000),
        _sub(4, "PEACOCK", 1499),
    ]
    findings = _detect_from_subs(_active(subs), today=TODAY)
    expect(len(findings) == 2, f"expected 2 findings, got {len(findings)}")
    expect(
        findings[0].annual_savings_cents >= findings[1].annual_savings_cents,
        "first finding should have higher annual savings",
    )
    expect(findings[0].perk_merchant == "peacock", "Peacock comes first ($179.88)")


# ---------------------------------------------------------------------
def main() -> None:
    print("=" * 64)
    print("Wave E bundle-overlap detector smoke")
    print("=" * 64)
    test_xfinity_mobile_plus_peacock_high_confidence()
    test_xfinity_internet_low_tier_bill_low_confidence()
    test_verizon_disney_plus()
    test_no_parent_no_finding()
    test_no_perk_no_finding()
    test_cancelled_perk_excluded()
    test_findings_sorted_by_savings()
    print()
    print("All 7 tests passed.")


if __name__ == "__main__":
    main()
