"""Re-run state extraction + proof heuristic over existing legal_claims rows.

Why this exists
---------------
We tightened the proof heuristic and added state extraction in one batch.
Existing rows scraped *before* the change still carry the old (often
wrong) ``proof_status=unknown`` and the default ``state_eligibility=
"nationwide"``. Re-scraping would re-fetch from the network and is
slower than necessary — we already have the description text in the DB.

This script walks every available row and re-classifies in place:

    py -m scripts.reclassify_legal_claims

Idempotent. Safe to run repeatedly. Only touches rows in status=available
so the user's filed/paid lifecycle isn't disturbed. Skips rows the user
has manually triaged (we detect that via ``source = "manual"`` AND a
non-default proof_status — those are user-set and should stay put).

Output
------
Prints a summary like::

    Walked 142 available rows
      State extraction:
        nationwide: 89 (was: 142 unknown)
        CA: 18, FL: 12, TX: 9, NY: 7, IL: 4, ...
      Proof reclassification:
        not_required: 47 (was: 8)
        required: 31 (was: 24)
        unknown: 64 (was: 110)
"""
from __future__ import annotations

from collections import Counter

from sqlalchemy import select

from finance_app.db.models import LegalClaim, LegalClaimStatus, ProofRequirement
from finance_app.db.session import SessionLocal
from finance_app.scrapers.legal_claims.proof_heuristic import classify_proof
from finance_app.scrapers.legal_claims.state_parser import extract_states


def reclassify_all() -> None:
    db = SessionLocal()
    try:
        rows = list(
            db.execute(
                select(LegalClaim).where(LegalClaim.status == LegalClaimStatus.available)
            ).scalars().all()
        )
        before_proof = Counter(r.proof_status.value for r in rows)
        before_state = Counter((r.state_eligibility or "nationwide") for r in rows)

        proof_changed = 0
        state_changed = 0
        for r in rows:
            # Skip rows the user manually set (manual source + a non-unknown
            # proof_status implies they made a deliberate call).
            user_overrode_proof = (
                r.source == "manual" and r.proof_status != ProofRequirement.unknown
            )

            text = " ".join(filter(None, [
                r.name or "",
                r.eligibility or "",
                r.description or "",
            ]))

            new_state = extract_states(r.name or "", r.eligibility or "", r.description or "")
            if new_state != (r.state_eligibility or "nationwide"):
                r.state_eligibility = new_state
                state_changed += 1

            if not user_overrode_proof:
                new_proof, _score = classify_proof(text)
                if new_proof != r.proof_status:
                    r.proof_status = new_proof
                    proof_changed += 1

        db.commit()

        after_proof = Counter(r.proof_status.value for r in rows)
        after_state: Counter = Counter()
        for r in rows:
            for code in (r.state_eligibility or "nationwide").split(","):
                after_state[code.strip()] += 1

        print(f"Walked {len(rows)} available rows")
        print(f"  Updated proof_status on {proof_changed} rows")
        print(f"  Updated state_eligibility on {state_changed} rows")
        print()
        print("  Proof split (before → after):")
        for k in ("not_required", "required", "unknown"):
            print(f"    {k:15s} {before_proof.get(k, 0):4d} → {after_proof.get(k, 0):4d}")
        print()
        print("  State split (after, top 12):")
        for k, v in after_state.most_common(12):
            print(f"    {k:15s} {v:4d}")
    finally:
        db.close()


if __name__ == "__main__":
    reclassify_all()
