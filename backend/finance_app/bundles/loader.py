"""bundles.yaml loader + dataclass mirrors.

Same loader pattern as the rest of the YAML-backed catalogs in the
backend (`benefits/service.py`, `card_applications/__init__.py`).
Module-level cache; explicit UTF-8 encoding to avoid the cp1252 mojibake
trap on Windows; an empty-list fallback if the file's missing so a
fresh checkout doesn't crash.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass(frozen=True)
class PerkEntry:
    """One perk inside a bundle — e.g. Peacock inside Xfinity Mobile."""

    merchant: str                          # canonical merchant key (e.g. "peacock")
    match_patterns: tuple[str, ...]        # case-insensitive substrings to match against Subscription.name
    perk_name: str                         # human-readable display name
    perk_value_cents: int                  # standalone monthly price (cents)
    tier_note: str = ""                    # human-readable tier description
    # Range of *parent* monthly bill amounts that include this perk.
    # Empty / 0 means "any tier qualifies." [low, high] inclusive.
    bill_range_cents: tuple[int, int] | None = None
    activation_url: str | None = None


@dataclass(frozen=True)
class BundleEntry:
    """One bundle — a parent subscription that includes one or more perks."""

    provider: str                          # stable key, e.g. "xfinity_mobile"
    parent_label: str                      # display name, e.g. "Xfinity Mobile"
    match_patterns: tuple[str, ...]        # patterns to find the parent in Subscription.name
    perks: tuple[PerkEntry, ...]
    notes: tuple[str, ...] = field(default_factory=tuple)
    # Optional: card profile names this bundle attaches to instead of
    # a recurring-bill subscription. Used for premium-card freebies.
    card_profiles: tuple[str, ...] = field(default_factory=tuple)


_loaded: list[BundleEntry] | None = None
_PATH = Path(__file__).parent / "bundles.yaml"


def load_bundles(path: Path | None = None) -> list[BundleEntry]:
    """Load + cache the bundle catalog. Pass ``path`` for tests."""
    global _loaded
    if path is None and _loaded is not None:
        return _loaded

    target = path or _PATH
    if not target.exists():
        # Empty catalog fallback — fresh checkouts and CI shouldn't
        # crash if the YAML is missing.
        if path is None:
            _loaded = []
        return []

    # encoding="utf-8" matches the D-2 mojibake fix in card_applications/.
    raw = yaml.safe_load(target.read_text(encoding="utf-8")) or []
    out: list[BundleEntry] = []
    for entry in raw:
        perks_raw = entry.get("perks") or []
        perks: list[PerkEntry] = []
        for p in perks_raw:
            br = p.get("bill_range_cents")
            bill_range: tuple[int, int] | None = None
            if isinstance(br, (list, tuple)) and len(br) == 2:
                bill_range = (int(br[0]), int(br[1]))
            perks.append(
                PerkEntry(
                    merchant=str(p["merchant"]),
                    match_patterns=tuple(
                        str(s).lower() for s in (p.get("match_patterns") or [])
                    ),
                    perk_name=str(p.get("perk_name", p["merchant"])),
                    perk_value_cents=int(p.get("perk_value_cents", 0)),
                    tier_note=str(p.get("tier_note", "")),
                    bill_range_cents=bill_range,
                    activation_url=p.get("activation_url"),
                )
            )
        out.append(
            BundleEntry(
                provider=str(entry["provider"]),
                parent_label=str(entry.get("parent_label", entry["provider"])),
                match_patterns=tuple(
                    str(s).lower() for s in (entry.get("match_patterns") or [])
                ),
                perks=tuple(perks),
                notes=tuple(str(n) for n in (entry.get("notes") or [])),
                card_profiles=tuple(
                    str(s) for s in (entry.get("card_profiles") or [])
                ),
            )
        )

    if path is None:
        _loaded = out
    return out


def reset_cache_for_tests() -> None:
    """Clear the module-level cache so tests can reload the catalog."""
    global _loaded
    _loaded = None
