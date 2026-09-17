# Organized Router caching gateway

This is the runnable, self-hosted caching track. It extends the repository's original F0 scaffold. The historical healing, Stripe, public catalog, classifier and marketing plans remain separate, unimplemented product work; they are not prerequisites for operating this gateway.

## Run locally

Requires Node 22 or newer and npm. No paid inference is needed for the fixture demo.

```sh
npm ci
npm run verify
npm run test:runtime
```

The runtime test starts a local provider fixture and Wrangler, exercises the actual Worker/Durable Object HTTP path, and shuts both down. It uses dummy credentials and never calls a commercial model provider.

For your own providers, copy `CONFIG/router.example.json` to a local configuration file, replace the model placeholders with models available to your account, and run:

```sh
node scripts/configure.mjs CONFIG/my-router.json
# Edit .dev.vars to populate PROVIDER_KEYS. It is ignored by Git.
npm run dev
```

`GATE_API_KEY` is the client-facing key; `PROVIDER_KEYS` is a JSON object mapping provider identifiers to provider secrets. `ROUTER_CONFIG` contains route aliases and approved candidates, in cold-start/fallback order. Provider base URLs exclude the `/v1` suffix: the full endpoint path is appended. HTTPS is required; loopback HTTP is permitted only with `LOCAL_MODE=true` for fixtures. Redirects are never followed.

Each candidate explicitly declares supported endpoints. Only add candidates you have verified support the same request features and quality requirements. A route can list multiple OpenAI-compatible hosts without claiming every model implements every API. No automatic cross-protocol conversion occurs. No model lists or prices are silently fetched or changed.

Example request (set the generated key in your shell):

```sh
curl http://localhost:8787/v1/responses \
  -H "Authorization: Bearer $GATE_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'X-Organized-Cache: exact' \
  -d '{"model":"organized-openai","input":"Say hello","temperature":0,"store":false}'
```

Repeat the request to see `X-Organized-Cache: hit`. Response bodies retain provider IDs and historical usage exactly; `X-Organized-Upstream-Attempts: 0` and the gateway receipt distinguish a replay from new inference. Do not sum historical usage from replayed response bodies as new provider consumption.

## Three distinct mechanisms

| Mechanism | Behavior |
|---|---|
| Provider prompt cache | Cache controls pass through unchanged. Provider usage reports reads and writes. Each request still calls the provider. |
| Routing affinity | `X-Organized-Session` or `prompt_cache_key` keeps an alias on a successful candidate. Lease defaults to five minutes, one hour for Anthropic 1h markers, or 24h for `prompt_cache_retention: "24h"`. Success refreshes it. |
| Exact response cache | Explicit `X-Organized-Cache: exact`; stateless, text-only, `temperature: 0`, non-streaming. A hit makes no provider call. |

Affinity represents a routing preference, not proof that the provider retains a prefix. Provider eviction remains possible. Explicit `service_tier` is preserved and creates a separate affinity scope. Full-response hits do not refresh provider affinity because they do not warm the provider.

Exact caching bypasses tools, functions, images, files, stored/previous conversations, background requests, unknown top-level fields, incomplete output, nonzero or missing temperature, client `no-cache`/`no-store`, and provider `private`/`no-store`. Responses requires explicit `store:false`. Cached text is persisted only when the request opts in. Stochastic provider behavior can still occur at temperature zero; opting in means choosing to reuse the first successful output for the TTL.

Cache keys include the full canonical request, endpoint, relevant version/beta headers, session, TTL, candidate configuration and credential fingerprint. Object-key order is normalized; array order, text, whitespace and tool/schema order are not rewritten. No semantic response matching occurs.

`X-Organized-Cache: off` disables exact reuse, not provider-native caching. `X-Organized-Cache-TTL` can shorten the configured TTL, but cannot exceed it. Defaults: 300 seconds, 128 response entries, 64 KB per response, and four times as many affinity entries per API key. Least-soon-useful entries (earliest expiry) are evicted first. Durable Object alarms remove expired data even for inactive clients.

## API and observability

| Method and path | Purpose |
|---|---|
| `GET /health` | Public process liveness; does not validate provider credentials |
| `GET /v1/models` | Authorized route aliases and supported endpoints |
| `POST /v1/responses` | Native OpenAI-compatible Responses |
| `POST /v1/chat/completions` | Native OpenAI-compatible Chat |
| `POST /v1/messages` | Native Anthropic Messages; `x-api-key` auth also accepted |
| `GET /api/cache/stats` | Per-key cumulative counters and latest 100 metadata-only receipts |
| `DELETE /api/cache` | Purge this key's cached responses and affinities; retain aggregate metrics |

Request and response payloads are absent from receipts. Response bodies exist in cache storage only for eligible opt-in requests. Purge increments a generation atomically, preventing older in-flight requests from repopulating the cache. Revoked keys are checked before the cache dispatch path.

Receipts correlate with `X-Organized-Request-Id`. They include candidate, status, duration, attempts and observed token counts. Provide optional `prices` per candidate in USD per million tokens: `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`. Missing usage or relevant rates yields `null`, never fabricated zero cost. `promptCacheDeltaUsd` compares the selected model's observed cache charges with the same input charged uncached; it can be negative. `avoidedCostUsd` on replay estimates the avoided cost using the original response. These are operational estimates, not invoice reconciliation or automatically billable savings. Unreported partial work on failed attempts cannot be priced; `unpricedAttempts` exposes this gap even when a later fallback succeeds. Costs and token totals cover the final provider response, not unreported earlier work.

## Failure and streaming behavior

429, 5xx, network failures, redirects and timeouts can advance to another configured candidate once each. Other errors are returned directly, preserving the provider body. This track does not enable the existing experimental request-healing module.

Streaming bypasses exact caching and single-flight reuse. The first upstream bytes must arrive before the response is committed; an empty or broken startup can fail over. After commitment, a failure closes the stream without starting another provider. SSE bytes pass unchanged; a bounded observer reads reported usage. A full stream timeout covers headers and body. Chat clients must request stream usage from the provider if they want token accounting. Missing usage stays unknown.

## Deploy yourself

`wrangler.toml` is the deployable gateway configuration. The historical `CONFIG/wrangler.product-plan.toml` still documents unprovisioned resources for the older billing/healing plan.

```sh
npx wrangler secret put GATE_API_KEY --config wrangler.toml
npx wrangler secret put PROVIDER_KEYS --config wrangler.toml
npx wrangler secret put ROUTER_CONFIG --config wrangler.toml
npm run deploy
```

No account IDs are committed and no deployment occurs during verification. For multiple client keys, add a `USERS` KV binding. Records live at `key:<sha256(JSON.stringify(rawKey))>` with `{ "active": true, "routes": ["alias"], "expiresAt": 1900000000000 }`; expiry is optional, milliseconds since epoch. Each API key gets an isolated Durable Object, even if several keys belong to the same person. KV authorization changes follow Cloudflare KV propagation semantics; use the bootstrap secret rotation for a single-key deployment, and do not assume globally instantaneous KV revocation.

## Current limits

The gateway has no learned quality classifier, Thompson-sampling optimizer, semantic cache, provider-independent shared KV cache, billing integration, dashboard, or production availability guarantee. It uses operator-approved candidate order with cache affinity. A single Durable Object coordinates one API key, so heavy keys may need future sharding; affinity and deduplication must remain consistent if sharding is added. Public production use also needs operator-specific rate/spend controls and provider credential validation. Local fixture tests establish protocol and cache behavior, not real-provider savings or production load capacity.
