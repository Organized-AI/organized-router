# Organized Router

A self-hosted LLM gateway built around caching: preserve provider prompt caches, keep sessions on a warm route, and reuse explicitly cacheable responses.

TypeScript · Cloudflare Workers · Durable Objects · MIT

## Use your Codex subscription

The local subscription mode uses your existing ChatGPT login and plan. No provider
API key is needed. The persistent connector follows Ramp's Codex setup lifecycle,
with subscription authentication added as a separate mode. It requires Python
3.14+, Codex and `lsof`; the background service below requires macOS.

```sh
npm run router -- service install
npm run router -- configure codex --mode subscription --dry-run
# Close Codex desktop and CLI before applying the history migration:
npm run router -- configure codex --mode subscription
```

Reopen Codex. Check the saved connection with `npm run router -- status` and
reported cache tokens with `npm run router:status`. The route is Codex → local
Organized Router → ChatGPT's Codex backend. Subscription limits still apply.
Setup preserves your model and migrates conversation provider metadata with a
rollback receipt. Active transcript writers block activation. An already-running
chat is not rerouted by editing settings. See the
[connection guide](DOCUMENTATION/CACHING.md#connect-codex-with-your-chatgpt-subscription)
for API mode, refresh, undo and the optional process-only launcher.

## Live usage

```sh
npm run usage                  # Latest local Codex usage and reported plan limits
npm run usage:live             # Refresh the terminal view every five seconds
npm run router -- usage --json # Machine-readable snapshot
```

The background service scans Codex records with pinned `ccusage` every 30 seconds.
It shows total input, cached input, output, model breakdowns and the age of the
latest Codex-reported limit snapshot. Router counters are displayed separately
because the two sources overlap. No inference API key or pricing lookup is needed.
See [live usage and its limits](DOCUMENTATION/LIVE-USAGE.md).

## Run

```sh
npm ci
npm run verify
npm run test:runtime
npm run test:subscription
npm run test:connection
npm run test:connection-runtime
npm run test:telemetry
npm run test:usage
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
- Persistent Codex CLI/desktop configuration in subscription or API mode, native catalog discovery, and reversible history migration.
- Provider cache controls preserved, including Anthropic markers and OpenAI cache keys/retention.
- Session affinity to the last successful provider/model; ordered fallback for transient errors.
- Opt-in exact response caching for stateless text requests, with per-key isolation and bounded persistent storage.
- Concurrent duplicate coalescing, TTL expiry/alarms, and atomic purge that blocks in-flight resurrection.
- SSE passthrough with usage observation and no provider switching after commitment.
- Per-key cache statistics and request receipts separating new inference from replayed usage.
- Correlated OpenTelemetry logs/traces, private rotating local capture, and configurable OTLP export.
- Live local Codex usage via ccusage, reported subscription limits, and separate router counters.
- Explicit cache read/write pricing, negative write overhead, and unknown-cost handling.

Response reuse requires `X-Organized-Cache: exact`, `temperature: 0`, and `store: false` for Responses. Tools, stateful requests and streams bypass it. Provider prompt caching is independent and remains available on those paths.

## Research and scope

[How Ramp Router was built](DOCUMENTATION/RAMP-ROUTER-RESEARCH.md) summarizes Ramp's public engineering and API documentation, with sources and unknowns. Organized Router applies the cache-affinity lessons and adds exact response reuse; it does not claim to reproduce Ramp's private stack, trained routing policies or savings percentages.

The [connection audit](DOCUMENTATION/RAMP-CONNECTION-AUDIT.md) pins Ramp's public
CLI implementation. The [routing policy review](DOCUMENTATION/ROUTING-POLICY-REVIEW.md)
compares Ramp's Thompson sampling with modelrouter's learned model selection and
records how future routing should account for warm caches and coding quality.

[Observability setup](DOCUMENTATION/OBSERVABILITY.md) recommends OpenTelemetry
with Grafana, explains Cloudflare/Supabase/Prometheus/PostHog roles, and documents
local capture plus the prepared collector configuration. The
[Grafana vs PostHog comparison](DOCUMENTATION/GRAFANA-VS-POSTHOG.md) covers their
current overlap, caching workflows, routing experiments and costs. Inspect
captured traffic with `npm run telemetry:status`.

To connect an existing Grafana Cloud stack, run
`npm run telemetry:configure -- --restart` in a terminal. It accepts a hidden,
stack-scoped ingestion token and verifies log/trace access before saving private
settings. [Connection details and current status](DOCUMENTATION/OBSERVABILITY.md#connect-a-destination).

The [cache implementation plan](PLANNING/CACHE-FIRST-PLAN.md) defines the verified track. The [original product vision](DOCUMENTATION/ORIGINAL-PRODUCT-VISION.md) and [historical master plan](PLANNING/IMPLEMENTATION-MASTER-PLAN.md) describe future healing, billing, classifier and public-catalog work. Existing experimental repair/savings modules remain in the tree but are not activated by the caching gateway.

This is a runnable gateway, not a production deployment or a measured savings claim. [Current operational limits](DOCUMENTATION/CACHING.md#current-limits) are documented. Self-hosting uses `wrangler.toml`; no cloud resources are created by tests.

---

Maintained by Jordaaan Hill ([LinkedIn](https://www.linkedin.com/in/jordaaanhill)).
