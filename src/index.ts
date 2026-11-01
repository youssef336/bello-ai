import { cleanupAuth, isAuthenticated, login, logout } from './auth';
import { chat } from './chat';
import { scanById, scheduledScan } from './discovery';
import { type Env, error, json, newId, now } from './env';
import { configuredProviders, PROVIDERS } from './providers';

type Handler = (req: Request, env: Env, ctx: ExecutionContext, params: string[]) => Promise<Response>;

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/me$/, async () => json({ ok: true })],

  ['GET', /^\/api\/providers$/, async (_r, env) => {
    const on = new Set(configuredProviders(env).map((p) => p.id));
    return json(PROVIDERS.map((p) => ({ id: p.id, label: p.label, configured: on.has(p.id), freeBasis: p.freeBasis })));
  }],

  ['GET', /^\/api\/conversations$/, async (_r, env) => {
    const rows = await env.DB.prepare(
      'SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 200',
    ).all();
    return json(rows.results);
  }],

  ['GET', /^\/api\/conversations\/([\w-]+)$/, async (_r, env, _c, [id]) => {
    const rows = await env.DB.prepare(
      `SELECT m.id, m.role, m.content, m.model_id, m.feedback, m.created_at, md.name AS model_name
         FROM messages m LEFT JOIN models md ON md.id = m.model_id
        WHERE m.conversation_id = ? ORDER BY m.created_at`,
    ).bind(id).all();
    return json(rows.results);
  }],

  ['DELETE', /^\/api\/conversations\/([\w-]+)$/, async (_r, env, _c, [id]) => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM messages WHERE conversation_id = ?').bind(id),
      env.DB.prepare('DELETE FROM conversations WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }],

  ['POST', /^\/api\/chat$/, async (req, env, ctx) => {
    const body = await req.json<{ conversationId?: string; message?: string; model?: string }>();
    if (typeof body.message !== 'string' || body.message.length > 100_000) return error(400, 'bad message');
    return chat(env, ctx, { conversationId: body.conversationId, message: body.message, model: body.model });
  }],

  ['POST', /^\/api\/messages\/([\w-]+)\/feedback$/, async (req, env, _c, [id]) => {
    const { value } = await req.json<{ value: number }>();
    if (value !== 1 && value !== -1) return error(400, 'value must be 1 or -1');
    const msg = await env.DB.prepare('SELECT model_id, feedback FROM messages WHERE id = ?')
      .bind(id).first<{ model_id: string | null; feedback: number | null }>();
    if (!msg) return error(404, 'not found');
    // Undo a previous vote before applying the new one, so voting twice cannot farm points.
    const delta = (value - (msg.feedback ?? 0)) * 2;
    await env.DB.batch([
      env.DB.prepare('UPDATE messages SET feedback = ? WHERE id = ?').bind(value, id),
      env.DB.prepare('UPDATE models SET quality = MAX(5, MIN(99, quality + ?)) WHERE id = ?').bind(delta, msg.model_id),
    ]);
    return json({ ok: true });
  }],

  ['GET', /^\/api\/models$/, async (_r, env) => {
    const rows = await env.DB.prepare(
      `SELECT * FROM models ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
         quality DESC`,
    ).all();
    return json(rows.results);
  }],

  ['PATCH', /^\/api\/models\/(.+)$/, async (req, env, _c, [id]) => {
    const { status } = await req.json<{ status: string }>();
    // Re-enabling sends the model back through the quick test instead of trusting it blindly.
    const next = status === 'disabled' ? 'disabled' : status === 'enabled' ? 'candidate' : null;
    if (!next) return error(400, 'status must be enabled or disabled');
    await env.DB.prepare('UPDATE models SET status = ?, cooldown_until = 0 WHERE id = ?')
      .bind(next, decodeURIComponent(id!)).run();
    return json({ ok: true });
  }],

  ['POST', /^\/api\/discovery\/([\w-]+)$/, async (_r, env, _c, [provider]) => {
    const report = await scanById(env, provider!);
    return report ? json(report) : error(404, 'unknown provider');
  }],

  ['GET', /^\/api\/events$/, async (_r, env) => {
    const rows = await env.DB.prepare('SELECT * FROM events ORDER BY at DESC LIMIT 200').all();
    return json(rows.results);
  }],

  ['GET', /^\/api\/usage$/, async (_r, env) => {
    const rows = await env.DB.prepare(
      `SELECT u.*, m.name FROM usage u LEFT JOIN models m ON m.id = u.model_id
        WHERE u.day >= date('now', '-6 days') ORDER BY u.day DESC, u.requests DESC`,
    ).all();
    return json(rows.results);
  }],

  ['GET', /^\/api\/memories$/, async (_r, env) => {
    const rows = await env.DB.prepare('SELECT * FROM memories ORDER BY pinned DESC, created_at DESC').all();
    return json(rows.results);
  }],

  ['POST', /^\/api\/memories$/, async (req, env) => {
    const { content, pinned } = await req.json<{ content: string; pinned?: boolean }>();
    if (typeof content !== 'string' || !content.trim() || content.length > 2000) return error(400, 'bad content');
    const id = newId();
    await env.DB.prepare('INSERT INTO memories (id, content, pinned, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, content.trim(), pinned ? 1 : 0, now()).run();
    return json({ id });
  }],

  ['DELETE', /^\/api\/memories\/([\w-]+)$/, async (_r, env, _c, [id]) => {
    await env.DB.prepare('DELETE FROM memories WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }],

  ['GET', /^\/api\/export$/, async (_r, env) => {
    const tables = ['conversations', 'messages', 'memories', 'models', 'usage', 'events', 'settings'];
    const out: Record<string, unknown[]> = {};
    for (const t of tables) out[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
    return json({ app: 'bello-ai', exported_at: new Date().toISOString(), ...out }, 200, {
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

  if (!(await isAuthenticated(req, env))) return error(401, 'login required');

  for (const [method, pattern, handler] of routes) {
    if (method !== req.method) continue;
    const match = pattern.exec(url.pathname);
    if (match) return handler(req, env, ctx, match.slice(1));
  }
  return error(404, 'not found');
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
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
        await env.DB.prepare('DELETE FROM events WHERE at < ?').bind(now() - 90 * 24 * 3600_000).run();
        const report = await scheduledScan(env);
        console.log('discovery', JSON.stringify(report));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
