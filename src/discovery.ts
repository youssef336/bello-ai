import { type Env, now } from './env';
import { callProvider, configuredProviders, guessQuality, type Provider, providerById } from './providers';
import { SCAN_EVERY_DAYS } from '../config/scan';
import { benchSome } from './bench';
import { setSettingStmt } from './paid';
import type { ModelRow } from './router';

const DAY = 24 * 3600_000;
/**
 * The free plan allows 50 subrequests (and 50 D1 queries) per invocation. Each test is one fetch
 * plus one D1 batch, so 12 tests stay well inside with room for listing and bookkeeping.
 */
const MAX_TESTS_PER_RUN = 12;
/** Slow "thinking" models get this long to answer the quick test. */
const TEST_TIMEOUT_MS = 60_000;
/** Tests run in small parallel groups so a scan finishes in about a minute. */
const TEST_CONCURRENCY = 4;
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
export async function quickTest(provider: Provider, env: Env, model: string): Promise<QuickTestResult> {
  const started = now();
  try {
    const res = await callProvider(
      provider,
      env,
      {
        model,
        messages: [{ role: 'user', content: 'أجب بكلمة واحدة باللغة العربية: ما هي عاصمة مصر؟' }],
        max_tokens: 1024,
        temperature: 0,
      },
      undefined,
      AbortSignal.timeout(TEST_TIMEOUT_MS),
    );
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

export type FailureKind = 'bad-key' | 'paid' | 'failed' | 'transient';

/** Why a quick test failed decides what happens to the model. */
export function classifyFailure(r: QuickTestResult): FailureKind | null {
  if (r.ok) return null;
  if (r.paid) return 'paid';
  if (r.error === 'empty answer') return 'failed';
  const status = Number(/^HTTP (\d{3})/.exec(r.error ?? '')?.[1] ?? 0);
  const body = r.error ?? '';
  if (status === 401) return 'bad-key';
  // 403 is also used for "this model is not available to you"; only a key complaint is the key.
  if (status === 403 && /api.?key|unauthori[sz]ed|invalid.*(key|token)|authentication/i.test(body)) return 'bad-key';
  if (status === 429 || status >= 500 || status === 0) return 'transient';
  return 'failed';
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

/** Quick-test the models waiting on this provider: candidates first, then periodic re-checks. */
async function testPending(env: Env, provider: Provider, key: string, report: ScanReport): Promise<void> {
  const at = now();
  // Candidates first, then failed models a day later, then paid ones a week later (free tiers change).
  const toTest = await env.DB.prepare(
    `SELECT * FROM models WHERE provider = ? AND paid = 0 AND (
        status = 'candidate'
        OR (status = 'failed' AND COALESCE(tested_at, 0) < ?)
        OR (status = 'paid' AND COALESCE(tested_at, 0) < ?))
     ORDER BY status = 'candidate' DESC, first_seen DESC LIMIT ?`,
  )
    .bind(provider.id, at - DAY, at - 7 * DAY, MAX_TESTS_PER_RUN)
    .all<ModelRow>();

  const tests = toTest.results;
  for (let i = 0; i < tests.length && !report.error; i += TEST_CONCURRENCY) {
    const group = tests.slice(i, i + TEST_CONCURRENCY);
    const results = await Promise.all(group.map((m) => quickTest(provider, env, m.model)));
    const stmts: D1PreparedStatement[] = [];
    const t = now();
    group.forEach((m, j) => {
      const r = results[j]!;
      const outcome = classifyFailure(r);
      if (r.ok) {
        stmts.push(env.DB.prepare(
          `UPDATE models SET status = 'active', verified_at = ?, tested_at = ?, arabic_ok = ?,
             latency_ms = ?, ok_count = ok_count + 1, last_error = NULL WHERE id = ?`,
        ).bind(t, t, r.arabic ? 1 : 0, r.latencyMs, m.id));
        if (m.status === 'candidate') {
          report.added.push(m.id);
          stmts.push(eventStmt(env, 'added', m.id, `${m.free_evidence ?? ''}${r.arabic ? '' : ' · weak Arabic'}`));
        }
      } else if (outcome === 'bad-key') {
        // The key itself was rejected: no model is at fault, so nothing is marked.
        report.error = `API key rejected (${r.error?.slice(0, 120)})`;
      } else if (outcome === 'paid' || outcome === 'failed') {
        (outcome === 'paid' ? report.paid : report.failed).push(m.id);
        stmts.push(
          env.DB.prepare(`UPDATE models SET status = ?, tested_at = ?, last_error = ? WHERE id = ?`)
            .bind(outcome, t, r.error ?? null, m.id),
          eventStmt(env, outcome, m.id, r.error ?? ''),
        );
      } else {
        // Transient (rate limit, outage, timeout): status untouched, tried again next scan.
        stmts.push(env.DB.prepare('UPDATE models SET last_error = ?, tested_at = ? WHERE id = ?').bind(r.error ?? null, t, m.id));
      }
    });
    if (stmts.length) await env.DB.batch(stmts);
  }
}

/**
 * Scan one provider: register new free models, test candidates, retire models the provider
 * dropped. New models that pass the quick test become active right away (auto-add).
 */
export async function scanProvider(
  env: Env,
  provider: Provider,
  source: 'auto' | 'manual' = 'manual',
): Promise<ScanReport> {
  const report: ScanReport = { provider: provider.id, found: 0, added: [], removed: [], failed: [], paid: [] };
  const key = provider.keyOf(env);
  if (!key) return { ...report, error: 'no API key' };

  let found;
  try {
    found = await provider.discover(key, env);
  } catch (e) {
    report.error = String(e);
    await logEvent(env, 'scan', null, `${provider.id}: ${report.error}`);
    return report;
  }
  report.found = found.length;
  const at = now();

  const existing = await env.DB.prepare('SELECT * FROM models WHERE provider = ? AND paid = 0')
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

  await testPending(env, provider, key, report);
  await logEvent(env, 'scan', null,
    `${source === 'auto' ? '[auto] ' : ''}${provider.id}: ${report.found} free, +${report.added.length} added, -${report.removed.length} removed` +
      (report.error ? ` · ${report.error}` : ''));
  return report;
}

interface ScanRound {
  startedAt: number;
  done: string[];
}

/** When the next scan happens: next hour while a round is running, else the next round start. */
export function nextScanAt(round: ScanRound | null, providers: string[], at: number): number {
  const nextHour = Math.ceil((at + 1) / 3600_000) * 3600_000;
  if (!round || providers.some((p) => !round.done.includes(p))) return nextHour;
  const due = round.startedAt + SCAN_EVERY_DAYS * DAY;
  return Math.max(nextHour, Math.ceil(due / 3600_000) * 3600_000);
}

export async function loadRound(env: Env): Promise<ScanRound | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'scan_round'`).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as ScanRound) : null;
}

/**
 * Cron, every hour. A round scans each provider once, one per hour (keeps every run under the
 * free plan's subrequest and CPU caps). A new round starts SCAN_EVERY_DAYS after the last one.
 */
export async function scheduledScan(env: Env): Promise<ScanReport | null> {
  const providers = configuredProviders(env);
  if (!providers.length) return null;
  const at = now();
  let round = await loadRound(env);
  const pending = (r: ScanRound | null) => providers.filter((p) => !r?.done.includes(p.id));

  if (!round || (pending(round).length === 0 && at - round.startedAt >= SCAN_EVERY_DAYS * DAY)) {
    round = { startedAt: at, done: [] };
  }
  const provider = pending(round)[0];
  if (!provider) {
    // Round finished: use the hour for models still waiting a test, then for the task exam.
    const retest = await retestWaiting(env, providers);
    if (retest) return retest;
    await benchSome(env, providers.map((p) => p.id));
    return null;
  }
  round.done.push(provider.id);
  await env.DB.batch([
    setSettingStmt(env, 'scan_round', JSON.stringify(round)),
    setSettingStmt(env, 'last_cron', JSON.stringify({ at, provider: provider.id })),
  ]);
  return scanProvider(env, provider, 'auto');
}

/**
 * Between rounds, each hourly wake-up tests models still waiting (new ones that hit a rate limit
 * or did not fit in the last scan), one provider at a time, so none waits days for its test.
 */
async function retestWaiting(env: Env, providers: Provider[]): Promise<ScanReport | null> {
  const ids = providers.map((p) => p.id);
  const row = await env.DB.prepare(
    `SELECT provider FROM models WHERE status = 'candidate' AND paid = 0
       AND provider IN (${ids.map(() => '?').join(',')})
     GROUP BY provider ORDER BY MIN(COALESCE(tested_at, 0)) LIMIT 1`,
  ).bind(...ids).first<{ provider: string }>();
  const provider = row && providerById(row.provider);
  if (!provider) return null;
  const report: ScanReport = { provider: provider.id, found: 0, added: [], removed: [], failed: [], paid: [] };
  await testPending(env, provider, provider.keyOf(env)!, report);
  if (report.added.length || report.failed.length || report.paid.length) {
    await logEvent(env, 'scan', null, `[auto] ${provider.id}: tested waiting models, +${report.added.length} added`);
  }
  return report;
}

export async function scanById(env: Env, providerId: string): Promise<ScanReport | null> {
  const provider = providerById(providerId);
  return provider ? scanProvider(env, provider) : null;
}
