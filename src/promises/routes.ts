/**
 * Promise HTTP routes. Not mounted from src/http.ts.
 *
 * A later transplant, after the user approves it against the live Worker,
 * can call handlePromiseRequest and return the Response when it is non-null.
 * Paths that are not under /api/<persona>/promises return null so the host
 * keeps its own router.
 *
 * There is no task-board page and no change to garden or session start.
 */

import { AppError } from "../errors";
import type { MemoryDb } from "../types";
import { assertChuChannel, assertPromiseAccess, PROMISE_ADMIT_ADMIN_DEFAULT, type ResolvePromiseCaller } from "./access";
import { REPLY_PREVIEW_LIMIT, type PromiseAuthor } from "./rules";
import { ensurePromiseSchema, PromiseStore, type PromiseRecord } from "./store";
import { civilDate, formatOffsetIso, parseInstant, parseSurface, resolvePromiseTimezone } from "./zone";

export interface PromiseModuleEnv {
  PROMISE_TIMEZONE?: string;
  PROMISE_ADMIT_ADMIN?: string;
}

export interface PromiseRouteDeps {
  db: MemoryDb;
  env: unknown;
  resolveCaller: ResolvePromiseCaller;
  /** Canonical IANA zone. Falls back to env.PROMISE_TIMEZONE, then America/New_York. */
  timeZone?: string;
  /** Default false. Does not change resolveCaller; it only gates this table. */
  admitAdmin?: boolean;
  now?: () => Date;
}

const PROMISE_PATH = /^\/api\/([^/]+)\/promises(?:\/(.*))?$/;

export function matchPromisePath(pathname: string): { personaId: string; rest: string } | null {
  const match = PROMISE_PATH.exec(pathname);
  if (!match?.[1]) return null;
  let personaId: string;
  try {
    personaId = decodeURIComponent(match[1]);
  } catch {
    return { personaId: match[1], rest: "\u0000" };
  }
  const rest = (match[2] ?? "").replace(/\/+$/, "");
  return { personaId, rest };
}

export async function handlePromiseRequest(request: Request, deps: PromiseRouteDeps): Promise<Response | null> {
  const url = new URL(request.url);
  const match = matchPromisePath(url.pathname);
  if (!match) return null;
  if (match.rest === "\u0000") {
    return json({ error: "invalid", message: "路径里的人格 id 无法解码。" }, 400);
  }
  try {
    const caller = await deps.resolveCaller(deps.db, deps.env, request, match.personaId);
    const admitAdmin = deps.admitAdmin ?? readAdmitAdmin(deps.env);
    assertPromiseAccess(caller, match.personaId, admitAdmin);
    const zone = resolvePromiseTimezone(deps.timeZone ?? readTimezone(deps.env));
    if (!zone.ok) throw new AppError(500, "promise_timezone", zone.message);
    const now = (deps.now ?? (() => new Date()))();
    if (Number.isNaN(now.getTime())) throw new AppError(500, "clock", "约定的时钟无效。");
    await ensurePromiseSchema(deps.db);
    const store = new PromiseStore(deps.db, zone.value);
    return await dispatch(request, store, caller.actor, match.personaId, match.rest, zone.value, now.getTime());
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.code, message: error.message }, error.status);
    throw error;
  }
}

async function dispatch(
  request: Request,
  store: PromiseStore,
  actor: PromiseAuthor,
  personaId: string,
  rest: string,
  timeZone: string,
  now: number,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (rest === "") {
    if (method !== "GET") return methodNotAllowed();
    const items = await store.page(personaId, now);
    return json({ timezone: timeZone, items: items.map((item) => toJson(item, timeZone)) });
  }
  if (rest === "wake") {
    if (method !== "GET") return methodNotAllowed();
    assertChuChannel(actor);
    const wake = await store.wake(personaId, now);
    return json({
      timezone: timeZone,
      limit: 10,
      remaining: wake.remaining,
      items: wake.items.map((item) => toJson(item, timeZone)),
    });
  }
  if (rest === "page") {
    if (method !== "POST") return methodNotAllowed();
    const body = await readBody(request);
    const text = pickText(body);
    if (!text) throw new AppError(400, "invalid", "约定是空的。");
    const due = pickOptional(body, "due_at", "dueAt");
    let dueAt: number | null = null;
    if (due != null) {
      const parsed = parseInstant(due);
      if (!parsed.ok) throw new AppError(400, "invalid", parsed.message);
      dueAt = parsed.value;
    }
    const item = await store.addPage({ personaId, author: actor, text, dueAt, now });
    if (!item) throw new AppError(400, "invalid", "约定是空的。");
    return json({ timezone: timeZone, item: toJson(item, timeZone) }, 201);
  }
  if (rest === "content") {
    if (method !== "POST") return methodNotAllowed();
    assertChuChannel(actor);
    const body = await readBody(request);
    const text = pickText(body);
    if (!text) throw new AppError(400, "invalid", "约定是空的。");
    const surface = pickOptional(body, "surface_at", "surfaceAt");
    let surfaceAt: number | null = null;
    if (surface != null) {
      const parsed = parseSurface(surface, timeZone);
      if (!parsed.ok) throw new AppError(400, "invalid", parsed.message);
      surfaceAt = parsed.value;
    }
    const item = await store.addContent({ personaId, text, surfaceAt, now });
    if (!item) throw new AppError(400, "invalid", "约定是空的。");
    return json({ timezone: timeZone, item: toJson(item, timeZone) }, 201);
  }

  const action = /^([^/]+)\/(check|close|defer|replies)$/.exec(rest);
  if (!action?.[1] || !action[2]) {
    return json({ error: "not_found", message: "没有这个约定接口。" }, 404);
  }
  if (method !== "POST") return methodNotAllowed();
  const id = decodeURIComponent(action[1]);
  const verb = action[2];
  if (verb === "check") {
    const result = await store.toggleCheck(personaId, id, actor, now);
    return mutation(result, timeZone);
  }
  if (verb === "close") {
    assertChuChannel(actor);
    const body = await readBody(request);
    const resolution = pickOptional(body, "resolution");
    const result = await store.close(personaId, id, blankToNull(resolution), now);
    return mutation(result, timeZone);
  }
  if (verb === "defer") {
    assertChuChannel(actor);
    const body = await readBody(request);
    const surface = pickOptional(body, "surface_at", "surfaceAt");
    if (surface == null) throw new AppError(400, "invalid", "推迟需要 surface_at。");
    const parsed = parseSurface(surface, timeZone);
    if (!parsed.ok) throw new AppError(400, "invalid", parsed.message);
    const result = await store.defer(personaId, id, parsed.value, now);
    return mutation(result, timeZone);
  }
  const body = await readBody(request);
  const text = pickText(body);
  if (!text) throw new AppError(400, "invalid", "回话是空的。");
  const result = await store.reply(personaId, id, actor, text, now);
  return mutation(result, timeZone);
}

function mutation(result: Awaited<ReturnType<PromiseStore["toggleCheck"]>>, timeZone: string): Response {
  if (!result.ok) return json({ error: "not_found", message: "没有这条约定。" }, 404);
  return json({
    timezone: timeZone,
    applied: result.applied,
    ...(result.applied ? { action: result.action } : { reason: result.reason }),
    item: toJson(result.item, timeZone),
  });
}

export interface PromiseJson {
  id: string;
  persona_id: string;
  author: PromiseAuthor;
  text: string;
  due_at: string | null;
  surface_at: string | null;
  surface_on: string | null;
  checked_by: PromiseAuthor | null;
  checked_at: string | null;
  resolution: string | null;
  status: "open" | "done";
  bloom: "bud" | "owed" | "open";
  created_at: string;
  replies: { id: string; author: PromiseAuthor; text: string; at: string }[];
  reply_count: number;
  replies_preview: { id: string; author: PromiseAuthor; text: string; at: string }[];
}

export function toJson(item: PromiseRecord, timeZone: string): PromiseJson {
  const replies = item.replies.map((reply) => ({
    id: reply.id,
    author: reply.author,
    text: reply.text,
    at: formatOffsetIso(reply.createdAt, timeZone),
  }));
  return {
    id: item.id,
    persona_id: item.personaId,
    author: item.author,
    text: item.text,
    due_at: item.dueAt == null ? null : formatOffsetIso(item.dueAt, timeZone),
    surface_at: item.surfaceAt == null ? null : formatOffsetIso(item.surfaceAt, timeZone),
    surface_on: item.surfaceAt == null ? null : civilDate(item.surfaceAt, timeZone),
    checked_by: item.checkedBy,
    checked_at: item.checkedAt == null ? null : formatOffsetIso(item.checkedAt, timeZone),
    resolution: item.resolution,
    status: item.status,
    bloom: item.bloom,
    created_at: formatOffsetIso(item.createdAt, timeZone),
    replies,
    reply_count: replies.length,
    replies_preview: replies.slice(-REPLY_PREVIEW_LIMIT),
  };
}

function readTimezone(env: unknown): string | undefined {
  const value = readEnvString(env, "PROMISE_TIMEZONE");
  return value;
}

function readAdmitAdmin(env: unknown): boolean {
  return readEnvString(env, "PROMISE_ADMIT_ADMIN") === "1" ? true : PROMISE_ADMIT_ADMIN_DEFAULT;
}

function readEnvString(env: unknown, key: string): string | undefined {
  if (!env || typeof env !== "object") return undefined;
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AppError(400, "invalid", "请求体不是对象。");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "invalid", "请求体不是 JSON。");
  }
}

/** text/content only. author, owner, persona_id, checked_by are ignored. */
function pickText(body: Record<string, unknown>): string {
  const raw = body.text ?? body.content;
  return typeof raw === "string" ? raw.trim() : "";
}

function pickOptional(body: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function methodNotAllowed(): Response {
  return json({ error: "method", message: "这个约定接口不接受这个方法。" }, 405);
}
