.PHONY: install dev db seed test lint clean smoke

install:
	pip install -e ".[dev]"

dev:
	uvicorn finance_app.api.main:app --reload --host 0.0.0.0 --port 8000

db:
	alembic upgrade head

seed:
	python -m finance_app.db.seed

test:
	pytest -v

lint:
	ruff check finance_app tests
	ruff format --check finance_app tests

format:
	ruff format finance_app tests

smoke:
	python scripts/smoke_test.py

clean:
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type d -name .pytest_cache -exec rm -rf {} +
	rm -f finance.db
