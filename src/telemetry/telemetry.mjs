import { ROOT_CONTEXT, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { JsonLogsSerializer, JsonTraceSerializer } from '@opentelemetry/otlp-transformer';

// An allowlist, not redaction after recording: payloads and arbitrary headers
// never enter an OTel span or log record. Values come from validated metadata.
const allowed = new Set(['http.request.method', 'http.route', 'http.response.status_code', 'error.type',
  'gen_ai.provider.name', 'gen_ai.request.model', 'gen_ai.response.model', 'gen_ai.operation.name', 'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens', 'organized.cache.read_tokens', 'organized.cache.write_tokens',
  'organized.cache.result', 'organized.cache.affinity', 'organized.upstream.attempt', 'organized.upstream.attempts',
  'organized.request.id', 'organized.route', 'organized.candidate', 'organized.usage.known', 'organized.duration_ms',
  'organized.usage.source', 'organized.usage.date', 'organized.usage.input_tokens', 'organized.usage.output_tokens',
  'organized.usage.cached_input_tokens', 'organized.usage.total_tokens',
  'organized.decision.policy', 'organized.decision.baseline', 'organized.decision.mode', 'organized.decision.source',
  'organized.decision.input_chars', 'organized.decision.truncated', 'organized.decision.status', 'organized.decision.class',
  'organized.decision.confidence', 'organized.decision.recommended_model', 'organized.decision.served_model',
  'organized.decision.reason', 'organized.decision.cache', 'organized.decision.applied', 'organized.decision.disagrees',
  'organized.decision.usage_known', 'organized.decision.estimated_cost_usd']);
function attributes(values = {}) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => allowed.has(key) &&
    (typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)))
    .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 128) : value]));
}
function parentContext(value) {
  const parsed = typeof value === 'string' && /^00-([a-f0-9]{32})-([a-f0-9]{16})-(0[01])$/.exec(value);
  if (!parsed || /^0+$/.test(parsed[1]) || /^0+$/.test(parsed[2])) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, { traceId: parsed[1], spanId: parsed[2], traceFlags: Number(parsed[3]), isRemote: true });
}
export function otlpSettings(env = {}) {
  const headers = {};
  for (const field of (env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',').filter(Boolean)) {
    const index = field.indexOf('=');
    if (index < 1) throw new Error('Invalid OTLP header configuration');
    headers[decodeURIComponent(field.slice(0, index).trim())] = decodeURIComponent(field.slice(index + 1).trim());
  }
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
  if (endpoint) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash ||
        !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      throw new Error('OTLP requires HTTPS or loopback HTTP without URL credentials');
    }
    if (env.OTEL_EXPORTER_OTLP_PROTOCOL && env.OTEL_EXPORTER_OTLP_PROTOCOL !== 'http/json') throw new Error('Use OTLP http/json');
  }
  const sampleRate = Number(env.OTEL_TRACES_SAMPLER_ARG ?? 1);
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) throw new Error('Invalid trace sampling ratio');
  return { endpoint: endpoint.replace(/\/$/, ''), headers, sampleRate };
}

export function createTelemetry({ serviceName, mode, env = {}, capture, fetcher = (...args) => fetch(...args) }) {
  const stats = { localBatches: 0, exportedBatches: 0, exportFailures: 0, captureFailures: 0, configurationError: false,
    lastExportFailure: null, lastExportStatus: null };
  let settings;
  try { settings = otlpSettings(env); }
  catch { settings = { endpoint: '', headers: {}, sampleRate: 1 }; stats.configurationError = true; }
  const pending = new Set();
  const exporter = (signal, serializer) => ({
    export(records, callback) {
      const work = async () => {
        let failed = false;
        const bytes = serializer.serializeRequest(records);
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        const tasks = [];
        if (capture) tasks.push(Promise.resolve().then(() => capture(signal, payload))
          .then(() => { stats.localBatches++; }, () => { stats.captureFailures++; failed = true; }));
        if (settings.endpoint) tasks.push((async () => {
          let stage = 'transport';
          try {
            const response = await fetcher(settings.endpoint + '/v1/' + signal, {
              method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(3000),
              headers: { ...settings.headers, 'content-type': 'application/json' }, body: bytes,
            });
            stats.lastExportStatus = response.status;
            stage = 'http_status';
            if (!response.ok) { await response.body?.cancel(); throw new Error('OTLP rejected export'); }
            // An OTLP HTTP 200 may contain partial-success rejections.
            stage = 'response';
            // Grafana's OTLP log gateway also uses 204 No Content for success.
            const result = response.status === 204 ? {} : await response.json();
            const partial = result.partialSuccess;
            if (partial && (Number(partial.rejectedSpans ?? partial.rejectedLogRecords ?? 0) > 0 || partial.errorMessage)) {
              stage = 'partial_success';
              throw new Error('OTLP partially rejected export');
            }
            stats.exportedBatches++;
          } catch { stats.exportFailures++; stats.lastExportFailure = stage; failed = true; }
        })());
        await Promise.all(tasks);
        return failed;
      };
      const task = work().then(failed => callback({ code: failed ? 1 : 0 }), () => { stats.exportFailures++; stats.lastExportFailure = 'serialization'; callback({ code: 1 }); });
      pending.add(task);
      task.finally(() => pending.delete(task));
    },
    async forceFlush() { await Promise.allSettled([...pending]); },
    async shutdown() { await Promise.allSettled([...pending]); },
  });
  const resource = resourceFromAttributes({ 'service.name': serviceName, 'service.version': '0.1.0', 'organized.mode': mode });
  const batch = { maxQueueSize: 512, maxExportBatchSize: 64, scheduledDelayMillis: 500, exportTimeoutMillis: 4000 };
  const traces = new BasicTracerProvider({ resource,
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(settings.sampleRate) }),
    spanLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 128 },
    spanProcessors: [new BatchSpanProcessor(exporter('traces', JsonTraceSerializer), batch)] });
  const logs = new LoggerProvider({ resource, logRecordLimits: { attributeCountLimit: 32, attributeValueLengthLimit: 128 },
    processors: [new BatchLogRecordProcessor({ exporter: exporter('logs', JsonLogsSerializer), ...batch })] });
  const tracer = traces.getTracer('organized-router', '0.1.0');
  const logger = logs.getLogger('organized-router', '0.1.0');
  let generation = 0;
  let flushing;
  Object.defineProperty(stats, 'pendingBatches', { enumerable: true, get: () => pending.size });
  Object.defineProperty(stats, 'flushing', { enumerable: true, get: () => Boolean(flushing) });
  const begin = (name, parent = ROOT_CONTEXT, values = {}, kind = SpanKind.SERVER, logOnEnd = kind === SpanKind.SERVER) => {
    const started = Date.now();
    const span = tracer.startSpan(name, { kind, attributes: attributes(values) }, parent);
    const ctx = trace.setSpan(parent, span);
    const ids = span.spanContext();
    let ended = false;
    return {
      traceId: ids.traceId, spanId: ids.spanId,
      traceparent: `00-${ids.traceId}-${ids.spanId}-${ids.traceFlags & 1 ? '01' : '00'}`,
      child: (childName, childValues = {}) => begin(childName, ctx, childValues, SpanKind.CLIENT),
      end(finalValues = {}, failed = false) {
        if (ended) return;
        ended = true;
        generation++;
        const fields = attributes({ ...values, ...finalValues, 'organized.duration_ms': Math.max(0, Date.now() - started) });
        span.setAttributes(fields);
        if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
        if (logOnEnd) logger.emit({ context: ctx, severityNumber: failed ? 17 : 9, severityText: failed ? 'ERROR' : 'INFO',
          body: name + '.completed', attributes: fields });
        span.end();
      },
    };
  };
  return {
    stats,
    usageSnapshot(values) {
      generation++;
      logger.emit({ severityNumber: 9, severityText: 'INFO', body: 'organized.usage.snapshot', attributes: attributes(values) });
    },
    start: (name, traceparent, values) => begin(name, parentContext(traceparent), values),
    decision: (traceparent, values) => begin('organized.decision', parentContext(traceparent), values, SpanKind.INTERNAL, true),
    flush() {
      if (!flushing) flushing = (async () => {
        let observed;
        do {
          observed = generation;
          await Promise.allSettled([traces.forceFlush(), logs.forceFlush()]);
          await Promise.allSettled([...pending]);
        } while (observed !== generation);
      })().finally(() => { flushing = undefined; });
      return flushing;
    },
    async shutdown() { await Promise.allSettled([traces.shutdown(), logs.shutdown()]); },
  };
}
