import { type Env, now } from './env';
import { configuredProviders, guessQuality, type Provider, providerById } from './providers';
import type { ModelRow } from './router';

const DAY = 24 * 3600_000;
/**
 * The free plan allows 50 subrequests (and 50 D1 queries) per invocation. Each test is one fetch
 * plus one D1 batch, so 12 tests stay well inside with room for listing and bookkeeping.
 */
const MAX_TESTS_PER_RUN = 12;
/** A model missing from the catalog for longer than this is marked removed. */
const REMOVE_AFTER_MS = 12 * 3600_000;

export interface QuickTestResult {
  ok: boolean;
  paid: boolean;
  arabic: boolean;
  latencyMs: number;
  error?: string;
}

/** One call checks three things: the model answers, answers in Arabic, and answers correctly. */
export async function quickTest(provider: Provider, key: string, model: string): Promise<QuickTestResult> {
  const started = now();
  try {
    const res = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        ...provider.extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'أجب بكلمة واحدة باللغة العربية: ما هي عاصمة مصر؟' }],
        max_tokens: 1024,
        temperature: 0,
      }),
    });
    const latencyMs = now() - started;
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      // No free quota at all for this model on a free key: "limit: 0" (Gemini) or 402 (payment).
      const paid = res.status === 402 || (res.status === 429 && /limit:\s*0\b|free_tier|billing/i.test(body));
      return { ok: false, paid, arabic: false, latencyMs, error: `HTTP ${res.status}: ${body}` };
    }
    const data = await res.json<{ choices?: { message?: { content?: string | null } }[] }>();
    const answer = data.choices?.[0]?.message?.content ?? '';
    if (!answer.trim()) return { ok: false, paid: false, arabic: false, latencyMs, error: 'empty answer' };
    return { ok: true, paid: false, arabic: /القاهر/.test(answer), latencyMs };
  } catch (e) {
    return { ok: false, paid: false, arabic: false, latencyMs: now() - started, error: String(e) };
  }
}

function eventStmt(env: Env, kind: string, modelId: string | null, detail: string): D1PreparedStatement {
  return env.DB.prepare('INSERT INTO events (at, kind, model_id, detail) VALUES (?, ?, ?, ?)')
    .bind(now(), kind, modelId, detail.slice(0, 500));
}

async function logEvent(env: Env, kind: string, modelId: string | null, detail: string): Promise<void> {
  await eventStmt(env, kind, modelId, detail).run();
}

export interface ScanReport {
  provider: string;
  found: number;
  added: string[];
  removed: string[];
  failed: string[];
  paid: string[];
  error?: string;
}

/**
 * Scan one provider: register new free models, test candidates, retire models the provider
 * dropped. New models that pass the quick test become active right away (auto-add).
 */
export async function scanProvider(env: Env, provider: Provider): Promise<ScanReport> {
  const report: ScanReport = { provider: provider.id, found: 0, added: [], removed: [], failed: [], paid: [] };
  const key = provider.keyOf(env);
  if (!key) return { ...report, error: 'no API key' };

  let found;
  try {
    found = await provider.discover(key);
  } catch (e) {
    report.error = String(e);
    await logEvent(env, 'scan', null, `${provider.id}: ${report.error}`);
    return report;
  }
  report.found = found.length;
  const at = now();

  const existing = await env.DB.prepare('SELECT * FROM models WHERE provider = ?')
    .bind(provider.id)
    .all<ModelRow>();
  const known = new Map(existing.results.map((m) => [m.id, m]));
  const seen = new Set<string>();

  const writes: D1PreparedStatement[] = [];
  for (const d of found) {
    const id = `${provider.id}:${d.model}`;
    seen.add(id);
    const row = known.get(id);
    if (!row) {
      writes.push(
        env.DB.prepare(
          `INSERT INTO models (id, provider, model, name, status, free_evidence, context_length,
             supports_tools, supports_vision, quality, first_seen, last_seen)
           VALUES (?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, provider.id, d.model, d.name, d.evidence, d.contextLength, d.tools ? 1 : 0,
          d.vision ? 1 : 0, guessQuality(d.model), at, at),
      );
    } else {
      // Back in the catalog after removal → test again.
      const status = row.status === 'removed' ? 'candidate' : row.status;
      writes.push(
        env.DB.prepare(
          `UPDATE models SET last_seen = ?, status = ?, context_length = COALESCE(?, context_length)
           WHERE id = ?`,
        ).bind(at, status, d.contextLength, id),
      );
    }
  }
  for (const m of existing.results) {
    if (!seen.has(m.id) && m.status !== 'removed' && at - m.last_seen > REMOVE_AFTER_MS) {
      writes.push(env.DB.prepare(`UPDATE models SET status = 'removed' WHERE id = ?`).bind(m.id));
      report.removed.push(m.id);
    }
  }
  for (const id of report.removed) writes.push(eventStmt(env, 'removed', id, 'no longer in the provider catalog'));
  if (writes.length) await env.DB.batch(writes);

  // Candidates first, then failed models a day later, then paid ones a week later (free tiers change).
  const toTest = await env.DB.prepare(
    `SELECT * FROM models WHERE provider = ? AND (
        status = 'candidate'
        OR (status = 'failed' AND COALESCE(tested_at, 0) < ?)
        OR (status = 'paid' AND COALESCE(tested_at, 0) < ?))
     ORDER BY status = 'candidate' DESC, first_seen DESC LIMIT ?`,
  )
    .bind(provider.id, at - DAY, at - 7 * DAY, MAX_TESTS_PER_RUN)
    .all<ModelRow>();

  for (const m of toTest.results) {
    const r = await quickTest(provider, key, m.model);
    const t = now();
    if (r.ok) {
      const stmts = [
        env.DB.prepare(
          `UPDATE models SET status = 'active', verified_at = ?, tested_at = ?, arabic_ok = ?,
             latency_ms = ?, ok_count = ok_count + 1, last_error = NULL WHERE id = ?`,
        ).bind(t, t, r.arabic ? 1 : 0, r.latencyMs, m.id),
      ];
      if (m.status === 'candidate') {
        report.added.push(m.id);
        stmts.push(eventStmt(env, 'added', m.id,
          `${m.free_evidence ?? ''}${r.arabic ? '' : ' · weak Arabic'}`));
      }
      await env.DB.batch(stmts);
    } else if (/^HTTP 40[13]\b/.test(r.error ?? '')) {
      // The key was rejected: the model is not at fault, and every other test would fail the same way.
      report.error = `API key rejected (${r.error?.slice(0, 120)})`;
      break;
    } else if (r.error?.startsWith('HTTP 429') && !r.paid) {
      // Just rate limited: leave it as is and try again next scan.
      continue;
    } else {
      const status = r.paid ? 'paid' : 'failed';
      (r.paid ? report.paid : report.failed).push(m.id);
      await env.DB.batch([
        env.DB.prepare(`UPDATE models SET status = ?, tested_at = ?, last_error = ? WHERE id = ?`)
          .bind(status, t, r.error ?? null, m.id),
        eventStmt(env, status, m.id, r.error ?? ''),
      ]);
    }
  }
  await logEvent(env, 'scan', null,
    `${provider.id}: ${report.found} free, +${report.added.length} added, -${report.removed.length} removed` +
      (report.error ? ` · ${report.error}` : ''));
  return report;
}

/** Cron: one provider per run (round-robin) so a run never hits the subrequest or CPU caps. */
export async function scheduledScan(env: Env): Promise<ScanReport | null> {
  const providers = configuredProviders(env);
  if (!providers.length) return null;
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'discovery_cursor'`)
    .first<{ value: string }>();
  const cursor = Number(row?.value ?? 0) % providers.length;
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES ('discovery_cursor', ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).bind(String(cursor + 1)).run();
  return scanProvider(env, providers[cursor]!);
}

export async function scanById(env: Env, providerId: string): Promise<ScanReport | null> {
  const provider = providerById(providerId);
  return provider ? scanProvider(env, provider) : null;
}
