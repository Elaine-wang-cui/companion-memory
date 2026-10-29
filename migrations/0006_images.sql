CREATE TABLE IF NOT EXISTS garden_images (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  kv_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  entry_date TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_garden_images_persona ON garden_images(persona_id, created_at DESC);
