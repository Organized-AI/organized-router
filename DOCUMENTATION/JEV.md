# Jev shadow decisions

The local Codex subscription proxy can now observe new tasks with TypeSafe's
Jev. This is an opt-in shadow policy: the selected Codex model, authentication,
request bytes, tool trajectory, cache controls and response stream stay intact.
The classifier cannot apply its recommendation. The Cloudflare API router's
existing affinity and fallback policy is unchanged.

## Enable on an installation

Jev requires a separate [TypeSafe account and API key](https://console.typesafe.ai/).
It does not use a Codex subscription to authenticate. The pinned model is
`jev-1.13.0` and the official JavaScript SDK is pinned to `0.6.0`.

Run the hidden prompt locally:

```sh
npm run jev:configure -- --restart
```

Alternatively, read a privately saved key without putting it in command arguments:

```sh
npm run jev:configure -- --key-file /absolute/path/to/typesafe-key --restart
```

Setup checks the key with a read-only model-catalog request before saving
`.local/jev.json` with mode 0600. The file is ignored by Git and read by the
background service; a shell export alone does not configure launchd. The service
restart refuses to interrupt active inference. If it is busy, retry
`npm run router -- service restart` after the active request finishes.

The default proposal maps `routine` to `gpt-5.6-luna`, `standard` to
`gpt-5.6-terra`, and `complex` to `gpt-6-astra`. These are hypotheses for a shadow
comparison, not measured quality rankings. Setup checks them against a locally
saved Codex catalog when available. Override them with `--routine-model`,
`--standard-model` and `--complex-model` on installations with different models.
Requests selecting a model outside this configured set are not sent to Jev.

```sh
npm run jev:status
npm run jev:probe
```

The probe makes one separately billed TypeSafe request using a public synthetic
task. It records `source=probe` and verifies access, the pinned model and response
shape while requesting telemetry export. Verify hosted delivery separately with
`npm run telemetry:status` and Grafana. It does not establish real-task routing quality.
`jev:status` reads authenticated live status at `/api/decisions`, including
whether Jev is actually active, counters, and the latest metadata-only decision.
Saved configuration alone is not proof of activation.

Disable and apply:

```sh
npm run jev:configure -- --off --restart
```

Fresh installations have Jev off and contain no shared TypeSafe or Grafana key.
Credentials belong to the installation. Switching Codex accounts in the same
installation still uses its configured TypeSafe/Grafana accounts. No central
Organized Router billing or hosted multi-tenant service is introduced.

## Data and request boundaries

Only an authenticated native `POST /responses` can produce a live decision.
The observer reads a bounded copy while the unmodified request streams upstream;
it never awaits the classifier before serving. The last input item must be a
user message (or the input must be a plain string). Tool/assistant continuations,
stateful `previous_response_id` requests, compaction, compressed bodies, and
bodies larger than 1 MiB are skipped. At most four request copies are retained
for parsing and two classifier calls run concurrently.

Jev receives the last user's text, limited to 2,000 characters by default, plus
a truncation flag and the fixed classification rubric. Recognized Codex context
wrappers, fenced code, links, obvious credential patterns, email addresses and
home-directory paths are omitted. System/developer messages, prior conversation,
tool results, model outputs, OAuth credentials, account/session IDs and cache keys
are never included in classifier state. This filtering is data minimization,
not a complete detector of private prose. Enabling this feature permits the
remaining task excerpt to be processed by TypeSafe.

TypeSafe says requests/responses are not used for training; zero data retention
is an enterprise offering, not a general guarantee. See its [model/data
documentation](https://docs.typesafe.ai/models).

## Cache, limits and failure behavior

`CONFIG/jev.local.example.json` documents the configurable defaults:

- A 1.5-second deadline and zero SDK retries; errors never retry via OpenAI API.
- At most 120 calls per process per hour. This resets on service restart and is
  a traffic guard, not an account-wide billing cap.
- A 10-minute in-memory decision cache with at most 256 entries. Matching
  in-flight requests coalesce. Identity covers an ephemeral, keyed account/session
  partition, selected model, pinned Jev version, policy version, candidate mapping,
  confidence threshold and the submitted excerpt/truncation flag. Raw partition
  identifiers and decision-cache keys are not logged or persisted.
- A 30-second cooldown after failure, or five minutes after authentication failure.
- Unknown choices, malformed probabilities, unpinned returned models, low confidence
  and `uncertain` retain the current model in the recorded recommendation. The
  0.8 threshold is an initial observation setting, not a validated accuracy floor.

The adapter pins TypeSafe's HTTPS endpoint, refuses redirects, bounds responses
to 64 KiB, and disables SDK logging even if a shell has debug logging enabled.
Error records use fixed categories rather than remote error bodies.

## Grafana and cost accounting

Each decision has an internal OTel span and completion log correlated to the
original router trace. The external classifier has its own client span.
Allowlisted metadata includes policy/baseline versions, pinned classifier,
task class, confidence, recommended and selected models, cache result, fallback
reason, duration, usage and `applied=false`. Task text, probabilities containing
unvalidated keys, and remote error messages never enter logs or traces.

In Grafana Explore, search the subscription service for
`organized.decision.completed`; use its trace ID to inspect the call. Synthetic
probes have `organized.decision.source=probe`; ordinary requests use `live`.
Existing Grafana destinations and sampling settings apply.

TypeSafe's documented price is $0.042 per million input tokens, with free output.
Known classifier costs are estimated from its reported usage and tracked
separately from Codex usage. Cache hits and coalesced observations have zero new
classifier usage. Failed or missing-usage calls increase `unpricedCalls`; they
are not assumed free. Neither decision caching nor prompt-cache tokens establish
Codex subscription-quota savings.

## Evaluation and PostHog

The proposed comparison is `jev-shadow-v1` versus `codex-selected-model-v1`.
Initially measure recommendation disagreement, abstention, classifier overhead,
cache reuse, errors and cost on real tasks. The current model always serves;
this cannot tell us whether the recommended alternative would succeed. Actual
substitutions require representative coding evaluations with task outcomes and
protocol/quality checks.

The user requested enabling this shadow policy on 2026-09-21. Complete live
credential/decision verification before calling this a ready-to-run experiment
for the [PostHog trigger](POSTHOG-TRIGGER.md). Fixtures and synthetic probes alone
are not evidence of coding-task success. The optional decision observer exposes
only validated metadata for a future analytics integration.

## Verification

`npm run test:jev` exercises the real pinned SDK against controlled responses,
timeouts, rate limits, response validation, cache/account isolation, usage
accounting, OTel correlation, private setup, and actual local HTTP subscription
streaming while a classifier is stalled. It makes no paid inference calls.
Run the existing subscription, telemetry, usage, connection, and `verify` checks
when modifying shared transport or telemetry code.
