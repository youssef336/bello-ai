import type { Env } from './env';
import { savePaidCatalog } from './paid';
import { callWorkersAi, discoverWorkersAi } from './workers-ai';

/**
 * How we know a model is free:
 * - 'catalog': the provider's own catalog lists its price as 0 (OpenRouter).
 * - 'probe': the provider has a permanent free plan and the key has no billing attached, so a
 *   model that answers the quick test on that key is free. A model the free plan does not
 *   cover answers 402/429 "limit: 0" and is marked paid.
 * - 'allocation': a daily allocation that fails when used up and can never bill (Workers AI).
 */
export type FreeBasis = 'catalog' | 'probe' | 'allocation';

export interface DiscoveredModel {
  model: string;
  name: string;
  contextLength: number | null;
  tools: boolean;
  vision: boolean;
  evidence: string;
}

export interface Provider {
  id: string;
  label: string;
  baseUrl: string;
  keyOf: (env: Env) => string | undefined;
  freeBasis: FreeBasis;
  /** Added to every model's score: fast hardware up, a small daily budget down. */
  bonus: number;
  /** Returns only the chat models that may be free. Paid-only models are dropped here. */
  discover: (key: string, env: Env) => Promise<DiscoveredModel[]>;
  /** For providers that are not an HTTP endpoint; must answer like OpenAI /chat/completions. */
  call?: (env: Env, body: Record<string, unknown>) => Promise<Response>;
  extraHeaders?: Record<string, string>;
}

/** POST an OpenAI-style /chat/completions body to any provider. */
export function callProvider(
  provider: Provider,
  env: Env,
  body: Record<string, unknown>,
  key: string | undefined = provider.keyOf(env),
  signal?: AbortSignal,
): Promise<Response> {
  if (provider.call) return provider.call(env, body);
  return fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...provider.extraHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });
}

/** Not chat models: speech, embeddings, images, video, moderation. */
const NOT_CHAT =
  /whisper|tts|speech|audio|embed|guard|moderation|safety|imagen|image-generation|veo|lyria|playai|orpheus|transcribe|aqa|live|robotics|computer-use|nano-banana|-image\b/i;

async function getJson<T>(url: string, key?: string): Promise<T> {
  const res = await fetch(url, key ? { headers: { authorization: `Bearer ${key}` } } : {});
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json<T>();
}

interface OpenAiList {
  data: { id: string; context_window?: number; active?: boolean }[];
}

/** For providers whose catalog is OpenAI-shaped and carries no price. */
function openAiCatalog(baseUrl: string, evidence: string, stripPrefix = '') {
  return async (key: string): Promise<DiscoveredModel[]> => {
    const list = await getJson<OpenAiList>(`${baseUrl}/models`, key);
    return list.data
      .filter((m) => m.active !== false && !NOT_CHAT.test(m.id))
      .map((m) => {
        const model = m.id.startsWith(stripPrefix) ? m.id.slice(stripPrefix.length) : m.id;
        return {
          model,
          name: model,
          contextLength: m.context_window ?? null,
          tools: false,
          vision: false,
          evidence,
        };
      });
  };
}

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length?: number;
  pricing?: Record<string, string>;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
}

/** Free only when every listed price is exactly zero and the model reads and writes text. */
export function isOpenRouterFree(m: OpenRouterModel): boolean {
  const prices = Object.values(m.pricing ?? {});
  if (prices.length === 0 || prices.some((p) => Number(p) !== 0)) return false;
  const input = m.architecture?.input_modalities ?? ['text'];
  const output = m.architecture?.output_modalities ?? ['text'];
  return input.includes('text') && output.includes('text') && !NOT_CHAT.test(m.id);
}

export const PROVIDERS: Provider[] = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyOf: (env) => env.GROQ_API_KEY,
    freeBasis: 'probe',
    bonus: 3,
    discover: openAiCatalog(
      'https://api.groq.com/openai/v1',
      'Groq free plan key (console.groq.com/settings/limits); answered the quick test',
    ),
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyOf: (env) => env.CEREBRAS_API_KEY,
    freeBasis: 'probe',
    bonus: 3,
    discover: openAiCatalog(
      'https://api.cerebras.ai/v1',
      'Cerebras free plan key (cloud.cerebras.ai); answered the quick test',
    ),
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyOf: (env) => env.GEMINI_API_KEY,
    freeBasis: 'probe',
    bonus: 0,
    discover: openAiCatalog(
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'Gemini API key without billing (ai.google.dev/gemini-api/docs/rate-limits); answered the quick test',
      'models/',
    ),
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyOf: (env) => env.OPENROUTER_API_KEY,
    freeBasis: 'catalog',
    bonus: 0,
    extraHeaders: { 'X-Title': 'Bello AI' },
    discover: async (_key, env) => {
      const list = await getJson<{ data: OpenRouterModel[] }>('https://openrouter.ai/api/v1/models');
      // Same catalog carries every paid model's price: keep it for the paid models page.
      await savePaidCatalog(env, list.data);
      return list.data.filter(isOpenRouterFree).map((m) => ({
        model: m.id,
        name: m.name,
        contextLength: m.context_length ?? null,
        tools: m.supported_parameters?.includes('tools') ?? false,
        vision: m.architecture?.input_modalities?.includes('image') ?? false,
        evidence: 'OpenRouter catalog lists every price as 0 (openrouter.ai/api/v1/models)',
      }));
    },
  },
];

PROVIDERS.push({
  id: 'workers-ai',
  label: 'Cloudflare Workers AI',
  baseUrl: '',
  // No key: the AI binding is the credential. 'binding' only marks it as configured.
  keyOf: (env) => (env.AI ? 'binding' : undefined),
  freeBasis: 'allocation',
  // 10,000 neurons a day is small: keep it as the backup, not the first choice.
  bonus: -6,
  discover: (_key, env) => discoverWorkersAi(env),
  call: callWorkersAi,
});

export const providerById = (id: string): Provider | undefined =>
  PROVIDERS.find((p) => p.id === id);

export const configuredProviders = (env: Env): Provider[] =>
  PROVIDERS.filter((p) => Boolean(p.keyOf(env)));

/** Starting quality guess from the model name, before any feedback. 10..95. */
export function guessQuality(model: string): number {
  const id = model.toLowerCase();
  let q = 50;
  const sizes = [...id.matchAll(/(\d+(?:\.\d+)?)b\b/g)].map((m) => Number(m[1]));
  const total = sizes.length ? Math.max(...sizes) : null;
  if (total !== null) {
    if (total >= 200) q += 25;
    else if (total >= 60) q += 18;
    else if (total >= 25) q += 8;
    else if (total <= 9) q -= 15;
  }
  if (/\b(pro|ultra|large|max|maverick|opus)\b/.test(id)) q += 12;
  if (/\b(mini|nano|lite|small|tiny|instant)\b|flash-lite/.test(id)) q -= 10;
  if (/preview|experimental|-exp\b/.test(id)) q -= 3;
  return Math.max(10, Math.min(95, q));
}
