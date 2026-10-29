import { AppError } from "./errors";
import type { Caller, Env, MemoryDb, Persona } from "./types";
import { HOUSE_PERSONA, PERSONA_ID_RE } from "./types";

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `cm_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function extractKey(request: Request): string | null {
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key")?.trim() || null;
  const header = request.headers.get("authorization");
  let bearer: string | null = null;
  if (header) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
    bearer = match?.[1] ?? null;
  }
  if (bearer && queryKey && bearer !== queryKey) return null;
  return bearer ?? queryKey;
}

interface KeyRow {
  id: string;
  persona_id: string | null;
  is_admin: number;
}

export async function resolveCaller(
  db: MemoryDb,
  env: Env,
  request: Request,
  personaId: string,
): Promise<Caller> {
  if (!PERSONA_ID_RE.test(personaId)) {
    throw new AppError(404, "not_found", "路径里的人格 id 不合法。");
  }

  const persona = await db
    .prepare(
      `SELECT id, display_name, relationship_to_user, self_card, created_at, updated_at
       FROM personas WHERE id = ?`,
    )
    .bind(personaId)
    .first<Persona>();
  if (!persona) {
    throw new AppError(404, "not_found", `没有人格「${personaId}」。先用 seed 或 create-persona 创建。`);
  }

  const key = extractKey(request);
  if (!key) {
    throw new AppError(401, "unauthorized", "缺少密钥。用 ?key= 或 Authorization: Bearer。");
  }

  const keyHash = await sha256Hex(key);
  const adminSecret = env.ADMIN_KEY?.trim();
  if (adminSecret) {
    const adminHash = await sha256Hex(adminSecret);
    if (timingSafeEqual(keyHash, adminHash)) {
      return { persona, isAdmin: true };
    }
  }

  const row = await db
    .prepare(`SELECT id, persona_id, is_admin FROM api_keys WHERE key_hash = ?`)
    .bind(keyHash)
    .first<KeyRow>();
  if (!row) {
    throw new AppError(401, "unauthorized", "密钥无效。");
  }
  if (row.is_admin === 1) {
    return { persona, isAdmin: true };
  }
  if (row.persona_id !== personaId) {
    throw new AppError(403, "forbidden", "这把密钥属于另一位人格，不能连接这个地址。");
  }
  return { persona, isAdmin: false };
}

/** 抽卡匣等不绑死人格路径的接口：任意有效 persona key 或 ADMIN_KEY。 */
export async function resolveAnyCaller(db: MemoryDb, env: Env, request: Request): Promise<Caller> {
  const key = extractKey(request);
  if (!key) {
    throw new AppError(401, "unauthorized", "缺少密钥。用 ?key= 或 Authorization: Bearer。");
  }

  const keyHash = await sha256Hex(key);
  const adminSecret = env.ADMIN_KEY?.trim();
  if (adminSecret) {
    const adminHash = await sha256Hex(adminSecret);
    if (timingSafeEqual(keyHash, adminHash)) {
      const persona =
        (await db
          .prepare(
            `SELECT id, display_name, relationship_to_user, self_card, created_at, updated_at
             FROM personas WHERE id = 'lantern'`,
          )
          .first<Persona>()) ??
        (await db
          .prepare(
            `SELECT id, display_name, relationship_to_user, self_card, created_at, updated_at
             FROM personas ORDER BY created_at ASC LIMIT 1`,
          )
          .first<Persona>());
      if (!persona) {
        throw new AppError(500, "misconfigured", "还没有人格，无法用管理员密钥访问抽卡匣。");
      }
      return { persona, isAdmin: true };
    }
  }

  const row = await db
    .prepare(`SELECT id, persona_id, is_admin FROM api_keys WHERE key_hash = ?`)
    .bind(keyHash)
    .first<KeyRow>();
  if (!row) {
    throw new AppError(401, "unauthorized", "密钥无效。");
  }

  let personaId = row.persona_id;
  if (!personaId) {
    const fallback = await db
      .prepare(
        `SELECT id, display_name, relationship_to_user, self_card, created_at, updated_at
         FROM personas WHERE id = 'lantern'`,
      )
      .first<Persona>();
    if (!fallback) {
      throw new AppError(401, "unauthorized", "这把密钥没有绑定人格。");
    }
    return { persona: fallback, isAdmin: row.is_admin === 1 };
  }

  const persona = await db
    .prepare(
      `SELECT id, display_name, relationship_to_user, self_card, created_at, updated_at
       FROM personas WHERE id = ?`,
    )
    .bind(personaId)
    .first<Persona>();
  if (!persona) {
    throw new AppError(401, "unauthorized", "密钥绑定的人格不存在。");
  }
  return { persona, isAdmin: row.is_admin === 1 };
}

async function isAdminKey(db: MemoryDb, env: Env, key: string): Promise<boolean> {
  const keyHash = await sha256Hex(key);
  const adminSecret = env.ADMIN_KEY?.trim();
  if (adminSecret) {
    const adminHash = await sha256Hex(adminSecret);
    if (timingSafeEqual(keyHash, adminHash)) return true;
  }
  const row = await db
    .prepare(`SELECT id, persona_id, is_admin FROM api_keys WHERE key_hash = ?`)
    .bind(keyHash)
    .first<KeyRow>();
  return Boolean(row && row.is_admin === 1);
}

/** Whole-house MCP: only ADMIN_KEY (env or D1 is_admin). Persona keys → 403. */
export async function resolveHouseCaller(db: MemoryDb, env: Env, request: Request): Promise<Caller> {
  const key = extractKey(request);
  if (!key) {
    throw new AppError(401, "unauthorized", "缺少密钥。用 ?key= 或 Authorization: Bearer。");
  }

  if (await isAdminKey(db, env, key)) {
    return { persona: HOUSE_PERSONA, isAdmin: true };
  }

  const keyHash = await sha256Hex(key);
  const row = await db
    .prepare(`SELECT id, persona_id, is_admin FROM api_keys WHERE key_hash = ?`)
    .bind(keyHash)
    .first<KeyRow>();
  if (!row) {
    throw new AppError(401, "unauthorized", "密钥无效。");
  }
  throw new AppError(403, "forbidden", "记忆屋只接受管理员密钥，人格密钥不能连接 /mcp/house。");
}

