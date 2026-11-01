import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth';
import { trimHistory } from '../src/chat';
import { guessQuality, isOpenRouterFree } from '../src/providers';

describe('isOpenRouterFree', () => {
  const free = {
    id: 'x/y:free', name: 'y',
    pricing: { prompt: '0', completion: '0', request: '0' },
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  };
  it('all prices zero → free', () => expect(isOpenRouterFree(free)).toBe(true));
  it('any non-zero price → not free', () =>
    expect(isOpenRouterFree({ ...free, pricing: { prompt: '0', completion: '0.000001' } })).toBe(false));
  it('no pricing → not free (no evidence)', () => expect(isOpenRouterFree({ ...free, pricing: {} })).toBe(false));
  it('audio output → not a chat model', () =>
    expect(isOpenRouterFree({ ...free, architecture: { output_modalities: ['audio'] } })).toBe(false));
});

describe('guessQuality', () => {
  it('big beats small', () => expect(guessQuality('llama-3.3-70b')).toBeGreaterThan(guessQuality('llama-3.1-8b-instant')));
  it('stays in range', () => {
    expect(guessQuality('tiny-1b-mini')).toBeGreaterThanOrEqual(10);
    expect(guessQuality('ultra-550b-pro-max')).toBeLessThanOrEqual(95);
  });
});

describe('password hashing', () => {
  it('round-trips and rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery', 1000);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('trimHistory', () => {
  it('keeps the newest turns within budget, oldest first', () => {
    const turns = ['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)].map((content) => ({ role: 'user' as const, content }));
    expect(trimHistory(turns, 120).map((t) => t.content[0])).toEqual(['b', 'c']);
  });
  it('always keeps the latest turn even if it is huge', () => {
    expect(trimHistory([{ role: 'user', content: 'x'.repeat(500) }], 100)).toHaveLength(1);
  });
});
