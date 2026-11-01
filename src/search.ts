import type { ApiMessage } from './attachments';

/**
 * Answers built from a live web search, through Groq's built-in `browser_search` tool on the
 * gpt-oss models: free on Groq's free plan, the model searches and opens pages itself.
 * (Gemini's Google Search grounding is not free on current models, checked 1 Nov 2026 at
 * ai.google.dev/gemini-api/docs/pricing.)
 *
 * The tool only runs without streaming, so the finished answer is replayed as OpenAI-style
 * deltas, followed by one `{ sources }` event with the pages it read.
 */

export interface Source {
  title: string;
  url: string;
}

/** The models that have the tool. */
export const SEARCH_MODELS = /^openai\/gpt-oss-/;

/** Strong hints that only today's web can answer. Kept narrow on purpose: a wrong hit costs a search. */
const FRESH =
  /أخبار|اخبار|سعر|أسعار|اسعار|الطقس|درجة الحرارة|نتيجة (ماتش|مباراة)|مباراة النهارده|ماتش النهارده|\b(news|headlines|weather|price of|stock price|exchange rate|latest version|score of)\b/i;

export const wantsWeb = (text: string): boolean => FRESH.test(text);

interface ExecutedTool {
  type?: string;
  search_results?: { results?: { title?: string; url?: string }[] };
}

/** Pages the model opened first, then the rest of what the search found. */
export function sourcesOf(tools: ExecutedTool[]): Source[] {
  const titles = new Map<string, string>();
  const opened: string[] = [];
  const found: string[] = [];
  for (const t of tools) {
    for (const r of t.search_results?.results ?? []) {
      if (!r.url || !/^https?:\/\//.test(r.url)) continue;
      if (t.type === 'browser_search') {
        if (r.title) titles.set(r.url, r.title);
        found.push(r.url);
      } else {
        opened.push(r.url);
      }
    }
  }
  const urls = [...new Set([...opened, ...found])].slice(0, 6);
  return urls.map((url) => ({ url, title: titles.get(url) ?? new URL(url).hostname.replace(/^www\./, '') }));
}

/** 【1†L4-L8】-style markers point into the tool's page dumps; the reader has the links instead. */
export const stripCitations = (text: string): string => text.replace(/\s?【[^】]*】/g, '');

export async function callSearch(key: string, model: string, messages: ApiMessage[]): Promise<Response> {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, tools: [{ type: 'browser_search' }] }),
  });
  if (!res.ok) return res;
  const data = await res.json<{ choices?: { message?: { content?: string; executed_tools?: ExecutedTool[] } }[] }>();
  const message = data.choices?.[0]?.message;
  const text = stripCitations(message?.content ?? '').trim();
  if (!text) return new Response('empty answer from search', { status: 502 });
  const sources = sourcesOf(message?.executed_tools ?? []);
  const events = [{ choices: [{ delta: { content: text } }] }, ...(sources.length ? [{ sources }] : [])];
  return new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
