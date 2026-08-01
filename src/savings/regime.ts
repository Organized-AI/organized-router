/**
 * Cost regime detection and plan-aware savings.
 *
 * The whole savings model assumes a request has a marginal dollar cost. Under a
 * monthly subscription (Claude Max/Pro, ChatGPT/Codex plans) it does not: the money
 * is already spent, and routing a request to a cheaper model saves zero dollars.
 *
 * Billing 5% of an imaginary saving would be fraud, so the regime decides whether a
 * request can produce a billable saving at all.
 */

export type CostRegime =
  | "api"              // pay-per-token BYOK. Marginal cost is real. Savings billable
  | "plan_within_cap"  // subscription, quota not binding. Marginal cost is zero. Savings NOT billable
  | "plan_spillover";  // subscription, this request would breach a window and fall to API. Savings billable

export type WindowKind = "rolling_5h" | "weekly" | "monthly";

export interface PlanWindow {
  kind: WindowKind;
  /** Plan units allowed per window. null until observed. */
  capUnits: number | null;
  usedUnits: number;
  resetsAt: number;
}

export interface PlanState {
  provider: string;
  planName: string;            // "claude_max_20x", "chatgpt_plus", "codex_pro"
  monthlyCostUsd: number;
  authType: "oauth_subscription" | "api_key";
  windows: PlanWindow[];
  /** Plan units consumed this billing period, for amortized reporting. */
  periodUnits: number;
}

/**
 * Plan units are not tokens. Subscriptions meter weighted usage: a frontier model
 * burns quota far faster than a small one. Weights are learned from observed
 * rate-limit headroom decay and cached in KV; these are the cold-start defaults.
 */
export const DEFAULT_UNIT_WEIGHTS: Record<string, number> = {
  opus: 5.0,
  sonnet: 1.0,
  haiku: 0.2,
  "gpt-5": 4.0,
  "gpt-5-mini": 0.8,
  o3: 4.0,
  "o4-mini": 0.8,
  default: 1.0,
};

export function unitWeight(model: string, weights = DEFAULT_UNIT_WEIGHTS): number {
  const m = model.toLowerCase();
  for (const key of Object.keys(weights)) {
    if (key !== "default" && m.includes(key)) return weights[key];
  }
  return weights.default;
}

export function planUnits(model: string, tokensIn: number, tokensOut: number): number {
  return (tokensIn + tokensOut * 4) * unitWeight(model);
}

/* ---------------- Plan detection ---------------- */

/**
 * Read plan windows from provider rate-limit headers. Header names differ per
 * provider and change over time, so every lookup is a miss-tolerant probe rather
 * than a hard schema. A miss leaves the window unchanged, never throws.
 */
export function readWindowsFromHeaders(h: Headers): Partial<PlanWindow>[] {
  const num = (k: string) => {
    const v = h.get(k);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const ts = (k: string) => {
    const v = h.get(k);
    if (!v) return null;
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  };

  const out: Partial<PlanWindow>[] = [];

  // Anthropic unified / OAuth subscription surface
  const fiveHourLimit = num("anthropic-ratelimit-unified-5h-limit");
  const fiveHourRemaining = num("anthropic-ratelimit-unified-5h-remaining");
  if (fiveHourLimit !== null) {
    out.push({
      kind: "rolling_5h",
      capUnits: fiveHourLimit,
      usedUnits: fiveHourRemaining === null ? 0 : fiveHourLimit - fiveHourRemaining,
      resetsAt: ts("anthropic-ratelimit-unified-5h-reset") ?? Date.now() + 5 * 3600_000,
    });
  }

  const weekLimit = num("anthropic-ratelimit-unified-7d-limit");
  const weekRemaining = num("anthropic-ratelimit-unified-7d-remaining");
  if (weekLimit !== null) {
    out.push({
      kind: "weekly",
      capUnits: weekLimit,
      usedUnits: weekRemaining === null ? 0 : weekLimit - weekRemaining,
      resetsAt: ts("anthropic-ratelimit-unified-7d-reset") ?? Date.now() + 7 * 86400_000,
    });
  }

  // Generic OpenAI-shaped fallback
  const genericLimit = num("x-ratelimit-limit-tokens");
  const genericRemaining = num("x-ratelimit-remaining-tokens");
  if (out.length === 0 && genericLimit !== null) {
    out.push({
      kind: "rolling_5h",
      capUnits: genericLimit,
      usedUnits: genericRemaining === null ? 0 : genericLimit - genericRemaining,
      resetsAt: Date.now() + 3600_000,
    });
  }

  return out;
}

/**
 * A credential that is an OAuth token rather than a provider API key means the
 * request is served by a subscription. This is the primary signal; headers only
 * refine it.
 */
export function detectAuthType(credential: string): PlanState["authType"] {
  if (/^(sk-ant-|sk-|AIza|sk-or-)/.test(credential)) return "api_key";
  return "oauth_subscription";
}

/* ---------------- Regime ---------------- */

export function classifyRegime(plan: PlanState | null, estimatedUnits: number): CostRegime {
  if (!plan || plan.authType === "api_key") return "api";

  for (const w of plan.windows) {
    if (w.capUnits === null) continue;              // cap not yet observed, assume headroom
    if (Date.now() > w.resetsAt) continue;          // stale window
    if (w.usedUnits + estimatedUnits > w.capUnits) return "plan_spillover";
  }
  return "plan_within_cap";
}

/* ---------------- Savings ---------------- */

export interface SavingsInput {
  regime: CostRegime;
  baselineModel: string;
  selectedModel: string;
  /** List API cost in USD had the request run on each model. */
  baselineApiCostUsd: number;
  selectedApiCostUsd: number;
  probeCostUsd: number;
  baselineUnits: number;
  selectedUnits: number;
}

export interface SavingsResult {
  regime: CostRegime;
  /** Billable. Always >= 0. Zero inside a plan. */
  savedUsd: number;
  /** Non-billable. Plan quota preserved, the real value inside a subscription. */
  savedUnits: number;
  billable: boolean;
  note: string;
}

export function computeSavings(i: SavingsInput): SavingsResult {
  const savedUnits = Math.max(0, i.baselineUnits - i.selectedUnits);

  switch (i.regime) {
    case "api": {
      const savedUsd = Math.max(0, i.baselineApiCostUsd - i.selectedApiCostUsd - i.probeCostUsd);
      return { regime: i.regime, savedUsd, savedUnits, billable: true, note: "pay-per-token" };
    }

    case "plan_within_cap":
      // The money was spent at the start of the month. Routing changed nothing about it.
      return {
        regime: i.regime,
        savedUsd: 0,
        savedUnits,
        billable: false,
        note: "inside plan quota, marginal cost zero, no dollar saving exists",
      };

    case "plan_spillover": {
      // The baseline would have breached the window and fallen through to API pricing.
      // If the selected model fits inside the remaining quota, the entire API cost is avoided.
      const savedUsd = Math.max(0, i.baselineApiCostUsd - i.selectedApiCostUsd - i.probeCostUsd);
      return {
        regime: i.regime,
        savedUsd,
        savedUnits,
        billable: true,
        note: "plan window would have been breached, API cost avoided",
      };
    }
  }
}

/**
 * Reporting only, never billing. What a plan actually costs per unit, once the
 * period's real consumption is known. Falls to zero-ish for heavy users, which is
 * the honest answer: a heavy subscriber's marginal token is nearly free.
 */
export function amortizedRateUsdPerUnit(plan: PlanState): number | null {
  if (plan.periodUnits <= 0) return null;
  return plan.monthlyCostUsd / plan.periodUnits;
}
