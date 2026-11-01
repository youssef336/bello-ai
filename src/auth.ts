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

function readCookie(request: Request, name = COOKIE): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  role: 'owner' | 'member';
}

const randomToken = (): string =>
  b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function createSession(env: Env, userId: string, extra: D1PreparedStatement[] = []): Promise<string> {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), userId, now(), now() + SESSION_MS),
    env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now(), userId),
    ...extra,
  ]);
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
}

export async function currentUser(request: Request, env: Env): Promise<User | null> {
  const token = readCookie(request);
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.picture, u.role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(await sha256(token), now()).first<User>();
}

/** Owner password login (the fallback that works before Google sign-in is set up). */
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
  return { cookie: await createSession(env, 'owner', [env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip)]) };
}

// --- Google sign-in (OpenID Connect, authorization code flow) ---------------------------------

const STATE_COOKIE = 'bello_oauth';

export const googleEnabled = (env: Env): boolean => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

const redirectUri = (request: Request): string => `${new URL(request.url).origin}/api/auth/google/callback`;

export function googleStart(request: Request, env: Env): Response {
  const state = randomToken();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(request),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      // Lax, not Strict: it has to come back on Google's cross-site redirect to the callback.
      'set-cookie': `${STATE_COOKIE}=${state}; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

const backHome = (error?: string, cookie?: string): Response => {
  const headers = new Headers({ location: error ? `/?login_error=${encodeURIComponent(error)}` : '/' });
  headers.append('set-cookie', `${STATE_COOKIE}=; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  if (cookie) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
};

interface IdToken {
  iss: string;
  aud: string;
  exp: number;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/** Payload of a JWT. Signature is not checked: the token came straight from Google's token endpoint over TLS (OIDC Core 3.1.3.7). */
export function jwtPayload<T>(jwt: string): T {
  const part = jwt.split('.')[1] ?? '';
  const text = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(text, (c) => c.charCodeAt(0)))) as T;
}

export async function googleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!code || !state || state !== readCookie(request, STATE_COOKIE)) return backHome('expired');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(request),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) return backHome('google');
  const { id_token: idToken } = await res.json<{ id_token?: string }>();
  if (!idToken) return backHome('google');
  const claims = jwtPayload<IdToken>(idToken);
  const validIssuer = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!validIssuer || claims.aud !== env.GOOGLE_CLIENT_ID || claims.exp * 1000 < now()) return backHome('google');
  if (!claims.email || !claims.email_verified) return backHome('email');

  const email = claims.email.toLowerCase();
  const isOwner = email === env.OWNER_EMAIL?.toLowerCase();
  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  let userId = existing?.id;
  if (!userId) {
    if (isOwner) {
      userId = 'owner';
    } else {
      const invited = await env.DB.prepare('SELECT 1 FROM invites WHERE email = ?').bind(email).first();
      if (!invited) return backHome('not_invited');
      userId = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO users (id, email, role, created_at) VALUES (?, ?, ?, ?)')
        .bind(userId, email, 'member', now()).run();
    }
  }
  const profile = env.DB.prepare('UPDATE users SET email = ?, name = ?, picture = ? WHERE id = ?')
    .bind(email, claims.name ?? null, claims.picture ?? null, userId);
  return backHome(undefined, await createSession(env, userId, [profile]));
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
