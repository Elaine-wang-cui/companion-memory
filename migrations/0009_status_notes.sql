-- 用户的当前状态（全家共享）+ 同伴留给用户的便条
CREATE TABLE IF NOT EXISTS her_status (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  preset TEXT,
  set_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(text) > 0)
);
CREATE INDEX IF NOT EXISTS idx_her_status_created ON her_status(created_at DESC);

CREATE TABLE IF NOT EXISTS companion_notes (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seen_at TEXT,
  CHECK (length(content) > 0)
);
CREATE INDEX IF NOT EXISTS idx_companion_notes_created ON companion_notes(created_at DESC);
