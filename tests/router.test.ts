import { describe, expect, it, vi } from 'vitest';
import { RouterEngine } from '../src/router/engine';
import { completion, config, keys, MemoryStore, request } from './helpers';

function setup(fetcher = vi.fn<typeof fetch>(async () => completion()), clock = () => Date.now()) {
  const store = new MemoryStore();
  return { store, fetcher, engine: new RouterEngine(store, structuredClone(config), keys, fetcher, clock) };
}
describe('exact response cache', () => {
  it('returns a hit without another provider call and does not bill historical usage twice', async () => {
    const { engine, store, fetcher } = setup();
    const first = await engine.handle(request());
    const second = await engine.handle(request());
    expect(first.headers.get('x-organized-cache')).toBe('miss');
    expect(second.headers.get('x-organized-cache')).toBe('hit');
    expect(await second.json()).toEqual(await first.json());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const stats = await store.stats();
    expect(stats.requests).toBe(2); expect(stats.upstreamAttempts).toBe(1);
    expect(stats.inputTokens).toBe(1000); expect(stats.cacheReadTokens).toBe(800);
    expect(stats.estimatedCostUsd).toBeCloseTo(0.00064);
    expect(stats.avoidedCostUsd).toBeCloseTo(0.00064);
    expect(stats.recent[0].id).toBe(second.headers.get('x-organized-request-id'));
  });
  it('isolates tenant stores', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => completion());
    const a = setup(fetcher); const b = setup(fetcher);
    await a.engine.handle(request()); await b.engine.handle(request());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('expires cached bodies with a controllable clock', async () => {
    let now = 1000;
    const { engine, fetcher } = setup(undefined, () => now);
    await engine.handle(request()); now += 59999;
    expect((await engine.handle(request())).headers.get('x-organized-cache')).toBe('hit');
    now += 1; await engine.handle(request()); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([{ temperature: 0.1 }, { tools: [] }, { store: true }, { previous_response_id: 'resp-old' }])('never caches %j', async body => {
    const { engine, fetcher } = setup();
    await engine.handle(request(body)); await engine.handle(request(body));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('respects provider no-store and incomplete output', async () => {
    for (const provider of [
      async () => { const r = completion(); r.headers.set('cache-control', 'no-store'); return r; },
      async () => completion({ status: 'incomplete' }),
    ]) {
      const { engine, fetcher } = setup(vi.fn<typeof fetch>(provider));
      await engine.handle(request()); await engine.handle(request());
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it('bounds stored entry size and capacity', async () => {
    const store = new MemoryStore(); const fetcher = vi.fn<typeof fetch>(async () => completion());
    const engine = new RouterEngine(store, { ...config, maxEntries: 2 }, keys, fetcher);
    for (const input of ['one', 'two', 'three']) await engine.handle(request({ input }));
    expect([...store.rows.keys()].filter(k => k.startsWith('c:'))).toHaveLength(2);
    const small = new RouterEngine(new MemoryStore(), { ...config, maxEntryBytes: 128 }, keys, fetcher);
    const before = fetcher.mock.calls.length;
    await small.handle(request()); await small.handle(request());
    expect(fetcher.mock.calls.length - before).toBe(2);
  });
  it('keys all generation parameters, headers, credentials and route changes', async () => {
    const { engine, fetcher, store } = setup();
    await engine.handle(request());
    await engine.handle(request({ input: 'changed' }));
    await engine.handle(request({ seed: 5 }));
    await engine.handle(request({}, { 'anthropic-beta': 'different' }));
    await new RouterEngine(store, config, { ...keys, one: 'rotated' }, fetcher).handle(request());
    const changed = structuredClone(config); changed.routes.test[0].model = 'new-model';
    await new RouterEngine(store, changed, keys, fetcher).handle(request());
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
  it('does not mix different TTL policies', async () => {
    const { engine, fetcher } = setup();
    await engine.handle(request());
    await engine.handle(request({}, { 'x-organized-cache-ttl': '1' }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await engine.handle(request({}, { 'x-organized-cache-ttl': '999' }))).status).toBe(400);
  });
  it('single-flights a burst of identical requests', async () => {
    const { engine, store, fetcher } = setup(vi.fn<typeof fetch>(async () => {
      await new Promise(resolve => setTimeout(resolve, 20)); return completion();
    }));
    const results = await Promise.all(Array.from({ length: 10 }, () => engine.handle(request())));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.filter(r => r.headers.get('x-organized-cache') === 'coalesced')).toHaveLength(9);
    expect((await store.stats()).upstreamAttempts).toBe(1);
    await Promise.all(results.map(r => r.text()));
  });
  it('purge invalidates both cached data and pending writes', async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { engine, fetcher, store } = setup(vi.fn<typeof fetch>(async () => { entered(); await gate; return completion(); }));
    const pending = engine.handle(request()); await ready;
    await store.clear(); release(); await pending;
    expect([...store.rows.keys()].filter(k => k.startsWith('c:'))).toHaveLength(0);
    await engine.handle(request()); expect(fetcher).toHaveBeenCalledTimes(2);
    await store.clear(); await engine.handle(request()); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('cache read/write and receipt failures degrade to provider service', async () => {
    const { engine, store, fetcher } = setup();
    store.epoch = async () => { throw new Error('unavailable'); };
    store.record = async () => { throw new Error('unavailable'); };
    expect((await engine.handle(request())).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
describe('cache affinity and failover', () => {
  it('keeps a successful fallback warm, expires it, and fails over when it breaks', async () => {
    let now = 1000; let primaryBroken = true; let backupBroken = false;
    const calls: string[] = [];
    const { engine } = setup(vi.fn<typeof fetch>(async url => {
      const primary = String(url).includes('one.invalid'); calls.push(primary ? 'primary' : 'backup');
      return primary && primaryBroken || !primary && backupBroken ? new Response('busy', { status: 503 }) : completion();
    }), () => now);
    const req = () => request({ prompt_cache_key: 'session-a' }, { 'x-organized-cache': 'off' });
    await engine.handle(req()); expect(calls).toEqual(['primary', 'backup']);
    primaryBroken = false;
    const second = await engine.handle(req()); expect(calls.at(-1)).toBe('backup');
    expect(second.headers.get('x-organized-affinity')).toBe('warm');
    backupBroken = true; await engine.handle(req()); expect(calls.slice(-2)).toEqual(['backup', 'primary']);
    now += 300001; await engine.handle(req()); expect(calls.at(-1)).toBe('primary');
  });
  it('does not share affinity across different sessions or tiers', async () => {
    const calls: string[] = []; let failures = 1;
    const { engine } = setup(vi.fn<typeof fetch>(async url => {
      calls.push(String(url));
      if (failures-- > 0) return new Response('busy', { status: 429 });
      return completion();
    }));
    await engine.handle(request({ prompt_cache_key: 'a' }, { 'x-organized-cache': 'off' }));
    await engine.handle(request({ prompt_cache_key: 'b' }, { 'x-organized-cache': 'off' }));
    expect(calls.at(-1)).toContain('one.invalid');
    await engine.handle(request({ prompt_cache_key: 'a', service_tier: 'flex' }, { 'x-organized-cache': 'off' }));
    expect(calls.at(-1)).toContain('one.invalid');
  });
  it.each([400, 401, 403, 404, 422])('does not fallback or cache terminal status %i', async status => {
    const { engine, fetcher } = setup(vi.fn<typeof fetch>(async () => new Response('original error', { status })));
    const r = await engine.handle(request()); expect(r.status).toBe(status); expect(await r.text()).toBe('original error');
    await engine.handle(request()); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([429, 500, 502, 503, 504])('falls back once on status %i', async status => {
    const { engine, fetcher } = setup(vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('error', { status })).mockImplementation(async () => completion()));
    const r = await engine.handle(request()); expect(r.status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not follow credential-leaking provider redirects', async () => {
    const { engine, fetcher } = setup(vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe('manual'); return new Response(null, { status: 307, headers: { location: 'https://evil.invalid' } });
    }));
    expect((await engine.handle(request())).status).toBe(502); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('times out a provider and advances to the next candidate', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('timeout')));
    })).mockImplementation(async () => completion());
    const engine = new RouterEngine(new MemoryStore(), { ...config, timeoutMs: 10 }, keys, fetcher);
    expect((await engine.handle(request())).status).toBe(200); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('preserves Anthropic cache controls and uses provider credentials only', async () => {
    const body = { model: 'claude', input: undefined, store: undefined, messages: [{ role: 'user', content: 'hello' }],
      system: [{ type: 'text', text: 'stable prefix', cache_control: { type: 'ephemeral', ttl: '1h' } }] };
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.system).toEqual(body.system); expect(sent.model).toBe('claude-test');
      expect(new Headers(init?.headers).get('x-api-key')).toBe(keys.anthropic);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return Response.json({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 50, output_tokens: 10 } });
    });
    const { engine } = setup(fetcher);
    await engine.handle(request(body, { authorization: 'Bearer private-router-key' }, '/v1/messages'));
    expect((await engine.handle(request(body, {}, '/v1/messages'))).headers.get('x-organized-cache')).toBe('hit');
  });
  it('rejects invalid aliases, body, credentials and methods before provider work', async () => {
    const { engine, fetcher } = setup();
    expect((await engine.handle(request({ model: '__proto__' }))).status).toBe(400);
    expect((await engine.handle(request({ stream: 'yes' }))).status).toBe(400);
    expect((await engine.handle(request({ model: 'claude' }))).status).toBe(400);
    expect((await new RouterEngine(new MemoryStore(), config, {}, fetcher).handle(request())).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe('streaming', () => {
  const sse = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"output_tokens":5}}}\n\n';
  it('passes SSE through byte for byte, observes usage and never response-caches it', async () => {
    const { engine, store, fetcher } = setup(vi.fn<typeof fetch>(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } })));
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await engine.handle(request({ stream: true }), p => work.push(p));
      expect(r.headers.get('x-organized-cache-bypass')).toBe('streaming');
      expect(await r.text()).toBe(sse);
    }
    await Promise.all(work);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await store.stats()).inputTokens).toBe(200);
    expect((await store.stats()).cacheReadTokens).toBe(160);
  });
  it('falls back on empty streams before committing headers', async () => {
    const { engine, fetcher } = setup(vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { headers: { 'content-type': 'text/event-stream' } }))
      .mockImplementation(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } })));
    const r = await engine.handle(request({ stream: true })); expect(await r.text()).toBe(sse);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not retry a stream after bytes reach the client', async () => {
    let pulls = 0;
    const { engine, store, fetcher } = setup(vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      pull(c) { if (pulls++ === 0) c.enqueue(new TextEncoder().encode('data: partial\n\n')); else c.error(new Error('broken')); },
    }), { headers: { 'content-type': 'text/event-stream' } })));
    const work: Promise<unknown>[] = [];
    const response = await engine.handle(request({ stream: true }), p => work.push(p));
    await expect(response.text()).rejects.toThrow('broken'); await Promise.all(work);
    expect(fetcher).toHaveBeenCalledTimes(1); expect((await store.stats()).recent[0].status).toBe(502);
  });
});
