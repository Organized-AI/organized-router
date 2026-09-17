import { describe, expect, it } from 'vitest';
import { affinitySeconds, cachePolicy, canonical, completedResponse, hash } from '../src/cache/policy';
import { parseConfig } from '../src/router/config';
import { costs, usageFrom, UsageObserver } from '../src/router/usage';
import { config } from './helpers';

describe('cache identity and admission', () => {
  it('sorts object keys, preserves array order and literal whitespace', async () => {
    expect(await hash({ b: 2, a: [1, 2] })).toBe(await hash({ a: [1, 2], b: 2 }));
    expect(await hash([1, 2])).not.toBe(await hash([2, 1]));
    expect(await hash(' hi')).not.toBe(await hash('hi'));
    expect(canonical({ '__proto__': null, a: 1 })).toBe('{"a":1}');
  });
  const base = { model: 'test', input: 'hello', store: false, temperature: 0 };
  const headers = new Headers({ 'x-organized-cache': 'exact' });
  it('requires explicit exact opt-in', () => {
    expect(cachePolicy(base, '/v1/responses', new Headers())).toBe('not_opted_in');
    expect(cachePolicy(base, '/v1/responses', headers)).toBeNull();
  });
  it.each([
    { stream: true }, { store: true }, { temperature: 1 }, { tools: [] }, { previous_response_id: 'old' },
    { conversation: 'x' }, { background: true }, { input: [{ type: 'input_image', image_url: 'https://example.com' }] },
    { messages: [{ role: 'tool', content: 'result' }] }, { prompt: { id: 'mutable' } }, { unknown: true },
  ])('bypasses unsafe or non-repeatable input %j', extra => {
    expect(cachePolicy({ ...base, ...extra }, '/v1/responses', headers)).not.toBeNull();
  });
  it('requires store:false for Responses but not Chat', () => {
    const { store: _, ...body } = base;
    expect(cachePolicy(body, '/v1/responses', headers)).toBe('provider_storage');
    expect(cachePolicy(body, '/v1/chat/completions', headers)).toBeNull();
  });
  it('honors client no-store', () => {
    expect(cachePolicy(base, '/v1/responses', new Headers({ 'x-organized-cache': 'exact', 'cache-control': 'no-store' }))).toBe('request_no_store');
  });
  it('does not cache incomplete or tool-producing output', () => {
    expect(completedResponse({ status: 'incomplete', output: [] }, '/v1/responses')).toBe(false);
    expect(completedResponse({ status: 'completed', output: [{ type: 'function_call' }] }, '/v1/responses')).toBe(false);
    expect(completedResponse({ choices: [{ finish_reason: 'length' }] }, '/v1/chat/completions')).toBe(false);
    expect(completedResponse({ type: 'message', stop_reason: 'tool_use', content: [] }, '/v1/messages')).toBe(false);
  });
  it('matches affinity TTL to requested provider retention', () => {
    expect(affinitySeconds({})).toBe(300);
    expect(affinitySeconds({ prompt_cache_retention: '24h' })).toBe(86400);
    expect(affinitySeconds({ system: [{ type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' } }] })).toBe(3600);
  });
});
describe('usage and cost accounting', () => {
  it('does not double-count OpenAI cached input', () => {
    const usage = usageFrom({ usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } } }, 'openai');
    expect(usage.input).toBe(1000);
    expect(costs(usage, config.routes.test[0]).cost).toBeCloseTo(0.00064);
    expect(costs(usage, config.routes.test[0]).delta).toBeCloseTo(0.00144);
  });
  it('adds Anthropic disjoint input buckets and charges both TTL write rates', () => {
    const usage = usageFrom({ usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 800,
      cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 } } }, 'anthropic');
    expect(usage.input).toBe(1000);
    expect(costs(usage, config.routes.claude[0]).cost).toBeCloseTo(0.0012);
  });
  it('reports negative cache benefit when cache writes cost more', () => {
    const u = usageFrom({ usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 } }, 'anthropic');
    expect(costs(u, config.routes.claude[0]).delta).toBeCloseTo(-0.00075);
  });
  it('uses null for absent usage or missing cache prices', () => {
    expect(costs(usageFrom({}, 'openai'), config.routes.test[0]).cost).toBeNull();
    const u = usageFrom({ usage: { input_tokens: 20, output_tokens: 0, input_tokens_details: { cached_tokens: 10 } } }, 'openai');
    expect(costs(u, { ...config.routes.test[0], prices: { input: 1, output: 1 } }).cost).toBeNull();
    expect(costs({ ...u, cacheRead: 21 }, config.routes.test[0]).cost).toBeNull();
  });
  it('observes Anthropic SSE usage split across arbitrary chunks', () => {
    const observer = new UsageObserver('anthropic');
    const bytes = new TextEncoder().encode('data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":500,"output_tokens":1}}}\r\n\r\ndata: {"type":"message_delta","usage":{"output_tokens":20}}\n\ndata: {"type":"message_stop"}\n\n');
    for (let i = 0; i < bytes.length; i += 7) observer.push(bytes.slice(i, i + 7));
    expect(observer.usage.input).toBe(600);
    expect(observer.usage.output).toBe(20);
    expect(observer.complete).toBe(true);
  });
  it('observes Responses terminal usage and Chat usage before DONE', () => {
    for (const text of [
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":3}}}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
    ]) {
      const o = new UsageObserver('openai'); o.push(new TextEncoder().encode(text));
      expect(o.usage.output).toBe(3); expect(o.complete).toBe(true);
    }
  });
  it('does not treat incomplete or malformed usage as a zero-cost request', () => {
    for (const usage of [{ input_tokens: 10 }, { other: 2 }, { input_tokens: -1, output_tokens: 10 },
      { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 'unknown' } }]) {
      expect(costs(usageFrom({ usage }, 'openai'), config.routes.test[0]).cost).toBeNull();
    }
  });
  it('does not let a terminal marker erase a preceding stream error', () => {
    const o = new UsageObserver('openai');
    o.push(new TextEncoder().encode('data: {"type":"error"}\n\ndata: [DONE]\n\n'));
    expect(o.complete).toBe(false);
  });
});
describe('configuration validation', () => {
  it('accepts explicit protocol-compatible routes', () => expect(parseConfig(JSON.stringify(config))).toEqual(config));
  it.each(['http://external.example', 'https://key:secret@example.com', 'https://example.com?key=secret'])('rejects unsafe URL %s', baseUrl => {
    const c = structuredClone(config); c.routes.test[0].baseUrl = baseUrl;
    expect(() => parseConfig(JSON.stringify(c))).toThrow();
  });
  it('only enables loopback HTTP when explicitly local', () => {
    const c = structuredClone(config); c.routes.test[0].baseUrl = 'http://127.0.0.1:8899';
    expect(() => parseConfig(JSON.stringify(c))).toThrow();
    expect(() => parseConfig(JSON.stringify(c), true)).not.toThrow();
  });
  it('rejects wrong protocol, prices and unbounded settings', () => {
    expect(() => parseConfig(JSON.stringify({ ...config, maxEntries: 1e9 }))).toThrow();
    const c = structuredClone(config); c.routes.test[0].endpoints = ['/v1/messages'];
    expect(() => parseConfig(JSON.stringify(c))).toThrow();
    c.routes.test[0] = { ...config.routes.test[0], prices: { input: -1, output: 1 } };
    expect(() => parseConfig(JSON.stringify(c))).toThrow();
  });
});
