/**
 * Pictures and files sent with a message. The browser shrinks pictures to JPEG and reads text out
 * of PDFs and text files before sending, so the server only ever sees data URLs and plain text.
 */

export type Attachment =
  | { type: 'image'; name: string; data: string }
  | { type: 'file'; name: string; text: string };

const MAX_IMAGES = 4;
const MAX_FILES = 3;
const MAX_IMAGE_CHARS = 1_400_000;
const MAX_FILE_CHARS = 120_000;
/** D1 keeps a row under 2 MB; the message text and the rest of the row need room too. */
const MAX_TOTAL_CHARS = 1_800_000;
/** How many of the newest pictures in the history a model is shown again. */
const MAX_IMAGES_IN_HISTORY = 4;
/** What a picture counts as against the history budget. */
const IMAGE_COST = 1_000;

const IMAGE_DATA = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/;

/** The attachments a request may carry, or a reason to refuse it. */
export function parseAttachments(raw: unknown): Attachment[] | string {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return 'attachments must be a list';
  const out: Attachment[] = [];
  let total = 0;
  for (const a of raw as Record<string, unknown>[]) {
    const name = typeof a?.name === 'string' ? a.name.slice(0, 120) : 'file';
    if (a?.type === 'image' && typeof a.data === 'string') {
      if (a.data.length > MAX_IMAGE_CHARS || !IMAGE_DATA.test(a.data)) return `${name}: not a usable picture`;
      out.push({ type: 'image', name, data: a.data });
      total += a.data.length;
    } else if (a?.type === 'file' && typeof a.text === 'string') {
      out.push({ type: 'file', name, text: a.text.slice(0, MAX_FILE_CHARS) });
      total += Math.min(a.text.length, MAX_FILE_CHARS);
    } else {
      return 'unknown attachment';
    }
  }
  if (out.filter((a) => a.type === 'image').length > MAX_IMAGES) return `at most ${MAX_IMAGES} pictures`;
  if (out.filter((a) => a.type === 'file').length > MAX_FILES) return `at most ${MAX_FILES} files`;
  if (total > MAX_TOTAL_CHARS) return 'attachments too large';
  return out;
}

export const hasImages = (list: Attachment[] | undefined): boolean => Boolean(list?.some((a) => a.type === 'image'));

export function readAttachments(stored: string | null | undefined): Attachment[] {
  if (!stored) return [];
  try {
    return JSON.parse(stored) as Attachment[];
  } catch {
    return [];
  }
}

export interface Turn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: Attachment[];
}

/** The message text with the files' text after it: what a model actually reads. */
export function turnText(t: Turn): string {
  const files = (t.attachments ?? []).filter((a) => a.type === 'file');
  if (!files.length) return t.content;
  return [t.content, ...files.map((f) => `--- ${f.name} ---\n${f.text}`)].join('\n\n');
}

export const turnSize = (t: Turn): number =>
  turnText(t).length + (t.attachments ?? []).filter((a) => a.type === 'image').length * IMAGE_COST;

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type ApiMessage = { role: Turn['role']; content: string | Part[] };

/**
 * OpenAI-style messages. A model that reads images gets the newest few pictures; one that does
 * not gets a note in their place, so it at least knows a picture was there.
 */
export function toApiMessages(turns: Turn[], vision: boolean): ApiMessage[] {
  let budget = vision ? MAX_IMAGES_IN_HISTORY : 0;
  const shown = new Set<string>();
  for (let i = turns.length - 1; i >= 0 && budget > 0; i--) {
    for (const a of turns[i]!.attachments ?? []) {
      if (a.type === 'image' && budget > 0) {
        shown.add(a.data);
        budget--;
      }
    }
  }
  return turns.map((t) => {
    const images = (t.attachments ?? []).filter((a) => a.type === 'image');
    const text = turnText(t);
    if (!images.length) return { role: t.role, content: text };
    const notes = images.filter((a) => !shown.has(a.data)).map((a) => `[picture: ${a.name}]`);
    const caption = [text, ...notes].filter(Boolean).join('\n') || ' ';
    const pictures: Part[] = images
      .filter((a) => shown.has(a.data))
      .map((a) => ({ type: 'image_url', image_url: { url: a.data } }));
    return pictures.length ? { role: t.role, content: [{ type: 'text', text: caption }, ...pictures] } : { role: t.role, content: caption };
  });
}
