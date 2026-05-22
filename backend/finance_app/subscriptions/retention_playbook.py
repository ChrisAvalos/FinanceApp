"""Retention-negotiation playbook generator.

Given a Subscription row and (optionally) the user's transaction
history with that merchant, builds a structured negotiation script
the user can take into a phone call or chat session. Output is plain
data — no money moves, no calls placed automatically. The user does
the call; this just hands them the leverage points + counter-offers.

Why this matters
----------------
Calling retention to negotiate a sub is high-leverage but uncomfortable.
Most people don't because they don't know what to ask for or how to
phrase it. A script that surfaces the actual leverage (your usage
history, your tenure, competitor pricing) lowers the friction.

Output shape
------------
:class:`RetentionPlaybook` is a dataclass with:

  * ``opening_line`` — what to say first when you reach a human
  * ``leverage_points`` — list of factual statements pulled from data
  * ``counter_offers`` — list of specific things to ask for, sorted
    most→least desirable
  * ``walkaway_line`` — the "OK, then please cancel my account" line
  * ``estimated_success_pct`` — rough probability the negotiation lands
    something. Heuristic, calibrated against industry-average retention
    desk data; gets refined per-issuer once we have enough
    RetentionAttempt rows.
  * ``notes`` — caveats / extra tips (timing, asking for the retention
    department specifically, etc.)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from ..db.models import Subscription, SubscriptionType


@dataclass
class RetentionPlaybook:
    """Plain-data negotiation script. JSON-serializable."""

    subscription_id: int
    merchant: str
    current_monthly_cents: int
    opening_line: str
    leverage_points: list[str] = field(default_factory=list)
    counter_offers: list[str] = field(default_factory=list)
    walkaway_line: str = ""
    estimated_success_pct: int = 30  # 0-100
    estimated_savings_min_cents: int = 0
    estimated_savings_max_cents: int = 0
    notes: list[str] = field(default_factory=list)


# Per-type baselines. These shape the counter-offers and the success
# estimate. Streaming retention desks are notoriously generous; SaaS
# is moderate; utilities almost never negotiate the headline rate but
# WILL waive specific add-on fees.
_BASELINES: dict[SubscriptionType, dict] = {
    SubscriptionType.streaming: {
        "success_pct": 50,
        "save_min_pct": 20,   # likely floor of monthly discount
        "save_max_pct": 50,   # likely ceiling
        "duration_months": 6,
        "tone": "casual",
    },
    SubscriptionType.saas: {
        "success_pct": 35,
        "save_min_pct": 10,
        "save_max_pct": 30,
        "duration_months": 12,
        "tone": "business",
    },
    SubscriptionType.news_media: {
        "success_pct": 60,
        "save_min_pct": 30,
        "save_max_pct": 75,   # NYT et al. routinely halve to keep you
        "duration_months": 12,
        "tone": "casual",
    },
    SubscriptionType.fitness: {
        "success_pct": 40,
        "save_min_pct": 15,
        "save_max_pct": 35,
        "duration_months": 3,
        "tone": "casual",
    },
    SubscriptionType.internet: {
        "success_pct": 60,
        "save_min_pct": 15,
        "save_max_pct": 40,
        "duration_months": 12,
        "tone": "firm",
    },
    SubscriptionType.telecom: {
        "success_pct": 55,
        "save_min_pct": 10,
        "save_max_pct": 30,
        "duration_months": 12,
        "tone": "firm",
    },
    SubscriptionType.utilities: {
        "success_pct": 15,    # rate is usually regulated; fees aren't
        "save_min_pct": 0,
        "save_max_pct": 10,
        "duration_months": 0,
        "tone": "polite",
    },
    SubscriptionType.insurance: {
        "success_pct": 70,    # very negotiable, especially if you've shopped
        "save_min_pct": 10,
        "save_max_pct": 30,
        "duration_months": 12,
        "tone": "firm",
    },
}

# Default for unknown / unclassified types
_DEFAULT_BASELINE = {
    "success_pct": 30,
    "save_min_pct": 10,
    "save_max_pct": 30,
    "duration_months": 6,
    "tone": "casual",
}


# Type-specific opening lines. Shoot for a tone that matches what
# retention reps expect from that kind of customer.
_OPENING_LINES: dict[str, str] = {
    "casual": (
        "Hi, I've been a customer for a while and I'm thinking about "
        "cancelling — the monthly fee is starting to feel like a lot for "
        "how much I actually use it. Can you take a look at my account "
        "and see what you can do?"
    ),
    "business": (
        "Hi, I'm reviewing all my software subscriptions and need to "
        "decide whether to renew this one. Before I cancel, I wanted to "
        "see what loyalty pricing or annual-prepay discounts might be "
        "available. What can you offer me to stay?"
    ),
    "firm": (
        "Hi, I'm calling because my monthly bill has gone up and I'm "
        "comparing it against your competitors. I'd like to talk to "
        "retention about getting a better rate before I make a decision. "
        "Can you transfer me?"
    ),
    "polite": (
        "Hi, I'm calling about my account — I see the monthly amount has "
        "been creeping up. Can you tell me what fees are on this bill and "
        "whether any of them can be waived for a long-term customer?"
    ),
}


# Generic counter-offers — type-specific lists below override.
_GENERIC_OFFERS = [
    "A specific dollar amount off the monthly rate (ask for 30% — they may meet at 15-20%)",
    "A free month or two as a 'loyalty credit'",
    "A free upgrade to the next tier for the same price",
    "A waiver of any equipment / setup / monthly service fees",
    "Locking in your current rate for 12 months (avoiding upcoming price hikes)",
]

_TYPE_SPECIFIC_OFFERS: dict[SubscriptionType, list[str]] = {
    SubscriptionType.streaming: [
        "30-50% off for 6 months ('loyalty discount')",
        "Free upgrade to the ad-free / premium tier at your current price",
        "1-2 free months credited to your account",
        "Switching to an annual plan at a lower monthly equivalent",
    ],
    SubscriptionType.news_media: [
        "Half off for the next 12 months — NYT-style retention is notoriously generous here",
        "Switching from monthly to a discounted annual subscription",
        "1-3 free months tacked onto your existing plan",
    ],
    SubscriptionType.internet: [
        "Match a specific competitor's promo rate (look up Verizon Fios or T-Mobile Home Internet pricing first)",
        "Removal of any modem-rental, broadcast-TV, or 'regional sports' fees",
        "Speed upgrade at the same monthly rate",
        "Extension of your current promo rate by another 12 months",
    ],
    SubscriptionType.telecom: [
        "Match a competitor (Mint Mobile $30/mo unlimited, Visible $25)",
        "Loyalty discount for accounts open >2 years",
        "Drop unused add-on lines / device payments",
    ],
    SubscriptionType.fitness: [
        "Pause vs cancel — most gyms will pause 1-3 months free",
        "Match the corporate / employer rate (ask if your employer has a discount even if you don't know)",
        "Return to your founding-member rate if you were a long-term customer",
    ],
    SubscriptionType.saas: [
        "Switching from monthly to annual at the discounted annual rate",
        "Keeping current pricing through the next renewal cycle (avoiding announced price hikes)",
        "Extra seats / users / quota at the same monthly cost",
    ],
    SubscriptionType.insurance: [
        "Bundle discount (auto + home, auto + renters)",
        "Lower deductible at the same premium, or same deductible at a lower premium",
        "Re-rating based on commute changes, lower mileage, defensive-driving courses",
    ],
}

_WALKAWAY_LINES = {
    "casual": (
        "Thanks for trying. If that's the best you can do, please go "
        "ahead and cancel my subscription effective at the end of this "
        "billing cycle."
    ),
    "business": (
        "I appreciate the offer, but it's not enough to justify the "
        "renewal. Please process the cancellation and confirm the final "
        "billing date in writing."
    ),
    "firm": (
        "OK — please cancel my account. Send me a confirmation number "
        "and the date the service will end. I'll need that for my records."
    ),
    "polite": (
        "I understand. Could you note the call and let me know if "
        "anything changes in the next billing cycle?"
    ),
}


def build_playbook(
    sub: Subscription,
    *,
    today: date | None = None,
) -> RetentionPlaybook:
    """Generate a retention script for one subscription.

    All inputs come from the Subscription row + heuristic per-type
    baselines. Future versions can layer in: real competitor pricing
    pulled at build time, the user's outcome history with this issuer
    (RetentionAttempt rows), and Gmail-parsed historical promo offers.

    Returns a RetentionPlaybook; caller decides whether to surface it
    in the API or render it inline.
    """
    today = today or date.today()
    sub_type = sub.subscription_type or SubscriptionType.unknown
    baseline = _BASELINES.get(sub_type, _DEFAULT_BASELINE)

    monthly_cents = abs(sub.last_amount_cents or sub.amount_cents or 0)

    # Leverage points: facts pulled directly from data. Each is one
    # sentence we'd actually say on the call.
    leverage: list[str] = []
    leverage.append(f"You're paying ${monthly_cents/100:.2f}/month to {sub.name}.")
    if sub.first_seen_date is not None:
        months = max(1, (today - sub.first_seen_date).days // 30)
        leverage.append(
            f"You've been a customer for at least {months} month{'s' if months != 1 else ''} "
            f"(based on transaction history)."
        )
    if sub.prior_amount_cents and sub.last_amount_cents:
        if abs(sub.last_amount_cents) > abs(sub.prior_amount_cents):
            increase_cents = abs(sub.last_amount_cents) - abs(sub.prior_amount_cents)
            increase_pct = (increase_cents / abs(sub.prior_amount_cents)) * 100
            leverage.append(
                f"Your rate went UP from ${abs(sub.prior_amount_cents)/100:.2f} "
                f"to ${abs(sub.last_amount_cents)/100:.2f} (+{increase_pct:.0f}%) "
                f"recently — mention this as a specific complaint."
            )
    if sub.is_variable_amount:
        leverage.append(
            "This bill varies month to month — ask whether any line items "
            "(fees, surcharges, equipment rentals) can be removed."
        )

    # Counter-offers: type-specific list with a generic fallback.
    offers = list(_TYPE_SPECIFIC_OFFERS.get(sub_type, _GENERIC_OFFERS))

    # Estimated savings range = baseline % bracket applied to current rate.
    save_min = int(monthly_cents * baseline["save_min_pct"] / 100)
    save_max = int(monthly_cents * baseline["save_max_pct"] / 100)

    notes: list[str] = []
    notes.append(
        "Ask to be transferred to the RETENTION or LOYALTY department. "
        "Front-line CSRs usually can't authorize bigger discounts."
    )
    notes.append(
        "Best time to call: weekday afternoons. Reps have unmet quotas later in the day."
    )
    notes.append(
        "Have a competitor's pricing ready to mention by name. Specific beats generic."
    )
    if sub_type == SubscriptionType.utilities:
        notes.append(
            "Utility headline rates are usually regulated and non-negotiable. Focus on FEES "
            "(line items on the bill), not the per-kWh / per-gallon rate itself."
        )

    return RetentionPlaybook(
        subscription_id=sub.id,
        merchant=sub.name,
        current_monthly_cents=monthly_cents,
        opening_line=_OPENING_LINES[baseline["tone"]],
        leverage_points=leverage,
        counter_offers=offers,
        walkaway_line=_WALKAWAY_LINES[baseline["tone"]],
        estimated_success_pct=baseline["success_pct"],
        estimated_savings_min_cents=save_min,
        estimated_savings_max_cents=save_max,
        notes=notes,
    )
