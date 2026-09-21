import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevShadow, jevSettings, taskExcerpt, JEV_MODEL } from '../src/decision/jev.mjs';
import { createTelemetry } from '../src/telemetry/telemetry.mjs';
import { createSubscriptionProxy } from '../scripts/subscription-proxy.mjs';
import { subscriptionDecisions } from '../scripts/jev-local.mjs';

const settings = { mode: 'shadow', apiKey: 'fixture-typesafe-credential', model: JEV_MODEL,
  models: { routine: 'fixture-light', standard: 'fixture-standard', complex: 'fixture-complex' } };
const body = { model: 'fixture-complex', input: 'Fix the typo in the README heading.' };
const valid = (taskClass = 'routine', confidence = 0.95) => ({ model: JEV_MODEL,
  answers: { task_class: { type: 'choice', choice: taskClass, confidence,
    probabilities: Object.fromEntries(['routine', 'standard', 'complex', 'uncertain'].map(key => [key, key === taskClass ? 1 : 0])) } },
  usage: { input_tokens: 400, output_tokens: 20 } });
const response = (...args) => Response.json(valid(...args));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await delay(10); }
  assert.fail('Expected asynchronous decision did not complete');
}
function capture(t) {
  const batches = [];
  const telemetry = createTelemetry({ serviceName: 'fixture-jev', mode: 'subscription', capture: (s, p) => batches.push([s, p]) });
  t.after(() => telemetry.shutdown());
  return { telemetry, batches };
}
const spans = batches => batches.filter(([s]) => s === 'traces').flatMap(([, p]) => p.resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans)));
const logs = batches => batches.filter(([s]) => s === 'logs').flatMap(([, p]) => p.resourceLogs.flatMap(r => r.scopeLogs.flatMap(s => s.logRecords)));
const fields = row => Object.fromEntries(row.attributes.map(a => [a.key, Object.values(a.value)[0]]));
async function listen(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('disabled, missing-key and invalid settings never call Jev; candidates and numeric limits are validated', async () => {
  for (const config of [{}, { ...settings, mode: 'off' }, { ...settings, apiKey: undefined }, { ...settings, model: 'jev-latest' }]) {
    const decisions = createJevShadow({ settings: config, fetcher: () => assert.fail('No TypeSafe access expected') });
    assert.equal(decisions.stats.active, false);
    assert.equal(decisions.capture({}), null);
    assert.equal(await decisions.observe(body), null);
  }
  for (const config of [{ ...settings, mode: 'active' }, { ...settings, maxCallsPerHour: 0 },
    { ...settings, confidenceThreshold: NaN }, { ...settings, models: { routine: 'bad model' } }]) assert.throws(() => jevSettings(config));
});

test('extracts only the latest user text, omitting wrappers, code, credentials, links, email and local paths', () => {
  const request = { input: [
    { role: 'system', content: 'PRIVATE SYSTEM' },
    { role: 'user', content: 'PRIVATE HISTORY' },
    { type: 'function_call_output', output: 'PRIVATE TOOL RESULT' },
    { role: 'user', content: [{ type: 'input_image', image_url: 'PRIVATE IMAGE' },
      { type: 'input_text', text: '<environment_context>PRIVATE ENV</environment_context> Fix typo. ```PRIVATE CODE``` https://example.com/SECRET Bearer PRIVATE-TOKEN me@example.com /Users/private/file.txt' }] },
  ] };
  const result = taskExcerpt(request, 2000);
  assert.match(result.task, /Fix typo/);
  for (const secret of ['PRIVATE', 'SECRET', 'me@example.com', '/Users/private']) assert.ok(!result.task.includes(secret));
  request.input.push({ type: 'function_call_output', output: 'Never send this' });
  assert.equal(taskExcerpt(request, 2000), null);
  assert.equal(taskExcerpt({ input: 'Hello', previous_response_id: 'old-response' }, 2000), null);
  assert.equal(taskExcerpt({ input: 'x'.repeat(2001) }, 2000).task.length, 2000);
  assert.equal(taskExcerpt({ input: 'x'.repeat(2001) }, 2000).truncated, true);
});

test('official SDK uses pinned endpoint/model and bounded input; records correlated metadata without sharing auth or payloads with telemetry', async t => {
  const { telemetry, batches } = capture(t);
  const emitted = [];
  const parent = telemetry.start('router.request');
  const decisions = createJevShadow({ settings, telemetry, onDecision: row => emitted.push(row), fetcher: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-typesafe-credential');
    const sent = JSON.parse(options.body);
    assert.equal(sent.model, JEV_MODEL);
    assert.deepEqual(Object.keys(sent.state).sort(), ['task', 'truncated']);
    assert.equal(sent.state.task, body.input);
    for (const secret of ['ACCOUNT-SECRET', 'SESSION-SECRET', 'OAUTH-SECRET']) assert.ok(!options.body.includes(secret));
    return response();
  } });
  const row = await decisions.observe({ ...body, instructions: 'PRIVATE SYSTEM', metadata: { secret: 'OAUTH-SECRET' } },
    { partition: decisions.partition('ACCOUNT-SECRET', 'SESSION-SECRET'), traceparent: parent.traceparent });
  assert.equal(row.recommendedModel, 'fixture-light');
  assert.equal(row.servedModel, 'fixture-complex');
  assert.equal(row.applied, false);
  assert.equal(row.reason, 'classified');
  parent.end(); await telemetry.flush();
  const decisionSpan = spans(batches).find(s => s.name === 'organized.decision');
  assert.equal(decisionSpan.kind, 1); // OTLP INTERNAL
  assert.equal(decisionSpan.parentSpanId, parent.spanId);
  const call = spans(batches).find(s => s.name === 'jev.client');
  assert.equal(call.kind, 3); // OTLP CLIENT
  assert.equal(call.parentSpanId, decisionSpan.spanId);
  const event = logs(batches).find(log => log.body.stringValue === 'organized.decision.completed');
  assert.equal(event.traceId, parent.traceId);
  assert.equal(fields(event)['organized.decision.disagrees'], true);
  assert.equal(decisions.stats.inputTokens, 400);
  assert.equal(decisions.stats.knownEstimatedCostUsd, 400 * 0.042 / 1_000_000);
  for (const secret of ['ACCOUNT-SECRET', 'SESSION-SECRET', 'OAUTH-SECRET', 'PRIVATE SYSTEM', body.input, settings.apiKey]) {
    assert.ok(!JSON.stringify([batches, decisions.stats, emitted]).includes(secret));
  }
});

test('cache reuse and coalescing avoid extra calls and costs, expire, and isolate accounts and sessions', async () => {
  let release, count = 0, now = 1000;
  const gate = new Promise(resolve => { release = resolve; });
  const rows = [];
  const decisions = createJevShadow({ settings: { ...settings, cacheTtlMs: 1000 }, now: () => now,
    onDecision: row => rows.push(row), fetcher: async () => { count++; await gate; return response(); } });
  const partition = decisions.partition('account-one', 'session-one');
  const first = decisions.observe(body, { partition });
  const second = decisions.observe(body, { partition });
  release();
  const completed = await Promise.all([first, second]);
  assert.deepEqual(completed.map(row => row.cache), ['miss', 'coalesced']);
  assert.equal((await decisions.observe(body, { partition })).cache, 'hit');
  assert.equal(count, 1);
  assert.equal(rows.reduce((sum, row) => sum + row.inputTokens, 0), 400);
  assert.equal(decisions.stats.inputTokens, 400);
  assert.equal((await decisions.observe(body, { partition: decisions.partition('account-two', 'session-one') })).cache, 'miss');
  assert.equal((await decisions.observe(body, { partition: decisions.partition('account-one', 'session-two') })).cache, 'miss');
  now += 1001;
  assert.equal((await decisions.observe(body, { partition })).cache, 'miss');
  assert.equal(count, 4);
});

test('low confidence and uncertain answers retain the current model; invalid or unapproved answers are rejected', async () => {
  for (const [value, reason] of [[valid('routine', 0.2), 'low_confidence'], [valid('uncertain'), 'uncertain'],
    [{ ...valid(), model: 'jev-unpinned' }, 'invalid_response'],
    [{ ...valid(), answers: { task_class: { type: 'choice', choice: 'attacker-model', confidence: 1, probabilities: {} } } }, 'invalid_response']]) {
    const decisions = createJevShadow({ settings, fetcher: async () => Response.json(value) });
    const result = await decisions.observe(body);
    assert.equal(result.reason, reason);
    assert.equal(result.recommendedModel, body.model);
    assert.equal(result.applied, false);
  }
  const decisions = createJevShadow({ settings, fetcher: () => assert.fail('Unconfigured models must not call Jev') });
  assert.equal(await decisions.observe({ ...body, model: 'unapproved' }), null);
});

test('rate limits get one attempt, enter cooldown and remain unpriced instead of assuming zero', async () => {
  let calls = 0, now = 0;
  const decisions = createJevShadow({ settings, now: () => now, fetcher: async () => {
    calls++; return Response.json({ error: 'PRIVATE UPSTREAM PAYLOAD' }, { status: 429, headers: { 'retry-after': '90' } });
  } });
  assert.equal((await decisions.observe(body)).reason, 'rate_limit');
  assert.equal((await decisions.observe(body)).reason, 'cooldown');
  assert.equal(calls, 1);
  assert.equal(decisions.stats.unpricedCalls, 1);
  assert.ok(!JSON.stringify(decisions.stats).includes('PRIVATE UPSTREAM PAYLOAD'));
  now += 30_001;
  await decisions.observe(body);
  assert.equal(calls, 2);
});

test('a slow call times out, releases capacity and never retries', async () => {
  let calls = 0;
  const decisions = createJevShadow({ settings: { ...settings, timeoutMs: 100 }, fetcher: async (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const result = await decisions.observe(body);
  assert.equal(result.reason, 'timeout');
  assert.equal(decisions.stats.inFlight, 0);
  assert.equal(calls, 1);
});

test('bounds response bytes, concurrency, per-hour calls and malformed-response accounting', async () => {
  const oversized = createJevShadow({ settings, fetcher: async () => new Response('x'.repeat(65537)) });
  assert.equal((await oversized.observe(body)).reason, 'transport');
  const malformed = createJevShadow({ settings, fetcher: async () => Response.json({}) });
  await malformed.observe(body);
  assert.equal(malformed.stats.unpricedCalls, 1);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let now = 0;
  const decisions = createJevShadow({ settings: { ...settings, maxCallsPerHour: 2 }, now: () => now,
    fetcher: async () => { await gate; return response(); } });
  const one = decisions.observe(body);
  const two = decisions.observe({ ...body, input: 'Second task' });
  assert.equal((await decisions.observe({ ...body, input: 'Third task' })).reason, 'busy');
  release(); await Promise.all([one, two]);
  assert.equal((await decisions.observe({ ...body, input: 'Third task' })).reason, 'call_limit');
  now = 3_600_001;
  assert.equal((await decisions.observe({ ...body, input: 'Third task' })).reason, 'classified');
});

test('SDK environment cannot redirect credentials, select an alias, or enable debug payload logging', async () => {
  const previous = Object.fromEntries(['TYPESAFE_BASE_URL', 'TYPESAFE_DEFAULT_MODEL', 'TYPESAFE_LOG_LEVEL'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { TYPESAFE_BASE_URL: 'https://example.com/steal', TYPESAFE_DEFAULT_MODEL: 'unapproved', TYPESAFE_LOG_LEVEL: 'debug' });
  try {
    const decisions = createJevShadow({ settings, fetcher: async (url, options) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(JSON.parse(options.body).model, JEV_MODEL);
      return response();
    } });
    assert.equal((await decisions.observe(body)).reason, 'classified');
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('native subscription streaming is byte-preserving and completes before a blocked Jev call', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const decisions = createJevShadow({ settings, fetcher: async () => { await gate; return response(); } });
  const key = 'f'.repeat(64);
  const requestBody = JSON.stringify({ ...body, prompt_cache_key: 'PRIVATE-CACHE-KEY', stream: true });
  const stream = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":1,"input_tokens_details":{"cached_tokens":80}}}}\n\n';
  let nativeCalls = 0;
  const upstream = await listen(t, http.createServer(async (req, res) => {
    nativeCalls++;
    assert.equal(req.headers.authorization, 'Bearer NATIVE-OAUTH');
    assert.equal(req.headers['chatgpt-account-id'], 'NATIVE-ACCOUNT');
    assert.equal(req.headers.session_id, 'NATIVE-SESSION');
    assert.equal(req.headers['x-organized-gateway-key'], undefined);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), requestBody);
    res.end(stream);
  }));
  const base = await listen(t, createSubscriptionProxy({ gatewayKey: key, decisions,
    requestUpstream: (url, options, cb) => http.request(upstream + url.pathname, options, cb) }));
  const headers = { 'x-organized-gateway-key': key, authorization: 'Bearer NATIVE-OAUTH', 'chatgpt-account-id': 'NATIVE-ACCOUNT', session_id: 'NATIVE-SESSION' };
  try {
    assert.equal((await fetch(base + '/responses', { method: 'POST', body: requestBody })).status, 401);
    assert.equal((await fetch(base + '/api/decisions')).status, 401);
    assert.equal(decisions.stats.calls, 0);
    const result = await fetch(base + '/responses', { method: 'POST', headers, body: requestBody });
    assert.equal(await result.text(), stream);
    await until(() => decisions.stats.calls === 1);
    assert.equal(decisions.stats.inFlight, 1);
    const stats = await (await fetch(base + '/api/cache/stats', { headers })).json();
    assert.equal(stats.cachedInputTokens, 80);
    assert.equal(stats.inFlight, 0);
    assert.equal(nativeCalls, 1);
  } finally { release(); await decisions.shutdown(); }
  const status = await (await fetch(base + '/api/decisions', { headers })).json();
  assert.equal(status.lastDecision.applied, false);
  assert.equal(status.lastDecision.recommendedModel, 'fixture-light');
});

test('request capture discards oversized or cancelled input and observers cannot break decisions', async () => {
  const decisions = createJevShadow({ settings, onDecision: async () => { throw new Error('observer offline'); }, fetcher: async () => response() });
  const large = decisions.capture({}); large.push(Buffer.alloc(1024 * 1024 + 1)); large.end();
  const aborted = decisions.capture({}); aborted.push(Buffer.from(JSON.stringify(body))); aborted.cancel(); aborted.end();
  await delay(10);
  assert.equal(decisions.stats.calls, 0);
  const fragmented = decisions.capture({});
  for (const part of [JSON.stringify(body).slice(0, 20), JSON.stringify(body).slice(20)]) fragmented.push(Buffer.from(part));
  fragmented.end();
  await until(() => decisions.stats.classified === 1);
  await decisions.shutdown();
});

test('private configuration is opt-in, errors disable egress, and status never contains the key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'organized-jev-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const off = await subscriptionDecisions({ directory, env: { TYPESAFE_API_KEY: settings.apiKey } });
  assert.equal(off.stats.active, false);
  await writeFile(join(directory, 'jev.json'), '{broken');
  const invalid = await subscriptionDecisions({ directory, env: {} });
  assert.equal(invalid.stats.configurationError, true);
  await writeFile(join(directory, 'jev.json'), 'null');
  const nullConfig = await subscriptionDecisions({ directory, env: { TYPESAFE_API_KEY: settings.apiKey } });
  assert.equal(nullConfig.stats.configurationError, true);
  await writeFile(join(directory, 'jev.json'), JSON.stringify(settings), { mode: 0o600 });
  const enabled = await subscriptionDecisions({ directory, env: {} });
  assert.equal(enabled.stats.active, true);
  assert.ok(!JSON.stringify(enabled.stats).includes(settings.apiKey));
});
