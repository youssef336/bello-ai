import {
  type ApiMessage,
  type Attachment,
  hasImages,
  readAttachments,
  toApiMessages,
  type Turn,
  turnSize,
  turnText,
} from './attachments';
import type { User } from './auth';
import { type Env, newId, now, today } from './env';
import { keysFor } from './keys';
import { classifyTask, detectLanguage } from './lang';
import { estimateCost, paidAllowedNow } from './paid';
import { callProvider, providerById } from './providers';
import { cooldownMs, type ModelRow, rankModels, type RouteRequest } from './router';
import { callSearch, SEARCH_MODELS, type Source, wantsWeb } from './search';
import { makeTitle } from './titles';

const HISTORY_CHARS = 24_000;
const MEMORY_CHARS = 3_000;
const MAX_ATTEMPTS = 4;
const COMPARE_SLOTS = 3;
const TITLE_WAIT_MS = 5_000;

const SYSTEM_PROMPT = `You are Bello AI, the personal assistant of one owner.
Answer in the language the owner writes in. If they write Egyptian Arabic, answer in Egyptian Arabic;
if they write Modern Standard Arabic, answer in MSA; otherwise English.
Be direct and practical. Say so when you are not sure instead of guessing.`;

const WEB_PROMPT = 'Search the web first and base the answer on what you find. Mention the date of the information when it matters.';

export interface ChatInput {
  conversationId?: string;
  message: string;
  /** 'auto' or a model id from the registry. */
  model?: string;
  /** Answer the last user message again: the previous answer is replaced. */
  regenerate?: boolean;
  attachments?: Attachment[];
  /** Search the web first. Also switched on by itself for news, prices and weather. */
  web?: boolean;
  /** Three models answer side by side; the person keeps the one they like. */
  compare?: boolean;
}

export type { Turn };

const words = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));

/** Pinned memories, then the ones sharing the most words with the message. Never all of them. */
async function relevantMemories(env: Env, userId: string, message: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT content, pinned FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 500',
  ).bind(userId).all<{ content: string; pinned: number }>();
  const query = words(message);
  const scored = rows.results
    .map((m) => {
      let overlap = 0;
      for (const w of words(m.content)) if (query.has(w)) overlap++;
      return { m, score: m.pinned ? 1000 : overlap };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const out: string[] = [];
  let used = 0;
  for (const { m } of scored) {
    if (used + m.content.length > MEMORY_CHARS) break;
    out.push(m.content);
    used += m.content.length;
  }
  return out;
}

/** Newest turns that fit the budget, oldest first. */
export function trimHistory(turns: Turn[], budget: number): Turn[] {
  const out: Turn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const size = turnSize(t);
    if (used + size > budget && out.length > 0) break;
    out.unshift(t);
    used += size;
  }
  return out;
}

/** An SSE response whose writes stop quietly once the browser has gone. */
function eventStream() {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let gone = false;
  return {
    send: async (event: string, data: unknown) => {
      if (gone) return;
      try {
        await writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        gone = true;
      }
    },
    close: () => writer.close().catch(() => {}),
    response: () =>
      new Response(readable, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
      }),
  };
}

async function bumpUsage(
  env: Env,
  userId: string,
  modelId: string,
  field: 'requests' | 'failures' | 'fallbacks',
  tokens = 0,
  cost = 0,
) {
  await env.DB.prepare(
    `INSERT INTO usage (day, user_id, model_id, ${field}, tokens_est, cost_est) VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (day, user_id, model_id) DO UPDATE SET ${field} = ${field} + 1, tokens_est = tokens_est + ?,
       cost_est = cost_est + ?`,
  ).bind(today(), userId, modelId, tokens, cost, tokens, cost).run();
}

/**
 * Record a failed attempt. Rate limits and key errors belong to this user's key, so the rest is
 * per user; a model that is gone is gone for everyone.
 */
async function markFailure(
  env: Env,
  userId: string,
  m: ModelRow,
  status: number,
  body: string,
  retryAfter: string | null,
) {
  const retry = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
  const gone = status === 404 || /decommission|deprecat|not found|does not exist/i.test(body);
  const rest =
    status === 429
      ? cooldownMs(m.cooldown_strikes, retry, /per.?day|daily|RPD|TPD/i.test(body))
      : status === 401 || status === 403
        ? 3600_000
        : 120_000;
  const stmts = [
    env.DB.prepare(
      `UPDATE models SET fail_count = fail_count + 1, last_error = ?,
         status = CASE WHEN ? THEN 'failed' ELSE status END WHERE id = ?`,
    ).bind(`HTTP ${status}: ${body.slice(0, 300)}`, gone ? 1 : 0, m.id),
  ];
  if (!gone) {
    stmts.push(env.DB.prepare(
      `INSERT INTO cooldowns (user_id, model_id, until, strikes) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, model_id) DO UPDATE SET until = excluded.until,
         strikes = CASE WHEN ? = 429 THEN cooldowns.strikes + 1 ELSE cooldowns.strikes END`,
    ).bind(userId, m.id, now() + rest, status === 429 ? 1 : 0, status));
  }
  await env.DB.batch(stmts);
}

/** Everything one answer needs: the prompt, the user's keys and the models they can reach now. */
interface Prepared {
  turns: Turn[];
  promptChars: number;
  keys: Map<string, string>;
  usable: ModelRow[];
  route: RouteRequest;
}

async function prepare(env: Env, user: User, job: Job): Promise<Prepared> {
  const memories = await relevantMemories(env, user.id, job.message);
  const system = memories.length
    ? `${SYSTEM_PROMPT}\n\nWhat you know about the owner (use only when relevant):\n- ${memories.join('\n- ')}`
    : SYSTEM_PROMPT;
  const turns: Turn[] = [
    { role: 'system', content: system },
    ...trimHistory([...job.history, { role: 'user', content: job.message, attachments: job.attachments }], HISTORY_CHARS),
  ];
  const promptChars = turns.reduce((n, t) => n + turnText(t).length, 0);

  // Only providers this user holds a key for: a member never spends the owner's limits.
  const keys = await keysFor(env, user);
  const [all, rests] = await Promise.all([
    env.DB.prepare(`SELECT * FROM models WHERE status = 'active'`).all<ModelRow>(),
    env.DB.prepare('SELECT model_id, until, strikes FROM cooldowns WHERE user_id = ?')
      .bind(user.id).all<{ model_id: string; until: number; strikes: number }>(),
  ]);
  const rest = new Map(rests.results.map((r) => [r.model_id, r]));
  // Paid models: the owner's credits, only with paid mode on and under the monthly cap.
  const paidOk = user.role === 'owner' && all.results.some((m) => m.paid) && (await paidAllowedNow(env));
  const usable = all.results
    .filter((m) => keys.has(m.provider) && (!m.paid || paidOk))
    .map((m) => ({ ...m, cooldown_until: rest.get(m.id)?.until ?? 0, cooldown_strikes: rest.get(m.id)?.strikes ?? 0 }));
  const route: RouteRequest = {
    language: detectLanguage(job.message),
    task: classifyTask(job.message),
    tokens: Math.ceil(promptChars / 3),
    providerBonus: new Map([...keys.keys()].map((id) => [id, providerById(id)?.bonus ?? 0])),
    at: now(),
    vision: hasImages(job.attachments),
  };
  return { turns, promptChars, keys, usable, route };
}

function noModelsMessage(p: Prepared): string {
  if (p.route.vision) return 'No model that reads pictures is free right now. Try again in a minute, or send text only.';
  if (p.usable.length) return 'Every free model is resting after a rate limit. Try again in a minute.';
  if (p.keys.size === 0) return 'Add at least one free API key in My keys (مفاتيحي) to start.';
  return 'No active models yet. Open Models and press "Scan now".';
}

const seesImages = (m: ModelRow): boolean => Boolean(m.supports_vision) && m.provider !== 'workers-ai';

type Success = { ok: true; text: string; latency: number; broken: boolean; sources: Source[] };
type Outcome = Success | { ok: false };

/**
 * One attempt with one model. A failure before the first token puts the model on rest and
 * returns ok: false so the caller can try the next one. Once text has started there is no silent
 * switch: a mid-answer failure keeps the text and reports `broken`.
 */
async function streamModel(
  env: Env,
  user: User,
  m: ModelRow,
  key: string | undefined,
  messages: ApiMessage[],
  hooks: { onStart: () => Promise<void>; onToken: (t: string) => Promise<void> },
  web = false,
): Promise<Outcome> {
  const provider = providerById(m.provider)!;
  const started = now();
  const fail = async (status: number, body: string, retryAfter: string | null = null): Promise<Outcome> => {
    await markFailure(env, user.id, m, status, body, retryAfter);
    await bumpUsage(env, user.id, m.id, 'failures');
    return { ok: false };
  };
  let res: Response;
  try {
    res = web
      ? await callSearch(key ?? '', m.model, messages)
      : await callProvider(provider, env, { model: m.model, messages, stream: true }, key);
  } catch (e) {
    return fail(0, String(e));
  }
  if (!res.ok || !res.body) return fail(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'));

  await hooks.onStart();
  let text = '';
  let firstTokenMs: number | null = null;
  let broken = false;
  let sources: Source[] = [];
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk: {
          choices?: { delta?: { content?: string | null } }[];
          error?: { message?: string };
          sources?: Source[];
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (chunk.error) throw new Error(chunk.error.message ?? 'provider error');
        if (chunk.sources) sources = chunk.sources;
        const piece = chunk.choices?.[0]?.delta?.content;
        if (piece) {
          firstTokenMs ??= now() - started;
          text += piece;
          await hooks.onToken(piece);
        }
      }
    }
  } catch (e) {
    broken = true;
    if (!text) return fail(0, String(e));
  }
  if (!text) return fail(0, 'empty answer');
  return { ok: true, text, latency: firstTokenMs ?? now() - started, broken, sources };
}

/** A model answered: clear its rest, learn its speed, count the use. */
async function recordSuccess(env: Env, user: User, m: ModelRow, o: Success, fallback: boolean, promptChars: number) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM cooldowns WHERE user_id = ? AND model_id = ?').bind(user.id, m.id),
    env.DB.prepare(
      `UPDATE models SET ok_count = ok_count + 1,
         latency_ms = CASE WHEN latency_ms IS NULL THEN ? ELSE (latency_ms * 4 + ?) / 5 END
       WHERE id = ?`,
    ).bind(o.latency, o.latency, m.id),
  ]);
  await bumpUsage(env, user.id, m.id, fallback ? 'fallbacks' : 'requests', Math.ceil((promptChars + o.text.length) / 4),
    m.paid ? estimateCost(m.price_in, m.price_out, promptChars, o.text.length) : 0);
}

async function saveAnswer(
  env: Env,
  conversationId: string,
  m: ModelRow,
  text: string,
  sources: Source[] = [],
  feedback: number | null = null,
): Promise<string> {
  const id = newId();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, model_id, sources, feedback, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`,
    ).bind(id, conversationId, text, m.id, sources.length ? JSON.stringify(sources) : null, feedback, now()),
    env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now(), conversationId),
  ]);
  return id;
}

interface Job {
  conversationId: string;
  userMessageId: string;
  message: string;
  attachments: Attachment[];
  history: Turn[];
  isNew: boolean;
}

type HistoryRow = { role: Turn['role']; content: string; attachments: string | null };
const toTurns = (rows: HistoryRow[]): Turn[] =>
  rows.reverse().map((r) => ({ role: r.role, content: r.content, attachments: readAttachments(r.attachments) }));

export async function chat(env: Env, ctx: ExecutionContext, user: User, input: ChatInput): Promise<Response> {
  const at = now();
  if (input.regenerate) return regenerate(env, ctx, user, input);
  const message = input.message.trim();
  const attachments = input.attachments ?? [];
  if (!message && !attachments.length) return new Response('empty message', { status: 400 });

  let conversationId = input.conversationId;
  let isNew = false;
  if (conversationId) {
    const exists = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?')
      .bind(conversationId, user.id).first();
    if (!exists) return new Response('conversation not found', { status: 404 });
  } else {
    isNew = true;
    conversationId = newId();
    const title = (message || attachments[0]!.name).replace(/\s+/g, ' ').slice(0, 60);
    await env.DB.prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(conversationId, user.id, title, at, at).run();
  }

  const past = await env.DB.prepare(
    'SELECT role, content, attachments FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 60',
  ).bind(conversationId).all<HistoryRow>();
  const userMessageId = newId();
  await env.DB.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(userMessageId, conversationId, 'user', message, attachments.length ? JSON.stringify(attachments) : null, at).run();
  const job: Job = { conversationId, userMessageId, message, attachments, history: toTurns(past.results), isNew };
  return input.compare ? compare(env, ctx, user, job) : answer(env, ctx, user, input, job);
}

/** Drop the answers after the last user message and answer it again. */
async function regenerate(env: Env, ctx: ExecutionContext, user: User, input: ChatInput): Promise<Response> {
  const conversationId = input.conversationId;
  if (!conversationId) return new Response('conversation required', { status: 400 });
  const mine = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?')
    .bind(conversationId, user.id).first();
  if (!mine) return new Response('conversation not found', { status: 404 });
  const last = await env.DB.prepare(
    `SELECT id, content, attachments, created_at FROM messages WHERE conversation_id = ? AND role = 'user'
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(conversationId).first<{ id: string; content: string; attachments: string | null; created_at: number }>();
  if (!last) return new Response('nothing to regenerate', { status: 404 });
  await env.DB.prepare('DELETE FROM messages WHERE conversation_id = ? AND created_at > ?')
    .bind(conversationId, last.created_at).run();
  const past = await env.DB.prepare(
    `SELECT role, content, attachments FROM messages WHERE conversation_id = ? AND created_at < ?
      ORDER BY created_at DESC LIMIT 60`,
  ).bind(conversationId, last.created_at).all<HistoryRow>();
  return answer(env, ctx, user, input, {
    conversationId,
    userMessageId: last.id,
    message: last.content,
    attachments: readAttachments(last.attachments),
    history: toTurns(past.results),
    isNew: false,
  });
}

/** For a new conversation: a short title, sent before `done` if it is ready in time. */
function titler(env: Env, p: Prepared, job: Job, send: (e: string, d: unknown) => Promise<void>) {
  const task = job.isNew ? makeTitle(p.usable, p.keys, env, job.message || job.attachments[0]?.name || '') : null;
  return async () => {
    if (!task) return;
    const title = await Promise.race([task, new Promise<null>((r) => setTimeout(() => r(null), TITLE_WAIT_MS))]);
    if (!title) return;
    await env.DB.prepare('UPDATE conversations SET title = ? WHERE id = ?').bind(title, job.conversationId).run();
    await send('title', { title });
  };
}

/** Stream one answer over SSE, best model first, falling back on failure. */
async function answer(env: Env, ctx: ExecutionContext, user: User, input: ChatInput, job: Job): Promise<Response> {
  const p = await prepare(env, user, job);
  const auto = !input.model || input.model === 'auto';

  let candidates: ModelRow[];
  if (!auto) {
    const pinned = p.usable.find((m) => m.id === input.model);
    candidates = pinned ? [pinned] : [];
  } else {
    candidates = rankModels(p.usable, p.route, MAX_ATTEMPTS);
  }
  // Web search runs on Groq's gpt-oss models, which read text only.
  const webWanted = (Boolean(input.web) || (auto && wantsWeb(job.message))) && !p.route.vision;
  const searchers = webWanted
    ? rankModels(p.usable.filter((m) => m.provider === 'groq' && SEARCH_MODELS.test(m.model)), { ...p.route, language: 'en' }, 2)
    : [];
  const attempts = [...searchers.map((m) => ({ m, web: true })), ...candidates.map((m) => ({ m, web: false }))];

  const { send, close, response } = eventStream();
  const sendTitle = titler(env, p, job, send);

  const run = async () => {
    await send('conversation', { id: job.conversationId, userMessageId: job.userMessageId });
    if (!attempts.length) {
      await send('error', { message: noModelsMessage(p) });
      await close();
      return;
    }
    if (input.web && !searchers.length) {
      await send('notice', {
        message: p.route.vision ? 'البحث على النت مش بيشتغل مع الصور. هرد من غير بحث.' : 'البحث على النت محتاج مفتاح Groq (مفاتيحي). هرد من غير بحث.',
      });
    }

    if (searchers.length) await send('searching', {});
    let warned = false;
    for (const [index, { m, web }] of attempts.entries()) {
      if (!web && searchers.length && !warned) {
        warned = true;
        await send('notice', { message: 'البحث على النت مش متاح دلوقتي، ده رد من غير بحث.' });
      }
      const turns = web
        ? [{ role: 'system' as const, content: `${p.turns[0]!.content}\n\n${WEB_PROMPT}` }, ...p.turns.slice(1)]
        : p.turns;
      const o = await streamModel(env, user, m, p.keys.get(m.provider), toApiMessages(turns, !web && seesImages(m)), {
        onStart: () =>
          send('model', { id: m.id, name: m.name, provider: providerById(m.provider)!.label, fallback: index > 0, web }),
        onToken: (t) => send('token', { t }),
      }, web);
      if (!o.ok) continue;

      const assistantId = await saveAnswer(env, job.conversationId, m, o.text, o.sources);
      await recordSuccess(env, user, m, o, index > 0, p.promptChars);
      if (o.sources.length) await send('sources', { sources: o.sources });
      if (o.broken) await send('error', { message: 'The answer was cut off by the provider.' });
      await sendTitle();
      await send('done', { messageId: assistantId });
      await close();
      return;
    }
    await send('error', { message: 'All free models failed for this message. Try again shortly.' });
    await close();
  };

  // Keep saving even if the browser disconnects mid-answer.
  ctx.waitUntil(run());
  return response();
}

/**
 * Three models answer at once, from different providers when possible. Nothing is saved as the
 * answer until the person keeps one (pickAnswer), and keeping it counts as a thumbs-up.
 */
async function compare(env: Env, ctx: ExecutionContext, user: User, job: Job): Promise<Response> {
  const p = await prepare(env, user, job);
  const ranked = rankModels(p.usable, p.route, 12);
  // Three different models, from three providers when possible: the same model twice compares nothing.
  const own: ModelRow[] = [];
  const sameModel = (a: ModelRow, b: ModelRow) => a.name.split('/').pop() === b.name.split('/').pop();
  for (const distinctProvider of [true, false]) {
    for (const m of ranked) {
      if (own.length >= COMPARE_SLOTS || own.includes(m) || own.some((o) => sameModel(o, m))) continue;
      if (distinctProvider && own.some((o) => o.provider === m.provider)) continue;
      own.push(m);
    }
  }
  // Spares: a slot whose model fails takes the next one.
  const spares = ranked.filter((m) => !own.includes(m));

  const { send, close, response } = eventStream();
  const sendTitle = titler(env, p, job, send);

  const showing = [...own];
  // A spare that is not the same model as one already on screen.
  const nextSpare = (): ModelRow | undefined => {
    const at = spares.findIndex((m) => !showing.some((o) => sameModel(o, m)));
    return at < 0 ? undefined : spares.splice(at, 1)[0];
  };

  const slot = async (n: number, start: ModelRow) => {
    for (let m: ModelRow | undefined = start; m; m = nextSpare()) {
      const model = m;
      showing[n] = model;
      const o = await streamModel(env, user, model, p.keys.get(model.provider), toApiMessages(p.turns, seesImages(model)), {
        onStart: () => send('model', { slot: n, id: model.id, name: model.name, provider: providerById(model.provider)!.label }),
        onToken: (t) => send('token', { slot: n, t }),
      });
      if (!o.ok) continue;
      await recordSuccess(env, user, model, o, false, p.promptChars);
      await send('slot-done', { slot: n, broken: o.broken });
      return;
    }
    await send('slot-error', { slot: n, message: 'مفيش موديل تاني فاضي دلوقتي.' });
  };

  const run = async () => {
    await send('conversation', { id: job.conversationId, userMessageId: job.userMessageId, slots: own.length });
    if (!own.length) {
      await send('error', { message: noModelsMessage(p) });
      await close();
      return;
    }
    await Promise.all(own.map((m, n) => slot(n, m)));
    await sendTitle();
    await send('done', {});
    await close();
  };

  ctx.waitUntil(run());
  return response();
}

/** Keep one of the compared answers: it becomes the conversation's answer and earns a thumbs-up. */
export async function pickAnswer(
  env: Env,
  user: User,
  input: { conversationId?: string; modelId?: string; text?: string },
): Promise<string | null> {
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100_000) return null;
  const [mine, m] = await Promise.all([
    env.DB.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?').bind(input.conversationId ?? '', user.id).first(),
    env.DB.prepare('SELECT * FROM models WHERE id = ?').bind(input.modelId ?? '').first<ModelRow>(),
  ]);
  if (!mine || !m) return null;
  const id = await saveAnswer(env, input.conversationId!, m, input.text, [], 1);
  await env.DB.prepare('UPDATE models SET quality = MAX(5, MIN(99, quality + 2)) WHERE id = ?').bind(m.id).run();
  return id;
}
