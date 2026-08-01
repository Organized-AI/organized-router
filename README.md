# Organized Router

**A healing service for LLM gateways, and a router that bills on savings instead of tokens.**

MIT licensed. Runs on Cloudflare Workers.

---

## Two things live here

### 1. Organized Fix - a drop-in healing service

Gateways that implement request repair need something to call when a request fails on a 400, 404, or 422. Manifest exposes this as `AUTOFIX_HEALING_URL`. Organized Fix implements that contract.

```bash
# self-hosted Manifest, pointed at Organized Fix
AUTOFIX_HEALING_URL=https://fix.organizedai.vip
AUTOFIX_HEALING_API_KEY=org_...
```

You can also run it yourself. The engine, the rule set, the error taxonomy, and the patch schema are all in this repository under MIT. Nothing is held back.

### 2. Organized Router - savings-accounted routing

An OpenAI and Anthropic compatible endpoint that classifies each request, routes to the cheapest model that clears the quality bar, and keeps a per-request ledger of what that decision saved against your own baseline.

---

## Why the healing service is separate

Most repair layers send every repairable failure to an LLM. That is correct and expensive. Organized Fix puts two free tiers in front of it:

```
TIER 0   catalog lookup      KV, ~2ms, $0    signature hit from a prior verified repair
TIER 1   deterministic rules in-worker, $0   known transforms (unsupported param, model alias, schema shape)
TIER 2   LLM healer          Haiku, metered  catalog and rule miss only, promoted back to catalog
```

The catalog is the whole thing. The first caller to hit a novel failure signature pays for a real repair. Everyone after them gets it from cache in about two milliseconds. Catalog hit rate is the metric that matters, and it should climb toward 1.

**The catalog is published.** Verified patches go public at `errors.organizedai.vip` once they succeed across enough distinct callers, MIT, no signup. If you self-host the engine you can pull the catalog and get most of the value without ever sending us a request.

## Behavior contract

| Rule | Behavior |
|---|---|
| Narrow trigger | Repair only 400, 404, 422, and OF302. Never 401, 403, 429, or any 5xx |
| Order | Repair runs before the fallback chain. Fallback stays the safety net |
| One retry | Exactly one patched retry. No loop, no retry budget |
| Quiet degradation | Healer error or timeout returns the original provider error, never a synthetic 500 |
| Circuit breaker | 3 consecutive healer transport failures opens a 30s cooldown. One success clears it |
| Separate attempts | Failed original and patched retry are distinct rows sharing a request_id |
| Success only | Recovered means the patched retry actually succeeded |

See [DOCUMENTATION/HEALER-PROTOCOL.md](DOCUMENTATION/HEALER-PROTOCOL.md) for the wire format.

---

## What costs money

Nothing in this repository. Run all of it for free, forever.

| Hosted | Price |
|---|---|
| `fix.organizedai.vip` healing endpoint + private catalog | **$50 / month** |
| `gate.organizedai.vip` router with savings accounting | included |
| Savings share | **5% of verified savings** |

The $50 buys inference you would otherwise pay for yourself, the catalog before it is published, and not having to operate any of it.

The 5% applies only to money the router actually saved, measured against your own baseline model mix mined from your receipts and frozen at onboarding. Not a self-declared baseline.

```
saved = cost(baseline) - cost(selected) - classifier_probe_cost
share = max(0, saved) x 0.05
```

Self-hosters pay neither. That is not a loophole, it is the design. Full detail in [DOCUMENTATION/PRICING.md](DOCUMENTATION/PRICING.md).

## Extras

The provider error fixture corpus, a catalog snapshot you can import straight into KV, and
`receipt.py` (the local token-receipt miner) are bundled behind an email wall. The code is
public and always will be; the bundle just saves you the work of regenerating it. See
[DOCUMENTATION/DISTRIBUTION.md](DOCUMENTATION/DISTRIBUTION.md).

## Stack

Cloudflare Workers, Workers Assets, D1, KV, Durable Objects, Queues, R2. No Cloudflare Pages.

## Status

Phase F0. See [PLANNING/IMPLEMENTATION-MASTER-PLAN.md](PLANNING/IMPLEMENTATION-MASTER-PLAN.md).

## Prior art

The repair behavior is modeled on [Manifest](https://github.com/mnfst/manifest) Auto-fix (MIT): narrow status trigger, repair before fallback, exactly one retry, quiet degradation, circuit breaker on the healer. Manifest got that design right and we did not improve on it. What we added is the catalog in front of the healer, and a published error corpus.

Organized Fix is built to be useful to Manifest users, not to replace Manifest. If you are already running it, point `AUTOFIX_HEALING_URL` here and keep everything else.

No Manifest source is vendored in this repository. If any is added it stays under MIT with its original notice.
