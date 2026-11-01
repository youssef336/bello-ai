import type { User } from './auth';
import { type Env, now } from './env';
import { PROVIDERS, type Provider } from './providers';

/**
 * Each person's provider keys, encrypted at rest with AES-256-GCM. The key's owner and provider
 * are bound in as associated data, so a stored key cannot be moved to another user or provider.
 * The owner falls back to the Worker secrets; members only ever use their own keys, so a friend
 * never spends the owner's daily limits.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function aesKey(env: Env): Promise<CryptoKey> {
  if (!env.KEYS_ENCRYPTION_KEY) throw new Error('KEYS_ENCRYPTION_KEY is not set');
  return crypto.subtle.importKey('raw', unb64(env.KEYS_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(env: Env, userId: string, provider: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(`${userId}:${provider}`) },
    await aesKey(env),
    enc.encode(plain),
  );
  const out = new Uint8Array(iv.length + data.byteLength);
  out.set(iv);
  out.set(new Uint8Array(data), iv.length);
  return b64(out);
}

export async function decryptSecret(env: Env, userId: string, provider: string, stored: string): Promise<string> {
  const raw = unb64(stored);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(`${userId}:${provider}`) },
    await aesKey(env),
    raw.slice(12),
  );
  return dec.decode(plain);
}

/**
 * Providers a person may bring a key for. Workers AI runs on the owner's Cloudflare account;
 * Cerebras only gives trial credits now (see README), so it is not offered.
 */
export const KEYED_PROVIDERS = PROVIDERS.filter((p) => p.id !== 'workers-ai' && p.id !== 'cerebras');

/** provider id → API key, for every provider this user can call right now. */
export async function keysFor(env: Env, user: User): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (user.role === 'owner') {
    for (const p of PROVIDERS) {
      const key = p.keyOf(env);
      if (key) out.set(p.id, key);
    }
  }
  const rows = await env.DB.prepare('SELECT provider, key_enc FROM user_keys WHERE user_id = ?')
    .bind(user.id).all<{ provider: string; key_enc: string }>();
  for (const r of rows.results) {
    try {
      out.set(r.provider, await decryptSecret(env, user.id, r.provider, r.key_enc));
    } catch {
      // Unreadable (encryption key rotated): treat as missing; the keys page shows it to re-add.
    }
  }
  return out;
}

/** Cheap check that a key works: list the provider's models with it. */
export async function checkKey(provider: Provider, key: string): Promise<boolean> {
  if (!provider.baseUrl) return false;
  const res = await fetch(`${provider.baseUrl}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (provider.id !== 'openrouter') return res.ok;
  // OpenRouter lists models without a key; /key only answers for a valid one.
  const who = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` } });
  return who.ok;
}

export async function saveKey(env: Env, user: User, provider: string, key: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_keys (user_id, provider, key_enc, key_hint, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET key_enc = excluded.key_enc, key_hint = excluded.key_hint,
       created_at = excluded.created_at`,
  ).bind(user.id, provider, await encryptSecret(env, user.id, provider, key), key.slice(-4), now()).run();
  // A fresh key starts without the old key's rests.
  await env.DB.prepare(`DELETE FROM cooldowns WHERE user_id = ? AND model_id LIKE ?`).bind(user.id, `${provider}:%`).run();
}
