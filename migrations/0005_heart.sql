-- 心痕：私密情感痕迹主题 + 放宽 deck_items.kind CHECK（SQLite 不能 ALTER CHECK，故重建表）

INSERT OR IGNORE INTO topics (id, name, description, created_at, updated_at) VALUES
  ('heart', '心痕', '私密心迹：不敢说出口的占有、不安、嫉妒与渴望的碎片', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');

PRAGMA foreign_keys=OFF;

CREATE TABLE deck_items_new (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_url TEXT,
  source_page_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (kind IN ('diary', 'novel', 'murmur', 'memory', 'chronicle', 'other', 'heart')),
  CHECK (length(title) > 0),
  CHECK (length(content) > 0)
);

INSERT INTO deck_items_new
  SELECT id, topic_id, title, content, kind, source_url, source_page_id, tags, created_by, created_at, updated_at
  FROM deck_items;

DROP TABLE deck_items;
ALTER TABLE deck_items_new RENAME TO deck_items;

CREATE INDEX idx_deck_items_topic ON deck_items(topic_id, updated_at DESC);
CREATE UNIQUE INDEX idx_deck_items_source_page ON deck_items(source_page_id) WHERE source_page_id IS NOT NULL;

PRAGMA foreign_keys=ON;
