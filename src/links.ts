/**
 * 关联记忆（识海 / 心流）。2026-10-28。
 * memory_links: 无向边（a_id < b_id 唯一），weight 0..1，kind = semantic|tag|time|manual|co_recall。
 * memory_embeddings: Workers AI bge-m3 向量（JSON）。不删除任何记忆。
 */
// @ts-ignore nodejs_compat 提供
import { AsyncLocalStorage } from "node:async_hooks";
import { strengthNow, isPinned, stateOf, reinforcePatch } from "./forgetting";
import type { Env, MemoryDb, MemoryRow } from "./types";

// —— 可调开关 ——
export const LINKS_ENABLED = true;            // 总开关：自动连线
export const ASSOC_RECALL_ENABLED = true;     // 浮现时带出关联记忆（心流）
export const ASSOC_MAX = 2;                   // 每次最多牵出几条
export const ASSOC_MIN_SCORE = 0.3;           // weight × 当前强度 的门槛
export const ASSOC_CLIP = 120;                // 牵出来的那条最多显示多少字
export const ASSOC_NEIGHBOR_BOOST = 0.05;     // 用到一条记忆时，邻居被轻轻强化（直接强化是 0.5）
export const ASSOC_NEIGHBOR_MAX = 3;
export const CO_RECALL_INIT = 0.15;
export const CO_RECALL_STEP = 0.05;
export const EMBED_MODEL = "@cf/baai/bge-m3";
export const SEM_TOP_K = 4;
export const SEM_MIN = 0.55;                  // 同一人格内语义连线门槛（余弦）
export const SEM_MIN_CROSS = 0.68;            // family ↔ 人格 的跨区门槛（更严）
const GENERIC_TAGS = new Set(["对话", "日志", "系统", "chat", "log", "交接", "handoff", "记忆屋"]);

// —— 请求上下文（给 remember 后台连线用 waitUntil）——
type Ctx = { waitUntil(p: Promise<unknown>): void };
export const reqStore = new AsyncLocalStorage<{ env: Env; ctx?: Ctx }>();

export function scheduleLinking(memoryId: string) {
  if (!LINKS_ENABLED) return;
  const s = reqStore.getStore();
  if (!s?.env?.AI || !s.ctx) return; // 没有上下文：交给 cron 补
  s.ctx.waitUntil(linkMemory(s.env.DB, s.env.AI, memoryId).catch((e) => console.error("[links] link err", e)));
}

let ready = false;
export async function ensureLinksSchema(db: MemoryDb): Promise<void> {
  if (ready) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS memory_links (
    a_id TEXT NOT NULL, b_id TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0, kind TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (a_id, b_id),
    CHECK (a_id < b_id), CHECK (weight >= 0 AND weight <= 1),
    CHECK (kind IN ('semantic','tag','time','manual','co_recall')))`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_memory_links_b ON memory_links(b_id)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS memory_embeddings (
    memory_id TEXT PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, vec TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
  ready = true;
}

const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

/** 写边：取更大的权重；kind 跟着权重大的那一方走。manual 不被覆盖。 */
export async function upsertLink(db: MemoryDb, x: string, y: string, weight: number, kind: string, nowIso = new Date().toISOString()) {
  if (x === y) return;
  const [a, b] = pair(x, y);
  const w = Math.max(0, Math.min(1, weight));
  await db.prepare(`INSERT INTO memory_links (a_id,b_id,weight,kind,created_at,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(a_id,b_id) DO UPDATE SET
      kind = CASE WHEN memory_links.kind = 'manual' THEN 'manual' WHEN excluded.weight > memory_links.weight THEN excluded.kind ELSE memory_links.kind END,
      weight = MAX(memory_links.weight, excluded.weight), updated_at = excluded.updated_at`)
    .bind(a, b, w, kind, nowIso, nowIso).run();
}

/** 同一次浮现里一起出现 → 边轻轻变强。 */
export async function coRecall(db: MemoryDb, ids: string[], nowIso = new Date().toISOString()) {
  const u = [...new Set(ids)].slice(0, 6);
  for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) {
    const [a, b] = pair(u[i]!, u[j]!);
    try {
      await db.prepare(`INSERT INTO memory_links (a_id,b_id,weight,kind,created_at,updated_at) VALUES (?,?,?,'co_recall',?,?)
        ON CONFLICT(a_id,b_id) DO UPDATE SET weight = MIN(1.0, memory_links.weight + ?), updated_at = excluded.updated_at`)
        .bind(a, b, CO_RECALL_INIT, nowIso, nowIso, CO_RECALL_STEP).run();
    } catch (e) { console.error("[links] co_recall", e); }
  }
}

function parseTags(t: string | null | undefined): string[] {
  try { const v = JSON.parse(t || "[]"); if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean); } catch { /* */ }
  return String(t || "").split(/[,，\s]+/).filter(Boolean);
}
function cos(a: number[], b: number[]) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! * a[i]!; y += b[i]! * b[i]!; }
  return x && y ? d / Math.sqrt(x * y) : 0;
}

async function embed(ai: NonNullable<Env["AI"]>, texts: string[]): Promise<number[][]> {
  const out = (await ai.run(EMBED_MODEL, { text: texts.map((t) => t.slice(0, 2000)) })) as { data?: number[][] };
  if (!out?.data || out.data.length !== texts.length) throw new Error("embedding failed");
  return out.data;
}

type LRow = { id: string; owner_persona: string; tags: string; content: string };

async function loadVecs(db: MemoryDb): Promise<Map<string, number[]>> {
  const r = await db.prepare(`SELECT memory_id, vec FROM memory_embeddings WHERE model = ?`).bind(EMBED_MODEL).all<{ memory_id: string; vec: string }>();
  return new Map((r.results ?? []).map((x) => [x.memory_id, JSON.parse(x.vec) as number[]]));
}

/** 补向量：没向量的记忆批量算一下。 */
export async function embedMissing(db: MemoryDb, ai: NonNullable<Env["AI"]>, max = 64): Promise<string[]> {
  const rows = ((await db.prepare(`SELECT m.id, m.content FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ? WHERE e.memory_id IS NULL LIMIT ?`).bind(EMBED_MODEL, max).all<{ id: string; content: string }>()).results ?? []);
  const done: string[] = [];
  for (let i = 0; i < rows.length; i += 16) {
    const batch = rows.slice(i, i + 16);
    const vecs = await embed(ai, batch.map((r) => r.content));
    const now = new Date().toISOString();
    for (let j = 0; j < batch.length; j++) {
      await db.prepare(`INSERT OR REPLACE INTO memory_embeddings (memory_id, model, dim, vec, updated_at) VALUES (?,?,?,?,?)`)
        .bind(batch[j]!.id, EMBED_MODEL, vecs[j]!.length, JSON.stringify(vecs[j]!.map((v) => Math.round(v * 1e5) / 1e5)), now).run();
      done.push(batch[j]!.id);
    }
  }
  return done;
}

function allowed(a: LRow, b: LRow, sim: number): boolean {
  if (a.owner_persona === b.owner_persona) return sim >= SEM_MIN;
  if (a.owner_persona === "family" || b.owner_persona === "family") return sim >= SEM_MIN_CROSS;
  return false; // 不同人格之间不连
}

/** 给一条记忆连线（语义 top-k + 共享标签）。 */
export async function linkOne(db: MemoryDb, me: LRow, all: LRow[], vecs: Map<string, number[]>, nowIso: string) {
  let n = 0;
  const v = vecs.get(me.id);
  if (v) {
    const sims = all.filter((o) => o.id !== me.id && vecs.has(o.id)).map((o) => ({ o, s: cos(v, vecs.get(o.id)!) }))
      .filter(({ o, s }) => allowed(me, o, s)).sort((x, y) => y.s - x.s).slice(0, SEM_TOP_K);
    for (const { o, s } of sims) {
      const floor = o.owner_persona === me.owner_persona ? SEM_MIN : SEM_MIN_CROSS;
      await upsertLink(db, me.id, o.id, Math.min(1, 0.35 + (s - floor) / (1 - floor) * 0.65), "semantic", nowIso); n++;
    }
  }
  const mine = new Set(parseTags(me.tags).filter((t) => !GENERIC_TAGS.has(t.toLowerCase())));
  if (mine.size) {
    const cand = all.filter((o) => o.id !== me.id && (o.owner_persona === me.owner_persona || o.owner_persona === "family" || me.owner_persona === "family"))
      .map((o) => ({ o, k: parseTags(o.tags).filter((t) => mine.has(t)).length })).filter((x) => x.k > 0)
      .sort((a, b) => b.k - a.k).slice(0, 6);
    for (const { o, k } of cand) { await upsertLink(db, me.id, o.id, Math.min(0.6, 0.25 + 0.1 * k), "tag", nowIso); n++; }
  }
  return n;
}

async function allRows(db: MemoryDb): Promise<LRow[]> {
  return ((await db.prepare(`SELECT id, owner_persona, tags, content FROM memories`).all<LRow>()).results ?? []);
}

export async function linkMemory(db: MemoryDb, ai: NonNullable<Env["AI"]>, id: string) {
  await ensureLinksSchema(db);
  await embedMissing(db, ai, 16);
  const all = await allRows(db);
  const me = all.find((r) => r.id === id);
  if (!me) return 0;
  return linkOne(db, me, all, await loadVecs(db), new Date().toISOString());
}

/** 全量回填（幂等）。 */
export async function backfillLinks(db: MemoryDb, ai: NonNullable<Env["AI"]>) {
  await ensureLinksSchema(db);
  const embedded = await embedMissing(db, ai, 500);
  const all = await allRows(db);
  const vecs = await loadVecs(db);
  const now = new Date().toISOString();
  let edges = 0;
  for (const r of all) edges += await linkOne(db, r, all, vecs, now);
  return { memories: all.length, embedded_now: embedded.length, with_vectors: vecs.size, ...(await linkStats(db)) };
}

/** cron：只补没向量的新记忆（每次最多 20 条）。 */
export async function cronLinks(db: MemoryDb, ai: NonNullable<Env["AI"]> | undefined) {
  if (!LINKS_ENABLED || !ai) return { skipped: true };
  await ensureLinksSchema(db);
  const done = await embedMissing(db, ai, 20);
  if (!done.length) return { linked: 0 };
  const all = await allRows(db); const vecs = await loadVecs(db); const now = new Date().toISOString();
  for (const id of done) { const me = all.find((r) => r.id === id); if (me) await linkOne(db, me, all, vecs, now); }
  return { linked: done.length };
}

export async function linkStats(db: MemoryDb) {
  const r = await db.prepare(`SELECT kind, COUNT(*) n, ROUND(AVG(weight),3) w FROM memory_links GROUP BY kind`).all<{ kind: string; n: number; w: number }>();
  const by = Object.fromEntries((r.results ?? []).map((x) => [x.kind, { n: x.n, avg_weight: x.w }]));
  const total = (r.results ?? []).reduce((s, x) => s + x.n, 0);
  return { links_total: total, links_by_kind: by };
}

export async function allLinks(db: MemoryDb) {
  try {
    return ((await db.prepare(`SELECT a_id a, b_id b, ROUND(weight,3) w, kind k FROM memory_links`).all<{ a: string; b: string; w: number; k: string }>()).results ?? []);
  } catch { return []; }
}

export async function neighborsOf(db: MemoryDb, ids: string[], limit = 40) {
  if (!ids.length) return [] as { src: string; nb: string; w: number; k: string }[];
  const q = ids.map(() => "?").join(",");
  try {
    return ((await db.prepare(`SELECT a_id src, b_id nb, weight w, kind k FROM memory_links WHERE a_id IN (${q})
      UNION ALL SELECT b_id src, a_id nb, weight w, kind k FROM memory_links WHERE b_id IN (${q}) ORDER BY w DESC LIMIT ?`)
      .bind(...ids, ...ids, limit).all<{ src: string; nb: string; w: number; k: string }>()).results ?? []);
  } catch { return []; }
}

/** 心流：从已选记忆牵出 1–2 条邻居（weight × 当前强度）。 */
export async function associate(db: MemoryDb, picked: string[], pool: Map<string, MemoryRow>, exclude: Set<string>, nowMs = Date.now(), max = ASSOC_MAX) {
  if (!ASSOC_RECALL_ENABLED || !picked.length) return [] as { row: MemoryRow; from: string; score: number }[];
  const out: { row: MemoryRow; from: string; score: number }[] = [];
  const seen = new Set([...picked, ...exclude]);
  for (const e of await neighborsOf(db, picked)) {
    if (seen.has(e.nb)) continue;
    const r = pool.get(e.nb); if (!r) continue;
    if (stateOf(r, nowMs) === "trace") continue;
    const score = e.w * strengthNow(r, nowMs);
    if (score < ASSOC_MIN_SCORE) continue;
    seen.add(e.nb); out.push({ row: r, from: e.src, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

/** 用到一条记忆 → 邻居轻轻被强化（不加 recall_count，不改半衰期）。 */
export async function nudgeNeighbors(db: MemoryDb, id: string, nowMs = Date.now()) {
  if (!ASSOC_RECALL_ENABLED) return [] as string[];
  const nb = (await neighborsOf(db, [id], ASSOC_NEIGHBOR_MAX)).map((e) => e.nb);
  if (!nb.length) return [];
  const rows = ((await db.prepare(`SELECT id, importance, kind, tags, content, created_at, strength, emotion, half_life_days, last_recalled_at, recall_count, state FROM memories WHERE id IN (${nb.map(() => "?").join(",")})`).bind(...nb).all<MemoryRow>()).results ?? []);
  const iso = new Date(nowMs).toISOString(); const done: string[] = [];
  for (const r of rows) {
    if (isPinned(r)) continue;
    const s = strengthNow(r, nowMs);
    const ns = s + (1 - s) * ASSOC_NEIGHBOR_BOOST;
    try { await db.prepare(`UPDATE memories SET strength = ?, last_recalled_at = ? WHERE id = ?`).bind(ns, iso, r.id).run(); done.push(r.id); } catch { /* */ }
  }
  void reinforcePatch;
  return done;
}
