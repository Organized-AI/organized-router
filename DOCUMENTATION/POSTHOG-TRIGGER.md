**Deferred PostHog integration**

The user selected Grafana as the primary observability backend on 2026-09-17 and
authorized building the PostHog piece when it becomes useful.

The Codex heartbeat `build-posthog-when-useful` checks this project every six hours.
Implement PostHog when either condition has concrete evidence:

- The user has requested a specific routing-policy experiment that is ready to run.
- Real task-outcome events, such as test results, accepted results or task completion,
  make a specific comparison between at least two routing policies or models possible.

General roadmap/research text, this document, fixture traffic and request volume
alone do not satisfy the trigger. Current HTTP success and token counts cannot
establish coding-task success. Record the evidence that satisfies the condition.

When triggered, implement an optional PostHog integration that connects outcome
events with policy versions, models and trace identifiers. Keep Grafana as the
primary operational backend, preserve native Codex subscription inference, and
export metadata only. Keep prompt/output text, credentials, account identifiers
and raw session/cache keys outside telemetry. Verify classification, correlation,
retry behavior and usage accounting before activation.

Use an existing authorized PostHog connection if available. If account access is
missing, finish and test the integration code and report the configuration needed.
Record implementation evidence and completion in `.local/posthog-trigger-state.json`
so checks cannot repeatedly implement the same feature. Pause the heartbeat after
the implementation is complete. This follow-up does not automatically purchase a
plan or enable paid LLM judge evaluations.
