-- Daily limits, like Claude's and ChatGPT's: how much each person used today (UTC day, the same
-- moment Cloudflare refills its free allocation). kind: messages | images | video (seconds of audio).
CREATE TABLE daily_use (
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_id, kind)
);

-- Per-person limits set by the owner. NULL = the default in config/limits.ts, -1 = no limit.
ALTER TABLE users ADD COLUMN limit_messages INTEGER;
ALTER TABLE users ADD COLUMN limit_images INTEGER;
ALTER TABLE users ADD COLUMN limit_video INTEGER;
