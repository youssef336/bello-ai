import { describe, expect, it } from 'vitest';
import type { User } from '../src/auth';
import type { Env } from '../src/env';
import { DAILY_LIMITS } from '../config/limits';
import { toApiMessages } from '../src/attachments';
import { cleanPrompt, makeImage, modelsFor, parseImageRequest, sizeFor } from '../src/images';
import { effectiveLimit, nextReset } from '../src/limits';
import { parseDuration, rateLimitFromHeaders, rateLimitHeaders } from '../src/remaining';
import { wavSeconds } from '../src/transcribe';
// The browser half of the video page: same WAV the server checks.
// @ts-expect-error plain browser module without types
import { plan, shortLines, wav } from '../public/video.js';

const pic = 'data:image/jpeg;base64,/9j/AAAA';
const KLEIN_4B = '@cf/black-forest-labs/flux-2-klein-4b';
const KLEIN_9B = '@cf/black-forest-labs/flux-2-klein-9b';

/** A database that accepts everything and remembers its statements, and a scripted Workers AI. */
function fakeEnv(answers: Record<string, (string | null)[]>) {
  const statements: { sql: string; args: unknown[] }[] = [];
  const called: string[] = [];
  const DB = {
    prepare: (sql: string) => {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          statement.args = args;
          statements.push({ sql, args });
          return statement;
        },
        run: async () => ({ meta: { changes: 1 } }),
        first: async () => null,
        all: async () => ({ results: [] }),
      };
      return statement;
    },
    batch: async () => [],
  };
  const AI = {
    run: async (model: string) => {
      called.push(model);
      const next = answers[model]?.shift();
      if (next === undefined || next === null) throw new Error('3043: Internal server error');
      return { image: next };
    },
  };
  return { env: { DB, AI } as unknown as Env, statements, called };
}

const owner = { id: 'owner', role: 'owner' } as User;
const member = { id: 'm1', role: 'member' } as User;
const editOnce = (env: Env, user: User) => makeImage(env, user, { prompt: 'make it night', images: [pic], aspect: 1 });
const usedStrong = (statements: { sql: string }[]) => statements.filter((s) => s.sql.includes("'best_edits', 1")).length;
const gaveBackStrong = (statements: { args: unknown[] }[]) => statements.filter((s) => s.args.includes('best_edits')).length;

describe('daily limits', () => {
  it('resets at the next 00:00 UTC', () => {
    expect(nextReset(Date.UTC(2026, 10, 1, 21, 30))).toBe(Date.UTC(2026, 10, 2));
    expect(nextReset(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1));
  });
  it('uses the default unless the owner set one; -1 means no limit', () => {
    expect(effectiveLimit('member', null, 'images')).toBe(DAILY_LIMITS.member.images);
    expect(effectiveLimit('member', 12, 'images')).toBe(12);
    expect(effectiveLimit('member', 0, 'messages')).toBe(0);
    expect(effectiveLimit('member', -1, 'messages')).toBeNull();
    expect(effectiveLimit('owner', null, 'messages')).toBe(DAILY_LIMITS.owner.messages);
  });
});

describe('what is left on a model', () => {
  it('reads the durations Groq sends', () => {
    expect(parseDuration('2m59.56s')).toBe(179_560);
    expect(parseDuration('7.66s')).toBe(7_660);
    expect(parseDuration('1h2m')).toBe(3_720_000);
    expect(parseDuration('250ms')).toBe(250);
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });
  it('reads the daily allowance from the response', () => {
    const headers = new Headers({
      'x-ratelimit-limit-requests': '1000',
      'x-ratelimit-remaining-requests': '984',
      'x-ratelimit-reset-requests': '2m',
    });
    expect(rateLimitFromHeaders(headers, 1_000)).toEqual({ left: 984, limit: 1000, resetAt: 121_000 });
  });
  it('treats zero left as a number and missing headers as unknown', () => {
    expect(rateLimitFromHeaders(new Headers({ 'x-ratelimit-remaining-requests': '0' }), 0)).toEqual({ left: 0, limit: null, resetAt: null });
    expect(rateLimitFromHeaders(new Headers(), 0)).toBeNull();
    expect(rateLimitFromHeaders(new Headers({ 'x-ratelimit-remaining-requests': '' }), 0)).toBeNull();
  });
  it('carries only the limit headers over to a rebuilt response', () => {
    const headers = new Headers({ 'x-ratelimit-remaining-requests': '5', 'content-encoding': 'gzip' });
    expect(rateLimitHeaders(headers)).toEqual({ 'x-ratelimit-remaining-requests': '5' });
  });
});

describe('which picture model runs', () => {
  it('tries the strong model first only when an edit has a slot today', () => {
    expect(modelsFor(true, true)).toEqual([KLEIN_9B, KLEIN_9B, KLEIN_4B]);
    expect(modelsFor(true, false)).toEqual([KLEIN_4B]);
  });
  it('never sends an edit to the model that cannot see pictures', () => {
    expect(modelsFor(true, true).some((m) => m.includes('schnell'))).toBe(false);
    expect(modelsFor(false, false).at(-1)).toContain('schnell');
  });
});

describe('an edit from start to finish', () => {
  it('runs the owner on the strong model and keeps the slot spent', async () => {
    const { env, statements, called } = fakeEnv({ [KLEIN_9B]: ['/9j/NINE'] });
    const out = await (await editOnce(env, owner)).json<{ message: { model_name: string } }>();
    expect(out.message.model_name).toBe('FLUX.2 klein 9B');
    expect(called).toEqual([KLEIN_9B]);
    expect([usedStrong(statements), gaveBackStrong(statements)]).toEqual([1, 0]);
  });
  it('tries the strong model again after its quick failure', async () => {
    const { env, statements, called } = fakeEnv({ [KLEIN_9B]: [null, '/9j/NINE'] });
    const out = await (await editOnce(env, owner)).json<{ message: { model_name: string } }>();
    expect(out.message.model_name).toBe('FLUX.2 klein 9B');
    expect(called).toEqual([KLEIN_9B, KLEIN_9B]);
    expect(gaveBackStrong(statements)).toBe(0);
  });
  it('falls back to the ordinary model and gives the slot back', async () => {
    const { env, statements, called } = fakeEnv({ [KLEIN_9B]: [null, null], [KLEIN_4B]: ['/9j/FOUR'] });
    const out = await (await editOnce(env, owner)).json<{ message: { model_name: string } }>();
    expect(out.message.model_name).toBe('FLUX.2 klein');
    expect(called).toEqual([KLEIN_9B, KLEIN_9B, KLEIN_4B]);
    expect(gaveBackStrong(statements)).toBe(1);
  });
  it('never spends the strong model on a member', async () => {
    const { env, statements, called } = fakeEnv({ [KLEIN_4B]: ['/9j/FOUR'] });
    await editOnce(env, member);
    expect(called).toEqual([KLEIN_4B]);
    expect(usedStrong(statements)).toBe(0);
  });
});

describe('image requests', () => {
  it('needs a prompt and at most 4 pictures', () => {
    expect(typeof parseImageRequest({ prompt: '' })).toBe('string');
    expect(typeof parseImageRequest({ prompt: 'x', images: [pic, pic, pic, pic, pic] })).toBe('string');
    expect(typeof parseImageRequest({ prompt: 'x', images: ['https://evil.example/a.jpg'] })).toBe('string');
    const ok = parseImageRequest({ prompt: 'a cat', images: [pic], aspect: 9 });
    expect(typeof ok !== 'string' && ok.aspect).toBe(2);
  });
  it('keeps the long side at 1024 in multiples of 16', () => {
    expect(sizeFor(1)).toEqual({ width: 1024, height: 1024 });
    expect(sizeFor(9 / 16)).toEqual({ width: 576, height: 1024 });
    expect(sizeFor(16 / 9)).toEqual({ width: 1024, height: 576 });
    const odd = sizeFor(0.7);
    expect(odd.width % 16).toBe(0);
  });
  it('cleans the rewritten English prompt', () => {
    expect(cleanPrompt('<think>hmm</think>Prompt: "A cat at sunset"')).toBe('A cat at sunset');
    expect(cleanPrompt('')).toBeNull();
  });
  it('never sends a drawn picture back to a model as an image', () => {
    const out = toApiMessages([
      { role: 'user', content: 'draw a cat' },
      { role: 'assistant', content: 'here', attachments: [{ type: 'image', name: 'bello.jpg', data: pic }] },
    ], true);
    expect(out[1]!.content).toBe('here\n[picture: bello.jpg]');
  });
});

describe('video', () => {
  it('measures the sound the browser sends', () => {
    const pcm = new Uint8Array(16_000 * 2 * 30);
    const file = wav(pcm) as Uint8Array;
    const b64 = Buffer.from(file).toString('base64');
    expect(wavSeconds(b64)).toBe(30);
  });
  it('refuses anything that is not 16 kHz mono PCM', () => {
    const file = wav(new Uint8Array(32_000)) as Uint8Array;
    new DataView(file.buffer).setUint32(24, 44_100, true);
    expect(wavSeconds(Buffer.from(file).toString('base64'))).toBeNull();
    expect(wavSeconds('not audio')).toBeNull();
  });
  it('crops to the frame from the centre and scales the short side', () => {
    expect(plan(1920, 1080, '9:16', '480')).toEqual({ crop: { left: 656, top: 0, width: 608, height: 1080 }, width: 480, height: 852 });
    // Never scaled up: a 608-wide crop stays 608 when 720p is asked for.
    expect(plan(1920, 1080, '9:16', '720').width).toBe(608);
    expect(plan(1080, 1920, 'original', 'original')).toEqual({ crop: null, width: 1080, height: 1920 });
    expect(plan(1080, 1920, '1:1', '480')).toEqual({ crop: { left: 0, top: 420, width: 1080, height: 1080 }, width: 480, height: 480 });
  });
  it('splits a long subtitle into short lines that share its time', () => {
    const lines = shortLines([{ start: 0, end: 10, text: 'one two three four five six seven eight nine ten' }]);
    expect(lines.map((l: { text: string }) => l.text)).toEqual(['one two three four five', 'six seven eight nine ten']);
    expect(lines[0].start).toBe(0);
    expect(lines[1].end).toBeCloseTo(10);
    expect(lines[0].end).toBe(lines[1].start);
  });
});
