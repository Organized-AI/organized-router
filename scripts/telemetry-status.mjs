import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './subscription-connection.mjs';

const directory = resolve(root, '.local/telemetry');
const requested = process.argv[2];
if (requested && !/^[a-f0-9]{32}$/.test(requested)) {
  process.stderr.write('Pass a 32-character hexadecimal trace ID, or omit it for recent activity.\n');
  process.exit(1);
}
const result = { directory, files: [], logs: [], spans: [] };
const attributes = item => Object.fromEntries((item.attributes ?? []).map(a => [a.key, Object.values(a.value)[0]]));
for (const signal of ['logs', 'traces']) for (const suffix of ['.1', '']) {
  const path = resolve(directory, signal + '.jsonl' + suffix);
  let contents;
  try {
    contents = await readFile(path, 'utf8');
    result.files.push({ path, bytes: (await stat(path)).size });
  } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  for (const line of contents.split('\n').filter(Boolean)) {
    let batch; try { batch = JSON.parse(line); } catch { continue; }
    const rows = signal === 'logs'
      ? (batch.resourceLogs ?? []).flatMap(r => r.scopeLogs.flatMap(s => s.logRecords))
      : (batch.resourceSpans ?? []).flatMap(r => r.scopeSpans.flatMap(s => s.spans));
    for (const row of rows) {
      if (requested && row.traceId !== requested) continue;
      const a = attributes(row);
      const item = { traceId: row.traceId, spanId: row.spanId, parentSpanId: row.parentSpanId,
        name: row.name ?? row.body?.stringValue, status: a['http.response.status_code'],
        durationMs: a['organized.duration_ms'], cache: a['organized.cache.result'],
        inputTokens: a['gen_ai.usage.input_tokens'], cachedInputTokens: a['organized.cache.read_tokens'],
        outputTokens: a['gen_ai.usage.output_tokens'] };
      result[signal === 'logs' ? 'logs' : 'spans'].push(item);
    }
  }
}
result.totalLogs = result.logs.length;
result.totalSpans = result.spans.length;
if (!requested) { result.logs = result.logs.slice(-10); result.spans = result.spans.slice(-20); }
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
