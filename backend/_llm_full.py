from finance_app.db.session import SessionLocal
from finance_app.categorization.llm_fallback import (
    _list_leaf_categories, _PROMPT_TEMPLATE, _parse_slug
)
from finance_app.llm import get_client

db = SessionLocal()
cats = _list_leaf_categories(db)
slug_list = '\n'.join(f'  - {c.slug}' for c in cats)
prompt = _PROMPT_TEMPLATE.format(slug_list=slug_list, merchant='AVOKATO ATO SJO ALAJUELA 02/01')

raw = get_client().generate(prompt, json_mode=True, temperature=0.0, max_tokens=80)
print('--- RAW OUTPUT ---')
print(repr(raw))
print('--- PARSED ---')
print(_parse_slug(raw))
