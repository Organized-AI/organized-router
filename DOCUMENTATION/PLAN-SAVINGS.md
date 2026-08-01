# Savings Under Monthly Plans

## The problem

The savings share assumes a request has a marginal dollar cost. Under Claude Max, Claude Pro,
ChatGPT Plus, or a Codex plan, it does not. The money left the customer's account on the first of
the month. Routing a request from Opus to Haiku inside an unexhausted plan saves exactly zero
dollars, and billing 5% of a number computed from list API rates would be inventing a saving that
never happened.

Most routers quietly do this. It is the single most likely way this product becomes dishonest, so
the regime is decided before any savings math runs.

## Three regimes

```
                        credential is an API key?
                                  |
                    yes ----------+---------- no (OAuth subscription)
                     |                              |
                  REGIME: api              any plan window that this
              marginal cost real           request would push over cap?
              savings BILLABLE                      |
                                        no ---------+--------- yes
                                         |                      |
                              REGIME: plan_within_cap    REGIME: plan_spillover
                              marginal cost ZERO         request falls to API rates
                              savings NOT billable       avoided cost is real
                              quota saved is reported    savings BILLABLE
```

## What gets billed

| Regime | savedUsd | savedUnits | Billed |
|---|---|---|---|
| `api` | list(baseline) - list(selected) - probe | reported | yes, 5% |
| `plan_within_cap` | **0** | reported | **no** |
| `plan_spillover` | avoided API cost | reported | yes, 5% |

A customer on Claude Max who never hits their cap pays $50 and nothing else, forever. That is the
correct outcome and it should be stated on the pricing page, not discovered.

## What the product is worth to a plan user

Dollars are the wrong unit inside a subscription. The scarce resource is quota, and the thing that
hurts is hitting a five-hour wall mid-task. So plan users get a different headline metric:

- **quota preserved** in plan units
- **headroom recovered**, quota preserved divided by their observed burn rate, expressed as time
- **cap breaches avoided**, count of requests that would have crossed a window and did not

"You did not hit your weekly limit on Thursday" is worth more than $50 to someone on a Max plan.
That is the retention argument, and it is honest, because it is a thing that actually happened.

## Plan units, not tokens

Subscriptions meter weighted usage. A frontier model burns quota several times faster than a small
one, and output tokens cost more than input. The engine models this as:

```
planUnits = (tokensIn + tokensOut * 4) * unitWeight(model)
```

Weights start from a defaults table and are corrected by observation: each response's rate-limit
headroom decay is compared against predicted units, and the per-family weight is nudged toward the
observed ratio. Weights live in `unit_weights` and converge per provider.

## Detection

Three signals, in order of trust:

1. **Credential shape.** A token that is not `sk-ant-`, `sk-`, `AIza`, or `sk-or-` is an OAuth
   subscription token. This is the primary signal and it is nearly free.
2. **Rate-limit headers.** `anthropic-ratelimit-unified-5h-*` and `-7d-*` give real caps and real
   remaining headroom. Every header read is a miss-tolerant probe; a renamed header degrades to
   "cap not yet observed" rather than throwing.
3. **Receipt mining.** `~/.claude` and `~/.codex` transcripts show which sessions were
   subscription-backed, which seeds the plan before the first routed request.

When a cap is unknown, the window is treated as having headroom and `observed_max_units` learns
the ceiling from the highest usage seen before a 429.

## Failure modes this is designed against

- **Phantom savings.** Billing plan users against list API rates. Prevented by regime, enforced by
  `billable=0` on the ledger row, not by a check at invoice time.
- **Header drift.** Providers rename rate-limit headers. Every probe is optional and a miss means
  "assume headroom", which fails toward `plan_within_cap`, which bills nothing. The safe direction.
- **Weight staleness.** A wrong unit weight misclassifies spillover. Weights are observation-corrected,
  and spillover requires an *observed* cap, never an assumed one.
- **Double counting.** A spillover request that then gets repaired by Organized Fix logs one savings
  row and one repair row against a shared `request_id`. The ledger is keyed on request, not attempt.
