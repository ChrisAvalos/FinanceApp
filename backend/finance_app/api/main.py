"""FastAPI entry point.

    uvicorn finance_app.api.main:app --reload
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse

from finance_app.api import (
    accounts,
    anomaly,
    balance_scrapers,
    benefits,
    budgets,
    bundles as bundles_api,
    card_applications,
    canonical_products,
    cashflow,
    categories,
    chat,
    credit,
    deals,
    fire,
    gmail,
    goals,
    heatmap,
    holdings,
    hsa,
    ingest,
    insights,
    legal_claims,
    merchants,
    money_on_table,
    networth,
    notifications,
    offers,
    plaid,
    prime,
    receipts,
    recurring,  # Sprint O-2: recurring-bills detection
    redress,
    rules,
    savings,
    setup,
    shopping_patterns as shopping_patterns_api,
    stats,
    subscriptions,
    tax,
    transactions,
    unclaimed,
    yield_opt,
)
from finance_app.config import settings
from finance_app.db.migrations import apply_auto_migrations
from finance_app.db.models import Base, Category
from finance_app.db.seed import ensure_categories, load_seed_rules
from finance_app.db.session import SessionLocal, engine
from finance_app.scheduler import start_scheduler, stop_scheduler


def _warm_up_ollama() -> None:
    """Send a tiny generate request so Ollama loads the model into RAM.

    Cold-start latency for Llama 3.1 8B on CPU is brutal (30-60s on the
    first call). We pay it once here in the background so the user's
    first chat question / categorization fallback isn't the one that
    waits. Errors are swallowed — if Ollama isn't running, the rest of
    the app keeps working and the user will see a "model unreachable"
    state in the UI.
    """
    try:
        from finance_app.llm import get_client  # local import — keeps startup fast
    except Exception as exc:  # noqa: BLE001
        print(f"[ollama-warmup] skipped — llm module import failed: {exc!r}")
        return
    client = get_client()
    if not client.is_available():
        print("[ollama-warmup] skipped — Ollama not reachable at startup")
        return
    import time
    t0 = time.monotonic()
    try:
        # Single-token reply is enough to force model load; the actual
        # text doesn't matter, only that Ollama has the weights paged in.
        client.generate("Reply with a single word: ready", max_tokens=4)
    except Exception as exc:  # noqa: BLE001
        print(f"[ollama-warmup] generate failed after {time.monotonic() - t0:.1f}s: {exc!r}")
        return
    print(f"[ollama-warmup] model loaded in {time.monotonic() - t0:.1f}s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables if missing — lets `make dev` work without alembic for now.
    Base.metadata.create_all(bind=engine)
    # Apply additive column migrations (create_all doesn't ALTER existing tables).
    added = apply_auto_migrations(engine)
    if added:
        # Print, not log — keeps parity with uvicorn's stdout logging in dev.
        for table, cols in added.items():
            print(f"[auto-migrations] {table}: added columns {cols}")
    # Idempotent baseline-seed for categories + seed rules. Categorization
    # silently degrades to "Uncategorized" without these, so we ensure them
    # at every startup. Cheap (single existence check on the categories
    # table); only writes when missing.
    try:
        with SessionLocal() as db:
            existing = db.query(Category).count()
            if existing == 0:
                cat_map = ensure_categories(db)
                load_seed_rules(db, cat_map)
                db.commit()
                print(f"[startup-seed] populated categories + seed rules ({len(cat_map)} categories)")
    except Exception as exc:  # noqa: BLE001 — startup must not crash on seed errors
        print(f"[startup-seed] failed: {exc!r}")
    # Kick off APScheduler if enabled. Safe no-op when disabled.
    start_scheduler()
    # Warm Ollama in the background so chat / T3 categorization don't
    # pay cold-start latency on the user's first request. Fire-and-forget
    # in a daemon thread — startup must not block on this.
    import threading
    threading.Thread(
        target=_warm_up_ollama, name="ollama-warmup", daemon=True
    ).start()
    try:
        yield
    finally:
        stop_scheduler()


app = FastAPI(
    title="Finance App",
    version="0.1.0",
    description="Local-first personal finance engine.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(accounts.router, prefix="/api")
app.include_router(transactions.router, prefix="/api")
app.include_router(categories.router, prefix="/api")
app.include_router(rules.router, prefix="/api")
app.include_router(ingest.router, prefix="/api")
app.include_router(stats.router, prefix="/api")
app.include_router(subscriptions.router, prefix="/api")
app.include_router(plaid.router, prefix="/api")
# Sprint 43 — Albert / future neobank balance scrapers.
app.include_router(balance_scrapers.router, prefix="/api")
app.include_router(gmail.router, prefix="/api")
app.include_router(budgets.router, prefix="/api")
# Sprint O-2: recurring-bills detection — its own router so we don't have
# to touch the corruption-prone budgets.py for this feature.
app.include_router(recurring.router, prefix="/api")
app.include_router(credit.router, prefix="/api")
app.include_router(legal_claims.router, prefix="/api")
app.include_router(goals.router, prefix="/api")
app.include_router(savings.router, prefix="/api")
# Sprint 46 — first-run setup checklist endpoint.
app.include_router(setup.router, prefix="/api")
app.include_router(insights.router, prefix="/api")
app.include_router(offers.router, prefix="/api")
app.include_router(notifications.router, prefix="/api")
app.include_router(networth.router, prefix="/api")
app.include_router(merchants.router, prefix="/api")
app.include_router(cashflow.router, prefix="/api")
app.include_router(tax.router, prefix="/api")
app.include_router(unclaimed.router, prefix="/api")
app.include_router(benefits.router, prefix="/api")
app.include_router(bundles_api.router, prefix="/api")
app.include_router(yield_opt.router, prefix="/api")
app.include_router(card_applications.router, prefix="/api")
app.include_router(redress.router, prefix="/api")
app.include_router(money_on_table.router, prefix="/api")
app.include_router(holdings.router, prefix="/api")
app.include_router(hsa.router, prefix="/api")
app.include_router(anomaly.router, prefix="/api")
app.include_router(heatmap.router, prefix="/api")
app.include_router(receipts.router, prefix="/api")
app.include_router(shopping_patterns_api.router, prefix="/api")
app.include_router(deals.router, prefix="/api")
app.include_router(canonical_products.router, prefix="/api")
app.include_router(fire.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(prime.router, prefix="/api")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# Minimal HTML dashboard — so you can verify the pipeline without running the
# React app. Replaced by the real Vite app in Phase 2.
INDEX_HTML = (Path(__file__).parent / "static" / "index.html").resolve()


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def root() -> str:
    if INDEX_HTML.exists():
        return INDEX_HTML.read_text()
    return "<h1>Finance App</h1><p>API up. See <a href='/docs'>/docs</a>.</p>"
