# Verification record

Verified locally on 2026-09-16/17, using Node 22.22.3, Wrangler 4.133.0 and Vitest 5.0.1.

| Gate | Result |
|---|---|
| TypeScript strict typecheck | Passed |
| Behavioral unit/integration tests | 72 passed across three test files |
| Local subscription transport tests | 6 passed |
| Configuration, migration, rollback, service ownership and private Grafana setup tests | 22 passed |
| OpenTelemetry SDK/export/local capture tests | 6 passed |
| Live usage, ccusage and native CLI argument regression | 7 passed |
| Live Codex subscription request | Passed; router and CLI usage reconciled |
| Worker deploy dry run | Passed; gateway and RouterCache Durable Object bundle |
| Real workerd HTTP/runtime checks, including native Codex and OTLP | 15 passed |
| Dependency audit, including dev dependencies | Zero reported vulnerabilities |
| Patch whitespace check | Passed |

The [runtime report](../artifacts/runtime-report.json) records the latest execution and receipts. Fixture rates are deliberately synthetic and are not provider price quotes or measured commercial savings.

Runtime evidence includes unauthorized request rejection, exact-hit upstream suppression, persistence across restart, ten concurrent requests sharing one provider call, TTL expiry, alarm cleanup without another generation request, warm fallback affinity, Anthropic marker preservation, Chat response caching, streaming usage, in-flight purge protection, deletion of more than 128 affinity records, and reconciliation of receipts against actual HTTP provider calls.

Implementation review found and corrected a native-fetch receiver issue visible only in workerd. It also changed storage eviction to scan metadata instead of loading cached bodies, chunked deletes to respect storage limits, and added unknown-attempt accounting. Cached responses are bounded; keys and cache state are isolated; response bodies are stored only on explicit eligible opt-in; no prompt bodies are included in receipts.

The [subscription report](../artifacts/subscription-report.json) records a live
Codex CLI 0.154.0 request through the local proxy using the existing ChatGPT login
and `gpt-6-astra`. Both CLI and router reported 17,039 input tokens, 9,088 cached
input tokens, and 10 output tokens. Two model-list requests and one completed
generation reached the fixed subscription backend, with no failures in the final
run. No provider API key was supplied. Two earlier tiny probes established the
transport and exposed a missing Content-Type header and native client close after
the terminal event; regression coverage now handles both.

Subscription fixtures cover local authentication, browser/host rejection, fixed
upstream routing, exact body and session-header preservation, unchanged SSE,
metadata-only counters, quota errors, blocked redirects, bounded usage parsing,
model lists, compaction, and terminal completion before HTTP close. Run
`npm run test:subscription` to reproduce these tests without live inference.

The [live subscription/telemetry report](../artifacts/subscription-telemetry-report.json)
records a new native request with 18,027 input tokens, zero reported cached tokens
and 10 output tokens. CLI, router and correlated local OTLP records agree. This
probe also verified the launcher fix for Codex 0.154.0 dropping root configuration
overrides when another `-c` option follows the subcommand. The launcher now moves
user configuration options to the root and applies transport settings last.

The [live usage monitor](LIVE-USAGE.md) has seven passing checks, including the
installed ccusage binary and native Codex configuration. Its installed service
endpoint returns current local usage, recorded subscription-limit snapshots and
the separately counted real router response. This proves local live capture;
hosted Grafana ingestion still requires its own end-to-end evidence.
The running terminal watch refreshed against the installed service and stopped
on Ctrl-C. Four additional Grafana setup checks cover allowed
destinations, owner-only settings, failure preservation, response privacy,
partial rejections and refusing credential forwarding on redirects.

The [native connection report](../artifacts/connection-runtime-report.json)
records an isolated Codex CLI/app-server test against the real Worker with a dummy
upstream. Saved configuration selected `organized-router` without process-level
provider overrides. The app server listed the model and retained native history
visibility both before and after unconfigure. This proves the fixture connection;
the user's real default is still `openai` pending an idle Codex restart/migration.

The [OTLP runtime report](../artifacts/telemetry-runtime-report.json) reconciles
167 request spans, 155 upstream spans and 167 correlated completion logs against
actual workerd HTTP traffic. Checks include payload redaction, trace propagation,
fallback attempts and zero new inference tokens on exact replay. The separate SDK
suite covers collector failure, partial rejection, rotation and response streaming
while export is slow. These are local receiver tests, not hosted Grafana or PostHog
ingestion tests.

No cloud deployment, production load test, invoice reconciliation, incremental
cache improvement, or measured production savings is claimed. Run `npm run verify`
and `npm run test:runtime` to reproduce the original gateway checks. Subscription
cache hits are backend observations and do not imply a change to plan limits.
