import type { Env } from './env';
import { detectLanguage } from './lang';
import { callProvider, providerById } from './providers';
import type { ModelRow } from './router';

/**
 * A short title for a new conversation, from the fastest free model that is not thinking out
 * loud first. Runs next to the answer, so it costs no waiting; null when nothing answers in time.
 */

const THINKS = /reason|think|r1\b|qwq|gpt-oss|qwen3|nemotron|kimi|deepseek|glm/i;
const TRY_MODELS = 3;
const TIMEOUT_MS = 6_000;

/** First line, no quotes or trailing punctuation, at most 60 characters. */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const title = line
    .replace(/^(title|العنوان)\s*[:：]\s*/i, '')
    .replace(/^["'«“*#\s]+|["'»”*.。!?؟\s]+$/g, '')
    .slice(0, 60)
    .trim();
  return title.length >= 2 ? title : null;
}

export async function makeTitle(
  usable: ModelRow[],
  keys: Map<string, string>,
  env: Env,
  message: string,
): Promise<string | null> {
  if (!message.trim()) return null;
  const arabic = detectLanguage(message) === 'ar';
  const at = Date.now();
  const picks = usable
    .filter((m) => !m.paid && !THINKS.test(m.model) && m.cooldown_until <= at && m.provider !== 'workers-ai')
    .filter((m) => !arabic || m.arabic_ok === 1)
    .sort((a, b) => (a.latency_ms ?? 9e9) - (b.latency_ms ?? 9e9))
    .slice(0, TRY_MODELS);
  const prompt = arabic
    ? `اكتب عنوان قصير (من 2 لـ 6 كلمات) للمحادثة دي، بنفس لهجة الرسالة. اكتب العنوان بس من غير أي حاجة تانية.\n\nالرسالة:\n${message.slice(0, 1500)}`
    : `Write a short title (2 to 6 words) for this conversation. Reply with the title only.\n\nMessage:\n${message.slice(0, 1500)}`;
  for (const m of picks) {
    try {
      const res = await callProvider(
        providerById(m.provider)!,
        env,
        { model: m.model, messages: [{ role: 'user', content: prompt }], max_tokens: 40, temperature: 0.3 },
        keys.get(m.provider),
        AbortSignal.timeout(TIMEOUT_MS),
      );
      if (!res.ok) continue;
      const data = await res.json<{ choices?: { message?: { content?: string } }[] }>();
      const title = cleanTitle(data.choices?.[0]?.message?.content ?? '');
      if (title) return title;
    } catch {
      // Too slow or unreachable: the next one.
    }
  }
  return null;
}
