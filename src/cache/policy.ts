import type { Endpoint, Json } from '../router/types';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const obj = value as Json;
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
export async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}
function textOnly(value: unknown): boolean {
  if (typeof value === 'string') return true;
  return Array.isArray(value) && value.every(block => {
    const b = object(block);
    return ['text', 'input_text', 'output_text'].includes(String(b.type)) && typeof b.text === 'string';
  });
}
// Deliberately conservative: unknown fields may refer to mutable external state.
const EXACT_FIELDS = new Set(['model', 'input', 'instructions', 'messages', 'system', 'temperature',
  'top_p', 'seed', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'stop', 'stop_sequences',
  'stream', 'store', 'prompt_cache_key', 'prompt_cache_retention', 'cache_control', 'metadata',
  'user', 'safety_identifier', 'reasoning', 'reasoning_effort', 'text', 'response_format',
  'frequency_penalty', 'presence_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'n', 'service_tier']);
export function cachePolicy(body: Json, path: Endpoint, headers: Headers): string | null {
  if (headers.get('x-organized-cache') !== 'exact') return 'not_opted_in';
  if (/no-store|no-cache/i.test(headers.get('cache-control') ?? '')) return 'request_no_store';
  if (body.stream === true) return 'streaming';
  if (Object.keys(body).some(k => !EXACT_FIELDS.has(k))) return 'stateful_or_unknown_field';
  if (body.store === true || (path === '/v1/responses' && body.store !== false)) return 'provider_storage';
  if (body.temperature !== 0) return 'temperature_not_zero';
  if (body.input !== undefined && !textOnly(body.input)) return 'non_text_input';
  if (body.messages !== undefined && (!Array.isArray(body.messages) || !body.messages.every(m => {
    const message = object(m);
    return ['system', 'developer', 'user', 'assistant'].includes(String(message.role)) &&
      !message.tool_calls && !message.function_call && textOnly(message.content);
  }))) return 'non_text_messages';
  return null;
}
export function completedResponse(value: unknown, path: Endpoint): boolean {
  const b = object(value);
  if (b.error) return false;
  if (path === '/v1/responses') return b.status === 'completed' && Array.isArray(b.output) &&
    b.output.every(item => object(item).type === 'message');
  if (path === '/v1/messages') return b.type === 'message' &&
    ['end_turn', 'stop_sequence'].includes(String(b.stop_reason)) && Array.isArray(b.content) &&
    b.content.every(item => object(item).type === 'text');
  return Array.isArray(b.choices) && b.choices.length > 0 && b.choices.every(choice =>
    object(choice).finish_reason === 'stop' && !object(object(choice).message).tool_calls);
}
export function affinitySeconds(body: Json): number {
  if (body.prompt_cache_retention === '24h') return 86400;
  const hasHour = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(hasHour);
    const obj = object(v);
    return object(obj.cache_control).ttl === '1h' || Object.values(obj).some(x =>
      x !== null && typeof x === 'object' && hasHour(x));
  };
  return hasHour(body) ? 3600 : 300;
}
