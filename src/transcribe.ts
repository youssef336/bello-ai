import type { User } from './auth';
import { type Env, error, json } from './env';
import { allocationUsed, consume, limitReached, refund } from './limits';

/**
 * Subtitles for a video: the browser cuts the sound into short 16 kHz mono WAV pieces and sends
 * them one by one; Whisper on Workers AI (free allocation, ≈ 47 neurons a minute) writes the words
 * with their times. Every second of sound counts against the person's daily video limit.
 * The video itself never leaves the device: trimming, cropping and burning the words in all
 * happen in the browser (public/video.js).
 */

const WHISPER = '@cf/openai/whisper-large-v3-turbo';
/** 16 kHz × 1 channel × 2 bytes. */
const BYTES_PER_SECOND = 32_000;
const HEADER_BYTES = 44;
/** ≈ 40 s of sound: small enough to parse well inside the Worker's CPU budget. */
const MAX_AUDIO_CHARS = 1_800_000;

export interface Segment {
  start: number;
  end: number;
  text: string;
}

/** Seconds of sound in a base64 WAV, or null when it is not 16 kHz mono 16-bit PCM. */
export function wavSeconds(b64: string): number | null {
  if (b64.length < 64 || b64.length > MAX_AUDIO_CHARS || !/^[A-Za-z0-9+/]+=*$/.test(b64)) return null;
  const head = Uint8Array.from(atob(b64.slice(0, 60)), (c) => c.charCodeAt(0));
  const view = new DataView(head.buffer);
  const tag = (at: number) => String.fromCharCode(...head.slice(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') return null;
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  if (format !== 1 || channels !== 1 || rate !== 16_000 || bits !== 16) return null;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const bytes = (b64.length * 3) / 4 - padding - HEADER_BYTES;
  return Math.max(1, Math.ceil(bytes / BYTES_PER_SECOND));
}

export async function transcribe(env: Env, user: User, raw: Record<string, unknown>): Promise<Response> {
  if (!env.AI) return error(503, 'الترجمة المكتوبة محتاجة Cloudflare Workers AI، ومش متوصّل.');
  const audio = typeof raw.audio === 'string' ? raw.audio : '';
  const seconds = wavSeconds(audio);
  if (seconds === null) return error(400, 'الصوت لازم يبقى WAV ‏16kHz mono، لحد 40 ثانية في المرة');
  const language = typeof raw.language === 'string' && /^[a-z]{2}$/.test(raw.language) ? raw.language : undefined;
  const toEnglish = raw.task === 'translate';

  if (!(await consume(env, user, 'video', seconds))) return limitReached('video');
  try {
    const out = (await env.AI.run(WHISPER as never, {
      audio,
      task: toEnglish ? 'translate' : 'transcribe',
      vad_filter: true,
      ...(language ? { language } : {}),
      // Nudges Whisper towards Egyptian Arabic spelling instead of transliterating it.
      ...(language === 'ar' && !toEnglish ? { initial_prompt: 'ده فيديو بالعامية المصرية.' } : {}),
    } as never)) as { segments?: Segment[]; transcription_info?: { language?: string } };
    const segments = (out.segments ?? [])
      .map((s) => ({ start: s.start, end: s.end, text: String(s.text ?? '').trim() }))
      .filter((s) => s.text && Number.isFinite(s.start) && Number.isFinite(s.end));
    return json({ segments, language: out.transcription_info?.language ?? null, seconds });
  } catch (e) {
    await refund(env, user, 'video', seconds);
    const message = String(e instanceof Error ? e.message : e);
    console.error('whisper', message);
    if (/4006|daily free allocation|neurons/i.test(message)) return allocationUsed();
    return error(502, 'ماعرفتش أسمع الجزء ده. جرّب تاني.');
  }
}
