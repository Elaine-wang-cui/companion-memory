-- 抽卡匣：主题 + 条目 + 抽出记录。与 personas/memories 并列。

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE deck_items (
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
  CHECK (kind IN ('diary', 'novel', 'murmur', 'memory', 'chronicle', 'other')),
  CHECK (length(title) > 0),
  CHECK (length(content) > 0)
);

CREATE INDEX idx_deck_items_topic ON deck_items(topic_id, updated_at DESC);
CREATE UNIQUE INDEX idx_deck_items_source_page ON deck_items(source_page_id) WHERE source_page_id IS NOT NULL;

CREATE TABLE deck_draws (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES deck_items(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL,
  title TEXT NOT NULL,
  drawn_at TEXT NOT NULL,
  drawn_by TEXT,
  source TEXT NOT NULL CHECK (source IN ('mcp', 'rest', 'web'))
);

CREATE INDEX idx_deck_draws_drawn_at ON deck_draws(drawn_at DESC);

INSERT INTO topics (id, name, description, created_at, updated_at) VALUES
  ('diary', '日记', '日记、创作日记、对话日记、恋爱日记、各人格日记等', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z'),
  ('novel', '小说', '小说与创作页里的长篇作品', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z'),
  ('murmur', '碎碎念', '碎碎念与短想', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z'),
  ('memory', '记忆', '值得记住的片段', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z'),
  ('chronicle', '编年史', '家庭编年史按日的页', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
