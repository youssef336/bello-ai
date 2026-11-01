import type { User } from './auth';
import { type Env, newId, now, today } from './env';
import { keysFor } from './keys';
import { classifyTask, detectLanguage } from './lang';
import { estimateCost, paidAllowedNow } from './paid';
import { callProvider, providerById } from './providers';
import { cooldownMs, type ModelRow, rankModels } from './router';

const HISTORY_CHARS = 24_000;
const MEMORY_CHARS = 3_000;
const MAX_ATTEMPTS = 4;

const SYSTEM_PROMPT = `You are Bello AI, the personal assistant of one owner.
Answer in the language the owner writes in. If they write Egyptian Arabic, answer in Egyptian Arabic;
if they write Modern Standard Arabic, answer in MSA; otherwise English.
Be direct and practical. Say so when you are not sure instead of guessing.`;

interface ChatInput {
  conversationId?: string;
  message: string;
  /** 'auto' or a model id from the registry. */
  model?: string;
  /** Answer the last user message again: the previous answer is replaced. */
  regenerate?: boolean;
}

interface Turn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

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
    if (used + t.content.length > budget && out.length > 0) break;
    out.unshift(t);
    used += t.content.length;
  }
  return out;
}

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

/**
 * Stream an answer over SSE. Models are tried best-first; a model that fails before its first
 * token is put on cooldown and the next one takes over. Once text has started, there is no
 * silent switch: a mid-answer failure is reported, never stitched from two models.
 */
export async function chat(env: Env, ctx: ExecutionContext, user: User, input: ChatInput): Promise<Response> {
  const at = now();
  if (input.regenerate) return regenerate(env, ctx, user, input);
  const message = input.message.trim();
  if (!message) return new Response('empty message', { status: 400 });

  let conversationId = input.conversationId;
  if (conversationId) {
    const exists = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?')
      .bind(conversationId, user.id).first();
    if (!exists) return new Response('conversation not found', { status: 404 });
  } else {
    conversationId = newId();
    await env.DB.prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(conversationId, user.id, message.replace(/\s+/g, ' ').slice(0, 60), at, at).run();
  }

  const past = await env.DB.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 60',
  ).bind(conversationId).all<Turn>();
  const userMessageId = newId();
  await env.DB.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(userMessageId, conversationId, 'user', message, at).run();
  return answer(env, ctx, user, input, conversationId, userMessageId, message, past.results.reverse(), at);
}

/** Drop the answers after the last user message and answer it again. */
async function regenerate(env: Env, ctx: ExecutionContext, user: User, input: ChatInput): Promise<Response> {
  const conversationId = input.conversationId;
  if (!conversationId) return new Response('conversation required', { status: 400 });
  const mine = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ? AND user_id = ?')
    .bind(conversationId, user.id).first();
  if (!mine) return new Response('conversation not found', { status: 404 });
  const last = await env.DB.prepare(
    `SELECT id, content, created_at FROM messages WHERE conversation_id = ? AND role = 'user'
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(conversationId).first<{ id: string; content: string; created_at: number }>();
  if (!last) return new Response('nothing to regenerate', { status: 404 });
  await env.DB.prepare('DELETE FROM messages WHERE conversation_id = ? AND created_at > ?')
    .bind(conversationId, last.created_at).run();
  const past = await env.DB.prepare(
    `SELECT role, content FROM messages WHERE conversation_id = ? AND created_at < ?
      ORDER BY created_at DESC LIMIT 60`,
  ).bind(conversationId, last.created_at).all<Turn>();
  return answer(env, ctx, user, input, conversationId, last.id, last.content, past.results.reverse(), now());
}

async function answer(
  env: Env,
  ctx: ExecutionContext,
  user: User,
  input: ChatInput,
  conversationId: string,
  userMessageId: string,
  message: string,
  history: Turn[],
  at: number,
): Promise<Response> {
  const memories = await relevantMemories(env, user.id, message);
  const system = memories.length
    ? `${SYSTEM_PROMPT}\n\nWhat you know about the owner (use only when relevant):\n- ${memories.join('\n- ')}`
    : SYSTEM_PROMPT;
  const turns: Turn[] = [
    { role: 'system', content: system },
    ...trimHistory([...history, { role: 'user', content: message }], HISTORY_CHARS),
  ];
  const promptChars = turns.reduce((n, t) => n + t.content.length, 0);

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

  let candidates: ModelRow[];
  if (input.model && input.model !== 'auto') {
    const pinned = usable.find((m) => m.id === input.model);
    candidates = pinned ? [pinned] : [];
  } else {
    candidates = rankModels(
      usable,
      {
        language: detectLanguage(message),
        task: classifyTask(message),
        tokens: Math.ceil(promptChars / 3),
        providerBonus: new Map([...keys.keys()].map((id) => [id, providerById(id)?.bonus ?? 0])),
        at,
      },
      MAX_ATTEMPTS,
    );
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let clientGone = false;
  const send = async (event: string, data: unknown) => {
    if (clientGone) return;
    try {
      await writer.write(sse(event, data));
    } catch {
      clientGone = true;
    }
  };

  const run = async () => {
    await send('conversation', { id: conversationId, userMessageId });
    if (!candidates.length) {
      await send('error', {
        message: usable.length
          ? 'Every free model is resting after a rate limit. Try again in a minute.'
          : keys.size === 0
            ? 'Add at least one free API key in My keys (مفاتيحي) to start.'
            : 'No active models yet. Open Models and press "Scan now".',
      });
      await writer.close().catch(() => {});
      return;
    }

    for (const [index, m] of candidates.entries()) {
      const provider = providerById(m.provider)!;
      const started = now();
      let res: Response;
      try {
        res = await callProvider(provider, env, { model: m.model, messages: turns, stream: true }, keys.get(m.provider));
      } catch (e) {
        await markFailure(env, user.id, m, 0, String(e), null);
        await bumpUsage(env, user.id, m.id, 'failures');
        continue;
      }
      if (!res.ok || !res.body) {
        await markFailure(env, user.id, m, res.status, await res.text().catch(() => ''), res.headers.get('retry-after'));
        await bumpUsage(env, user.id, m.id, 'failures');
        continue;
      }

      await send('model', { id: m.id, name: m.name, provider: provider.label, fallback: index > 0 });
      let text = '';
      let firstTokenMs: number | null = null;
      let broken = false;
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
            let chunk: { choices?: { delta?: { content?: string | null } }[]; error?: { message?: string } };
            try {
              chunk = JSON.parse(payload);
            } catch {
              continue;
            }
            if (chunk.error) throw new Error(chunk.error.message ?? 'provider error');
            const piece = chunk.choices?.[0]?.delta?.content;
            if (piece) {
              firstTokenMs ??= now() - started;
              text += piece;
              await send('token', { t: piece });
            }
          }
        }
      } catch (e) {
        broken = true;
        if (!text) {
          await markFailure(env, user.id, m, 0, String(e), null);
          await bumpUsage(env, user.id, m.id, 'failures');
          continue;
        }
      }
      if (!text) {
        await markFailure(env, user.id, m, 0, 'empty answer', null);
        await bumpUsage(env, user.id, m.id, 'failures');
        continue;
      }

      const assistantId = newId();
      const latency = firstTokenMs ?? now() - started;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO messages (id, conversation_id, role, content, model_id, created_at)
           VALUES (?, ?, 'assistant', ?, ?, ?)`,
        ).bind(assistantId, conversationId, text, m.id, now()),
        env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(now(), conversationId),
        env.DB.prepare('DELETE FROM cooldowns WHERE user_id = ? AND model_id = ?').bind(user.id, m.id),
        env.DB.prepare(
          `UPDATE models SET ok_count = ok_count + 1,
             latency_ms = CASE WHEN latency_ms IS NULL THEN ? ELSE (latency_ms * 4 + ?) / 5 END
           WHERE id = ?`,
        ).bind(latency, latency, m.id),
      ]);
      await bumpUsage(env, user.id, m.id, index > 0 ? 'fallbacks' : 'requests', Math.ceil((promptChars + text.length) / 4),
        m.paid ? estimateCost(m.price_in, m.price_out, promptChars, text.length) : 0);
      if (broken) await send('error', { message: 'The answer was cut off by the provider.' });
      await send('done', { messageId: assistantId });
      await writer.close().catch(() => {});
      return;
    }
    await send('error', { message: 'All free models failed for this message. Try again shortly.' });
    await writer.close().catch(() => {});
  };

  // Keep saving even if the browser disconnects mid-answer.
  ctx.waitUntil(run());
  return new Response(readable, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  });
}
