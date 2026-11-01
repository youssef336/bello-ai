import { type Env, now } from './env';
import { callProvider, providerById } from './providers';
import type { ModelRow } from './router';

/**
 * A small exam per task type. Every active model takes it once (and again monthly); the router
 * then picks by measured skill for the kind of message, not by the model's name.
 * Three questions per task, one of them hard enough to separate good models from great ones.
 * Prompts ask for short answers so the exam is cheap on free quotas.
 */

export type BenchTask = 'code' | 'reasoning' | 'arabic';

interface Case {
  task: BenchTask;
  prompt: string;
  pass: (answer: string) => boolean;
}

const ARABIC_RATIO = (t: string) => {
  const ar = t.match(/[؀-ۿ]/g)?.length ?? 0;
  const latin = t.match(/[A-Za-z]/g)?.length ?? 0;
  return ar / Math.max(1, ar + latin);
};

export const CASES: Case[] = [
  {
    task: 'code',
    prompt:
      'Write a Python function is_palindrome(s) that returns True when s reads the same backwards, ignoring case. Reply with only the code.',
    pass: (a) => /def\s+is_palindrome\s*\(/.test(a) && /return/.test(a) && /lower|casefold/.test(a) && /\[::-1\]|reversed/.test(a),
  },
  {
    task: 'code',
    prompt: 'In JavaScript, what does [1, 2, 3].map(x => x * 2).filter(x => x > 2) return? Reply with only the array.',
    pass: (a) => /\[\s*4\s*,\s*6\s*\]/.test(a),
  },
  {
    task: 'code',
    prompt:
      "What does this Python print? Reply with only the output.\n\nd = {3: 'a', 1: 'b', 2: 'c'}\nprint(sorted(d.items(), key=lambda kv: kv[1], reverse=True)[0][0])",
    pass: (a) => /^\W*2\W*$/.test(a.replace(/```\w*/g, '').trim()),
  },
  {
    task: 'reasoning',
    prompt: 'How many times does the letter r appear in the word "strawberry"? Reply with just the number.',
    pass: (a) => /(^|\D)3(\D|$)/.test(a) && !/(^|\D)2(\D|$)/.test(a),
  },
  {
    task: 'reasoning',
    prompt:
      'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How many cents does the ball cost? Reply with just the number.',
    pass: (a) => /(^|\D)5(\D|$)/.test(a) && !/(^|\D)10(\D|$)/.test(a),
  },
  {
    task: 'reasoning',
    prompt: 'What is 17 × 24? Reply with just the number.',
    pass: (a) => /(^|\D)408(\D|$)/.test(a),
  },
  {
    task: 'arabic',
    prompt: 'رد بالعامية المصرية في جملة واحدة قصيرة: بتعمل إيه دلوقتي؟',
    pass: (a) => ARABIC_RATIO(a) > 0.7 && /(بعمل|دلوقتي|مش|عشان|علشان|كده|إيه|ايه|بقى|أهو|اهو|خالص|يعني|بتاع|قاعد|بذاكر|باكل|بشتغل)/.test(a),
  },
  {
    task: 'arabic',
    prompt: 'ما مفرد كلمة "أطباء"؟ أجب بكلمة واحدة فقط.',
    pass: (a) => /طبيب/.test(a) && !/أطباء$/.test(a.trim()),
  },
  {
    task: 'arabic',
    prompt: "ترجم إلى العربية الفصحى فقط، بدون أي شرح: 'The weather is beautiful today.'",
    pass: (a) => /(الطقس|الجو)/.test(a) && /(جميل|رائع)/.test(a) && /اليوم/.test(a),
  },
];

/** Reasoning models may put their thinking in the answer; only the final text counts. */
export const finalText = (a: string): string => a.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

async function ask(env: Env, m: ModelRow, prompt: string): Promise<string | null> {
  const provider = providerById(m.provider);
  if (!provider) return null;
  try {
    const res = await callProvider(
      provider,
      env,
      { model: m.model, messages: [{ role: 'user', content: prompt }], max_tokens: 1024, temperature: 0 },
      undefined,
      AbortSignal.timeout(60_000),
    );
    if (!res.ok) return null;
    const data = await res.json<{ choices?: { message?: { content?: string | null } }[] }>();
    return finalText(data.choices?.[0]?.message?.content ?? '');
  } catch {
    return null;
  }
}

export interface BenchResult {
  code: number;
  reasoning: number;
  arabic: number;
  /** Too many calls failed (rate limit, outage) to judge: not saved, tried again later. */
  incomplete: boolean;
}

export async function benchModel(env: Env, m: ModelRow): Promise<BenchResult> {
  const answers = await Promise.all(CASES.map((c) => ask(env, m, c.prompt)));
  const score = (task: BenchTask) => {
    const cases = CASES.map((c, i) => ({ c, a: answers[i] })).filter((x) => x.c.task === task);
    return Math.round((cases.filter((x) => typeof x.a === 'string' && x.c.pass(x.a)).length / cases.length) * 100);
  };
  return {
    code: score('code'),
    reasoning: score('reasoning'),
    arabic: score('arabic'),
    incomplete: answers.filter((a) => a === null).length > 3,
  };
}

const MONTH = 30 * 24 * 3600_000;
/** 9 calls per model; 4 models (36 calls) stay inside the 50-subrequest limit of one invocation. */
const MODELS_PER_RUN = 4;

/** Benchmark the active free models that have no scores yet (or month-old ones). */
export async function benchSome(env: Env, providers: string[]): Promise<{ done: string[]; left: number }> {
  if (!providers.length) return { done: [], left: 0 };
  const marks = providers.map(() => '?').join(',');
  const due = await env.DB.prepare(
    `SELECT * FROM models WHERE status = 'active' AND paid = 0 AND provider IN (${marks})
       AND (bench_at IS NULL OR bench_at < ?) ORDER BY bench_at IS NOT NULL, quality DESC`,
  ).bind(...providers, now() - MONTH).all<ModelRow>();
  const batch = due.results.slice(0, MODELS_PER_RUN);
  const results = await Promise.all(batch.map((m) => benchModel(env, m)));
  const done: string[] = [];
  const stmts = batch.flatMap((m, i) => {
    const r = results[i]!;
    if (r.incomplete) return [];
    done.push(m.id);
    return [env.DB.prepare(
      'UPDATE models SET score_code = ?, score_reasoning = ?, score_arabic = ?, bench_at = ? WHERE id = ?',
    ).bind(r.code, r.reasoning, r.arabic, now(), m.id)];
  });
  if (stmts.length) await env.DB.batch(stmts);
  return { done, left: due.results.length - done.length };
}
