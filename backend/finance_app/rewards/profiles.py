"""Card-rewards profile loader.

Reads ``card_rewards.yaml`` once at import time and exposes the
profiles as a list. The optimizer matches each linked Account against
this list by name pattern and uses the matched profile's multipliers
to compute "rewards earned."

Design notes
------------
* Profiles are read-only. To add a card, edit the YAML — no code change
  needed in 95% of cases.
* Pattern matching is case-insensitive substring on Account.name. We
  prefer this to exact matches because Plaid often returns cards with
  marketing variants ("Sapphire Preferred®" vs "Chase Sapphire
  Preferred Card"); substrings absorb that drift.
* If multiple profiles match a name, the FIRST in YAML order wins.
  Order in the YAML reflects priority: more-specific profiles first
  (e.g. "Sapphire Reserve" before "Sapphire Preferred" so "Sapphire
  Reserve Visa" doesn't get matched to Preferred). When you add a new
  profile, place it above any more-general one.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass(frozen=True)
class CardRewardProfile:
    """One card's rewards behavior, loaded from the YAML file.

    Attributes mirror the YAML schema but use frozen dataclass so the
    profiles can be safely shared across requests.
    """

    name: str
    name_patterns: tuple[str, ...]
    base_multiplier: float
    category_multipliers: dict[str, float] = field(default_factory=dict)
    annual_caps_cents: dict[str, int] = field(default_factory=dict)
    notes: str = ""

    def matches(self, account_name: str) -> bool:
        """True if any of this profile's patterns appears in ``account_name``."""
        if not account_name:
            return False
        n = account_name.lower()
        return any(p.lower() in n for p in self.name_patterns)

    def multiplier_for(self, category_slug: str | None) -> float:
        """Multiplier this card earns on a transaction in ``category_slug``.

        Returns the base multiplier when the slug isn't in the boost map
        (or is None). Annual-cap enforcement happens at the optimizer
        layer because it requires running spend totals — this method
        just returns the headline rate.
        """
        if category_slug and category_slug in self.category_multipliers:
            return self.category_multipliers[category_slug]
        return self.base_multiplier


_DEFAULT_YAML_PATH = Path(__file__).parent / "card_rewards.yaml"

_loaded: list[CardRewardProfile] | None = None


def load_profiles(path: Path | None = None) -> list[CardRewardProfile]:
    """Lazily load + cache the profile list.

    Pass ``path`` to load a custom file (useful for tests). The default
    cache is keyed on no path; tests with custom paths bypass it.
    """
    global _loaded
    if path is None and _loaded is not None:
        return _loaded
    target = path or _DEFAULT_YAML_PATH
    # See card_applications/__init__.py — explicit UTF-8 to avoid the
    # cp1252 mojibake bug on Windows.
    raw = yaml.safe_load(target.read_text(encoding="utf-8")) or []
    profiles: list[CardRewardProfile] = []
    for entry in raw:
        profiles.append(
            CardRewardProfile(
                name=entry["name"],
                name_patterns=tuple(entry.get("name_patterns") or []),
                base_multiplier=float(entry.get("base_multiplier", 1.0)),
                category_multipliers={
                    k: float(v) for k, v in (entry.get("category_multipliers") or {}).items()
                },
                annual_caps_cents={
                    k: int(v) for k, v in (entry.get("annual_caps_cents") or {}).items()
                },
                notes=entry.get("notes", ""),
            )
        )
    if path is None:
        _loaded = profiles
    return profiles
