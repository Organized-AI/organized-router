# Pricing and Billing

Two components. One flat, one contingent.

## 1. Subscription: $50 per month

Sold through GitPaywall as recurring repository access. Includes:

- the router endpoint (OpenAI and Anthropic compatible)
- Organized Fix, unlimited recoveries, no per-repair charge
- the full patch catalog, including private signatures not yet published
- observability: request log, provider attempts, cost by model and agent
- self-hosting rights for the whole gateway under LICENSE.md

## 2. Savings share: 5% of verified savings

```
saved = cost(baseline_model) - cost(selected_model) - classifier_probe_cost
share = max(0, saved) x 0.05
```

Rules that make the number honest:

- **Baseline is observed, not declared.** It is the user's own modal model per task class, mined from their receipt digest at onboarding and frozen. A user cannot inflate savings by naming an expensive baseline.
- **Classifier overhead is subtracted.** The probe that decides where to route is charged against the savings it produced.
- **Savings floor at zero per request.** A request routed to a more expensive model produces no negative and no fee.
- **Quality voids savings.** A `!bad` feedback signal on a request voids that request's savings and demotes the model-class quality score.
- **Metered, not estimated.** Every share line resolves to a request id, a baseline price, a selected price, and a timestamp, all readable at `/api/billing/preview`.

## Why 5% and not more

The subscription carries the product. The share exists to align the router's incentive with the user's bill, not to be the revenue. At 5%, a user saving $2,000 a month pays $100 in share and keeps $1,900. That is an easy yes. At 20% the conversation becomes a negotiation about the baseline, which is exactly the conversation that kills the deal.

## What changed from the earlier design

An earlier draft billed a fee per recovered request. That was dropped. Charging per recovery means profiting from a user's breakage in perpetuity, and the incentive points the wrong way: the vendor benefits when repairs stay rare and expensive. Folding recoveries into the flat $50 points the incentive the right way. Every repair we learn makes the catalog better, which lowers our own healer cost, which is the only cost recoveries carry. We would rather have a catalog with a 95% hit rate than a per-repair meter.

## GitPaywall setup

1. Create the product at $50/month recurring.
2. Point it at `Organized-AI/organized-router` (private).
3. Entitlement grants repository read access on active subscription, revokes on cancellation or failed payment.
4. Webhook `subscription.created` provisions a router API key (`org_...`) into KV `user:<id>` with `plan=pro`, and seeds the user's baseline as `pending_receipt`.
5. Webhook `subscription.deleted` sets `plan=none`. The key keeps working in read-only observability mode for 30 days so a lapsed user can still export their own data.

## Stripe

Account `acct_XXXXXXXXXXXXXXXX`.

| Object | Purpose |
|---|---|
| Product: Organized Router | $50/month recurring, created by GitPaywall |
| Meter: `organized_router_savings_share` | usage-based, unit = USD cents of share |
| Queue: `meter-flush` | buffers meter events out of the request path |

Never bill inline in the request path. Meter events go to the queue, the consumer flushes to Stripe.

## Conversion tracking

GTM `GTM-XXXXXXX` to sGTM `GTM-YYYYYYY` at `<your-subdomain>.stape.io`, then GA4 `G-XXXXXXXXXX`, Google Ads Enhanced Conversions, and Meta CAPI.

Events: `sign_up`, `receipt_pushed`, `first_route`, `first_recovery`, `purchase` (subscription activation, value 50.00 USD), `savings_share_billed` (value = actual share).

Purchase events must carry a real value. A $0 purchase value is the known failure mode.
