"""SQLAlchemy engine + session factory."""
from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from finance_app.config import settings

_IS_SQLITE = settings.database_url.startswith("sqlite")

# check_same_thread=False lets FastAPI's threadpool hand sessions around safely
engine = create_engine(
    settings.database_url,
    connect_args={"check_same_thread": False} if _IS_SQLITE else {},
    echo=False,
    future=True,
)

if _IS_SQLITE:
    # SQLite's default rollback-journal mode takes an exclusive lock on the
    # whole database during any write transaction — concurrent readers get
    # "database is locked" immediately. WAL (write-ahead logging) lets
    # readers and the single writer coexist: readers see a consistent
    # snapshot while the writer appends to the WAL file. busy_timeout
    # adds a grace window (5s) so brief contention waits silently instead
    # of erroring. foreign_keys=ON matches the behavior Alembic migrations
    # assume. synchronous=NORMAL is the WAL-recommended durability level.
    @event.listens_for(engine, "connect")
    def _configure_sqlite_connection(dbapi_connection, _connection_record) -> None:  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            # Bumped from 5s → 30s. Gmail sync writes hundreds of rows
            # in one transaction (one EmailMessage + parser side effects
            # per inbox row), and the scheduler runs subscription
            # detection every 6h. When the two collide on a fresh sync
            # the 5s window wasn't enough — Gmail sync would 502 with
            # "database is locked". 30s is comfortably longer than any
            # legitimate writer should hold the WAL.
            cursor.execute("PRAGMA busy_timeout=30000")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA foreign_keys=ON")
        finally:
            cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def get_db() -> Iterator[Session]:
    """FastAPI dependency — yields a request-scoped session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
