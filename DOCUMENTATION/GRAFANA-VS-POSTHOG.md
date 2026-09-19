**Grafana vs PostHog for Organized Router**

Research checked 2026-09-17. Recommendation: start with Grafana Cloud for the
router's operational logs and traces. PostHog is a credible alternative if product
analytics and routing experiments are immediate requirements. This is a design
judgment based on the workflows below, not a hosted performance benchmark.

The current products overlap substantially. PostHog offers
[OTLP-native logs](https://posthog.com/docs/logs) and a
[general distributed tracing backend in beta](https://posthog.com/docs/distributed-tracing).
Grafana offers [Agent Observability](https://grafana.com/docs/grafana-cloud/observe-and-act/agent-observability/introduction/)
with conversations, generation tracking, evaluations and offline experiments.
Neither should be evaluated using an older infrastructure-versus-analytics split.

| Decision | Grafana | PostHog | Implication here |
|---|---|---|---|
| Investigate a slow or failed request | Logs, general traces and operational metrics in one observability stack | Logs and general traces, with the tracing backend currently in beta | Grafana is my initial choice for operating a gateway |
| Explain cache behavior | Custom cache dimensions can be correlated with latency, errors and upstream attempts | The same dimensions can be queried in logs/events and traced | Instrumentation quality determines whether either can explain a cache miss |
| Measure whether routing improves outcomes | Agent evaluations and custom operational/quality views | AI observability joined to product events, feedback and feature-flag experiments | PostHog is attractive when adoption and completed tasks drive decisions |
| Use existing OpenTelemetry | General OTLP ingestion | General OTLP ingestion plus a separate AI-specific endpoint | Both are viable; endpoint choice and generation mapping require care |
| Expand to infrastructure metrics | Prometheus/Mimir, Loki and Tempo are a natural fit | Log-derived and product metrics are useful; they cover a different operational workflow | Grafana better matches a future gateway SLO/metrics stack |
| Operate one system | Observability can stay in Grafana | Product analytics and observability can share PostHog | Avoid deploying both until a concrete question requires the second |

Grafana's [OTLP documentation](https://grafana.com/docs/grafana-cloud/observe-and-act/send-data/otlp/)
describes ingestion of all three signals and their storage in Loki, Tempo and
Prometheus/Mimir. PostHog's [experiment documentation](https://posthog.com/docs/experiments)
describes user assignment, exposure tracking and event/warehouse outcome metrics.
The preferences in the table are our assessment of those capabilities.

**The case for Grafana: explain the router's behavior.**

Consider a hypothetical regression: cached input falls while requests get slower.
We want to connect the affected requests to their model, route, cache outcome,
upstream attempts, status and timing. An upstream 429 followed by a successful
fallback can explain a slow request and a change in cache warmth. A stream that
fails after returning HTTP 200 must remain visible as a failure. A local exact hit
should show no new upstream inference. These are operational questions before
they are product questions.

Grafana lets us keep that investigation beside future request-rate, latency,
error-rate, queue and exporter-health metrics. The useful setup is a small set of
dashboards and trace/log links tailored to our router. Sending OTLP alone does
not create those views or automatically explain every cache miss.

The tradeoff is configuration work: bounded labels, queries, retention, sampling,
dashboards and alerts still need owners. Self-hosting additionally means operating
the backing stores. Grafana Cloud is the lower-maintenance starting point for this
project; running a complete local observability stack is unnecessary for the
current private-file capture workflow.

**The case for PostHog: measure what a routing change accomplishes.**

Suppose two policies have similar latency, but one requires more retries and fewer
tasks reach an accepted result. PostHog can connect a policy exposure to captured
task-completion, test-result and feedback events, then compare those outcomes.
Its [AI observability](https://posthog.com/docs/ai-observability) also connects
model interactions to the surrounding product data. That becomes compelling if
Organized Router develops a team dashboard or a customer-facing application.

Those outcomes require explicit instrumentation. The gateway cannot infer that
a code change passed tests or was accepted from the model's HTTP response alone.
Session replay also needs an instrumented application; installing a telemetry
exporter does not make the native Codex desktop interface replayable.

For a cache experiment, I would assign a policy consistently for a conversation
and record its version. Switching policies on every request changes cache warmth
and makes the experiment harder to interpret. Compare similar tasks and record
unknown outcomes explicitly. These are proposed experiment-design rules, not
features currently implemented in Organized Router.

**Protocol compatibility needs an exact comparison.**

PostHog has two tracing paths. Its beta distributed tracing backend accepts general
OTLP spans. Its separate [AI OTLP endpoint](https://posthog.com/docs/ai-observability/installation/opentelemetry)
accepts AI-related spans, preserves trace relationships and maps supported GenAI
attributes to AI events; unrelated spans are discarded there. That AI endpoint
uses a signal-specific URL. Its restrictions must not be generalized to all of
PostHog.

Our current exporter can send standard OTLP HTTP/JSON logs and traces to a collector.
A PostHog collector configuration would route each signal to the documented
endpoint. Its [general tracing setup](https://posthog.com/docs/distributed-tracing/installation/nodejs)
uses HTTP/protobuf, which a collector can export from our JSON input. Populating
AI generation views additionally needs a mapping review:
an HTTP operation named `responses` is not automatically a correctly classified
generation, and request plus attempt records must not count the same usage twice.

Grafana has a similar distinction between telemetry and its richer AI product:
generic OTLP traces arrive in Tempo, while Agent Observability generation records
use a separate API. Choosing Grafana does not automatically enable its conversation
and evaluation features. Neither vendor's hosted ingestion has been verified for
this repository yet.

**Keep caching measurements separate.**

- Native prompt-cache reuse: reported cached input divided by normalized total
  input, across calls with known usage. Track missing usage and provider semantics.
- Exact response reuse: eligible API requests answered locally without inference.
  Subscription mode does not replay cached answers.
- Affinity: whether a route reused its selected upstream; this alone does not
  prove the provider cache was warm.
- User benefit: latency, successful completion, retries and accepted results.
  Token reuse alone cannot establish those outcomes.

Neither backend makes the router cache more effectively by receiving telemetry.
It provides evidence for changing routing and cache policy. Ramp-style provider
selection needs failure/latency evidence; modelrouter-style quality decisions also
need labeled outcomes. Keep the router's live decision state local to its routing
path so an analytics outage cannot stop requests.

**Privacy and the Codex subscription remain separate decisions.**

The current implementation exports metadata only: no prompts, responses, OAuth
tokens, API keys, account IDs or raw session/cache keys. Preserve that allowlist
before data leaves the process. PostHog offers
[SDK privacy mode](https://posthog.com/docs/ai-observability/privacy-mode), but an
OTLP sender still needs its own content policy. Grafana's
[coding-agent integrations default to metadata-only capture](https://grafana.com/docs/grafana-cloud/observe-and-act/agent-observability/privacy-and-security/privacy/);
general agent SDK message capture requires separate review.

Telemetry APIs do not require switching inference to a paid OpenAI API account.
The verified subscription transport remains native Codex authentication. Track
observed token/cache counts and latency; do not label API list-price estimates as
the user's subscription bill or infer an increase in subscription quota. Paid LLM
judge evaluations are a separate decision from capturing telemetry.

**Cost and retention, checked on the research date.**

| Service | Relevant published allowance | Meaning for this decision |
|---|---|---|
| Grafana Cloud telemetry | 50 GB logs/month and 50 GB traces/month; 14-day retention on Free. Pro starts at $19/month plus usage | An initial metadata-only trial can use the free plan; volume and retention still need measurement |
| Grafana Agent Observability | Separate generation/evaluation meters; metering starts October 1, 2026 | Rich AI features are a separate cost choice from ordinary OTLP storage |
| PostHog | 10 GB logs/month and 100,000 AI events/month free; logs default to 14-day retention | AI events are not equivalent to general trace GB or completed coding tasks |

Sources: [Grafana pricing](https://grafana.com/pricing/),
[Grafana Agent Observability billing](https://grafana.com/docs/grafana-cloud/observe-and-act/agent-observability/pricing/),
[PostHog pricing](https://posthog.com/pricing/), and
[PostHog log retention/pricing](https://posthog.com/docs/logs/pricing).
PostHog keeps large AI message properties for
[30 days while retaining other event metadata under its event policy](https://posthog.com/docs/ai-observability/data-retention).
This table does not establish a price for PostHog's beta general tracing product.
Measure spans, event fan-out and bytes on our actual workload before estimating
paid usage; neither the free-tier event count nor provider token cost is a bill
for the entire observability stack.

For the current caching and subscription-transport work, use Grafana Cloud as the
first hosted destination once a destination is selected and configured. Revisit
PostHog when routing experiments, user feedback and task outcomes become immediate
work. If those are already the primary product requirements, PostHog alone is a
reasonable starting choice after validating its beta tracing on our fixture.
The [existing local capture and collector setup](OBSERVABILITY.md) keeps this
choice reversible. No hosted destination was activated by this comparison.
