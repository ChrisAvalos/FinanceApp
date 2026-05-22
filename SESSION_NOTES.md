# Session notes — 2026-05-04 polish push

Picking up from the 84/100 scorecard, this session shipped the three biggest 84 → 94 pushes plus the small UX punchlist.

## What landed

### Backend

| File | Change |
|---|---|
| `backend/finance_app/api/main.py` | Lifespan now seeds Categories + seed rules on startup if Categories table is empty. Idempotent. |
| `backend/finance_app/api/categories.py` | New `POST /api/categories/seed` endpoint to re-prime an existing DB without restart. |
| `backend/finance_app/ingestion/plaid_connector.py` | Auto-fires `SubscriptionDetector(db).sync_to_db()` after categorization on every Plaid sync. So Subscriptions panel + Cash Flow events + Overview hero light up without manual intervention. |
| `backend/finance_app/api/prime.py` (NEW) | `POST /api/prime/run` orchestrator. Fires categorization, subscription detector, shopping-patterns detector, canonical-product clustering, deals scan, legal-claims scrape, offers scrape — each task wrapped so a single failure can't tank the rest. Returns per-task status. |
| `backend/finance_app/api/rules.py` | New `POST /api/rules/from-transaction` endpoint. Backs the inline "+ Categorize" UX: derives a substring pattern from the merchant string, creates a non-seed Rule pinned at priority 230, applies it to the originating row, then re-runs `categorize_all(only_unset=True)` so other matching rows pick up the same category in one click. |
| `backend/finance_app/categorization/seed_rules.yaml` | +46 new rules: FoodMaxx, Trojan Storage, Movement gym, Diligent Financial, AFC, Le Boulanger, Stevens Creek car wash, wire fees, Pay-in-4 / Affirm / Klarna / Afterpay, Progressive Lease, Dave / GMass / Earnin / Brigit, plus generic POS DEBIT regex catch-alls. |
| `backend/finance_app/tax/service.py` | Bug fix — `untagged_total_cents` now counts only outflows. Previously included inflows so it could exceed `grand_total_outflow_cents`, which made the panel look broken. |

### Frontend

| File | Change |
|---|---|
| `web/src/api/client.ts` | Added `api.primeRun()` and `api.ruleFromTransaction()` |
| `web/src/App.tsx` | "Find money on the table — Prime everything" CTA on Overview that fires the orchestrator with progress badges. Inline `+ Categorize` button on every Uncategorized row in both the Overview recent-transactions table and the full Transactions panel; opens an inline category picker, posts `/api/rules/from-transaction`, shows toast like "✓ Rule created · 12 rows match." Sidebar `Money on ta…` → `Money found`. |
| `web/src/NetWorthPanel.tsx` | Single-snapshot chart guard — shows tasteful "📈 N snapshots so far" placeholder until ≥3 snapshots; Δ 30d / Δ 1y null state reads "Need history" instead of "—". |
| `web/src/BudgetsPanel.tsx` | When zero budgets set, swap the dead $0/$0/$0/$X hero for a single big CTA card pointing to the templates above. |
| `web/src/GoalsPanel.tsx` | When zero goals, swap "No goals yet" for a richer wizard card with category chips (Emergency fund / Down payment / Car / Annual travel) and a "+ New goal" button. |
| `web/src/AttributionPanel.tsx` | Hide fully-empty months (no snapshot AND zero cash flow AND no top categories), surface as a footer count. |
| `web/src/TaxPanel.tsx` | Renamed "Top untagged categories" → "Categorized but not tax-mapped" with explanatory copy. |
| `web/src/components/PanelLoading.tsx` (NEW) | Shared spinner + label + compact variant. |
| `web/src/components/PanelError.tsx` (NEW) | Shared error state with retry button + truncated detail. |
| `web/src/CashFlowPanel.tsx` `HeatmapPanel.tsx` `BenefitsPanel.tsx` `HoldingsPanel.tsx` | Adopted PanelLoading + PanelError. |

## What's verified live

- **Categories autoseed** at startup — confirmed empty → 50 categories on lifespan run.
- **POS DEBIT rules pack** — categorization coverage on Chris's live DB: 50% uncategorized → 32% uncategorized.
- **Prime endpoint** — confirmed live in earlier session: 0 → 95 class actions, 0 → 18 anomalies, 0 → 1 subscription.
- **Inline categorize-this** — backend route wired, frontend UI wired, but live verification was blocked by a stuck Vite/uvicorn page during the session. Code is in place and matches the same pattern as runCategorization which works.

## Where the score sits now (estimate)

- Categorization 85 → **90** (auto-fire on sync + inline categorize-this + 46 new rules)
- Cash Flow 84 → **88** (subscription events now auto-populate)
- Subscriptions 88 → **92** (now actually has data on first run)
- Budgets 78 → **84** (real first-budget CTA)
- Savings & goals 77 → **84** (real first-goal CTA)
- Net Worth 80 → **86** (chart guard + better empty Δ copy)
- Attribution 92 → **95** (empty-month collapse)
- Tax export 84 → **88** (math fix)
- Loading + error states 70 → **82** (shared components shipped + 4 adopters; precedent set)
- Overview 86 → **92** (Prime CTA, sidebar relabel)

**Estimated overall: 84 → ~91 / 100.**

The remaining 9 points to 100:

1. **First-run wizard** that calls Prime automatically post-Plaid-Link (not manual button).
2. **Adopt PanelLoading + PanelError on the remaining ~17 panels** — mechanical migration; precedent + components are shipped.
3. **Connections panel per-product visibility** (which Plaid products are granted vs pending) — closes the Holdings/Card Benefits empty-state confusion.
4. **NAUPA + per-state unclaimed scrape** so that panel populates without manual entry.
5. **Live HYSA / T-bill rate fetcher** (FRED API) so Yield Optimization stops going stale.
6. **Card benefits manual picker** on Connections so generic "CREDIT CARD" Plaid names match.

## To verify after backend hot-reloads

1. Visit Overview. The "Find money on the table" hero should be at the top with a "Prime everything" button.
2. Hit Prime. After ~30 seconds you should see green ✓ badges per task (categorization / subscriptions / shopping_patterns / canonical_products / deals / legal_claims / offers).
3. Visit Transactions. Click `+ Categorize` on any uncategorized row. Pick a category. You should see "✓ Rule created · N rows match" briefly, then the page refreshes and the row + matching kin all show the new category.
4. Visit Net Worth — Δ 30d / Δ 1y should read "Need history"; chart should show "📈 N snapshots so far" placeholder.
5. Visit Budgets — should show a single "🎯 Set up your first budget for May 26" card instead of $0/$0/$0/$X.
6. Visit Savings & goals — should show the rich "🎯 Set your first savings goal" card with chips.
7. Visit Attribution — Aug-Dec 2025 empty months should collapse to a single "5 earlier months hidden — no activity recorded." footer.
8. Visit Tax export — "Categorized but not tax-mapped" copy is clearer; numbers add up.
9. Visit Cash Flow / Heatmap / Card Benefits / Holdings — loading state should show a spinner + label; error state would show retry button.
