# Organized Router

Cloudflare Workers/TypeScript gateway. Current work is the caching track in
`PLANNING/CACHE-FIRST-PLAN.md`; the older master plan describes a separate product vision.

## Verification

- `npm run verify`: types, behavioral tests, deployment dry run.
- `npm run test:runtime`: actual workerd, Durable Objects, local HTTP fixtures.
- `npm run test:subscription`: local subscription transport fixtures; no live inference.
- `npm run test:connection`: persistent configuration, migration, rollback and service ownership checks.
- `npm run test:connection-runtime`: saved configuration in native Codex CLI/app-server against a real Worker and dummy upstream.
- `npm run test:telemetry`: actual OTel SDKs, local capture, OTLP transport and collector failure behavior.
- `npm run test:usage`: pinned ccusage parser, quota freshness/privacy, authenticated polling, and native CLI argument regression.
- `npm run test:jev`: official Jev SDK, private setup, bounded shadow decisions, metadata privacy and unchanged subscription streaming.
- `npm audit`: dependency advisories.
- `git diff --check`: patch formatting.

## Invariants

- Authenticate and authorize before cache access. Isolate each API key.
- Exact response reuse requires explicit opt-in. Never cache tools, stateful responses or streams.
- Preserve prompt text, array order, schemas and provider cache controls.
- Cache identity covers credentials, route config, protocol, full request and policy.
- Purge generation must be checked atomically with storage writes.
- Never switch providers after a stream is committed.
- Do not count replayed historical usage as another provider charge.
- Unknown pricing/usage stays unknown; estimated savings must not enter billing.
- No request/response payloads in receipts, and no secrets in logs or commits.
- Subscription mode sends native Codex auth only to the fixed ChatGPT backend. Never fall back to paid API inference or persist OAuth credentials.
- Refuse transcript migration while any Codex transcript writer is open; a running desktop chat is not rerouted by changing saved settings.
- Preserve user edits during setup rollback as well as during unconfigure. Retain a recovery receipt when rollback is incomplete.
- Telemetry uses an attribute allowlist. Never emit payloads, credentials, account IDs, raw sessions, or arbitrary URLs. Collector outages must not break inference.
- ccusage inputTokens excludes cached input; normalize before comparing with native/router usage. Local and router counts overlap and must not be added. Codex-reported quota is separate from token counts and API-equivalent prices.
- Jev is opt-in shadow observation only. Never apply a classifier recommendation to a subscription request. TypeSafe receives only the configured bounded task excerpt, never native auth or tool/history payloads. Keep its usage and costs separate from Codex; disable SDK payload logging and retries.

## Local lessons

- Do not upgrade Wrangler without its matching optional workers-types peer.
- Write compact JSON directly to dotenv values; double-encoding escapes breaks JSON parsing.
- Clear only regenerable download caches when disk pressure blocks dependency installation.
- Wrap native fetch when assigning it as a class dependency; workerd requires the correct receiver.
- Cache eviction scans expiry metadata, not stored payloads, and deletes in batches of at most 128 keys.
- SQLite connection context managers commit/rollback but do not close; use `closing` to release handles.
- Codex 0.154.0 can drop root `-c` options when another `-c` follows the subcommand. Launchers must collect configuration options at the root and apply transport settings last; verify the effective native provider.
- Use the OpenTelemetry API's named `SpanKind` constants; the JS and OTLP wire enum numbers differ. Grafana's OTLP log gateway can acknowledge success with HTTP 204 and no body.
