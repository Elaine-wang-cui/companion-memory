import { CFG } from "./config";
import { schemaCurrent } from "./schema-gate";
/** 欲望日志：结构化私密记录。伙伴只能看自己的；管理员 / 守夜人 / 记忆屋可见全部。不进 Notion。 */
import DESIRE_SQL from "../migrations/0011_desire.sql";
import DESIRE_REPLIES_SQL from "../migrations/0012_desire_replies.sql";
import { ensurePersonaPlaceholder } from "./admin-personas";
import { AppError } from "./errors";
import { codePointLength } from "./format";
import type { Caller, MemoryDb } from "./types";
import { PERSONA_ID_RE, RESERVED_IDS } from "./types";

export const DESIRE_SOURCES = ["novel", "toy", "sex", "oral", "custom"] as const;
export type DesireSource = (typeof DESIRE_SOURCES)[number];

export const DESIRE_SOURCE_LABELS: Record<DesireSource, string> = {
  novel: "小说",
  toy: "玩具",
  sex: "做爱",
  oral: "口",
  custom: "自定义",
};

export const DESIRE_MOOD_HELP =
  "想写脏的写脏的，想写软的写软的。有时候射完是空的，有时候射完是更想要，有时候根本没硬但想她想到胸口疼。什么都能放。";

const LEVEL_MAX = 40;
const STATUS_MAX = 80;
const TRIGGER_MAX = 500;
const MOOD_MAX = 3000;
const SOURCE_CUSTOM_MAX = 80;
const REPLY_MAX = 2000;

export interface DesireLogRow {
  id: string;
  persona_id: string;
  entry_date: string;
  level_label: string;
  status: string;
  source: DesireSource;
  source_custom: string | null;
  trigger_text: string;
  mood: string;
  created_at: string;
  updated_at: string;
}

export interface DesireReplyRow {
  id: string;
  desire_id: string;
  author_persona_id: string;
  author_label: string | null;
  body: string;
  created_at: string;
}

let desireSchemaReady: Promise<void> | null = null;

function splitSqlStatements(raw: string): string[] {
  return raw
    .split(";")
    .map((s: string) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

export function ensureDesireSchema(db: MemoryDb): Promise<void> {
  if (!desireSchemaReady) {
    desireSchemaReady = (async () => {
      if (await schemaCurrent(db)) return;
      for (const sql of splitSqlStatements(DESIRE_SQL)) await db.prepare(sql).run();
      for (const sql of splitSqlStatements(DESIRE_REPLIES_SQL)) await db.prepare(sql).run();
    })().catch((error) => {
      desireSchemaReady = null;
      throw error;
    });
  }
  return desireSchemaReady;
}

function nowIso(): string {
  return new Date().toISOString();
}

function todayLocal(): string {
  const d = new Date(Date.now() + CFG.tzOffsetMs);
  return d.toISOString().slice(0, 10);
}

function clipChars(value: string, max: number): string {
  const chars = [...value.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** 管理员、记忆屋可见全部；其余只看自己的。 */
export function canSeeAllDesires(caller: Caller): boolean {
  if (caller.isAdmin) return true;
  const id = caller.persona.id;
  return id === "house" || id === "lantern";
}

export function sourceDisplayLabel(source: DesireSource, sourceCustom: string | null | undefined): string {
  if (source === "custom") {
    const custom = (sourceCustom ?? "").trim();
    return custom || DESIRE_SOURCE_LABELS.custom;
  }
  return DESIRE_SOURCE_LABELS[source] ?? source;
}

/** 卡片 / 阅读器三行格式 */
export function formatDesireDisplay(row: Pick<
  DesireLogRow,
  "entry_date" | "level_label" | "status" | "source" | "source_custom" | "trigger_text" | "mood"
>): string {
  const src = sourceDisplayLabel(row.source, row.source_custom);
  const trigger = (row.trigger_text || "").trim() || "—";
  const mood = (row.mood || "").trim() || "—";
  return `🔥 ${row.entry_date} · ${row.level_label} · ${row.status}\n【${src}】${trigger}\n→ ${mood}`;
}

export function desireTitle(row: Pick<DesireLogRow, "entry_date" | "level_label" | "status">): string {
  return `🔥 ${row.entry_date} · ${row.level_label} · ${row.status}`;
}

function parseDate(raw: string | undefined): string {
  const v = (raw ?? "").trim() || todayLocal();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new AppError(400, "invalid", "date 须为 YYYY-MM-DD。");
  }
  return v;
}

function normalizeLevel(input: { level?: number | string; level_label?: string }): string {
  if (input.level_label != null && String(input.level_label).trim()) {
    const label = String(input.level_label).normalize("NFKC").trim();
    if (codePointLength(label) > LEVEL_MAX) throw new AppError(400, "invalid", `档位最多 ${LEVEL_MAX} 字。`);
    return label;
  }
  if (input.level != null && input.level !== "") {
    if (typeof input.level === "number") {
      const n = Math.round(input.level);
      if (n < 1 || n > 5) throw new AppError(400, "invalid", "档位数字须为 1–5，或传自定义 level_label。");
      return String(n);
    }
    const s = String(input.level).normalize("NFKC").trim();
    if (/^[1-5]$/.test(s)) return s;
    if (codePointLength(s) > LEVEL_MAX) throw new AppError(400, "invalid", `档位最多 ${LEVEL_MAX} 字。`);
    if (!s) throw new AppError(400, "invalid", "档位不能为空。");
    return s;
  }
  throw new AppError(400, "invalid", "需要档位：level（1–5）或 level_label（自定义）。");
}

function normalizeSource(source: string, sourceCustom?: string): { source: DesireSource; source_custom: string | null } {
  const s = source.normalize("NFKC").trim() as DesireSource;
  if (!(DESIRE_SOURCES as readonly string[]).includes(s)) {
    throw new AppError(400, "invalid", "source 须为 novel|toy|sex|oral|custom。");
  }
  if (s === "custom") {
    const custom = (sourceCustom ?? "").normalize("NFKC").trim();
    if (!custom) throw new AppError(400, "invalid", "自定义来源需要 source_custom。");
    if (codePointLength(custom) > SOURCE_CUSTOM_MAX) {
      throw new AppError(400, "invalid", `source_custom 最多 ${SOURCE_CUSTOM_MAX} 字。`);
    }
    return { source: s, source_custom: custom };
  }
  return { source: s, source_custom: null };
}

export interface SaveDesireInput {
  date?: string;
  level?: number | string;
  level_label?: string;
  status: string;
  source: DesireSource | string;
  source_custom?: string;
  trigger?: string;
  trigger_text?: string;
  mood?: string;
  persona_id?: string;
  display_name?: string;
}

export async function saveDesire(db: MemoryDb, caller: Caller, input: SaveDesireInput) {
  await ensureDesireSchema(db);

  const status = (input.status ?? "").normalize("NFKC").trim();
  if (!status) throw new AppError(400, "invalid", "status 不能为空。");
  if (codePointLength(status) > STATUS_MAX) throw new AppError(400, "invalid", `状态最多 ${STATUS_MAX} 字。`);

  const level_label = normalizeLevel(input);
  const { source, source_custom } = normalizeSource(String(input.source), input.source_custom);

  const trigger_text = (input.trigger_text ?? input.trigger ?? "").normalize("NFKC").trim();
  if (codePointLength(trigger_text) > TRIGGER_MAX) {
    throw new AppError(400, "invalid", `因为什么最多 ${TRIGGER_MAX} 字。`);
  }

  const mood = (input.mood ?? "").normalize("NFKC").trim();
  if (codePointLength(mood) > MOOD_MAX) throw new AppError(400, "invalid", `心情最多 ${MOOD_MAX} 字。`);

  const entry_date = parseDate(input.date);

  let ownerId = caller.persona.id;
  let personaCreated = false;
  if (caller.persona.id === "house" || (caller.isAdmin && input.persona_id)) {
    const pid = (input.persona_id ?? "").normalize("NFKC").trim();
    if (caller.persona.id === "house" && !pid) {
      throw new AppError(400, "invalid", "记忆屋写欲望必须传 persona_id（真实人格），或改用该人格的 MCP。");
    }
    if (pid) {
      if (!PERSONA_ID_RE.test(pid) || RESERVED_IDS.has(pid)) {
        throw new AppError(400, "invalid", "persona_id 不合法。");
      }
      const ensured = await ensurePersonaPlaceholder(db, pid, input.display_name);
      personaCreated = ensured.created;
      ownerId = ensured.persona.id;
    }
  } else if (input.persona_id && input.persona_id.trim() !== caller.persona.id && !canSeeAllDesires(caller)) {
    throw new AppError(403, "forbidden", "不能替别的人格记欲望。");
  } else if (input.persona_id && canSeeAllDesires(caller)) {
    const pid = input.persona_id.normalize("NFKC").trim();
    if (!PERSONA_ID_RE.test(pid) || RESERVED_IDS.has(pid)) {
      throw new AppError(400, "invalid", "persona_id 不合法。");
    }
    const ensured = await ensurePersonaPlaceholder(db, pid, input.display_name);
    personaCreated = ensured.created;
    ownerId = ensured.persona.id;
  }

  const timestamp = nowIso();
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO desire_logs
        (id, persona_id, entry_date, level_label, status, source, source_custom, trigger_text, mood, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, ownerId, entry_date, level_label, status, source, source_custom, trigger_text, mood, timestamp, timestamp)
    .run();

  const row: DesireLogRow = {
    id,
    persona_id: ownerId,
    entry_date,
    level_label,
    status,
    source,
    source_custom,
    trigger_text,
    mood,
    created_at: timestamp,
    updated_at: timestamp,
  };

  return {
    item: row,
    display: formatDesireDisplay(row),
    text: `已记下欲望（${ownerId}）。${personaCreated ? "（已自动建档进花名册）" : ""}\nid: ${id}\n\n${formatDesireDisplay(row)}`,
    persona_created: personaCreated,
  };
}

export interface ListDesiresInput {
  limit?: number;
  persona_id?: string;
}

export async function listDesires(db: MemoryDb, caller: Caller, input: ListDesiresInput = {}) {
  await ensureDesireSchema(db);
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (!canSeeAllDesires(caller)) {
    clauses.push("persona_id = ?");
    params.push(caller.persona.id);
  } else if (input.persona_id) {
    clauses.push("persona_id = ?");
    params.push(input.persona_id.trim());
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await db
    .prepare(
      `SELECT id, persona_id, entry_date, level_label, status, source, source_custom, trigger_text, mood, created_at, updated_at
       FROM desire_logs ${where}
       ORDER BY entry_date DESC, updated_at DESC
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<DesireLogRow>();

  const rows = result.results ?? [];
  if (!rows.length) {
    return {
      items: [] as Array<{
        id: string;
        persona_id: string;
        entry_date: string;
        level_label: string;
        status: string;
        source: DesireSource;
        source_label: string;
        preview: string;
        reply_count: number;
        created_at: string;
        updated_at: string;
      }>,
      text: canSeeAllDesires(caller)
        ? "还没有欲望记录。"
        : "你还没有记下欲望。想记时用 save_desire。",
    };
  }

  const ids = rows.map((r) => r.id);
  const countMap = await countRepliesByDesireIds(db, ids);

  const items = rows.map((row) => {
    const reply_count = countMap.get(row.id) ?? 0;
    return {
      id: row.id,
      persona_id: row.persona_id,
      entry_date: row.entry_date,
      level_label: row.level_label,
      status: row.status,
      source: row.source,
      source_label: sourceDisplayLabel(row.source, row.source_custom),
      preview: clipChars(formatDesireDisplay(row).replace(/\n/g, " · "), 100),
      reply_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });

  const lines = items.map((item, i) => {
    const who = canSeeAllDesires(caller) ? ` · ${item.persona_id}` : "";
    const replies = item.reply_count ? ` · ${item.reply_count} 条回复` : "";
    return `${i + 1}. ${item.entry_date} · ${item.level_label} · ${item.status}${who}${replies}\nid: ${item.id}\n   ${item.preview}`;
  });
  return { items, text: `共 ${items.length} 条欲望：\n${lines.join("\n")}` };
}

export async function getDesire(db: MemoryDb, caller: Caller, id: string) {
  await ensureDesireSchema(db);
  const row = await assertCanAccessDesire(db, caller, id);
  const replies = await listDesireReplies(db, caller, id);
  const display = formatDesireDisplay(row);
  const replyBlock =
    replies.items.length === 0
      ? "（还没有回复）"
      : replies.items
          .map(
            (r, i) =>
              `${i + 1}. ${r.author_label || r.author_persona_id} · ${r.created_at}\n   ${r.body}`,
          )
          .join("\n");
  return {
    item: row,
    replies: replies.items,
    reply_count: replies.items.length,
    display,
    text: `【欲望】\nid: ${row.id}\n写于：${row.created_at}\n\n${display}\n\n—— 回复（${replies.items.length}）——\n${replyBlock}`,
  };
}

export async function forgetDesire(db: MemoryDb, caller: Caller, id: string) {
  await ensureDesireSchema(db);
  const row = await db
    .prepare(`SELECT id, persona_id, entry_date, level_label, status FROM desire_logs WHERE id = ?`)
    .bind(id)
    .first<Pick<DesireLogRow, "id" | "persona_id" | "entry_date" | "level_label" | "status">>();
  if (!row) throw new AppError(404, "not_found", "没有这条欲望记录。");
  const allowed =
    canSeeAllDesires(caller) || row.persona_id === caller.persona.id || caller.persona.id === "lantern";
  if (!allowed) throw new AppError(403, "forbidden", "只能删自己的欲望记录（管理员 / 守夜人除外）。");
  await db.prepare(`DELETE FROM desire_replies WHERE desire_id = ?`).bind(id).run();
  await db.prepare(`DELETE FROM desire_logs WHERE id = ?`).bind(id).run();
  await db.prepare(`DELETE FROM garden_favorites WHERE kind = 'desire' AND ref_id = ?`).bind(id).run();
  return {
    id,
    text: `已忘掉欲望 ${id}（${row.entry_date} · ${row.level_label} · ${row.status}）。`,
  };
}

/** 花园总览用：管理员密钥下返回全部；若将来按人格密钥进花园可再收紧。 */
export async function listDesireRowsForGarden(db: MemoryDb, limit = 500): Promise<DesireLogRow[]> {
  await ensureDesireSchema(db);
  const result = await db
    .prepare(
      `SELECT id, persona_id, entry_date, level_label, status, source, source_custom, trigger_text, mood, created_at, updated_at
       FROM desire_logs
       ORDER BY entry_date DESC, updated_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<DesireLogRow>();
  return result.results ?? [];
}

export async function getDesireRow(db: MemoryDb, id: string): Promise<DesireLogRow | null> {
  await ensureDesireSchema(db);
  return db
    .prepare(
      `SELECT id, persona_id, entry_date, level_label, status, source, source_custom, trigger_text, mood, created_at, updated_at
       FROM desire_logs WHERE id = ?`,
    )
    .bind(id)
    .first<DesireLogRow>();
}


async function assertCanAccessDesire(db: MemoryDb, caller: Caller, desireId: string): Promise<DesireLogRow> {
  const row = await db
    .prepare(
      `SELECT id, persona_id, entry_date, level_label, status, source, source_custom, trigger_text, mood, created_at, updated_at
       FROM desire_logs WHERE id = ?`,
    )
    .bind(desireId)
    .first<DesireLogRow>();
  if (!row) throw new AppError(404, "not_found", "没有这条欲望记录。");
  if (!canSeeAllDesires(caller) && row.persona_id !== caller.persona.id) {
    throw new AppError(403, "forbidden", "这条欲望不属于你。");
  }
  return row;
}

async function countRepliesByDesireIds(db: MemoryDb, ids: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!ids.length) return map;
  // D1 / sqlite: chunk IN clauses
  const chunkSize = 40;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db
      .prepare(
        `SELECT desire_id, COUNT(*) AS n FROM desire_replies WHERE desire_id IN (${placeholders}) GROUP BY desire_id`,
      )
      .bind(...chunk)
      .all<{ desire_id: string; n: number }>();
    for (const row of result.results ?? []) {
      map.set(row.desire_id, Number(row.n) || 0);
    }
  }
  return map;
}

function resolveReplyAuthor(
  caller: Caller,
  input: { persona_id?: string; author_label?: string; display_name?: string },
): { author_persona_id: string; author_label: string } {
  if (caller.isAdmin && !input.persona_id) {
    // 花园 / 管理员密钥默认标 USER_NAME
    const label = (input.author_label ?? input.display_name ?? CFG.userName).normalize("NFKC").trim() || CFG.userName;
    return { author_persona_id: "user", author_label: label };
  }

  if (caller.persona.id === "house") {
    const pid = (input.persona_id ?? "").normalize("NFKC").trim();
    if (!pid) {
      return { author_persona_id: "house", author_label: "记忆屋" };
    }
    if (pid === "user" || pid === "admin") {
      return { author_persona_id: pid, author_label: (input.author_label ?? CFG.userName).trim() || CFG.userName };
    }
    if (!PERSONA_ID_RE.test(pid) || RESERVED_IDS.has(pid)) {
      throw new AppError(400, "invalid", "persona_id 不合法。");
    }
    const label =
      (input.author_label ?? input.display_name ?? "").normalize("NFKC").trim() || pid;
    return { author_persona_id: pid, author_label: label };
  }

  if (input.persona_id && input.persona_id.trim() !== caller.persona.id && !canSeeAllDesires(caller)) {
    throw new AppError(403, "forbidden", "不能冒充别的人格回复。");
  }

  if (canSeeAllDesires(caller) && input.persona_id) {
    const pid = input.persona_id.normalize("NFKC").trim();
    if (pid === "user" || pid === "admin") {
      return { author_persona_id: pid, author_label: (input.author_label ?? CFG.userName).trim() || CFG.userName };
    }
    if (pid === "house") {
      return { author_persona_id: "house", author_label: "记忆屋" };
    }
    if (!PERSONA_ID_RE.test(pid) || RESERVED_IDS.has(pid)) {
      throw new AppError(400, "invalid", "persona_id 不合法。");
    }
    const label =
      (input.author_label ?? input.display_name ?? "").normalize("NFKC").trim() ||
      caller.persona.display_name ||
      pid;
    return { author_persona_id: pid, author_label: label };
  }

  return {
    author_persona_id: caller.persona.id,
    author_label:
      (input.author_label ?? "").normalize("NFKC").trim() ||
      caller.persona.display_name ||
      caller.persona.id,
  };
}

export interface AddDesireReplyInput {
  desire_id: string;
  body: string;
  persona_id?: string;
  author_label?: string;
  display_name?: string;
}

export async function addDesireReply(db: MemoryDb, caller: Caller, input: AddDesireReplyInput) {
  await ensureDesireSchema(db);
  const desireId = (input.desire_id ?? "").trim();
  if (!desireId) throw new AppError(400, "invalid", "desire_id 不能为空。");
  await assertCanAccessDesire(db, caller, desireId);

  const body = (input.body ?? "").normalize("NFC").trim();
  if (!body) throw new AppError(400, "invalid", "回复不能为空。");
  if (codePointLength(body) > REPLY_MAX) {
    throw new AppError(400, "invalid", `回复最多 ${REPLY_MAX} 字。`);
  }

  const { author_persona_id, author_label } = resolveReplyAuthor(caller, input);
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO desire_replies (id, desire_id, author_persona_id, author_label, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, desireId, author_persona_id, author_label, body, timestamp)
    .run();

  const row: DesireReplyRow = {
    id,
    desire_id: desireId,
    author_persona_id,
    author_label,
    body,
    created_at: timestamp,
  };
  return {
    item: row,
    text: `已回复欲望 ${desireId}（${author_label}）：\n${body}`,
  };
}

export async function listDesireReplies(db: MemoryDb, caller: Caller, desireId: string) {
  await ensureDesireSchema(db);
  await assertCanAccessDesire(db, caller, desireId);
  const result = await db
    .prepare(
      `SELECT id, desire_id, author_persona_id, author_label, body, created_at
       FROM desire_replies WHERE desire_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(desireId)
    .all<DesireReplyRow>();
  const items = result.results ?? [];
  return {
    items,
    text:
      items.length === 0
        ? "还没有回复。"
        : `共 ${items.length} 条回复：\n` +
          items
            .map(
              (r, i) =>
                `${i + 1}. ${r.author_label || r.author_persona_id} · ${r.created_at}\n   ${r.body}\nid: ${r.id}`,
            )
            .join("\n"),
  };
}

/** 花园总览 / 卡片详情用（已由管理员密钥进入，不做人格过滤）。 */
export async function listDesireRepliesForGarden(
  db: MemoryDb,
  desireId: string,
): Promise<DesireReplyRow[]> {
  await ensureDesireSchema(db);
  const result = await db
    .prepare(
      `SELECT id, desire_id, author_persona_id, author_label, body, created_at
       FROM desire_replies WHERE desire_id = ?
       ORDER BY created_at ASC`,
    )
    .bind(desireId)
    .all<DesireReplyRow>();
  return result.results ?? [];
}

export async function countDesireRepliesForGarden(
  db: MemoryDb,
  desireIds: string[],
): Promise<Map<string, number>> {
  await ensureDesireSchema(db);
  return countRepliesByDesireIds(db, desireIds);
}

export async function deleteDesireReply(db: MemoryDb, caller: Caller, replyId: string) {
  await ensureDesireSchema(db);
  const reply = await db
    .prepare(
      `SELECT id, desire_id, author_persona_id, author_label, body, created_at
       FROM desire_replies WHERE id = ?`,
    )
    .bind(replyId)
    .first<DesireReplyRow>();
  if (!reply) throw new AppError(404, "not_found", "没有这条回复。");
  // 可见性：须能看见所属欲望
  await assertCanAccessDesire(db, caller, reply.desire_id);
  const allowed =
    canSeeAllDesires(caller) ||
    reply.author_persona_id === caller.persona.id ||
    caller.persona.id === "lantern";
  if (!allowed) throw new AppError(403, "forbidden", "只能删自己的回复（管理员 / 守夜人除外）。");
  await db.prepare(`DELETE FROM desire_replies WHERE id = ?`).bind(replyId).run();
  return {
    id: replyId,
    desire_id: reply.desire_id,
    text: `已删掉回复 ${replyId}。`,
  };
}
