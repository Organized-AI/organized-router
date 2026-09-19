import { object } from '../cache/policy';
import { EMPTY_USAGE, type Candidate, type Usage } from './types';

function validCount(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v) && v >= 0; }
function count(v: unknown): number { return validCount(v) ? v : 0; }
export function usageFrom(value: unknown, protocol: Candidate['protocol']): Usage {
  const root = object(value);
  const u = object(root.usage ?? object(root.response).usage ?? object(root.message).usage);
  if (Object.keys(u).length === 0) return { ...EMPTY_USAGE };
  const read = count(u.cache_read_input_tokens ?? object(u.input_tokens_details ?? u.prompt_tokens_details).cached_tokens);
  const writes = count(u.cache_creation_input_tokens);
  const hour = count(object(u.cache_creation).ephemeral_1h_input_tokens);
  const five = count(object(u.cache_creation).ephemeral_5m_input_tokens ?? Math.max(0, writes - hour));
  const inputValue = u.input_tokens ?? u.prompt_tokens;
  const outputValue = u.output_tokens ?? u.completion_tokens;
  const input = count(inputValue);
  const known = validCount(inputValue) && validCount(outputValue) &&
    [u.cache_read_input_tokens, u.cache_creation_input_tokens,
      object(u.input_tokens_details ?? u.prompt_tokens_details).cached_tokens,
      ...Object.values(object(u.cache_creation))].every(v => v === undefined || validCount(v));
  return { input: protocol === 'anthropic' ? input + read + five + hour : input,
    output: count(outputValue), cacheRead: read,
    cacheWrite5m: five, cacheWrite1h: hour, known };
}
export function costs(usage: Usage, candidate: Candidate): { cost: number | null; delta: number | null } {
  const p = candidate.prices;
  if (!p || !usage.known || usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h > usage.input ||
    (usage.cacheRead > 0 && p.cacheRead === undefined) ||
    (usage.cacheWrite5m > 0 && p.cacheWrite5m === undefined) ||
    (usage.cacheWrite1h > 0 && p.cacheWrite1h === undefined)) return { cost: null, delta: null };
  const uncached = usage.input - usage.cacheRead - usage.cacheWrite5m - usage.cacheWrite1h;
  const cost = (uncached * p.input + usage.output * p.output + usage.cacheRead * (p.cacheRead ?? 0) +
    usage.cacheWrite5m * (p.cacheWrite5m ?? 0) + usage.cacheWrite1h * (p.cacheWrite1h ?? 0)) / 1e6;
  return { cost, delta: (usage.input * p.input + usage.output * p.output) / 1e6 - cost };
}

// Incremental SSE observer. Bytes are forwarded unchanged; only bounded event data is inspected.
export class UsageObserver {
  usage: Usage = { ...EMPTY_USAGE };
  complete = false;
  private failed = false;
  private buffer = '';
  private decoder = new TextDecoder();
  constructor(private protocol: Candidate['protocol']) {}
  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { this.complete = !this.failed; continue; }
      try {
        const event = JSON.parse(data);
        const next = usageFrom(event, this.protocol);
        if (event.type === 'message_delta' && validCount(object(event.usage).output_tokens)) this.usage.output = next.output;
        else if (next.known) this.usage = next;
        if (event.type === 'response.completed' || event.type === 'message_stop') this.complete = !this.failed;
        if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
          this.failed = true;
          this.complete = false;
        }
      } catch { /* Non-JSON SSE data is opaque, not a provider usage report. */ }
    }
    if (this.buffer.length > 1024 * 1024) this.buffer = '';
  }
}
