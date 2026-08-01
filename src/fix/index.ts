/**
 * Organized Fix - repair engine
 * Tier 0 catalog (KV) -> Tier 1 rules (in-worker) -> Tier 2 healer (separate worker)
 * Runs before the fallback chain. Exactly one patched retry. Degrades quietly.
 */

export type PatchOp =
  | { op: "delete"; path: string }
  | { op: "set"; path: string; value: unknown }
  | { op: "rename"; path: string; to: string }
  | { op: "clamp"; path: string; max?: number; min?: number }
  | { op: "wrap"; path: string; as: "array" | "object" };

export interface NormalizedError {
  ofCode: string; status: number; type: string; param: string | null; message: string;
}

export interface FixResult {
  attempted: boolean; recovered: boolean; tier: 0 | 1 | 2 | null;
  signature: string | null; patch: PatchOp[] | null;
  outcome: "recovered" | "patch_failed" | "no_patch" | "not_repairable" | "breaker_open" | "healer_error";
  healerCostUsd: number;
}

const REPAIRABLE = new Set([400, 404, 422]);

/* -------------------- 1. Normalizer -------------------- */

const PARAM_PATTERNS = [
  /unsupported parameter:?\s*'?([a-z_0-9.\[\]]+)'?/i,
  /unknown (?:field|parameter):?\s*'?([a-z_0-9.\[\]]+)'?/i,
  /'([a-z_0-9.\[\]]+)'\s+is not (?:supported|permitted|allowed)/i,
  /invalid value for\s+'?([a-z_0-9.\[\]]+)'?/i,
  /([a-z_0-9.\[\]]+):\s*(?:Extra inputs|Input should)/i,
];

function extractParam(message: string): string | null {
  for (const re of PARAM_PATTERNS) { const m = message.match(re); if (m?.[1]) return m[1]; }
  return null;
}

function mapOfCode(status: number, message: string): string {
  const m = message.toLowerCase();
  if (status === 404 || m.includes("model not found") || m.includes("does not exist")) return "OF404";
  if (m.includes("max_tokens") && (m.includes("exceed") || m.includes("greater than"))) return "OF407";
  if (m.includes("tool") && m.includes("schema")) return "OF402";
  if (m.includes("response_format") || m.includes("json_schema")) return "OF403";
  if (m.includes("system")) return "OF405";
  if (m.includes("image") || m.includes("media_type")) return "OF406";
  if (m.includes("temperature") && m.includes("top_p")) return "OF412";
  if (m.includes("unsupported") || m.includes("unknown") || m.includes("extra input")) return "OF400";
  if (m.includes("out of range") || m.includes("must be less") || m.includes("must be greater")) return "OF401";
  if (status === 422) return "OF401";
  return "OF400";
}

export function normalizeError(status: number, body: unknown): NormalizedError {
  const b = (body ?? {}) as Record<string, any>;
  const err = b.error ?? b;
  const message = String(err?.message ?? err?.detail ?? "unknown provider error");
  const type = String(err?.type ?? err?.code ?? "unknown");
  const param = err?.param ?? err?.parameter ?? extractParam(message);
  return { ofCode: mapOfCode(status, message), status, type, param, message };
}

/* -------------------- 2. Signature -------------------- */

function modelFamily(model: string): string {
  return model.toLowerCase().replace(/[-_]?\d{6,8}$/, "").replace(/[-_]?(latest|preview)$/, "");
}

export async function signature(
  provider: string, model: string, err: NormalizedError, body: Record<string, unknown>,
): Promise<string> {
  const input = [provider, modelFamily(model), err.status, err.ofCode, err.type, err.param ?? "-",
    Object.keys(body).sort().join(",")].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/* -------------------- 3. Tier 1 rules -------------------- */

function ceilingFromMessage(message: string): number | null {
  const m = message.match(/(?:less than or equal to|maximum of|max)\s*:?\s*(\d{3,7})/i);
  return m ? Number(m[1]) : null;
}

type Rule = {
  code: string;
  match: (e: NormalizedError, b: Record<string, any>) => boolean;
  patch: (e: NormalizedError, b: Record<string, any>) => PatchOp[];
};

const RULES: Rule[] = [
  { code: "OF400", match: (e) => e.ofCode === "OF400" && !!e.param, patch: (e) => [{ op: "delete", path: e.param! }] },
  { code: "OF401", match: (e) => e.ofCode === "OF401" && !!e.param, patch: (e) => [{ op: "delete", path: e.param! }] },
  { code: "OF407", match: (e, b) => e.ofCode === "OF407" && typeof b.max_tokens === "number",
    patch: (e) => [{ op: "clamp", path: "max_tokens", max: ceilingFromMessage(e.message) ?? 8192 }] },
  { code: "OF412", match: (e, b) => e.ofCode === "OF412" && b.temperature !== undefined && b.top_p !== undefined,
    patch: () => [{ op: "delete", path: "top_p" }] },
  { code: "OF403", match: (e, b) => e.ofCode === "OF403" && b.response_format?.type === "json_object",
    patch: () => [{ op: "set", path: "response_format",
      value: { type: "json_schema", json_schema: { name: "response", schema: { type: "object" } } } }] },
  { code: "OF405", match: (e, b) => e.ofCode === "OF405" && Array.isArray(b.messages) && b.messages[0]?.role === "system",
    patch: (_e, b) => [{ op: "set", path: "system", value: b.messages[0].content },
      { op: "set", path: "messages", value: b.messages.slice(1) }] },
];

export function ruleLookup(err: NormalizedError, body: Record<string, any>): PatchOp[] | null {
  for (const r of RULES) if (r.match(err, body)) return r.patch(err, body);
  return null;
}

/* -------------------- 4. Patch application -------------------- */

export function applyPatch(body: Record<string, any>, ops: PatchOp[], maxBytes = 32768): Record<string, any> | null {
  const next = structuredClone(body);
  for (const op of ops) {
    const parts = op.path.split(".");
    const leaf = parts.pop()!;
    let target: any = next;
    for (const p of parts) { if (target?.[p] === undefined) { target = null; break; } target = target[p]; }
    if (!target || typeof target !== "object") continue;
    switch (op.op) {
      case "delete": delete target[leaf]; break;
      case "set": target[leaf] = op.value; break;
      case "rename": if (leaf in target) { target[op.to] = target[leaf]; delete target[leaf]; } break;
      case "clamp": {
        const v = target[leaf];
        if (typeof v === "number") {
          if (op.max !== undefined) target[leaf] = Math.min(v, op.max);
          if (op.min !== undefined) target[leaf] = Math.max(target[leaf], op.min);
        }
        break;
      }
      case "wrap": if (leaf in target) target[leaf] = op.as === "array" ? [target[leaf]] : { value: target[leaf] }; break;
    }
  }
  const serialized = JSON.stringify(next);
  return serialized.length > maxBytes ? null : next;
}

/* -------------------- 5. Orchestrator -------------------- */

const SECRET_KEYS = /(api[_-]?key|authorization|token|secret|password|bearer)/i;

function scrub(body: Record<string, any>): Record<string, any> {
  const clone = structuredClone(body);
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    for (const k of Object.keys(node)) {
      if (SECRET_KEYS.test(k)) node[k] = "[redacted]"; else walk(node[k]);
    }
  };
  walk(clone);
  return clone;
}

export interface FixEnv {
  PATCH_CATALOG: KVNamespace;
  HEALER_BREAKER: DurableObjectNamespace;
  HEALER_URL?: string;
  HEALER_API_KEY?: string;
  FIX_TIMEOUT_MS?: string;
  FIX_MAX_PATCH_BYTES?: string;
}

export async function repair(env: FixEnv, opts: {
  provider: string; model: string; status: number; errorBody: unknown;
  requestBody: Record<string, any>; enabled: boolean;
  send: (body: Record<string, any>) => Promise<Response>;
}): Promise<{ response: Response | null; result: FixResult }> {
  const none = (outcome: FixResult["outcome"]): FixResult => ({
    attempted: false, recovered: false, tier: null, signature: null, patch: null, outcome, healerCostUsd: 0,
  });

  if (!opts.enabled || !REPAIRABLE.has(opts.status)) return { response: null, result: none("not_repairable") };

  const err = normalizeError(opts.status, opts.errorBody);
  const sig = await signature(opts.provider, opts.model, err, opts.requestBody);
  const maxBytes = Number(env.FIX_MAX_PATCH_BYTES ?? 32768);

  let tier: 0 | 1 | 2 = 0;
  let ops: PatchOp[] | null = null;
  let healerCost = 0;

  const cached = await env.PATCH_CATALOG.get(`patch:${sig}`, "json").catch(() => null);
  if (cached) ops = cached as PatchOp[];

  if (!ops) { ops = ruleLookup(err, opts.requestBody); if (ops) tier = 1; }

  if (!ops && env.HEALER_URL) {
    const breaker = env.HEALER_BREAKER.get(env.HEALER_BREAKER.idFromName("global"));
    const state = await breaker.fetch("https://breaker/state")
      .then((r) => r.json<{ open: boolean }>()).catch(() => ({ open: false }));
    if (state.open) return { response: null, result: none("breaker_open") };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(env.FIX_TIMEOUT_MS ?? 10000));
      const res = await fetch(`${env.HEALER_URL}/heal`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.HEALER_API_KEY ?? "" },
        body: JSON.stringify({ signature: sig, error: err, body: scrub(opts.requestBody),
          provider: opts.provider, model: opts.model }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`healer ${res.status}`);
      const data = await res.json<{ ops: PatchOp[]; cost_usd?: number }>();
      ops = data.ops; healerCost = data.cost_usd ?? 0; tier = 2;
      await breaker.fetch("https://breaker/success", { method: "POST" });
    } catch {
      await breaker.fetch("https://breaker/failure", { method: "POST" });
      return { response: null, result: none("healer_error") };
    }
  }

  if (!ops || ops.length === 0) return { response: null, result: none("no_patch") };

  const patched = applyPatch(opts.requestBody, ops, maxBytes);
  if (!patched) return { response: null, result: none("no_patch") };

  // Exactly one retry. No loop.
  const retry = await opts.send(patched).catch(() => null);
  const recovered = !!retry && retry.ok;

  if (recovered && tier !== 0) {
    await env.PATCH_CATALOG.put(`patch:${sig}`, JSON.stringify(ops),
      { expirationTtl: 60 * 60 * 24 * 90 }).catch(() => {});
  }

  return {
    response: recovered ? retry : null,
    result: { attempted: true, recovered, tier, signature: sig, patch: ops,
      outcome: recovered ? "recovered" : "patch_failed", healerCostUsd: healerCost },
  };
}
