"""Card-applications support module — best-bonuses catalog loader.

The catalog itself lives next door in ``best_bonuses.yaml``; this
module exposes a typed loader so the API can serve the list with
caching.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import yaml


@dataclass(frozen=True)
class BestBonus:
    """One entry in the curated welcome-bonus catalog."""
    card_name: str
    issuer: str
    bonus_points: int
    bonus_dollar_value_cents: int
    minimum_spend_cents: int
    minimum_spend_months: int
    annual_fee_cents: int
    counts_toward_5_24: bool
    chase_5_24_friendly: bool
    notes: str
    product_url: str


_loaded: list[BestBonus] | None = None
_PATH = Path(__file__).parent / "best_bonuses.yaml"


def load_best_bonuses(path: Path | None = None) -> list[BestBonus]:
    """Load + cache. Reload when ``path`` is passed (test seam)."""
    global _loaded
    if path is None and _loaded is not None:
        return _loaded
    target = path or _PATH
    if not target.exists():
        return []
    # Pin UTF-8 explicitly: Path.read_text() defaults to the OS locale,
    # which on Windows is cp1252. The YAML contains em-dashes and other
    # non-ASCII chars (— in card descriptions); without this they decode
    # as `â€"` mojibake by the time the response hits the frontend.
    raw = yaml.safe_load(target.read_text(encoding="utf-8")) or []
    out: list[BestBonus] = []
    for entry in raw:
        out.append(
            BestBonus(
                card_name=entry["card_name"],
                issuer=entry["issuer"],
                bonus_points=int(entry.get("bonus_points", 0) or 0),
                bonus_dollar_value_cents=int(entry.get("bonus_dollar_value", 0) or 0),
                minimum_spend_cents=int(entry.get("minimum_spend_cents", 0) or 0),
                minimum_spend_months=int(entry.get("minimum_spend_months", 0) or 0),
                annual_fee_cents=int(entry.get("annual_fee_cents", 0) or 0),
                counts_toward_5_24=bool(entry.get("counts_toward_5_24", True)),
                chase_5_24_friendly=bool(entry.get("chase_5_24_friendly", True)),
                notes=str(entry.get("notes", "")),
                product_url=str(entry.get("product_url", "")),
            )
        )
    if path is None:
        _loaded = out
    return out


def iter_best_bonuses_ranked(filter_chase_5_24: bool | None = None) -> Iterator[BestBonus]:
    """Yield the catalog ranked by bonus_dollar_value descending.

    ``filter_chase_5_24=True`` only yields entries marked as 5/24-
    friendly. Default None returns everything.
    """
    bonuses = sorted(
        load_best_bonuses(),
        key=lambda b: b.bonus_dollar_value_cents,
        reverse=True,
    )
    for b in bonuses:
        if filter_chase_5_24 is True and not b.chase_5_24_friendly:
            continue
        yield b


__all__ = ["BestBonus", "load_best_bonuses", "iter_best_bonuses_ranked"]
