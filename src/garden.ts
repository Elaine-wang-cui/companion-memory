import { CFG } from "./config";
import { schemaCurrent } from "./schema-gate";
/** Memory Garden: conversations, garden entries, voice (KV), persona meta, garden overview. */
import { AppError } from "./errors";
import type { Caller, MemoryDb, MemoryRow, Persona } from "./types";
import type { HandoffRow, NoteRow, UnresolvedRow } from "./continuity";
import GARDEN_SQL from "../migrations/0004_garden.sql";
import IMAGES_SQL from "../migrations/0006_images.sql";
import { buildAliasIndex, matchPersonaId } from "./persona-roster";
import { ensureNotionSyncSchema, safeEnqueueNotionOutbox } from "./notion-sync";
import { loadNovelFamilyIds } from "./deck";
import {
  desireTitle,
  ensureDesireSchema,
  formatDesireDisplay,
  getDesireRow,
  listDesireRowsForGarden,
  listDesireRepliesForGarden,
  countDesireRepliesForGarden,
} from "./desire";

const MAX_TRANSCRIPT = 500_000;
const MAX_VOICE_BYTES = 4_500_000; // KV value limit ~25MB; keep clips reasonable
const MAX_IMAGE_BYTES = 8_000_000;

export interface MediaKv {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | string, options?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  delete(key: string): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function todayLocal(): string {
  const d = new Date(Date.now() + CFG.tzOffsetMs);
  return d.toISOString().slice(0, 10);
}

function clip(value: string, max: number): string {
  const chars = [...value.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

function autoSummary(fullText: string, existing?: string): string {
  const s = (existing ?? "").trim();
  if (s) return clip(s, 500);
  return clip(fullText.replace(/\s+/g, " "), 160);
}

const DEFAULT_EMBLEMS: Record<string, "cat" | "snake" | "rose" | "moon"> = {
  companion: "cat",
  lantern: "moon",
  ember: "rose",
};

export interface ConversationRow {
  id: string;
  persona_id: string;
  title: string;
  summary: string;
  full_text: string;
  entry_date: string;
  favorite: number;
  source_platform: string | null;
  created_at: string;
  updated_at: string;
}

export interface GardenEntryRow {
  id: string;
  persona_id: string;
  kind: "memory" | "diary" | "promise" | "note";
  title: string;
  body: string;
  entry_date: string;
  favorite: number;
  created_at: string;
  updated_at: string;
}

export interface VoiceClipRow {
  id: string;
  persona_id: string;
  title: string;
  kv_key: string;
  mime: string;
  size: number;
  entry_date: string | null;
  favorite: number;
  created_at: string;
}
export interface GardenImageRow {
  id: string;
  persona_id: string;
  title: string;
  kv_key: string;
  mime: string;
  size: number;
  entry_date: string | null;
  favorite: number;
  created_at: string;
}


export interface GardenPersonaMeta {
  persona_id: string;
  emblem: string;
  note: string;
  updated_at: string;
}

export type GardenCardType =
  | "memory"
  | "diary"
  | "promise"
  | "conversation"
  | "note"
  | "unresolved"
  | "handoff"
  | "voice"
  | "image"
  | "heart"
  | "desire"
  | "novel";

export interface GardenCard {
  id: string;
  source: "memory" | "garden" | "conversation" | "note" | "unresolved" | "handoff" | "voice" | "image" | "heart" | "desire" | "deck";
  ref_id: string;
  persona_id: string;
  type: GardenCardType;
  title: string;
  summary: string;
  date: string;
  favorite: boolean;
  kind_label?: string;
  status?: string;
  reply_count?: number;
}

let gardenSchemaReady: Promise<void> | null = null;

export function ensureGardenSchema(db: MemoryDb): Promise<void> {
  if (!gardenSchemaReady) {
    gardenSchemaReady = (async () => {
      if (await schemaCurrent(db)) return;
      const statements = [...GARDEN_SQL.split(";"), ...IMAGES_SQL.split(";")]
        .map((s: string) => s.replace(/^\s*--.*$/gm, "").trim())
        .filter(Boolean);
      for (const sql of statements) await db.prepare(sql).run();
      await ensureNotionSyncSchema(db);
      await ensureDesireSchema(db);
    })().catch((error) => {
      gardenSchemaReady = null;
      throw error;
    });
  }
  return gardenSchemaReady;
}

export async function listConversations(db: MemoryDb, personaId?: string, limit = 200) {
  if (personaId) {
    const r = await db
      .prepare(
        `SELECT id, persona_id, title, summary, entry_date, favorite, source_platform, created_at, updated_at,
                substr(full_text, 1, 1) AS has_body
         FROM conversations WHERE persona_id = ? ORDER BY entry_date DESC, updated_at DESC LIMIT ?`,
      )
      .bind(personaId, limit)
      .all<Omit<ConversationRow, "full_text"> & { has_body: string }>();
    return (r.results ?? []).map(({ has_body: _h, ...rest }) => rest);
  }
  const r = await db
    .prepare(
      `SELECT id, persona_id, title, summary, entry_date, favorite, source_platform, created_at, updated_at
       FROM conversations ORDER BY entry_date DESC, updated_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<Omit<ConversationRow, "full_text">>();
  return r.results ?? [];
}

export async function getConversation(db: MemoryDb, id: string): Promise<ConversationRow> {
  const row = await db.prepare(`SELECT * FROM conversations WHERE id = ?`).bind(id).first<ConversationRow>();
  if (!row) throw new AppError(404, "not_found", "没有这段对话。");
  return row;
}

export async function createConversation(
  db: MemoryDb,
  input: {
    persona_id: string;
    title: string;
    full_text: string;
    summary?: string;
    entry_date?: string;
    favorite?: boolean;
    source_platform?: string;
  },
) {
  const full = input.full_text.trim();
  if (!full) throw new AppError(400, "invalid", "对话正文不能为空。");
  if ([...full].length > MAX_TRANSCRIPT) {
    throw new AppError(400, "invalid", `对话正文过长（上限约 ${MAX_TRANSCRIPT} 字）。`);
  }
  const t = nowIso();
  const row: ConversationRow = {
    id: crypto.randomUUID(),
    persona_id: input.persona_id.trim(),
    title: input.title.trim() || clip(full, 40),
    summary: autoSummary(full, input.summary),
    full_text: full,
    entry_date: (input.entry_date || todayLocal()).slice(0, 10),
    favorite: input.favorite ? 1 : 0,
    source_platform: input.source_platform?.trim() || null,
    created_at: t,
    updated_at: t,
  };
  await db
    .prepare(
      `INSERT INTO conversations (id, persona_id, title, summary, full_text, entry_date, favorite, source_platform, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.persona_id,
      row.title,
      row.summary,
      row.full_text,
      row.entry_date,
      row.favorite,
      row.source_platform,
      row.created_at,
      row.updated_at,
    )
    .run();
  await safeEnqueueNotionOutbox(db, {
    kind: "conversation",
    local_id: row.id,
    persona_id: row.persona_id,
    title: row.title,
    body: row.full_text,
  });
  return row;
}

export async function updateConversation(
  db: MemoryDb,
  id: string,
  patch: Partial<{
    title: string;
    summary: string;
    full_text: string;
    entry_date: string;
    favorite: boolean;
    persona_id: string;
    source_platform: string | null;
  }>,
) {
  const existing = await getConversation(db, id);
  const full = patch.full_text !== undefined ? patch.full_text.trim() : existing.full_text;
  if (!full) throw new AppError(400, "invalid", "对话正文不能为空。");
  if ([...full].length > MAX_TRANSCRIPT) {
    throw new AppError(400, "invalid", `对话正文过长（上限约 ${MAX_TRANSCRIPT} 字）。`);
  }
  const t = nowIso();
  const title = patch.title !== undefined ? patch.title.trim() : existing.title;
  const summary =
    patch.summary !== undefined
      ? autoSummary(full, patch.summary)
      : patch.full_text !== undefined && !existing.summary
        ? autoSummary(full)
        : existing.summary;
  await db
    .prepare(
      `UPDATE conversations SET persona_id = ?, title = ?, summary = ?, full_text = ?, entry_date = ?, favorite = ?,
       source_platform = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      patch.persona_id?.trim() || existing.persona_id,
      title,
      summary,
      full,
      (patch.entry_date || existing.entry_date).slice(0, 10),
      patch.favorite !== undefined ? (patch.favorite ? 1 : 0) : existing.favorite,
      patch.source_platform !== undefined ? patch.source_platform : existing.source_platform,
      t,
      id,
    )
    .run();
  return getConversation(db, id);
}

export async function deleteConversation(db: MemoryDb, id: string) {
  const r = await db.prepare(`DELETE FROM conversations WHERE id = ?`).bind(id).run();
  return { ok: true, deleted: r.meta?.changes ?? 0 };
}


function assertConversationAccess(caller: Caller, row: ConversationRow): void {
  if (caller.isAdmin) return;
  if (row.persona_id !== caller.persona.id) {
    throw new AppError(403, "forbidden", "这段对话属于别人，你不能看或改。");
  }
}

/** MCP: save full transcript into Memory Garden as this caller. */
export async function saveConversationMcp(
  db: MemoryDb,
  caller: Caller,
  input: {
    persona_id?: string;
    title?: string;
    summary?: string;
    full_text: string;
    entry_date?: string;
    source_platform?: string;
  },
): Promise<{ text: string }> {
  await ensureGardenSchema(db);
  let personaId = caller.persona.id;
  if (caller.persona.id === "house") {
    const pid = input.persona_id?.trim() ?? "";
    if (!pid) {
      throw new AppError(400, "invalid", "记忆屋存对话必须传 persona_id（真实人格）。");
    }
    personaId = pid;
  } else if (input.persona_id && input.persona_id.trim() !== caller.persona.id && !caller.isAdmin) {
    throw new AppError(403, "forbidden", "不能替别的人格存对话。");
  } else if (input.persona_id && caller.isAdmin) {
    personaId = input.persona_id.trim();
  }
  const row = await createConversation(db, {
    persona_id: personaId,
    title: (input.title ?? "").trim() || "一段对话",
    full_text: input.full_text,
    summary: input.summary,
    entry_date: input.entry_date,
    source_platform: input.source_platform?.trim() || "claude",
  });
  const preview = clip(row.summary, 80);
  return {
    text: `已存入记忆花园。\nid: ${row.id}\n标题：${row.title}\n日期：${row.entry_date}\n摘要：${preview}`,
  };
}

/** MCP: list this persona's conversations (admin: all). No full_text. */
export async function listConversationsMcp(
  db: MemoryDb,
  caller: Caller,
  limit = 50,
): Promise<{ text: string }> {
  await ensureGardenSchema(db);
  const cap = Math.min(Math.max(limit, 1), 100);
  const personaFilter = caller.isAdmin ? undefined : caller.persona.id;
  const items = await listConversations(db, personaFilter, cap);
  if (!items.length) {
    return { text: caller.isAdmin ? "记忆花园里还没有对话。" : "你还没有存过对话。用 save_conversation 把这一窗存进花名册。" };
  }
  const lines = items.map((c, i) => {
    const sum = clip(c.summary || "", 60);
    const who = caller.isAdmin && c.persona_id !== caller.persona.id ? ` [${c.persona_id}]` : "";
    return `${i + 1}. ${c.title}${who}（${c.entry_date}） id=${c.id}\n   ${sum || "（无摘要）"}`;
  });
  return { text: `共 ${items.length} 段对话：\n${lines.join("\n")}` };
}

/** MCP: get one conversation if owned by caller (or admin). */
export async function getConversationMcp(
  db: MemoryDb,
  caller: Caller,
  id: string,
): Promise<{ text: string }> {
  await ensureGardenSchema(db);
  const row = await getConversation(db, id);
  assertConversationAccess(caller, row);
  return {
    text: `标题：${row.title}\n日期：${row.entry_date}\nid: ${row.id}\n来源：${row.source_platform ?? "—"}\n摘要：${row.summary}\n\n—— 全文 ——\n${row.full_text}`,
  };
}

/** MCP: delete one conversation if owned by caller (or admin). */
export async function forgetConversationMcp(
  db: MemoryDb,
  caller: Caller,
  id: string,
): Promise<{ text: string }> {
  await ensureGardenSchema(db);
  const row = await getConversation(db, id);
  assertConversationAccess(caller, row);
  await deleteConversation(db, id);
  return { text: `已从记忆花园删掉「${row.title}」（id: ${id}）。` };
}


export async function createGardenEntry(
  db: MemoryDb,
  input: {
    persona_id: string;
    kind: GardenEntryRow["kind"];
    title: string;
    body: string;
    entry_date?: string;
    favorite?: boolean;
  },
) {
  const t = nowIso();
  const row: GardenEntryRow = {
    id: crypto.randomUUID(),
    persona_id: input.persona_id.trim(),
    kind: input.kind,
    title: input.title.trim(),
    body: input.body.trim(),
    entry_date: (input.entry_date || todayLocal()).slice(0, 10),
    favorite: input.favorite ? 1 : 0,
    created_at: t,
    updated_at: t,
  };
  if (!row.title || !row.body) throw new AppError(400, "invalid", "标题和正文不能为空。");
  await db
    .prepare(
      `INSERT INTO garden_entries (id, persona_id, kind, title, body, entry_date, favorite, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(row.id, row.persona_id, row.kind, row.title, row.body, row.entry_date, row.favorite, row.created_at, row.updated_at)
    .run();
  await safeEnqueueNotionOutbox(db, {
    kind: "garden_entry",
    local_id: row.id,
    persona_id: row.persona_id,
    title: row.title,
    body: row.body,
  });
  return row;
}

export async function updateGardenEntry(
  db: MemoryDb,
  id: string,
  patch: Partial<{ title: string; body: string; kind: GardenEntryRow["kind"]; entry_date: string; favorite: boolean; persona_id: string }>,
) {
  const existing = await db.prepare(`SELECT * FROM garden_entries WHERE id = ?`).bind(id).first<GardenEntryRow>();
  if (!existing) throw new AppError(404, "not_found", "没有这条花园记录。");
  const t = nowIso();
  await db
    .prepare(
      `UPDATE garden_entries SET persona_id = ?, kind = ?, title = ?, body = ?, entry_date = ?, favorite = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      patch.persona_id?.trim() || existing.persona_id,
      patch.kind || existing.kind,
      patch.title !== undefined ? patch.title.trim() : existing.title,
      patch.body !== undefined ? patch.body.trim() : existing.body,
      (patch.entry_date || existing.entry_date).slice(0, 10),
      patch.favorite !== undefined ? (patch.favorite ? 1 : 0) : existing.favorite,
      t,
      id,
    )
    .run();
  return db.prepare(`SELECT * FROM garden_entries WHERE id = ?`).bind(id).first<GardenEntryRow>();
}

export async function deleteGardenEntry(db: MemoryDb, id: string) {
  const r = await db.prepare(`DELETE FROM garden_entries WHERE id = ?`).bind(id).run();
  return { ok: true, deleted: r.meta?.changes ?? 0 };
}

export async function upsertPersonaMeta(
  db: MemoryDb,
  personaId: string,
  input: { emblem?: string; note?: string },
) {
  const t = nowIso();
  const existing = await db
    .prepare(`SELECT * FROM garden_persona_meta WHERE persona_id = ?`)
    .bind(personaId)
    .first<GardenPersonaMeta>();
  const emblem = input.emblem || existing?.emblem || DEFAULT_EMBLEMS[personaId] || "rose";
  const note = input.note !== undefined ? input.note.trim() : existing?.note || "";
  if (!["cat", "snake", "rose", "moon"].includes(emblem)) {
    throw new AppError(400, "invalid", "印记只能是 cat / snake / rose / moon。");
  }
  await db
    .prepare(
      `INSERT INTO garden_persona_meta (persona_id, emblem, note, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(persona_id) DO UPDATE SET emblem = excluded.emblem, note = excluded.note, updated_at = excluded.updated_at`,
    )
    .bind(personaId, emblem, note, t)
    .run();
  return { persona_id: personaId, emblem, note, updated_at: t };
}

export async function setFavorite(db: MemoryDb, kind: string, refId: string, favorite: boolean) {
  if (kind === "conversation") {
    await db.prepare(`UPDATE conversations SET favorite = ?, updated_at = ? WHERE id = ?`).bind(favorite ? 1 : 0, nowIso(), refId).run();
  } else if (kind === "garden") {
    await db.prepare(`UPDATE garden_entries SET favorite = ?, updated_at = ? WHERE id = ?`).bind(favorite ? 1 : 0, nowIso(), refId).run();
  } else if (kind === "voice") {
    await db.prepare(`UPDATE voice_clips SET favorite = ? WHERE id = ?`).bind(favorite ? 1 : 0, refId).run();
  } else if (kind === "image") {
    await db.prepare(`UPDATE garden_images SET favorite = ? WHERE id = ?`).bind(favorite ? 1 : 0, refId).run();
  } else {
    const id = `${kind}:${refId}`;
    if (favorite) {
      await db
        .prepare(
          `INSERT INTO garden_favorites (id, kind, ref_id, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .bind(id, kind, refId, nowIso())
        .run();
    } else {
      await db.prepare(`DELETE FROM garden_favorites WHERE id = ? OR (kind = ? AND ref_id = ?)`).bind(id, kind, refId).run();
    }
  }
  return { ok: true, kind, ref_id: refId, favorite };
}

export async function saveVoiceClip(
  db: MemoryDb,
  media: MediaKv,
  input: {
    persona_id: string;
    title?: string;
    mime: string;
    bytes: ArrayBuffer;
    entry_date?: string;
  },
) {
  if (!media) throw new AppError(503, "unavailable", "语音存储（KV）尚未配置。");
  const size = input.bytes.byteLength;
  if (size <= 0) throw new AppError(400, "invalid", "空音频。");
  if (size > MAX_VOICE_BYTES) throw new AppError(400, "invalid", `音频过大（上限约 ${Math.floor(MAX_VOICE_BYTES / 1e6)}MB）。`);
  const id = crypto.randomUUID();
  const kvKey = `voice/${input.persona_id}/${id}`;
  await media.put(kvKey, input.bytes, { httpMetadata: { contentType: input.mime } });
  const t = nowIso();
  const row: VoiceClipRow = {
    id,
    persona_id: input.persona_id.trim(),
    title: (input.title || "一段语音").trim(),
    kv_key: kvKey,
    mime: input.mime || "audio/webm",
    size,
    entry_date: (input.entry_date || todayLocal()).slice(0, 10),
    favorite: 0,
    created_at: t,
  };
  await db
    .prepare(
      `INSERT INTO voice_clips (id, persona_id, title, kv_key, mime, size, entry_date, favorite, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(row.id, row.persona_id, row.title, row.kv_key, row.mime, row.size, row.entry_date, row.created_at)
    .run();
  return row;
}

export async function getVoiceClip(db: MemoryDb, id: string): Promise<VoiceClipRow> {
  const row = await db.prepare(`SELECT * FROM voice_clips WHERE id = ?`).bind(id).first<VoiceClipRow>();
  if (!row) throw new AppError(404, "not_found", "没有这段语音。");
  return row;
}

export async function readVoiceBytes(media: MediaKv, clip: VoiceClipRow): Promise<ArrayBuffer> {
  const buf = await media.get(clip.kv_key, "arrayBuffer");
  if (!buf) throw new AppError(404, "not_found", "语音文件不在存储里了。");
  return buf;
}

export async function deleteVoiceClip(db: MemoryDb, media: MediaKv | undefined, id: string) {
  const row = await getVoiceClip(db, id);
  if (media) {
    try {
      await media.delete(row.kv_key);
    } catch {
      /* ignore */
    }
  }
  const r = await db.prepare(`DELETE FROM voice_clips WHERE id = ?`).bind(id).run();
  return { ok: true, deleted: r.meta?.changes ?? 0 };
}

export async function saveGardenImage(
  db: MemoryDb,
  media: MediaKv,
  input: {
    persona_id: string;
    title?: string;
    mime: string;
    bytes: ArrayBuffer;
    entry_date?: string;
  },
) {
  if (!media) throw new AppError(503, "unavailable", "图片存储（KV）尚未配置。");
  const size = input.bytes.byteLength;
  if (size <= 0) throw new AppError(400, "invalid", "空图片。");
  if (size > MAX_IMAGE_BYTES) throw new AppError(400, "invalid", `图片过大（上限约 ${Math.floor(MAX_IMAGE_BYTES / 1e6)}MB）。`);
  const mime = (input.mime || "image/png").toLowerCase();
  if (!mime.startsWith("image/")) throw new AppError(400, "invalid", "只要图片文件。");
  const id = crypto.randomUUID();
  const kvKey = `image/${input.persona_id}/${id}`;
  await media.put(kvKey, input.bytes, { httpMetadata: { contentType: mime } });
  const t = nowIso();
  const row: GardenImageRow = {
    id,
    persona_id: input.persona_id.trim(),
    title: (input.title || "一张图").trim(),
    kv_key: kvKey,
    mime,
    size,
    entry_date: (input.entry_date || todayLocal()).slice(0, 10),
    favorite: 0,
    created_at: t,
  };
  await db
    .prepare(
      `INSERT INTO garden_images (id, persona_id, title, kv_key, mime, size, entry_date, favorite, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(row.id, row.persona_id, row.title, row.kv_key, row.mime, row.size, row.entry_date, row.created_at)
    .run();
  return row;
}

export async function getGardenImage(db: MemoryDb, id: string): Promise<GardenImageRow> {
  const row = await db.prepare(`SELECT * FROM garden_images WHERE id = ?`).bind(id).first<GardenImageRow>();
  if (!row) throw new AppError(404, "not_found", "没有这张图。");
  return row;
}

export async function readGardenImageBytes(media: MediaKv, row: GardenImageRow): Promise<ArrayBuffer> {
  const buf = await media.get(row.kv_key, "arrayBuffer");
  if (!buf) throw new AppError(404, "not_found", "图片文件不在存储里了。");
  return buf;
}

export async function deleteGardenImage(db: MemoryDb, media: MediaKv | undefined, id: string) {
  const row = await getGardenImage(db, id);
  if (media) {
    try {
      await media.delete(row.kv_key);
    } catch {
      /* ignore */
    }
  }
  const r = await db.prepare(`DELETE FROM garden_images WHERE id = ?`).bind(id).run();
  return { ok: true, deleted: r.meta?.changes ?? 0 };
}

export async function listGardenImages(db: MemoryDb, personaId?: string, limit = 50) {
  const lim = Math.min(Math.max(limit, 1), 200);
  if (personaId) {
    const r = await db
      .prepare(`SELECT * FROM garden_images WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(personaId, lim)
      .all<GardenImageRow>();
    return r.results ?? [];
  }
  const r = await db.prepare(`SELECT * FROM garden_images ORDER BY created_at DESC LIMIT ?`).bind(lim).all<GardenImageRow>();
  return r.results ?? [];
}

function memoryTitle(content: string): string {
  const line = content.trim().split(/\n/)[0] || content;
  return clip(line, 36);
}

function memoryType(kind: string): GardenCardType {
  return kind === "diary" ? "diary" : "memory";
}

export async function gardenOverview(db: MemoryDb) {
  await ensureGardenSchema(db);
  const personas =
    (
      await db
        .prepare(`SELECT id, display_name, relationship_to_user, self_card, created_at, updated_at FROM personas ORDER BY created_at ASC, id ASC`)
        .all<Persona>()
    ).results ?? [];
  const metaRows =
    (await db.prepare(`SELECT * FROM garden_persona_meta`).all<GardenPersonaMeta>()).results ?? [];
  const metaMap = new Map(metaRows.map((m) => [m.persona_id, m]));

  const people = personas.map((p) => {
    const meta = metaMap.get(p.id);
    return {
      id: p.id,
      name: p.display_name,
      note: (() => {
        const metaNote = (meta?.note || "").trim();
        if (metaNote) return metaNote;
        const rel = (p.relationship_to_user || "").trim();
        if (rel && !rel.includes("同伴")) return rel;
        return "这里，替我们记得。";
      })(),
      emblem: meta?.emblem || DEFAULT_EMBLEMS[p.id] || "rose",
      relationship_to_user: p.relationship_to_user,
    };
  });

  const memories =
    (
      await db
        .prepare(
          `SELECT id, owner_persona, created_by, kind, visibility, content, importance, tags, event_date, created_at, updated_at, source_platform
           FROM memories WHERE owner_persona != 'family' OR visibility = 'family'
           ORDER BY updated_at DESC LIMIT 1000`,
        )
        .all<MemoryRow>()
    ).results ?? [];

  const favRows =
    (await db.prepare(`SELECT kind, ref_id FROM garden_favorites`).all<{ kind: string; ref_id: string }>()).results ?? [];
  const favSet = new Set(favRows.map((f) => `${f.kind}:${f.ref_id}`));

  const conversations =
    (
      await db
        .prepare(
          `SELECT id, persona_id, title, summary, entry_date, favorite, source_platform, created_at, updated_at FROM conversations
           ORDER BY entry_date DESC, updated_at DESC LIMIT 500`,
        )
        .all<Omit<ConversationRow, "full_text">>()
    ).results ?? [];

  const gardenEntries =
    (await db.prepare(`SELECT * FROM garden_entries ORDER BY entry_date DESC, updated_at DESC LIMIT 500`).all<GardenEntryRow>())
      .results ?? [];

  const voiceClips =
    (await db.prepare(`SELECT * FROM voice_clips ORDER BY created_at DESC LIMIT 300`).all<VoiceClipRow>()).results ?? [];
  let gardenImages: GardenImageRow[] = [];
  try {
    gardenImages =
      (await db.prepare(`SELECT * FROM garden_images ORDER BY created_at DESC LIMIT 300`).all<GardenImageRow>()).results ?? [];
  } catch {
    gardenImages = [];
  }

  const unresolved =
    (await db.prepare(`SELECT * FROM unresolved ORDER BY updated_at DESC LIMIT 300`).all<UnresolvedRow>()).results ?? [];
  const handoffs =
    (await db.prepare(`SELECT * FROM handoffs ORDER BY created_at DESC LIMIT 100`).all<HandoffRow>()).results ?? [];
  const notes =
    (await db.prepare(`SELECT * FROM notes ORDER BY created_at DESC LIMIT 300`).all<NoteRow>()).results ?? [];

  const cards: GardenCard[] = [];

  for (const m of memories) {
    if (m.owner_persona === "family") continue; // family shown optionally later
    const date = (m.event_date || m.updated_at || m.created_at || "").slice(0, 10);
    cards.push({
      id: `memory:${m.id}`,
      source: "memory",
      ref_id: m.id,
      persona_id: m.owner_persona,
      type: memoryType(m.kind),
      title: memoryTitle(m.content),
      summary: clip(m.content, 180),
      date,
      favorite: favSet.has(`memory:${m.id}`),
      kind_label: m.kind,
    });
  }

  for (const g of gardenEntries) {
    cards.push({
      id: `garden:${g.id}`,
      source: "garden",
      ref_id: g.id,
      persona_id: g.persona_id,
      type: g.kind === "promise" ? "promise" : g.kind === "diary" ? "diary" : g.kind === "note" ? "note" : "memory",
      title: g.title,
      summary: clip(g.body, 180),
      date: g.entry_date,
      favorite: !!g.favorite,
    });
  }

  for (const c of conversations) {
    cards.push({
      id: `conversation:${c.id}`,
      source: "conversation",
      ref_id: c.id,
      persona_id: c.persona_id,
      type: "conversation",
      title: c.title,
      summary: c.summary || clip(c.title, 120),
      date: c.entry_date,
      favorite: !!c.favorite,
    });
  }

  for (const n of notes) {
    cards.push({
      id: `note:${n.id}`,
      source: "note",
      ref_id: n.id,
      persona_id: n.persona_id,
      type: "note",
      title: clip(n.content, 36),
      summary: n.reply ? `便条：${clip(n.content, 80)}\n回复：${clip(n.reply, 80)}` : clip(n.content, 160),
      date: (n.created_at || "").slice(0, 10),
      favorite: favSet.has(`note:${n.id}`),
    });
  }

  for (const u of unresolved) {
    cards.push({
      id: `unresolved:${u.id}`,
      source: "unresolved",
      ref_id: u.id,
      persona_id: u.persona_id,
      type: "unresolved",
      title: clip(u.content, 36),
      summary: u.status === "closed" && u.resolution ? `${clip(u.content, 100)}\n了结：${clip(u.resolution, 60)}` : clip(u.content, 160),
      date: (u.updated_at || u.created_at || "").slice(0, 10),
      favorite: favSet.has(`unresolved:${u.id}`),
      status: u.status,
    });
  }

  for (const h of handoffs) {
    cards.push({
      id: `handoff:${h.id}`,
      source: "handoff",
      ref_id: h.id,
      persona_id: h.persona_id,
      type: "handoff",
      title: clip(h.summary, 36),
      summary: [h.summary, h.mood ? `心情：${h.mood}` : "", h.next_time ? `下次：${h.next_time}` : ""].filter(Boolean).join("\n"),
      date: (h.created_at || "").slice(0, 10),
      favorite: favSet.has(`handoff:${h.id}`),
    });
  }

  for (const v of voiceClips) {
    cards.push({
      id: `voice:${v.id}`,
      source: "voice",
      ref_id: v.id,
      persona_id: v.persona_id,
      type: "voice",
      title: v.title || "一段语音",
      summary: `语音 · ${(v.size / 1024).toFixed(1)} KB · ${v.mime}`,
      date: (v.entry_date || v.created_at || "").slice(0, 10),
      favorite: !!v.favorite,
    });
  }

  for (const img of gardenImages) {
    cards.push({
      id: `image:${img.id}`,
      source: "image",
      ref_id: img.id,
      persona_id: img.persona_id,
      type: "image",
      title: img.title || "一张图",
      summary: `图片 · ${(img.size / 1024).toFixed(1)} KB · ${img.mime}`,
      date: (img.entry_date || img.created_at || "").slice(0, 10),
      favorite: !!img.favorite,
    });
  }

  // 心痕（deck topic=heart）：书房可见，归在 created_by 名下
  try {
    const heartRows =
      (
        await db
          .prepare(
            `SELECT id, title, content, created_by, created_at, updated_at
             FROM deck_items WHERE topic_id = 'heart' AND kind = 'heart'
             ORDER BY updated_at DESC LIMIT 500`,
          )
          .all<{
            id: string;
            title: string;
            content: string;
            created_by: string | null;
            created_at: string;
            updated_at: string;
          }>()
      ).results ?? [];
    for (const h of heartRows) {
      if (!h.created_by) continue;
      cards.push({
        id: `heart:${h.id}`,
        source: "heart",
        ref_id: h.id,
        persona_id: h.created_by,
        type: "heart",
        title: h.title,
        summary: clip(h.content, 180),
        date: (h.updated_at || h.created_at || "").slice(0, 10),
        favorite: favSet.has(`heart:${h.id}`),
        kind_label: "心痕",
      });
    }
  } catch {
    /* topics/deck may lag on fresh DBs; ensureHeartTopic covers MCP path */
  }

  // 欲望日志：书房可见，归在 persona_id 名下（不进 Notion）
  try {
    const desireRows = await listDesireRowsForGarden(db, 500);
    const replyCounts = await countDesireRepliesForGarden(
      db,
      desireRows.map((d) => d.id),
    );
    for (const d of desireRows) {
      const display = formatDesireDisplay(d);
      const reply_count = replyCounts.get(d.id) ?? 0;
      cards.push({
        id: `desire:${d.id}`,
        source: "desire",
        ref_id: d.id,
        persona_id: d.persona_id,
        type: "desire",
        title: desireTitle(d),
        summary: display,
        date: d.entry_date || (d.updated_at || d.created_at || "").slice(0, 10),
        favorite: favSet.has(`desire:${d.id}`),
        kind_label: "欲望",
        reply_count,
      });
    }
  } catch {
    /* desire table may lag on fresh DBs */
  }

  // 抽卡匣 diary/murmur：按标题 / tags(path) 挂到对应人名，花名册点进去不再空壳
  try {
    const aliasIndex = buildAliasIndex(personas);
    const knownIds = new Set(personas.map((p) => p.id));
    const deckRows =
      (
        await db
          .prepare(
            `SELECT id, title, content, kind, tags, created_by, created_at, updated_at
             FROM deck_items
             WHERE topic_id IN ('diary', 'murmur') AND kind IN ('diary', 'murmur')
             ORDER BY updated_at DESC LIMIT 800`,
          )
          .all<{
            id: string;
            title: string;
            content: string;
            kind: string;
            tags: string;
            created_by: string | null;
            created_at: string;
            updated_at: string;
          }>()
      ).results ?? [];
    for (const item of deckRows) {
      const pid = matchPersonaId(item.title, item.tags, item.created_by, aliasIndex, knownIds);
      if (!pid) continue;
      cards.push({
        id: `deck:${item.id}`,
        source: "deck",
        ref_id: item.id,
        persona_id: pid,
        type: item.kind === "murmur" ? "note" : "diary",
        title: item.title,
        summary: clip(item.content, 180),
        date: (item.updated_at || item.created_at || "").slice(0, 10),
        favorite: favSet.has(`deck:${item.id}`),
        kind_label: item.kind === "murmur" ? "碎碎念" : "日记",
      });
    }
  } catch {
    /* deck table may lag */
  }

  // 抽卡匣小说（kind=novel 或 topic 在 novel 家族含子类）：挂到作者/归属人名下，花名册可直接打开全文
  try {
    const novelFamily = await loadNovelFamilyIds(db);
    const novelIds = [...novelFamily];
    const ph = novelIds.map(() => "?").join(", ");
    const topicNameRows =
      (await db.prepare(`SELECT id, name FROM topics`).all<{ id: string; name: string }>()).results ?? [];
    const topicNames = new Map(topicNameRows.map((t) => [t.id, t.name]));
    const aliasIndexN = buildAliasIndex(personas);
    const knownIdsN = new Set(personas.map((p) => p.id));
    const novelRows =
      (
        await db
          .prepare(
            `SELECT id, title, content, kind, tags, topic_id, created_by, created_at, updated_at
             FROM deck_items
             WHERE kind = 'novel' OR topic_id IN (${ph})
             ORDER BY updated_at DESC LIMIT 800`,
          )
          .bind(...novelIds)
          .all<{
            id: string;
            title: string;
            content: string;
            kind: string;
            tags: string;
            topic_id: string;
            created_by: string | null;
            created_at: string;
            updated_at: string;
          }>()
      ).results ?? [];
    for (const item of novelRows) {
      const matched = matchPersonaId(item.title, item.tags, item.created_by, aliasIndexN, knownIdsN);
      const pid =
        matched ||
        (item.created_by && knownIdsN.has(item.created_by) ? item.created_by : null) ||
        "family";
      cards.push({
        id: `deck:${item.id}`,
        source: "deck",
        ref_id: item.id,
        persona_id: pid,
        type: "novel",
        title: item.title,
        summary: clip(item.content, 180),
        date: (item.updated_at || item.created_at || "").slice(0, 10),
        favorite: favSet.has(`deck:${item.id}`),
        kind_label: topicNames.get(item.topic_id) || "小说",
      });
    }
  } catch {
    /* deck/topics may lag */
  }

  cards.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));

  // Also include family memories as a synthetic person? Skip for roster purity; can show under 记忆 tab without person filter via owner family.
  const familyMemories = memories.filter((m) => m.owner_persona === "family");
  for (const m of familyMemories) {
    cards.push({
      id: `memory:${m.id}`,
      source: "memory",
      ref_id: m.id,
      persona_id: "family",
      type: memoryType(m.kind),
      title: memoryTitle(m.content),
      summary: clip(m.content, 180),
      date: (m.event_date || m.updated_at || "").slice(0, 10),
      favorite: favSet.has(`memory:${m.id}`),
      kind_label: m.kind,
    });
  }

  const needsFamily =
    familyMemories.length > 0 || cards.some((c) => c.persona_id === "family");
  if (!people.find((p) => p.id === "family") && needsFamily) {
    people.push({
      id: "family",
      name: "全家",
      note: "关于{{USER_NAME}}、全家都该知道的事。",
      emblem: "rose",
      relationship_to_user: "全家共享",
    });
  }

  return {
    people,
    cards,
    conversations,
    garden_entries: gardenEntries,
    voice_clips: voiceClips.map(({ kv_key: _k, ...rest }) => rest),
    garden_images: gardenImages.map(({ kv_key: _k, ...rest }) => rest),
    counts: {
      people: people.filter((p) => p.id !== "family").length,
      cards: cards.length,
      conversations: conversations.length,
      voice: voiceClips.length,
      image: gardenImages.length,
    },
  };
}

export async function getCardDetail(db: MemoryDb, source: string, refId: string) {
  if (source === "conversation") {
    const c = await getConversation(db, refId);
    return {
      id: `conversation:${c.id}`,
      source,
      ref_id: c.id,
      persona_id: c.persona_id,
      type: "conversation" as const,
      title: c.title,
      summary: c.summary,
      full_text: c.full_text,
      date: c.entry_date,
      favorite: !!c.favorite,
    };
  }
  if (source === "garden") {
    const g = await db.prepare(`SELECT * FROM garden_entries WHERE id = ?`).bind(refId).first<GardenEntryRow>();
    if (!g) throw new AppError(404, "not_found", "没有这条记录。");
    return {
      id: `garden:${g.id}`,
      source,
      ref_id: g.id,
      persona_id: g.persona_id,
      type: g.kind,
      title: g.title,
      summary: clip(g.body, 180),
      full_text: g.body,
      date: g.entry_date,
      favorite: !!g.favorite,
    };
  }
  if (source === "memory") {
    const m = await db.prepare(`SELECT * FROM memories WHERE id = ?`).bind(refId).first<MemoryRow>();
    if (!m) throw new AppError(404, "not_found", "没有这条记忆。");
    const fav = await db
      .prepare(`SELECT 1 AS ok FROM garden_favorites WHERE kind = 'memory' AND ref_id = ?`)
      .bind(refId)
      .first<{ ok: number }>();
    return {
      id: `memory:${m.id}`,
      source,
      ref_id: m.id,
      persona_id: m.owner_persona,
      type: memoryType(m.kind),
      title: memoryTitle(m.content),
      summary: clip(m.content, 180),
      full_text: m.content,
      date: (m.event_date || m.updated_at || "").slice(0, 10),
      favorite: !!fav,
      kind_label: m.kind,
    };
  }
  if (source === "voice") {
    const v = await getVoiceClip(db, refId);
    return {
      id: `voice:${v.id}`,
      source,
      ref_id: v.id,
      persona_id: v.persona_id,
      type: "voice" as const,
      title: v.title,
      summary: `语音 · ${(v.size / 1024).toFixed(1)} KB`,
      full_text: "",
      date: (v.entry_date || v.created_at || "").slice(0, 10),
      favorite: !!v.favorite,
      mime: v.mime,
      size: v.size,
      play_url: `/api/view/voice/${v.id}`,
    };
  }
  if (source === "image") {
    const img = await getGardenImage(db, refId);
    return {
      id: `image:${img.id}`,
      source,
      ref_id: img.id,
      persona_id: img.persona_id,
      type: "image" as const,
      title: img.title,
      summary: `图片 · ${(img.size / 1024).toFixed(1)} KB`,
      full_text: "",
      date: (img.entry_date || img.created_at || "").slice(0, 10),
      favorite: !!img.favorite,
      mime: img.mime,
      size: img.size,
      play_url: `/api/view/images/${img.id}`,
    };
  }
  if (source === "note") {
    const n = await db.prepare(`SELECT * FROM notes WHERE id = ?`).bind(refId).first<NoteRow>();
    if (!n) throw new AppError(404, "not_found", "没有这张便条。");
    const text = [`{{USER_NAME}}：${n.content}`, n.reply ? `回复：${n.reply}` : "（还没有回复）"].join("\n\n");
    return {
      id: `note:${n.id}`,
      source,
      ref_id: n.id,
      persona_id: n.persona_id,
      type: "note" as const,
      title: clip(n.content, 36),
      summary: clip(text, 180),
      full_text: text,
      date: (n.created_at || "").slice(0, 10),
      favorite: false,
      note: { content: n.content, reply: n.reply || "" },
    };
  }
  if (source === "unresolved") {
    const u = await db.prepare(`SELECT * FROM unresolved WHERE id = ?`).bind(refId).first<UnresolvedRow>();
    if (!u) throw new AppError(404, "not_found", "没有这件未了的事。");
    const text = [u.content, u.context ? `背景：${u.context}` : "", u.resolution ? `了结：${u.resolution}` : `状态：${u.status}`]
      .filter(Boolean)
      .join("\n\n");
    return {
      id: `unresolved:${u.id}`,
      source,
      ref_id: u.id,
      persona_id: u.persona_id,
      type: "unresolved" as const,
      title: clip(u.content, 36),
      summary: clip(text, 180),
      full_text: text,
      date: (u.updated_at || "").slice(0, 10),
      favorite: false,
      unresolved: { content: u.content, context: u.context || "", status: u.status, resolution: u.resolution || "" },
    };
  }
  if (source === "handoff") {
    const h = await db.prepare(`SELECT * FROM handoffs WHERE id = ?`).bind(refId).first<HandoffRow>();
    if (!h) throw new AppError(404, "not_found", "没有这张交接便签。");
    const text = [h.summary, h.mood ? `心情：${h.mood}` : "", h.next_time ? `下次：${h.next_time}` : ""].filter(Boolean).join("\n\n");
    return {
      id: `handoff:${h.id}`,
      source,
      ref_id: h.id,
      persona_id: h.persona_id,
      type: "handoff" as const,
      title: clip(h.summary, 36),
      summary: clip(text, 180),
      full_text: text,
      date: (h.created_at || "").slice(0, 10),
      favorite: false,
      handoff: { summary: h.summary, mood: h.mood || "", next_time: h.next_time || "" },
    };
  }

  if (source === "desire") {
    const d = await getDesireRow(db, refId);
    if (!d) throw new AppError(404, "not_found", "没有这条欲望记录。");
    const display = formatDesireDisplay(d);
    const replies = await listDesireRepliesForGarden(db, d.id);
    const fav = await db
      .prepare(`SELECT 1 AS ok FROM garden_favorites WHERE kind = 'desire' AND ref_id = ?`)
      .bind(refId)
      .first<{ ok: number }>();
    return {
      id: `desire:${d.id}`,
      source,
      ref_id: d.id,
      persona_id: d.persona_id,
      type: "desire" as const,
      title: desireTitle(d),
      summary: display,
      full_text: display,
      date: d.entry_date || (d.updated_at || d.created_at || "").slice(0, 10),
      favorite: !!fav,
      kind_label: "欲望",
      reply_count: replies.length,
      replies,
      desire: {
        entry_date: d.entry_date,
        level_label: d.level_label,
        status: d.status,
        source: d.source,
        source_custom: d.source_custom,
        trigger_text: d.trigger_text,
        mood: d.mood,
      },
    };
  }

  if (source === "heart") {
    const h = await db
      .prepare(
        `SELECT id, title, content, created_by, created_at, updated_at FROM deck_items
         WHERE id = ? AND topic_id = 'heart'`,
      )
      .bind(refId)
      .first<{
        id: string;
        title: string;
        content: string;
        created_by: string | null;
        created_at: string;
        updated_at: string;
      }>();
    if (!h) throw new AppError(404, "not_found", "没有这条心痕。");
    return {
      id: `heart:${h.id}`,
      source,
      ref_id: h.id,
      persona_id: h.created_by || "unknown",
      type: "heart" as const,
      title: h.title,
      summary: clip(h.content, 180),
      full_text: h.content,
      date: (h.updated_at || h.created_at || "").slice(0, 10),
      favorite: false,
      kind_label: "心痕",
    };
  }
  if (source === "deck") {
    const full = await db
      .prepare(
        `SELECT d.id, d.title, d.content, d.kind, d.tags, d.topic_id, d.created_by,
                d.created_at, d.updated_at, t.name AS topic_name
         FROM deck_items d
         LEFT JOIN topics t ON t.id = d.topic_id
         WHERE d.id = ?`,
      )
      .bind(refId)
      .first<{
        id: string;
        title: string;
        content: string;
        kind: string;
        tags: string;
        topic_id: string;
        created_by: string | null;
        created_at: string;
        updated_at: string;
        topic_name: string | null;
      }>();
    if (!full) throw new AppError(404, "not_found", "没有这条抽卡匣记录。");
    const personas =
      (await db.prepare(`SELECT id, display_name FROM personas`).all<{ id: string; display_name: string }>()).results ?? [];
    const aliasIndex = buildAliasIndex(personas);
    const knownIds = new Set(personas.map((p) => p.id));
    const pid =
      matchPersonaId(full.title, full.tags, full.created_by, aliasIndex, knownIds) ||
      full.created_by ||
      "unknown";
    const fav = await db
      .prepare(`SELECT 1 AS ok FROM garden_favorites WHERE kind = 'deck' AND ref_id = ?`)
      .bind(refId)
      .first<{ ok: number }>();
    const novelFamily = await loadNovelFamilyIds(db);
    const isNovel = full.kind === "novel" || novelFamily.has(full.topic_id);
    let cardType: GardenCardType = "diary";
    let kindLabel = "日记";
    if (full.kind === "murmur") {
      cardType = "note";
      kindLabel = "碎碎念";
    } else if (full.kind === "heart") {
      cardType = "heart";
      kindLabel = "心痕";
    } else if (isNovel) {
      cardType = "novel";
      kindLabel = full.topic_name || "小说";
    } else if (full.kind === "diary") {
      cardType = "diary";
      kindLabel = "日记";
    } else {
      cardType = "memory";
      kindLabel = full.topic_name || full.kind || "记忆";
    }
    return {
      id: `deck:${full.id}`,
      source,
      ref_id: full.id,
      persona_id: pid,
      type: cardType,
      title: full.title,
      summary: clip(full.content, 180),
      full_text: full.content,
      date: (full.updated_at || full.created_at || "").slice(0, 10),
      favorite: !!fav,
      kind_label: kindLabel,
    };
  }
  throw new AppError(404, "not_found", "没有这个来源。");
}
