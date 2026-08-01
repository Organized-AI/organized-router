# Pricing and Billing

Two components. One flat, one contingent.

## 0. What is free

Everything in this repository, under MIT. The repair engine, the rule set, the error
taxonomy, the patch schema, the healer protocol, and the published catalog. Self-host
the whole thing and pay nothing, ever. No feature is held back for the paid tier.

## 1. Hosted: $50 per month

Sold and billed on our own Stripe account, not through a repo paywall. Includes:

- `fix.organizedai.vip`, the hosted healing endpoint. Tier 2 inference is on us
- the private catalog: verified patches before they are published
- the router endpoint (OpenAI and Anthropic compatible)
- observability: request log, provider attempts, cost by model and agent
- not operating any of it

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

## Why not a repo paywall

An earlier draft sold repository access at $50/month through GitPaywall. That is dropped.

The prior art here is MIT and free. Selling closed access to a design borrowed from an
MIT project, to an audience that can already run the MIT original, is a weak position and
an ugly one. Publishing the engine costs us nothing we were actually selling: the value is
the hosted healer, the private catalog, and the savings ledger, none of which live in a
git clone.

There is also a mechanical reason. A repo paywall running on Stripe Connect puts the
subscription under the platform's account while the savings meter has to live on ours.
That is two customer records, two invoices, and no way to put both lines on one bill.

## Entitlement

Stripe owns the product and the price. Our own worker owns the entitlement.

1. `checkout.session.completed` provisions a router key (`org_...`) into KV `user:<id>` with `plan=pro`, and seeds the baseline as `pending_receipt`.
2. `invoice.payment_failed` marks `plan=past_due`. The healer keeps answering for the grace period; only the private catalog is gated.
3. `customer.subscription.deleted` sets `plan=none`. The key drops to read-only observability for 30 days so a lapsed user can export their own data, then stops.

No GitHub collaborator invites, no PAT with `admin:org`, no access revocation race.

## Stripe

Account `acct_XXXXXXXXXXXXXXXX`.

| Object | Purpose |
|---|---|
| Product: Organized Router | $50/month recurring, created directly on Stripe |
| Meter: `organized_router_savings_share` | usage-based, unit = USD cents of share |
| Queue: `meter-flush` | buffers meter events out of the request path |

Never bill inline in the request path. Meter events go to the queue, the consumer flushes to Stripe.

## Conversion tracking

GTM `GTM-XXXXXXX` to sGTM `GTM-YYYYYYY` at `<your-subdomain>.stape.io`, then GA4 `G-XXXXXXXXXX`, Google Ads Enhanced Conversions, and Meta CAPI.

Events: `sign_up`, `receipt_pushed`, `first_route`, `first_recovery`, `purchase` (subscription activation, value 50.00 USD), `savings_share_billed` (value = actual share).

Purchase events must carry a real value. A $0 purchase value is the known failure mode.
