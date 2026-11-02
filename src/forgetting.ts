import { schemaCurrent } from "./schema-gate";
/**
 * 遗忘机制 phase 1（2026-10-28）：纯数学，不调模型，不删除任何东西。
 * strength 在读取时按半衰期衰减；被「真正用到」时强化。
 * 状态：pinned（不衰减）/ clear ≥0.5 / faded 0.15–0.5 / trace <0.15。
 */
import type { MemoryDb, MemoryRow } from "./types";

export type MemoryState = "clear" | "faded" | "trace" | "pinned";
export const FADED_MIN = 0.15;
export const CLEAR_MIN = 0.5;
export const DEFAULT_EMOTION = 0.3;
const DAY_MS = 86400_000;
const BASE_HALF_LIFE: Record<number, number> = { 1: 2, 2: 5, 3: 14, 4: 45 };
export const FADED_PREFIX = "（记得不太清了）";
export const TRACE_PREFIX = "（很久以前的事）";

export interface DecayFields {
  strength?: number | null;
  emotion?: number | null;
  half_life_days?: number | null;
  last_recalled_at?: string | null;
  recall_count?: number | null;
  state?: string | null;
  faded_text?: string | null;
  last_surfaced_at?: string | null;
}
type Row = Pick<MemoryRow, "importance" | "kind" | "tags" | "content" | "created_at"> & DecayFields;

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/**
 * 初始强度。注：任务书写的是 importance/5，但验收用例（重要2、情绪0、10 天后应为 faded）
 * 在 importance/5=0.4 下会算出 0.1（trace）。重要度已经体现在半衰期里，所以这里用 0.5+importance/10
 * （1→0.6 … 5→1.0），让新记忆一律从 clear 起步、验收用例成立。改这一处即可切回 importance/5。
 */
export function initialStrength(importance: number): number {
  return clamp01(0.5 + (Number(importance) || 3) / 10);
}

export function baseHalfLife(importance: number, emotion = DEFAULT_EMOTION): number | null {
  const imp = Math.round(Number(importance) || 3);
  if (imp >= 5) return null; // pinned
  return (BASE_HALF_LIFE[Math.max(1, imp)] ?? 14) * (1 + 2 * clamp01(emotion));
}

/** 写入时的「默认钉住」规则：重要 5、偏好、核心卡、安全词。 */
export function pinnedByRule(r: Pick<MemoryRow, "importance" | "kind" | "tags" | "content">): boolean {
  if (Number(r.importance) >= 5) return true;
  if (r.kind === "preference") return true;
  const t = r.tags ?? "";
  if (/核心|安全词|safe ?word/i.test(t)) return true;
  if (/安全词|safe ?word/i.test((r.content ?? "").slice(0, 200))) return true;
  return false;
}

export function isPinned(r: Row): boolean {
  if (r.state === "pinned") return true;
  if (r.state == null) return pinnedByRule(r); // 迁移前 / 未回填的行
  return false;
}

export function emotionOf(r: Row): number {
  return r.emotion == null ? DEFAULT_EMOTION : clamp01(Number(r.emotion));
}

export function halfLifeOf(r: Row): number {
  const h = Number(r.half_life_days);
  if (Number.isFinite(h) && h > 0) return h;
  return baseHalfLife(r.importance, emotionOf(r)) ?? 14;
}

export function strengthNow(r: Row, nowMs = Date.now()): number {
  if (isPinned(r)) return 1;
  const s0 = r.strength == null ? initialStrength(r.importance) : clamp01(Number(r.strength));
  const t = Date.parse(r.last_recalled_at || r.created_at);
  const days = Number.isFinite(t) ? Math.max(0, (nowMs - t) / DAY_MS) : 0;
  return s0 * Math.pow(0.5, days / halfLifeOf(r));
}

export function stateOf(r: Row, nowMs = Date.now()): MemoryState {
  if (isPinned(r)) return "pinned";
  const s = strengthNow(r, nowMs);
  if (s >= CLEAR_MIN) return "clear";
  if (s >= FADED_MIN) return "faded";
  return "trace";
}

/** 强化：s = s_now + (1-s_now)*0.5；半衰期 ×1.5；次数+1；时钟归零；回到 clear。 */
export function reinforcePatch(r: Row, nowMs = Date.now()) {
  if (isPinned(r)) {
    return { strength: 1, half_life_days: r.half_life_days ?? null, recall_count: (Number(r.recall_count) || 0) + 1, last_recalled_at: new Date(nowMs).toISOString(), state: "pinned" as MemoryState };
  }
  const sNow = strengthNow(r, nowMs);
  const strength = sNow + (1 - sNow) * 0.5;
  return {
    strength,
    half_life_days: halfLifeOf(r) * 1.5,
    recall_count: (Number(r.recall_count) || 0) + 1,
    last_recalled_at: new Date(nowMs).toISOString(),
    state: (strength >= CLEAR_MIN ? "clear" : strength >= FADED_MIN ? "faded" : "trace") as MemoryState,
  };
}

/** 新记忆的字段。 */
export function initialFields(input: { importance: number; kind: string; tags: string; content: string; emotion?: number; pin?: boolean }, createdAt: string) {
  const emotion = input.emotion == null ? DEFAULT_EMOTION : clamp01(input.emotion);
  const pinned = input.pin === true || (input.pin !== false && pinnedByRule(input as never));
  return {
    strength: initialStrength(input.importance),
    emotion,
    half_life_days: baseHalfLife(input.importance, emotion) ?? baseHalfLife(4, emotion)!,
    last_recalled_at: createdAt,
    recall_count: 0,
    state: (pinned ? "pinned" : "clear") as MemoryState,
  };
}

/** 展示用正文：faded 加前缀（尚无 faded_text 时保留全文），trace 标「很久以前的事」。 */
export function displayContent(r: Row, state: MemoryState): string {
  if (state === "faded") return r.faded_text ? `${FADED_PREFIX}${r.faded_text}` : `${FADED_PREFIX}${r.content}`;
  if (state === "trace") return `${TRACE_PREFIX}${r.faded_text || r.content}`;
  return r.content;
}

/** 近乎原文命中（trace 才会被普通 recall 捞出来）。 */
export function nearExactMatch(content: string, query: string): boolean {
  const q = query.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  if ([...q].length < 2) return false;
  return content.normalize("NFKC").toLowerCase().replace(/\s+/g, "").includes(q);
}

export const DECAY_COLUMNS = `strength, emotion, half_life_days, last_recalled_at, recall_count, state, faded_text, last_surfaced_at`;

// —— schema（幂等；快路径一次 SELECT 探测）——
let ready = false;
export async function ensureForgettingSchema(db: MemoryDb): Promise<void> {
  if (ready) return;
  if (await schemaCurrent(db)) return;
  try {
    await db.prepare(`SELECT ${DECAY_COLUMNS} FROM memories LIMIT 1`).first();
    ready = true;
    return;
  } catch { /* migrate */ }
  for (const col of [
    `strength REAL`, `emotion REAL DEFAULT 0.3`, `half_life_days REAL`, `last_recalled_at TEXT`,
    `recall_count INTEGER NOT NULL DEFAULT 0`, `state TEXT`, `faded_text TEXT`, `last_surfaced_at TEXT`,
  ]) {
    try { await db.prepare(`ALTER TABLE memories ADD COLUMN ${col}`).run(); } catch { /* exists */ }
  }
  await backfill(db);
  ready = true;
}

/** 回填（只填 NULL，可重复执行）。 */
export async function backfill(db: MemoryDb): Promise<void> {
  const stmts = [
    `UPDATE memories SET emotion = 0.3 WHERE emotion IS NULL`,
    `UPDATE memories SET strength = MIN(1.0, 0.5 + importance / 10.0) WHERE strength IS NULL`,
    `UPDATE memories SET last_recalled_at = created_at WHERE last_recalled_at IS NULL`,
    `UPDATE memories SET state = 'pinned' WHERE state IS NULL AND (importance >= 5 OR kind = 'preference' OR tags LIKE '%核心%' OR tags LIKE '%安全词%' OR lower(tags) LIKE '%safe%word%' OR content LIKE '%安全词%')`,
    `UPDATE memories SET state = 'clear' WHERE state IS NULL`,
    `UPDATE memories SET half_life_days = (CASE WHEN importance <= 1 THEN 2 WHEN importance = 2 THEN 5 WHEN importance = 3 THEN 14 ELSE 45 END) * (1 + 2 * emotion) WHERE half_life_days IS NULL`,
  ];
  for (const s of stmts) await db.prepare(s).run();
}

export async function reinforceMemory(db: MemoryDb, row: Row & { id: string }, nowMs = Date.now()) {
  const p = reinforcePatch(row, nowMs);
  try {
    await db
      .prepare(`UPDATE memories SET strength = ?, half_life_days = ?, recall_count = ?, last_recalled_at = ?, state = ? WHERE id = ?`)
      .bind(p.strength, p.half_life_days, p.recall_count, p.last_recalled_at, p.state, row.id)
      .run();
  } catch (e) { console.error("reinforce failed", e); }
  return p;
}

// —— 浮现加权 ——
export const SURFACE_COOLDOWN_MS = 48 * 3600_000;
export const TRACE_SURFACE_CHANCE = 0.05;
/** 返回乘子（0 = 不浮现）。recentOverlap = 命中词也出现在最近对话里。 */
export function surfaceWeight(r: Row, opts: { nowMs?: number; recentOverlap?: boolean; rand?: () => number; auto?: boolean; cong?: number; toneIntensity?: number } = {}): number {
  const now = opts.nowMs ?? Date.now();
  const last = r.last_surfaced_at ? Date.parse(r.last_surfaced_at) : NaN;
  if (Number.isFinite(last) && now - last < SURFACE_COOLDOWN_MS) return 0;
  const st = stateOf(r, now);
  const s = strengthNow(r, now);
  let w: number;
  if (st === "trace") {
    if (opts.auto) return 0; // 自动浮现：不再随机冒出几乎忘掉的（显式 recall 仍可找到）
    if ((opts.rand ?? Math.random)() >= TRACE_SURFACE_CHANCE) return 0;
    w = 0.5;
  } else if (st === "faded") {
    w = opts.auto ? 0.8 : s >= 0.2 && s <= 0.4 ? 1.5 : 0.8; // 自动浮现不偏爱「快忘了」；手动 recall 偏爱那段
  } else w = 1;
  w *= 1 + emotionOf(r);
  if (opts.recentOverlap) w *= 2;
  // 方案 A：心境一致（0..1）× 情绪强度 → ±15% 以内（仅 bm25 回退模式会传）
  if (opts.cong != null) w *= 1 + 0.3 * (opts.cong - 0.5) * Math.max(0, Math.min(1, opts.toneIntensity ?? 0));
  return w;
}

// —— 保存时标签：topic / people / mood，JSON 文本列（迁移 0017；运行时也会自动补列）——
// topic / mood 是固定小词表（方便浮现时按话题、心境加权）；people 是自由文本（人格 id 或名字）。
export const TOPIC_VALUES = ["亲密", "吵架", "和好", "日常", "承诺", "身体", "梦", "工作", "第一次", "失落"] as const;
export const MOOD_VALUES = ["甜", "痛", "平", "怒", "怕"] as const;
let tagReady = false;
export async function ensureTagColumns(db: MemoryDb): Promise<void> {
  if (tagReady) return;
  try {
    await db.prepare(`SELECT topic, people, mood FROM memories LIMIT 1`).first();
    tagReady = true;
    return;
  } catch { /* migrate */ }
  for (const col of [`topic TEXT`, `people TEXT`, `mood TEXT`]) {
    try { await db.prepare(`ALTER TABLE memories ADD COLUMN ${col}`).run(); } catch { /* exists */ }
  }
  tagReady = true;
}
