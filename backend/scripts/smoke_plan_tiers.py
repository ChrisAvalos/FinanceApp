"""Smoke test for Wave E-6 — Xfinity plan-tier parse + sidecar persistence.

Pure-function tests on the HTML parser and the sidecar I/O. Exercises:

  [1] HTML with explicit "Included with your plan: Peacock" strip →
      emits xfinity_mobile snapshot with perk_keys=["peacock"]
  [2] HTML with plan name "Unlimited Plus" but NO included strip →
      perk_keys inferred from the plan-name lookup
  [3] HTML with a low-tier plan ("Connect" internet) → no perks
  [4] Empty HTML → no snapshots
  [5] Sidecar save + load round-trips ScrapedPlanTier intact
  [6] Bundle detector confidence override: snapshot lists peacock →
      confidence ≥ 0.95 even when the parent bill is below the
      bundles.yaml tier-range
  [7] Bundle detector negative override: snapshot does NOT list peacock
      → confidence drops to 0.2 (UI hides by default)

Self-contained — only stdlib + bs4 + pyyaml required (both are real
backend deps; smoke runs in the venv. Fall back to py system-Python if
the venv has those installed too).
"""
from __future__ import annotations

import sys
import tempfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from finance_app.scrapers.plan_tiers import (  # noqa: E402
    ScrapedPlanTier,
    load_snapshots,
    parse_xfinity_html,
    save_snapshot,
)
from finance_app.bundles import _detect_from_subs, loader  # noqa: E402


@dataclass
class FakeSub:
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


TODAY = date(2026, 5, 7)


# ---------------------------------------------------------------------
# Test 1: explicit "included with your plan" strip
# ---------------------------------------------------------------------
def test_included_strip_explicit() -> None:
    print("Xfinity Mobile HTML with explicit 'Included' strip → peacock")
    html = """
    <html><body>
      <h1>Welcome back, Chris</h1>
      <div>Your Xfinity Mobile plan: Unlimited Plus</div>
      <div>Included with your plan: Peacock Premium</div>
    </body></html>
    """
    tiers = parse_xfinity_html(html)
    expect(len(tiers) >= 1, f"expected ≥1 tier, got {len(tiers)}")
    mobile = next((t for t in tiers if t.provider == "xfinity_mobile"), None)
    expect(mobile is not None, "xfinity_mobile snapshot present")
    assert mobile is not None
    expect("peacock" in mobile.perk_keys, f"peacock in perk_keys, got {mobile.perk_keys}")
    expect(
        "unlimited plus" in mobile.plan_name.lower(),
        f"plan_name should mention Unlimited Plus, got {mobile.plan_name!r}",
    )


# ---------------------------------------------------------------------
# Test 2: plan-name inference (no explicit strip)
# ---------------------------------------------------------------------
def test_plan_name_inference() -> None:
    print("Xfinity Mobile HTML with only plan name → infer peacock from lookup")
    html = """
    <html><body>
      <p>Account: Chris</p>
      <div>Your Xfinity Mobile plan is Unlimited Premium with 2 lines.</div>
    </body></html>
    """
    tiers = parse_xfinity_html(html)
    mobile = next((t for t in tiers if t.provider == "xfinity_mobile"), None)
    expect(mobile is not None, "xfinity_mobile snapshot present")
    assert mobile is not None
    expect(
        "peacock" in mobile.perk_keys,
        f"plan-name lookup should infer peacock for Unlimited Premium, got {mobile.perk_keys}",
    )


# ---------------------------------------------------------------------
# Test 3: low-tier plan, no perks
# ---------------------------------------------------------------------
def test_low_tier_no_perks() -> None:
    print("Xfinity Internet 'Connect' tier → no perks")
    html = """
    <html><body>
      <h1>Your account</h1>
      <p>Internet plan: Connect — 100 Mbps</p>
    </body></html>
    """
    tiers = parse_xfinity_html(html)
    internet = next((t for t in tiers if t.provider == "xfinity_internet"), None)
    expect(internet is not None, "xfinity_internet snapshot present")
    assert internet is not None
    expect(
        internet.perk_keys == [],
        f"low-tier plan should have empty perk_keys, got {internet.perk_keys}",
    )


# ---------------------------------------------------------------------
# Test 4: empty HTML
# ---------------------------------------------------------------------
def test_empty_html() -> None:
    print("Empty HTML → no snapshots")
    tiers = parse_xfinity_html("")
    expect(tiers == [], f"expected [], got {tiers}")


# ---------------------------------------------------------------------
# Test 5: sidecar round-trip
# ---------------------------------------------------------------------
def test_sidecar_round_trip() -> None:
    print("Sidecar save+load round-trips ScrapedPlanTier intact")
    with tempfile.TemporaryDirectory() as td:
        sidecar = Path(td) / "snapshots.json"
        tier = ScrapedPlanTier(
            provider="xfinity_mobile",
            plan_name="Unlimited Premium",
            perk_keys=["peacock"],
            raw_text="some scraped text",
            source_url="https://example.com",
        )
        save_snapshot(tier, path=sidecar)
        expect(sidecar.exists(), "sidecar file written")
        loaded = load_snapshots(path=sidecar)
        expect("xfinity_mobile" in loaded, "provider key present")
        roundtrip = loaded["xfinity_mobile"]
        expect(
            roundtrip.plan_name == "Unlimited Premium",
            f"plan_name preserved, got {roundtrip.plan_name!r}",
        )
        expect(roundtrip.perk_keys == ["peacock"], "perk_keys preserved")


# ---------------------------------------------------------------------
# Test 6: detector confidence override (positive)
# ---------------------------------------------------------------------
def test_detector_override_positive() -> None:
    print("Detector confidence ≥0.95 when snapshot confirms perk, even on low-tier bill")
    loader.reset_cache_for_tests()
    subs = [
        FakeSub(
            id=1,
            name="XFINITY MOBILE",
            last_amount_cents=-2500,  # $25/mo — below $35 tier range
            last_seen_date=TODAY,
        ),
        FakeSub(
            id=2,
            name="PEACOCK",
            last_amount_cents=-1499,
            last_seen_date=TODAY,
        ),
    ]
    snapshots = {
        "xfinity_mobile": ScrapedPlanTier(
            provider="xfinity_mobile",
            plan_name="Unlimited Plus",
            perk_keys=["peacock"],
        )
    }
    findings = _detect_from_subs(subs, today=TODAY, plan_snapshots=snapshots)
    expect(len(findings) == 1, f"expected 1 finding, got {len(findings)}")
    expect(
        findings[0].confidence >= 0.95,
        f"snapshot match should bump confidence ≥0.95, got {findings[0].confidence}",
    )
    expect(
        "verified" in findings[0].rationale.lower(),
        f"rationale should mention portal verification: {findings[0].rationale}",
    )


# ---------------------------------------------------------------------
# Test 7: detector confidence override (negative)
# ---------------------------------------------------------------------
def test_detector_override_negative() -> None:
    print("Detector confidence ≤0.2 when snapshot says perk NOT included")
    loader.reset_cache_for_tests()
    subs = [
        FakeSub(
            id=1,
            name="XFINITY MOBILE",
            last_amount_cents=-6000,  # $60/mo — IN the heuristic tier range
            last_seen_date=TODAY,
        ),
        FakeSub(
            id=2,
            name="PEACOCK",
            last_amount_cents=-1499,
            last_seen_date=TODAY,
        ),
    ]
    # Snapshot says the user is on "By the Gig" — no Peacock.
    snapshots = {
        "xfinity_mobile": ScrapedPlanTier(
            provider="xfinity_mobile",
            plan_name="By the Gig",
            perk_keys=[],
        )
    }
    findings = _detect_from_subs(subs, today=TODAY, plan_snapshots=snapshots)
    expect(len(findings) == 1, "still emit the finding for transparency")
    expect(
        findings[0].confidence <= 0.2,
        f"portal-said-no should drop confidence to ≤0.2, got {findings[0].confidence}",
    )
    expect(
        "does not include" in findings[0].rationale.lower(),
        f"rationale should explain the negative: {findings[0].rationale}",
    )


# ---------------------------------------------------------------------
def main() -> None:
    print("=" * 64)
    print("Wave E-6 plan-tier scraper smoke")
    print("=" * 64)
    test_included_strip_explicit()
    test_plan_name_inference()
    test_low_tier_no_perks()
    test_empty_html()
    test_sidecar_round_trip()
    test_detector_override_positive()
    test_detector_override_negative()
    print()
    print("All 7 tests passed.")


if __name__ == "__main__":
    main()
