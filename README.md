# Organized Router

A self-hosted LLM gateway built around caching: preserve provider prompt caches, keep sessions on a warm route, and reuse explicitly cacheable responses.

TypeScript · Cloudflare Workers · Durable Objects · MIT

## Use your Codex subscription

The local subscription mode uses your existing ChatGPT login and plan. No provider
API key is needed. Sign in with `codex login`, then start the local router:

```sh
npm run router:subscription
```

In another terminal, run `npm run codex:local`. Check native prompt-cache usage
with `npm run router:status`. Codex → local Organized Router → ChatGPT's Codex
backend. Your selected model and native session/cache fields are preserved;
the router observes reported cached tokens without storing or replaying coding
responses. Subscription limits still apply. This launches a CLI session; it does
not reroute an already-running desktop chat. See the [connection guide](DOCUMENTATION/CACHING.md#connect-codex-with-your-chatgpt-subscription).

## Run

```sh
npm ci
npm run verify
npm run test:runtime
npm run test:subscription
```

The runtime suite starts workerd and a local HTTP model fixture, tests all three API protocols, persistence, concurrency, expiry and purge, then shuts down. It makes no paid model calls. Requires Node 22.12+.

For real providers, choose model IDs in a copy of [CONFIG/router.example.json](CONFIG/router.example.json), then:

```sh
node scripts/configure.mjs CONFIG/my-router.json
# Add your provider keys to the generated, gitignored .dev.vars.
npm run dev
```

See [the configuration and API guide](DOCUMENTATION/CACHING.md) for requests, auth, deployment, prices, and exact cache semantics.

## What works

- Native `/v1/responses`, `/v1/chat/completions`, and `/v1/messages` forwarding.
- Local Codex subscription transport with native login, streaming, and cache-usage observation.
- Provider cache controls preserved, including Anthropic markers and OpenAI cache keys/retention.
- Session affinity to the last successful provider/model; ordered fallback for transient errors.
- Opt-in exact response caching for stateless text requests, with per-key isolation and bounded persistent storage.
- Concurrent duplicate coalescing, TTL expiry/alarms, and atomic purge that blocks in-flight resurrection.
- SSE passthrough with usage observation and no provider switching after commitment.
- Per-key cache statistics and request receipts separating new inference from replayed usage.
- Explicit cache read/write pricing, negative write overhead, and unknown-cost handling.

Response reuse requires `X-Organized-Cache: exact`, `temperature: 0`, and `store: false` for Responses. Tools, stateful requests and streams bypass it. Provider prompt caching is independent and remains available on those paths.

## Research and scope

[How Ramp Router was built](DOCUMENTATION/RAMP-ROUTER-RESEARCH.md) summarizes Ramp's public engineering and API documentation, with sources and unknowns. Organized Router applies the cache-affinity lessons and adds exact response reuse; it does not claim to reproduce Ramp's private stack, trained routing policies or savings percentages.

The [cache implementation plan](PLANNING/CACHE-FIRST-PLAN.md) defines the verified track. The [original product vision](DOCUMENTATION/ORIGINAL-PRODUCT-VISION.md) and [historical master plan](PLANNING/IMPLEMENTATION-MASTER-PLAN.md) describe future healing, billing, classifier and public-catalog work. Existing experimental repair/savings modules remain in the tree but are not activated by the caching gateway.

This is a runnable gateway, not a production deployment or a measured savings claim. [Current operational limits](DOCUMENTATION/CACHING.md#current-limits) are documented. Self-hosting uses `wrangler.toml`; no cloud resources are created by tests.
