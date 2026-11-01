import { DAILY_LIMITS } from '../config/limits';
import type { User } from './auth';
import { type Env, error, json, now, today } from './env';

/**
 * Daily limits per person, like Claude's and ChatGPT's. A day is the UTC day: it resets at 00:00
 * UTC, the same moment Cloudflare refills the free Workers AI allocation that images and video
 * subtitles run on. Video is counted in seconds of audio and shown in minutes.
 */

export type Kind = 'messages' | 'images' | 'video';
export const KINDS: Kind[] = ['messages', 'images', 'video'];

/** What the owner stored for a person: NULL = default, -1 = no limit. */
type Stored = { limit_messages: number | null; limit_images: number | null; limit_video: number | null };

/** The unit the limit is written in → the unit `daily_use` counts in. */
const SCALE: Record<Kind, number> = { messages: 1, images: 1, video: 60 };

export const nextReset = (at: number = now()): number => {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

/** The limit in its written unit (minutes for video); null = no limit. */
export function effectiveLimit(role: User['role'], stored: number | null | undefined, kind: Kind): number | null {
  if (stored === -1) return null;
  if (typeof stored === 'number' && stored >= 0) return stored;
  return DAILY_LIMITS[role][kind];
}

async function storedLimits(env: Env, userId: string): Promise<Stored | null> {
  return env.DB.prepare('SELECT limit_messages, limit_images, limit_video FROM users WHERE id = ?')
    .bind(userId).first<Stored>();
}

export interface Usage {
  kind: Kind;
  used: number;
  limit: number | null;
}

/** Today's use and limit of every kind, in written units (video in minutes, rounded up). */
export async function usageOf(env: Env, user: User): Promise<{ resetAt: number; kinds: Usage[] }> {
  const [stored, rows] = await Promise.all([
    storedLimits(env, user.id),
    env.DB.prepare('SELECT kind, used FROM daily_use WHERE day = ? AND user_id = ?')
      .bind(today(), user.id).all<{ kind: Kind; used: number }>(),
  ]);
  const used = new Map(rows.results.map((r) => [r.kind, r.used]));
  return {
    resetAt: nextReset(),
    kinds: KINDS.map((kind) => ({
      kind,
      used: Math.ceil((used.get(kind) ?? 0) / SCALE[kind]),
      limit: effectiveLimit(user.role, stored?.[`limit_${kind}`], kind),
    })),
  };
}

/**
 * Take `amount` (in counting units: seconds for video) from today's allowance, in one statement so
 * two tabs cannot both slip past the limit. false = not enough left; nothing was taken.
 */
export async function consume(env: Env, user: User, kind: Kind, amount = 1): Promise<boolean> {
  const limit = effectiveLimit(user.role, (await storedLimits(env, user.id))?.[`limit_${kind}`], kind);
  const max = limit === null ? Number.MAX_SAFE_INTEGER : limit * SCALE[kind];
  if (amount > max) return false;
  const res = await env.DB.prepare(
    `INSERT INTO daily_use (day, user_id, kind, used) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (day, user_id, kind) DO UPDATE SET used = used + ?4 WHERE used + ?4 <= ?5`,
  ).bind(today(), user.id, kind, amount, max).run();
  return res.meta.changes > 0;
}

/** Give back what a request took when it produced nothing. */
export async function refund(env: Env, user: User, kind: Kind, amount = 1): Promise<void> {
  await env.DB.prepare('UPDATE daily_use SET used = MAX(0, used - ?) WHERE day = ? AND user_id = ? AND kind = ?')
    .bind(amount, today(), user.id, kind).run();
}

const NAMES: Record<Kind, string> = { messages: 'الرسايل', images: 'الصور', video: 'دقايق ترجمة الفيديو' };

/** 429 with the reset time, for the browser to show like "you have reached today's limit". */
export function limitReached(kind: Kind): Response {
  return json({ error: `خلّصت حد ${NAMES[kind]} بتاع النهارده.`, limit: kind, resetAt: nextReset() }, 429);
}

/** Cloudflare's free daily allocation itself is used up: same answer shape, same reset moment. */
export function allocationUsed(): Response {
  return json({ error: 'رصيد Cloudflare المجاني للصور والفيديو خلص النهارده.', resetAt: nextReset() }, 429);
}

/** Owner: set a person's limits. Each value: null = default, -1 = no limit, 0..100000. */
export async function setLimits(env: Env, userId: string, body: Partial<Record<Kind, unknown>>): Promise<Response> {
  const values: (number | null)[] = [];
  for (const kind of KINDS) {
    const v = body[kind];
    if (v === null || v === undefined) values.push(null);
    else if (typeof v === 'number' && Number.isInteger(v) && v >= -1 && v <= 100_000) values.push(v);
    else return error(400, `${kind}: a whole number, -1 for no limit, or null for the default`);
  }
  const res = await env.DB.prepare('UPDATE users SET limit_messages = ?, limit_images = ?, limit_video = ? WHERE id = ?')
    .bind(...values, userId).run();
  return res.meta.changes ? json({ ok: true }) : error(404, 'not found');
}
