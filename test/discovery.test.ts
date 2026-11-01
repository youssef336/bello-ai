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
