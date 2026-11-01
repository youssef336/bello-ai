# Bello AI — Architecture

Checked on 2026-11-01. Items marked [Verify] change often; re-check them before relying on them.

## Shape

```
Browser (phone / desktop)
   │  HTTPS, session cookie
   ▼
Cloudflare Worker  ── static assets (public/: index.html, app.js, style.css)
   │   /api/*  auth → routes
   │   ├─ chat.ts       history + memories → rank → stream with fallback → save
   │   ├─ router.ts     score models (language, task, reliability, speed, cooldown)
   │   ├─ discovery.ts  catalog scan → quick test → active / paid / failed / removed
   │   ├─ images.ts     draw / edit on Workers AI FLUX (counts against the daily image limit)
   │   ├─ transcribe.ts Whisper subtitles for the video page (counts seconds of sound)
   │   ├─ limits.ts     daily limits per person, reset 00:00 UTC
   │   └─ auth.ts       password, sessions, login throttle
   │
   ├── D1 (SQLite): sessions, models, conversations, messages, memories, usage, events
   └── fetch → Groq · Cerebras · Gemini (OpenAI-compatible) · OpenRouter
Cron (every 3 h) → scan one provider (round-robin) + cleanup
```

One request, end to end:

```
message → detect language + task → relevant memories + trimmed history
       → rank active models (max 4, max 2 per provider)
       → try #1 ─ 429/5xx/empty before first word → cooldown, try #2 …
       → stream tokens over SSE → save answer + latency + usage
```

## Decisions

| Decision | Why | Alternatives | Risks | Reversibility |
|---|---|---|---|---|
| Cloudflare Workers Free for everything | One free platform for HTTPS, API, static files, DB and cron; no sleeping, no credit card | GitHub Pages + separate backend; Vercel/Netlify functions; Supabase | Free-plan limits change [Verify]; 10 ms CPU | Medium: the code is plain `fetch` + SQL, portable to any Node/Bun host with SQLite |
| No GitHub Pages | Static only: cannot hold keys, run the router or a DB, so it would still need this Worker | Frontend on Pages, API here | Two deploys, CORS, cookies across sites | Easy |
| TypeScript, no framework, not FastAPI | Workers run JS natively; Python Workers are newer and limited. The app is ~1k lines | FastAPI on a free host (most sleep or need a card) | Fewer ready-made libraries | Medium |
| D1 | Free 5 GB SQLite, migrations in repo, export via the app | Supabase Postgres (pauses after a week idle on free [Verify]) | Daily row caps enforced since 2026-09-01 | Easy: standard SQL |
| Own small router, not LiteLLM / Open WebUI | Free-model discovery, evidence, Arabic gating and cooldowns are the point of the project; those tools need an always-on server | Open WebUI + LiteLLM on a VPS | Less UI polish | — |
| Auto-add new free models | Owner's explicit wish; safe because a model is only "free" with evidence and only active after passing a test | Owner approves each model | A bad model slips in → feedback and reliability push it down; owner can disable | Easy |
| Pictures and subtitles on Workers AI only | The one provider whose free plan covers image models and Whisper with no key and never bills; tested 2026-11-01 | Gemini image models (developers report a free-tier quota of 0), Pollinations (generation needs a key that spends Pollen credits) | 10k neurons/day shared by everyone → daily limits | Easy: `images.ts` is one model list |
| Video edited in the browser | Free, private (the video never leaves the phone), no Worker CPU limit to fight | ffmpeg on a server (no free host runs it within limits) | Needs WebCodecs (Chrome, Safari 26+) | Easy |
| Rule-based routing | No extra LLM call per message, explainable | Classifier / LLM router | Name-based quality guess is rough | Easy |
| Password + session instead of Cloudflare Access | Works on `workers.dev` with no extra setup | Cloudflare Access (Zero Trust, free ≤ 50 users) | Password strength is on the owner | Easy: put Access in front later |

## What is deliberately not here (yet)

- Multi-agent / debate: adds quota use and latency; no evidence it helps a personal chat.
- Long autonomous tasks: a Worker request lives while it streams, but jobs that run for many minutes
  need Queues/Workflows; add only when there is a real task that needs it.
- Vector search: keyword memory is enough for dozens of notes. Vectorize + Workers AI embeddings
  are the free path when it is not.
- Local models: the public app must not depend on the PC. Ollama on a GTX 1660 Ti (6 GB) runs 7–8B
  models at Q4; a Cloudflare Tunnel with Access would be the safe way to plug it in.

## Failure modes

| What happens | Effect | Recovery |
|---|---|---|
| One model rate-limited | Cooldown, next model answers | Automatic |
| A provider is down | Its models cool down; others answer | Automatic |
| A provider's key is revoked | Scan reports "API key rejected"; models untouched | Put a new secret |
| Model removed upstream | Marked *removed* at the next scan; 404 in chat marks it *failed* at once | Automatic |
| Free plan becomes paid upstream | OpenRouter: price ≠ 0 → no longer listed. Others: `402`/`limit: 0` → *paid* | Automatic |
| Workers / D1 free limits change | App errors when exceeded | Re-check limits; Workers Paid is $5/mo, owner's choice |
| D1 database deleted | History lost | Restore from the JSON export (keep one regularly); D1 Time Travel keeps 7 days on free [Verify] |
