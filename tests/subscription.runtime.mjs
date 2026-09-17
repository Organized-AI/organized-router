import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createSubscriptionProxy, SubscriptionUsage } from '../scripts/subscription-proxy.mjs';

const gatewayKey = 'a'.repeat(64);
const headers = { 'x-organized-gateway-key': gatewayKey, authorization: 'Bearer fixture-oauth', 'chatgpt-account-id': 'fixture-account' };
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function setup(t, handler) {
  let attempts = 0;
  const upstream = http.createServer(handler);
  const fixture = await listen(upstream);
  const proxy = createSubscriptionProxy({ gatewayKey, requestUpstream(url, options, callback) {
    attempts++;
    assert.equal(url.origin, 'https://chatgpt.com');
    assert.ok(url.pathname.startsWith('/backend-api/codex/'));
    return http.request(fixture + url.pathname + url.search, options, callback);
  } });
  const base = await listen(proxy);
  t.after(async () => { for (const s of [proxy, upstream]) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); } });
  return { base, attempts: () => attempts };
}

test('rejects unauthenticated, browser, foreign-host and non-ChatGPT requests before upstream access', async t => {
  const { base, attempts } = await setup(t, () => assert.fail('No upstream request expected'));
  for (const bad of [{}, { ...headers, 'x-organized-gateway-key': 'wrong' }, { ...headers, authorization: '' }, { ...headers, 'chatgpt-account-id': '' }]) {
    assert.equal((await fetch(base + '/responses', { method: 'POST', headers: bad, body: '{}' })).status, 401);
  }
  assert.equal((await fetch(base + '/responses', { method: 'POST', headers: { ...headers, origin: 'https://example.com' }, body: '{}' })).status, 403);
  await new Promise((resolve, reject) => {
    const req = http.request(base + '/health', { headers: { host: 'example.com' } }, res => { assert.equal(res.statusCode, 403); res.resume(); res.on('end', resolve); });
    req.on('error', reject); req.end();
  });
  for (const path of ['/v1/responses', '/responses/../../evil', '/responses/https://example.com', '/api/cache']) {
    assert.equal((await fetch(base + path, { method: 'POST', headers, body: '{}' })).status, 404);
  }
  assert.equal(attempts(), 0);
});

test('forwards unchanged payload, OAuth, session and cache headers; streams unchanged SSE and counts reported cache tokens', async t => {
  const body = '{ "model":"fixture-model", "prompt_cache_key":"stable-session", "input":"Unicode 🌱", "tools":[], "stream":true }';
  const stream = 'data: {"type":"response.output_text.delta","delta":"secret-fixture-output"}\n\n' +
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":1200,"output_tokens":12,"input_tokens_details":{"cached_tokens":1024}}}}\n\n';
  const { base, attempts } = await setup(t, async (req, res) => {
    assert.equal(req.url, '/backend-api/codex/responses?fixture=1');
    assert.equal(req.headers.authorization, headers.authorization);
    assert.equal(req.headers['chatgpt-account-id'], 'fixture-account');
    assert.equal(req.headers['x-organized-gateway-key'], undefined);
    assert.equal(req.headers['x-codex-turn-state'], 'warm-turn');
    assert.equal(req.headers.session_id, 'stable-session');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), body);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'next-turn', 'x-codex-primary-used-percent': '5' });
    res.write(stream.slice(0, 117)); setImmediate(() => res.end(stream.slice(117)));
  });
  const result = await fetch(base + '/responses?fixture=1', { method: 'POST', headers: { ...headers, 'x-codex-turn-state': 'warm-turn', session_id: 'stable-session' }, body });
  assert.equal(result.headers.get('x-codex-turn-state'), 'next-turn');
  assert.equal(result.headers.get('x-codex-primary-used-percent'), '5');
  assert.equal(await result.text(), stream);
  const statsText = await (await fetch(base + '/api/cache/stats', { headers })).text();
  const stats = JSON.parse(statsText);
  assert.equal(stats.completedResponses, 1);
  assert.equal(stats.inputTokens, 1200);
  assert.equal(stats.cachedInputTokens, 1024);
  assert.equal(stats.responsesWithCacheUsage, 1);
  for (const privateValue of ['fixture-oauth', 'fixture-account', 'stable-session', 'secret-fixture-output', body]) assert.ok(!statsText.includes(privateValue));
  assert.equal(attempts(), 1);
});

test('preserves subscription quota errors without provider fallback or redirect following', async t => {
  let status = 429;
  const { base, attempts } = await setup(t, (_req, res) => { res.writeHead(status, { 'retry-after': '90', location: 'https://example.com/steal' }); res.end('{"error":"quota fixture"}'); });
  const quota = await fetch(base + '/responses', { method: 'POST', headers, body: '{}' });
  assert.equal(quota.status, 429); assert.equal(quota.headers.get('retry-after'), '90');
  assert.equal(await quota.text(), '{"error":"quota fixture"}');
  status = 307;
  const redirect = await fetch(base + '/responses', { method: 'POST', headers, body: '{}' });
  assert.equal(redirect.status, 502); assert.equal(redirect.headers.get('location'), null);
  assert.equal(attempts(), 2);
});

test('usage observer bounds oversized events, handles fragmented Unicode, and leaves missing cache usage unknown', () => {
  const observer = new SubscriptionUsage();
  observer.push(Buffer.from('data: ' + 'x'.repeat(1024 * 1024 + 10)));
  assert.equal(observer.buffer.length, 0);
  const data = Buffer.from('\n\ndata: {"type":"response.completed","response":{"text":"🌱","usage":{"input_tokens":9,"output_tokens":3}}}\n\n');
  for (const byte of data) observer.push(Buffer.from([byte]));
  assert.deepEqual(observer.usage, { inputTokens: 9, outputTokens: 3, cachedInputTokens: null });
});

test('supports native models and compaction paths', async t => {
  const seen = [];
  const { base } = await setup(t, (req, res) => { seen.push(req.url); req.resume(); res.end('{}'); });
  assert.equal((await fetch(base + '/models?client_version=fixture', { headers })).status, 200);
  assert.equal((await fetch(base + '/responses/compact', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.deepEqual(seen, ['/backend-api/codex/models?client_version=fixture', '/backend-api/codex/responses/compact']);
});

test('observes terminal usage without Content-Type and treats client close after completion as success', async t => {
  let ended;
  const upstreamEnded = new Promise(resolve => { ended = resolve; });
  const { base } = await setup(t, (_req, res) => {
    res.on('close', ended);
    res.write('data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":1,"input_tokens_details":{"cached_tokens":64}}}}\n\n');
    // Remain open, as the real backend does after the terminal event.
  });
  const response = await fetch(base + '/responses', { method: 'POST', headers, body: '{}' });
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await upstreamEnded;
  const stats = await (await fetch(base + '/api/cache/stats', { headers })).json();
  assert.equal(stats.completedResponses, 1);
  assert.equal(stats.failedRequests, 0);
  assert.equal(stats.cachedInputTokens, 64);
});
