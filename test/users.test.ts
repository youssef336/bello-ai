import { describe, expect, it } from 'vitest';
import { jwtPayload } from '../src/auth';
import type { Env } from '../src/env';
import { decryptSecret, encryptSecret } from '../src/keys';

const env = { KEYS_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) } as Env;

describe('stored API keys', () => {
  it('round-trips', async () => {
    const box = await encryptSecret(env, 'u1', 'groq', 'gsk_secret_value_1234');
    expect(box).not.toContain('secret');
    expect(await decryptSecret(env, 'u1', 'groq', box)).toBe('gsk_secret_value_1234');
  });

  it('cannot be moved to another user or provider', async () => {
    const box = await encryptSecret(env, 'u1', 'groq', 'gsk_secret_value_1234');
    await expect(decryptSecret(env, 'u2', 'groq', box)).rejects.toThrow();
    await expect(decryptSecret(env, 'u1', 'gemini', box)).rejects.toThrow();
  });

  it('every encryption is different (random IV)', async () => {
    const a = await encryptSecret(env, 'u1', 'groq', 'same');
    const b = await encryptSecret(env, 'u1', 'groq', 'same');
    expect(a).not.toBe(b);
  });
});

describe('jwtPayload', () => {
  it('reads base64url claims, including non-ASCII names', () => {
    const json = JSON.stringify({ email: 'a@b.com', name: 'يوسف' });
    const payload = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(jwtPayload<{ email: string; name: string }>(`x.${payload}.y`)).toEqual({ email: 'a@b.com', name: 'يوسف' });
  });
});
