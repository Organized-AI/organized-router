# Verification record

Verified locally on 2026-09-16/17, using Node 22.22.3, Wrangler 4.133.0 and Vitest 5.0.1.

| Gate | Result |
|---|---|
| TypeScript strict typecheck | Passed |
| Behavioral unit/integration tests | 71 passed across three test files |
| Worker deploy dry run | Passed; gateway and RouterCache Durable Object bundle |
| Real workerd HTTP/runtime checks | 13 passed |
| Dependency audit, including dev dependencies | Zero reported vulnerabilities |
| Patch whitespace check | Passed |

The [runtime report](../artifacts/runtime-report.json) records the latest execution and receipts. Fixture rates are deliberately synthetic and are not provider price quotes or measured commercial savings.

Runtime evidence includes unauthorized request rejection, exact-hit upstream suppression, persistence across restart, ten concurrent requests sharing one provider call, TTL expiry, alarm cleanup without another generation request, warm fallback affinity, Anthropic marker preservation, Chat response caching, streaming usage, in-flight purge protection, deletion of more than 128 affinity records, and reconciliation of receipts against actual HTTP provider calls.

Implementation review found and corrected a native-fetch receiver issue visible only in workerd. It also changed storage eviction to scan metadata instead of loading cached bodies, chunked deletes to respect storage limits, and added unknown-attempt accounting. Cached responses are bounded; keys and cache state are isolated; response bodies are stored only on explicit eligible opt-in; no prompt bodies are included in receipts.

No cloud deployment, real model-provider request, production load test, invoice reconciliation, or measured production savings is claimed. Run `npm run verify` and `npm run test:runtime` to reproduce the local checks.
