import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './subscription-connection.mjs';
import { createTelemetry } from '../src/telemetry/telemetry.mjs';

// Serial writes and rotation bound disk use to four files of about 5 MiB each.
export function localCapture(directory, maxBytes = 5 * 1024 * 1024) {
  let queued = Promise.resolve();
  let pending = 0;
  return async (signal, payload) => {
    if (!['logs', 'traces'].includes(signal) || pending >= 64) throw new Error('Local telemetry queue full');
    pending++;
    const work = queued.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = resolve(directory, signal + '.jsonl');
      const line = JSON.stringify(payload) + '\n';
      const existing = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing && existing.size + Buffer.byteLength(line) > maxBytes) await rename(path, path + '.1');
      const file = await open(path, 'a', 0o600);
      try { await file.chmod(0o600); await file.writeFile(line); } finally { await file.close(); }
    });
    queued = work.catch(() => {});
    try { await work; } finally { pending--; }
  };
}

export async function subscriptionTelemetry() {
  let saved = {};
  try { saved = JSON.parse(await readFile(resolve(root, '.local/telemetry.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') process.stderr.write('Telemetry configuration could not be read; using local capture.\n'); }
  // launchd does not inherit a shell's exports; this private optional file uses
  // the same OTEL_* keys. Environment settings take precedence when present.
  const env = { ...saved };
  for (const key of ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_TRACES_SAMPLER_ARG']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return createTelemetry({ serviceName: 'organized-router-subscription', mode: 'subscription', env,
    capture: localCapture(resolve(root, '.local/telemetry')) });
}
