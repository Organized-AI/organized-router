import { describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { hash } from '../src/cache/policy';
import { config, request } from './helpers';

function setup() {
  const downstream = vi.fn(async (req: Request) => {
    expect(req.headers.has('authorization')).toBe(false);
    expect(req.headers.has('x-api-key')).toBe(false);
    return Response.json({ ok: true });
  });
  const ids: string[] = [];
  const records = new Map<string, unknown>();
  const env: Env = { GATE_API_KEY: 'bootstrap-secret', ROUTER_CONFIG: JSON.stringify(config),
    USERS: { get: async (id: string) => records.get(id) ?? null } as unknown as KVNamespace,
    ROUTER_CACHE: { idFromName: (name: string) => { ids.push(name); return name; }, get: () => ({ fetch: downstream }) } as unknown as DurableObjectNamespace };
  return { env, downstream, ids, records };
}
describe('Worker authorization', () => {
  it('exposes only health without authentication', async () => {
    const { env, downstream } = setup();
    expect((await worker.fetch(new Request('https://router/health'), env)).status).toBe(200);
    expect((await worker.fetch(request(), env)).status).toBe(401);
    expect((await worker.fetch(new Request('https://router/api/cache/stats'), env)).status).toBe(401);
    expect(downstream).not.toHaveBeenCalled();
  });
  it('accepts bootstrap bearer and Anthropic-style keys, strips both before forwarding', async () => {
    const { env, downstream } = setup();
    const methods: Record<string, string>[] = [{ authorization: 'Bearer bootstrap-secret' }, { 'x-api-key': 'bootstrap-secret' }];
    for (const headers of methods) {
      expect((await worker.fetch(request({}, headers), env)).status).toBe(200);
    }
    expect(downstream).toHaveBeenCalledTimes(2);
  });
  it('fails closed for missing config and unknown keys', async () => {
    const { env, downstream } = setup();
    expect((await worker.fetch(request({}, { authorization: 'Bearer wrong' }), env)).status).toBe(401);
    env.ROUTER_CONFIG = '{}';
    expect((await worker.fetch(request({}, { authorization: 'Bearer bootstrap-secret' }), env)).status).toBe(503);
    expect(downstream).not.toHaveBeenCalled();
  });
  it('enforces model permissions and revocation before cache dispatch', async () => {
    const { env, records, downstream } = setup();
    const key = 'key:' + await hash('tenant-a');
    records.set(key, { active: true, routes: ['test'] });
    const auth = { authorization: 'Bearer tenant-a' };
    expect((await worker.fetch(request({}, auth), env)).status).toBe(200);
    expect((await worker.fetch(request({ model: 'claude' }, auth), env)).status).toBe(403);
    records.set(key, { active: false, routes: ['test'] });
    expect((await worker.fetch(request({}, auth), env)).status).toBe(401);
    records.set(key, { active: true, routes: ['test'], expiresAt: 1 });
    expect((await worker.fetch(request({}, auth), env)).status).toBe(401);
    expect(downstream).toHaveBeenCalledTimes(1);
  });
  it('routes distinct keys to distinct durable objects without leaking raw keys', async () => {
    const { env, records, ids } = setup();
    for (const key of ['tenant-a', 'tenant-b']) {
      records.set('key:' + await hash(key), { active: true, routes: ['test'] });
      await worker.fetch(request({}, { authorization: 'Bearer ' + key }), env);
    }
    expect(new Set(ids).size).toBe(2);
    expect(ids.every(id => /^[a-f0-9]{64}$/.test(id))).toBe(true);
  });
  it('returns only authorized model aliases', async () => {
    const { env, records } = setup();
    records.set('key:' + await hash('tenant-a'), { active: true, routes: ['claude'] });
    const response = await worker.fetch(new Request('https://router/v1/models', { headers: { authorization: 'Bearer tenant-a' } }), env);
    expect((await response.json<{ data: { id: string }[] }>()).data.map(m => m.id)).toEqual(['claude']);
  });
  it('serves Codex-native discovery only for authorized Responses routes', async () => {
    const { env, records } = setup();
    env.CODEX_CATALOG = JSON.stringify({ models: [{ slug: 'test', context_window: 272000 }, { slug: 'claude' }, { slug: 'unconfigured' }] });
    records.set('key:' + await hash('tenant-a'), { active: true, routes: ['test'] });
    const headers = { authorization: 'Bearer tenant-a', 'X-Gateway-Client': 'codex' };
    const result = await worker.fetch(new Request('https://router/v1/models', { headers }), env);
    expect(await result.json()).toEqual({ models: [{ slug: 'test', context_window: 272000 }] });
    delete env.CODEX_CATALOG;
    expect((await worker.fetch(new Request('https://router/v1/models', { headers }), env)).status).toBe(503);
    expect((await worker.fetch(new Request('https://router/v1/models', { headers: { 'X-Gateway-Client': 'codex' } }), env)).status).toBe(401);
  });
  it('rejects oversized and malformed requests without upstream calls', async () => {
    const { env, records, downstream } = setup();
    records.set('key:' + await hash('tenant-a'), { active: true, routes: ['test'] });
    const response = await worker.fetch(new Request('https://router/v1/responses', { method: 'POST',
      headers: { authorization: 'Bearer tenant-a' }, body: 'x'.repeat(1024 * 1024 + 1) }), env);
    expect(response.status).toBe(413);
    expect((await worker.fetch(new Request('https://router/v1/responses', { method: 'POST', headers: { authorization: 'Bearer tenant-a' }, body: 'invalid' }), env)).status).toBe(400);
    expect(downstream).not.toHaveBeenCalled();
  });
});
