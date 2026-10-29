-- Memory Garden: conversations, garden-native entries, voice metadata, persona emblems, favorites.

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  full_text TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  source_platform TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(title) > 0),
  CHECK (length(full_text) > 0)
);
CREATE INDEX IF NOT EXISTS idx_conversations_persona ON conversations(persona_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS garden_entries (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (kind IN ('memory', 'diary', 'promise', 'note')),
  CHECK (length(title) > 0),
  CHECK (length(body) > 0)
);
CREATE INDEX IF NOT EXISTS idx_garden_entries_persona ON garden_entries(persona_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS voice_clips (
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
CREATE INDEX IF NOT EXISTS idx_voice_clips_persona ON voice_clips(persona_id, created_at DESC);

CREATE TABLE IF NOT EXISTS garden_persona_meta (
  persona_id TEXT PRIMARY KEY,
  emblem TEXT NOT NULL DEFAULT 'rose',
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  CHECK (emblem IN ('cat', 'snake', 'rose', 'moon'))
);

CREATE TABLE IF NOT EXISTS garden_favorites (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_garden_fav_ref ON garden_favorites(kind, ref_id);
