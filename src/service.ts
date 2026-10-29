import { scheduleLinking, nudgeNeighbors } from "./links";
import { AppError } from "./errors";
import { safeEnqueueNotionOutbox } from "./notion-sync";
import {
  bucketOf,
  codePointLength,
  defaultVisibility,
  formatMemoryCard,
  formatMemoryLine,
  formatRecall,
  formatWhoami,
  isFamilyFact,
  isOthersExperience,
  labelMemory,
  likePattern,
  toFtsQuery,
} from "./format";
import type { Caller, LabeledMemory, MemoryDb, MemoryKind, MemoryRow, Persona, Visibility } from "./types";
import { FAMILY_OWNER, PERSONA_ID_RE, RESERVED_IDS } from "./types";
import {
  DECAY_COLUMNS,
  displayContent,
  initialFields,
  nearExactMatch,
  pinnedByRule,
  reinforceMemory,
  stateOf,
  strengthNow,
  type MemoryState,
} from "./forgetting";

const MEMORY_COLUMNS = `id, owner_persona, created_by, kind, visibility, content, importance, tags, event_date, created_at, updated_at, source_platform, ${DECAY_COLUMNS}`;

const VISIBLE_SQL_PERSONA = `(visibility = 'family' OR owner_persona = ?)`;

/** Admin (incl. house) sees every memory; personas keep the usual filter. */
function visibilityClause(caller: Caller): { sql: string; params: unknown[] } {
  if (caller.isAdmin) return { sql: "1 = 1", params: [] };
  return { sql: VISIBLE_SQL_PERSONA, params: [caller.persona.id] };
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

async function personas(db: MemoryDb): Promise<Persona[]> {
  const result = await db
    .prepare(
      `SELECT id, display_name, relationship_to_user, self_card, created_at, updated_at
       FROM personas ORDER BY created_at ASC, id ASC`,
    )
    .all<Persona>();
  return result.results ?? [];
}

async function nameMap(db: MemoryDb): Promise<Map<string, string>> {
  const rows = await personas(db);
  return new Map(rows.map((persona) => [persona.id, persona.display_name]));
}

async function getPersona(db: MemoryDb, id: string): Promise<Persona | null> {
  return db
    .prepare(
      `SELECT id, display_name, relationship_to_user, self_card, created_at, updated_at
       FROM personas WHERE id = ?`,
    )
    .bind(id)
    .first<Persona>();
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

function normalizePlatform(value: string | null | undefined): string | null {
  if (value == null) return null;
  const cleaned = value.normalize("NFKC").trim().toLowerCase();
  if (!cleaned) return null;
  if (cleaned.length > 32) throw new AppError(400, "invalid", "source_platform 太长。");
  return cleaned;
}

function normalizeEventDate(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const cleaned = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    throw new AppError(400, "invalid", "event_date 要用 YYYY-MM-DD。");
  }
  return cleaned;
}

async function assertOwner(db: MemoryDb, caller: Caller, owner: string | undefined): Promise<string> {
  if (caller.persona.id === "house" && (owner == null || !String(owner).trim())) {
    throw new AppError(
      400,
      "invalid",
      "记忆屋写记忆必须显式传入 owner（某个人格 id，或 family）。",
    );
  }
  const resolved = (owner ?? caller.persona.id).trim();
  if (resolved === FAMILY_OWNER) return FAMILY_OWNER;
  if (!PERSONA_ID_RE.test(resolved) || RESERVED_IDS.has(resolved)) {
    throw new AppError(400, "invalid", "owner 只能是当前人格、family，或管理员指定的另一位人格。");
  }
  if (resolved !== caller.persona.id && !caller.isAdmin) {
    throw new AppError(403, "forbidden", "只有管理员可以把记忆写成另一位人格。全家共享的事实请把 owner 设为 family。");
  }
  const persona = await getPersona(db, resolved);
  if (!persona) throw new AppError(404, "not_found", `没有人格「${resolved}」。`);
  return resolved;
}

function canModify(caller: Caller, memory: MemoryRow): boolean {
  if (caller.isAdmin) return true;
  if (memory.owner_persona === caller.persona.id) return true;
  if (memory.owner_persona === FAMILY_OWNER) return true;
  return false;
}

export interface RememberInput {
  content: string;
  kind: MemoryKind;
  visibility?: Visibility;
  importance?: number;
  tags?: string[];
  event_date?: string;
  source_platform?: string;
  owner?: string;
  emotion?: number;
  pin?: boolean;
}

export async function remember(db: MemoryDb, caller: Caller, input: RememberInput) {
  const owner = await assertOwner(db, caller, input.owner);
  let visibility = input.visibility ?? defaultVisibility(input.kind);
  if (owner === FAMILY_OWNER) visibility = "family";
  const tags = normalizeTags(input.tags);
  const timestamp = nowIso();
  let createdBy = caller.persona.id;
  if (caller.persona.id === "house") {
    if (owner !== "family") {
      createdBy = owner;
    } else {
      const any = await db
        .prepare(`SELECT id FROM personas ORDER BY created_at ASC, id ASC LIMIT 1`)
        .first<{ id: string }>();
      if (!any) throw new AppError(500, "misconfigured", "还没有人格，记忆屋无法写入。");
      createdBy = any.id;
    }
  }
  const importance = input.importance ?? 3;
  const decay = initialFields(
    { importance, kind: input.kind, tags: JSON.stringify(tags), content: input.content, emotion: input.emotion, pin: input.pin },
    timestamp,
  );
  const memory: MemoryRow = {
    ...decay,
    id: newId(),
    owner_persona: owner,
    created_by: createdBy,
    kind: input.kind,
    visibility,
    content: input.content.trim(),
    importance,
    tags: JSON.stringify(tags),
    event_date: normalizeEventDate(input.event_date),
    created_at: timestamp,
    updated_at: timestamp,
    source_platform: normalizePlatform(input.source_platform),
  };
  await db
    .prepare(
      `INSERT INTO memories
        (id, owner_persona, created_by, kind, visibility, content, importance, tags, event_date, created_at, updated_at, source_platform,
         strength, emotion, half_life_days, last_recalled_at, recall_count, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      memory.id,
      memory.owner_persona,
      memory.created_by,
      memory.kind,
      memory.visibility,
      memory.content,
      memory.importance,
      memory.tags,
      memory.event_date,
      memory.created_at,
      memory.updated_at,
      memory.source_platform,
      decay.strength,
      decay.emotion,
      decay.half_life_days,
      decay.last_recalled_at,
      decay.recall_count,
      decay.state,
    )
    .run();
  try { scheduleLinking(memory.id); } catch (e) { console.error("[links] schedule", e); }
  const names = await nameMap(db);
  const labeled = labelMemory(memory, caller.persona.id, names);
  const scope = labeled.owner_label === "我的" ? "你自己的" : labeled.owner_label;
  const syncPersona = memory.owner_persona === "family" ? memory.created_by : memory.owner_persona;
  await safeEnqueueNotionOutbox(db, {
    kind: "memory",
    local_id: memory.id,
    persona_id: syncPersona,
    title: `${memory.kind} · ${memory.content.slice(0, 40)}`,
    body: memory.content,
  });
  return {
    memory: labeled,
    text: `已记下，归${scope}（${labeled.visibility === "private" ? "私有" : "全家可见"}，${labeled.kind}，重要${labeled.importance}${decay.state === "pinned" ? "，已钉住" : ""}）。\nid: ${labeled.id}\n${labeled.content}`,
  };
}

export interface RecallInput {
  query?: string;
  kind?: MemoryKind;
  owner?: string;
  limit?: number;
  include_faded?: boolean;
  include_trace?: boolean;
  now_ms?: number;
}

function ownerFilter(owner: string | undefined, callerId: string): { sql: string; params: unknown[] } {
  if (!owner || owner === "all") return { sql: "1 = 1", params: [] };
  if (owner === "me") return { sql: "owner_persona = ?", params: [callerId] };
  if (owner === "family") return { sql: "owner_persona = 'family'", params: [] };
  if (owner === "others") return { sql: "owner_persona != ? AND owner_persona != 'family'", params: [callerId] };
  if (!PERSONA_ID_RE.test(owner)) throw new AppError(400, "invalid", "owner 筛选不合法。");
  return { sql: "owner_persona = ?", params: [owner] };
}

export async function recall(db: MemoryDb, caller: Caller, input: RecallInput) {
  const finalLimit = input.limit ?? 20;
  const limit = Math.min(Math.max(finalLimit * 3, 30), 150); // 先多取，再按 相关度×强度 重排
  const callerId = caller.persona.id;
  const owner = ownerFilter(input.owner, callerId);
  const kindSql = input.kind ? "kind = ?" : "1 = 1";
  const kindParams = input.kind ? [input.kind] : [];
  const query = input.query?.normalize("NFKC").trim() ?? "";
  const vis = visibilityClause(caller);
  const baseParams = [...vis.params, ...owner.params, ...kindParams];
  let rows: MemoryRow[] = [];
  let mode: "recent" | "like" | "fts" = "recent";

  if (!query) {
    const result = await db
      .prepare(
        `SELECT ${MEMORY_COLUMNS} FROM memories
         WHERE ${vis.sql} AND ${owner.sql} AND ${kindSql}
         ORDER BY importance DESC, updated_at DESC
         LIMIT ?`,
      )
      .bind(...baseParams, limit)
      .all<MemoryRow>();
    rows = result.results ?? [];
  } else if (codePointLength(query) < 3) {
    mode = "like";
    rows = await likeSearch(db, query, baseParams, vis.sql, owner.sql, kindSql, limit);
  } else {
    try {
      mode = "fts";
      const ftsVis = caller.isAdmin
        ? "1 = 1"
        : "(m.visibility = 'family' OR m.owner_persona = ?)";
      const result = await db
        .prepare(
          `SELECT ${MEMORY_COLUMNS.split(", ").map((column) => `m.${column}`).join(", ")}
           FROM memories m
           JOIN memories_fts ON m.rowid = memories_fts.rowid
           WHERE memories_fts MATCH ?
             AND ${ftsVis}
             AND ${owner.sql.replaceAll("owner_persona", "m.owner_persona")}
             AND ${kindSql.replaceAll("kind", "m.kind")}
           ORDER BY memories_fts.rank, m.importance DESC, m.updated_at DESC
           LIMIT ?`,
        )
        .bind(toFtsQuery(query), ...baseParams, limit)
        .all<MemoryRow>();
      rows = result.results ?? [];
      // FTS 索引可能不全（中文/旧行）：没命中时退回 LIKE
      if (!rows.length) {
        mode = "like";
        rows = await likeSearch(db, query, baseParams, vis.sql, owner.sql, kindSql, limit);
      }
    } catch (error) {
      console.error("fts fallback", error);
      mode = "like";
      rows = await likeSearch(db, query, baseParams, vis.sql, owner.sql, kindSql, limit);
    }
  }

  const names = await nameMap(db);
  const memories = rankByStrength(rows, query, {
    nowMs: input.now_ms,
    includeFaded: input.include_faded ?? true,
    includeTrace: input.include_trace ?? false,
  })
    .slice(0, finalLimit)
    .map(({ row, state, s }) => decorate(labelMemory(row, callerId, names), row, state, s));
  return { memories, mode, text: formatRecall(memories, query, mode) };
}

function decorate(m: LabeledMemory, row: MemoryRow, state: MemoryState, s: number): LabeledMemory {
  return { ...m, content: displayContent(row, state), state, strength_now: Math.round(s * 1000) / 1000 };
}

/** recall 重排：SQL 给出的顺序当相关度（第 i 名 → 1/√(i+1)），乘以当前强度（钉住=1）。trace 默认排除，原句几乎命中除外。 */
export function rankByStrength(
  rows: MemoryRow[],
  query: string,
  opts: { nowMs?: number; includeFaded?: boolean; includeTrace?: boolean } = {},
) {
  const now = opts.nowMs ?? Date.now();
  const out: { row: MemoryRow; state: MemoryState; s: number; score: number }[] = [];
  rows.forEach((row, i) => {
    const state = stateOf(row, now);
    const s = strengthNow(row, now);
    if (state === "faded" && opts.includeFaded === false) return;
    if (state === "trace" && !opts.includeTrace && !(query && nearExactMatch(row.content, query))) return;
    const relevance = 1 / Math.sqrt(i + 1);
    out.push({ row, state, s, score: relevance * Math.max(s, 0.05) });
  });
  return out.sort((a, b) => b.score - a.score);
}

/** 只要 clear + 钉住（memory_card / session_start 用）。 */
export function onlyClearOrPinned<T extends MemoryRow | LabeledMemory>(rows: T[], nowMs = Date.now()): T[] {
  return rows.filter((r) => {
    const st = "strength_now" in r && r.strength_now !== undefined ? (r as LabeledMemory).state : stateOf(r as MemoryRow, nowMs);
    return st === "clear" || st === "pinned";
  });
}

/** 打开一条记忆（真正读它）→ 强化。 */
export async function openMemory(db: MemoryDb, caller: Caller, id: string, nowMs = Date.now()) {
  const row = await getMemory(db, id);
  if (!row) throw new AppError(404, "not_found", "没有这条记忆。");
  if (!caller.isAdmin && row.visibility !== "family" && row.owner_persona !== caller.persona.id) {
    throw new AppError(404, "not_found", "没有这条记忆。");
  }
  const before = stateOf(row, nowMs);
  const patch = await reinforceMemory(db, row, nowMs);
  try { await nudgeNeighbors(db, row.id, nowMs); } catch { /* 无表 / 测试桩 */ }
  const next = { ...row, ...patch } as MemoryRow;
  const names = await nameMap(db);
  const labeled = decorate(labelMemory(next, caller.persona.id, names), next, patch.state, patch.strength);
  const hint = before === "faded" || before === "trace" ? `（本来${before === "faded" ? "记得不太清了" : "是很久以前的事"}，现在又想起来了。）\n` : "";
  return { memory: labeled, before, after: patch.state, text: `${hint}${formatMemoryLine(labeled, 1)}` };
}

/** 钉住 / 取消钉住。取消后从现在开始按重要度重新计时。 */
export async function pinMemory(db: MemoryDb, caller: Caller, id: string, pin: boolean, nowMs = Date.now()) {
  const row = await getMemory(db, id);
  if (!row) throw new AppError(404, "not_found", "没有这条记忆。");
  if (!canModify(caller, row)) throw new AppError(403, "forbidden", "只有这条记忆的所有者或管理员能钉住/取消。");
  const t = new Date(nowMs).toISOString();
  if (pin) {
    await db.prepare(`UPDATE memories SET state = 'pinned', strength = 1 WHERE id = ?`).bind(id).run();
  } else {
    await db
      .prepare(`UPDATE memories SET state = 'clear', strength = MAX(COALESCE(strength, 0), 0.6), last_recalled_at = ?, half_life_days = COALESCE(half_life_days, 45) WHERE id = ?`)
      .bind(t, id)
      .run();
  }
  return { id, state: pin ? "pinned" : "clear", text: pin ? `已钉住 ${id}，不会淡忘。` : `已取消钉住 ${id}，从现在起会按重要度慢慢淡。` };
}

async function likeSearch(
  db: MemoryDb,
  query: string,
  baseParams: unknown[],
  visSql: string,
  ownerSql: string,
  kindSql: string,
  limit: number,
): Promise<MemoryRow[]> {
  const pattern = likePattern(query);
  const result = await db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE ${visSql} AND ${ownerSql} AND ${kindSql}
         AND (content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
       ORDER BY importance DESC, updated_at DESC
       LIMIT ?`,
    )
    .bind(...baseParams, pattern, pattern, limit)
    .all<MemoryRow>();
  return result.results ?? [];
}

async function visibleMemories(
  db: MemoryDb,
  caller: Caller | string,
  limit: number,
): Promise<LabeledMemory[]> {
  const asCaller: Caller =
    typeof caller === "string"
      ? { persona: { id: caller, display_name: caller, relationship_to_user: "", self_card: "", created_at: "", updated_at: "" }, isAdmin: false }
      : caller;
  const vis = visibilityClause(asCaller);
  const callerId = asCaller.persona.id;
  const result = await db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE ${vis.sql}
       ORDER BY importance DESC, updated_at DESC
       LIMIT ?`,
    )
    .bind(...vis.params, limit)
    .all<MemoryRow>();
  const names = await nameMap(db);
  const now = Date.now();
  return (result.results ?? []).map((row) => ({
    ...labelMemory(row, callerId, names),
    state: stateOf(row, now),
    strength_now: Math.round(strengthNow(row, now) * 1000) / 1000,
  }));
}

export async function whoami(db: MemoryDb, caller: Caller) {
  if (caller.persona.id === "house") {
    return whoamiHouse(db, caller);
  }
  const names = await nameMap(db);
  const visible = await visibleMemories(db, caller, 80);
  const own = visible.filter((memory) => memory.bucket === "mine").slice(0, 8);
  const family = visible.filter((memory) => isFamilyFact(memory, caller.persona.id)).slice(0, 8);
  const others = visible.filter((memory) => isOthersExperience(memory, caller.persona.id)).slice(0, 8);
  const text = formatWhoami({ persona: caller.persona, names, own, family, others });
  return {
    text,
    persona: publicPersona(caller.persona),
    self_card: caller.persona.self_card,
    own_memories: own,
    family_memories: family,
    others_memories: others,
  };
}

async function whoamiHouse(db: MemoryDb, caller: Caller) {
  const allPersonas = await personas(db);
  const countRows = await db
    .prepare(
      `SELECT owner_persona AS owner, COUNT(*) AS n FROM memories GROUP BY owner_persona ORDER BY n DESC`,
    )
    .all<{ owner: string; n: number }>();
  const counts = new Map((countRows.results ?? []).map((r) => [r.owner, Number(r.n)]));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const recent = await visibleMemories(db, caller, 24);

  const rosterLines = allPersonas.map((p) => {
    const n = counts.get(p.id) ?? 0;
    return `- ${p.display_name}（${p.id}）：${p.relationship_to_user} · 记忆 ${n} 条`;
  });
  const familyN = counts.get("family") ?? 0;
  rosterLines.push(`- 全家共享（family）· 记忆 ${familyN} 条`);

  const sample = recent.slice(0, 12).map((m, i) => formatMemoryLine(m, i + 1)).join("\n\n");

  const text = [
    "你是记忆屋（house）。你是整库记忆系统，不是任何一位伙伴。",
    "你可以看见全部记忆（含各人格的 private）。写记忆时必须显式指定 owner。",
    caller.persona.self_card.trim(),
    "",
    `【库内概览】共 ${total} 条记忆。`,
    "【人格名册】",
    rosterLines.join("\n") || "（还没有人格）",
    "",
    "【各所有者近期样本】（已标明归属，不要说成「我」的经历）",
    sample || "（还没有记忆）",
  ].join("\n");

  return {
    text,
    persona: publicPersona(caller.persona),
    self_card: caller.persona.self_card,
    own_memories: [] as LabeledMemory[],
    family_memories: recent.filter((m) => m.owner_persona === "family").slice(0, 8),
    others_memories: recent.filter((m) => m.owner_persona !== "family").slice(0, 16),
    personas: allPersonas.map(publicPersona),
    counts: Object.fromEntries(counts),
  };
}


function publicPersona(persona: Persona) {
  return {
    id: persona.id,
    display_name: persona.display_name,
    relationship_to_user: persona.relationship_to_user,
  };
}

export async function listPersonas(db: MemoryDb) {
  const rows = await personas(db);
  const items = rows.map(publicPersona);
  const text = items.map((persona) => `${persona.display_name}（${persona.id}）— ${persona.relationship_to_user}`).join("\n");
  return { personas: items, text: text || "还没有人格。" };
}

async function getMemory(db: MemoryDb, id: string): Promise<MemoryRow | null> {
  return db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`).bind(id).first<MemoryRow>();
}

export interface UpdateMemoryInput {
  id: string;
  content?: string;
  kind?: MemoryKind;
  visibility?: Visibility;
  importance?: number;
  tags?: string[];
  event_date?: string | null;
  source_platform?: string | null;
}

export async function updateMemory(db: MemoryDb, caller: Caller, input: UpdateMemoryInput) {
  const existing = await getMemory(db, input.id);
  if (!existing) throw new AppError(404, "not_found", "没有这条记忆。");
  if (!canModify(caller, existing)) {
    throw new AppError(403, "forbidden", "只有这条记忆的所有者或管理员能改。");
  }
  const next: MemoryRow = {
    ...existing,
    content: input.content?.trim() ?? existing.content,
    kind: input.kind ?? existing.kind,
    visibility: input.visibility ?? existing.visibility,
    importance: input.importance ?? existing.importance,
    tags: input.tags ? JSON.stringify(normalizeTags(input.tags)) : existing.tags,
    event_date: input.event_date !== undefined ? normalizeEventDate(input.event_date) : existing.event_date,
    source_platform:
      input.source_platform !== undefined ? normalizePlatform(input.source_platform) : existing.source_platform,
    updated_at: nowIso(),
  };
  if (next.owner_persona === FAMILY_OWNER) next.visibility = "family";
  if (!next.content) throw new AppError(400, "invalid", "content 不能为空。");
  if (existing.state !== "pinned" && (input.importance === 5 || input.kind === "preference") && pinnedByRule(next)) {
    try { await db.prepare(`UPDATE memories SET state = 'pinned' WHERE id = ?`).bind(next.id).run(); } catch { /* 旧库 */ }
  }
  await db
    .prepare(
      `UPDATE memories
       SET content = ?, kind = ?, visibility = ?, importance = ?, tags = ?, event_date = ?, source_platform = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      next.content,
      next.kind,
      next.visibility,
      next.importance,
      next.tags,
      next.event_date,
      next.source_platform,
      next.updated_at,
      next.id,
    )
    .run();
  const names = await nameMap(db);
  const labeled = labelMemory(next, caller.persona.id, names);
  return { memory: labeled, text: `已更新 ${labeled.id}（${labeled.owner_label}）。\n${labeled.content}` };
}

export async function forget(db: MemoryDb, caller: Caller, id: string) {
  const existing = await getMemory(db, id);
  if (!existing) throw new AppError(404, "not_found", "没有这条记忆。");
  if (!canModify(caller, existing)) {
    throw new AppError(403, "forbidden", "只有这条记忆的所有者或管理员能删除。");
  }
  await db.prepare(`DELETE FROM memories WHERE id = ?`).bind(id).run();
  const names = await nameMap(db);
  const label = labelMemory(existing, caller.persona.id, names).owner_label;
  return { id, text: `已忘记 ${id}（${label}）。` };
}

export async function updateSelfCard(db: MemoryDb, caller: Caller, selfCard: string) {
  if (caller.persona.id === "house") {
    throw new AppError(400, "invalid", "记忆屋没有自我卡片可更新；请连到具体人格的 MCP。");
  }
  const timestamp = nowIso();
  await db
    .prepare(`UPDATE personas SET self_card = ?, updated_at = ? WHERE id = ?`)
    .bind(selfCard.trim(), timestamp, caller.persona.id)
    .run();
  caller.persona.self_card = selfCard.trim();
  caller.persona.updated_at = timestamp;
  return {
    persona: publicPersona(caller.persona),
    self_card: caller.persona.self_card,
    text: `已更新${caller.persona.display_name}的自我卡片。\n${caller.persona.self_card}`,
  };
}

export async function memoryCard(db: MemoryDb, caller: Caller, personaId?: string) {
  const targetId = personaId?.trim() || caller.persona.id;
  if (!PERSONA_ID_RE.test(targetId)) throw new AppError(400, "invalid", "persona_id 不合法。");
  const persona = targetId === caller.persona.id ? caller.persona : await getPersona(db, targetId);
  if (!persona) throw new AppError(404, "not_found", `没有人格「${targetId}」。`);
  const viewerIsOwner = caller.isAdmin || caller.persona.id === persona.id;
  const names = await nameMap(db);
  const visible = await visibleMemories(
    db,
    viewerIsOwner ? (caller.isAdmin ? caller : { ...caller, persona }) : caller,
    80,
  );
  const perspective = persona.id;
  visible.splice(0, visible.length, ...onlyClearOrPinned(visible));
  const own = visible.filter((memory) => memory.owner_persona === perspective && (viewerIsOwner || memory.visibility === "family")).slice(0, 5);
  const family = visible.filter((memory) => isFamilyFact({ ...memory, bucket: bucketOf(memory.owner_persona, perspective) }, perspective)).slice(0, 4);
  const others = visible.filter((memory) => isOthersExperience(memory, perspective)).slice(0, 4);
  const relabeledOwn = own.map((memory) => ({
    ...memory,
    owner_label: "我的",
    bucket: "mine" as const,
  }));
  const text = formatMemoryCard({
    persona,
    viewerIsOwner,
    own: relabeledOwn,
    family: family.map((memory) => ({
      ...memory,
      owner_label: memory.owner_persona === perspective ? "我的" : memory.owner_persona === FAMILY_OWNER ? "全家" : `${names.get(memory.owner_persona) ?? memory.owner_persona}的`,
    })),
    others,
  });
  return { text, persona: publicPersona(persona), includes_private: viewerIsOwner };
}


/** 关联记忆：顺着连线看邻居（只读，不强化）。 */
export async function relatedMemories(db: MemoryDb, caller: Caller, id: string, limit = 6, nowMs = Date.now()) {
  const row = await getMemory(db, id);
  if (!row || (!caller.isAdmin && row.visibility !== "family" && row.owner_persona !== caller.persona.id)) {
    throw new AppError(404, "not_found", "没有这条记忆。");
  }
  const { neighborsOf } = await import("./links");
  const edges = await neighborsOf(db, [id], 30);
  const names = await nameMap(db);
  const out: string[] = [];
  for (const e of edges) {
    if (out.length >= Math.min(Math.max(limit, 1), 12)) break;
    const r = await getMemory(db, e.nb);
    if (!r) continue;
    if (!caller.isAdmin && r.visibility !== "family" && r.owner_persona !== caller.persona.id) continue;
    const st = stateOf(r, nowMs);
    const kindZh: Record<string, string> = { semantic: "意思相近", tag: "同一标签", time: "同一时期", manual: "手动", co_recall: "常一起想起" };
    const lab = labelMemory(r, caller.persona.id, names);
    out.push(`- [#${r.id} · ${lab.owner_label} · ${kindZh[e.k] ?? e.k} ${Math.round(e.w * 100)}% · ${st}] ${displayContent(r, st).slice(0, 160)}`);
  }
  let items: string[] = [];
  try {
    const { relatedItemsForMemory } = await import("./garden-links");
    items = await relatedItemsForMemory(db, id, caller.isAdmin ? null : new Set([caller.persona.id, "family"]));
  } catch { /* 花园连线可选 */ }
  if (items.length) out.push(`\n连着的花园内容（日记/小说/便签等，只读）：\n${items.join("\n")}`);
  return out.length ? `从 #${id} 牵出来的记忆（连线越强越靠前；只是看看，不算想起）：\n${out.join("\n")}` : `#${id} 还没有连着别的记忆。`;
}
