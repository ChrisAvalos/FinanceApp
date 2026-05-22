"""Bundle-overlap detection — Wave E.

Cross-references active Subscription rows against a knowledge base of
ISP / cellular / cable / card "bundles" (perks included with a parent
plan). When a user is paying for a perk standalone AND has the parent
bundle active, the detector flags the duplicate so the user can cancel
the standalone and activate via the bundle.

This is the "unique angle" feature called out in the project memory —
no money moves; we just surface the finding with a script for the user
to act on.
"""
from __future__ import annotations

from .loader import (
    BundleEntry,
    PerkEntry,
    load_bundles,
    reset_cache_for_tests,
)
from .detector import (
    BundleOverlap,
    detect_overlaps,
    _detect_from_subs,
)

__all__ = [
    "BundleEntry",
    "PerkEntry",
    "BundleOverlap",
    "load_bundles",
    "detect_overlaps",
    "_detect_from_subs",
    "reset_cache_for_tests",
]
