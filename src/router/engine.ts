import { affinitySeconds, cachePolicy, completedResponse, hash, object } from '../cache/policy';
import { costs, usageFrom, UsageObserver } from './usage';
import { EMPTY_USAGE, type Affinity, type CacheEntry, type Candidate, type Endpoint,
  type Json, type Receipt, type RouterConfig, type Store, type Usage } from './types';
import type { RouterSpan, Telemetry } from '../telemetry/telemetry.mjs';

type Result = { response?: Response; body?: string; status: number; headers: Headers; candidate: string;
  usage: Usage; cost: number | null; delta: number | null; attempts: number; cacheable: boolean };
export function error(status: number, message: string): Response {
  return Response.json({ error: { type: 'router_error', message } }, { status, headers: { 'cache-control': 'no-store' } });
}
const retryable = (status: number) => status === 429 || status >= 500;
export async function readBounded(stream: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  let length = 0;
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return text + decoder.decode();
      length += part.value.byteLength;
      if (length > max) { await reader.cancel(); throw new Error('body_too_large'); }
      text += decoder.decode(part.value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export class RouterEngine {
  private pending = new Map<string, Promise<Result>>();
  constructor(private store: Store, private config: RouterConfig, private keys: Record<string, string>,
    private fetcher: typeof fetch = (...args) => fetch(...args), private now = () => Date.now(), private telemetry?: Telemetry) {}

  async handle(request: Request, waitUntil: (p: Promise<unknown>) => void = () => {}): Promise<Response> {
    const path = new URL(request.url).pathname;
    const span = this.telemetry?.start('router.request', request.headers.get('traceparent'), {
      'http.request.method': 'POST', 'http.route': ['/v1/responses', '/v1/chat/completions', '/v1/messages'].includes(path) ? path : 'unmatched' });
    try {
      const response = await this.route(request, waitUntil, span);
      if (span) response.headers.set('x-organized-trace-id', span.traceId);
      if (response.status >= 400) {
        span?.end({ 'http.response.status_code': response.status, 'error.type': 'request_failed' }, true);
        if (this.telemetry) waitUntil(this.telemetry.flush());
      }
      return response;
    } catch (error) {
      span?.end({ 'http.response.status_code': 503, 'error.type': 'router_error' }, true);
      if (this.telemetry) waitUntil(this.telemetry.flush());
      throw error;
    }
  }

  private async route(request: Request, waitUntil: (p: Promise<unknown>) => void, span?: RouterSpan): Promise<Response> {
    const path = new URL(request.url).pathname as Endpoint;
    const started = this.now();
    const requestId = crypto.randomUUID();
    let body: Json;
    try { body = object(JSON.parse(await readBounded(request.body, 1024 * 1024))); }
    catch (e) { return error(e instanceof Error && e.message === 'body_too_large' ? 413 : 400, 'Invalid or oversized JSON body'); }
    if (typeof body.model !== 'string' || !Object.hasOwn(this.config.routes, body.model)) return error(400, 'Unknown model alias');
    if (body.stream !== undefined && typeof body.stream !== 'boolean') return error(400, 'stream must be a boolean');
    if (path === '/v1/responses' ? body.input === undefined : !Array.isArray(body.messages)) return error(400, 'Missing input or messages');
    const candidates = this.config.routes[body.model].filter(c => c.endpoints.includes(path));
    if (!candidates.length) return error(400, 'Alias does not support this endpoint');
    if (candidates.some(c => !Object.hasOwn(this.keys, c.provider) || !this.keys[c.provider])) return error(503, 'Provider credentials are not configured');
    const cacheMode = request.headers.get('x-organized-cache');
    if (cacheMode && !['exact', 'off'].includes(cacheMode)) return error(400, 'x-organized-cache must be exact or off');
    const ttlText = request.headers.get('x-organized-cache-ttl');
    const ttl = ttlText === null ? this.config.responseTtlSeconds : Number(ttlText);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > this.config.responseTtlSeconds) return error(400, 'Invalid cache TTL');
    const epoch = await this.store.epoch().catch(() => -1);
    const forwarded = new Headers();
    for (const name of ['anthropic-version', 'anthropic-beta']) {
      const value = request.headers.get(name);
      if (value) forwarded.set(name, value);
    }
    const revision = await hash({ schema: 'organized-cache-v1', candidates, credentials: candidates.map(c => this.keys[c.provider]),
      headers: [...forwarded], tier: body.service_tier ?? null, epoch });
    const session = request.headers.get('x-organized-session') ?? body.prompt_cache_key;
    if (session !== undefined && session !== null && (typeof session !== 'string' || session.length > 512)) return error(400, 'Invalid session key');
    const affinityKey = session && epoch >= 0 ? await hash([path, body.model, revision, session]) : null;
    const affinity = affinityKey ? await this.store.get<Affinity>('a:' + affinityKey).catch(() => undefined) : undefined;
    const warm = affinity && affinity.expiresAt > this.now() && candidates.some(c => c.id === affinity.candidate) ? affinity.candidate : null;
    const ordered = warm ? [...candidates.filter(c => c.id === warm), ...candidates.filter(c => c.id !== warm)] : candidates;
    const bypass = epoch < 0 ? 'cache_unavailable' : cachePolicy(body, path, request.headers);
    // TTL is included so a short-lived request cannot borrow a longer-lived policy entry.
    const cacheKey = bypass ? null : await hash([path, revision, body, ttl, session ?? null]);
    const record = async (result: Result, cache: string, reused: boolean): Promise<void> => {
      const receipt: Receipt = { id: requestId, at: this.now(), route: String(body.model),
        ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
        candidate: result.candidate, status: result.status, cache, latencyMs: this.now() - started,
        attempts: reused ? 0 : result.attempts, usage: reused ? { ...EMPTY_USAGE, known: true } : result.usage,
        unpricedAttempts: reused ? 0 : Math.max(0, result.attempts - 1) + Number(result.cost === null),
        estimatedCostUsd: reused ? 0 : result.cost, promptCacheDeltaUsd: reused ? 0 : result.delta,
        avoidedCostUsd: reused && result.cacheable ? result.cost : null };
      await this.store.record(receipt).catch(() => {});
      span?.end({ 'organized.request.id': requestId, 'organized.route': String(body.model),
        'organized.candidate': result.candidate, 'organized.cache.result': cache,
        'organized.cache.affinity': warm === result.candidate ? 'warm' : 'cold',
        'organized.upstream.attempts': receipt.attempts, 'http.response.status_code': result.status,
        'organized.usage.known': receipt.usage.known,
        ...(receipt.usage.known ? { 'gen_ai.usage.input_tokens': receipt.usage.input, 'gen_ai.usage.output_tokens': receipt.usage.output,
          'organized.cache.read_tokens': receipt.usage.cacheRead, 'organized.cache.write_tokens': receipt.usage.cacheWrite5m + receipt.usage.cacheWrite1h } : {})
      }, result.status >= 400);
      if (this.telemetry) waitUntil(this.telemetry.flush());
    };
    const respond = (result: Result, cache: string): Response => {
      const headers = new Headers(result.headers);
      headers.set('cache-control', 'no-store');
      headers.set('x-organized-request-id', requestId);
      headers.set('x-organized-cache', cache);
      if (bypass) headers.set('x-organized-cache-bypass', bypass);
      headers.set('x-organized-candidate', result.candidate);
      headers.set('x-organized-affinity', warm === result.candidate ? 'warm' : 'cold');
      headers.set('x-organized-upstream-attempts', String(cache === 'hit' || cache === 'coalesced' ? 0 : result.attempts));
      return new Response(result.response?.body ?? result.body ?? '', { status: result.status, headers });
    };
    if (cacheKey) {
      const hit = await this.store.get<CacheEntry>('c:' + cacheKey).catch(() => undefined);
      if (hit && hit.expiresAt > this.now()) {
        const result: Result = { body: hit.body, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
          candidate: hit.candidate, usage: EMPTY_USAGE, cost: hit.cost, delta: null, attempts: 0, cacheable: true };
        await record(result, 'hit', true);
        const response = respond(result, 'hit');
        response.headers.set('age', String(Math.floor((this.now() - hit.createdAt) / 1000)));
        return response;
      }
      const existing = this.pending.get(cacheKey);
      if (existing) {
        const result = await existing;
        await record(result, 'coalesced', true);
        return respond(result, 'coalesced');
      }
    }
    const send = async (): Promise<Result> => {
      const result = await this.forward(body, path, forwarded, ordered, affinityKey, epoch, waitUntil,
        async final => { await record(final, 'bypass', false); }, span);
      if (!result.response) {
        if (cacheKey && result.cacheable && result.body && new TextEncoder().encode(result.body).length <= this.config.maxEntryBytes) {
          await this.store.putBounded('c:', cacheKey, { body: result.body, candidate: result.candidate,
            createdAt: this.now(), expiresAt: this.now() + ttl * 1000, cost: result.cost }, this.config.maxEntries, epoch).catch(() => {});
        }
        await record(result, cacheKey ? 'miss' : 'bypass', false);
      }
      return result;
    };
    const task = send();
    if (cacheKey) this.pending.set(cacheKey, task);
    try { return respond(await task, cacheKey ? 'miss' : 'bypass'); }
    finally { if (cacheKey) this.pending.delete(cacheKey); }
  }

  private async forward(body: Json, path: Endpoint, forwarded: Headers, candidates: Candidate[], affinityKey: string | null,
    epoch: number, waitUntil: (p: Promise<unknown>) => void, streamDone: (result: Result) => Promise<void>, span?: RouterSpan): Promise<Result> {
    let last: Result = { body: JSON.stringify({ error: { message: 'Provider unavailable' } }), status: 502,
      headers: new Headers({ 'content-type': 'application/json' }), candidate: '', usage: EMPTY_USAGE,
      cost: null, delta: null, attempts: 0, cacheable: false };
    const pin = async (c: Candidate) => {
      if (affinityKey) await this.store.putBounded('a:', affinityKey, {
        candidate: c.id, expiresAt: this.now() + affinitySeconds(body) * 1000,
      }, this.config.maxEntries * 4, epoch).catch(() => {});
    };
    for (const candidate of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      const headers = new Headers(forwarded);
      headers.set('content-type', 'application/json');
      if (candidate.protocol === 'anthropic') {
        headers.set('x-api-key', this.keys[candidate.provider]);
        if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
      } else headers.set('authorization', 'Bearer ' + this.keys[candidate.provider]);
      last = { ...last, attempts: last.attempts + 1, candidate: candidate.id };
      const attempt = span?.child('gen_ai.client', { 'gen_ai.provider.name': candidate.provider,
        'gen_ai.request.model': candidate.model, 'gen_ai.operation.name': path.slice('/v1/'.length),
        'organized.candidate': candidate.id, 'organized.upstream.attempt': last.attempts });
      if (attempt) headers.set('traceparent', attempt.traceparent);
      const finishAttempt = (status: number, usage: Usage) => attempt?.end({ 'http.response.status_code': status,
        'organized.usage.known': usage.known, ...(status >= 400 ? { 'error.type': 'upstream_error' } : {}),
        ...(usage.known ? { 'gen_ai.usage.input_tokens': usage.input, 'gen_ai.usage.output_tokens': usage.output,
          'organized.cache.read_tokens': usage.cacheRead, 'organized.cache.write_tokens': usage.cacheWrite5m + usage.cacheWrite1h } : {}) }, status >= 400);
      try {
        const upstream = await this.fetcher(candidate.baseUrl.replace(/\/$/, '') + path, {
          method: 'POST', headers, body: JSON.stringify({ ...body, model: candidate.model }),
          signal: controller.signal, redirect: 'manual',
        });
        const responseHeaders = new Headers({ 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        const retryAfter = upstream.headers.get('retry-after');
        if (retryAfter) responseHeaders.set('retry-after', retryAfter);
        if (upstream.status >= 300 && upstream.status < 400) {
          await upstream.body?.cancel();
          throw new Error('Provider redirect refused');
        }
        if (upstream.ok && body.stream === true) {
          if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
            await upstream.body?.cancel(); throw new Error('Expected SSE stream');
          }
          const reader = upstream.body.getReader();
          const first = await reader.read();
          if (first.done) throw new Error('Empty provider stream');
          const observer = new UsageObserver(candidate.protocol);
          observer.push(first.value);
          let ended = false;
          const base = { ...last, status: upstream.status, headers: responseHeaders, usage: EMPTY_USAGE };
          const finish = (failed: boolean) => {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            const prices = costs(observer.usage, candidate);
            finishAttempt(failed || !observer.complete ? 502 : base.status, observer.usage);
            waitUntil((async () => {
              if (!failed && observer.complete) await pin(candidate);
              await streamDone({ ...base, status: failed || !observer.complete ? 502 : base.status,
                usage: observer.usage, cost: prices.cost, delta: prices.delta, cacheable: false });
            })());
          };
          const stream = new ReadableStream<Uint8Array>({
            start(streamController) { streamController.enqueue(first.value); },
            async pull(streamController) {
              try {
                const part = await reader.read();
                if (part.done) { finish(false); streamController.close(); }
                else { observer.push(part.value); streamController.enqueue(part.value); }
              } catch (e) { finish(true); streamController.error(e); }
            },
            async cancel(reason) { controller.abort(); await reader.cancel(reason).catch(() => {}); finish(true); },
          });
          return { ...base, response: new Response(stream), cacheable: false };
        }
        const text = await readBounded(upstream.body, 8 * 1024 * 1024);
        clearTimeout(timer);
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        const usage = usageFrom(parsed, candidate.protocol);
        const prices = costs(usage, candidate);
        last = { ...last, body: text, status: upstream.status, headers: responseHeaders, usage,
          cost: prices.cost, delta: prices.delta, cacheable: upstream.status === 200 && completedResponse(parsed, path) &&
            !/no-store|private/i.test(upstream.headers.get('cache-control') ?? '') };
        finishAttempt(upstream.status, usage);
        if (upstream.ok) { await pin(candidate); return last; }
        if (!retryable(upstream.status)) return last;
      } catch {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        controller.abort();
        last = { ...last, status: timedOut ? 504 : 502,
          body: JSON.stringify({ error: { type: 'provider_error', message: 'Provider transport failed or timed out' } }),
          usage: EMPTY_USAGE, cost: null, delta: null, cacheable: false };
        finishAttempt(last.status, EMPTY_USAGE);
      }
      if (affinityKey) await this.store.delete('a:' + affinityKey).catch(() => {});
    }
    return last;
  }
}
