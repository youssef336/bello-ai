import { type Env, error, json } from './env';

/**
 * Read-only paging over the database for the weekly backup (GitHub Action in the private
 * bello-ai-backups repo, which encrypts what it gets before committing it).
 *
 *   GET /api/backup                     → { schema: [CREATE …], tables: [names] }
 *   GET /api/backup?table=t&after=rowid → { rows: [...], next: rowid | null }
 *
 * Bearer BACKUP_TOKEN, compared in constant time. Sessions, login attempts and rests are left
 * out: they are short-lived, and a session row is as good as a login.
 */

const SKIP = new Set(['sessions', 'login_attempts', 'cooldowns', 'd1_migrations']);
const PAGE = 100;

async function tokenOk(req: Request, env: Env): Promise<boolean> {
  if (!env.BACKUP_TOKEN) return false;
  const given = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(env.BACKUP_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function backupPage(req: Request, env: Env): Promise<Response> {
  if (!(await tokenOk(req, env))) return error(401, 'bad backup token');
  const all = await env.DB.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type DESC, name`,
  ).all<{ name: string; sql: string }>();
  const tables = all.results.filter((t) => t.sql.startsWith('CREATE TABLE') && !SKIP.has(t.name)).map((t) => t.name);

  const url = new URL(req.url);
  const table = url.searchParams.get('table');
  if (!table) {
    return json({ app: 'bello-ai', at: new Date().toISOString(), schema: all.results.map((t) => t.sql), tables });
  }
  // The name goes into SQL, so it must be one of the tables just listed.
  if (!tables.includes(table)) return error(404, 'unknown table');
  const after = Number(url.searchParams.get('after') ?? 0) || 0;
  const rows = await env.DB.prepare(`SELECT rowid AS _rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`)
    .bind(after, PAGE).all<{ _rowid: number }>();
  const last = rows.results.at(-1);
  return json({ rows: rows.results, next: rows.results.length === PAGE && last ? last._rowid : null });
}
