# Organized Router - Implementation Master Plan

**Runtime:** Cloudflare Workers, Workers Assets, D1, KV, Durable Objects, Queues, R2
**Account:** ${CF_ACCOUNT_ID} | **Zone:** ${CF_ZONE_ID}
**Stripe:** acct_XXXXXXXXXXXXXXXX
**Billing:** MIT source, free to self-host. Hosted at $50/month plus 5% of verified savings, billed on Stripe. See DOCUMENTATION/PRICING.md

---

## Architecture

```
                          CALLER  (Claude Code, Codex, OpenClaw, Hermes, any OpenAI-compatible client)
                                             |
                                             v  POST /v1/chat/completions   Authorization: Bearer org_...
  +-------------------- CLOUDFLARE WORKER: organized-router ------------------------------------+
  |                                                                                             |
  |   +----------+    +------------+    +--------------+    +----------------------------+     |
  |   | AUTH +   |--->| TASK       |--->| ROUTING      |--->| PROVIDER FAN-OUT           |     |
  |   | LIMITS   |    | CLASSIFIER |    | TABLE (D1)   |    | Anthropic | OpenAI | Gemini|     |
  |   | OF0xx    |    | heuristic +|    | class x model|    | via CF AI Gateway          |     |
  |   | OF2xx    |    | Haiku pass |    | x quality    |    | + local tier (DGX/Ollama)  |     |
  |   +----------+    +------------+    +--------------+    +-------------+--------------+     |
  |                                                                       |                     |
  |                                            provider returns 4xx ------+                     |
  |                                                                       v                     |
  |   ===================== ORGANIZED FIX ====================================================  |
  |                                                                                             |
  |    +------------+   status in {400,404,422,OF302}? -- no --> straight to FALLBACK           |
  |    | NORMALIZER |                                                                            |
  |    | provider   |--> {of_code, type, param, message}                                        |
  |    | error      |                                                                            |
  |    +-----+------+                                                                            |
  |          v                                                                                   |
  |    +------------+  sha256(provider|model_family|status|of_code|type|param|body_key_set)      |
  |    | SIGNATURE  |                                                                            |
  |    +-----+------+                                                                            |
  |          v                                                                                   |
  |    +------------------+  hit    +--------------------------------------+                     |
  |    | TIER 0  CATALOG  |-------->|          APPLY PATCH                 |                     |
  |    | KV patch:<sig>   |         |   (delete / set / rename / clamp)    |                     |
  |    +--------+---------+         |                  |                    |                     |
  |        miss |                   |                  v                    |                     |
  |             v                   |        ONE RETRY, NO LOOP             |                     |
  |    +------------------+  hit    +--------+------------------+----------+                     |
  |    | TIER 1  RULES    |------------------+                  |                                |
  |    | deterministic    |         success  |                  | still fails                    |
  |    +--------+---------+                  v                  v                                |
  |        miss |               +----------------------+  +------------------+                   |
  |             v               | PROMOTE to catalog   |  |  FALLBACK CHAIN  |                   |
  |    +------------------+     | + repairs log        |  |  (unchanged)     |                   |
  |    | TIER 2  HEALER   |     +----------+-----------+  +------------------+                   |
  |    | Haiku, scrubbed  |                |                                                     |
  |    | 10s timeout      |                v                                                     |
  |    +--------+---------+     +--------------------------------------+                         |
  |             v               |  STRIPE METER: savings_share (5%)    |                         |
  |    +------------------+     |  GITPAYWALL: $50/mo entitlement      |                         |
  |    | BREAKER (DO)     |     +--------------------------------------+                         |
  |    | 3 fails -> 30s   |                                                                      |
  |    | open, quiet fail |                                                                      |
  |    +------------------+                                                                      |
  |   ==========================================================================================  |
  |                                                                                             |
  |   STATE:  D1 provider_attempts . repairs . patch_catalog . savings_ledger . receipts        |
  |           KV  patch:<sig> . user:<key> . route:<class>                                      |
  |           DO  HealerBreaker . RateLimiter        QUEUE  receipt-ingest . meter-flush        |
  |           R2  full body archive (opt-in message recording)                                  |
  +---------------------------------------------------------------------------------------------+
             |                              |                                |
             v                              v                                v
   guide/wiki/arch.organizedai.vip   errors.organizedai.vip        gate.organizedai.vip
   /organized-router                 public patch catalog (MIT)    leaderboard + receipts
   (Workers Assets, GSAP)            SEO surface                   savings + recovery cards
```

---

## Behavior Contract

These rules are the product. Do not deviate.

| Rule | Behavior |
|---|---|
| Narrow trigger | Repair only 400, 404, 422, and OF302 (model not available). Never 401, 403, 429, or any 5xx |
| Order | Repair runs BEFORE the fallback chain. Fallback stays the safety net |
| One retry | Exactly one patched retry. No loop, no retry budget |
| Quiet degradation | Healer error or timeout returns the ORIGINAL provider error. Never a synthetic 500 |
| Circuit breaker | 3 consecutive healer transport failures opens a 30s cooldown. One success clears it |
| Separate attempts | Failed original and patched retry are distinct provider_attempts rows sharing a request_id |
| Per-agent toggle | Off means the request body never leaves the request path |
| Success only | Recovered means the patched retry actually succeeded |
| Streaming | Repair only before the first byte reaches the client |

---

## Error Taxonomy (OF001-OF500)

| Range | Domain | Repairable |
|---|---|---|
| OF001-OF005 | Auth: missing header, empty bearer, bad key shape, expired, unknown key | No |
| OF100-OF102 | Provider: key missing, none configured, subscription credentials unusable | No |
| OF200-OF204 | Limits: usage cap, per-user rate, per-IP rate, concurrency, plan quota | No |
| OF300-OF303 | Validation: missing messages array, malformed param, model not available, local provider unreachable | Yes |
| OF400-OF412 | Repair classes: unsupported param, param out of range, tool schema shape, response_format shape, model alias moved, system message placement, image block format, max_tokens ceiling, streaming flag conflict, role sequence, content block type, stop sequence limit, temperature/top_p conflict | Yes |
| OF500 | Internal | No |

---

## Phases

| Phase | Name | Key files | Depends on |
|---|---|---|---|
| F0 | Organized Codebase bootstrap + OF taxonomy | CLAUDE.md, .claude/{skills,commands,agents,hooks}, DOCUMENTATION/ERROR-CODES.md | none |
| F1 | Error normalizer + signature | src/fix/normalize.ts, src/fix/signature.ts, tests/fixtures/provider-errors/ | F0 |
| F2 | Tier 0 catalog + Tier 1 rules | src/fix/catalog.ts, src/fix/rules.ts, migrations/0003 | F1 |
| F3 | Tier 2 healer + circuit breaker | src/fix/healer.ts, src/do/HealerBreaker.ts | F2 |
| F4 | Request-path integration | src/router/pipeline.ts, src/fix/index.ts | F3 |
| F5 | Recovery observability surface | assets/fix/index.html (GSAP), src/api/fix-stats.ts | F4 |
| F6 | Subscription + savings-share billing | src/billing/meters.ts, src/billing/entitlement.ts, migrations/0004 | F4 |
| F7 | Public error catalog | assets/errors/, src/api/catalog-publish.ts | F2, F6 |
| F8 | Conversion tracking | GTM-CONTAINER-IMPORT.json, sGTM + CAPI events | F6 |

### F1 - Normalizer and Signature
Capture real 4xx bodies from Anthropic, OpenAI, Gemini, and OpenRouter into fixtures. Normalizer produces `{of_code, type, param, message}`. Signature hashes provider, model family, status, of_code, type, param, and the sorted top-level body keys.
Success: 30+ fixtures map to correct OF codes. Identical failures across two different prompts produce an identical signature. Different params produce different signatures.

### F2 - Catalog and Rules
KV read path `patch:<signature>` with a D1 mirror. Patches are ordered op lists (delete, set, rename, clamp, wrap). At least 8 deterministic rules covering the OF4xx classes. Apply-patch is pure and size bounded.
Success: a known bad request repairs in under 5ms at zero LLM cost. A patch exceeding FIX_MAX_PATCH_BYTES is rejected. Hits and misses both logged.

### F3 - Healer and Breaker
Healer runs on its own worker (fix.organizedai.vip) so it can be self-hosted or swapped. Secrets scrubbed before send. Haiku returns a strict patch op list as JSON only. 10s timeout. HealerBreaker DO opens after 3 consecutive transport failures for 30s.
Success: healer down means the caller sees the original provider error. Breaker verifiably stops calls during cooldown. Healer cost recorded per repair.

### F4 - Integration
Insert Fix between provider failure and fallback. One patched retry. Per-agent toggle from the KV user record. Both attempts logged.
Success: fallback still runs when the patch fails. A toggle-off agent never has its body leave the request path.

### F5 - Recovery Surface
Cards: request success rate, recovered requests, recovered by Fix, catalog hit rate, healer spend. Per-signature table ranked by occurrences. GSAP count-ups and FLIP row transitions. Dark terminal, JetBrains Mono, gold/teal/lime. Workers Assets.
Success: every card links to a filtered request log. Catalog hit rate trends up as the catalog fills.

### F6 - Billing
Stripe webhooks provision and revoke the org_ key and plan flag. Savings share metered at 5% against the frozen receipt baseline, classifier probe subtracted, floored at zero, voided by !bad feedback. Meter events buffered through the queue.
Success: /api/billing/preview resolves every share line to a request id with baseline price, selected price, and timestamp. A cancelled subscription drops to read-only observability for 30 days.

### F7 - Public Catalog
Promote a signature to published after N verified successes across M distinct users. Static pages at errors.organizedai.vip/OFxxx generated from patch_catalog. Published catalog is MIT.
Success: a published page shows the error, the OF code, the patch, and the providers affected, with no user prompt content anywhere.

### F8 - Conversion Tracking
Events into GTM-XXXXXXX, forwarded through sGTM GTM-YYYYYYY to GA4 G-XXXXXXXXXX, Google Ads Enhanced Conversions, and Meta CAPI. Purchase carries value 50.00, savings_share_billed carries the actual share.
Success: dedupe via event_id across browser and server. No $0 purchase values.

---

## Wrangler CLI Prerequisites

MCP cannot do these.

```bash
wrangler d1 migrations apply organized-router-db --remote
wrangler kv namespace create PATCH_CATALOG
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put HEALER_API_KEY
wrangler secret put GATE_ADMIN_KEY
wrangler queues create meter-flush
wrangler deploy
wrangler deploy --config workers/fix-healer/wrangler.toml
```

Workers Assets via the [assets] block. Never Cloudflare Pages.

---

## Risks

- **Self-hosting versus the share.** A subscriber can self-host and the 5% is unenforceable on their own instance. That is intentional. The share is metered only on the hosted gateway, and the $50 is what the self-hoster pays for. Do not try to enforce the share in code a customer runs.
- **Prompt exposure.** The healer sees the failing body. Scrubbing is necessary but not sufficient. The per-agent toggle and a self-hostable healer are the real answer.
- **Patch poisoning.** A promoted patch that works for one caller could break another. Promotion requires N successes across M distinct users, and any patch with a rising fail_count is demoted automatically.
- **Provider ToS.** Rewriting a request body is fine. Reselling routed access is fine on BYOK. Review resale terms before fronting keys.
- **License hygiene.** The prior art is MIT. Behavior is not copyrightable and the design is credited in the README. Do not vendor Manifest source into a source-available repository without honoring MIT.
