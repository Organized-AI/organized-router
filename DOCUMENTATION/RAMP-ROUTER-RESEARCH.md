# Ramp Router research

Research date: 2026-09-16. Sources below are public first-party material. This is a reconstruction of documented behavior, not an inspection of Ramp's private implementation. No Ramp gateway source was found in this research, and no proprietary implementation is copied.

## How it was built

Ramp describes Router as an outgrowth of its internal production AI gateway: a shared API, provider integrations, request attribution, model evaluation, and routing policies. Its launch article describes years of internal use before opening the service to external developers. [Ramp launch](https://ramp.com/blog/router-launch)

The engineering article supplies a concrete routing algorithm. It estimates provider failures with an exponentially weighted moving average and models log-latency using a Normal-Inverse-Gamma posterior. Pooled sufficient statistics live in Redis. Thompson sampling estimates whether each candidate will miss the request deadline. Failure and deadline risk combine as `p(failure) + (1 - p(failure)) * p(latency > deadline)`. The selection balances these observations with caller preferences and costs. Ramp also describes a streaming variant. The article supports these algorithm and storage details; it does not establish the entire service's programming language, deployment topology, or database stack. [Ramp engineering](https://builders.ramp.com/post/thompson-sampling-model-routing)

The public Flex strategy preserves the provider/model while selecting a service tier. Explicit service-tier intent constrains optimization. [Cost-efficient routing](https://docs.router.com/strategies/cost-efficient-routing)

Switchyard is a distinct, opt-in strategy. It uses recent agent-turn signals, including tool failures and test outcomes, to choose between capable and efficient model tiers. This is separate from provider-health routing. [Switchyard](https://docs.router.com/strategies/switchyard-routing)

## What caching actually means

Ramp documents provider-owned prompt caching. It forwards explicit Anthropic cache markers and supported Responses cache controls. Eligible multi-candidate routes have affinity leases: five minutes by default and 24 hours for the corresponding retention request. Switching provider or model loses access to that provider/model's warm cache. Full-response caching is described as a separate optimization that is not currently self-service configurable. [Ramp caching](https://docs.router.com/strategies/cache-optimizations)

Failover handles transient failures, including rate limits, server errors and timeouts; terminal caller errors stop the chain. A committed stream cannot transparently switch providers. [Fallback contract](https://docs.router.com/guides/fallbacks)

Provider token accounting differs. OpenAI-style input counts include cached tokens; Anthropic exposes separate uncached, cache-read, and cache-write input buckets. Anthropic write pricing also distinguishes TTLs. Stable prefixes matter, and an affinity lease alone is not evidence of a cache hit. Only provider-reported usage establishes observed reuse. [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

## Organized Router design decisions

These are our implementation choices, not claims about Ramp:

1. Preserve native protocols and caller cache controls. OpenAI-compatible providers share Responses/Chat routes; Anthropic uses Messages. Avoid lossy automatic protocol translation.
2. Choose the first operator-approved candidate on a cold request. Reuse the successful candidate while a session's affinity lease remains valid. Transient failures advance through the remaining approved candidates.
3. Add opt-in, exact-response reuse for stateless, text-only, zero-temperature requests. Do not perform semantic similarity matching, which could return a plausible but incorrect answer.
4. Coordinate each API key with a Cloudflare Durable Object. This provides persistent cache state, request coalescing and atomic invalidation in the existing Workers stack. KV alone would not provide this coordination. [Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
5. Expose prompt read/write tokens, cache hits, upstream attempts, and bounded request receipts. Report price-based estimates separately from billable savings; cache writes can have a negative net benefit.
6. Use measured traffic to decide whether a learned routing policy is worthwhile later. This implementation does not claim to reproduce Ramp's Thompson sampler or its savings percentages.

## Verification criteria

The implementation must run in workerd, accept authenticated native API requests, preserve cache controls, avoid a second provider call on an exact hit, coalesce a concurrent burst, expire and purge stored data, prevent in-flight cache resurrection after purge, isolate keys and route revisions, retain working session affinity, fail over before streaming commitment, and report usage without double counting. Tests must inspect upstream call counts and wire bodies rather than relying only on response headers.
