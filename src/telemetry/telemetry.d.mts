export type Fields = Record<string, string | number | boolean | undefined>;
export interface RouterSpan {
  traceId: string;
  spanId: string;
  traceparent: string;
  child(name: string, values?: Fields): RouterSpan;
  end(values?: Fields, failed?: boolean): void;
}
export interface Telemetry {
  stats: { localBatches: number; exportedBatches: number; exportFailures: number; captureFailures: number; configurationError: boolean };
  start(name: string, traceparent?: string | null, values?: Fields): RouterSpan;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}
export function otlpSettings(env?: Record<string, string | undefined>): { endpoint: string; headers: Record<string, string>; sampleRate: number };
export function createTelemetry(options: { serviceName: string; mode: string; env?: Record<string, string | undefined>;
  capture?: (signal: string, payload: unknown) => void | Promise<void>; fetcher?: typeof fetch }): Telemetry;
