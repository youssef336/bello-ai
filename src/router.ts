import type { Language, Task } from './lang';

export interface ModelRow {
  id: string;
  provider: string;
  model: string;
  name: string;
  status: string;
  free_evidence: string | null;
  verified_at: number | null;
  tested_at: number | null;
  context_length: number | null;
  supports_tools: number;
  supports_vision: number;
  arabic_ok: number | null;
  quality: number;
  latency_ms: number | null;
  ok_count: number;
  fail_count: number;
  cooldown_until: number;
  cooldown_strikes: number;
  last_error: string | null;
  first_seen: number;
  last_seen: number;
  paid: number;
  price_in: number | null;
  price_out: number | null;
}

export interface RouteRequest {
  language: Language;
  task: Task;
  /** Rough prompt size in tokens; models with a smaller window are skipped. */
  tokens: number;
  /** Per-provider score adjustment (see Provider.bonus). */
  providerBonus: ReadonlyMap<string, number>;
  at: number;
}

const CODE_NAME = /cod(e|er|ing)|devstral|qwen.*coder|deepseek/i;
const REASONING_NAME = /reason|think|r1\b|qwq|o\d|gpt-oss|kimi|deepseek/i;

/** Higher is better. -Infinity means "never for this request". */
export function scoreModel(m: ModelRow, req: RouteRequest): number {
  if (m.status !== 'active' || m.cooldown_until > req.at) return -Infinity;
  if (m.context_length !== null && m.context_length < req.tokens + 1024) return -Infinity;

  let score = m.quality;

  if (req.language === 'ar') {
    if (m.arabic_ok === 0) return -Infinity;
    score += m.arabic_ok === 1 ? 10 : -5;
  }
  if (req.task === 'code' && CODE_NAME.test(m.model)) score += 10;
  if (req.task === 'reasoning' && REASONING_NAME.test(m.model)) score += 8;

  // Laplace-smoothed success rate: a new model starts at 0.5 and earns its place.
  const success = (m.ok_count + 1) / (m.ok_count + m.fail_count + 2);
  score += (success - 0.5) * 40;

  if (m.latency_ms !== null) score -= Math.min(m.latency_ms / 1000, 10);
  score += req.providerBonus.get(m.provider) ?? 0;

  // OpenRouter's own "any free model" router: handy as a last resort only.
  if (m.model === 'openrouter/free') score -= 30;
  return score;
}

/** Best first. Each provider appears at most twice so one outage cannot eat the fallback chain. */
export function rankModels(models: ModelRow[], req: RouteRequest, limit: number): ModelRow[] {
  const ranked = models
    .map((m) => ({ m, s: scoreModel(m, req) }))
    .filter((x) => x.s !== -Infinity)
    .sort((a, b) => b.s - a.s);
  const perProvider = new Map<string, number>();
  const out: ModelRow[] = [];
  for (const { m } of ranked) {
    const n = perProvider.get(m.provider) ?? 0;
    if (n >= 2) continue;
    perProvider.set(m.provider, n + 1);
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

/** Cooldown after a rate limit: Retry-After when given, otherwise 1, 2, 4 … minutes, capped at 6 h. */
export function cooldownMs(strikes: number, retryAfterSeconds: number | null, dailyLimit: boolean): number {
  if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 6 * 3600_000);
  }
  if (dailyLimit) return 6 * 3600_000;
  return Math.min(60_000 * 2 ** strikes, 6 * 3600_000);
}
