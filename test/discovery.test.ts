import { describe, expect, it } from 'vitest';
import { classifyFailure, type QuickTestResult } from '../src/discovery';

const fail = (error: string, paid = false): QuickTestResult => ({ ok: false, paid, arabic: false, latencyMs: 1, error });

describe('classifyFailure', () => {
  it('401 is the key', () => expect(classifyFailure(fail('HTTP 401: bad'))).toBe('bad-key'));
  it('403 about the key is the key', () =>
    expect(classifyFailure(fail('HTTP 403: {"error":"Invalid API key"}'))).toBe('bad-key'));
  it('403 about the model only fails that model', () =>
    expect(classifyFailure(fail('HTTP 403: model is only available on agentic harnesses'))).toBe('failed'));
  it('rate limits, outages and timeouts are retried later', () => {
    expect(classifyFailure(fail('HTTP 429: slow down'))).toBe('transient');
    expect(classifyFailure(fail('HTTP 503: no upstreams available'))).toBe('transient');
    expect(classifyFailure(fail('TimeoutError: The operation was aborted'))).toBe('transient');
  });
  it('gone models fail', () => expect(classifyFailure(fail('HTTP 404: no longer available'))).toBe('failed'));
  it('empty answers fail', () => expect(classifyFailure(fail('empty answer'))).toBe('failed'));
  it('paid wins', () => expect(classifyFailure(fail('HTTP 429: limit: 0', true))).toBe('paid'));
});

import { nextScanAt } from '../src/discovery';
import { SCAN_EVERY_DAYS } from '../config/scan';

describe('nextScanAt', () => {
  const H = 3600_000;
  it('next hour when no round has run', () => expect(nextScanAt(null, ['a'], 10 * H + 5)).toBe(11 * H));
  it('next hour while a round is still going', () =>
    expect(nextScanAt({ startedAt: 0, done: ['a'] }, ['a', 'b'], 2 * H)).toBe(3 * H));
  it('waits the configured days after a finished round', () =>
    expect(nextScanAt({ startedAt: 0, done: ['a', 'b'] }, ['a', 'b'], 3 * H)).toBe(SCAN_EVERY_DAYS * 24 * H));
});

import { CASES, finalText } from '../src/bench';

describe('task exam', () => {
  const check = (prompt: RegExp, answer: string) => CASES.find((c) => prompt.test(c.prompt))!.pass(answer);
  it('grades code', () => {
    expect(check(/is_palindrome/, 'def is_palindrome(s):\n    s = s.lower()\n    return s == s[::-1]')).toBe(true);
    expect(check(/is_palindrome/, 'I cannot help with that')).toBe(false);
    expect(check(/map/, '[4, 6]')).toBe(true);
  });
  it('grades reasoning and ignores <think>', () => {
    expect(check(/bat and a ball/, finalText('<think>10 minus 5…</think>5'))).toBe(true);
    expect(check(/bat and a ball/, '10')).toBe(false);
    expect(check(/17 × 24/, '408')).toBe(true);
    expect(check(/strawberry/, '3')).toBe(true);
    expect(check(/strawberry/, '2')).toBe(false);
    expect(check(/What does this Python print/, '2')).toBe(true);
    expect(check(/What does this Python print/, '3')).toBe(false);
  });
  it('grades Egyptian Arabic and MSA', () => {
    expect(check(/بالعامية المصرية/, 'ولا حاجة، قاعد بذاكر شوية دلوقتي')).toBe(true);
    expect(check(/بالعامية المصرية/, 'I am working now')).toBe(false);
    expect(check(/الفصحى/, 'الطقس جميل اليوم.')).toBe(true);
    expect(check(/أطباء/, 'طبيب')).toBe(true);
  });
});
