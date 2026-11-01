import { type Env, now } from './env';
import { guessQuality, type OpenRouterModel } from './providers';

/**
 * Paid models go through OpenRouter: one prepaid balance covers Claude, GPT, Gemini Pro and the
 * rest, and an empty balance fails instead of billing. Nothing paid is ever used unless the
 * owner (1) turns paid mode on, (2) allows that model, and (3) is under the monthly cap.
 */

export interface PaidEntry {
  id: string;
  name: string;
  vendor: string;
  /** USD per 1M tokens. */
  in: number;
  out: number;
  context: number | null;
  vision: boolean;
}

export interface PaidSettings {
  mode: 'on' | 'off';
  capUsd: number;
}

const perMillion = (price: string | undefined): number => Math.round(Number(price ?? 0) * 1e6 * 1000) / 1000;

/** Text chat models with a real price. Batch-only variants are skipped (no streaming chat). */
export function toPaidEntries(models: OpenRouterModel[]): PaidEntry[] {
  return models
    .filter((m) => {
      const out = m.architecture?.output_modalities ?? ['text'];
      const input = m.architecture?.input_modalities ?? ['text'];
      if (!out.includes('text') || !input.includes('text') || m.id.endsWith(':batch')) return false;
      return Number(m.pricing?.prompt ?? 0) > 0 || Number(m.pricing?.completion ?? 0) > 0;
    })
    .map((m) => ({
      id: m.id,
      name: m.name.replace(/^[^:]+:\s*/, ''),
      vendor: m.id.split('/')[0] ?? '',
      in: perMillion(m.pricing?.prompt),
      out: perMillion(m.pricing?.completion),
      context: m.context_length ?? null,
      vision: m.architecture?.input_modalities?.includes('image') ?? false,
    }))
    .sort((a, b) => a.out - b.out);
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export function setSettingStmt(env: Env, key: string, value: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).bind(key, value);
}

/** The whole price list is one settings row: one write per refresh instead of hundreds. */
export async function savePaidCatalog(env: Env, models: OpenRouterModel[]): Promise<void> {
  await setSettingStmt(env, 'paid_catalog', JSON.stringify({ updatedAt: now(), models: toPaidEntries(models) })).run();
}

export async function loadPaidCatalog(env: Env): Promise<{ updatedAt: number; models: PaidEntry[] }> {
  const raw = await getSetting(env, 'paid_catalog');
  if (raw) return JSON.parse(raw);
  const res = await fetch('https://openrouter.ai/api/v1/models');
  if (!res.ok) return { updatedAt: 0, models: [] };
  await savePaidCatalog(env, (await res.json<{ data: OpenRouterModel[] }>()).data);
  return JSON.parse((await getSetting(env, 'paid_catalog'))!);
}

export async function paidSettings(env: Env): Promise<PaidSettings> {
  const [mode, cap] = await Promise.all([getSetting(env, 'paid_mode'), getSetting(env, 'paid_cap_usd')]);
  return { mode: mode === 'on' ? 'on' : 'off', capUsd: cap === null ? 5 : Number(cap) };
}

export async function monthSpend(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(cost_est), 0) AS spent FROM usage WHERE day >= strftime('%Y-%m-01', 'now')`,
  ).first<{ spent: number }>();
  return row?.spent ?? 0;
}

/** True only when the owner switched paid mode on and this month is still under the cap. */
export async function paidAllowedNow(env: Env): Promise<boolean> {
  const s = await paidSettings(env);
  return s.mode === 'on' && (await monthSpend(env)) < s.capUsd;
}

export async function openRouterCredits(env: Env): Promise<{ total: number; used: number } | null> {
  if (!env.OPENROUTER_API_KEY) return null;
  const res = await fetch('https://openrouter.ai/api/v1/credits', {
    headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
  });
  if (!res.ok) return null;
  const { data } = await res.json<{ data: { total_credits: number; total_usage: number } }>();
  return { total: data.total_credits, used: data.total_usage };
}

/** Allowing a paid model adds it to the registry as active, flagged paid, with its prices. */
export async function allowPaidModel(env: Env, modelId: string): Promise<boolean> {
  const catalog = await loadPaidCatalog(env);
  const entry = catalog.models.find((m) => m.id === modelId);
  if (!entry) return false;
  const at = now();
  await env.DB.prepare(
    `INSERT INTO models (id, provider, model, name, status, free_evidence, context_length, supports_vision,
       quality, paid, price_in, price_out, first_seen, last_seen)
     VALUES (?, 'openrouter', ?, ?, 'active', ?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET status = 'active', paid = 1, price_in = excluded.price_in,
       price_out = excluded.price_out, cooldown_until = 0`,
  ).bind(`openrouter:${entry.id}`, entry.id, entry.name,
    `PAID — allowed by the owner on ${new Date(at).toISOString().slice(0, 10)}`,
    entry.context, entry.vision ? 1 : 0,
    // The owner picked it on purpose, usually for quality: rank it above the free ones.
    Math.max(guessQuality(entry.id), 80), entry.in, entry.out, at, at).run();
  return true;
}

export async function disallowPaidModel(env: Env, modelId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM models WHERE id = ? AND paid = 1').bind(`openrouter:${modelId}`).run();
}

/** Estimated cost of one answer, from the stored per-1M prices. */
export function estimateCost(priceIn: number | null, priceOut: number | null, promptChars: number, answerChars: number): number {
  if (!priceIn && !priceOut) return 0;
  return ((promptChars / 4) * (priceIn ?? 0) + (answerChars / 4) * (priceOut ?? 0)) / 1e6;
}
