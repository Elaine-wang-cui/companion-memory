import { generateKey, sha256Hex } from "./auth";
import { AppError } from "./errors";
import { PERSONA_DISPLAY_ALIASES, ROSTER_SEEDS } from "./persona-roster";
import { PERSONA_ID_RE, RESERVED_IDS, type MemoryDb, type Persona } from "./types";
import { safeEnqueueNotionOutbox } from "./notion-sync";

export type CreatePersonaInput = {
  id: string;
  display_name: string;
  relationship_to_user: string;
  self_card: string;
  /** 新建时发密钥；对已存在人格则仅在尚无密钥时补发。 */
  issue_key?: boolean;
};

export function friendlyDisplayName(id: string, displayName?: string | null): string {
  const given = (displayName ?? "").trim();
  if (given) return given;
  const aliases = PERSONA_DISPLAY_ALIASES[id];
  if (aliases?.[0]) return aliases[0];
  const seed = ROSTER_SEEDS.find((s) => s.id === id);
  if (seed) return seed.display_name;
  return id;
}

async function issuePersonaKey(db: MemoryDb, personaId: string, label: string): Promise<string> {
  const key = generateKey();
  const hash = await sha256Hex(key);
  await db
    .prepare(
      `INSERT INTO api_keys (id, persona_id, key_hash, label, is_admin, created_at)
       VALUES (?, ?, ?, ?, 0, datetime('now'))`,
    )
    .bind(crypto.randomUUID(), personaId, hash, label)
    .run();
  return key;
}

async function hasPersonaKey(db: MemoryDb, personaId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM api_keys WHERE persona_id = ? AND is_admin = 0 LIMIT 1`)
    .bind(personaId)
    .first<{ id: string }>();
  return !!row;
}

export async function adminUpsertPersona(
  db: MemoryDb,
  input: CreatePersonaInput,
): Promise<{
  persona: Persona;
  created: boolean;
  key?: string;
  key_issued?: boolean;
}> {
  const id = input.id.trim().toLowerCase();
  if (!PERSONA_ID_RE.test(id) || RESERVED_IDS.has(id)) {
    throw new AppError(400, "invalid", "id 要用小写英文 slug，且不能是保留字。");
  }
  const display_name = input.display_name.trim();
  const relationship_to_user = input.relationship_to_user.trim();
  const self_card = input.self_card.trim();
  if (!display_name || !relationship_to_user || !self_card) {
    throw new AppError(400, "invalid", "需要 display_name、relationship_to_user、self_card。");
  }

  const existing = await db
    .prepare(`SELECT id, display_name, relationship_to_user, self_card, created_at, updated_at FROM personas WHERE id = ?`)
    .bind(id)
    .first<Persona>();

  if (existing) {
    let key: string | undefined;
    let key_issued = false;
    if (input.issue_key && !(await hasPersonaKey(db, id))) {
      key = await issuePersonaKey(db, id, `${id}-roster`);
      key_issued = true;
    }
    return { persona: existing, created: false, key, key_issued };
  }

  await db
    .prepare(
      `INSERT INTO personas (id, display_name, relationship_to_user, self_card, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(id, display_name, relationship_to_user, self_card)
    .run();

  let key: string | undefined;
  let key_issued = false;
  if (input.issue_key !== false) {
    // 默认新建就发密钥，方便 /mcp/<id> 写心痕
    key = await issuePersonaKey(db, id, `${id}-roster`);
    key_issued = true;
  }

  const persona = await db
    .prepare(`SELECT id, display_name, relationship_to_user, self_card, created_at, updated_at FROM personas WHERE id = ?`)
    .bind(id)
    .first<Persona>();
  if (!persona) throw new AppError(500, "internal", "写入人格后读不回来。");
  await safeEnqueueNotionOutbox(db, {
    kind: "persona",
    local_id: persona.id,
    persona_id: persona.id,
    title: persona.display_name,
    body: `花名册人格：${persona.display_name}\n关系：${persona.relationship_to_user}\n\n${persona.self_card}`,
  });
  return { persona, created: true, key, key_issued };
}

/** 写心痕等场景：人格不在就建占位，并确保有一把可用密钥。 */
export async function ensurePersonaPlaceholder(
  db: MemoryDb,
  idRaw: string,
  displayName?: string | null,
): Promise<{ persona: Persona; created: boolean; key?: string }> {
  const id = idRaw.trim().toLowerCase();
  if (!PERSONA_ID_RE.test(id) || RESERVED_IDS.has(id)) {
    throw new AppError(400, "invalid", "persona_id 不合法。");
  }
  const name = friendlyDisplayName(id, displayName);
  return adminUpsertPersona(db, {
    id,
    display_name: name,
    relationship_to_user: "Notion／心痕",
    self_card: `我是${name}。这里先放一张占位自我卡片，日后由我自己改。`,
    issue_key: true,
  });
}

/** Batch-set relationship_to_user only (never touches self_card). */
export async function updatePersonaRelationships(
  db: MemoryDb,
  updates: Array<{ id: string; relationship_to_user: string }>,
): Promise<{ updated: number; skipped: string[] }> {
  let updated = 0;
  const skipped: string[] = [];
  for (const u of updates) {
    const id = String(u.id || "").trim();
    const rel = String(u.relationship_to_user ?? "").trim();
    if (!id) continue;
    const existing = await db
      .prepare(`SELECT id FROM personas WHERE id = ?`)
      .bind(id)
      .first<{ id: string }>();
    if (!existing) {
      skipped.push(id);
      continue;
    }
    await db
      .prepare(`UPDATE personas SET relationship_to_user = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(rel, id)
      .run();
    updated += 1;
  }
  return { updated, skipped };
}
