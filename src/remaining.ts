import type { User } from './auth';
import { type Env, now, today } from './env';
import { nextReset } from './limits';
import type { ModelRow } from './router';

/**
 * How much is left on the model that just answered, as far as its provider says:
 * - Groq sends the model's daily request allowance on every response.
 * - OpenRouter reports one daily allowance shared by all its free models (GET /key).
 * - Gemini and Workers AI report nothing per model, so only today's own count is known.
 * A number is never made up: `left` stays null when the provider gives none.
 */

export interface RateLimit {
  left: number;
  limit: number | null;
  resetAt: number | null;
}

export interface Remaining {
  model: string;
  paid: boolean;
  left: number | null;
  limit: number | null;
  /** The allowance belongs to the whole account's free models, not to this one. */
  shared: boolean;
  resetAt: number | null;
  /** This person's answers from this model today. */
  used: number;
}

const LIMIT_HEADERS = ['x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests'];

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3600_000 };

/** Groq's "2m59.56s" / "7.66s" / "1h2m" in milliseconds; null when it is not a duration. */
export function parseDuration(text: string | null): number | null {
  const parts = [...(text ?? '').matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (!parts.length) return null;
  return Math.round(parts.reduce((total, [, n, unit]) => total + Number(n) * UNIT_MS[unit!]!, 0));
}

const numberOf = (text: string | null): number | null => {
  const n = text === null || text.trim() === '' ? NaN : Number(text);
  return Number.isFinite(n) ? n : null;
};

export function rateLimitFromHeaders(headers: Headers, at: number = now()): RateLimit | null {
  const left = numberOf(headers.get('x-ratelimit-remaining-requests'));
  if (left === null) return null;
  const wait = parseDuration(headers.get('x-ratelimit-reset-requests'));
  return {
    left,
    limit: numberOf(headers.get('x-ratelimit-limit-requests')),
    resetAt: wait === null ? null : at + wait,
  };
}

/** The limit headers of a provider response, to carry over to a response built from it. */
export function rateLimitHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of LIMIT_HEADERS) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

async function openRouterLeft(key: string, at: number): Promise<RateLimit | null> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const { data } = await res.json<{ data?: { free_model_daily_requests?: { limit?: unknown; remaining?: unknown } } }>();
    const daily = data?.free_model_daily_requests;
    if (typeof daily?.remaining !== 'number') return null;
    return { left: daily.remaining, limit: typeof daily.limit === 'number' ? daily.limit : null, resetAt: nextReset(at) };
  } catch {
    return null;
  }
}

export async function remainingFor(
  env: Env,
  user: User,
  m: ModelRow,
  key: string | undefined,
  headers: Headers,
): Promise<Remaining> {
  const at = now();
  const shared = !m.paid && m.provider === 'openrouter' && Boolean(key);
  const rate = m.paid
    ? null
    : m.provider === 'groq'
      ? rateLimitFromHeaders(headers, at)
      : shared
        ? await openRouterLeft(key!, at)
        : null;
  const row = await env.DB.prepare('SELECT requests + fallbacks AS n FROM usage WHERE day = ? AND user_id = ? AND model_id = ?')
    .bind(today(), user.id, m.id).first<{ n: number }>();
  return {
    model: m.name,
    paid: Boolean(m.paid),
    left: rate?.left ?? null,
    limit: rate?.limit ?? null,
    shared: shared && rate !== null,
    // Workers AI gives no number, but its daily allocation always refills at 00:00 UTC.
    resetAt: rate?.resetAt ?? (m.provider === 'workers-ai' ? nextReset(at) : null),
    used: row?.n ?? 0,
  };
}
