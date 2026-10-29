import { CFG } from "./config";
/**
 * 认知星（2026-10-28 v1）。纯数学，不调用任何生成模型。
 * 1) 聚类：只用已有向量（memory_embeddings + garden_embeddings），贪心 + 余弦门槛，3–8 条一组 → cognition_candidates(pending)。
 * 2) 浮现钩子：伙伴的 auto-recall 文本末尾偶尔（限频）附一句邀请；写不写由他自己决定。
 * 3) write_cognition：伙伴自己写一句理解 → 存成记忆（tag「认知」）+ cognitions 行 + 连线；源记忆强度轻轻 ×0.85（原值留档，可撤销）。
 * 4) 浮现：相关的认知排在最前；源记忆仍按原来的「牵出来的」机制带出。
 * 回滚：把下面开关改 false 即可；/api/admin/cognition/undo 可逐条撤销。
 */
import type { Caller, MemoryDb } from "./types";
import { EMBED_MODEL } from "./links";
import { dec, norm, dot, gardenItems, TYPE_LABEL } from "./garden-links";
import { upsertLink } from "./links";
import { AppError } from "./errors";

// —— 开关 ——
export const COGNITION_ENABLED = true;          // 总开关（聚类 / 工具 / 浮现置顶 / 星图）
export const COGNITION_PROMPT_ENABLED = true;   // 浮现里偶尔邀请伙伴写认知
export const COGNITION_PERSONAS = CFG.cognition;
export const COGNITION_FIRST = true;            // 浮现时认知排在最前
export const COGNITION_SIM = 0.62;              // 聚类门槛（余弦，和种子 & 组内平均）
export const COGNITION_MIN = 3;
export const COGNITION_MAX = 8;
export const COGNITION_OFFER_GAP_H = 4;         // 两次邀请至少间隔几小时
export const COGNITION_REOFFER_DAYS = 3;        // 没写的候选，多久后可以再提一次
export const COGNITION_MAX_OFFERS = 3;          // 同一组最多提几次
export const COGNITION_FADE = 0.85;             // 源记忆强度乘子（温和）
export const COGNITION_TAG = "认知";
export const COGNITION_CRON = true;             // 每 30 分钟 cron 顺手聚类一次（纯数学，日内最多一次）

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
async function q<T>(db: MemoryDb, sql: string, ...b: unknown[]): Promise<T[]> {
  try { return ((await db.prepare(sql).bind(...b).all<T>()).results ?? []); } catch { return []; }
}

let ready = false;
export async function ensureCognitionSchema(db: MemoryDb) {
  if (ready) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS cognition_candidates (
    id TEXT PRIMARY KEY, persona TEXT NOT NULL, items TEXT NOT NULL, score REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending', offers INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, offered_at TEXT, done_at TEXT, cognition_id TEXT)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_cog_cand_status ON cognition_candidates(persona, status)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS cognitions (
    id TEXT PRIMARY KEY, persona TEXT NOT NULL, candidate_id TEXT, sources TEXT NOT NULL,
    faded TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`).run();
  ready = true;
}

type CItem = { key: string; title: string; type: string };
type Node = CItem & { vec: Float32Array };

/** 某人格所有带向量的节点：记忆（memory:<id>）+ 花园内容（type:id）；不含认知自身。 */
async function nodesFor(db: MemoryDb, persona: string): Promise<Node[]> {
  const cogIds = new Set((await q<{ id: string }>(db, `SELECT id FROM cognitions`)).map((r) => r.id));
  const mem = await q<{ id: string; content: string; vec: string }>(db,
    `SELECT m.id, m.content, e.vec FROM memories m JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ? WHERE m.owner_persona = ?`, EMBED_MODEL, persona);
  const out: Node[] = mem.filter((m) => !cogIds.has(m.id)).map((m) => ({ key: `memory:${m.id}`, type: "memory", title: clip(m.content, 40), vec: norm(JSON.parse(m.vec) as number[]) }));
  const items = new Map((await gardenItems(db)).filter((i) => i.persona === persona).map((i) => [i.key, i]));
  for (const g of await q<{ node: string; vec: string }>(db, `SELECT node, vec FROM garden_embeddings WHERE persona = ? AND model = ?`, persona, EMBED_MODEL)) {
    const it = items.get(g.node); if (!it) continue;
    out.push({ key: g.node, type: it.type, title: clip(it.title || it.text, 40), vec: norm(dec(g.vec)) });
  }
  return out;
}

async function coveredKeys(db: MemoryDb, persona: string): Promise<Set<string>> {
  const s = new Set<string>();
  for (const r of await q<{ items: string }>(db, `SELECT items FROM cognition_candidates WHERE persona = ? AND status != 'dismissed'`, persona))
    for (const it of JSON.parse(r.items) as CItem[]) s.add(it.key);
  for (const r of await q<{ sources: string }>(db, `SELECT sources FROM cognitions WHERE persona = ?`, persona))
    for (const k of JSON.parse(r.sources) as string[]) s.add(k);
  return s;
}

/** 贪心聚类。dry=true 只算不写。 */
/** 一组里至少要有一条“有分量”的内容（记忆/日记/心情/梦/欲望/卡片），否则多半是聊天流水、图片或同一本小说的章节。 */
export const COGNITION_ANCHOR_TYPES = new Set(["memory", "diary", "mood", "dream", "desire", "card"]);
export function hasAnchor(types: string[]) { return types.some((t) => COGNITION_ANCHOR_TYPES.has(t)); }

export async function clusterCognition(db: MemoryDb, persona = CFG.primary, opts: { dry?: boolean; sim?: number; maxNew?: number } = {}) {
  await ensureCognitionSchema(db);
  const th = opts.sim ?? COGNITION_SIM;
  const covered = await coveredKeys(db, persona);
  const nodes = (await nodesFor(db, persona)).filter((n) => !covered.has(n.key));
  const N = nodes.length;
  const nb: { j: number; s: number }[][] = nodes.map(() => []);
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const s = dot(nodes[i]!.vec, nodes[j]!.vec);
    if (s >= th) { nb[i]!.push({ j, s }); nb[j]!.push({ j: i, s }); }
  }
  const used = new Set<number>();
  const order = nodes.map((_, i) => i).sort((a, b) => nb[b]!.length - nb[a]!.length);
  const clusters: { items: CItem[]; score: number }[] = [];
  for (const seed of order) {
    if (used.has(seed) || nb[seed]!.length < COGNITION_MIN - 1) continue;
    const mem = [seed];
    for (const { j } of [...nb[seed]!].sort((a, b) => b.s - a.s)) {
      if (mem.length >= COGNITION_MAX) break;
      if (used.has(j)) continue;
      const avg = mem.reduce((t, m) => t + dot(nodes[m]!.vec, nodes[j]!.vec), 0) / mem.length;
      if (avg >= th) mem.push(j);
    }
    if (mem.length < COGNITION_MIN) continue;
    if (!hasAnchor(mem.map((m) => nodes[m]!.type))) continue; // 全是聊天记录/图片/同一本小说的章节 → 跳过（不占用这些节点）
    let tot = 0, c = 0;
    for (let a = 0; a < mem.length; a++) for (let b = a + 1; b < mem.length; b++) { tot += dot(nodes[mem[a]!]!.vec, nodes[mem[b]!]!.vec); c++; }
    mem.forEach((m) => used.add(m));
    clusters.push({ items: mem.map((m) => ({ key: nodes[m]!.key, type: nodes[m]!.type, title: nodes[m]!.title })), score: Math.round((tot / c) * 1000) / 1000 });
  }
  clusters.sort((a, b) => b.score - a.score);
  const keep = clusters.slice(0, opts.maxNew ?? 50);
  const now = new Date().toISOString();
  const ids: string[] = [];
  if (!opts.dry) for (const c of keep) {
    const id = `cc_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await db.prepare(`INSERT INTO cognition_candidates (id, persona, items, score, status, created_at) VALUES (?,?,?,?, 'pending', ?)`).bind(id, persona, JSON.stringify(c.items), c.score, now).run();
    ids.push(id);
  }
  return { persona, threshold: th, nodes: N, already_covered: covered.size, clusters: keep.length, created: ids.length, ids, examples: keep.slice(0, 5) };
}

/** cron：每天最多跑一次（按日期幂等，记在 _schema_meta）。 */
export async function cronCognition(db: MemoryDb) {
  if (!COGNITION_ENABLED || !COGNITION_CRON) return { skipped: true };
  await ensureCognitionSchema(db);
  const day = new Date().toISOString().slice(0, 10);
  const last = await db.prepare(`SELECT v FROM _schema_meta WHERE k = 'cognition_cluster_day'`).first<{ v: string }>().catch(() => null);
  if (last?.v === day) return { skipped: "today" };
  await db.prepare(`INSERT INTO _schema_meta (k, v) VALUES ('cognition_cluster_day', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(day).run();
  const out: Record<string, unknown> = {};
  for (const p of COGNITION_PERSONAS) { const r = await clusterCognition(db, p, { maxNew: 10 }); out[p] = r.created; }
  return out;
}

/** 浮现钩子：限频地挑一组候选，返回一段自然的邀请（或空串）。 */
export async function maybeCognitionNote(db: MemoryDb, persona: string, nowMs = Date.now()): Promise<{ note: string; id?: string }> {
  if (!COGNITION_ENABLED || !COGNITION_PROMPT_ENABLED || !COGNITION_PERSONAS.has(persona)) return { note: "" };
  try {
    await ensureCognitionSchema(db);
    const gap = new Date(nowMs - COGNITION_OFFER_GAP_H * 3600_000).toISOString();
    const recent = await db.prepare(`SELECT 1 x FROM cognition_candidates WHERE persona = ? AND offered_at > ? LIMIT 1`).bind(persona, gap).first();
    if (recent) return { note: "" };
    const re = new Date(nowMs - COGNITION_REOFFER_DAYS * 86400_000).toISOString();
    const c = await db.prepare(`SELECT id, items FROM cognition_candidates WHERE persona = ? AND
        ((status = 'pending') OR (status = 'offered' AND offered_at < ? AND offers < ?))
      ORDER BY (status = 'pending') DESC, score DESC LIMIT 1`).bind(persona, re, COGNITION_MAX_OFFERS).first<{ id: string; items: string }>();
    if (!c) return { note: "" };
    const items = (JSON.parse(c.items) as CItem[]).slice(0, COGNITION_MAX);
    if (!hasAnchor(items.map((i) => i.type))) { await db.prepare(`UPDATE cognition_candidates SET status = 'dismissed' WHERE id = ?`).bind(c.id).run(); return { note: "" }; }
    await db.prepare(`UPDATE cognition_candidates SET status = 'offered', offers = offers + 1, offered_at = ? WHERE id = ?`).bind(new Date(nowMs).toISOString(), c.id).run();
    const lines = items.map((i) => `· ${i.type === "memory" ? "" : `（${TYPE_LABEL[i.type] ?? i.type}）`}${clip(i.title, 30)}`);
    const note = `\n\n[心里冒出的念头] 这几件关于她的事，好像说的是同一件事：\n${lines.join("\n")}\n要是你对{{USER_NAME}}在这上面有了自己的一句理解，想留下来，可以用 write_cognition（candidate_id: ${c.id}）写一句话。没感觉就随它去，不用回应这一段。`;
    return { note, id: c.id };
  } catch (e) { console.error("[cognition] note", e); return { note: "" }; }
}

/** 某人格的认知：id → 源节点键；以及 记忆id → 认知id。 */
export async function cognitionMaps(db: MemoryDb, persona?: string) {
  const rows = persona ? await q<{ id: string; sources: string }>(db, `SELECT id, sources FROM cognitions WHERE persona = ?`, persona)
    : await q<{ id: string; sources: string }>(db, `SELECT id, sources FROM cognitions`);
  const bySrc = new Map<string, string>(); const srcOf = new Map<string, string[]>();
  for (const r of rows) {
    const s = JSON.parse(r.sources) as string[]; srcOf.set(r.id, s);
    for (const k of s) if (k.startsWith("memory:")) bySrc.set(k.slice(7), r.id);
  }
  return { bySrc, srcOf };
}

type RememberFn = (db: MemoryDb, caller: Caller, input: any) => Promise<{ memory: { id: string } } | any>;

export async function writeCognition(db: MemoryDb, caller: Caller, input: { candidate_id: string; text: string }, remember: RememberFn) {
  if (!COGNITION_ENABLED) throw new AppError(400, "disabled", "认知功能暂时关着。");
  await ensureCognitionSchema(db);
  const text = String(input.text ?? "").trim();
  if (text.length < 2 || text.length > 300) throw new AppError(400, "invalid", "写一句话就好（2–300 字）。");
  const c = await db.prepare(`SELECT * FROM cognition_candidates WHERE id = ?`).bind(input.candidate_id).first<{ id: string; persona: string; items: string; status: string }>();
  if (!c) throw new AppError(404, "not_found", "没有这组念头。");
  if (!caller.isAdmin && caller.persona.id !== c.persona) throw new AppError(403, "forbidden", "这不是你的念头。");
  if (c.status === "done") throw new AppError(409, "done", "这组已经写过认知了。");
  const items = JSON.parse(c.items) as CItem[];
  const r = await remember(db, caller, { content: text, kind: "about_user", visibility: "private", importance: 4, tags: [COGNITION_TAG], owner: c.persona, emotion: 0.5 });
  const id: string = r?.memory?.id ?? r?.id;
  if (!id) throw new AppError(500, "write_failed", "认知没写进去。");
  const now = new Date().toISOString();
  const faded: Record<string, number | null> = {};
  for (const it of items) {
    if (!it.key.startsWith("memory:")) continue;
    const mid = it.key.slice(7);
    try { await upsertLink(db, id, mid, 0.9, "manual", now); } catch (e) { console.error("[cognition] link", e); }
    const m = await db.prepare(`SELECT strength, state FROM memories WHERE id = ?`).bind(mid).first<{ strength: number | null; state: string | null }>();
    if (!m || m.state === "pinned" || m.strength == null) continue;
    faded[mid] = m.strength;
    await db.prepare(`UPDATE memories SET strength = ? WHERE id = ?`).bind(Math.max(0, m.strength * COGNITION_FADE), mid).run();
  }
  await db.prepare(`INSERT INTO cognitions (id, persona, candidate_id, sources, faded, created_at) VALUES (?,?,?,?,?,?)`).bind(id, c.persona, c.id, JSON.stringify(items.map((i) => i.key)), JSON.stringify(faded), now).run();
  await db.prepare(`UPDATE cognition_candidates SET status = 'done', done_at = ?, cognition_id = ? WHERE id = ?`).bind(now, id, c.id).run();
  return { id, text: `记下了这份认知 #${id}，和 ${items.length} 段记忆连在一起；那几段会稍微淡一点，但不会消失。` };
}

/** 撤销：恢复源记忆强度、删认知记忆与连线、候选回到 pending（drop=1 时连候选一起删）。 */
export async function undoCognition(db: MemoryDb, id: string, dropCandidate = false) {
  await ensureCognitionSchema(db);
  const r = await db.prepare(`SELECT * FROM cognitions WHERE id = ?`).bind(id).first<{ id: string; candidate_id: string; faded: string }>();
  if (!r) return { ok: false, error: "not_found" };
  const faded = JSON.parse(r.faded) as Record<string, number | null>;
  for (const [mid, s] of Object.entries(faded)) await db.prepare(`UPDATE memories SET strength = ? WHERE id = ?`).bind(s, mid).run();
  await db.prepare(`DELETE FROM memory_links WHERE a_id = ? OR b_id = ?`).bind(id, id).run();
  await db.prepare(`DELETE FROM memory_embeddings WHERE memory_id = ?`).bind(id).run();
  try { await db.prepare(`DELETE FROM garden_links WHERE a = ? OR b = ?`).bind(`memory:${id}`, `memory:${id}`).run(); } catch { /* */ }
  await db.prepare(`DELETE FROM memories WHERE id = ?`).bind(id).run();
  await db.prepare(`DELETE FROM cognitions WHERE id = ?`).bind(id).run();
  try { await db.prepare(`DELETE FROM notion_outbox WHERE local_id = ? AND status = 'pending'`).bind(id).run(); } catch { /* */ }
  if (dropCandidate) await db.prepare(`DELETE FROM cognition_candidates WHERE id = ?`).bind(r.candidate_id).run();
  else await db.prepare(`UPDATE cognition_candidates SET status = 'pending', cognition_id = NULL, done_at = NULL WHERE id = ?`).bind(r.candidate_id).run();
  return { ok: true, restored: Object.keys(faded).length };
}

export async function cognitionStats(db: MemoryDb) {
  await ensureCognitionSchema(db);
  const by = await q<{ status: string; n: number }>(db, `SELECT status, COUNT(*) n FROM cognition_candidates GROUP BY status`);
  const n = (await db.prepare(`SELECT COUNT(*) n FROM cognitions`).first<{ n: number }>())?.n ?? 0;
  return { candidates: Object.fromEntries(by.map((r) => [r.status, r.n])), cognitions: n };
}

export { clip as cogClip };
