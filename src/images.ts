import type { Attachment } from './attachments';
import type { User } from './auth';
import { type Env, error, json, newId, now } from './env';
import { keysFor } from './keys';
import { detectLanguage } from './lang';
import { allocationUsed, consume, limitReached, refund } from './limits';
import type { ModelRow } from './router';
import { askQuick } from './titles';

/**
 * Draw a picture or edit the ones sent, on Cloudflare Workers AI: free inside the owner's daily
 * allocation (10,000 neurons; a 1024×1024 picture costs about 60–130), and it fails rather than
 * bills when the allocation is used up. Each picture counts against the person's daily image limit.
 *
 * - FLUX.2 [klein] 4B draws and edits: up to 4 pictures go in as input_image_0..3, and the prompt
 *   can refer to them ("put the dog from image 1 next to the woman in image 0").
 * - FLUX.1 [schnell] is the backup for plain drawing.
 * Prices: developers.cloudflare.com/workers-ai/platform/pricing (checked 2026-11-01).
 */

const KLEIN = '@cf/black-forest-labs/flux-2-klein-4b';
const SCHNELL = '@cf/black-forest-labs/flux-1-schnell';
export const IMAGE_MODEL_NAMES: Record<string, string> = { [KLEIN]: 'FLUX.2 klein', [SCHNELL]: 'FLUX.1 schnell' };

const MAX_INPUTS = 4;
const MAX_INPUT_CHARS = 1_000_000;
const MAX_PROMPT = 2_000;
const LONG_SIDE = 1024;
const INPUT = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+=*)$/;

export interface ImageRequest {
  prompt: string;
  /** Pictures to edit or combine, as data URLs. */
  images: string[];
  /** Width / height of the result. */
  aspect: number;
  conversationId?: string;
}

export function parseImageRequest(raw: Record<string, unknown>): ImageRequest | string {
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt || prompt.length > MAX_PROMPT) return 'اكتب وصف للصورة (لحد 2000 حرف)';
  const images = Array.isArray(raw.images) ? raw.images : [];
  if (images.length > MAX_INPUTS) return `أقصى حاجة ${MAX_INPUTS} صور في التعديل`;
  for (const img of images) {
    if (typeof img !== 'string' || img.length > MAX_INPUT_CHARS || !INPUT.test(img)) return 'صورة مش صالحة للتعديل';
  }
  const aspect = typeof raw.aspect === 'number' && Number.isFinite(raw.aspect) ? raw.aspect : 1;
  const conversationId = typeof raw.conversationId === 'string' ? raw.conversationId : undefined;
  return { prompt, images: images as string[], aspect: Math.min(2, Math.max(0.5, aspect)), conversationId };
}

/** Long side 1024, both sides multiples of 16 (what the FLUX models want). */
export function sizeFor(aspect: number): { width: number; height: number } {
  const round = (n: number) => Math.max(256, Math.round(n / 16) * 16);
  return aspect >= 1
    ? { width: LONG_SIDE, height: round(LONG_SIDE / aspect) }
    : { width: round(LONG_SIDE * aspect), height: LONG_SIDE };
}

const pictureOf = (dataUrl: string): Blob => {
  const [, type, b64] = INPUT.exec(dataUrl)!;
  return new Blob([Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0))], { type: `image/${type}` });
};

/** First line of a model's answer, without thinking, quotes or a "Prompt:" label. */
export function cleanPrompt(raw: string): string | null {
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
    .replace(/^(prompt|english prompt)\s*[:：]\s*/i, '')
    .replace(/^["'“]+|["'”]+$/g, '')
    .trim();
  return text.length >= 3 && text.length <= 1500 ? text : null;
}

/**
 * FLUX follows English best. An Arabic request is rewritten as an English prompt by a fast free
 * chat model; words meant to appear in the picture stay as written. Falls back to the original.
 */
async function englishPrompt(env: Env, user: User, request: string, editing: boolean): Promise<string> {
  if (detectLanguage(request) !== 'ar') return request;
  const keys = await keysFor(env, user);
  // Pictures already run on the owner's Workers AI, so its chat models may word the prompt too.
  if (env.AI) keys.set('workers-ai', 'binding');
  const models = await env.DB.prepare(`SELECT * FROM models WHERE status = 'active' AND paid = 0`).all<ModelRow>();
  const usable = models.results.filter((m) => keys.has(m.provider));
  const ask = editing
    ? `Rewrite this request as one short English instruction for an image model that edits the attached picture(s). Say exactly what to change, then "keep everything else the same". Refer to pictures as image 0, image 1… only when there are several. Text that must appear in the picture stays in its original language, in quotes. Reply with the instruction only.\n\nRequest:\n${request}`
    : `Rewrite this request as one clear English prompt for an image model. Keep every detail it gives (people, objects, colours, style, mood) and add nothing it does not ask for. Text that must appear in the picture stays in its original language, in quotes. Reply with the prompt only.\n\nRequest:\n${request}`;
  // Sent as Arabic, an edit is only half done (tested: "a red hat instead of the glasses" added
  // the hat and kept the glasses), so a slower model is worth it when no fast one answers.
  return (await askQuick(usable, keys, env, ask, true, 300, cleanPrompt))
    ?? (await askQuick(usable, keys, env, ask, true, 1500, cleanPrompt, true))
    ?? request;
}

class DailyAllocationUsed extends Error {}
/** The docs ask for input pictures under 512 px; larger ones work today and keep more detail. */
class InputTooLarge extends Error {}

async function runKlein(env: Env, prompt: string, inputs: Blob[], size: { width: number; height: number }) {
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('width', String(size.width));
  form.append('height', String(size.height));
  inputs.forEach((picture, i) => form.append(`input_image_${i}`, picture));
  // FormData has no serialised body or boundary of its own: a Response makes both.
  const body = new Response(form);
  return env.AI!.run(KLEIN as never, {
    multipart: { body: body.body, contentType: body.headers.get('content-type') },
  } as never) as Promise<{ image?: string }>;
}

async function runSchnell(env: Env, prompt: string) {
  return env.AI!.run(SCHNELL as never, { prompt, steps: 6 } as never) as Promise<{ image?: string }>;
}

/** Base64 JPEG of the picture, trying the backup model when the first one fails. */
async function draw(env: Env, prompt: string, inputs: Blob[], aspect: number): Promise<{ image: string; model: string }> {
  const attempts: [string, () => Promise<{ image?: string }>][] = [[KLEIN, () => runKlein(env, prompt, inputs, sizeFor(aspect))]];
  // schnell cannot see pictures, so it only stands in for plain drawing.
  if (!inputs.length) attempts.push([SCHNELL, () => runSchnell(env, prompt)]);
  let last: unknown = null;
  for (const [model, run] of attempts) {
    try {
      const out = await run();
      if (out.image) return { image: out.image, model };
      last = new Error('no image in the answer');
    } catch (e) {
      const message = String(e instanceof Error ? e.message : e);
      if (/4006|daily free allocation|neurons/i.test(message)) throw new DailyAllocationUsed(message);
      if (inputs.length && /512|too large|dimension|resolution|image size/i.test(message)) throw new InputTooLarge(message);
      console.error('image', model, message);
      last = e;
    }
  }
  throw last;
}

const mimeOf = (b64: string): string => (b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg');

export async function makeImage(env: Env, user: User, req: ImageRequest): Promise<Response> {
  if (!env.AI) return error(503, 'الصور محتاجة Cloudflare Workers AI، ومش متوصّل.');
  const at = now();

  let conversationId = req.conversationId;
  let isNew = false;
  if (conversationId) {
    const mine = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?')
      .bind(conversationId, user.id).first();
    if (!mine) return error(404, 'conversation not found');
  }

  if (!(await consume(env, user, 'images'))) return limitReached('images');

  const editing = req.images.length > 0;
  let result: { image: string; model: string };
  let prompt = req.prompt;
  try {
    prompt = await englishPrompt(env, user, req.prompt, editing);
    result = await draw(env, prompt, req.images.map(pictureOf), req.aspect);
  } catch (e) {
    await refund(env, user, 'images');
    if (e instanceof DailyAllocationUsed) return allocationUsed();
    if (e instanceof InputTooLarge) return json({ error: 'الصورة كبيرة على الموديل', smaller: true }, 413);
    return error(502, 'ماعرفتش أعمل الصورة دي. جرّب توصفها بشكل تاني، أو استنى دقيقة.');
  }

  if (!conversationId) {
    isNew = true;
    conversationId = newId();
    await env.DB.prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(conversationId, user.id, `🎨 ${req.prompt.replace(/\s+/g, ' ').slice(0, 56)}`, at, at).run();
  }
  const inputs: Attachment[] = req.images.map((data, i) => ({ type: 'image', name: `صورة ${i}`, data }));
  const picture: Attachment = { type: 'image', name: `bello-${at}.jpg`, data: `data:${mimeOf(result.image)};base64,${result.image}` };
  const userMessageId = newId();
  const answerId = newId();
  const content = editing ? 'اتفضل بعد التعديل ✏️' : 'اتفضل الصورة 🎨';
  const modelId = `workers-ai:${result.model}`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO messages (id, conversation_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(userMessageId, conversationId, 'user', req.prompt, inputs.length ? JSON.stringify(inputs) : null, at),
    env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, attachments, model_id, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?)`,
    ).bind(answerId, conversationId, content, JSON.stringify([picture]), modelId, now()),
    env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now(), conversationId),
  ]);
  return json({
    conversationId,
    isNew,
    userMessageId,
    prompt: prompt !== req.prompt ? prompt : null,
    message: {
      id: answerId,
      role: 'assistant',
      content,
      attachments: [picture],
      model_name: IMAGE_MODEL_NAMES[result.model],
    },
  });
}
