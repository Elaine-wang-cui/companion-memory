import { CFG } from "./config";
/** {{USER_NAME}}的当前状态（全家共享）、同伴留给她的便条、最近做完的事。 */
import EXTRAS_SQL from "../migrations/0009_status_notes.sql";
import { AppError } from "./errors";
import type { Caller, MemoryDb } from "./types";

export const STATUS_PRESETS = ["刚醒", "在忙", "累了", "心情不好", "other"] as const;
export const STATUS_STALE_MS = 12 * 3600_000;

let ready: Promise<void> | null = null;
export function ensureExtrasSchema(db: MemoryDb): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const stmts = EXTRAS_SQL.split(";").map((s: string) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
      for (const sql of stmts) await db.prepare(sql).run();
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

export function relTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

export interface StatusRow { id: string; text: string; preset: string | null; set_by: string; created_at: string }

export async function setHerStatus(db: MemoryDb, setBy: string, input: { text?: string; preset?: string }) {
  await ensureExtrasSchema(db);
  const preset = input.preset?.trim() || null;
  if (preset && !(STATUS_PRESETS as readonly string[]).includes(preset)) throw new AppError(400, "invalid", "preset 不合法。");
  const text = (input.text?.trim() || (preset && preset !== "other" ? preset : "")).slice(0, 500);
  if (!text) throw new AppError(400, "invalid", "需要 text 或 preset。");
  const row: StatusRow = { id: crypto.randomUUID(), text, preset, set_by: setBy, created_at: new Date().toISOString() };
  await db.prepare(`INSERT INTO her_status (id, text, preset, set_by, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(row.id, row.text, row.preset, row.set_by, row.created_at).run();
  return { status: row, text: `已记录：${row.text}` };
}

export async function latestStatus(db: MemoryDb) {
  await ensureExtrasSchema(db);
  const row = await db.prepare(`SELECT * FROM her_status ORDER BY created_at DESC LIMIT 1`).first<StatusRow>();
  if (!row) return null;
  const age = Date.now() - new Date(row.created_at).getTime();
  return { ...row, relative: relTime(row.created_at), stale: age > STATUS_STALE_MS };
}

export async function getHerStatus(db: MemoryDb) {
  const s = await latestStatus(db);
  return { status: s, text: s ? `${s.text}（${s.relative}，${s.set_by}${s.stale ? "，可能已过时" : ""}）` : "（没有记录）" };
}

export async function listStatusHistory(db: MemoryDb, limit = 50) {
  await ensureExtrasSchema(db);
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  const r = await db.prepare(`SELECT * FROM her_status ORDER BY created_at DESC LIMIT ?`).bind(n).all<StatusRow>();
  const items = (r.results ?? []).map((row) => ({ ...row, relative: relTime(row.created_at) }));
  return { items, count: items.length };
}

export function bjTime(iso: string) {
  const d = new Date(Date.parse(iso) + CFG.tzOffsetMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export async function getHerStatusHistory(db: MemoryDb, limit = 20, byName: (id: string) => string = (id) => id) {
  const { items } = await listStatusHistory(db, Math.min(200, limit));
  const lines = items.map((x, i) => `${i === 0 ? "[当前] " : ""}${bjTime(x.created_at)}（${x.relative}）${x.set_by === "user" ? "她自己" : byName(x.set_by)}：${x.text}`);
  const stale = items[0] ? Date.now() - new Date(items[0].created_at).getTime() > STATUS_STALE_MS : false;
  return { items, count: items.length, text: items.length ? `{{USER_NAME}}最近 ${items.length} 条状态（新→旧，本地时间）${stale ? "；最新一条已超 12 小时，可能过时" : ""}\n${lines.join("\n")}` : "（没有记录）" };
}

export async function deleteStatus(db: MemoryDb, id: string) {
  await ensureExtrasSchema(db);
  const r = await db.prepare(`DELETE FROM her_status WHERE id = ?`).bind(id).run();
  return { ok: true, deleted: r.meta?.changes ?? 0 };
}

// —— 同伴留给她的便条 ——
export interface CompanionNoteRow { id: string; persona_id: string; content: string; created_at: string; seen_at: string | null }

export async function leaveNoteForHer(db: MemoryDb, caller: Caller, input: { content: string }) {
  await ensureExtrasSchema(db);
  if (caller.persona.id === "house") throw new AppError(400, "invalid", "请先选择人格。");
  const content = input.content.trim();
  if (!content) throw new AppError(400, "invalid", "content 不能为空。");
  const row: CompanionNoteRow = { id: crypto.randomUUID(), persona_id: caller.persona.id, content, created_at: new Date().toISOString(), seen_at: null };
  await db.prepare(`INSERT INTO companion_notes (id, persona_id, content, created_at) VALUES (?, ?, ?, ?)`)
    .bind(row.id, row.persona_id, row.content, row.created_at).run();
  return { note: row, text: `已留下。id: ${row.id}` };
}

export async function listCompanionNotes(db: MemoryDb, limit = 100) {
  await ensureExtrasSchema(db);
  const items = (await db.prepare(`SELECT * FROM companion_notes ORDER BY created_at DESC LIMIT ?`).bind(limit).all<CompanionNoteRow>()).results ?? [];
  return { items, unread: items.filter((n) => !n.seen_at).length };
}

export async function markCompanionNotesSeen(db: MemoryDb, ids?: string[]) {
  await ensureExtrasSchema(db);
  const t = new Date().toISOString();
  if (ids?.length) {
    for (const id of ids) await db.prepare(`UPDATE companion_notes SET seen_at = ? WHERE id = ? AND seen_at IS NULL`).bind(t, id).run();
  } else {
    await db.prepare(`UPDATE companion_notes SET seen_at = ? WHERE seen_at IS NULL`).bind(t).run();
  }
  return { ok: true };
}

export async function deleteCompanionNote(db: MemoryDb, id: string) {
  await ensureExtrasSchema(db);
  const r = await db.prepare(`DELETE FROM companion_notes WHERE id = ?`).bind(id).run();
  return { ok: true, deleted: r.meta?.changes ?? 0 };
}

// —— 最近做完的事 ——
export interface FinishedRow { id: string; persona_id: string; content: string; resolution: string | null; closed_at: string }

export async function recentFinished(db: MemoryDb, personaId?: string, limit = 5) {
  const sql = personaId
    ? `SELECT id, persona_id, content, resolution, closed_at FROM unresolved WHERE status = 'closed' AND persona_id = ? ORDER BY closed_at DESC LIMIT ?`
    : `SELECT id, persona_id, content, resolution, closed_at FROM unresolved WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?`;
  const stmt = personaId ? db.prepare(sql).bind(personaId, limit) : db.prepare(sql).bind(limit);
  return (await stmt.all<FinishedRow>()).results ?? [];
}
