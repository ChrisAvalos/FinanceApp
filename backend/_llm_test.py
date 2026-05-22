from finance_app.llm import get_client
client = get_client()
raw = client.generate(
    'You are a categorization helper. Reply ONLY with JSON like {\"slug\":\"food.restaurants\"} '
    'where slug is one of: food.restaurants, food.coffee, personal.travel, financial.transfer, shopping.household. '
    'Merchant: AVOKATO ATO SJO ALAJUELA. Reply:',
    json_mode=True
)
print('RAW LLM OUTPUT:', repr(raw))
