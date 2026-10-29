// 记忆花园 → 星图：把花园里的日记/小说/卡片/聊天摘要/欲望/梦/便签/心事/图片/语音也变成星星，并和记忆连线。
// 独立表 garden_embeddings / garden_links（节点键 "type:id"，记忆是 "memory:<id>"），
// 不写 memory_links，所以 浮现（associate / neighborsOf）完全不受影响。
import type { Env, MemoryDb } from "./types";
import { EMBED_MODEL, SEM_TOP_K, SEM_MIN, SEM_MIN_CROSS } from "./links";
import { loadNovelFamilyIds } from "./deck";

export const GARDEN_ATLAS_ENABLED = true;   // 星图显示花园内容
export const GARDEN_LINKS_ENABLED = true;   // 花园内容参与语义连线
export const RELATED_INCLUDE_ITEMS = true;  // recall_related 也列出连着的花园内容（只读）
export const GARDEN_EMBED_CLIP = 1500;      // 送去算向量的最多字数
export const GARDEN_TIME_LINK_W = 0.3;      // 同一天的弱连线
export const GARDEN_TIME_LINK_MAX = 2;      // 每个节点最多几条同日连线
export const GARDEN_ITEM_CAP = 1500;        // 单类超过就按最近采样

export const TYPE_LABEL: Record<string, string> = {
  memory: "记忆", diary: "日记", murmur: "碎碎念", novel: "小说", card: "卡片", chat: "聊天摘要", desire: "欲望",
  dream: "梦", handoff: "便签", worry: "心事", entry: "花园手记", image: "图片", voice: "语音", note: "陪伴便条", mood: "她的心情",
};

export type GItem = { key: string; type: string; id: string; persona: string; title: string; text: string; date: string; extra?: string };

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
async function q<T>(db: MemoryDb, sql: string, ...b: unknown[]): Promise<T[]> {
  try { return ((await db.prepare(sql).bind(...b).all<T>()).results ?? []); } catch { return []; }
}

/** 花园里所有“有意义”的内容（不含聊天原文、身体日志、Notion 镜像、抽卡记录）。 */
export async function gardenItems(db: MemoryDb): Promise<GItem[]> {
  const out: GItem[] = [];
  const add = (type: string, id: string, persona: string | null, title: string, text: string, date: string, extra?: string) => {
    if (!id) return; out.push({ key: `${type}:${id}`, type, id, persona: persona || "family", title: clip(title, 80), text: String(text ?? ""), date: String(date ?? "").slice(0, 10), extra });
  };
  let novel = new Set<string>(); try { novel = await loadNovelFamilyIds(db); } catch { /* */ }
  const topics = new Map((await q<{ id: string; name: string }>(db, `SELECT id, name FROM topics`)).map((t) => [t.id, t.name]));
  for (const r of await q<Record<string, string>>(db, `SELECT id, owner_persona, created_by, title, content, kind, topic_id, created_at, updated_at FROM deck_items ORDER BY updated_at DESC LIMIT ${GARDEN_ITEM_CAP}`)) {
    const t = r.kind === "novel" || novel.has(r.topic_id!) ? "novel" : r.kind === "diary" ? "diary" : r.kind === "murmur" ? "murmur" : "card";
    add(t, r.id!, r.owner_persona || r.created_by, r.title!, r.content!, r.created_at!, topics.get(r.topic_id!) || r.kind);
  }
  for (const r of await q<Record<string, string>>(db, `SELECT id, persona_id, title, summary, entry_date, created_at FROM conversations ORDER BY created_at DESC LIMIT ${GARDEN_ITEM_CAP}`))
    add("chat", r.id!, r.persona_id, r.title!, `${r.title ?? ""}\n${r.summary ?? ""}`, r.entry_date || r.created_at!);
  for (const r of await q<Record<string, string>>(db, `SELECT id, persona_id, entry_date, level_label, status, trigger_text, mood, created_at FROM desire_logs`))
    add("desire", r.id!, r.persona_id, [r.level_label, r.mood].filter(Boolean).join(" · ") || "欲望", [r.level_label, r.mood, r.trigger_text].filter(Boolean).join("\n"), r.entry_date || r.created_at!, r.status);
  for (const r of await q<Record<string, string>>(db, `SELECT id, persona_id, dream_date, text, created_at FROM dreams`))
    add("dream", r.id!, r.persona_id, `梦 ${r.dream_date ?? ""}`, r.text!, r.dream_date || r.created_at!);
  for (const r of await q<Record<string, string>>(db, `SELECT id, persona_id, summary, mood, next_time, created_at FROM handoffs`))
    add("handoff", r.id!, r.persona_id, r.mood ? `交接 · ${r.mood}` : "交接便签", [r.summary, r.mood && `心情：${r.mood}`, r.next_time && `下次：${r.next_time}`].filter(Boolean).join("\n"), r.created_at!);
  for (const r of await q<Record<string, string>>(db, `SELECT id, persona_id, title, content, context, status, created_at FROM unresolved`))
    add("worry", r.id!, r.persona_id, r.title || clip(r.content, 30), [r.title, r.content, r.context].filter(Boolean).join("\n"), r.created_at!, r.status);
  for (const r of await q<Record<string, string>>(db, `SELECT id, persona_id, kind, title, body, entry_date, created_at FROM garden_entries`))
    add("entry", r.id!, r.persona_id, r.title!, `${r.title ?? ""}\n${r.body ?? ""}`, r.entry_date || r.created_at!, r.kind);
  for (const r of await q<Record<string, string>>(db, `SELECT id, persona_id, title, entry_date, created_at FROM garden_images`))
    add("image", r.id!, r.persona_id, r.title || "图片", r.title || "", r.entry_date || r.created_at!);
  for (const r of await q<Record<string, string>>(db, `SELECT id, persona_id, title, entry_date, created_at FROM voice_clips`))
    add("voice", r.id!, r.persona_id, r.title || "语音", r.title || "", r.entry_date || r.created_at!);
  for (const r of await q<Record<string, string>>(db, `SELECT id, persona_id, content, created_at FROM companion_notes`))
    add("note", r.id!, r.persona_id, clip(r.content, 30), r.content!, r.created_at!);
  for (const r of await q<Record<string, string>>(db, `SELECT id, text, preset, created_at FROM her_status`))
    add("mood", r.id!, "family", r.text || r.preset || "心情", [r.preset, r.text].filter(Boolean).join(" "), r.created_at!);
  return out;
}

export async function ensureGardenLinksSchema(db: MemoryDb) {
  for (const s of [
    `CREATE TABLE IF NOT EXISTS garden_embeddings (node TEXT PRIMARY KEY, persona TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL, vec TEXT NOT NULL, text_len INTEGER NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS garden_links (a TEXT NOT NULL, b TEXT NOT NULL, weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 1), kind TEXT NOT NULL CHECK (kind IN ('semantic','time')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (a, b), CHECK (a < b))`,
    `CREATE INDEX IF NOT EXISTS idx_garden_links_b ON garden_links(b)`,
  ]) await db.prepare(s).run();
}

// Float32 → base64（比 JSON 小 4–5 倍）
export const enc = (v: number[]) => { const f = new Float32Array(v); let s = ""; const u = new Uint8Array(f.buffer); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!); return btoa(s); };
export const dec = (b: string) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new Float32Array(u.buffer); };
export function norm(v: ArrayLike<number>) { let x = 0; for (let i = 0; i < v.length; i++) x += v[i]! * v[i]!; x = Math.sqrt(x) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i]! / x; return o; }
export function dot(a: Float32Array, b: Float32Array) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!; return d; }

async function batchRun(db: MemoryDb, stmts: ReturnType<MemoryDb["prepare"]>[]) {
  const b = (db as unknown as { batch?: (s: unknown[]) => Promise<unknown> }).batch;
  for (let i = 0; i < stmts.length; i += 80) {
    const part = stmts.slice(i, i + 80);
    if (b) await b.call(db, part); else for (const s of part) await s.run();
  }
}

type Node = { key: string; persona: string; date: string; vec?: Float32Array };

async function memoryNodes(db: MemoryDb): Promise<Node[]> {
  const rows = await q<{ id: string; owner_persona: string; d: string; vec: string }>(db,
    `SELECT m.id, m.owner_persona, COALESCE(m.event_date, m.created_at) d, e.vec FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.model = ?`, EMBED_MODEL);
  return rows.map((r) => ({ key: `memory:${r.id}`, persona: r.owner_persona, date: String(r.d ?? "").slice(0, 10), vec: r.vec ? norm(JSON.parse(r.vec) as number[]) : undefined }));
}

/** 补花园向量（最多 max 条），然后全量重算花园连线。 */
export async function gardenBackfill(db: MemoryDb, ai: NonNullable<Env["AI"]>, max = 400, relink = true) {
  await ensureGardenLinksSchema(db);
  const items = await gardenItems(db);
  const have = new Map((await q<{ node: string; vec: string }>(db, `SELECT node, vec FROM garden_embeddings WHERE model = ?`, EMBED_MODEL)).map((r) => [r.node, r.vec]));
  const missing = items.filter((i) => !have.has(i.key) && clip(i.text, 10).length >= 2).slice(0, max);
  const now = new Date().toISOString();
  for (let i = 0; i < missing.length; i += 24) {
    const batch = missing.slice(i, i + 24);
    const r = (await ai.run(EMBED_MODEL, { text: batch.map((x) => clip(`${x.title}\n${x.text}`, GARDEN_EMBED_CLIP)) })) as { data?: number[][] };
    if (!r?.data || r.data.length !== batch.length) throw new Error("embedding failed");
    const st = batch.map((x, j) => { const b64 = enc(r.data![j]!); have.set(x.key, b64);
      return db.prepare(`INSERT OR REPLACE INTO garden_embeddings (node, persona, model, dim, vec, text_len, updated_at) VALUES (?,?,?,?,?,?,?)`).bind(x.key, x.persona, EMBED_MODEL, r.data![j]!.length, b64, x.text.length, now); });
    await batchRun(db, st);
  }
  let linkInfo = {};
  if (relink && GARDEN_LINKS_ENABLED) linkInfo = await relinkGarden(db, items, have, now);
  return { items: items.length, embedded_now: missing.length, with_vectors: items.filter((i) => have.has(i.key)).length, remaining: items.filter((i) => !have.has(i.key) && clip(i.text, 10).length >= 2).length, ...linkInfo };
}

async function relinkGarden(db: MemoryDb, items: GItem[], have: Map<string, string>, now: string) {
  const mem = await memoryNodes(db);
  const gnodes: Node[] = items.map((i) => ({ key: i.key, persona: i.persona, date: i.date, vec: have.has(i.key) ? norm(dec(have.get(i.key)!)) : undefined }));
  const all = [...mem, ...gnodes];
  const edges = new Map<string, { w: number; k: string }>();
  const put = (x: string, y: string, w: number, k: string) => {
    if (x === y || (x.startsWith("memory:") && y.startsWith("memory:"))) return; // 记忆↔记忆 归 memory_links
    const [a, b] = x < y ? [x, y] : [y, x]; const id = `${a}|${b}`; const o = edges.get(id);
    if (!o || o.w < w) edges.set(id, { w: Math.min(1, Math.max(0, w)), k });
  };
  for (const g of gnodes) {
    if (!g.vec) continue;
    const sims: { n: Node; s: number }[] = [];
    for (const o of all) {
      if (o === g || !o.vec) continue;
      const same = o.persona === g.persona, cross = !same && (o.persona === "family" || g.persona === "family");
      if (!same && !cross) continue;
      const s = dot(g.vec, o.vec);
      if (s >= (same ? SEM_MIN : SEM_MIN_CROSS)) sims.push({ n: o, s });
    }
    sims.sort((a, b) => b.s - a.s);
    for (const { n, s } of sims.slice(0, SEM_TOP_K)) put(g.key, n.key, 0.35 + ((s - SEM_MIN) / (1 - SEM_MIN)) * 0.65, "semantic");
  }
  // 同一天：同人格的花园内容 ↔ 记忆/花园内容，每个节点最多 2 条
  const byDay = new Map<string, Node[]>();
  for (const n of all) { if (!n.date) continue; const k = `${n.persona}|${n.date}`; (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(n); }
  for (const list of byDay.values()) {
    if (list.length < 2) continue;
    for (const g of list) { if (g.key.startsWith("memory:")) continue; let c = 0;
      for (const o of list) { if (c >= GARDEN_TIME_LINK_MAX) break; if (o === g) continue; const id = g.key < o.key ? `${g.key}|${o.key}` : `${o.key}|${g.key}`; if (edges.has(id)) continue; put(g.key, o.key, GARDEN_TIME_LINK_W, "time"); c++; } }
  }
  await db.prepare(`DELETE FROM garden_links`).run();
  await batchRun(db, [...edges].map(([id, e]) => { const [a, b] = id.split("|"); return db.prepare(`INSERT INTO garden_links (a, b, weight, kind, created_at, updated_at) VALUES (?,?,?,?,?,?)`).bind(a, b, e.w, e.k, now, now); }));
  return gardenLinkStats(db);
}

export async function gardenLinkStats(db: MemoryDb) {
  const r = await q<{ kind: string; n: number; w: number }>(db, `SELECT kind, COUNT(*) n, ROUND(AVG(weight),3) w FROM garden_links GROUP BY kind`);
  return { garden_links_total: r.reduce((s, x) => s + x.n, 0), garden_links_by_kind: Object.fromEntries(r.map((x) => [x.kind, { n: x.n, avg_weight: x.w }])) };
}

export async function allGardenLinks(db: MemoryDb) {
  return q<{ a: string; b: string; w: number; k: string }>(db, `SELECT a, b, ROUND(weight,3) w, kind k FROM garden_links`);
}

/** cron：有新内容时补一点向量并重连（每次最多 40 条）。 */
export async function cronGarden(db: MemoryDb, ai: NonNullable<Env["AI"]> | undefined) {
  if (!ai || !GARDEN_LINKS_ENABLED) return;
  await ensureGardenLinksSchema(db);
  const items = await gardenItems(db);
  const n = (await db.prepare(`SELECT COUNT(*) n FROM garden_embeddings`).first<{ n: number }>())?.n ?? 0;
  const embeddable = items.filter((i) => clip(i.text, 10).length >= 2).length;
  if (n >= embeddable) return;
  await gardenBackfill(db, ai, 40, true);
}

/** recall_related 用：一条记忆连着的花园内容（只读，按类型标注）。 */
export async function relatedItemsForMemory(db: MemoryDb, memoryId: string, allowPersonas: Set<string> | null, limit = 4) {
  if (!RELATED_INCLUDE_ITEMS) return [] as string[];
  const k = `memory:${memoryId}`;
  const es = await q<{ o: string; w: number; k: string }>(db, `SELECT b o, weight w, kind k FROM garden_links WHERE a = ? UNION ALL SELECT a o, weight w, kind k FROM garden_links WHERE b = ? ORDER BY w DESC LIMIT 20`, k, k);
  const want = es.filter((e) => !e.o.startsWith("memory:"));
  if (!want.length) return [];
  const items = new Map((await gardenItems(db)).map((i) => [i.key, i]));
  const out: string[] = [];
  for (const e of want) {
    const it = items.get(e.o); if (!it) continue;
    if (allowPersonas && !allowPersonas.has(it.persona)) continue;
    out.push(`- [${TYPE_LABEL[it.type] ?? it.type} · ${it.date} · ${e.k === "time" ? "同一天" : "意思相近"} ${Math.round(e.w * 100)}%] ${it.title ? it.title + "：" : ""}${clip(it.text, 100)}`);
    if (out.length >= limit) break;
  }
  return out;
}
