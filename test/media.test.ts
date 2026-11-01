import { describe, expect, it } from 'vitest';
import { DAILY_LIMITS } from '../config/limits';
import { toApiMessages } from '../src/attachments';
import { cleanPrompt, parseImageRequest, sizeFor } from '../src/images';
import { effectiveLimit, nextReset } from '../src/limits';
import { wavSeconds } from '../src/transcribe';
// The browser half of the video page: same WAV the server checks.
// @ts-expect-error plain browser module without types
import { plan, shortLines, wav } from '../public/video.js';

const pic = 'data:image/jpeg;base64,/9j/AAAA';

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
