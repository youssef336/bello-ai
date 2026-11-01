import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { callWorkersAi } from '../src/workers-ai';

const envWith = (run: (model: string, inputs: Record<string, unknown>) => unknown) =>
  ({ AI: { run: async (m: string, i: Record<string, unknown>) => run(m, i) } }) as unknown as Env;

const sse = (text: string) =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });

describe('callWorkersAi', () => {
  it('rewrites the stream as OpenAI deltas', async () => {
    const env = envWith(() => sse('data: {"response":"أهلاً"}\n\ndata: {"response":" يا"}\n\ndata: [DONE]\n\n'));
    const res = await callWorkersAi(env, { model: '@cf/x', messages: [], stream: true });
    const body = await res.text();
    expect(body).toContain('{"choices":[{"delta":{"content":"أهلاً"}}]}');
    expect(body).toContain('{"choices":[{"delta":{"content":" يا"}}]}');
    expect(body.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('wraps a plain answer as a chat completion', async () => {
    const env = envWith(() => ({ response: 'القاهرة' }));
    const res = await callWorkersAi(env, { model: '@cf/x', messages: [] });
    expect(await res.json()).toEqual({ choices: [{ message: { content: 'القاهرة' } }] });
  });

  it('turns the used-up daily allocation into a daily 429', async () => {
    const env = envWith(() => {
      throw new Error('4006: you have used up your daily free allocation of 10,000 neurons');
    });
    const res = await callWorkersAi(env, { model: '@cf/x', messages: [], stream: true });
    expect(res.status).toBe(429);
    expect(await res.text()).toMatch(/daily/);
  });

  it('marks paid-plan-only models as payment required', async () => {
    const env = envWith(() => {
      throw new Error('5035: Model @cf/x is not available on the Workers Free plan.');
    });
    expect((await callWorkersAi(env, { model: '@cf/x', messages: [] })).status).toBe(402);
  });
});
