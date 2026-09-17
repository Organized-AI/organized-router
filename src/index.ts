import { hash, object } from './cache/policy';
import { DurableStore } from './cache/store';
import { ENDPOINTS, parseConfig } from './router/config';
import { error, RouterEngine } from './router/engine';
import type { Endpoint } from './router/types';
import { createTelemetry, type Telemetry } from './telemetry/telemetry.mjs';
export { HealerBreaker } from './do/HealerBreaker';

export interface Env {
  ROUTER_CACHE: DurableObjectNamespace;
  USERS?: KVNamespace;
  GATE_API_KEY?: string;
  PROVIDER_KEYS?: string;
  ROUTER_CONFIG?: string;
  CODEX_CATALOG?: string;
  LOCAL_MODE?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  OTEL_EXPORTER_OTLP_PROTOCOL?: string;
  OTEL_TRACES_SAMPLER_ARG?: string;
  OTEL_CAPTURE_CONSOLE?: string;
}
export class RouterCache {
  private store: DurableStore;
  private engine: RouterEngine;
  private telemetry: Telemetry;
  constructor(private state: DurableObjectState, env: Env) {
    this.store = new DurableStore(state.storage);
    this.telemetry = createTelemetry({ serviceName: 'organized-router-api', mode: 'api', env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      OTEL_EXPORTER_OTLP_HEADERS: env.OTEL_EXPORTER_OTLP_HEADERS,
      OTEL_EXPORTER_OTLP_PROTOCOL: env.OTEL_EXPORTER_OTLP_PROTOCOL,
      OTEL_TRACES_SAMPLER_ARG: env.OTEL_TRACES_SAMPLER_ARG,
    }, capture: env.OTEL_CAPTURE_CONSOLE === 'false' ? undefined : (signal, payload) => console.log(JSON.stringify({ signal, payload })) });
    this.engine = new RouterEngine(this.store, parseConfig(env.ROUTER_CONFIG, env.LOCAL_MODE === 'true'),
      JSON.parse(env.PROVIDER_KEYS ?? '{}'), undefined, undefined, this.telemetry);
  }
  alarm(): Promise<void> { return this.store.sweep(); }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/api/cache/stats') return Response.json({ ...await this.store.stats(), ...await this.store.inventory(), telemetry: this.telemetry.stats }, { headers: { 'cache-control': 'no-store' } });
    if (path === '/api/cache' && request.method === 'DELETE') {
      await this.store.clear();
      return Response.json({ cleared: true }, { headers: { 'cache-control': 'no-store' } });
    }
    return this.engine.handle(request, p => this.state.waitUntil(p));
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({ status: 'ok', service: 'organized-router' });
    if (!(ENDPOINTS.includes(path as Endpoint) && request.method === 'POST') &&
      !(path === '/v1/models' && request.method === 'GET') &&
      !(path === '/api/cache/stats' && request.method === 'GET') &&
      !(path === '/api/cache' && request.method === 'DELETE')) return error(404, 'Not found');
    const auth = request.headers.get('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : request.headers.get('x-api-key');
    if (!token || token.length > 512) return error(401, 'An API key is required');
    const tokenHash = await hash(token);
    try {
      let allowed: string[] | null = null;
      if (!env.GATE_API_KEY || tokenHash !== await hash(env.GATE_API_KEY)) {
        if (!env.USERS) return error(401, 'Invalid API key');
        const user = object(await env.USERS.get('key:' + tokenHash, 'json'));
        if (user.active !== true || !Array.isArray(user.routes) ||
          user.routes.some(r => typeof r !== 'string') ||
          (user.expiresAt !== undefined && (typeof user.expiresAt !== 'number' || user.expiresAt <= Date.now()))) return error(401, 'Invalid or expired API key');
        allowed = user.routes as string[];
      }
      const config = parseConfig(env.ROUTER_CONFIG, env.LOCAL_MODE === 'true');
      if (path === '/v1/models') {
        const routes = Object.entries(config.routes).filter(([id]) => allowed === null || allowed.includes(id));
        if (request.headers.get('x-gateway-client') === 'codex') {
          const catalog = object(JSON.parse(env.CODEX_CATALOG ?? '{}'));
          if (!Array.isArray(catalog.models)) return error(503, 'Prepare the Codex model catalog before connecting this API gateway');
          const visible = new Set(routes.filter(([, candidates]) => candidates.every(c => c.endpoints.includes('/v1/responses'))).map(([id]) => id));
          const models = catalog.models.filter(m => typeof object(m).slug === 'string' && visible.has(object(m).slug as string));
          return Response.json({ models }, { headers: { 'cache-control': 'no-store' } });
        }
        return Response.json({ object: 'list', data: routes.map(([id, candidates]) => ({ id, object: 'model', owned_by: 'organized-router',
          endpoints: [...new Set(candidates.flatMap(c => c.endpoints))] })) });
      }
      if (ENDPOINTS.includes(path as Endpoint)) {
        // Authorization before any cache lookup. The clone is bounded in the engine too.
        const length = Number(request.headers.get('content-length'));
        if (length > 1024 * 1024) return error(413, 'Request is too large');
        if (allowed !== null) {
          const { readBounded } = await import('./router/engine');
          let text: string;
          try { text = await readBounded(request.body, 1024 * 1024); }
          catch { return error(413, 'Request is too large'); }
          let model: unknown;
          try { model = object(JSON.parse(text)).model; } catch { return error(400, 'Invalid JSON'); }
          if (typeof model !== 'string' || !allowed.includes(model)) return error(403, 'Model alias is not authorized');
          request = new Request(request.url, { method: request.method, headers: request.headers, body: text });
        }
      }
      const safeHeaders = new Headers(request.headers);
      safeHeaders.delete('authorization');
      safeHeaders.delete('x-api-key');
      const internal = new Request(request, { headers: safeHeaders });
      // Isolate by API key. Two keys for the same tenant never share responses implicitly.
      return await env.ROUTER_CACHE.get(env.ROUTER_CACHE.idFromName(tokenHash)).fetch(internal);
    } catch { return error(503, 'Router configuration or state service is unavailable'); }
  },
};
