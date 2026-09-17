import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'organized-router-test-'));
const calls = [];
const checks = [];
let worker;
let output = '';
let exit;
const provider = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls.push({ body, headers: req.headers, path: req.url });
  if (body.input === 'force-fallback' && body.model === 'fixture-primary') {
    res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fixture rate limit"}}'); return;
  }
  if (body.input === 'burst' || body.input === 'purge-inflight') await delay(150);
  const usage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 10 };
  const result = { id: 'fixture-' + calls.length, object: 'response', status: 'completed', model: body.model,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture completion' }] }], usage };
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Fixture completion"}\n\n');
    await delay(10);
    res.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: result }) + '\n\n'); return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url === '/v1/messages') {
    res.end(JSON.stringify({ id: result.id, type: 'message', role: 'assistant', model: body.model,
      stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fixture completion' }],
      usage: { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 10 } }));
  } else if (req.url === '/v1/chat/completions') {
    res.end(JSON.stringify({ id: result.id, object: 'chat.completion', model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Fixture completion' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } } }));
  } else res.end(JSON.stringify(result));
});
await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
const providerPort = provider.address().port;
const reserve = createServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const base = 'http://127.0.0.1:' + port;
const auth = { authorization: 'Bearer fixture-router-key' };
const prices = { input: 2, output: 8, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 };
const candidate = (id, protocol = 'openai') => ({ id, provider: id, model: 'fixture-' + id,
  baseUrl: 'http://127.0.0.1:' + providerPort, protocol,
  endpoints: protocol === 'openai' ? ['/v1/responses', '/v1/chat/completions'] : ['/v1/messages'], prices });
const configPath = join(temporary, 'wrangler.json');
await writeFile(configPath, JSON.stringify({ name: 'organized-router-runtime-test', main: join(root, 'src/index.ts'),
  compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'],
  durable_objects: { bindings: [{ name: 'ROUTER_CACHE', class_name: 'RouterCache' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['RouterCache'] }],
  vars: { LOCAL_MODE: 'true', GATE_API_KEY: 'fixture-router-key',
    PROVIDER_KEYS: JSON.stringify({ primary: 'fixture-provider-one', backup: 'fixture-provider-two', anthropic: 'fixture-anthropic' }),
    ROUTER_CONFIG: JSON.stringify({ timeoutMs: 3000, responseTtlSeconds: 30, maxEntries: 128, maxEntryBytes: 64000,
      routes: { test: [candidate('primary'), candidate('backup')], claude: [candidate('anthropic', 'anthropic')] } }) } }));

async function start() {
  output = ''; exit = undefined;
  worker = spawn(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', configPath,
    '--port', String(port), '--persist-to', join(temporary, 'state'), '--log-level', 'error'],
    { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.on('exit', code => { exit = code; });
  worker.on('error', e => { output += e.message; exit = -1; });
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', data => { output = (output + data).slice(-12000); });
  for (let i = 0; i < 200; i++) {
    if (exit !== undefined) throw new Error('Wrangler exited ' + exit + '\n' + output);
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(200) })).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('Wrangler startup timed out\n' + output);
}
async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const closed = new Promise(resolve => worker.once('exit', resolve));
  worker.kill('SIGTERM');
  const timeout = setTimeout(() => worker.kill('SIGKILL'), 3000);
  await closed; clearTimeout(timeout);
}
async function call(body = {}, headers = {}, path = '/v1/responses') {
  return fetch(base + path, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'x-organized-cache': 'exact', ...headers },
    body: JSON.stringify({ model: 'test', input: 'hello', temperature: 0, store: false, ...body }), signal: AbortSignal.timeout(10000) });
}
async function check(name, fn) {
  await fn(); checks.push(name); process.stdout.write('PASS ' + name + '\n');
}
try {
  await start();
  await check('unauthorized requests cannot reach providers', async () => {
    assert.equal((await call({}, { authorization: 'Bearer invalid' })).status, 401); assert.equal(calls.length, 0);
  });
  await check('exact hit avoids upstream and preserves the response', async () => {
    const a = await call();
    assert.equal(a.status, 200, 'Provider calls: ' + calls.length + '; router response: ' + (a.ok ? 'ok' : await a.clone().text()));
    assert.equal(a.headers.get('x-organized-cache'), 'miss');
    const original = await a.json(); const b = await call();
    assert.equal(b.headers.get('x-organized-cache'), 'hit'); assert.deepEqual(await b.json(), original); assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.authorization, 'Bearer fixture-provider-one');
  });
  await check('cache survives a Worker/runtime restart', async () => {
    await stop(); await start(); const r = await call();
    assert.equal(r.headers.get('x-organized-cache'), 'hit'); assert.equal(calls.length, 1); await r.text();
  });
  await check('ten concurrent duplicates cause one upstream request', async () => {
    const before = calls.length;
    const results = await Promise.all(Array.from({ length: 10 }, () => call({ input: 'burst' })));
    assert.equal(calls.length - before, 1);
    assert.equal(results.filter(r => r.headers.get('x-organized-cache') === 'miss').length, 1);
    await Promise.all(results.map(r => r.text()));
  });
  await check('cache TTL expires in persistent storage', async () => {
    const before = calls.length;
    await (await call({ input: 'expiry' }, { 'x-organized-cache-ttl': '1' })).text();
    await delay(1150);
    await (await call({ input: 'expiry' }, { 'x-organized-cache-ttl': '1' })).text();
    assert.equal(calls.length - before, 2);
  });
  await check('expiry alarm removes response payloads without another generation request', async () => {
    await fetch(base + '/api/cache', { method: 'DELETE', headers: auth });
    await (await call({ input: 'alarm' }, { 'x-organized-cache-ttl': '1' })).text();
    let entries = 1;
    for (let i = 0; i < 50 && entries; i++) {
      await delay(100);
      entries = (await (await fetch(base + '/api/cache/stats', { headers: auth })).json()).responseEntries;
    }
    assert.equal(entries, 0);
  });
  await check('successful fallback stays warm for the session', async () => {
    const r = await call({ input: 'force-fallback', prompt_cache_key: 'session' }, { 'x-organized-cache': 'off' });
    assert.equal(r.headers.get('x-organized-candidate'), 'backup'); await r.text();
    const before = calls.length;
    const next = await call({ input: 'next turn', prompt_cache_key: 'session' }, { 'x-organized-cache': 'off' });
    assert.equal(next.headers.get('x-organized-affinity'), 'warm'); assert.equal(next.headers.get('x-organized-candidate'), 'backup');
    assert.equal(calls.length - before, 1); assert.equal(calls.at(-1).body.prompt_cache_key, 'session'); await next.text();
  });
  await check('native Anthropic cache markers survive and response reuse works', async () => {
    const body = { model: 'claude', input: undefined, store: undefined, messages: [{ role: 'user', content: 'hello' }],
      system: [{ type: 'text', text: 'a stable prefix', cache_control: { type: 'ephemeral', ttl: '1h' } }] };
    const first = await call(body, {}, '/v1/messages'); assert.equal(first.status, 200); await first.text();
    assert.deepEqual(calls.at(-1).body.system, body.system); assert.equal(calls.at(-1).headers['x-api-key'], 'fixture-anthropic');
    const second = await call(body, {}, '/v1/messages'); assert.equal(second.headers.get('x-organized-cache'), 'hit'); await second.text();
  });
  await check('Chat Completions pass through and cache independently', async () => {
    const body = { input: undefined, store: undefined, messages: [{ role: 'user', content: 'hello' }] };
    const first = await call(body, {}, '/v1/chat/completions'); assert.equal((await first.json()).object, 'chat.completion');
    const second = await call(body, {}, '/v1/chat/completions'); assert.equal(second.headers.get('x-organized-cache'), 'hit'); await second.text();
  });
  await check('streaming stays live and reports provider usage', async () => {
    const before = calls.length;
    for (let i = 0; i < 2; i++) {
      const r = await call({ stream: true }); assert.equal(r.headers.get('x-organized-cache'), 'bypass');
      assert.match(await r.text(), /response.completed/);
    }
    assert.equal(calls.length - before, 2);
  });
  await check('purge prevents in-flight resurrection and clears warm routes', async () => {
    const before = calls.length;
    const pending = call({ input: 'purge-inflight' });
    for (let i = 0; i < 100 && calls.length === before; i++) await delay(10);
    assert.equal(calls.length, before + 1);
    assert.equal((await fetch(base + '/api/cache', { method: 'DELETE', headers: auth })).status, 200);
    await (await pending).text();
    const again = await call({ input: 'purge-inflight' }); assert.equal(again.headers.get('x-organized-cache'), 'miss'); await again.text();
    assert.equal(calls.length - before, 2);
    const cold = await call({ input: 'after purge', prompt_cache_key: 'session' }, { 'x-organized-cache': 'off' });
    assert.equal(cold.headers.get('x-organized-candidate'), 'primary'); await cold.text();
  });
  await check('purge atomically removes more than 128 affinity records', async () => {
    for (let i = 0; i < 140; i++) {
      await (await call({ input: 'affinity-capacity', prompt_cache_key: 'many-' + i }, { 'x-organized-cache': 'off' })).text();
    }
    const before = await (await fetch(base + '/api/cache/stats', { headers: auth })).json();
    assert.ok(before.affinityEntries >= 140);
    assert.equal((await fetch(base + '/api/cache', { method: 'DELETE', headers: auth })).status, 200);
    const after = await (await fetch(base + '/api/cache/stats', { headers: auth })).json();
    assert.equal(after.responseEntries, 0); assert.equal(after.affinityEntries, 0);
  });
  await check('receipts reconcile upstream calls without duplicated token charges', async () => {
    const response = await fetch(base + '/api/cache/stats', { headers: auth });
    const stats = await response.json();
    assert.equal(stats.upstreamAttempts, calls.length);
    assert.equal(stats.unpricedAttempts, 1); // The initial rate-limited attempt reported no usage.
    assert.ok(stats.hits >= 4); assert.ok(stats.coalesced >= 1); assert.ok(stats.cacheReadTokens > 0);
    assert.ok(stats.estimatedCostUsd > 0); assert.ok(stats.avoidedCostUsd > 0);
    assert.ok(stats.recent.every(r => !('body' in r) && !('input' in r)));
    await mkdir(join(root, 'artifacts'), { recursive: true });
    await writeFile(join(root, 'artifacts/runtime-report.json'), JSON.stringify({ verifiedAt: new Date().toISOString(),
      environment: 'local workerd with HTTP provider fixtures; no paid model calls', checks: [...checks, 'receipts reconcile upstream calls without duplicated token charges'],
      providerCalls: calls.length, stats }, null, 2) + '\n');
  });
  process.stdout.write('Verified ' + checks.length + ' runtime checks; report: artifacts/runtime-report.json\n');
} catch (e) {
  process.stderr.write(output + '\n'); throw e;
} finally {
  await stop(); await new Promise(resolve => provider.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
