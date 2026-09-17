import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelemetry, otlpSettings } from '../src/telemetry/telemetry.mjs';
import { localCapture } from '../scripts/telemetry-local.mjs';
import { createSubscriptionProxy } from '../scripts/subscription-proxy.mjs';

const spans = batches => batches.filter(([signal]) => signal === 'traces').flatMap(([, p]) => p.resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans)));
const logs = batches => batches.filter(([signal]) => signal === 'logs').flatMap(([, p]) => p.resourceLogs.flatMap(r => r.scopeLogs.flatMap(s => s.logRecords)));
const fields = row => Object.fromEntries(row.attributes.map(a => [a.key, Object.values(a.value)[0]]));
function setup(t, options = {}) {
  const batches = [];
  const telemetry = createTelemetry({ serviceName: 'fixture', mode: 'fixture', capture: (s, p) => batches.push([s, p]), ...options });
  t.after(() => telemetry.shutdown());
  return { telemetry, batches };
}
async function listen(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('SDK creates correlated OTLP spans/logs and excludes payloads, auth and account identifiers', async t => {
  const { telemetry, batches } = setup(t);
  const parent = '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01';
  const request = telemetry.start('router.request', parent, { 'http.route': '/responses', authorization: 'Bearer SECRET', prompt: 'PRIVATE PROMPT' });
  const child = request.child('gen_ai.client', { 'gen_ai.provider.name': 'openai', account_id: 'PRIVATE ACCOUNT' });
  child.end({ 'http.response.status_code': 200 });
  request.end({ 'organized.cache.read_tokens': 800, 'http.response.status_code': 200 });
  request.end(); // A terminal stream event and HTTP close must not double record.
  await telemetry.flush();
  assert.equal(spans(batches).length, 2);
  assert.equal(logs(batches).length, 1);
  const root = spans(batches).find(s => s.name === 'router.request');
  const upstream = spans(batches).find(s => s.name === 'gen_ai.client');
  // OTLP protobuf enum values differ from the JS SDK's SpanKind values.
  assert.equal(root.kind, 2); // OTLP SPAN_KIND_SERVER
  assert.equal(upstream.kind, 3); // OTLP SPAN_KIND_CLIENT
  assert.equal(root.traceId, 'a'.repeat(32));
  assert.equal(root.parentSpanId, 'b'.repeat(16));
  assert.equal(upstream.parentSpanId, root.spanId);
  assert.equal(logs(batches)[0].traceId, root.traceId);
  assert.equal(logs(batches)[0].spanId, root.spanId);
  assert.equal(Number(fields(logs(batches)[0])['organized.cache.read_tokens']), 800);
  for (const secret of ['SECRET', 'PRIVATE PROMPT', 'PRIVATE ACCOUNT', 'authorization', 'account_id']) assert.ok(!JSON.stringify(batches).includes(secret));
});

test('parent sampling suppresses spans while retaining a correlated completion log', async t => {
  const { telemetry, batches } = setup(t);
  telemetry.start('router.request', '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-00').end();
  await telemetry.flush();
  assert.equal(spans(batches).length, 0);
  assert.equal(logs(batches).length, 1);
  assert.equal(logs(batches)[0].traceId, 'a'.repeat(32));
});

test('OTLP HTTP exports both signals with collector auth and detects partial rejection', async t => {
  const received = [];
  let partial = false;
  const base = await listen(t, http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    received.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()), auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(partial ? '{"partialSuccess":{"rejectedSpans":"1"}}' : '{}');
  }));
  const { telemetry, batches } = setup(t, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: base, OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20COLLECTOR' } });
  telemetry.start('router.request').end(); await telemetry.flush();
  assert.deepEqual(received.map(r => r.path).sort(), ['/v1/logs', '/v1/traces']);
  assert.ok(received.every(r => r.auth === 'Bearer COLLECTOR'));
  assert.equal(telemetry.stats.exportedBatches, 2);
  assert.ok(!JSON.stringify(batches).includes('COLLECTOR'));
  partial = true;
  telemetry.start('router.request').end(); await telemetry.flush();
  assert.equal(telemetry.stats.exportFailures, 2);
  assert.equal(logs(batches).length, 2);
});

test('collector failure leaves local capture intact and invalid configuration never becomes an inference error', async t => {
  const { telemetry, batches } = setup(t, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' },
    fetcher: async () => { throw new Error('collector offline'); } });
  telemetry.start('router.request').end({}, true); await telemetry.flush();
  assert.equal(telemetry.stats.exportFailures, 2);
  assert.equal(logs(batches).length, 1);
  assert.equal(logs(batches)[0].severityNumber, 17);
  const invalid = setup(t, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://example.com' } });
  invalid.telemetry.start('router.request').end(); await invalid.telemetry.flush();
  assert.equal(invalid.telemetry.stats.configurationError, true);
  assert.equal(logs(invalid.batches).length, 1);
  assert.throws(() => otlpSettings({ OTEL_TRACES_SAMPLER_ARG: '2' }));
});

test('Grafana HTTP 204 acknowledgements succeed without attempting to parse an empty body', async t => {
  const received = [];
  const base = await listen(t, http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    received.push({path: req.url, payload: JSON.parse(Buffer.concat(chunks).toString())});
    res.writeHead(204); res.end();
  }));
  const {telemetry} = setup(t, {env: {OTEL_EXPORTER_OTLP_ENDPOINT: base}});
  telemetry.start('router.request').end(); await telemetry.flush();
  assert.deepEqual(received.map(r => r.path).sort(), ['/v1/logs', '/v1/traces']);
  assert.equal(telemetry.stats.exportedBatches, 2);
  assert.equal(telemetry.stats.exportFailures, 0);
});

test('local capture rotates private OTLP JSON files and keeps records parseable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'organized-telemetry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capture = localCapture(directory, 20);
  await capture('logs', { resourceLogs: [] });
  await capture('logs', { resourceLogs: [{ scopeLogs: [] }] });
  assert.equal((await stat(join(directory, 'logs.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'logs.jsonl.1'))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'logs.jsonl.1'), 'utf8')), { resourceLogs: [] });
});

test('real subscription transport captures usage spans without blocking on a slow collector', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { telemetry, batches } = setup(t, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' },
    fetcher: async () => { await gate; return Response.json({}); } });
  const upstream = await listen(t, http.createServer(async (req, res) => {
    assert.match(req.headers.traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    const chunks = []; for await (const c of req) chunks.push(c);
    assert.equal(Buffer.concat(chunks).toString(), '{"input":"PRIVATE PROMPT"}');
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":1000,"output_tokens":5,"input_tokens_details":{"cached_tokens":800}}}}\n\n');
  }));
  const key = 'f'.repeat(64);
  const base = await listen(t, createSubscriptionProxy({ gatewayKey: key, telemetry,
    requestUpstream: (url, options, callback) => http.request(upstream + url.pathname, options, callback) }));
  try {
    const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'x-organized-gateway-key': key,
      authorization: 'Bearer PRIVATE-TOKEN', 'chatgpt-account-id': 'PRIVATE ACCOUNT' }, body: '{"input":"PRIVATE PROMPT"}' });
    assert.equal(response.status, 200); await response.text();
    assert.match(response.headers.get('x-organized-trace-id'), /^[a-f0-9]{32}$/);
    assert.equal(telemetry.stats.exportedBatches, 0);
  } finally { release(); }
  await telemetry.flush();
  assert.equal(spans(batches).length, 2);
  assert.equal(logs(batches).length, 1);
  assert.equal(Number(fields(logs(batches)[0])['organized.cache.read_tokens']), 800);
  for (const secret of ['PRIVATE PROMPT', 'PRIVATE-TOKEN', 'PRIVATE ACCOUNT', key]) assert.ok(!JSON.stringify(batches).includes(secret));
});
