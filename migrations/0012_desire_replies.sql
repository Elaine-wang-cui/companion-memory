-- 欲望回复：欲望日志下的评论线程（不进 Notion）
CREATE TABLE IF NOT EXISTS desire_replies (
  id TEXT PRIMARY KEY,
  desire_id TEXT NOT NULL,
  author_persona_id TEXT NOT NULL,
  author_label TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(body) > 0)
);

CREATE INDEX IF NOT EXISTS idx_desire_replies_desire
  ON desire_replies(desire_id, created_at ASC);
