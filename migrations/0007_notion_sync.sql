-- 记忆屋 → Notion 反向同步：人格主页映射 + 出站队列（Worker 不持 Notion token，由 bot routine 创建页后 ACK）

CREATE TABLE IF NOT EXISTS persona_notion (
  persona_id TEXT PRIMARY KEY,
  notion_page_id TEXT,
  notion_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notion_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  local_id TEXT NOT NULL,
  persona_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  notion_page_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (kind IN ('persona', 'conversation', 'garden_entry', 'deck_item', 'memory')),
  CHECK (status IN ('pending', 'synced', 'skipped', 'error'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notion_outbox_kind_local ON notion_outbox(kind, local_id);
CREATE INDEX IF NOT EXISTS idx_notion_outbox_status ON notion_outbox(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_persona_notion_page ON persona_notion(notion_page_id);

-- (no seed data, the optional Notion mirror is not shipped)
