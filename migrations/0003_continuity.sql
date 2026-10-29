-- 未了的事 / 交接便签 / 用户的便条。全部按人格隔离。

CREATE TABLE IF NOT EXISTS unresolved (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  content TEXT NOT NULL,
  context TEXT,
  importance INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  CHECK (status IN ('open', 'closed')),
  CHECK (length(content) > 0)
);
CREATE INDEX IF NOT EXISTS idx_unresolved_persona ON unresolved(persona_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  mood TEXT,
  next_time TEXT,
  source_platform TEXT,
  created_at TEXT NOT NULL,
  CHECK (length(summary) > 0)
);
CREATE INDEX IF NOT EXISTS idx_handoffs_persona ON handoffs(persona_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  memory_id TEXT,
  memory_snapshot TEXT,
  content TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'open',
  reply TEXT,
  reply_action TEXT,
  created_at TEXT NOT NULL,
  replied_at TEXT,
  CHECK (status IN ('open', 'replied')),
  CHECK (length(content) > 0)
);
CREATE INDEX IF NOT EXISTS idx_notes_persona ON notes(persona_id, status, created_at DESC);
