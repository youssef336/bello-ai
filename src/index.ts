import { SCAN_EVERY_DAYS } from '../config/scan';
import {
  cleanupAuth,
  currentUser,
  googleCallback,
  googleEnabled,
  googleStart,
  login,
  logout,
  type User,
} from './auth';
import { parseAttachments } from './attachments';
import { backupPage } from './backup';
import { benchSome } from './bench';
import { chat, pickAnswer } from './chat';
import { loadRound, nextScanAt, scanById, scheduledScan } from './discovery';
import { type Env, error, json, newId, now } from './env';
import { checkKey, KEYED_PROVIDERS, keysFor, saveKey } from './keys';
import {
  allowPaidModel,
  disallowPaidModel,
  loadPaidCatalog,
  monthSpend,
  openRouterCredits,
  paidSettings,
  setSettingStmt,
} from './paid';
import { configuredProviders } from './providers';

type Handler = (
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  user: User,
  params: string[],
) => Promise<Response>;

const ANYONE = false;
const OWNER = true;

/** [method, path, owner only?, handler]. Every query that touches personal data filters by user. */
const routes: [string, RegExp, boolean, Handler][] = [
  ['GET', /^\/api\/me$/, ANYONE, async (_r, env, _c, user) => {
    const keys = await keysFor(env, user);
    return json({ ...user, providers: [...keys.keys()] });
  }],

  ['GET', /^\/api\/providers$/, ANYONE, async (_r, env, _c, user) => {
    const keys = await keysFor(env, user);
    const list = user.role === 'owner' ? configuredProviders(env) : KEYED_PROVIDERS;
    return json(list.map((p) => ({ id: p.id, label: p.label, configured: keys.has(p.id), freeBasis: p.freeBasis })));
  }],

  // --- Conversations: always the signed-in user's own ---------------------------------------

  ['GET', /^\/api\/conversations$/, ANYONE, async (_r, env, _c, user) => {
    const rows = await env.DB.prepare(
      'SELECT id, title, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 300',
    ).bind(user.id).all();
    return json(rows.results);
  }],

  ['GET', /^\/api\/conversations\/([\w-]+)$/, ANYONE, async (_r, env, _c, user, [id]) => {
    const rows = await env.DB.prepare(
      `SELECT m.id, m.role, m.content, m.attachments, m.sources, m.model_id, m.feedback, m.created_at,
              md.name AS model_name
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN models md ON md.id = m.model_id
        WHERE m.conversation_id = ? AND c.user_id = ? ORDER BY m.created_at`,
    ).bind(id, user.id).all();
    return json(rows.results);
  }],

  ['DELETE', /^\/api\/conversations\/([\w-]+)$/, ANYONE, async (_r, env, _c, user, [id]) => {
    const mine = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').bind(id, user.id).first();
    if (!mine) return error(404, 'not found');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(id),
      env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }],

  ['POST', /^\/api\/chat$/, ANYONE, async (req, env, ctx, user) => {
    const body = await req.json<{
      conversationId?: string;
      message?: string;
      model?: string;
      regenerate?: boolean;
      attachments?: unknown;
      web?: boolean;
      compare?: boolean;
    }>();
    if (body.regenerate) {
      return chat(env, ctx, user, {
        conversationId: body.conversationId, message: '', model: body.model, regenerate: true, web: body.web === true,
      });
    }
    if (typeof body.message !== 'string' || body.message.length > 100_000) return error(400, 'bad message');
    const attachments = parseAttachments(body.attachments);
    if (typeof attachments === 'string') return error(400, attachments);
    return chat(env, ctx, user, {
      conversationId: body.conversationId,
      message: body.message,
      model: body.model,
      attachments,
      web: body.web === true,
      compare: body.compare === true,
    });
  }],

  ['POST', /^\/api\/compare\/pick$/, ANYONE, async (req, env, _c, user) => {
    const id = await pickAnswer(env, user, await req.json());
    return id ? json({ messageId: id }) : error(400, 'cannot keep this answer');
  }],

  ['POST', /^\/api\/messages\/([\w-]+)\/feedback$/, ANYONE, async (req, env, _c, user, [id]) => {
    const { value } = await req.json<{ value: number }>();
    if (value !== 1 && value !== -1) return error(400, 'value must be 1 or -1');
    const msg = await env.DB.prepare(
      `SELECT m.model_id, m.feedback FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = ? AND c.user_id = ?`,
    ).bind(id, user.id).first<{ model_id: string | null; feedback: number | null }>();
    if (!msg) return error(404, 'not found');
    // Undo a previous vote before applying the new one, so voting twice cannot farm points.
    const delta = (value - (msg.feedback ?? 0)) * 2;
    await env.DB.batch([
      env.DB.prepare('UPDATE messages SET feedback = ? WHERE id = ?').bind(value, id),
      env.DB.prepare('UPDATE models SET quality = MAX(5, MIN(99, quality + ?)) WHERE id = ?').bind(delta, msg.model_id),
    ]);
    return json({ ok: true });
  }],

  // --- Models: shared registry; each person sees only what their keys can reach -------------

  ['GET', /^\/api\/models$/, ANYONE, async (_r, env, _c, user) => {
    const keys = await keysFor(env, user);
    const [rows, rests] = await Promise.all([
      env.DB.prepare(
        `SELECT * FROM models ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END, quality DESC`,
      ).all<Record<string, unknown> & { id: string; provider: string; paid: number }>(),
      env.DB.prepare('SELECT model_id, until FROM cooldowns WHERE user_id = ?').bind(user.id)
        .all<{ model_id: string; until: number }>(),
    ]);
    const rest = new Map(rests.results.map((r) => [r.model_id, r.until]));
    const visible = rows.results
      .filter((m) => (user.role === 'owner' || (keys.has(m.provider) && !m.paid)))
      .map((m) => ({ ...m, cooldown_until: rest.get(m.id) ?? 0, usable: keys.has(m.provider) }));
    return json(visible);
  }],

  ['PATCH', /^\/api\/models\/(.+)$/, OWNER, async (req, env, _c, _u, [id]) => {
    const { status } = await req.json<{ status: string }>();
    // Re-enabling sends the model back through the quick test instead of trusting it blindly.
    const next = status === 'disabled' ? 'disabled' : status === 'enabled' ? 'candidate' : null;
    if (!next) return error(400, 'status must be enabled or disabled');
    await env.DB.prepare('UPDATE models SET status = ? WHERE id = ?').bind(next, decodeURIComponent(id!)).run();
    return json({ ok: true });
  }],

  ['POST', /^\/api\/discovery\/([\w-]+)$/, OWNER, async (_r, env, _c, _u, [provider]) => {
    const report = await scanById(env, provider!);
    return report ? json(report) : error(404, 'unknown provider');
  }],

  ['POST', /^\/api\/bench$/, OWNER, async (_r, env) => {
    return json(await benchSome(env, configuredProviders(env).map((p) => p.id)));
  }],

  ['GET', /^\/api\/events$/, ANYONE, async (_r, env) => {
    const rows = await env.DB.prepare('SELECT * FROM events ORDER BY at DESC LIMIT 200').all();
    return json(rows.results);
  }],

  ['GET', /^\/api\/usage$/, ANYONE, async (_r, env, _c, user) => {
    const rows = await env.DB.prepare(
      `SELECT u.*, m.name FROM usage u LEFT JOIN models m ON m.id = u.model_id
        WHERE u.user_id = ? AND u.day >= date('now', '-6 days') ORDER BY u.day DESC, u.requests DESC`,
    ).bind(user.id).all();
    return json(rows.results);
  }],

  ['GET', /^\/api\/status$/, ANYONE, async (_r, env) => {
    const [row, round] = await Promise.all([
      env.DB.prepare(`SELECT value FROM settings WHERE key = 'last_cron'`).first<{ value: string }>(),
      loadRound(env),
    ]);
    const providers = configuredProviders(env).map((p) => p.id);
    return json({
      lastCron: row ? JSON.parse(row.value) : null,
      nextScanAt: nextScanAt(round, providers, now()),
      everyDays: SCAN_EVERY_DAYS,
    });
  }],

  // --- Memories ------------------------------------------------------------------------------

  ['GET', /^\/api\/memories$/, ANYONE, async (_r, env, _c, user) => {
    const rows = await env.DB.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY pinned DESC, created_at DESC')
      .bind(user.id).all();
    return json(rows.results);
  }],

  ['POST', /^\/api\/memories$/, ANYONE, async (req, env, _c, user) => {
    const { content, pinned } = await req.json<{ content: string; pinned?: boolean }>();
    if (typeof content !== 'string' || !content.trim() || content.length > 2000) return error(400, 'bad content');
    const id = newId();
    await env.DB.prepare('INSERT INTO memories (id, user_id, content, pinned, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(id, user.id, content.trim(), pinned ? 1 : 0, now()).run();
    return json({ id });
  }],

  ['DELETE', /^\/api\/memories\/([\w-]+)$/, ANYONE, async (_r, env, _c, user, [id]) => {
    await env.DB.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').bind(id, user.id).run();
    return json({ ok: true });
  }],

  // --- My keys -------------------------------------------------------------------------------

  ['GET', /^\/api\/keys$/, ANYONE, async (_r, env, _c, user) => {
    const rows = await env.DB.prepare('SELECT provider, key_hint, created_at FROM user_keys WHERE user_id = ?')
      .bind(user.id).all<{ provider: string; key_hint: string; created_at: number }>();
    const saved = new Map(rows.results.map((r) => [r.provider, r]));
    return json(KEYED_PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      saved: saved.has(p.id) ? { hint: saved.get(p.id)!.key_hint, at: saved.get(p.id)!.created_at } : null,
      // The owner already has the app's own keys; theirs only override.
      fromApp: user.role === 'owner' && Boolean(p.keyOf(env)),
    })));
  }],

  ['PUT', /^\/api\/keys\/([\w-]+)$/, ANYONE, async (req, env, _c, user, [id]) => {
    const provider = KEYED_PROVIDERS.find((p) => p.id === id);
    if (!provider) return error(404, 'unknown provider');
    const { key } = await req.json<{ key?: string }>();
    const clean = typeof key === 'string' ? key.trim() : '';
    if (clean.length < 16 || clean.length > 300 || /\s/.test(clean)) return error(400, 'That does not look like an API key');
    if (!(await checkKey(provider, clean))) return error(400, `${provider.label} rejected this key`);
    await saveKey(env, user, provider.id, clean);
    return json({ ok: true, hint: clean.slice(-4) });
  }],

  ['DELETE', /^\/api\/keys\/([\w-]+)$/, ANYONE, async (_r, env, _c, user, [id]) => {
    await env.DB.prepare('DELETE FROM user_keys WHERE user_id = ? AND provider = ?').bind(user.id, id).run();
    return json({ ok: true });
  }],

  // --- Members (owner) -----------------------------------------------------------------------

  ['GET', /^\/api\/members$/, OWNER, async (_r, env) => {
    const [users, invites] = await Promise.all([
      env.DB.prepare(
        `SELECT u.id, u.email, u.name, u.picture, u.role, u.created_at, u.last_seen,
           (SELECT COUNT(*) FROM user_keys k WHERE k.user_id = u.id) AS keys,
           (SELECT COALESCE(SUM(requests + fallbacks), 0) FROM usage g
              WHERE g.user_id = u.id AND g.day >= date('now', '-29 days')) AS messages_30d
         FROM users u ORDER BY u.role = 'owner' DESC, u.created_at`,
      ).all(),
      env.DB.prepare(
        `SELECT email, created_at FROM invites WHERE email NOT IN (SELECT email FROM users WHERE email IS NOT NULL)
          ORDER BY created_at DESC`,
      ).all(),
    ]);
    return json({ users: users.results, invites: invites.results, googleReady: googleEnabled(env) });
  }],

  ['POST', /^\/api\/members\/invite$/, OWNER, async (req, env) => {
    const { email } = await req.json<{ email?: string }>();
    const clean = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return error(400, 'not an email address');
    await env.DB.prepare('INSERT OR IGNORE INTO invites (email, created_at) VALUES (?, ?)').bind(clean, now()).run();
    return json({ ok: true });
  }],

  ['DELETE', /^\/api\/members\/invite\/(.+)$/, OWNER, async (_r, env, _c, _u, [email]) => {
    await env.DB.prepare('DELETE FROM invites WHERE email = ?').bind(decodeURIComponent(email!)).run();
    return json({ ok: true });
  }],

  /** Removing a member deletes everything they had: sessions, keys, chats, memories, usage. */
  ['DELETE', /^\/api\/members\/([\w-]+)$/, OWNER, async (_r, env, _c, _u, [id]) => {
    if (id === 'owner') return error(400, 'the owner cannot be removed');
    const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(id).first<{ email: string | null }>();
    if (!user) return error(404, 'not found');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)').bind(id),
      ...['conversations', 'memories', 'sessions', 'user_keys', 'cooldowns', 'usage'].map((t) =>
        env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(id)),
      env.DB.prepare('DELETE FROM invites WHERE email = ?').bind(user.email),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }],

  // --- Paid models (owner's OpenRouter credits) ----------------------------------------------

  ['GET', /^\/api\/paid$/, OWNER, async (_r, env) => {
    const [settings, spent, credits, catalog, allowed] = await Promise.all([
      paidSettings(env),
      monthSpend(env),
      openRouterCredits(env),
      loadPaidCatalog(env),
      env.DB.prepare('SELECT model FROM models WHERE paid = 1').all<{ model: string }>(),
    ]);
    return json({ settings, spent, credits, catalog, allowed: allowed.results.map((r) => r.model) });
  }],

  ['POST', /^\/api\/paid\/settings$/, OWNER, async (req, env) => {
    const { mode, capUsd } = await req.json<{ mode?: string; capUsd?: number }>();
    const stmts: D1PreparedStatement[] = [];
    if (mode === 'on' || mode === 'off') stmts.push(setSettingStmt(env, 'paid_mode', mode));
    if (typeof capUsd === 'number' && capUsd >= 0 && capUsd <= 1000) {
      stmts.push(setSettingStmt(env, 'paid_cap_usd', String(capUsd)));
    }
    if (!stmts.length) return error(400, 'nothing to change');
    await env.DB.batch(stmts);
    return json(await paidSettings(env));
  }],

  ['POST', /^\/api\/paid\/(allow|disallow)$/, OWNER, async (req, env, _c, _u, [action]) => {
    const { model } = await req.json<{ model?: string }>();
    if (typeof model !== 'string') return error(400, 'model required');
    if (action === 'disallow') {
      await disallowPaidModel(env, model);
      return json({ ok: true });
    }
    return (await allowPaidModel(env, model)) ? json({ ok: true }) : error(404, 'not in the price list');
  }],

  // --- Export: your own data (the owner also gets the shared registry) ----------------------

  ['GET', /^\/api\/export$/, ANYONE, async (_r, env, _c, user) => {
    const mine = (sql: string) => env.DB.prepare(sql).bind(user.id).all().then((r) => r.results);
    const out: Record<string, unknown> = {
      app: 'bello-ai',
      exported_at: new Date().toISOString(),
      user: { email: user.email, name: user.name },
      conversations: await mine('SELECT * FROM conversations WHERE user_id = ?'),
      messages: await mine(
        'SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ?',
      ),
      memories: await mine('SELECT * FROM memories WHERE user_id = ?'),
      usage: await mine('SELECT * FROM usage WHERE user_id = ?'),
    };
    if (user.role === 'owner') {
      for (const t of ['models', 'events', 'settings', 'users', 'invites']) {
        out[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
      }
    }
    return json(out, 200, {
      'content-disposition': `attachment; filename="bello-ai-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  }],
];

async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);

  // Same-origin check for every state change (the session cookie is also SameSite=Strict).
  if (req.method !== 'GET') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return error(403, 'cross-origin request');
  }

  // Weekly backup from the private backups repo's GitHub Action; its own token, no session.
  if (url.pathname === '/api/backup' && req.method === 'GET') return backupPage(req, env);

  if (url.pathname === '/api/auth/config' && req.method === 'GET') {
    return json({ google: googleEnabled(env) });
  }
  if (url.pathname === '/api/auth/google' && req.method === 'GET') {
    return googleEnabled(env) ? googleStart(req, env) : error(404, 'Google sign-in is not set up');
  }
  if (url.pathname === '/api/auth/google/callback' && req.method === 'GET') {
    return googleEnabled(env) ? googleCallback(req, env) : error(404, 'Google sign-in is not set up');
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const { password } = await req.json<{ password?: string }>().catch(() => ({ password: undefined }));
    if (typeof password !== 'string') return error(400, 'password required');
    const result = await login(req, env, password);
    if ('error' in result) return error(result.status, result.error);
    return json({ ok: true }, 200, { 'set-cookie': result.cookie });
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': await logout(req, env) });
  }

  const user = await currentUser(req, env);
  if (!user) return error(401, 'login required');

  for (const [method, pattern, ownerOnly, handler] of routes) {
    if (method !== req.method) continue;
    const match = pattern.exec(url.pathname);
    if (!match) continue;
    if (ownerOnly && user.role !== 'owner') return error(403, 'owner only');
    return handler(req, env, ctx, user, match.slice(1));
  }
  return error(404, 'not found');
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://*.googleusercontent.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let res: Response;
    try {
      res = new URL(req.url).pathname.startsWith('/api/')
        ? await handleApi(req, env, ctx)
        : await env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e);
      res = error(500, 'internal error');
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        await cleanupAuth(env);
        await env.DB.batch([
          env.DB.prepare('DELETE FROM events WHERE at < ?').bind(now() - 90 * 24 * 3600_000),
          env.DB.prepare('DELETE FROM cooldowns WHERE until < ?').bind(now()),
        ]);
        const report = await scheduledScan(env);
        console.log('discovery', JSON.stringify(report));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
