"""Phase D — savings & debt-payoff engine.

Two responsibilities:

* :mod:`surplus` computes "how much room is in the budget" from two angles —
  historical (what actually happened over the trailing 30d) and forecast
  (what's projected to happen over the next 30d).
* :mod:`suggestions` consumes the surplus + Phase B subscription data + the
  user's goals and produces actionable recommendations: "move $X to your
  emergency fund," "cancel Y, save $Z/mo," "if you funnel surplus to debt A
  instead of B, you save $W in interest." Every recommendation comes with
  before/after math.

Hard rules (project memory, 2026-04-23):
- App NEVER moves money. Suggestions only.
- Every recommendation must show current state + projected if act +
  projected if don't act.
"""
