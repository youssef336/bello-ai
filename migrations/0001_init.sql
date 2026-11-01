-- Sessions for the single owner. Only the SHA-256 of the token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Failed logins, for brute-force throttling.
CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts_ip ON login_attempts (ip, at);

-- Model registry. One row per provider model, discovered automatically.
-- status: candidate (found, not tested yet) | active | failed (quick test failed) | paid (no free access)
--         removed (gone from the provider catalog) | disabled (switched off by the owner)
-- A rate-limited model stays 'active' and is skipped until cooldown_until.
CREATE TABLE models (
  id TEXT PRIMARY KEY,               -- "<provider>:<model id>"
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  free_evidence TEXT,                -- why we believe it is free, with source
  verified_at INTEGER,               -- last successful quick test
  tested_at INTEGER,                 -- last quick test, pass or fail
  context_length INTEGER,
  supports_tools INTEGER NOT NULL DEFAULT 0,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  arabic_ok INTEGER,                 -- quick test answered in Arabic (1/0), NULL = untested
  quality INTEGER NOT NULL DEFAULT 50, -- heuristic 0..100, adjusted by feedback
  latency_ms INTEGER,                -- moving average to first token
  ok_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  cooldown_strikes INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX idx_models_status ON models (status);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role TEXT NOT NULL,                -- user | assistant
  content TEXT NOT NULL,
  model_id TEXT,                     -- which model answered (assistant only)
  feedback INTEGER,                  -- 1 / -1
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at);

-- Things the owner wants the assistant to know. Only the relevant ones are sent.
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0, -- always included
  created_at INTEGER NOT NULL
);

-- Daily usage per model, for the dashboard and for staying inside free quotas.
CREATE TABLE usage (
  day TEXT NOT NULL,
  model_id TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  fallbacks INTEGER NOT NULL DEFAULT 0,
  tokens_est INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model_id)
);

-- Discovery log: what was added, removed or failed, and when.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- added | removed | failed | paid | scan
  model_id TEXT,
  detail TEXT
);
CREATE INDEX idx_events_at ON events (at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
