"""Rewards-optimizer package.

Compares each transaction against the rewards profile of every linked
card and surfaces the dollar value Chris left on the table by using a
suboptimal card. Pure deterministic math — no LLM, no scraping. Card
profiles live in ``card_rewards.yaml`` and are loaded at module import
via :mod:`profiles`.
"""
from .optimizer import (
    RewardLeakageReport,
    TransactionAnalysis,
    analyze_transactions,
)
from .profiles import CardRewardProfile, load_profiles

__all__ = [
    "CardRewardProfile",
    "RewardLeakageReport",
    "TransactionAnalysis",
    "analyze_transactions",
    "load_profiles",
]
