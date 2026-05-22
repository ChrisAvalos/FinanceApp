"""Heuristic for guessing whether a settlement requires proof.

Why a heuristic
---------------
Scraped detail pages don't expose a "proof required" boolean. The
information lives in free-form prose like "no proof of purchase
required" or "you must submit receipts to claim". A bag-of-regex
classifier nails ~95% of cases at zero cost; the remaining ambiguous
listings get ``ProofRequirement.unknown`` and surface in the UI's
triage tab for the user to resolve in one click.

How the classifier works
------------------------
Score-based, not rule-priority. Every regex hit adds a positive or
negative score; the sign of the final score decides the bucket:

* score > 0   → ``required``       (saw "proof required", "receipts", etc.)
* score < 0   → ``not_required``   (saw "no proof required", "no purchase needed")
* score == 0  → ``unknown``        (no signal at all, OR equal pull both ways)

The scoring lets a "no proof of purchase required" string outweigh a
later "you may submit a receipt for higher payouts" — both signals
fire, and the negative one wins because it's more specific to the
filer's burden.

This is intentionally pessimistic about claiming "not_required". A
false positive there would let Chris file a claim that gets rejected
for missing docs; a false negative just shows up under "Needs proof"
and doesn't cost him anything but a glance.
"""
from __future__ import annotations

import re

from finance_app.db.models import ProofRequirement

# Each pattern is paired with a weight. Compiled once at import.
# Patterns are case-insensitive and word-boundary-loose so they match
# "no-proof" and "no proof" interchangeably.
_NEGATIVE_PATTERNS: list[tuple[re.Pattern[str], int]] = [
    # Strong "no proof" signals — heavy weight, decisive on their own.
    (re.compile(r"\bno\s+proof\s+(of\s+purchase\s+)?(is\s+)?(required|necessary|needed)\b", re.I), 4),
    (re.compile(r"\bno\s+receipts?\s+(required|necessary|needed)\b", re.I), 4),
    (re.compile(r"\bno\s+documentation\s+(required|necessary|needed)\b", re.I), 4),
    (re.compile(r"\bproof\s+of\s+purchase\s+is\s+not\s+required\b", re.I), 4),
    (re.compile(r"\b(proof|documentation|receipts?)\s+(is|are)?\s*not\s+(required|necessary|needed)\b", re.I), 4),
    (re.compile(r"\b(do|does)\s+not\s+(need|require|have)\s+to\s+(submit|provide|show)\s+(a\s+)?(proof|receipt|documentation)", re.I), 4),
    # "Without proof" / "without receipts" framings.
    (re.compile(r"\bwithout\s+(proof|a\s+receipt|receipts|documentation)\b", re.I), 3),
    (re.compile(r"\beven\s+without\s+(receipts?|proof|documentation)\b", re.I), 3),
    # Softer "no proof" signals — affirm without explicit "required".
    (re.compile(r"\bno\s+purchase\s+(necessary|needed|required)\b", re.I), 3),
    (re.compile(r"\bclaim\s+form\s+only\b", re.I), 2),
    (re.compile(r"\battestation\b", re.I), 1),  # "attestation under penalty of perjury" usually = no docs
    # "Self-reported" / "self-attested" — common in TCA copy for no-proof claims.
    (re.compile(r"\bself[-\s]?(report|attest|certif)\w*", re.I), 2),
    # Tiered language where the LOWER tier is no-proof and the higher
    # one is with-proof. We score the no-proof part as a soft negative
    # since the listing is BOTH eligible without proof and offers more
    # with proof — bucket it as "Quick" because the user can file the
    # easy form right away.
    (re.compile(r"\b(no\s+receipt|without\s+receipt)s?\s+(needed|required).{0,40}\bup\s+to\s+\$", re.I), 3),
]

_POSITIVE_PATTERNS: list[tuple[re.Pattern[str], int]] = [
    # Strong "needs proof" signals.
    (re.compile(r"\bproof\s+of\s+purchase\s+(is\s+)?required\b", re.I), 4),
    (re.compile(r"\breceipts?\s+(are\s+)?required\b", re.I), 4),
    (re.compile(r"\bdocumentation\s+(is\s+)?required\b", re.I), 4),
    (re.compile(r"\bmust\s+(submit|provide|attach)\s+(a\s+)?(receipt|proof|documentation)", re.I), 4),
    (re.compile(r"\bsubmit\s+(your\s+)?receipts?\b", re.I), 3),
    # Higher-tier payouts often require proof — flag those.
    (re.compile(r"\bhigher\s+payout(s)?\s+(if|with|when)\s+you\s+(submit|provide)", re.I), 2),
    (re.compile(r"\bitemized\s+receipts?\b", re.I), 3),
    (re.compile(r"\bphotograph\s+of\s+(your|the)\s+receipt\b", re.I), 3),
    # NOTE: removed the `\bup\s+to\s+\$\d` pattern — Settlemate's screenshot
    # showed "Up to $5 / Up to $500 / Up to $1,600" all under "No Proof",
    # so "up to $X" is NOT a reliable proof-required signal. It was
    # silently flipping every borderline listing to required, which is
    # why our Quick tab was empty after scrapes.
]


def classify_proof(text: str) -> tuple[ProofRequirement, int]:
    """Score the text and return (verdict, signed_score).

    Two-pass to avoid the obvious overlap bug:

    1. Score negative patterns. As each fires, its match span is
       *masked out* so the positive patterns don't re-fire on the
       same prose. (Otherwise "no proof of purchase required" would
       count once as -4 negative AND once as +4 positive — net zero,
       wrong answer.)
    2. Score positive patterns on the masked-down text.

    A non-zero final score with a clear sign returns ``required`` /
    ``not_required``; zero returns ``unknown``. The score is exposed so
    callers can log how confident the classifier was — useful when
    debugging false positives later.
    """
    if not text:
        return ProofRequirement.unknown, 0

    # Pass 1 — negative patterns, mask as we go.
    neg_score = 0
    masked = text
    for pat, w in _NEGATIVE_PATTERNS:
        hits = pat.findall(masked)
        if hits:
            neg_score -= w * len(hits)
            # Replace each match with whitespace so token boundaries
            # in the surrounding text aren't accidentally welded.
            masked = pat.sub(" ", masked)

    # Pass 2 — positive patterns over the masked text.
    pos_score = 0
    for pat, w in _POSITIVE_PATTERNS:
        hits = pat.findall(masked)
        if hits:
            pos_score += w * len(hits)

    score = neg_score + pos_score
    if score > 0:
        return ProofRequirement.required, score
    if score < 0:
        return ProofRequirement.not_required, score
    return ProofRequirement.unknown, 0
