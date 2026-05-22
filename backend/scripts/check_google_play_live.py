"""Live-data probe for the Google Play receipt parser — Sprint 53.

Standalone stdlib-sqlite3 script (no SQLAlchemy, no config, no slow API).
Queries ``finance.db`` directly to answer the questions a "user-driven
verification" run should answer:

  * How many emails from Google Play (or any Google Play-receipt-like
    sender) are in the DB?
  * Of those, how many were parsed by ``google_play_receipt``?
  * Of those, what's the parser_outcome breakdown — parsed / ignored /
    failed?
  * Show the 10 most recent matches with subject + outcome, so the user
    can spot-check whether the parser's matching the right shapes.

Why bypass the API: ``GET /api/gmail/messages?parser=google_play_receipt``
does a full-table scan + SQLAlchemy row-hydration that's slow on a
multi-thousand-row mailbox. Direct sqlite3 returns the same data in
sub-second time.

Run::

    cd backend
    py scripts\\check_google_play_live.py
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from textwrap import shorten


def _resolve_db_path() -> Path:
    """Find finance.db relative to backend/. Allow CLI override."""
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    # Default: backend/finance.db (relative to this script's parent-parent).
    return Path(__file__).resolve().parent.parent / "finance.db"


def _print_header(title: str) -> None:
    print()
    print("=" * 60)
    print(title)
    print("=" * 60)


def _hr() -> None:
    print("-" * 60)


def main() -> int:
    db_path = _resolve_db_path()
    if not db_path.exists():
        print(f"ERROR: finance.db not found at {db_path}")
        print("Pass a path as the first arg if it's elsewhere:")
        print(f"  py scripts\\check_google_play_live.py <path-to-finance.db>")
        return 1
    print(f"Using DB: {db_path}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # 1. Sender breakdown — anything from google.com that looks Play-ish.
    _print_header("Section 1 — Emails from google.com domains")
    cur.execute(
        """
        SELECT from_domain, COUNT(*) AS n
        FROM email_messages
        WHERE from_domain LIKE '%google.com%'
        GROUP BY from_domain
        ORDER BY n DESC
        """
    )
    rows = list(cur.fetchall())
    if not rows:
        print("  (no google.com emails in DB — Gmail sync may not be set up)")
    else:
        for r in rows:
            print(f"  {r['from_domain']:<40} {r['n']:>6}")

    # 2. parser_name breakdown — which parsers have claimed messages?
    _print_header("Section 2 — Parser attribution across ALL emails")
    cur.execute(
        """
        SELECT parser_name, parser_outcome, COUNT(*) AS n
        FROM email_messages
        GROUP BY parser_name, parser_outcome
        ORDER BY parser_name IS NULL, parser_name, parser_outcome
        """
    )
    rows = list(cur.fetchall())
    if not rows:
        print("  (table empty)")
    else:
        for r in rows:
            name = r["parser_name"] or "<no-match>"
            print(f"  {name:<32} {r['parser_outcome']:<10} {r['n']:>6}")

    # 3. Just google_play_receipt outcomes.
    _print_header("Section 3 — google_play_receipt outcome breakdown")
    cur.execute(
        """
        SELECT parser_outcome, COUNT(*) AS n
        FROM email_messages
        WHERE parser_name = 'google_play_receipt'
        GROUP BY parser_outcome
        """
    )
    rows = list(cur.fetchall())
    if not rows:
        print("  (no rows yet attributed to google_play_receipt)")
        print("  Either no Google Play receipts have synced, OR the parser")
        print("  isn't catching them. Section 4 below will show whether")
        print("  Play-looking emails are landing under a different parser.")
    else:
        total = sum(r["n"] for r in rows)
        print(f"  {'Total google_play_receipt rows':<35} {total:>6}")
        _hr()
        for r in rows:
            print(f"  {r['parser_outcome']:<35} {r['n']:>6}")

    # 4. Heuristic search: emails likely to be Play receipts but NOT
    # claimed by the google_play_receipt parser. Two heuristics OR'd:
    #   - subject contains "Google Play" (case-insensitive)
    #   - body_plain contains "GPA." (the order-number prefix)
    _print_header("Section 4 — Play-shaped emails NOT picked up by parser")
    cur.execute(
        """
        SELECT id, from_address, subject, parser_name, parser_outcome,
               substr(body_plain, 1, 160) AS body_head
        FROM email_messages
        WHERE (parser_name IS NULL OR parser_name != 'google_play_receipt')
          AND (
            lower(subject) LIKE '%google play%'
            OR body_plain LIKE '%GPA.%'
          )
        ORDER BY received_at DESC
        LIMIT 10
        """
    )
    rows = list(cur.fetchall())
    if not rows:
        print("  (none — every Play-shaped email is being matched)")
    else:
        print(f"  Found {len(rows)} likely-Play emails missed by the parser.")
        print("  Spot-check whether these should be matched (parser fix needed)")
        print("  or are genuinely off-shape (e.g. Play-store family alerts).")
        for r in rows:
            _hr()
            print(f"  id={r['id']}  from={r['from_address']}")
            subj = shorten(r["subject"] or "(no subject)", width=70, placeholder="…")
            print(f"  subject  : {subj}")
            print(f"  parser   : {r['parser_name'] or '<none>'} / {r['parser_outcome']}")
            head = (r["body_head"] or "").replace("\n", " ⏎ ").replace("\r", "")
            print(f"  body[..160]: {shorten(head, width=80, placeholder='…')}")

    # 5. Sample 10 most recent SUCCESSFUL google_play_receipt parses.
    _print_header("Section 5 — Most recent google_play_receipt = parsed")
    cur.execute(
        """
        SELECT id, from_address, subject, received_at
        FROM email_messages
        WHERE parser_name = 'google_play_receipt'
          AND parser_outcome = 'parsed'
        ORDER BY received_at DESC
        LIMIT 10
        """
    )
    rows = list(cur.fetchall())
    if not rows:
        print("  (no parsed Google Play receipts in DB yet)")
    else:
        for r in rows:
            subj = shorten(r["subject"] or "", width=70, placeholder="…")
            print(f"  {r['received_at'][:10]}  id={r['id']:<6}  {subj}")

    print()
    print("Done. If Section 4 has rows, those are the misses worth investigating.")
    print("If Section 3 + 5 are empty, run a Gmail sync first via the UI's")
    print("'Sync Gmail' button on the Gmail panel — the parser only attributes")
    print("rows it sees during a sync, not retroactively unless /reparse runs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
