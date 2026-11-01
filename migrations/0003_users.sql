-- Several people, one app: Google sign-in for invited emails, each with their own provider keys.
-- The original owner keeps the fixed id 'owner'; everything that existed so far is theirs.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,                 -- lower-case; NULL for the owner until they sign in with Google
  name TEXT,
  picture TEXT,
  role TEXT NOT NULL,                -- owner | member
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
INSERT INTO users (id, role, name, created_at) VALUES ('owner', 'owner', 'Owner', 0);

-- Emails the owner allowed in. A row here is an invitation until that person signs in.
CREATE TABLE invites (
  email TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
ALTER TABLE memories ADD COLUMN user_id TEXT NOT NULL DEFAULT 'owner';
CREATE INDEX idx_conversations_user ON conversations (user_id, updated_at);
CREATE INDEX idx_memories_user ON memories (user_id);

-- Provider API keys per user, AES-GCM encrypted with the KEYS_ENCRYPTION_KEY secret.
CREATE TABLE user_keys (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  key_enc TEXT NOT NULL,             -- base64(iv || ciphertext)
  key_hint TEXT NOT NULL,            -- last 4 characters, to recognise it
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- Rate limits belong to a key, so rests are per user and model.
CREATE TABLE cooldowns (
  user_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  until INTEGER NOT NULL,
  strikes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, model_id)
);

-- Usage per user: rebuild with user_id in the key.
CREATE TABLE usage_new (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  fallbacks INTEGER NOT NULL DEFAULT 0,
  tokens_est INTEGER NOT NULL DEFAULT 0,
  cost_est REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, model_id)
);
INSERT INTO usage_new (day, user_id, model_id, requests, failures, fallbacks, tokens_est, cost_est)
  SELECT day, 'owner', model_id, requests, failures, fallbacks, tokens_est, cost_est FROM usage;
DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;
