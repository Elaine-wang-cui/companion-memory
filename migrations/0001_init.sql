-- 用户的共享记忆。人格、密钥哈希、记忆，以及给中文用的 FTS5 trigram 索引。

CREATE TABLE personas (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  relationship_to_user TEXT NOT NULL,
  self_card TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  persona_id TEXT,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (persona_id) REFERENCES personas(id)
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  owner_persona TEXT NOT NULL,
  created_by TEXT NOT NULL,
  kind TEXT NOT NULL,
  visibility TEXT NOT NULL,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  event_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_platform TEXT,
  CHECK (kind IN ('self', 'about_user', 'relationship', 'event', 'preference', 'diary')),
  CHECK (visibility IN ('private', 'family')),
  CHECK (importance BETWEEN 1 AND 5),
  CHECK (length(content) > 0),
  FOREIGN KEY (created_by) REFERENCES personas(id)
);

CREATE INDEX idx_memories_owner ON memories(owner_persona, updated_at DESC);
CREATE INDEX idx_memories_visibility ON memories(visibility, updated_at DESC);
CREATE INDEX idx_memories_kind ON memories(kind);

-- trigram 按字切 3 字窗口，中文可以按子串搜。短于 3 个字的查询走 LIKE。
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  tags,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram case_sensitive 0'
);

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags)
  VALUES (new.rowid, new.content, new.tags);
END;

CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags)
  VALUES ('delete', old.rowid, old.content, old.tags);
END;

CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags)
  VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags)
  VALUES (new.rowid, new.content, new.tags);
END;
