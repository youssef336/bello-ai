import { type Env, now } from './env';

const COOKIE = 'bello_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IP = 5;
const MAX_GLOBAL = 30;

const enc = new TextEncoder();

const b64 = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));

const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Format: pbkdf2$sha256$<iterations>$<salt b64>$<hash b64>. Workers caps PBKDF2 at 100k. */
export async function hashPassword(password: string, iterations = 100_000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, digest, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2' || digest !== 'sha256' || !iter || !salt || !hash) return false;
  const actual = await pbkdf2(password, unb64(salt), Number(iter));
  const expected = unb64(hash);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

async function sha256(text: string): Promise<string> {
  return b64(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

function readCookie(request: Request): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

export async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  const token = readCookie(request);
  if (!token) return false;
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?')
    .bind(await sha256(token))
    .first<{ expires_at: number }>();
  return row !== null && row.expires_at > now();
}

/** Returns a Set-Cookie header on success, or an error message. */
export async function login(
  request: Request,
  env: Env,
  password: string,
): Promise<{ cookie: string } | { error: string; status: number }> {
  if (!env.OWNER_PASSWORD_HASH) return { error: 'OWNER_PASSWORD_HASH is not set', status: 500 };
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const since = now() - WINDOW_MS;
  const counts = await env.DB.prepare(
    `SELECT SUM(CASE WHEN ip = ? THEN 1 ELSE 0 END) AS mine, COUNT(*) AS total
       FROM login_attempts WHERE at > ?`,
  )
    .bind(ip, since)
    .first<{ mine: number | null; total: number }>();
  if ((counts?.mine ?? 0) >= MAX_PER_IP || (counts?.total ?? 0) >= MAX_GLOBAL) {
    return { error: 'Too many attempts. Try again in 15 minutes.', status: 429 };
  }

  if (!(await verifyPassword(password, env.OWNER_PASSWORD_HASH))) {
    await env.DB.prepare('INSERT INTO login_attempts (ip, at) VALUES (?, ?)').bind(ip, now()).run();
    return { error: 'Wrong password', status: 401 };
  }

  const token = b64(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').bind(
      await sha256(token),
      now(),
      now() + SESSION_MS,
    ),
    env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip),
  ]);
  return {
    cookie: `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`,
  };
}

export async function logout(request: Request, env: Env): Promise<string> {
  const token = readCookie(request);
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  }
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function cleanupAuth(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()),
    env.DB.prepare('DELETE FROM login_attempts WHERE at < ?').bind(now() - WINDOW_MS),
  ]);
}
