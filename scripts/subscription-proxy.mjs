import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';

export const subscriptionOrigin = 'https://chatgpt.com';
const allowed = new Set(['POST /responses', 'POST /responses/compact', 'GET /models']);
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'];

function cleanHeaders(headers) {
  const result = { ...headers };
  for (const name of [...hopHeaders, ...(headers.connection ?? '').split(',').map(v => v.trim().toLowerCase())]) delete result[name];
  for (const name of Object.keys(result)) if (name.startsWith('x-organized-')) delete result[name];
  return result;
}

// Observe only completion usage; never retain prompts, tool calls, or generated text.
export class SubscriptionUsage {
  buffer = '';
  skipping = false;
  decoder = new TextDecoder();
  usage = null;
  complete = false;
  push(chunk) {
    const text = this.decoder.decode(chunk, { stream: true });
    for (const [index, part] of text.split('\n').entries()) {
      if (index > 0) {
        if (!this.skipping && this.buffer.startsWith('data:')) {
          try {
            const event = JSON.parse(this.buffer.slice(5));
            if (event.type === 'response.completed') this.complete = true;
            const u = event.type === 'response.completed' ? event.response?.usage : undefined;
            if (u && [u.input_tokens, u.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0)) {
              const cached = u.input_tokens_details?.cached_tokens;
              this.usage = { inputTokens: u.input_tokens, outputTokens: u.output_tokens,
                cachedInputTokens: Number.isSafeInteger(cached) && cached >= 0 && cached <= u.input_tokens ? cached : null };
            }
          } catch { /* Opaque event; no payload logging. */ }
        }
        this.buffer = '';
        this.skipping = false;
      }
      if (!this.skipping) {
        if (this.buffer.length + part.length > 1024 * 1024) { this.buffer = ''; this.skipping = true; }
        else this.buffer += part;
      }
    }
  }
}

// requestUpstream is an explicit test seam. The production runner never supplies it.
export function createSubscriptionProxy({ gatewayKey, requestUpstream = https.request }) {
  if (!gatewayKey || gatewayKey.length < 32) throw new Error('A private local gateway key is required.');
  const expected = Buffer.from(gatewayKey);
  const stats = { mode: 'chatgpt-subscription', upstream: subscriptionOrigin + '/backend-api/codex',
    requests: 0, completedResponses: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0,
    cachedInputTokens: 0, responsesWithCacheUsage: 0, lastStatus: null, receipts: [] };
  const server = http.createServer((req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '') || req.headers.origin) return json(403, { error: 'Loopback clients only.' });
    if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true, mode: stats.mode });
    const provided = Buffer.from(req.headers['x-organized-gateway-key'] ?? '');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(401, { error: 'Local gateway authentication required.' });
    if (req.method === 'GET' && req.url === '/api/cache/stats') return json(200, stats);
    const path = req.url.split('?')[0];
    if (!allowed.has(req.method + ' ' + path)) return json(404, { error: 'Unsupported subscription endpoint.' });
    if (!/^Bearer \S+$/i.test(req.headers.authorization ?? '') || !req.headers['chatgpt-account-id']) return json(401, { error: 'Use Codex signed in with ChatGPT.' });
    stats.requests++;
    const headers = cleanHeaders(req.headers);
    // SSE stays observable without altering the request body or cache/session headers.
    headers['accept-encoding'] = 'identity';
    const observer = new SubscriptionUsage();
    let recorded = false;
    let upstream;
    let upstreamResponse;
    const receipt = { endpoint: path, status: null, contentType: null, contentEncoding: null, failed: false, usage: null };
    const record = (failed) => {
      if (recorded) return;
      recorded = true;
      receipt.failed = failed && !observer.complete;
      receipt.usage = observer.usage;
      stats.receipts.push(receipt);
      if (stats.receipts.length > 20) stats.receipts.shift();
      if (receipt.failed) stats.failedRequests++;
      if (observer.complete) stats.completedResponses++;
      if (observer.usage) {
        stats.inputTokens += observer.usage.inputTokens;
        stats.outputTokens += observer.usage.outputTokens;
        if (observer.usage.cachedInputTokens !== null) {
          stats.responsesWithCacheUsage++;
          stats.cachedInputTokens += observer.usage.cachedInputTokens;
        }
      }
    };
    const fail = () => {
      record(true);
      if (!res.headersSent) json(502, { error: 'Subscription upstream connection failed.' });
      else res.destroy();
      upstreamResponse?.destroy();
      upstream?.destroy();
    };
    try {
      upstream = requestUpstream(new URL('/backend-api/codex' + req.url, subscriptionOrigin), { method: req.method, headers }, response => {
        upstreamResponse = response;
        stats.lastStatus = response.statusCode;
        receipt.status = response.statusCode;
        receipt.contentType = response.headers['content-type'] ?? null;
        receipt.contentEncoding = response.headers['content-encoding'] ?? null;
        // Never follow redirects or hand an OAuth redirect to the local client.
        if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); return fail(); }
        const responseHeaders = cleanHeaders(response.headers);
        responseHeaders['cache-control'] = 'no-store';
        res.writeHead(response.statusCode, responseHeaders);
        // The Codex backend can omit Content-Type. Native clients also close as
        // soon as response.completed arrives, before the HTTP stream ends.
        if (path === '/responses' && response.statusCode === 200 && (!response.headers['content-encoding'] || response.headers['content-encoding'] === 'identity')) response.on('data', chunk => observer.push(chunk));
        response.on('error', fail);
        response.on('end', () => record(response.statusCode >= 400));
        response.pipe(res);
      });
      upstream.setTimeout(10 * 60 * 1000, fail);
      upstream.on('error', fail);
      req.on('error', fail);
      req.on('aborted', fail);
      res.on('close', () => { if (!res.writableFinished) { record(true); upstreamResponse?.destroy(); upstream.destroy(); } });
      req.pipe(upstream);
    } catch { fail(); }
  });
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n'));
  return server;
}
