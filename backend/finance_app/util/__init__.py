"""Cross-cutting utilities shared across modules.

These don't belong to any single domain (api / ingestion / scrapers /
db) but are referenced by several. Keep them small and dependency-free
so importing this package doesn't pull in heavy stuff.
"""
