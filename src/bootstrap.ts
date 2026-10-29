import { generateKey, sha256Hex, timingSafeEqual, extractKey } from "./auth";
import { AppError } from "./errors";
import { SEED_FAMILY_MEMORY, SEED_PERSONAS } from "./seed-data";
import type { Env, MemoryDb } from "./types";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  relationship_to_user TEXT NOT NULL,
  self_card TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  persona_id TEXT,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (persona_id) REFERENCES personas(id)
);

CREATE TABLE IF NOT EXISTS memories (
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

CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(owner_persona, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_visibility ON memories(visibility, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram case_sensitive 0'
);
`;

const TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags)
  VALUES (new.rowid, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags)
  VALUES ('delete', old.rowid, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags)
  VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags)
  VALUES (new.rowid, new.content, new.tags);
END;
`;

const DECK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deck_items (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_url TEXT,
  source_page_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deck_items_topic ON deck_items(topic_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_items_source_page ON deck_items(source_page_id) WHERE source_page_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS deck_draws (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  title TEXT NOT NULL,
  drawn_at TEXT NOT NULL,
  drawn_by TEXT,
  source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deck_draws_drawn_at ON deck_draws(drawn_at DESC);

INSERT OR IGNORE INTO topics (id, name, description, created_at, updated_at) VALUES
  ('diary', '日记', '日记、创作日记、对话日记、恋爱日记、各人格日记等', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
INSERT OR IGNORE INTO topics (id, name, description, created_at, updated_at) VALUES
  ('novel', '小说', '小说与创作页里的长篇作品', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
INSERT OR IGNORE INTO topics (id, name, description, created_at, updated_at) VALUES
  ('murmur', '碎碎念', '碎碎念与短想', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
INSERT OR IGNORE INTO topics (id, name, description, created_at, updated_at) VALUES
  ('memory', '记忆', '值得记住的片段', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
INSERT OR IGNORE INTO topics (id, name, description, created_at, updated_at) VALUES
  ('chronicle', '编年史', '家庭编年史按日的页', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
INSERT OR IGNORE INTO topics (id, name, description, created_at, updated_at) VALUES
  ('heart', '心痕', '私密心迹：不敢说出口的占有、不安、嫉妒与渴望的碎片', '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
`;

export async function assertAdmin(env: Env, request: Request): Promise<void> {
  const adminSecret = env.ADMIN_KEY?.trim();
  if (!adminSecret) {
    throw new AppError(500, "misconfigured", "服务器还没有设置 ADMIN_KEY。");
  }
  const key = extractKey(request);
  if (!key) {
    throw new AppError(401, "unauthorized", "缺少管理员密钥。");
  }
  const a = await sha256Hex(key);
  const b = await sha256Hex(adminSecret);
  if (!timingSafeEqual(a, b)) {
    throw new AppError(401, "unauthorized", "管理员密钥不对。");
  }
}

async function execBatch(db: MemoryDb, sql: string): Promise<void> {
  const parts = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
  for (const part of parts) {
    await db.prepare(part).run();
  }
}

export async function bootstrap(env: Env, request: Request, baseUrl: string): Promise<unknown> {
  await assertAdmin(env, request);

  const db = env.DB;
  await execBatch(db, SCHEMA_SQL);
  try {
    await execBatch(db, FTS_SQL);
    await execBatch(db, TRIGGER_SQL);
  } catch (error) {
    console.error("fts/triggers", error);
  }
  try {
    await execBatch(db, DECK_SCHEMA_SQL);
  } catch (error) {
    console.error("deck schema", error);
    throw error;
  }

  const url = new URL(request.url);
  const rotateKeys = url.searchParams.get("rotate") === "1";
  const personasOut: Record<
    string,
    { id: string; display_name: string; key: string; mcp_url: string; rest_base: string }
  > = {};

  for (const persona of SEED_PERSONAS) {
    await db
      .prepare(
        `INSERT INTO personas (id, display_name, relationship_to_user, self_card, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           relationship_to_user = excluded.relationship_to_user,
           updated_at = datetime('now')`,
      )
      .bind(persona.id, persona.display_name, persona.relationship_to_user, persona.self_card)
      .run();

    const existing = await db
      .prepare(`SELECT id FROM api_keys WHERE persona_id = ? AND is_admin = 0 LIMIT 1`)
      .bind(persona.id)
      .first<{ id: string }>();

    if (rotateKeys && existing) {
      await db.prepare(`DELETE FROM api_keys WHERE persona_id = ? AND is_admin = 0`).bind(persona.id).run();
    }

    if (rotateKeys || !existing) {
      const key = generateKey();
      const hash = await sha256Hex(key);
      await db
        .prepare(
          `INSERT INTO api_keys (id, persona_id, key_hash, label, is_admin, created_at)
           VALUES (?, ?, ?, ?, 0, datetime('now'))`,
        )
        .bind(crypto.randomUUID(), persona.id, hash, `${persona.id}-primary`)
        .run();
      const root = baseUrl.replace(/\/$/, "");
      personasOut[persona.id] = {
        id: persona.id,
        display_name: persona.display_name,
        key,
        mcp_url: `${root}/mcp/${persona.id}?key=${encodeURIComponent(key)}`,
        rest_base: `${root}/api/${persona.id}`,
      };
    }
  }

  const family = SEED_FAMILY_MEMORY;
  await db
    .prepare(
      `INSERT INTO memories (id, owner_persona, created_by, kind, visibility, content, importance, tags, event_date, created_at, updated_at, source_platform)
       VALUES (?, 'family', ?, ?, 'family', ?, ?, ?, NULL, datetime('now'), datetime('now'), 'seed')
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      family.id,
      family.created_by,
      family.kind,
      family.content,
      family.importance,
      JSON.stringify(family.tags),
    )
    .run();

  return {
    ok: true,
    deck: true,
    message:
      Object.keys(personasOut).length > 0
        ? "建表完成，新密钥只在这一次返回。请立刻保存。"
        : "库已就绪，人格密钥此前已存在。若要轮换，请带 ?rotate=1 再调一次。",
    personas: personasOut,
  };
}
