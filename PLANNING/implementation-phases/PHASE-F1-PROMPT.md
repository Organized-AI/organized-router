# Phase F1 - Error Normalizer and Signature

**Depends on:** F0
**Read first:** PLANNING/IMPLEMENTATION-MASTER-PLAN.md, DOCUMENTATION/HEALER-PROTOCOL.md, src/fix/index.ts

## Goal

Turn any provider 4xx into a stable `{ofCode, status, type, param, message}` and a signature
that is identical for the same failure cause and different for different causes. Everything
downstream, the catalog, the rules, the healer, the ledger, keys off this.

## Tasks

1. Capture real 4xx response bodies into `tests/fixtures/provider-errors/<provider>/<case>.json`.
   Minimum 30 fixtures across Anthropic, OpenAI, Gemini, and OpenRouter. Each fixture stores the
   request body that caused it, the HTTP status, and the raw error body. Redact any prompt content.
2. Split `src/fix/index.ts` into `normalize.ts` and `signature.ts`, keeping the orchestrator in
   `index.ts`. No behavior change.
3. Extend `mapOfCode` to cover every OF4xx class in the master plan taxonomy. Each class needs at
   least one fixture proving the mapping.
4. Extend `extractParam` with the patterns the fixtures actually produce. Do not invent patterns
   with no fixture behind them.
5. Write `tests/normalize.test.ts` and `tests/signature.test.ts`.
6. Write `DOCUMENTATION/ERROR-CODES.md`, one section per OF code: what the caller saw, why it
   happened, whether it is repairable, and the canonical patch if there is one.

## Success criteria

- [ ] 30+ fixtures normalize to the expected OF code, asserted in tests
- [ ] The same failure cause produces an identical signature across two different prompts,
      two different message contents, and two different request ids
- [ ] A different `param` produces a different signature
- [ ] A different model in the same family produces the SAME signature
      (`claude-sonnet-4-6-20260101` and `claude-sonnet-4-6` collapse to one family)
- [ ] `npm run typecheck` and `npm test` both pass
- [ ] No prompt content appears anywhere in `tests/fixtures/`

## Notes

Signature stability is the entire economic argument. If signatures are too specific the catalog
never hits and every repair pays for a healer call. If they are too loose a patch gets applied to
a failure it does not actually fix, and the retry burns a request for nothing. When in doubt,
prefer too specific: a catalog miss costs money, a bad patch costs trust.

## On completion

Write `PLANNING/implementation-phases/PHASE-F1-COMPLETE.md` recording the fixture count per
provider, the OF codes covered, and any error shape that resisted normalization.
Commit as `feat(fix): phase F1 normalizer and signature`.
