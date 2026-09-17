# Cache-focused implementation track

User direction: build Organized Router after researching Ramp Router, focusing on caching. This track supersedes the previous F0-first implementation sequence for the current work. It does not claim to deliver the separate proposed billing, marketing, model-classification or repair products.

## Deliverables and evidence

| Requirement | Evidence |
|---|---|
| Research Ramp's published architecture, caching and routing behavior | `DOCUMENTATION/RAMP-ROUTER-RESEARCH.md`, linked primary sources and explicit unknowns |
| Runnable authenticated gateway on the existing Workers stack | `src/index.ts`, `wrangler.toml`, runtime HTTP checks |
| Native Responses, Chat and Anthropic Messages | Protocol-specific fixture requests and request-body assertions |
| Preserve prompt cache controls | Anthropic cache marker and Responses cache-key wire assertions |
| Preserve warm provider/model affinity with bounded failover | Clock-driven unit tests plus runtime failover/session check |
| Opt-in exact response cache with stable identity and isolation | Full request/config/credential hashes, auth and cache tests |
| Persistent, bounded storage, TTL cleanup and atomic purge | Durable Object transactions/alarms, restart/TTL/purge runtime tests |
| Coalesce concurrent duplicate requests | Ten-request burst tests asserting one upstream call |
| Respect streaming and stateful request semantics | Cache admission tests and byte-preserving stream tests |
| Auditable cache-token/cost metrics | Accounting tests and runtime receipt/upstream-count reconciliation |
| Self-hosting instructions and reproducible verification | README, CACHING.md, lockfile, `npm run verify`, `npm run test:runtime` |

## Verification approach

Pure policy and accounting tests cover deterministic boundaries; mocked provider integration tests cover failures and clock transitions. The separate runtime suite exercises the real workerd HTTP boundary, persistent Durable Object storage and concurrent calls. Provider fixtures use dummy credentials; no production traffic or paid inference is required. Dry-run packaging checks the actual deployment entry point. Dependency audit is performed after the upgrade.

Completion requires all listed evidence to pass, a clean patch check, a review of the implementation's actual limits, and a recorded runtime report. Live deployment and commercial-provider savings measurements are not claimed by local verification.
