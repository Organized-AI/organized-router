# Live Codex usage

Implemented 2026-09-17 with [ccusage](https://github.com/ccusage/ccusage) version
20.0.21 pinned in the lockfile. Research inspected commit
`3c5556a775ebcf1e59844d4283c8c5b30529c290`.

The current [ccusage live-monitor documentation](https://ccusage.com/guide/live-monitoring)
says its old `blocks --live` feature was removed in v18. Organized Router uses
the current Codex parser and supplies its own live view. It does not apply the
old Claude billing-block model to Codex subscriptions.

## Run

```sh
npm run usage
npm run usage:live
npm run router -- usage --watch --interval 5
npm run router -- usage --json
```

The subscription background service refreshes usage every 30 seconds without
blocking inference. The terminal polls its authenticated `/api/usage` endpoint
every five seconds. `--json --watch` emits one JSON object per refresh. Ctrl+C
stops the terminal view; background sampling continues with the router service.
If the service is unavailable, the command reads local records directly and
labels that fallback. No hosted Grafana connection is needed for the local view.

## Three scopes

| Reading | Source | Meaning |
|---|---|---|
| Local Codex tokens today | Pinned ccusage, local JSONL sessions and archives | Includes direct Codex connections as well as recorded router sessions; grouped in the machine's local timezone |
| Router usage since service start | Completed Responses SSE events | Only requests that traversed the local subscription router; process counters reset on restart |
| Subscription limits | Recent `token_count.rate_limits` snapshots written by Codex | Account limits as last reported, potentially shared with other devices; observed time and reset time are shown |

The first two readings overlap. Their counts are never added together. A router
probe launched with `--ephemeral` has no persisted session and therefore does not
appear in ccusage's session totals. Neither source is the active Codex goal's
token-budget counter or an invoice.

Limit snapshots older than five minutes, or with a passed reset time, are marked
stale. Missing limits remain unavailable. The reader does not guess a new balance
after reset or derive a plan limit from the 20x multiplier. Separate limit IDs
remain separate; an absent secondary window is not zero usage.

## Accounting

ccusage's `inputTokens` contains uncached input. Organized Router adds cache-read
and cache-creation tokens to produce total input, matching native Codex's
`input_tokens` convention. Cache-read percentage is cached input divided by total
input. Reasoning tokens are included in output, and are not added a second time.
Unknown or invalid numeric values remain unknown. Inferred model names are marked.

The parser handles repeated cumulative snapshots and duplicate active/archive
paths. Its current Codex support is experimental; see the
[upstream format and replay behavior](https://github.com/ccusage/ccusage/blob/3c5556a775ebcf1e59844d4283c8c5b30529c290/rust/adapters/codex/src/README.md).
Compressed `.jsonl.zst` archives are not included by this adapter. The quota reader
examines bounded tails of the 32 most recently modified active JSONL files, so a
missing snapshot does not prove that the account has no limit.

## Privacy and observability

Every parser invocation uses `--offline --no-cost` and a fixed empty ccusage
configuration. It makes no inference request and fetches no pricing data. API
equivalent cost estimates and subscription charges remain null. Cache counts do
not establish quota savings.

Only approved numeric fields and bounded model/limit identifiers enter the
snapshot. Prompts, generated text, tools, account identifiers, credit balances,
session IDs and paths are excluded. `/api/usage` requires the existing private
loopback key and rejects browser-origin requests. Polling does not generate more
request telemetry.

Changed daily totals emit `organized.usage.snapshot` OTel logs with the local date,
source and numeric token counts. These are separate from request completion logs
and do not create inference spans. They are aggregate snapshots: query the most
recent sample, not the sum of samples. Quota snapshots remain in the local view.
Existing OTLP configuration sends the usage logs to Grafana alongside request logs
when hosted export is connected. The current Grafana connection has been verified
with real usage snapshots; see the [ingestion report](../artifacts/grafana-ingestion-report.json).
This implementation does not add a Prometheus
metrics exporter or a hosted dashboard.

## Verification

`npm run test:usage` runs seven checks, including the real pinned ccusage binary,
duplicate cumulative usage, duplicate archives, quota freshness and privacy,
authenticated HTTP polling, serialized background scans, and OTel log redaction.
It also checks native Codex's effective provider when launchers receive a `-c`
option after the subcommand. Tests use local fixtures and no paid inference.

The installed subscription service's live `/api/usage` endpoint has been read
successfully with both the ccusage report and actual router counters present.
