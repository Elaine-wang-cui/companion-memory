import { schemaCurrent } from "./schema-gate";
/** 记忆屋 → Notion reverse sync: outbox queue + persona page mappings (no Notion token in Worker). */
import { AppError } from "./errors";
import type { MemoryDb } from "./types";
import NOTION_SYNC_SQL from "../migrations/0007_notion_sync.sql";

export const OUTBOX_KINDS = [
  "persona",
  "conversation",
  "garden_entry",
  "deck_item",
  "memory",
] as const;

export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export const OUTBOX_STATUSES = ["pending", "synced", "skipped", "error"] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export interface PersonaNotionRow {
  persona_id: string;
  notion_page_id: string | null;
  notion_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotionOutboxRow {
  id: string;
  kind: OutboxKind;
  local_id: string;
  persona_id: string | null;
  title: string;
  body: string;
  status: OutboxStatus;
  notion_page_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Known persona → Notion parent pages (also seeded in 0007). */
/** Optional: seed persona → external page mappings here (empty by default). */
export const KNOWN_PERSONA_NOTION: { persona_id: string; notion_page_id: string; notion_url?: string }[] = [];

const MAX_OUTBOX_BODY = 80_000;

function nowIso(): string {
  return new Date().toISOString();
}

function clipBody(value: string, max = MAX_OUTBOX_BODY): string {
  const chars = [...value];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

export function normalizeNotionPageId(raw: string): string {
  const hex = raw.replace(/-/g, "").trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(hex)) {
    throw new AppError(400, "invalid", "notion_page_id 应为 32 位十六进制（可带横杠）。");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function notionUrlForPageId(pageId: string): string {
  const id = normalizeNotionPageId(pageId);
  return id.replace(/-/g, ""); // set your own URL scheme if you mirror to an external notes app
}

let notionSchemaReady: Promise<void> | null = null;

export function ensureNotionSyncSchema(db: MemoryDb): Promise<void> {
  if (!notionSchemaReady) {
    notionSchemaReady = (async () => {
      if (await schemaCurrent(db)) return;
      const statements = NOTION_SYNC_SQL.split(";")
        .map((s: string) => s.replace(/^\s*--.*$/gm, "").trim())
        .filter(Boolean);
      for (const sql of statements) await db.prepare(sql).run();
    })().catch((error) => {
      notionSchemaReady = null;
      throw error;
    });
  }
  return notionSchemaReady;
}

/** Reset schema-ready latch (tests). */
export function resetNotionSyncSchemaLatch(): void {
  notionSchemaReady = null;
}

export async function getPersonaNotion(
  db: MemoryDb,
  personaId: string,
): Promise<PersonaNotionRow | null> {
  await ensureNotionSyncSchema(db);
  return db
    .prepare(`SELECT persona_id, notion_page_id, notion_url, created_at, updated_at FROM persona_notion WHERE persona_id = ?`)
    .bind(personaId)
    .first<PersonaNotionRow>();
}

export async function listPersonaNotion(db: MemoryDb): Promise<PersonaNotionRow[]> {
  await ensureNotionSyncSchema(db);
  const r = await db
    .prepare(
      `SELECT persona_id, notion_page_id, notion_url, created_at, updated_at
       FROM persona_notion ORDER BY persona_id ASC`,
    )
    .all<PersonaNotionRow>();
  return r.results ?? [];
}

export async function upsertPersonaNotion(
  db: MemoryDb,
  input: { persona_id: string; notion_page_id: string; notion_url?: string | null },
): Promise<PersonaNotionRow> {
  await ensureNotionSyncSchema(db);
  const persona_id = input.persona_id.trim().toLowerCase();
  if (!persona_id) throw new AppError(400, "invalid", "需要 persona_id。");
  const notion_page_id = normalizeNotionPageId(input.notion_page_id);
  const notion_url = (input.notion_url ?? "").trim() || notionUrlForPageId(notion_page_id);
  const t = nowIso();
  await db
    .prepare(
      `INSERT INTO persona_notion (persona_id, notion_page_id, notion_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(persona_id) DO UPDATE SET
         notion_page_id = excluded.notion_page_id,
         notion_url = excluded.notion_url,
         updated_at = excluded.updated_at`,
    )
    .bind(persona_id, notion_page_id, notion_url, t, t)
    .run();
  const row = await getPersonaNotion(db, persona_id);
  if (!row) throw new AppError(500, "internal", "写入 persona_notion 后读不回来。");
  return row;
}

export interface EnqueueOutboxInput {
  kind: OutboxKind;
  local_id: string;
  persona_id?: string | null;
  title: string;
  body?: string;
}

/**
 * Enqueue an outbound Notion sync item.
 * Dedupes on (kind, local_id). If already synced/skipped, leaves it alone.
 * If still pending, refreshes title/body.
 * Never enqueue heart-traces (caller must not call for kind heart).
 */
export async function enqueueNotionOutbox(
  db: MemoryDb,
  input: EnqueueOutboxInput,
): Promise<{ id: string; enqueued: boolean; reason?: string }> {
  await ensureNotionSyncSchema(db);
  const kind = input.kind;
  const local_id = input.local_id.trim();
  if (!local_id) return { id: "", enqueued: false, reason: "empty local_id" };
  if (kind === "persona") {
    const mapped = await getPersonaNotion(db, input.persona_id || local_id);
    if (mapped?.notion_page_id) {
      return { id: "", enqueued: false, reason: "persona already mapped" };
    }
  }

  const title = (input.title || "").trim() || local_id;
  const body = clipBody(input.body ?? "");
  const persona_id = input.persona_id?.trim() || null;
  const t = nowIso();
  const id = crypto.randomUUID();

  const existing = await db
    .prepare(`SELECT id, status FROM notion_outbox WHERE kind = ? AND local_id = ?`)
    .bind(kind, local_id)
    .first<{ id: string; status: OutboxStatus }>();

  if (existing) {
    if (existing.status === "synced" || existing.status === "skipped") {
      return { id: existing.id, enqueued: false, reason: `already ${existing.status}` };
    }
    await db
      .prepare(
        `UPDATE notion_outbox
         SET title = ?, body = ?, persona_id = COALESCE(?, persona_id), status = 'pending', error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .bind(title, body, persona_id, t, existing.id)
      .run();
    return { id: existing.id, enqueued: true, reason: "refreshed pending" };
  }

  await db
    .prepare(
      `INSERT INTO notion_outbox
        (id, kind, local_id, persona_id, title, body, status, notion_page_id, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`,
    )
    .bind(id, kind, local_id, persona_id, title, body, t, t)
    .run();
  return { id, enqueued: true };
}

/** True if deck item originated from Notion import — do not reverse-push. */
export function isNotionSourcedDeckItem(input: {
  source_page_id?: string | null;
  source_url?: string | null;
  kind?: string | null;
  topic_id?: string | null;
}): boolean {
  if (input.kind === "heart" || input.topic_id === "heart") return true;
  if (input.source_page_id && String(input.source_page_id).trim()) return true;
  const url = (input.source_url || "").toLowerCase();
  if (url.includes("notion.so") || url.includes("notion.com")) return true;
  return false;
}

export async function listNotionOutbox(
  db: MemoryDb,
  opts: { status?: OutboxStatus; limit?: number; kind?: OutboxKind } = {},
): Promise<NotionOutboxRow[]> {
  await ensureNotionSyncSchema(db);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const clauses: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (opts.status) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  if (opts.kind) {
    clauses.push("kind = ?");
    params.push(opts.kind);
  }
  const r = await db
    .prepare(
      `SELECT id, kind, local_id, persona_id, title, body, status, notion_page_id, error, created_at, updated_at
       FROM notion_outbox
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<NotionOutboxRow>();
  return r.results ?? [];
}

export async function ackNotionOutbox(
  db: MemoryDb,
  input: { id: string; notion_page_id: string; notion_url?: string | null },
): Promise<NotionOutboxRow> {
  await ensureNotionSyncSchema(db);
  const id = input.id.trim();
  if (!id) throw new AppError(400, "invalid", "需要 id。");
  const row = await db
    .prepare(`SELECT * FROM notion_outbox WHERE id = ?`)
    .bind(id)
    .first<NotionOutboxRow>();
  if (!row) throw new AppError(404, "not_found", "没有这条出站记录。");

  const notion_page_id = normalizeNotionPageId(input.notion_page_id);
  const notion_url = (input.notion_url ?? "").trim() || notionUrlForPageId(notion_page_id);
  const t = nowIso();

  await db
    .prepare(
      `UPDATE notion_outbox
       SET status = 'synced', notion_page_id = ?, error = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .bind(notion_page_id, t, id)
    .run();

  if (row.kind === "persona" && row.persona_id) {
    await upsertPersonaNotion(db, {
      persona_id: row.persona_id,
      notion_page_id,
      notion_url,
    });
  } else if (row.kind === "persona" && row.local_id) {
    await upsertPersonaNotion(db, {
      persona_id: row.local_id,
      notion_page_id,
      notion_url,
    });
  }

  const updated = await db
    .prepare(`SELECT * FROM notion_outbox WHERE id = ?`)
    .bind(id)
    .first<NotionOutboxRow>();
  if (!updated) throw new AppError(500, "internal", "ACK 后读不回来。");
  return updated;
}

export async function skipNotionOutbox(
  db: MemoryDb,
  input: { id: string; error?: string | null },
): Promise<NotionOutboxRow> {
  await ensureNotionSyncSchema(db);
  const id = input.id.trim();
  if (!id) throw new AppError(400, "invalid", "需要 id。");
  const row = await db
    .prepare(`SELECT * FROM notion_outbox WHERE id = ?`)
    .bind(id)
    .first<NotionOutboxRow>();
  if (!row) throw new AppError(404, "not_found", "没有这条出站记录。");
  const t = nowIso();
  await db
    .prepare(
      `UPDATE notion_outbox SET status = 'skipped', error = ?, updated_at = ? WHERE id = ?`,
    )
    .bind((input.error ?? "").trim() || null, t, id)
    .run();
  const updated = await db
    .prepare(`SELECT * FROM notion_outbox WHERE id = ?`)
    .bind(id)
    .first<NotionOutboxRow>();
  if (!updated) throw new AppError(500, "internal", "skip 后读不回来。");
  return updated;
}

/** Fire-and-forget enqueue wrapper — never throws into callers. */
export async function safeEnqueueNotionOutbox(
  db: MemoryDb,
  input: EnqueueOutboxInput,
): Promise<void> {
  try {
    await enqueueNotionOutbox(db, input);
  } catch (err) {
    console.error("[notion-outbox] enqueue failed", input.kind, input.local_id, err);
  }
}
