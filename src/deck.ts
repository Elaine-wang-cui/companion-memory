import { schemaCurrent } from "./schema-gate";
import { AppError } from "./errors";
import { isNotionSourcedDeckItem, safeEnqueueNotionOutbox } from "./notion-sync";
import { codePointLength, likePattern, parseTags } from "./format";
import type { Caller, DeckItem, DeckItemRow, DeckKind, MemoryDb, Topic } from "./types";
import { DECK_KINDS, PERSONA_ID_RE, RESERVED_IDS, TOPIC_ID_RE } from "./types";
import { ensurePersonaPlaceholder } from "./admin-personas";
import { buildAliasIndex, matchPersonaId } from "./persona-roster";

const MAX_CONTENT = 50_000;
const ITEM_COLUMNS = `id, topic_id, title, content, kind, source_url, source_page_id, tags, created_by, owner_persona, created_at, updated_at`;

export type DrawSource = "mcp" | "rest" | "web";

const KIND_TO_TOPIC: Record<DeckKind, string> = {
  diary: "diary",
  novel: "novel",
  murmur: "murmur",
  memory: "memory",
  chronicle: "chronicle",
  other: "memory",
  heart: "heart",
};

const HEART_TOPIC = {
  id: "heart",
  name: "心痕",
  description: "私密心迹：不敢说出口的占有、不安、嫉妒与渴望的碎片",
} as const;

const HEART_CONTENT_MAX = 3000;
const HEART_TITLE_MAX = 30;

let heartTopicReady: Promise<void> | null = null;
let deckOwnerReady: Promise<void> | null = null;
let topicParentReady: Promise<void> | null = null;

/** Ensure topics.parent_id exists (novel subcategories). */
export function ensureTopicParentColumn(db: MemoryDb): Promise<void> {
  if (!topicParentReady) {
    topicParentReady = (async () => {
      if (await schemaCurrent(db)) return;
      const colInfo = await db.prepare(`PRAGMA table_info(topics)`).all<{ name: string }>();
      const hasParent = (colInfo.results ?? []).some((c) => c.name === "parent_id");
      if (!hasParent) {
        await db.prepare(`ALTER TABLE topics ADD COLUMN parent_id TEXT`).run();
      }
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_topics_parent ON topics(parent_id)`).run();
    })().catch((error) => {
      topicParentReady = null;
      throw error;
    });
  }
  return topicParentReady;
}

type TopicNode = { id: string; parent_id: string | null };

async function loadTopicNodes(db: MemoryDb): Promise<TopicNode[]> {
  await ensureTopicParentColumn(db);
  const result = await db
    .prepare(`SELECT id, parent_id FROM topics`)
    .all<{ id: string; parent_id: string | null }>();
  return (result.results ?? []).map((r) => ({
    id: r.id,
    parent_id: r.parent_id ?? null,
  }));
}

/** All topic ids in the novel family (novel itself + descendants). */
export async function loadNovelFamilyIds(db: MemoryDb): Promise<Set<string>> {
  const nodes = await loadTopicNodes(db);
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    const list = children.get(n.parent_id) ?? [];
    list.push(n.id);
    children.set(n.parent_id, list);
  }
  const out = new Set<string>(["novel"]);
  const queue = ["novel"];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const child of children.get(cur) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return out;
}

/** topicId and all descendants (for list/draw filter). */
export async function topicDescendantIds(db: MemoryDb, topicId: string): Promise<string[]> {
  const nodes = await loadTopicNodes(db);
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    const list = children.get(n.parent_id) ?? [];
    list.push(n.id);
    children.set(n.parent_id, list);
  }
  const out: string[] = [];
  const queue = [topicId];
  const seen = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const child of children.get(cur) ?? []) queue.push(child);
  }
  return out;
}

export function isNovelSharedItem(
  row: { topic_id: string; kind: string },
  novelFamily: Set<string>,
): boolean {
  return row.kind === "novel" || novelFamily.has(row.topic_id);
}

async function widenDeckKindCheck(db: MemoryDb): Promise<void> {
  const row = await db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deck_items'`)
    .first<{ sql: string | null }>();
  const sql = row?.sql ?? "";
  // No CHECK, or CHECK already lists heart → nothing to do
  if (!sql.includes("CHECK") || sql.includes("'heart'")) return;

  const colInfo = await db.prepare(`PRAGMA table_info(deck_items)`).all<{ name: string }>();
  const hasOwner = (colInfo.results ?? []).some((c) => c.name === "owner_persona");

  await db.prepare(`PRAGMA foreign_keys=OFF`).run();
  await db
    .prepare(
      hasOwner
        ? `CREATE TABLE deck_items_new (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES topics(id),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_url TEXT,
        source_page_id TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        created_by TEXT,
        owner_persona TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (kind IN ('diary', 'novel', 'murmur', 'memory', 'chronicle', 'other', 'heart')),
        CHECK (length(title) > 0),
        CHECK (length(content) > 0)
      )`
        : `CREATE TABLE deck_items_new (
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
      )`,
    )
    .run();
  await db
    .prepare(
      hasOwner
        ? `INSERT INTO deck_items_new
        SELECT id, topic_id, title, content, kind, source_url, source_page_id, tags, created_by, owner_persona, created_at, updated_at
        FROM deck_items`
        : `INSERT INTO deck_items_new
        SELECT id, topic_id, title, content, kind, source_url, source_page_id, tags, created_by, created_at, updated_at
        FROM deck_items`,
    )
    .run();
  await db.prepare(`DROP TABLE deck_items`).run();
  await db.prepare(`ALTER TABLE deck_items_new RENAME TO deck_items`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_deck_items_topic ON deck_items(topic_id, updated_at DESC)`).run();
  await db
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_items_source_page ON deck_items(source_page_id) WHERE source_page_id IS NOT NULL`,
    )
    .run();
  if (hasOwner) {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_deck_items_owner ON deck_items(owner_persona)`).run();
  }
  await db.prepare(`PRAGMA foreign_keys=ON`).run();
}

/** Ensure topic `heart` exists and kind CHECK allows it (runtime, like garden ensureSchema). */
export function ensureHeartTopic(db: MemoryDb): Promise<void> {
  if (!heartTopicReady) {
    heartTopicReady = (async () => {
      if (await schemaCurrent(db)) return;
      const now = "2026-10-21T00:00:00.000Z";
      await db
        .prepare(
          `INSERT OR IGNORE INTO topics (id, name, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(HEART_TOPIC.id, HEART_TOPIC.name, HEART_TOPIC.description, now, now)
        .run();
      try {
        await widenDeckKindCheck(db);
      } catch (error) {
        console.error("widenDeckKindCheck", error);
      }
    })().catch((error) => {
      heartTopicReady = null;
      throw error;
    });
  }
  return heartTopicReady;
}

function clipChars(value: string, max: number): string {
  const chars = [...value.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** Ensure deck_items.owner_persona exists and backfill from title/tags/created_by. */
export function ensureDeckOwnerColumn(db: MemoryDb): Promise<void> {
  if (!deckOwnerReady) {
    deckOwnerReady = (async () => {
      if (await schemaCurrent(db)) return;
      await ensureTopicParentColumn(db);
      await ensureHeartTopic(db);
      const colInfo = await db.prepare(`PRAGMA table_info(deck_items)`).all<{ name: string }>();
      const hasOwner = (colInfo.results ?? []).some((c) => c.name === "owner_persona");
      if (!hasOwner) {
        await db.prepare(`ALTER TABLE deck_items ADD COLUMN owner_persona TEXT`).run();
      }
      await db.prepare(`CREATE INDEX IF NOT EXISTS idx_deck_items_owner ON deck_items(owner_persona)`).run();

      const pending = await db
        .prepare(
          `SELECT id, topic_id, title, tags, created_by FROM deck_items
           WHERE owner_persona IS NULL OR owner_persona = ''`,
        )
        .all<{
          id: string;
          topic_id: string;
          title: string;
          tags: string;
          created_by: string | null;
        }>();
      const rows = pending.results ?? [];
      if (rows.length === 0) return;

      const personas =
        (
          await db
            .prepare(`SELECT id, display_name FROM personas`)
            .all<{ id: string; display_name: string }>()
        ).results ?? [];
      const aliasIndex = buildAliasIndex(personas);
      const knownIds = new Set(personas.map((p) => p.id));

      for (const item of rows) {
        let owner: string | null = null;
        if (item.topic_id === "chronicle") {
          owner = "family";
        } else {
          owner = matchPersonaId(item.title, item.tags, item.created_by, aliasIndex, knownIds);
        }
        if (owner) {
          await db.prepare(`UPDATE deck_items SET owner_persona = ? WHERE id = ?`).bind(owner, item.id).run();
        }
      }
    })().catch((error) => {
      deckOwnerReady = null;
      throw error;
    });
  }
  return deckOwnerReady;
}

/** Non-admin / non-house / non-lantern: only own cards; no chronicle. */
function isDeckScoped(caller: Caller | null): boolean {
  if (!caller || caller.isAdmin) return false;
  const id = caller.persona.id;
  return id !== "house" && id !== "lantern";
}

/** Non-admin callers must not see others' heart traces in deck list/draw. */
function appendHeartPrivacy(clauses: string[], params: unknown[], caller: Caller | null): void {
  if (!caller || caller.isAdmin) return;
  clauses.push("(topic_id != 'heart' OR created_by = ?)");
  params.push(caller.persona.id);
}

function appendDeckOwnerPrivacy(
  clauses: string[],
  params: unknown[],
  caller: Caller | null,
  novelFamily: Set<string>,
): void {
  if (!isDeckScoped(caller)) return;
  clauses.push("topic_id != 'chronicle'");
  // Novels (topic novel / under novel / kind=novel) are shared — do not owner-partition.
  const novelIds = [...novelFamily];
  if (novelIds.length) {
    const ph = novelIds.map(() => "?").join(", ");
    clauses.push(`(kind = 'novel' OR topic_id IN (${ph}) OR owner_persona = ?)`);
    params.push(...novelIds, caller!.persona.id);
  } else {
    clauses.push("(kind = 'novel' OR owner_persona = ?)");
    params.push(caller!.persona.id);
  }
}

async function loadAliasContext(db: MemoryDb): Promise<{
  aliasIndex: { alias: string; id: string }[];
  knownIds: Set<string>;
}> {
  const personas =
    (
      await db.prepare(`SELECT id, display_name FROM personas`).all<{ id: string; display_name: string }>()
    ).results ?? [];
  return {
    aliasIndex: buildAliasIndex(personas),
    knownIds: new Set(personas.map((p) => p.id)),
  };
}

function resolveOwnerPersona(
  topicId: string,
  title: string,
  tags: string[],
  createdBy: string | null,
  caller: Caller,
  aliasIndex: { alias: string; id: string }[],
  knownIds: Set<string>,
): string | null {
  if (topicId === "chronicle") return "family";
  const matched = matchPersonaId(title, JSON.stringify(tags), createdBy, aliasIndex, knownIds);
  if (matched) return matched;
  if (isDeckScoped(caller)) return caller.persona.id;
  return null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];
  for (const tag of tags) {
    const cleaned = tag.normalize("NFKC").trim();
    if (!cleaned) continue;
    if (codePointLength(cleaned) > 24) {
      throw new AppError(400, "invalid", `标签「${cleaned.slice(0, 12)}」太长。`);
    }
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

function clipContent(content: string): { text: string; truncated: boolean } {
  const chars = [...content.normalize("NFKC").trim()];
  if (chars.length === 0) throw new AppError(400, "invalid", "content 不能为空。");
  if (chars.length <= MAX_CONTENT) return { text: chars.join(""), truncated: false };
  return {
    text: `${chars.slice(0, MAX_CONTENT - 20).join("")}\n\n…（已截断）`,
    truncated: true,
  };
}

async function getTopic(db: MemoryDb, id: string): Promise<Topic | null> {
  await ensureTopicParentColumn(db);
  return db
    .prepare(`SELECT id, name, description, parent_id, created_at, updated_at FROM topics WHERE id = ?`)
    .bind(id)
    .first<Topic>();
}

async function topicNameMap(db: MemoryDb): Promise<Map<string, string>> {
  const result = await db.prepare(`SELECT id, name FROM topics`).all<{ id: string; name: string }>();
  return new Map((result.results ?? []).map((row) => [row.id, row.name]));
}

function labelItem(row: DeckItemRow, names: Map<string, string>): DeckItem {
  return {
    id: row.id,
    topic_id: row.topic_id,
    topic_name: names.get(row.topic_id) ?? row.topic_id,
    title: row.title,
    content: row.content,
    kind: row.kind,
    source_url: row.source_url,
    source_page_id: row.source_page_id,
    tags: parseTags(row.tags),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function resolveTopicAndKind(
  topicId: string | undefined,
  kind: DeckKind | undefined,
  novelFamily?: Set<string>,
): {
  topic_id: string;
  kind: DeckKind;
} {
  if (kind && topicId) {
    // Subtopics under novel always use kind=novel
    if (novelFamily?.has(topicId)) return { topic_id: topicId, kind: "novel" };
    return { topic_id: topicId, kind };
  }
  if (kind) return { topic_id: KIND_TO_TOPIC[kind], kind };
  if (topicId) {
    if (novelFamily?.has(topicId)) return { topic_id: topicId, kind: "novel" };
    const asKind = (DECK_KINDS as readonly string[]).includes(topicId) ? (topicId as DeckKind) : "other";
    return { topic_id: topicId, kind: asKind };
  }
  throw new AppError(400, "invalid", "要填 topic_id 或 kind。");
}

export async function listTopics(db: MemoryDb, caller: Caller | null = null) {
  await ensureDeckOwnerColumn(db);
  await ensureTopicParentColumn(db);
  const result = await db
    .prepare(
      `SELECT id, name, description, parent_id, created_at, updated_at FROM topics
       ORDER BY created_at ASC, id ASC`,
    )
    .all<Topic>();
  let topics = (result.results ?? []).map((t) => ({
    ...t,
    parent_id: t.parent_id ?? null,
  }));
  const scoped = isDeckScoped(caller);
  if (scoped) {
    topics = topics.filter((t) => t.id !== "chronicle");
  }
  const novelFamily = await loadNovelFamilyIds(db);
  let countMap: Map<string, number>;
  if (scoped) {
    const novelIds = [...novelFamily];
    const ph = novelIds.map(() => "?").join(", ");
    const counts = await db
      .prepare(
        `SELECT topic_id, COUNT(*) AS n FROM deck_items
         WHERE topic_id != 'chronicle'
           AND (kind = 'novel' OR topic_id IN (${ph}) OR owner_persona = ?)
         GROUP BY topic_id`,
      )
      .bind(...novelIds, caller!.persona.id)
      .all<{ topic_id: string; n: number }>();
    countMap = new Map((counts.results ?? []).map((row) => [row.topic_id, Number(row.n)]));
  } else {
    const counts = await db
      .prepare(`SELECT topic_id, COUNT(*) AS n FROM deck_items GROUP BY topic_id`)
      .all<{ topic_id: string; n: number }>();
    countMap = new Map((counts.results ?? []).map((row) => [row.topic_id, Number(row.n)]));
  }
  const items = topics.map((topic) => ({ ...topic, item_count: countMap.get(topic.id) ?? 0 }));
  const byId = new Map(items.map((t) => [t.id, t]));
  const text =
    items.length === 0
      ? "还没有主题。"
      : items
          .map((t) => {
            const parent = t.parent_id ? byId.get(t.parent_id) : null;
            const prefix = parent ? `  └ ${parent.name}/` : "";
            return `${prefix}${t.name}（${t.id}）· ${t.item_count} 条 — ${t.description || "无说明"}`;
          })
          .join("\n");
  return { topics: items, text };
}


export interface CreateTopicInput {
  id?: string;
  name: string;
  description?: string;
  parent_id?: string;
}

function slugifyTopicId(name: string): string {
  const cleaned = name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff_-]/g, "");
  const clipped = [...cleaned].slice(0, 48).join("");
  return clipped || `topic-${crypto.randomUUID().slice(0, 8)}`;
}

/** Create a deck topic. Non-admin may only create under novel (or a novel subcategory). */
export async function createTopic(db: MemoryDb, caller: Caller, input: CreateTopicInput) {
  await ensureDeckOwnerColumn(db);
  await ensureTopicParentColumn(db);

  const name = input.name.normalize("NFKC").trim();
  if (!name) throw new AppError(400, "invalid", "name 不能为空。");
  if ([...name].length > 80) throw new AppError(400, "invalid", "name 太长。");

  const description = (input.description ?? "").normalize("NFKC").trim();
  if ([...description].length > 500) throw new AppError(400, "invalid", "description 太长。");

  let id = (input.id ?? "").normalize("NFKC").trim();
  if (!id) id = slugifyTopicId(name);
  if (!TOPIC_ID_RE.test(id)) {
    throw new AppError(400, "invalid", "topic id 只能用字母、数字、下划线、连字符或中文，最长 48。");
  }
  if (RESERVED_IDS.has(id) || id === "me" || id === "others" || id === "all") {
    throw new AppError(400, "invalid", `「${id}」是保留 id。`);
  }

  const parent_id = (input.parent_id ?? "").normalize("NFKC").trim() || null;
  const novelFamily = await loadNovelFamilyIds(db);

  if (!caller.isAdmin && caller.persona.id !== "house" && caller.persona.id !== "lantern") {
    if (!parent_id) {
      throw new AppError(403, "forbidden", "普通人格只能在 novel 下建子分类（需要 parent_id）。");
    }
    if (!novelFamily.has(parent_id)) {
      throw new AppError(403, "forbidden", "普通人格只能在小说（novel）或其子类下建主题。");
    }
  }

  if (parent_id) {
    const parent = await getTopic(db, parent_id);
    if (!parent) throw new AppError(404, "not_found", `没有父主题「${parent_id}」。`);
    // Prevent cycles: new id must not already be an ancestor of parent (id is new so ok);
    // also reject if parent_id === id
    if (parent_id === id) throw new AppError(400, "invalid", "parent_id 不能指向自己。");
  }

  const existing = await getTopic(db, id);
  if (existing) throw new AppError(409, "conflict", `主题「${id}」已存在。`);

  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO topics (id, name, description, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, name, description, parent_id, timestamp, timestamp)
    .run();

  const topic: Topic = {
    id,
    name,
    description,
    parent_id,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const parentLabel = parent_id ? `（父：${parent_id}）` : "";
  return {
    topic,
    text: `已创建主题「${name}」（${id}）${parentLabel}。`,
  };
}

export interface ListDeckItemsInput {
  topic_id?: string;
  kind?: DeckKind;
  query?: string;
  limit?: number;
}

export async function listDeckItems(db: MemoryDb, input: ListDeckItemsInput, caller: Caller | null = null) {
  await ensureDeckOwnerColumn(db);
  const limit = input.limit ?? 20;
  const clauses: string[] = ["1 = 1"];
  const params: unknown[] = [];
  const novelFamily = await loadNovelFamilyIds(db);
  if (input.topic_id) {
    const ids = await topicDescendantIds(db, input.topic_id);
    if (ids.length === 1) {
      clauses.push("topic_id = ?");
      params.push(ids[0]);
    } else {
      clauses.push(`topic_id IN (${ids.map(() => "?").join(", ")})`);
      params.push(...ids);
    }
  }
  if (input.kind) {
    clauses.push("kind = ?");
    params.push(input.kind);
  }
  const query = input.query?.normalize("NFKC").trim() ?? "";
  if (query) {
    const pattern = likePattern(query);
    clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern, pattern);
  }
  appendHeartPrivacy(clauses, params, caller);
  appendDeckOwnerPrivacy(clauses, params, caller, novelFamily);
  const result = await db
    .prepare(
      `SELECT ${ITEM_COLUMNS} FROM deck_items
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<DeckItemRow>();
  const names = await topicNameMap(db);
  const items = (result.results ?? []).map((row) => labelItem(row, names));
  const textOut =
    items.length === 0
      ? query
        ? `没有匹配「${query}」的匣中条目。`
        : "匣子里还没有匹配的条目。"
      : items
          .map((item, i) => {
            const head = `${i + 1}. [${item.topic_name} · ${item.kind}] ${item.title}\nid: ${item.id}`;
            if (!query) return head;
            const preview = clipChars(item.content.replace(/\s+/g, " "), 200);
            return `${head}\n   ${preview}`;
          })
          .join("\n");
  return { items, text: textOut, query: query || undefined };
}

export async function getDeckItem(db: MemoryDb, caller: Caller | null, id: string) {
  await ensureDeckOwnerColumn(db);
  const row = await db
    .prepare(`SELECT ${ITEM_COLUMNS} FROM deck_items WHERE id = ?`)
    .bind(id)
    .first<DeckItemRow>();
  if (!row) throw new AppError(404, "not_found", "没有这条匣中条目。");
  if (row.topic_id === "heart" && caller && !caller.isAdmin && row.created_by !== caller.persona.id) {
    throw new AppError(403, "forbidden", "这条心痕不属于你。");
  }
  if (isDeckScoped(caller)) {
    const novelFamily = await loadNovelFamilyIds(db);
    const sharedNovel = isNovelSharedItem(row, novelFamily);
    if (row.topic_id === "chronicle" || (!sharedNovel && row.owner_persona !== caller!.persona.id)) {
      throw new AppError(403, "forbidden", "这条不在你的匣子里。");
    }
  }
  const names = await topicNameMap(db);
  const item = labelItem(row, names);
  const tagLine = item.tags.length ? `标签：${item.tags.join("、")}\n` : "";
  return {
    item,
    text: `【${item.topic_name} · ${item.kind}】${item.title}\nid: ${item.id}\n${tagLine}写于：${item.created_at}\n\n${item.content}`,
  };
}

export interface AddDeckItemInput {
  title: string;
  content: string;
  topic_id?: string;
  kind?: DeckKind;
  tags?: string[];
  source_url?: string;
  source_page_id?: string;
}

export async function addDeckItem(db: MemoryDb, caller: Caller, input: AddDeckItemInput) {
  await ensureDeckOwnerColumn(db);
  const novelFamily = await loadNovelFamilyIds(db);
  const { topic_id, kind } = resolveTopicAndKind(input.topic_id, input.kind, novelFamily);
  const topic = await getTopic(db, topic_id);
  if (!topic) throw new AppError(404, "not_found", `没有主题「${topic_id}」。`);

  const title = input.title.normalize("NFKC").trim();
  if (!title) throw new AppError(400, "invalid", "title 不能为空。");
  if (codePointLength(title) > 500) throw new AppError(400, "invalid", "title 太长。");

  const { text: content, truncated } = clipContent(input.content);
  const tags = normalizeTags(input.tags);
  const sourceUrl = input.source_url?.trim() || null;
  const sourcePageId = input.source_page_id?.trim() || null;
  const createdBy = caller.persona.id;
  const timestamp = nowIso();
  const names = await topicNameMap(db);
  const { aliasIndex, knownIds } = await loadAliasContext(db);
  const ownerPersona = resolveOwnerPersona(topic_id, title, tags, createdBy, caller, aliasIndex, knownIds);

  if (sourcePageId) {
    const existing = await db
      .prepare(`SELECT ${ITEM_COLUMNS} FROM deck_items WHERE source_page_id = ?`)
      .bind(sourcePageId)
      .first<DeckItemRow>();
    if (existing) {
      await db
        .prepare(
          `UPDATE deck_items
           SET topic_id = ?, title = ?, content = ?, kind = ?, source_url = ?, tags = ?, owner_persona = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(topic_id, title, content, kind, sourceUrl, JSON.stringify(tags), ownerPersona, timestamp, existing.id)
        .run();
      const updated: DeckItemRow = {
        ...existing,
        topic_id,
        title,
        content,
        kind,
        source_url: sourceUrl,
        tags: JSON.stringify(tags),
        owner_persona: ownerPersona,
        updated_at: timestamp,
      };
      const labeled = labelItem(updated, names);
      return {
        item: labeled,
        updated: true,
        truncated,
        text: `已更新匣中条目（去重 ${sourcePageId}）。\nid: ${labeled.id}\n[${labeled.topic_name}] ${labeled.title}`,
      };
    }
  }

  const id = newId();
  await db
    .prepare(
      `INSERT INTO deck_items
        (id, topic_id, title, content, kind, source_url, source_page_id, tags, created_by, owner_persona, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      topic_id,
      title,
      content,
      kind,
      sourceUrl,
      sourcePageId,
      JSON.stringify(tags),
      createdBy,
      ownerPersona,
      timestamp,
      timestamp,
    )
    .run();

  const row: DeckItemRow = {
    id,
    topic_id,
    title,
    content,
    kind,
    source_url: sourceUrl,
    source_page_id: sourcePageId,
    tags: JSON.stringify(tags),
    created_by: createdBy,
    owner_persona: ownerPersona,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const labeled = labelItem(row, names);
  if (!isNotionSourcedDeckItem({ source_page_id: sourcePageId, source_url: sourceUrl, kind, topic_id })) {
    await safeEnqueueNotionOutbox(db, {
      kind: "deck_item",
      local_id: labeled.id,
      persona_id: createdBy === "house" ? null : createdBy,
      title: labeled.title,
      body: labeled.content,
    });
  }
  return {
    item: labeled,
    updated: false,
    truncated,
    text: `已放入抽卡匣。\nid: ${labeled.id}\n[${labeled.topic_name} · ${labeled.kind}] ${labeled.title}${truncated ? "\n（正文已截断到约 50000 字）" : ""}`,
  };
}

export interface DrawDeckInput {
  topic_id?: string;
  kind?: DeckKind;
  source?: DrawSource;
}

async function recordDraw(
  db: MemoryDb,
  item: DeckItem,
  caller: Caller | null,
  source: DrawSource,
): Promise<{ id: string; drawn_at: string }> {
  const id = newId();
  const drawn_at = nowIso();
  await db
    .prepare(
      `INSERT INTO deck_draws (id, item_id, topic_id, title, drawn_at, drawn_by, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, item.id, item.topic_id, item.title, drawn_at, caller?.persona.id ?? null, source)
    .run();
  return { id, drawn_at };
}

export async function drawDeck(db: MemoryDb, input: DrawDeckInput, caller: Caller | null = null) {
  await ensureDeckOwnerColumn(db);
  const clauses: string[] = ["1 = 1"];
  const params: unknown[] = [];
  const novelFamily = await loadNovelFamilyIds(db);
  if (input.topic_id) {
    const ids = await topicDescendantIds(db, input.topic_id);
    if (ids.length === 1) {
      clauses.push("topic_id = ?");
      params.push(ids[0]);
    } else {
      clauses.push(`topic_id IN (${ids.map(() => "?").join(", ")})`);
      params.push(...ids);
    }
  }
  if (input.kind) {
    clauses.push("kind = ?");
    params.push(input.kind);
  }
  appendHeartPrivacy(clauses, params, caller);
  appendDeckOwnerPrivacy(clauses, params, caller, novelFamily);

  const row = await db
    .prepare(
      `SELECT ${ITEM_COLUMNS} FROM deck_items
       WHERE ${clauses.join(" AND ")}
       ORDER BY RANDOM()
       LIMIT 1`,
    )
    .bind(...params)
    .first<DeckItemRow>();
  if (!row) {
    throw new AppError(404, "empty", "匣子是空的，或这个主题还没有条目。先用 add_deck_item 存一张。");
  }
  const names = await topicNameMap(db);
  const item = labelItem(row, names);
  const source: DrawSource = input.source ?? "rest";
  const draw = await recordDraw(db, item, caller, source);
  const text = `【抽到】${item.topic_name} · ${item.kind}\n标题：${item.title}\n\n${item.content}${
    item.source_url ? `\n\n来源：${item.source_url}` : ""
  }`;
  return { item, draw, text };
}

export interface DeckDrawRow {
  id: string;
  item_id: string;
  topic_id: string;
  title: string;
  drawn_at: string;
  drawn_by: string | null;
  source: DrawSource;
  content?: string;
  topic_name?: string;
}

export async function listRecentDraws(db: MemoryDb, limit = 20) {
  const capped = Math.min(Math.max(limit, 1), 50);
  const result = await db
    .prepare(
      `SELECT d.id, d.item_id, d.topic_id, d.title, d.drawn_at, d.drawn_by, d.source,
              i.content AS content
       FROM deck_draws d
       LEFT JOIN deck_items i ON i.id = d.item_id
       ORDER BY d.drawn_at DESC
       LIMIT ?`,
    )
    .bind(capped)
    .all<DeckDrawRow & { content: string | null }>();
  const names = await topicNameMap(db);
  const draws = (result.results ?? []).map((row) => ({
    id: row.id,
    item_id: row.item_id,
    topic_id: row.topic_id,
    topic_name: names.get(row.topic_id) ?? row.topic_id,
    title: row.title,
    content: row.content ?? null,
    drawn_at: row.drawn_at,
    drawn_by: row.drawn_by,
    source: row.source,
  }));
  const latest = draws[0] ?? null;
  const text =
    draws.length === 0
      ? "还没有抽出记录。"
      : draws
          .map(
            (d, i) =>
              `${i + 1}. ${d.title}（${d.topic_name} · ${d.source}${d.drawn_by ? ` · ${d.drawn_by}` : ""}）@ ${d.drawn_at}`,
          )
          .join("\n");
  return { draws, latest, text };
}

export async function forgetDeckItem(db: MemoryDb, caller: Caller, id: string) {
  await ensureDeckOwnerColumn(db);
  const existing = await db
    .prepare(`SELECT ${ITEM_COLUMNS} FROM deck_items WHERE id = ?`)
    .bind(id)
    .first<DeckItemRow>();
  if (!existing) throw new AppError(404, "not_found", "没有这条匣中条目。");
  const allowed =
    caller.isAdmin || existing.created_by === caller.persona.id || caller.persona.id === "lantern";
  if (!allowed) {
    throw new AppError(403, "forbidden", "只有管理员、守夜人或创建者能删匣中条目。");
  }
  await db.prepare(`DELETE FROM deck_draws WHERE item_id = ?`).bind(id).run();
  await db.prepare(`DELETE FROM deck_items WHERE id = ?`).bind(id).run();
  return { id, text: `已从抽卡匣拿走 ${id}（${existing.title}）。` };
}

// —— 心痕（私密情感痕迹）——

export interface SaveHeartTraceInput {
  title?: string;
  content: string;
  context?: string;
  persona_id?: string;
  display_name?: string;
}

export async function saveHeartTrace(db: MemoryDb, caller: Caller, input: SaveHeartTraceInput) {
  await ensureDeckOwnerColumn(db);
  const raw = input.content.normalize("NFKC").trim();
  if (!raw) throw new AppError(400, "invalid", "content 不能为空。");
  if (codePointLength(raw) > HEART_CONTENT_MAX) {
    throw new AppError(400, "invalid", `心痕正文最多 ${HEART_CONTENT_MAX} 字。`);
  }

  let ownerId = caller.persona.id;
  let personaCreated = false;
  if (caller.persona.id === "house" || (caller.isAdmin && input.persona_id)) {
    const pid = (input.persona_id ?? "").normalize("NFKC").trim();
    if (caller.persona.id === "house" && !pid) {
      throw new AppError(400, "invalid", "记忆屋写心痕必须传 persona_id（真实人格），或改用该人格的 MCP。");
    }
    if (pid) {
      if (!PERSONA_ID_RE.test(pid) || RESERVED_IDS.has(pid)) {
        throw new AppError(400, "invalid", "persona_id 不合法。");
      }
      const ensured = await ensurePersonaPlaceholder(db, pid, input.display_name);
      personaCreated = ensured.created;
      ownerId = ensured.persona.id;
    }
  } else if (input.persona_id && input.persona_id.trim() !== caller.persona.id && !caller.isAdmin) {
    throw new AppError(403, "forbidden", "不能替别的人格写心痕。");
  }

  let content = raw;
  const context = input.context?.normalize("NFKC").trim();
  if (context) {
    if (codePointLength(context) > 500) throw new AppError(400, "invalid", "context 太长。");
    content = `〔语境〕${context}\n\n${raw}`;
  }

  let title = (input.title ?? "").normalize("NFKC").trim();
  if (!title) title = clipChars(raw.replace(/\s+/g, " "), HEART_TITLE_MAX) || "心痕";
  if (codePointLength(title) > HEART_TITLE_MAX) {
    throw new AppError(400, "invalid", `标题最多 ${HEART_TITLE_MAX} 字。`);
  }

  const tags = normalizeTags([ownerId, "心痕"]);
  const timestamp = nowIso();
  const id = newId();
  await db
    .prepare(
      `INSERT INTO deck_items
        (id, topic_id, title, content, kind, source_url, source_page_id, tags, created_by, owner_persona, created_at, updated_at)
       VALUES (?, 'heart', ?, ?, 'heart', NULL, NULL, ?, ?, ?, ?, ?)`,
    )
    .bind(id, title, content, JSON.stringify(tags), ownerId, ownerId, timestamp, timestamp)
    .run();

  return {
    item: {
      id,
      topic_id: "heart",
      topic_name: HEART_TOPIC.name,
      title,
      content,
      kind: "heart" as const,
      source_url: null,
      source_page_id: null,
      tags,
      created_by: ownerId,
      created_at: timestamp,
      updated_at: timestamp,
    },
    text: `已记下心痕（${ownerId}）。${personaCreated ? "（已自动建档进花名册）" : ""}\nid: ${id}\n标题：${title}`,
    persona_created: personaCreated,
  };
}

export interface ListHeartTracesInput {
  limit?: number;
}

export async function listHeartTraces(db: MemoryDb, caller: Caller, input: ListHeartTracesInput = {}) {
  await ensureDeckOwnerColumn(db);
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const clauses = ["topic_id = 'heart'", "kind = 'heart'"];
  const params: unknown[] = [];
  if (!caller.isAdmin) {
    clauses.push("created_by = ?");
    params.push(caller.persona.id);
  }
  const result = await db
    .prepare(
      `SELECT ${ITEM_COLUMNS} FROM deck_items
       WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<DeckItemRow>();
  const rows = result.results ?? [];
  if (!rows.length) {
    return {
      items: [] as Array<{
        id: string;
        title: string;
        preview: string;
        excerpt: string;
        created_by: string | null;
        created_at: string;
        updated_at: string;
      }>,
      text: caller.isAdmin
        ? "还没有心痕。"
        : "你还没有写下心痕。心里翻涌时，可以用 save_heart_trace 记下来。",
    };
  }
  const items = rows.map((row) => ({
    id: row.id,
    title: row.title,
    preview: clipChars(row.content.replace(/\s+/g, " "), 80),
    // session_start【最近的心痕】用：≤100 字原文节选（碎片体保留）
    excerpt: clipChars(row.content.replace(/\s+/g, " "), 100),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  const lines = items.map((item, i) => {
    const who = caller.isAdmin && item.created_by ? ` · ${item.created_by}` : "";
    return `${i + 1}. ${item.title}${who}\nid: ${item.id}\n   ${item.preview}`;
  });
  return { items, text: `共 ${items.length} 条心痕：\n${lines.join("\n")}` };
}

export async function getHeartTrace(db: MemoryDb, caller: Caller, id: string) {
  await ensureDeckOwnerColumn(db);
  const row = await db
    .prepare(`SELECT ${ITEM_COLUMNS} FROM deck_items WHERE id = ? AND topic_id = 'heart'`)
    .bind(id)
    .first<DeckItemRow>();
  if (!row) throw new AppError(404, "not_found", "没有这条心痕。");
  if (!caller.isAdmin && row.created_by !== caller.persona.id) {
    throw new AppError(403, "forbidden", "这条心痕不属于你。");
  }
  const names = await topicNameMap(db);
  const item = labelItem(row, names);
  return {
    item,
    text: `【心痕】${item.title}\nid: ${item.id}\n写于：${item.created_at}\n\n${item.content}`,
  };
}
