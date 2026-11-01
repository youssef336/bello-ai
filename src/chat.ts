import { type Env, newId, now, today } from './env';
import { classifyTask, detectLanguage } from './lang';
import { callProvider, configuredProviders, providerById } from './providers';
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
}

interface Turn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const words = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));

/** Pinned memories, then the ones sharing the most words with the message. Never all of them. */
async function relevantMemories(env: Env, message: string): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT content, pinned FROM memories ORDER BY created_at DESC LIMIT 500')
    .all<{ content: string; pinned: number }>();
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

async function bumpUsage(env: Env, modelId: string, field: 'requests' | 'failures' | 'fallbacks', tokens = 0) {
  await env.DB.prepare(
    `INSERT INTO usage (day, model_id, ${field}, tokens_est) VALUES (?, ?, 1, ?)
     ON CONFLICT (day, model_id) DO UPDATE SET ${field} = ${field} + 1, tokens_est = tokens_est + ?`,
  ).bind(today(), modelId, tokens, tokens).run();
}

/** Record a failed attempt and decide how long to skip the model. */
async function markFailure(env: Env, m: ModelRow, status: number, body: string, retryAfter: string | null) {
  const retry = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
  let until = 0;
  let status_ = m.status;
  if (status === 429) {
    until = now() + cooldownMs(m.cooldown_strikes, retry, /per.?day|daily|RPD|TPD/i.test(body));
  } else if (status === 404 || /decommission|deprecat|not found|does not exist/i.test(body)) {
    status_ = 'failed';
  } else if (status === 401 || status === 403) {
    until = now() + 3600_000;
  } else {
    until = now() + 120_000;
  }
  await env.DB.prepare(
    `UPDATE models SET fail_count = fail_count + 1, cooldown_until = ?, status = ?, last_error = ?,
       cooldown_strikes = CASE WHEN ? = 429 THEN cooldown_strikes + 1 ELSE cooldown_strikes END
     WHERE id = ?`,
  ).bind(until, status_, `HTTP ${status}: ${body.slice(0, 300)}`, status, m.id).run();
}

/**
 * Stream an answer over SSE. Models are tried best-first; a model that fails before its first
 * token is put on cooldown and the next one takes over. Once text has started, there is no
 * silent switch: a mid-answer failure is reported, never stitched from two models.
 */
export async function chat(env: Env, ctx: ExecutionContext, input: ChatInput): Promise<Response> {
  const message = input.message.trim();
  if (!message) return new Response('empty message', { status: 400 });

  const at = now();
  let conversationId = input.conversationId;
  if (conversationId) {
    const exists = await env.DB.prepare('SELECT 1 FROM conversations WHERE id = ?').bind(conversationId).first();
    if (!exists) return new Response('conversation not found', { status: 404 });
  } else {
    conversationId = newId();
    await env.DB.prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(conversationId, message.replace(/\s+/g, ' ').slice(0, 60), at, at).run();
  }

  const past = await env.DB.prepare(
    'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 60',
  ).bind(conversationId).all<Turn>();
  const userMessageId = newId();
  await env.DB.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(userMessageId, conversationId, 'user', message, at).run();

  const memories = await relevantMemories(env, message);
  const system = memories.length
    ? `${SYSTEM_PROMPT}\n\nWhat you know about the owner (use only when relevant):\n- ${memories.join('\n- ')}`
    : SYSTEM_PROMPT;
  const turns: Turn[] = [
    { role: 'system', content: system },
    ...trimHistory([...past.results.reverse(), { role: 'user', content: message }], HISTORY_CHARS),
  ];
  const promptChars = turns.reduce((n, t) => n + t.content.length, 0);

  const configured = new Set(configuredProviders(env).map((p) => p.id));
  const all = await env.DB.prepare(`SELECT * FROM models WHERE status = 'active'`).all<ModelRow>();
  const usable = all.results.filter((m) => configured.has(m.provider));

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
        providerBonus: new Map(configuredProviders(env).map((p) => [p.id, p.bonus])),
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
        res = await callProvider(provider, env, { model: m.model, messages: turns, stream: true });
      } catch (e) {
        await markFailure(env, m, 0, String(e), null);
        await bumpUsage(env, m.id, 'failures');
        continue;
      }
      if (!res.ok || !res.body) {
        await markFailure(env, m, res.status, await res.text().catch(() => ''), res.headers.get('retry-after'));
        await bumpUsage(env, m.id, 'failures');
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
          await markFailure(env, m, 0, String(e), null);
          await bumpUsage(env, m.id, 'failures');
          continue;
        }
      }
      if (!text) {
        await markFailure(env, m, 0, 'empty answer', null);
        await bumpUsage(env, m.id, 'failures');
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
        env.DB.prepare(
          `UPDATE models SET ok_count = ok_count + 1, cooldown_strikes = 0,
             latency_ms = CASE WHEN latency_ms IS NULL THEN ? ELSE (latency_ms * 4 + ?) / 5 END
           WHERE id = ?`,
        ).bind(latency, latency, m.id),
      ]);
      await bumpUsage(env, m.id, index > 0 ? 'fallbacks' : 'requests', Math.ceil((promptChars + text.length) / 4));
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
