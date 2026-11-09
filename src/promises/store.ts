/**
 * Persona-scoped promise rows. One persona's list holds both authors.
 * Author is not a persona id. Queries always filter on persona_id.
 */

import { AppError } from "../errors";
import type { MemoryDb } from "../types";
import {
  bloom,
  canCheck,
  canUncheck,
  isPromiseAuthor,
  pageOrder,
  statusOf,
  wakeList,
  type Bloom,
  type PromiseAuthor,
  type PromiseFields,
  type PromiseStatus,
} from "./rules";
import { promiseSchemaStatements } from "./schema";

export interface PromiseReply {
  id: string;
  author: PromiseAuthor;
  text: string;
  createdAt: number;
}

export interface PromiseRecord extends PromiseFields {
  personaId: string;
  text: string;
  resolution: string | null;
  status: PromiseStatus;
  bloom: Bloom;
  replies: PromiseReply[];
}

export type ToggleReason = "self" | "early" | "not_checker";

export type MutationResult =
  | { ok: true; applied: true; action: "check" | "uncheck" | "close" | "defer" | "reply"; item: PromiseRecord }
  | { ok: true; applied: false; reason: ToggleReason | "already_checked"; item: PromiseRecord }
  | { ok: false; reason: "missing" };

interface PromiseRow {
  id: string;
  persona_id: string;
  author: string;
  promise_text: string;
  due_at: string | null;
  surface_at: string | null;
  checked_by: string | null;
  checked_at: string | null;
  resolution: string | null;
  status: string;
  created_at: string;
}

interface ReplyRow {
  id: string;
  promise_id: string;
  persona_id: string;
  author: string;
  promise_text: string;
  created_at: string;
}

const ready = new WeakMap<MemoryDb, Promise<void>>();

export function ensurePromiseSchema(db: MemoryDb): Promise<void> {
  let pending = ready.get(db);
  if (!pending) {
    pending = applySchema(db).catch((error: unknown) => {
      ready.delete(db);
      throw error;
    });
    ready.set(db, pending);
  }
  return pending;
}

async function applySchema(db: MemoryDb): Promise<void> {
  for (const sql of promiseSchemaStatements()) {
    await db.prepare(sql).run();
  }
}

const SELECT_PROMISE = `SELECT id, persona_id, author, "text" AS promise_text, due_at, surface_at,
  checked_by, checked_at, resolution, status, created_at
  FROM companion_promises`;

const SELECT_REPLY = `SELECT id, promise_id, persona_id, author, "text" AS promise_text, created_at
  FROM companion_promise_replies`;

export class PromiseStore {
  constructor(
    private readonly db: MemoryDb,
    private readonly timeZone: string,
  ) {}

  async addPage(input: {
    personaId: string;
    author: PromiseAuthor;
    text: string;
    dueAt: number | null;
    now: number;
  }): Promise<PromiseRecord | null> {
    const text = input.text.trim();
    if (!text) return null;
    requireAuthor(input.author);
    const id = `p-${crypto.randomUUID()}`;
    await this.db
      .prepare(
        `INSERT INTO companion_promises
          (id, persona_id, author, "text", due_at, surface_at, checked_by, checked_at, resolution, status, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'open', ?)`,
      )
      .bind(id, input.personaId, input.author, text, input.dueAt == null ? null : toIso(input.dueAt), toIso(input.now))
      .run();
    return this.mustGet(input.personaId, id, input.now);
  }

  /** Chu's add. Writes surface_at only. Author is chu. due_at stays empty. */
  async addContent(input: {
    personaId: string;
    text: string;
    surfaceAt: number | null;
    now: number;
  }): Promise<PromiseRecord | null> {
    const text = input.text.trim();
    if (!text) return null;
    const id = `c-${crypto.randomUUID()}`;
    await this.db
      .prepare(
        `INSERT INTO companion_promises
          (id, persona_id, author, "text", due_at, surface_at, checked_by, checked_at, resolution, status, created_at)
         VALUES (?, ?, 'chu', ?, NULL, ?, NULL, NULL, NULL, 'open', ?)`,
      )
      .bind(id, input.personaId, text, input.surfaceAt == null ? null : toIso(input.surfaceAt), toIso(input.now))
      .run();
    return this.mustGet(input.personaId, id, input.now);
  }

  async toggleCheck(personaId: string, id: string, viewer: PromiseAuthor, now: number): Promise<MutationResult> {
    requireAuthor(viewer);
    const current = await this.get(personaId, id, now);
    if (!current) return { ok: false, reason: "missing" };
    if (canCheck(current, viewer, now)) {
      await this.db
        .prepare(
          `UPDATE companion_promises
             SET checked_by = ?, checked_at = ?, status = 'done'
           WHERE id = ? AND persona_id = ? AND checked_at IS NULL`,
        )
        .bind(viewer, toIso(now), id, personaId)
        .run();
      return { ok: true, applied: true, action: "check", item: await this.mustGet(personaId, id, now) };
    }
    if (canUncheck(current, viewer)) {
      await this.db
        .prepare(
          `UPDATE companion_promises
             SET checked_by = NULL, checked_at = NULL, resolution = NULL, status = 'open'
           WHERE id = ? AND persona_id = ? AND checked_by = ?`,
        )
        .bind(id, personaId, viewer)
        .run();
      return { ok: true, applied: true, action: "uncheck", item: await this.mustGet(personaId, id, now) };
    }
    return { ok: true, applied: false, reason: toggleReason(current, viewer, now), item: current };
  }

  /**
   * Chu's close channel. Attributes the check to chu even when chu wrote
   * the item, and does not consult canCheck. A second close is a no-op.
   */
  async close(personaId: string, id: string, resolution: string | null, now: number): Promise<MutationResult> {
    const current = await this.get(personaId, id, now);
    if (!current) return { ok: false, reason: "missing" };
    if (current.checkedAt != null) return { ok: true, applied: false, reason: "already_checked", item: current };
    await this.db
      .prepare(
        `UPDATE companion_promises
           SET checked_by = 'chu', checked_at = ?, resolution = ?, status = 'done'
         WHERE id = ? AND persona_id = ? AND checked_at IS NULL`,
      )
      .bind(toIso(now), resolution, id, personaId)
      .run();
    return { ok: true, applied: true, action: "close", item: await this.mustGet(personaId, id, now) };
  }

  /** Moves surface_at on an open item. Checked items stay where they are. */
  async defer(personaId: string, id: string, surfaceAt: number, now: number): Promise<MutationResult> {
    const current = await this.get(personaId, id, now);
    if (!current) return { ok: false, reason: "missing" };
    if (current.checkedAt != null) return { ok: true, applied: false, reason: "already_checked", item: current };
    await this.db
      .prepare(`UPDATE companion_promises SET surface_at = ? WHERE id = ? AND persona_id = ? AND checked_at IS NULL`)
      .bind(toIso(surfaceAt), id, personaId)
      .run();
    return { ok: true, applied: true, action: "defer", item: await this.mustGet(personaId, id, now) };
  }

  async reply(personaId: string, id: string, author: PromiseAuthor, text: string, now: number): Promise<MutationResult> {
    requireAuthor(author);
    const body = text.trim();
    if (!body) throw new AppError(400, "invalid", "回话是空的。");
    const current = await this.get(personaId, id, now);
    if (!current) return { ok: false, reason: "missing" };
    const replyId = `r-${crypto.randomUUID()}`;
    await this.db
      .prepare(
        `INSERT INTO companion_promise_replies (id, promise_id, persona_id, author, "text", created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(replyId, id, personaId, author, body, toIso(now))
      .run();
    return { ok: true, applied: true, action: "reply", item: await this.mustGet(personaId, id, now) };
  }

  async page(personaId: string, now: number): Promise<PromiseRecord[]> {
    const items = await this.list(personaId, now);
    return pageOrder(items, now);
  }

  async wake(personaId: string, now: number): Promise<{ items: PromiseRecord[]; remaining: number }> {
    const items = await this.list(personaId, now);
    return wakeList(items, now, this.timeZone);
  }

  private async list(personaId: string, now: number): Promise<PromiseRecord[]> {
    const rows = await this.db.prepare(`${SELECT_PROMISE} WHERE persona_id = ?`).bind(personaId).all<PromiseRow>();
    const replies = await this.db
      .prepare(`${SELECT_REPLY} WHERE persona_id = ? ORDER BY created_at ASC, id ASC`)
      .bind(personaId)
      .all<ReplyRow>();
    const byPromise = new Map<string, PromiseReply[]>();
    for (const row of replies.results ?? []) {
      const list = byPromise.get(row.promise_id) ?? [];
      list.push(mapReply(row));
      byPromise.set(row.promise_id, list);
    }
    return (rows.results ?? []).map((row) => mapPromise(row, byPromise.get(row.id) ?? [], now));
  }

  private async get(personaId: string, id: string, now: number): Promise<PromiseRecord | null> {
    const row = await this.db
      .prepare(`${SELECT_PROMISE} WHERE id = ? AND persona_id = ?`)
      .bind(id, personaId)
      .first<PromiseRow>();
    if (!row) return null;
    const replies = await this.db
      .prepare(`${SELECT_REPLY} WHERE promise_id = ? AND persona_id = ? ORDER BY created_at ASC, id ASC`)
      .bind(id, personaId)
      .all<ReplyRow>();
    return mapPromise(row, (replies.results ?? []).map(mapReply), now);
  }

  private async mustGet(personaId: string, id: string, now: number): Promise<PromiseRecord> {
    const row = await this.get(personaId, id, now);
    if (!row) throw new Error(`promise ${id} disappeared for ${personaId}`);
    return row;
  }
}

function requireAuthor(value: string): asserts value is PromiseAuthor {
  if (!isPromiseAuthor(value)) throw new AppError(400, "invalid", "作者只认初和燕燕。");
}

function toggleReason(item: PromiseRecord, viewer: PromiseAuthor, now: number): ToggleReason {
  if (item.checkedAt == null && viewer === item.author) return "self";
  if (item.checkedAt == null && item.dueAt != null && now < item.dueAt) return "early";
  return "not_checker";
}

function mapReply(row: ReplyRow): PromiseReply {
  if (!isPromiseAuthor(row.author)) throw new Error("stored reply author is outside chu|yanyan");
  return { id: row.id, author: row.author, text: row.promise_text, createdAt: fromIso(row.created_at) };
}

function mapPromise(row: PromiseRow, replies: PromiseReply[], now: number): PromiseRecord {
  if (!isPromiseAuthor(row.author)) throw new Error("stored author is outside chu|yanyan");
  if (row.checked_by != null && !isPromiseAuthor(row.checked_by)) throw new Error("stored checker is outside chu|yanyan");
  const checkedAt = row.checked_at == null ? null : fromIso(row.checked_at);
  const checkedBy = row.checked_by == null ? null : row.checked_by;
  const derived = statusOf({ checkedAt });
  if (row.status !== derived) throw new Error("stored status does not match checked_at");
  if (derived === "open" && (checkedBy != null || row.resolution != null)) {
    throw new Error("open promise still carries a check");
  }
  if (derived === "done" && (checkedAt == null || checkedBy == null)) {
    throw new Error("done promise is missing its checker");
  }
  const dueAt = row.due_at == null ? null : fromIso(row.due_at);
  const surfaceAt = row.surface_at == null ? null : fromIso(row.surface_at);
  return {
    id: row.id,
    personaId: row.persona_id,
    author: row.author,
    text: row.promise_text,
    createdAt: fromIso(row.created_at),
    dueAt,
    surfaceAt,
    checkedBy,
    checkedAt,
    resolution: row.resolution,
    status: derived,
    bloom: bloom({ checkedAt, dueAt }, now),
    replies,
  };
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function fromIso(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error("stored instant is not ISO");
  return ms;
}
