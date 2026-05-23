"""Pytest fixtures for the Finance App backend test suite."""
from __future__ import annotations

import os
import sys

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

# Make `finance_app` (backend/) and the local `factories` module
# (backend/tests/) importable regardless of how pytest is invoked.
_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
for _p in (_BACKEND, _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from finance_app.db.models import Base


@pytest.fixture
def db():
    """A fresh in-memory SQLite database with the full schema, per test.

    StaticPool keeps the single in-memory connection alive for the whole
    test so every session operation sees the same database.
    """
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=True, future=True)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()
