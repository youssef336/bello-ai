import { describe, expect, it } from 'vitest';
import { classifyTask, detectLanguage } from '../src/lang';
import { cooldownMs, type ModelRow, rankModels } from '../src/router';

const base: ModelRow = {
  id: 'p:m', provider: 'p', model: 'm', name: 'm', status: 'active', free_evidence: null,
  verified_at: null, tested_at: null, context_length: 32_000, supports_tools: 0, supports_vision: 0,
  arabic_ok: 1, quality: 50, latency_ms: 500, ok_count: 0, fail_count: 0, cooldown_until: 0,
  cooldown_strikes: 0, last_error: null, first_seen: 0, last_seen: 0, paid: 0, price_in: null, price_out: null,
};
const model = (over: Partial<ModelRow>): ModelRow => ({ ...base, ...over });
const req = { language: 'en' as const, task: 'general' as const, tokens: 1000, providerBonus: new Map<string, number>(), at: 1000 };

describe('detectLanguage', () => {
  it('Egyptian Arabic', () => expect(detectLanguage('عايز اعرف ازاي اعمل ده')).toBe('ar'));
  it('Arabic with code terms', () => expect(detectLanguage('ازاي اعمل provider في riverpod')).toBe('ar'));
  it('English', () => expect(detectLanguage('How do I deploy this?')).toBe('en'));
});

describe('classifyTask', () => {
  it('code', () => expect(classifyTask('fix this bug ```dart\nvoid main(){}```')).toBe('code'));
  it('Arabic code', () => expect(classifyTask('عندي ايرور في الكود')).toBe('code'));
  it('reasoning', () => expect(classifyTask('قارن بين الاتنين')).toBe('reasoning'));
  it('general', () => expect(classifyTask('اكتب رسالة عيد ميلاد')).toBe('general'));
});

describe('rankModels', () => {
  it('skips models on cooldown, inactive, or with a too-small window', () => {
    const out = rankModels([
      model({ id: 'a', cooldown_until: 5000 }),
      model({ id: 'b', status: 'failed' }),
      model({ id: 'c', context_length: 1500 }),
      model({ id: 'd' }),
    ], req, 4);
    expect(out.map((m) => m.id)).toEqual(['d']);
  });

  it('never sends Arabic to a model that failed the Arabic test', () => {
    const out = rankModels([model({ id: 'weak', arabic_ok: 0, quality: 95 }), model({ id: 'ok' })],
      { ...req, language: 'ar' }, 4);
    expect(out.map((m) => m.id)).toEqual(['ok']);
  });

  it('prefers reliable models and caps two per provider', () => {
    const out = rankModels([
      model({ id: 'flaky', ok_count: 1, fail_count: 9 }),
      model({ id: 'solid', ok_count: 9, fail_count: 1 }),
      model({ id: 'third' }),
      model({ id: 'other', provider: 'q' }),
    ], req, 4);
    expect(out[0]!.id).toBe('solid');
    expect(out.filter((m) => m.provider === 'p')).toHaveLength(2);
    expect(out.map((m) => m.id)).toContain('other');
  });
});

describe('cooldownMs', () => {
  it('honours Retry-After', () => expect(cooldownMs(0, 30, false)).toBe(30_000));
  it('backs off exponentially', () => expect(cooldownMs(3, null, false)).toBe(480_000));
  it('daily limits rest for 6 hours', () => expect(cooldownMs(0, null, true)).toBe(6 * 3600_000));
});
