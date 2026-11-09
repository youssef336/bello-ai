import type { User } from './auth';
import { type Env, now } from './env';
import { keysFor } from './keys';
import { providerById } from './providers';

const WINDOW_MS = 30 * 24 * 3600_000;
const MAX_ITEMS = 40;
/** Shorter rests are a per-minute limit passing by, not a model that has run out. */
const LONG_REST_MS = 10 * 60_000;

export interface Notifications {
  /** Models that arrived or left, newest first. */
  items: { key: string; at: number; kind: 'added' | 'removed'; name: string; provider: string }[];
  /** Models whose limit this person has used up, and when each comes back. */
  resting: { key: string; until: number; name: string; provider: string }[];
}

type EventRow = { id: number; at: number; kind: 'added' | 'removed'; model_id: string; name: string | null; paid: number | null };
type RestRow = { model_id: string; until: number; name: string | null };

const providerOf = (modelId: string): string => modelId.split(':')[0] ?? '';
const shortName = (modelId: string, name: string | null): string => name ?? modelId.slice(modelId.indexOf(':') + 1);
const labelOf = (modelId: string): string => providerById(providerOf(modelId))?.label ?? providerOf(modelId);

export async function notifications(env: Env, user: User): Promise<Notifications> {
  const at = now();
  const [keys, events, rests] = await Promise.all([
    keysFor(env, user),
    env.DB.prepare(
      `SELECT e.id, e.at, e.kind, e.model_id, m.name, m.paid FROM events e LEFT JOIN models m ON m.id = e.model_id
        WHERE e.kind IN ('added', 'removed') AND e.model_id IS NOT NULL AND e.at >= ? ORDER BY e.at DESC LIMIT ?`,
    ).bind(at - WINDOW_MS, MAX_ITEMS).all<EventRow>(),
    env.DB.prepare(
      `SELECT c.model_id, c.until, m.name FROM cooldowns c LEFT JOIN models m ON m.id = c.model_id
        WHERE c.user_id = ? AND c.strikes > 0 AND c.until > ? ORDER BY c.until DESC LIMIT 20`,
    ).bind(user.id, at + LONG_REST_MS).all<RestRow>(),
  ]);
  // The same rule as the models page: a member hears only about what their keys can reach.
  const reachable = (e: EventRow) => user.role === 'owner' || (keys.has(providerOf(e.model_id)) && !e.paid);
  return {
    items: events.results.filter(reachable).map((e) => ({
      key: String(e.id),
      at: e.at,
      kind: e.kind,
      name: shortName(e.model_id, e.name),
      provider: labelOf(e.model_id),
    })),
    resting: rests.results.map((r) => ({
      key: `${r.model_id}@${r.until}`,
      until: r.until,
      name: shortName(r.model_id, r.name),
      provider: labelOf(r.model_id),
    })),
  };
}
