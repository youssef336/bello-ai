import type { Env } from './env';
import type { DiscoveredModel } from './providers';

/**
 * Cloudflare Workers AI through the `AI` binding: no key, and the Workers Free plan's daily
 * allocation (10,000 neurons) fails with an error when used up — it never bills.
 * The binding speaks its own format; this file makes it look like an OpenAI-compatible endpoint
 * so the rest of the app does not care which provider it is talking to.
 */

const EVIDENCE =
  'Workers Free daily allocation, 10,000 neurons/day; over it requests fail, never bill ' +
  '(developers.cloudflare.com/workers-ai/platform/pricing)';

const NOT_CHAT = /lora|guard|embed|whisper|tts|vision-only|resnet|detr|bart|m2m|distilbert|unum/i;

export async function discoverWorkersAi(env: Env): Promise<DiscoveredModel[]> {
  if (!env.AI) return [];
  const models = await env.AI.models({ task: 'Text Generation', per_page: 200 });
  return models
    .filter((m) => !NOT_CHAT.test(m.name))
    .map((m) => {
      const prop = (id: string) => m.properties.find((p) => p.property_id === id)?.value;
      const context = Number(prop('context_window') ?? prop('max_input_tokens') ?? NaN);
      return {
        model: m.name,
        name: m.name.replace(/^@cf\/|^@hf\//, ''),
        contextLength: Number.isFinite(context) ? context : null,
        tools: prop('function_calling') === 'true',
        vision: /vision|llava/i.test(m.name),
        evidence: EVIDENCE,
      };
    });
}

function errorResponse(e: unknown): Response {
  const message = String(e instanceof Error ? e.message : e);
  // 4006 = daily free allocation used up. Report it as a daily rate limit so the model rests.
  const status = /4006|daily free allocation|neurons/i.test(message)
    ? 429
    : /5035|not available on the Workers Free plan/i.test(message)
      ? 402 // paid-plan-only model → marked paid, re-checked weekly
      : /not found|no such model|5007/i.test(message)
        ? 404
        : /5006|required properties/i.test(message)
          ? 400 // not a chat model (different input schema)
          : 500;
  const text = status === 429 ? `${message} (daily limit)` : message;
  return new Response(JSON.stringify({ error: { message: text } }), { status });
}

const contentOf = (out: Record<string, unknown>): string => {
  if (typeof out.response === 'string') return out.response;
  const choices = out.choices as { message?: { content?: string } }[] | undefined;
  return choices?.[0]?.message?.content ?? '';
};

/** OpenAI-shaped Response for a `/chat/completions` body, streamed or not. */
export async function callWorkersAi(env: Env, body: Record<string, unknown>): Promise<Response> {
  if (!env.AI) return new Response('{"error":{"message":"AI binding missing"}}', { status: 401 });
  const model = String(body.model);
  const inputs: Record<string, unknown> = { messages: body.messages };
  if (body.max_tokens) inputs.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) inputs.temperature = body.temperature;

  try {
    if (!body.stream) {
      const out = (await env.AI.run(model as never, inputs)) as Record<string, unknown>;
      return Response.json({ choices: [{ message: { content: contentOf(out) } }] });
    }
    const stream = (await env.AI.run(model as never, { ...inputs, stream: true } as never)) as ReadableStream;
    // Workers AI sends `data: {"response":"…"}`; rewrite each event as an OpenAI delta.
    let buffer = '';
    const encoder = new TextEncoder();
    const rewrite = new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const event = JSON.parse(payload) as Record<string, unknown>;
            const text = typeof event.response === 'string' ? event.response : null;
            const out = text !== null ? { choices: [{ delta: { content: text } }] } : event;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n\n`));
          } catch {
            // Partial or non-JSON line: skip.
          }
        }
      },
      flush(controller) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      },
    });
    return new Response(stream.pipeThrough(new TextDecoderStream()).pipeThrough(rewrite), {
      headers: { 'content-type': 'text/event-stream' },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
