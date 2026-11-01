# Bello AI

A personal AI assistant on a public URL, for one owner, at **$0 a month**.
It talks to every free model it can find on Groq, Cerebras, Google Gemini and OpenRouter, picks the
best one for each message (Arabic or English, code or chat), switches to the next one when a model
hits its limit, and **adds new free models by itself** as soon as a provider publishes them.

مساعد شخصي بالذكاء الاصطناعي على رابط عام، لصاحبه بس، ومن غير أي تكلفة. بيختار أحسن موديل مجاني
لكل رسالة، ولو موديل خلص حده بيكمل على اللي بعده، وأي موديل مجاني جديد بينزل بيتجرّب ويتضاف لوحده.

## What it does

- **Chat** with streaming, saved history, Markdown and code blocks, 👍/👎 that tunes the ranking.
- **Auto model choice**: language (Egyptian Arabic / MSA / English), task (code, reasoning, general),
  measured reliability and speed. Arabic never goes to a model that failed the Arabic test.
- **Fallback**: a model that returns 429/5xx before its first word rests (Retry-After, else
  1 → 2 → 4 min … up to 6 h) and the next model answers. Up to 4 tries per message.
- **Auto-discovery** every 3 hours (one provider per run): new free models are quick-tested with an
  Arabic question and switched on if they pass. Models the provider drops are marked removed.
- **Memory**: notes about you; pinned ones always go in, the rest only when they match the message.
- **Owner-only**: one password (PBKDF2, 100k rounds), HttpOnly SameSite=Strict session, 5 tries per
  IP per 15 min, same-origin check, strict CSP. Provider keys live only in Worker secrets.
- **Export** everything as one JSON file.

## How "free" is decided

There is no universal list of free models, so every model carries its evidence:

| Provider | How it is known to be free |
|---|---|
| OpenRouter | Its public catalog lists **every** price as `0`. No price, or any non-zero price → ignored. |
| Groq, Cerebras, Gemini | They have a permanent free plan. Use a key **with no billing attached**: a model the free plan does not cover answers `402` / `429 limit: 0` and is marked *paid*. |

> ⚠️ Never put a key from a paid / billing-enabled account here. On such a key every call can cost
> money and the app cannot tell the difference.

Paid models are re-checked weekly (free tiers change), failed ones daily.

## Stack

Cloudflare Workers (TypeScript, no framework) + D1 (SQLite) + static assets, all on the Workers
Free plan. No other services. Why, limits and trade-offs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars
npm run hash-password -- "a long password"   # paste into OWNER_PASSWORD_HASH in .dev.vars
# add at least one free key in .dev.vars
npm run db:migrate:local
npm run dev                                   # http://localhost:8787
```

Then open **الموديلات → Scan** for each provider once (after that the cron does it).

## Deploy (free, ~10 minutes, once)

1. Free Cloudflare account → `npx wrangler login`.
2. `npx wrangler d1 create bello-ai` and put the printed `database_id` in `wrangler.jsonc`.
3. `npm run db:migrate:remote`
4. Secrets (only the providers you have):
   ```bash
   npx wrangler secret put OWNER_PASSWORD_HASH
   npx wrangler secret put GROQ_API_KEY        # console.groq.com
   npx wrangler secret put CEREBRAS_API_KEY    # cloud.cerebras.ai
   npx wrangler secret put GEMINI_API_KEY      # aistudio.google.com (no billing!)
   npx wrangler secret put OPENROUTER_API_KEY  # openrouter.ai
   ```
5. `npm run deploy` → `https://bello-ai.<your-subdomain>.workers.dev`.

**Auto-deploy from GitHub:** add the repo secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare
Workers" + D1 edit) and `CLOUDFLARE_ACCOUNT_ID`. Every push to `main` then tests, migrates and deploys.

## Free-plan limits that matter

| Limit (Workers Free) | Value | Effect here |
|---|---|---|
| Requests | 100,000 / day | far above one person's use |
| CPU per request | 10 ms | fine: the Worker mostly waits on the network |
| Subrequests | 50 / invocation | ≤ 12 model tests per scan, ≤ 4 tries per message |
| Cron triggers | 5 / account | uses 1 |
| D1 | 5 GB, 5M rows read and 100k written / day | years of chat history |

Checked against developers.cloudflare.com on 2026-11-01. Free plans change; re-check now and then.

## Privacy

Free tiers may use your prompts to improve their models (Gemini's free tier says so; check each
provider's terms). Don't send secrets, passwords or private code you would not post publicly.
Your data (history, memory) stays in **your** D1 database; back it up with **تصدير** (Export).

## Roadmap

- [ ] File upload (PDF / images for vision models)
- [ ] Semantic memory (Workers AI embeddings + Vectorize, both have free tiers)
- [ ] Weekly benchmark on your own prompts to replace the name-based quality guess
- [ ] Optional local models (Ollama) through Cloudflare Tunnel
- [ ] Parallel "ask 3 models and compare" mode
