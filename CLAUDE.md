# Organized Router

Cloudflare Workers/TypeScript gateway. Current work is the caching track in
`PLANNING/CACHE-FIRST-PLAN.md`; the older master plan describes a separate product vision.

## Verification

- `npm run verify`: types, behavioral tests, deployment dry run.
- `npm run test:runtime`: actual workerd, Durable Objects, local HTTP fixtures.
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

## Local lessons

- Do not upgrade Wrangler without its matching optional workers-types peer.
- Write compact JSON directly to dotenv values; double-encoding escapes breaks JSON parsing.
- Clear only regenerable download caches when disk pressure blocks dependency installation.
- Wrap native fetch when assigning it as a class dependency; workerd requires the correct receiver.
- Cache eviction scans expiry metadata, not stored payloads, and deletes in batches of at most 128 keys.
