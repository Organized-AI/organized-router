# Organized Router

An LLM gateway for agents that **repairs broken requests before they reach your fallback chain**, then bills on outcomes instead of tokens.

Built on Cloudflare Workers. Extends the live Organized AI gateway at `gate.organizedai.vip`.

---

## The problem

About 5% of production LLM API calls fail. Most of those failures are request-side: a parameter the provider does not accept, a tool schema in the wrong shape, a model name that moved. Switching to a fallback model does not help, because the next model rejects the same body.

## What Organized Fix does

```
provider returns 400 / 404 / 422
        │
        ▼
   NORMALIZE ──▶ SIGNATURE ──▶ TIER 0  catalog lookup (KV, ~2ms, free)
                                  │ miss
                                  ▼
                               TIER 1  deterministic rules (in-worker, free)
                                  │ miss
                                  ▼
                               TIER 2  LLM healer (Haiku, metered)
                                  │
                                  ▼
                          APPLY PATCH ─▶ ONE RETRY ─▶ success  → promote to catalog
                                                    └─ failure → fallback chain
```

Never touches 401, 403, 429, or any 5xx. Those are not request problems and a rewritten body cannot fix them.

## Why the catalog matters

Most gateways send every repairable failure to an LLM healer. That is correct and expensive. Organized Fix puts a signature lookup and a deterministic rule engine in front of it, so the healer only fires on genuinely novel failures. The first person to hit a new failure pays for the repair. Everyone after them gets it free, from cache, in about two milliseconds.

Catalog hit rate is the metric that matters. It should climb toward 1.

---

## Pricing

| | |
|---|---|
| **Organized Router** | **$50 / month** |
| **Savings share** | **5% of verified savings** |

The $50 covers the router, Organized Fix with unlimited recoveries, the full patch catalog, observability, and the request log.

The 5% applies only to money the router actually saved you, measured against your own baseline model mix mined from your receipts and frozen at onboarding. Not a self-declared baseline. No savings in a period means no share that period.

```
saved = cost(baseline) - cost(selected) - classifier_probe_cost
share = max(0, saved) x 0.05
```

Full detail in [DOCUMENTATION/PRICING.md](DOCUMENTATION/PRICING.md).

## Repo access

Source is sold through GitPaywall at $50/month recurring. Paying subscribers get read access to this repository and can self-host the whole gateway, including the repair engine and the rule set. The hosted gateway at `gate.organizedai.vip` is where the 5% savings share is metered.

## Stack

Cloudflare Workers, Workers Assets, D1, KV, Durable Objects, Queues, R2. No Cloudflare Pages.

## Status

Phase F0. See [PLANNING/IMPLEMENTATION-MASTER-PLAN.md](PLANNING/IMPLEMENTATION-MASTER-PLAN.md).

## Prior art

The repair behavior is modeled on Manifest's Auto-fix (MIT, github.com/mnfst/manifest): narrow status trigger, repair before fallback, exactly one retry, quiet degradation, circuit breaker on the healer. The design is borrowed and credited. The code in this repository is original. No Manifest source is vendored here, and none may be added without honoring its MIT terms.
