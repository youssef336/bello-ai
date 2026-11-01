export interface Env {
  DB: D1Database;
  /** Cloudflare Workers AI; free daily allocation, no key. */
  AI?: Ai;
  ASSETS: Fetcher;
  OWNER_PASSWORD_HASH?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  GEMINI_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
}

export const now = (): number => Date.now();

export const newId = (): string => crypto.randomUUID();

export const today = (at: number = now()): string => new Date(at).toISOString().slice(0, 10);

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function error(status: number, message: string): Response {
  return json({ error: message }, status);
}
