# Sprint N — EnrichedTransaction service

## The problem this fixes

Intelligence in the app is currently **scattered across endpoints** as hand-written heuristics. Each consumer (rollup, drawer, ledger, projection) computes its own answer to "what does this transaction mean" using its own copy of the rules. When two consumers need the same answer, they drift.

Bugs of this class shipped to user in the last 48 hours:
- Rent drawer missing Valeria Zelle (rollup applies rent-shift; drawer didn't)
- The `+$417` trust hole (real_budget excluded catchalls; total_actual didn't)
- Goal current $0 vs $400 (cache vs live)
- savings_actual gross vs net (one place sums positives; another nets)
- Financial donut at $6,550 (viz includes catchalls; rollup excludes)
- Stock Plan zombie row (DB inactive; Net Worth didn't filter)
- Donut Valeria miss (same rent-shift logic, third location)

Same shape: **two implementations of the same rule, one drifts**.

## The architectural shift

Replace scattered heuristics with **one enrichment service** that every endpoint calls.

```python
@dataclass(frozen=True)
class EnrichedTransaction:
    base: Transaction
    effective_month: date           # post rent-shift
    is_catchall: bool               # Transfer / Uncategorized / CC Payment / Investment
    is_payroll: bool                # Livio paychecks, future employers
    is_savings_transfer: bool       # Albert EDI etc.
    is_rent_like: bool              # used to drive effective_month shift
    is_paid_committed: bool         # actual >= 80% of cap for committed cat
    reasoning: list[str]            # provenance — each rule that fired

class EnrichmentService:
    """Computes EnrichedTransaction. One source of truth.
    Loads context (categories, recurring patterns) on init; per-txn
    enrichment is a pure transform.
    """
    def __init__(self, db: Session, *, today: date | None = None) -> None: ...
    def enrich(self, tx: Transaction) -> EnrichedTransaction: ...
    def enrich_batch(self, txns: list[Transaction]) -> list[EnrichedTransaction]: ...
```

Every consumer reads from this. New rule (e.g. "Wells Fargo EOM sweep = savings") goes in one place and propagates everywhere.

## Phases

### N-1: Service skeleton + classifier rules
Create `backend/finance_app/enrichment/` package. Move:
- `_is_payroll_desc` → `is_payroll(tx)`
- `_is_savings_outflow_desc` → `is_savings_transfer(tx)`
- `_is_catchall_cat` → `is_catchall(category_name)`
- `_is_rent_cat` → `is_rent_category(category_name)`

Keep the old names as aliases in `budgets.py` for now to avoid cascading breaks.

### N-2: Effective month + rent attribution
Move `_find_rent_like_txns` + `_RENT_SHIFT_DAY_CUTOFF` into `enrichment.effective_month`. Expose:
```python
def effective_month(tx: Transaction, ctx: Context) -> date
```
For Apr-30 rent-like txn → returns May 1.

### N-3: Batch enrichment
`enrich_batch(txns)` for performance. Builds context (category map, recurring outflow patterns) once. Returns list of EnrichedTransaction.

### N-4: Refactor `budgets.py` rollup
Replace inline heuristics with `service.enrich_batch(...)`. Rollup now iterates over EnrichedTransaction. **Zero semantic changes** — same outputs.

### N-5: Refactor `assignment-ledger`
Same swap.

### N-6: `/transactions` endpoint accepts `effective_month` filter
Add `effective_month: str | None = None` query param. When set, server enriches all candidate txns and filters by `enriched.effective_month` instead of `posted_date`.

### N-7: Drawer uses effective_month
CategoryDrawer queries `?effective_month=2026-05` instead of `start_date/end_date`. Rent drawer now automatically includes Valeria — **no special-casing**. Remove the `extraTxIds` / `rent_attributed_tx_ids` workaround.

### N-8: Reasoning surfaced
Each enrichment that fires appends a one-line note to `reasoning[]`. Console-loggable for now. UI provenance tooltips come in Sprint P.

### N-Z: Verification
Smoke test that compares full rollup output before vs after refactor. Must be byte-identical (modulo new fields).

## Scope, risk, mitigation

**Scope:** ~10 hours of careful refactoring. Touches budgets.py heavily.
**Risk:** breaking rollup outputs that the UI depends on.
**Mitigation:**
- v1 preserves EXACT current behavior (only location changes, not semantics).
- After each phase, run rollup against existing data and diff against pre-refactor JSON.
- Keep the old helpers as aliases until N-Z passes.

## What N does NOT cover

These are explicit follow-ups, not gaps:
- **Effective category** (post-Plaid-PFC / post-Gmail / post-composite-unmask) — bigger refactor touching categorization. Sprint after N.
- **LLM self-writing rules** — Sprint Q.
- **Invariant test suite** — Sprint O.
- **Provenance UI tooltips** — Sprint P.

## Success criteria

After Sprint N:
1. All "what does this txn mean" logic lives in `enrichment/`.
2. Rollup, drawer, ledger, projection all read from `EnrichedTransaction`.
3. Adding a new heuristic ("WF EOM sweep") requires editing **one file**.
4. The rent drawer bug class is **structurally impossible** — every consumer reads from the same effective_month value.
5. Each EnrichedTransaction carries `reasoning[]` — debuggable provenance.

## Sequencing within N

N-1 → N-2 → N-3 → N-4 → N-Z (smoke verify after rollup refactor). Then N-5, N-6, N-7, N-8 as separate increments since each is independently verifiable.

I'll execute in that order and pause for verification after N-4 before continuing.
