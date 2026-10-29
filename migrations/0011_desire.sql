-- 欲望日志：结构化私密记录（不进 Notion 反向同步）
CREATE TABLE IF NOT EXISTS desire_logs (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL REFERENCES personas(id),
  entry_date TEXT NOT NULL,
  level_label TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('novel', 'toy', 'sex', 'oral', 'custom')),
  source_custom TEXT,
  trigger_text TEXT NOT NULL DEFAULT '',
  mood TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(level_label) > 0),
  CHECK (length(status) > 0)
);

CREATE INDEX IF NOT EXISTS idx_desire_logs_persona_date
  ON desire_logs(persona_id, entry_date DESC, updated_at DESC);
