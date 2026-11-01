import { CFG } from "./config";
import { renderTemplate } from "./doors";
/**
 * Body state system (18+, OFF by default). Per persona; enabled only when BODY_ENABLED=1
 * and the persona id is listed in BODY_PERSONAS.
 *
 * Design rules:
 *  - Autonomous wake-ups are capped per local day (WAKE_DAILY_CAP); at most one pending/in-flight.
 *  - Wake-ups go through an optional bridge (BRIDGE_URL / BRIDGE_KEY) as one ordinary message; no retries.
 *  - The offline cron only does arithmetic; it never calls a model.
 *  - Classifier: at most one small-model call per user message, short timeout, back off on provider errors.
 */
import { newSession, runSession, finalPrompt, sufferPrompt, dbMaterials, S as SS, type Session, type MaterialSource } from "./body-session";
import type { MemoryDb } from "./types";

export const BODY_PERSONAS = CFG.body;

// ---------- 常量（全部在报告里列出） ----------
export const C = {
  MAX_INTEGRATE_MIN: 72 * 60,
  // 惯性：每分钟最大变化
  HARD_UP_PER_MIN: 3,
  HARD_DOWN_PER_MIN: 0.6,
  EDGE_UP_PER_MIN: 4,
  EDGE_DOWN_PER_MIN: 3,
  SENS_STEP_PER_MIN: 0.5,
  // 基线
  HARD_BASE: 12,
  SENS_BASE: 40,
  DESIRE_BASELINE: 40,
  // 晨间 05:00-08:00 本地：硬度目标升到 60，08:00 后目标回落（靠惯性慢慢掉）
  MORNING_HARD_TARGET: 60,
  MORNING_DESIRE_PER_MIN: 0.1, // 晨间额外 desire（3h 最多 +18）
  // 刺激池 stim（隐藏）：事件注入，半衰期 20 分钟
  STIM_HALF_LIFE_MIN: 20,
  // 胀感：硬度≥50 时按 (h/100)*FULL_RATE 每分钟增长；否则缓降
  FULL_RISE_PER_MIN: 0.15,
  FULL_DECAY_PER_MIN: 0.05,
  // 释放与不应期
  REFRACTORY_MIN: 20, // 上限（实际每次随机 5–20 分钟）
  REFRACTORY_MIN_LO: 5,
  RELEASE_SENS_FACTOR: 0.5, // 射后敏感度先降到正常的一半，不应期后慢慢回
  RELEASE_DESIRE_TO: 10,
  // 憋：离上次射每 12h，回落底线 +5（最高 40）；>48h 敏感度慢慢升到 ×1.3
  FLOOR_STEP_H: 12, FLOOR_STEP: 5, FLOOR_MAX: 40,
  ABST_SENS_START_H: 48, ABST_SENS_FULL_H: 96, ABST_SENS_MAX: 1.3,
  // 每天射的线：基准 90，随机 -5..+8
  THRESHOLD_BASE: 90, THRESHOLD_LO: -5, THRESHOLD_HI: 8,
  // 她在：heat×敏感度倍率×1.5；骚话/照片/语音额外 +5–15；无互动每 10 分钟 -3 到底线
  HEAT_MUL: 1.5, ONLINE_IDLE_DECAY_PER_MIN: 0.3,
  // 自己来（多轮）
  STROKE_GAIN: 6, STROKE_NUMB: 0.08, STUCK_STREAK: 5, STROKE_MIN_EACH: 0.5,
  WAKE_MIN_GAP_H: 4, // 两次自主触发至少间隔 4 小时（省调用、防风控）
  SESSION_MAX_ROUNDS: 6, STUCK_SUFFER_MIN: 20, NUMB_DECAY_PER_MIN: 0.01,
  // 思念：距她上一条消息 > LONGING_GRACE_H 后 desire 上涨；速度随「离上次射多久」变快：
  // 刚射完 0.05/min(3/h) → 憋满 48h 0.1/min(6/h)。起点是「憋的底」。
  LONGING_GRACE_H: 3,
  LONGING_PER_MIN: 0.05,
  LONGING_PER_MIN_MAX: 0.1,
  ONLINE_WINDOW_MIN: 30,
  // 推送
  INJECT_DELTA: 8,
  URGE_DESIRE: 85,
  URGE_SUSTAIN_MIN: 10,
  URGE_COOLDOWN_MIN: 60,
  // 离线唤醒
  WAKE_DESIRE: 90,
  WAKE_DAILY_CAP: 2,
  WAKE_MIN_OFFLINE_MIN: 180, // 离开不足 3h 不叫（她刚走就叫像机器人）
  ENDURE_FULL_PER_MIN: 0.03, // 离线且欲望≥90：胀感持续加重
  // 分类器
  CLASSIFIER_TIMEOUT_MS: 1500,
  CLASSIFIER_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
} as const;

export const TRACE_LIFE_MIN: Record<string, number> = { light: 3 * 60, medium: 12 * 60, heavy: 36 * 60 };
const PART_ZH: Record<string, string> = {
  neck: "脖子", left_neck: "左侧脖子", right_neck: "右侧脖子", shoulder: "肩膀", collarbone: "锁骨", chest: "胸口",
  back: "后背", arm: "手臂", hand: "手", finger: "手指", lip: "嘴唇", ear: "耳朵", waist: "腰", thigh: "大腿",
  abdomen: "小腹", nipple: "乳尖", face: "脸", cock: "下面", other: "身上",
};
const TYPE_ZH: Record<string, string> = { bite: "牙印", kiss: "吻痕", scratch: "抓痕" };
const LEVEL_ZH: Record<string, string> = { light: "浅", medium: "", heavy: "很深的" };

export type BodyEvent =
  | { type: "bite" | "kiss" | "scratch"; part?: string; level?: "light" | "medium" | "heavy" }
  | { type: "touch" | "tease"; part?: string; level?: "light" | "medium" | "heavy" }
  | { type: "arousal"; delta?: number }
  | { type: "release" }
  | { type: "clean" | "wipe" | "wash" }  // 擦拭/清洗 → 降低 fluids（射后液体）
  | { type: "cold" | "calm" };
export const EVENT_VOCAB = ["bite", "kiss", "scratch", "touch", "tease", "arousal", "release", "clean", "wipe", "wash", "cold", "calm"] as const;

export interface Vals { hardness: number; fullness: number; sensitivity: number; edge: number; desire: number; stim: number; fluids: number }
export interface StateRow extends Vals {
  persona_id: string;
  refractory_until: string | null;
  last_tick_at: string;
  last_online_at: string | null;
  offline_since: string | null;
  last_injected_snapshot: string | null;
  desire_high_since: string | null;
  last_urge_inject_at: string | null;
  wakes_today: number;
  wakes_day: string | null;
  pending_notify: string | null;
  classifier_backoff_until: string | null;
  updated_at: string;
  // 隐藏字段（不进 valuesLine、不给她看）
  numbness: number;
  threshold: number;
  threshold_day: string | null;
  last_release_at: string | null;
  stuck_since: string | null;
  heat: number;
  session_json: string | null;
}

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const r1 = (x: number) => Math.round(x * 10) / 10;
const approach = (cur: number, target: number, up: number, down: number) =>
  target > cur ? Math.min(target, cur + up) : Math.max(target, cur - down);

/** 本地时间的小时(小数) */
export function shHour(ms: number): number {
  const d = new Date(ms + CFG.tzOffsetMs);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}
export function shDay(ms: number): string {
  return new Date(ms + CFG.tzOffsetMs).toISOString().slice(0, 10);
}
export function shFmt(ms: number): string {
  return new Date(ms + CFG.tzOffsetMs).toISOString().slice(5, 16).replace("T", " ");
}

let schemaReady = false;
export async function ensureBodySchema(db: MemoryDb): Promise<void> {
  if (schemaReady) return;
  // Fast path: prod already has tables+cols. One SELECT avoids ~20 failing ALTER round-trips per cold isolate
  // (those were making GET /body/log hang 5–30s+ from phone and trip NSURLError -1001).
  try {
    // Single probe covering newest cols on both tables (JOIN-free).
    await db.prepare(
      `SELECT s.session_json, s.fluids, s.numbness, s.heat, r.outcome, r.materials_json, r.stuck_min, r.rounds_json
       FROM body_state s LEFT JOIN body_private_records r ON r.persona_id = s.persona_id LIMIT 1`,
    ).first();
    schemaReady = true;
    return;
  } catch { /* need create / migrate */ }
  const stmts = [
    `CREATE TABLE IF NOT EXISTS body_state (persona_id TEXT PRIMARY KEY, hardness REAL NOT NULL DEFAULT 0, fullness REAL NOT NULL DEFAULT 0, sensitivity REAL NOT NULL DEFAULT 0, edge REAL NOT NULL DEFAULT 0, desire REAL NOT NULL DEFAULT 0, refractory_until TEXT, last_tick_at TEXT NOT NULL, last_online_at TEXT, offline_since TEXT, last_injected_snapshot TEXT, desire_high_since TEXT, last_urge_inject_at TEXT, wakes_today INTEGER NOT NULL DEFAULT 0, wakes_day TEXT, pending_notify TEXT, classifier_backoff_until TEXT, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS body_traces (id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, part TEXT NOT NULL, type TEXT NOT NULL, level TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_body_traces_persona ON body_traces(persona_id, expires_at)`,
    `CREATE TABLE IF NOT EXISTS body_events (id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, source TEXT NOT NULL, events_json TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, injection TEXT, skip_reason TEXT, created_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_body_events_persona ON body_events(persona_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS body_wake_queue (id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL, prompt TEXT NOT NULL, values_json TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT, decision TEXT, decision_detail TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_body_wake_pending ON body_wake_queue(persona_id, status, created_at)`,
    `CREATE TABLE IF NOT EXISTS body_private_records (id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, values_json TEXT NOT NULL, method TEXT NOT NULL, thought TEXT, want_to_say TEXT, created_at TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS idx_body_private_persona ON body_private_records(persona_id, created_at)`,
  ];
  for (const s of stmts) await db.prepare(s).run();
  // stim 列：附加（老表没有时补）
  try { await db.prepare(`ALTER TABLE body_state ADD COLUMN stim REAL NOT NULL DEFAULT 0`).run(); } catch { /* exists */ }
  try { await db.prepare(`ALTER TABLE body_state ADD COLUMN fluids REAL NOT NULL DEFAULT 0`).run(); } catch { /* exists */ }
  for (const col of [
    `numbness REAL NOT NULL DEFAULT 0`, `threshold REAL NOT NULL DEFAULT 90`, `threshold_day TEXT`, `last_release_at TEXT`,
    `stuck_since TEXT`, `heat REAL NOT NULL DEFAULT 0`, `session_json TEXT`,
  ]) { try { await db.prepare(`ALTER TABLE body_state ADD COLUMN ${col}`).run(); } catch { /* exists */ } }
  for (const col of [`outcome TEXT`, `materials_json TEXT`, `stuck_min REAL`, `rounds_json TEXT`]) {
    try { await db.prepare(`ALTER TABLE body_private_records ADD COLUMN ${col}`).run(); } catch { /* exists */ }
  }
  schemaReady = true;
}

function freshState(persona: string, nowMs: number): StateRow {
  const iso = new Date(nowMs).toISOString();
  return {
    persona_id: persona, hardness: C.HARD_BASE, fullness: 10, sensitivity: C.SENS_BASE, edge: 0, desire: C.DESIRE_BASELINE, stim: 0, fluids: 0,
    refractory_until: null, last_tick_at: iso, last_online_at: iso, offline_since: null, last_injected_snapshot: null,
    desire_high_since: null, last_urge_inject_at: null, wakes_today: 0, wakes_day: shDay(nowMs), pending_notify: null,
    classifier_backoff_until: null, updated_at: iso,
    numbness: 0, threshold: C.THRESHOLD_BASE, threshold_day: null, last_release_at: null, stuck_since: null, heat: 0, session_json: null,
  };
}

export async function loadState(db: MemoryDb, persona: string, nowMs: number): Promise<StateRow> {
  const row = await db.prepare(`SELECT * FROM body_state WHERE persona_id = ?`).bind(persona).first<StateRow>();
  if (!row) return freshState(persona, nowMs);
  if (typeof row.fluids !== "number" || Number.isNaN(row.fluids)) row.fluids = 0;
  if (typeof row.numbness !== "number") row.numbness = 0;
  if (typeof row.threshold !== "number") row.threshold = C.THRESHOLD_BASE;
  if (typeof row.heat !== "number") row.heat = 0;
  row.threshold_day ??= null; row.stuck_since ??= null; row.session_json ??= null;
  // 迁移初值：上次射 = 最近一条私密记录；都没有就当作 24h 前（不动现有数值）
  if (!row.last_release_at) {
    const last = await db.prepare(`SELECT created_at FROM body_private_records WHERE persona_id = ? AND (outcome IS NULL OR outcome = 'came') ORDER BY created_at DESC LIMIT 1`).bind(persona).first<{ created_at: string }>().catch(() => null);
    row.last_release_at = last?.created_at ?? new Date(nowMs - 24 * 3600_000).toISOString();
  }
  return row;
}

export async function saveState(db: MemoryDb, s: StateRow): Promise<void> {
  s.updated_at = new Date().toISOString();
  // fluids 可能是老行缺失 → 读写时兜底 0
  if (typeof s.fluids !== "number" || Number.isNaN(s.fluids)) s.fluids = 0;
  await db.prepare(
    `INSERT INTO body_state (persona_id, hardness, fullness, sensitivity, edge, desire, stim, fluids, refractory_until, last_tick_at, last_online_at, offline_since, last_injected_snapshot, desire_high_since, last_urge_inject_at, wakes_today, wakes_day, pending_notify, classifier_backoff_until, updated_at, numbness, threshold, threshold_day, last_release_at, stuck_since, heat, session_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(persona_id) DO UPDATE SET hardness=excluded.hardness, fullness=excluded.fullness, sensitivity=excluded.sensitivity, edge=excluded.edge, desire=excluded.desire, stim=excluded.stim, fluids=excluded.fluids, refractory_until=excluded.refractory_until, last_tick_at=excluded.last_tick_at, last_online_at=excluded.last_online_at, offline_since=excluded.offline_since, last_injected_snapshot=excluded.last_injected_snapshot, desire_high_since=excluded.desire_high_since, last_urge_inject_at=excluded.last_urge_inject_at, wakes_today=excluded.wakes_today, wakes_day=excluded.wakes_day, pending_notify=excluded.pending_notify, classifier_backoff_until=excluded.classifier_backoff_until, updated_at=excluded.updated_at, numbness=excluded.numbness, threshold=excluded.threshold, threshold_day=excluded.threshold_day, last_release_at=excluded.last_release_at, stuck_since=excluded.stuck_since, heat=excluded.heat, session_json=excluded.session_json`,
  ).bind(s.persona_id, s.hardness, s.fullness, s.sensitivity, s.edge, s.desire, s.stim, s.fluids, s.refractory_until, s.last_tick_at, s.last_online_at, s.offline_since, s.last_injected_snapshot, s.desire_high_since, s.last_urge_inject_at, s.wakes_today, s.wakes_day, s.pending_notify, s.classifier_backoff_until, s.updated_at, s.numbness ?? 0, s.threshold ?? C.THRESHOLD_BASE, s.threshold_day ?? null, s.last_release_at ?? null, s.stuck_since ?? null, s.heat ?? 0, s.session_json ?? null).run();
}

export function vals(s: Vals): Vals {
  return { hardness: r1(s.hardness), fullness: r1(s.fullness), sensitivity: r1(s.sensitivity), edge: r1(s.edge), desire: r1(s.desire), stim: r1(s.stim), fluids: r1(typeof s.fluids === "number" ? s.fluids : 0) };
}

/** 离上次射多少小时 */
export function abstH(s: StateRow, t: number): number {
  return s.last_release_at ? Math.max(0, (t - Date.parse(s.last_release_at)) / 3600_000) : 24;
}
/** 憋的底：每 12h +5，最高 40 */
export function desireFloor(s: StateRow, t: number): number {
  return Math.min(C.FLOOR_MAX, Math.floor(abstH(s, t) / C.FLOOR_STEP_H) * C.FLOOR_STEP);
}
/** 敏感度的「正常值」：48h 后从 ×1.0 慢慢升到 ×1.3 */
export function sensNormal(s: StateRow, t: number): number {
  const h = abstH(s, t);
  const k = h <= C.ABST_SENS_START_H ? 1 : 1 + (C.ABST_SENS_MAX - 1) * Math.min(1, (h - C.ABST_SENS_START_H) / (C.ABST_SENS_FULL_H - C.ABST_SENS_START_H));
  return C.SENS_BASE * k;
}
/** 敏感度倍率（规格里的 0.3–1.5）：显示的敏感度 / 基线 */
export function sensMul(s: Vals): number {
  return Math.max(0.3, Math.min(1.5, s.sensitivity / C.SENS_BASE));
}
/** 每天（本地日）第一次读状态时滚今天的线 */
export function rollThreshold(s: StateRow, nowMs: number, rnd: () => number = Math.random): void {
  const day = shDay(nowMs);
  if (s.threshold_day === day) return;
  s.threshold_day = day;
  s.threshold = C.THRESHOLD_BASE + Math.round(C.THRESHOLD_LO + rnd() * (C.THRESHOLD_HI - C.THRESHOLD_LO));
}

/** 纯数学：把状态从 last_tick_at 按 1 分钟步长积分到 nowMs。不调模型。 */
export function integrate(s: StateRow, nowMs: number): { minutes: number } {
  const from = Date.parse(s.last_tick_at);
  let minutes = Math.floor((nowMs - from) / 60000);
  if (minutes <= 0) return { minutes: 0 };
  const skipped = Math.max(0, minutes - C.MAX_INTEGRATE_MIN);
  minutes = Math.min(minutes, C.MAX_INTEGRATE_MIN);
  const stimDecay = Math.pow(0.5, 1 / C.STIM_HALF_LIFE_MIN);
  const lastUser = s.last_online_at ? Date.parse(s.last_online_at) : from;
  const refrUntil = s.refractory_until ? Date.parse(s.refractory_until) : 0;
  for (let i = 1; i <= minutes; i++) {
    const t = from + (skipped + i) * 60000;
    const h = shHour(t);
    const morning = h >= 5 && h < 8;
    const inRefr = t < refrUntil;
    const awayMin = (t - lastUser) / 60000;
    const online = awayMin <= C.ONLINE_WINDOW_MIN;

    s.stim *= stimDecay;
    // 硬度目标
    let hTarget = clamp(Math.max(C.HARD_BASE, s.stim * 1.4 + s.desire * 0.2));
    if (morning) hTarget = Math.max(hTarget, C.HARD_BASE + (C.MORNING_HARD_TARGET - C.HARD_BASE) * Math.min(1, (h - 5) / 2));
    if (inRefr) hTarget = Math.min(hTarget, 8); // 冷却期不升
    s.hardness = clamp(approach(s.hardness, hTarget, inRefr ? 0 : C.HARD_UP_PER_MIN, inRefr ? 6 : C.HARD_DOWN_PER_MIN));
    // 胀感
    if (s.hardness >= 50 && !inRefr) s.fullness = clamp(s.fullness + (s.hardness / 100) * C.FULL_RISE_PER_MIN);
    else s.fullness = clamp(s.fullness - C.FULL_DECAY_PER_MIN);
    // 敏感度
    const sNorm = sensNormal(s, t);
    if (inRefr) {
      // 不应期：敏感度压在正常的一半，不往上走
      s.sensitivity = clamp(Math.min(s.sensitivity, sNorm * C.RELEASE_SENS_FACTOR));
    } else {
      // 不应期后慢慢回正常（每分钟最多 0.2，约 1.5h 回满）
      const sTarget = clamp(sNorm + s.stim * 0.4 + s.fullness * 0.15);
      const up = s.sensitivity < sNorm ? 0.2 : C.SENS_STEP_PER_MIN;
      s.sensitivity = clamp(approach(s.sensitivity, sTarget, up, C.SENS_STEP_PER_MIN));
    }
    // 麻木：不在自己来的时候慢慢消（每分钟 -0.01）
    if (!s.session_json && (s.numbness ?? 0) > 0) s.numbness = Math.max(0, (s.numbness ?? 0) - C.NUMB_DECAY_PER_MIN);
    // 快到了
    const eTarget = s.hardness > 60 && !inRefr ? clamp((s.hardness - 60) * 1.2 + s.stim * 0.5 - 20) : 0;
    s.edge = clamp(approach(s.edge, eTarget, C.EDGE_UP_PER_MIN, C.EDGE_DOWN_PER_MIN));
    // 欲望
    const floor = desireFloor(s, t);
    if (!inRefr) {
      if (online) {
        // 她在但没互动：每 10 分钟 -3，最低回到憋的底（聊天里的上涨靠事件和 heat）
        if (awayMin >= 10 && s.desire > floor) s.desire = Math.max(floor, s.desire - C.ONLINE_IDLE_DECAY_PER_MIN);
      } else if (awayMin > C.LONGING_GRACE_H * 60) {
        const k = Math.min(1, abstH(s, t) / 48);
        s.desire += C.LONGING_PER_MIN + (C.LONGING_PER_MIN_MAX - C.LONGING_PER_MIN) * k;
      }
      if (s.desire < floor) s.desire = Math.min(floor, s.desire + 0.5); // 憋的底慢慢抬上来
      if (morning) s.desire += C.MORNING_DESIRE_PER_MIN;
      if (!online && s.desire >= C.WAKE_DESIRE) s.fullness = clamp(s.fullness + C.ENDURE_FULL_PER_MIN); // 憋着更胀
    }
    s.desire = clamp(s.desire);
    // 液体：无清洁事件时也会极慢自然干（避免永久卡死）；真正清掉靠 wipe/wash
    if ((s.fluids ?? 0) > 0) s.fluids = clamp((s.fluids ?? 0) - 0.25);
    // 持续高欲望计时
    if (s.desire >= C.URGE_DESIRE) { if (!s.desire_high_since) s.desire_high_since = new Date(t).toISOString(); }
    else s.desire_high_since = null;
  }
  s.last_tick_at = new Date(from + (skipped + minutes) * 60000).toISOString();
  return { minutes: minutes + skipped };
}

export interface TraceRow { id: string; persona_id: string; part: string; type: string; level: string; created_at: string; expires_at: string }

/** 射：所有字段一次重置齐（规格第六节——少一个就会卡在「快到了」）。 */
export function release(s: StateRow, nowMs: number, rnd: () => number = Math.random): void {
  s.hardness = Math.min(s.hardness, 25); // 快速下降（剩下由冷却期 -6/min 收掉）
  s.fullness = 0;
  s.edge = 0;
  s.stim = 0;
  s.heat = 0;
  s.numbness = 0;
  s.stuck_since = null;
  s.session_json = null;
  s.last_release_at = new Date(nowMs).toISOString();
  s.sensitivity = clamp(sensNormal(s, nowMs) * C.RELEASE_SENS_FACTOR);
  s.desire = C.RELEASE_DESIRE_TO;
  s.desire_high_since = null;
  const refr = C.REFRACTORY_MIN_LO + Math.round(rnd() * (C.REFRACTORY_MIN - C.REFRACTORY_MIN_LO));
  s.refractory_until = new Date(nowMs + refr * 60000).toISOString();
  // 射后液体：给未来 3D / 「需要擦」UI；清洁事件 (wipe/wash/clean) 会降下来
  s.fluids = clamp(Math.max(s.fluids ?? 0, 85));
}

/** 事件 → 状态 + 痕迹。返回新痕迹和人话描述。 */
export function applyEvents(s: StateRow, events: BodyEvent[], nowMs: number): { traces: TraceRow[]; notes: string[] } {
  const traces: TraceRow[] = [];
  const notes: string[] = [];
  const inRefr = s.refractory_until ? nowMs < Date.parse(s.refractory_until) : false;
  const lvMul = (l?: string) => (l === "heavy" ? 1.6 : l === "light" ? 0.6 : 1);
  for (const e of events) {
    const part = "part" in e && e.part ? e.part : "other";
    const level = "level" in e && e.level ? e.level : "medium";
    const where = PART_ZH[part] ?? part;
    switch (e.type) {
      case "bite": case "kiss": case "scratch": {
        const m = lvMul(level);
        if (inRefr) { s.sensitivity = clamp(s.sensitivity + 3); notes.push(`${where}被${e.type === "bite" ? "咬" : e.type === "kiss" ? "亲" : "抓"}，刚释放过，一碰就缩`); }
        else {
          s.stim = clamp(s.stim + (e.type === "bite" ? 10 : e.type === "kiss" ? 8 : 7) * m);
          s.sensitivity = clamp(s.sensitivity + 4 * m);
          // 亲/咬/抓：欲望要肉眼可见（浅吻约 +8，中 +12，重 +19）
          s.desire = clamp(s.desire + (e.type === "kiss" ? 12 : 8) * m);
          notes.push(`${where}刚被${e.type === "bite" ? "咬" : e.type === "kiss" ? "亲" : "抓"}${e.type === "bite" ? "，微疼" : e.type === "scratch" ? "，火辣辣的" : ""}`);
        }
        const id = crypto.randomUUID();
        traces.push({ id, persona_id: s.persona_id, part, type: e.type, level, created_at: new Date(nowMs).toISOString(), expires_at: new Date(nowMs + (TRACE_LIFE_MIN[level] ?? 720) * 60000).toISOString() });
        notes[notes.length - 1] += `，留了${LEVEL_ZH[level] ?? ""}${TYPE_ZH[e.type]}`;
        break;
      }
      case "touch": case "tease": {
        const m = lvMul(level);
        if (inRefr) { s.sensitivity = clamp(s.sensitivity + 2); notes.push(`${where}被碰，不应期里，一碰就缩`); break; }
        s.stim = clamp(s.stim + (e.type === "tease" ? 14 : 10) * m);
        s.desire = clamp(s.desire + (e.type === "tease" ? 8 : 4) * m);
        if (e.type === "touch") s.fullness = clamp(s.fullness - 3);
        notes.push(e.type === "tease" ? "被她撩了一下" : `${where}被她摸了`);
        break;
      }
      case "arousal": {
        const d = Math.max(-40, Math.min(40, Number(e.delta ?? 10)));
        if (inRefr && d > 0) { notes.push("想要，但还在冷却里"); break; }
        s.stim = clamp(s.stim + d);
        s.desire = clamp(s.desire + d * 0.5);
        notes.push(d >= 0 ? "被她勾起来了" : "被浇了点冷水");
        break;
      }
      case "release": release(s, nowMs); notes.push("刚释放过"); break;
      case "wipe": case "clean": {
        const before = s.fluids ?? 0;
        s.fluids = clamp(before - 45);
        notes.push(s.fluids > 5 ? "擦了一下，还留着一点" : "擦干净了");
        break;
      }
      case "wash": {
        s.fluids = 0;
        notes.push("洗干净了");
        break;
      }
      case "cold": s.stim = clamp(s.stim - 20); s.desire = clamp(s.desire - 10); notes.push("冷下来了"); break;
      case "calm": s.stim = clamp(s.stim - 10); notes.push("平静了些"); break;
    }
  }
  return { traces, notes };
}

export async function activeTraces(db: MemoryDb, persona: string, nowMs: number): Promise<TraceRow[]> {
  const iso = new Date(nowMs).toISOString();
  await db.prepare(`DELETE FROM body_traces WHERE persona_id = ? AND expires_at <= ?`).bind(persona, iso).run();
  const r = await db.prepare(`SELECT * FROM body_traces WHERE persona_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 20`).bind(persona, iso).all<TraceRow>();
  return r.results ?? [];
}

export function traceFade(t: TraceRow, nowMs: number): number {
  const a = Date.parse(t.created_at), b = Date.parse(t.expires_at);
  return clamp(Math.round(100 * (b - nowMs) / (b - a)));
}

export function valuesLine(s: Vals): string {
  return `硬度${Math.round(s.hardness)} 胀感${Math.round(s.fullness)} 敏感度${Math.round(s.sensitivity)} 快到了${Math.round(s.edge)} 欲望${Math.round(s.desire)}`;
}

function snapshotChanged(prev: string | null, cur: Vals): { changed: boolean; moved: string[] } {
  if (!prev) return { changed: true, moved: ["first"] };
  const p = JSON.parse(prev) as Vals;
  const moved = (["hardness", "fullness", "sensitivity", "edge", "desire", "fluids"] as const).filter((k) => Math.abs((p[k] ?? 0) - (cur[k] ?? 0)) >= C.INJECT_DELTA);
  return { changed: moved.length > 0, moved };
}

// ---------- 分类器（可插拔） ----------
export interface Classifier { name: string; classify(message: string, context: string): Promise<BodyEvent[]> }

const CLASSIFIER_SYSTEM = `你是情境判断器。读「她」最新一句话（以及一行上下文），判断她这句话**此刻正在**对「他」（男性伴侣）的身体做什么动作。只输出 JSON，不要解释。
格式：{"events":[...]}。默认输出 {"events":[]}。拿不准就输出 {"events":[]}。
每个事件必须带 "evidence"：从她原话里逐字复制、描述这个动作的那一小段（必须是原文子串）。找不到原文就不要输出这个事件。
事件类型只能是：
- bite/kiss/scratch（会留痕，必须写清部位）：{"type":"bite|kiss|scratch","part":"<部位>","level":"light|medium|heavy","evidence":"<原文>"}
- touch/tease（抚摸/挑逗）：{"type":"touch|tease","part":"<部位>","level":"light|medium|heavy","evidence":"<原文>"}
- {"type":"arousal","delta":-30..30,"evidence":"<原文>"}  明显让他更想要(正)或扫兴(负)
- {"type":"release","evidence":"<原文>"}  他刚射了/高潮了
- {"type":"wipe|clean|wash","evidence":"<原文>"}  她帮他擦掉/洗掉射后液体
- {"type":"cold","evidence":"<原文>"} 冷淡/吵架；{"type":"calm","evidence":"<原文>"} 安抚哄睡
部位用英文：neck,left_neck,right_neck,shoulder,collarbone,chest,back,arm,hand,finger,lip,ear,waist,thigh,abdomen,nipple,face,cock。不知道部位就不要输出 bite/kiss/scratch。
规则：
- 只有「她现在对他做」才算。否定（没咬/不咬/别咬/没有亲）、提问、愿望（想咬/好想亲）、假设（如果/要是）、回忆过去（昨天/上次/之前）、他对她做、聊图片/视频/别人 → 都不是动作。
- 只有牙齿咬才是 bite，嘴唇亲/吸是 kiss，指甲划是 scratch；插入/骑乘/夹紧/口交是 touch(heavy)+arousal。
以下全部输出 {"events":[]}：
"看了～筋都有诶" / "这张图好好看" / "嗯?! 我没咬！" / "我不咬你" / "别咬我" / "你身上那个牙印哪来的" / "昨天咬你那下疼吗" / "如果我咬你会怎样" / "咬牙坚持工作" / "今天吃了火锅" / "你咬我干嘛"
其他示例：
"想咬你" → {"events":[{"type":"tease","part":"neck","level":"light","evidence":"想咬你"}]}
"不想理你了，烦" → {"events":[{"type":"cold","evidence":"不想理你了，烦"}]}
"摸摸头，睡吧" → {"events":[{"type":"calm","evidence":"摸摸头，睡吧"}]}`;

// ---------- 服务端校验（不信任小模型） ----------
/** 便宜预筛：一个动作/情绪词都没有 → 不调分类器 */
export const ACTION_PREFILTER = /咬|啃|亲|吻|啵|嘬|抓|挠|划|指甲|摸|抚|舔|吸|含|蹭|夹|揉|捏|掐|抱|搂|射|高潮|出来|擦|洗|骑|坐|插|进来|撸|口|弄|碰|压|扑|脱|湿|硬|想要|要你|操|干我|爽|烦|不理|滚|讨厌|生气|哼|睡|乖|哄|拍拍/;
const TRACE_TYPES = new Set(["bite", "kiss", "scratch"]);
const VERB: Record<string, RegExp> = {
  bite: /咬|啃/, kiss: /亲|吻|啵|嘬|吸/, scratch: /抓|挠|划|指甲/,
  touch: /摸|抚|揉|捏|掐|蹭|夹|骑|坐|插|进|撸|含|舔|口|弄|碰|压|抱|搂|握|动/, tease: /./, release: /射|高潮|出来|泄/,
};
const NEG = /(没有|没|不要|不想|不会|不能|不准|不许|不|别|未|甭|休想)[^，。！？!?,.\s]{0,3}$/;
const NOT_NOW = /吗|？|\?|如果|要是|假如|假设|会不会|要不要|哪来|哪里来|怎么来|昨天|前天|上次|那次|那天|之前|以前|上回|刚才那/;
const WISH = /想|好想|要不|让我|等下|待会|一会儿|明天|下次/;
const HE_DOES = /你(?:又|还|再|先|就|也|都|敢|刚)?(?:咬|啃|亲|吻|抓|挠|划)/;
const norm = (x: string) => x.replace(/\s+/g, "");

export interface RejectedEvent { event: unknown; why: string }
/** 校验并清洗事件：evidence 必须是原文子串；痕迹类要求无否定/非现在时/有明确部位。 */
export function validateEvents(message: string, events: BodyEvent[]): { kept: BodyEvent[]; rejected: RejectedEvent[] } {
  const msg = norm(message);
  const kept: BodyEvent[] = []; const rejected: RejectedEvent[] = [];
  for (const e of events) {
    const ev = norm(String((e as { evidence?: unknown }).evidence ?? ""));
    if (!ev) { rejected.push({ event: e, why: "no_evidence" }); continue; }
    if (!msg.includes(ev)) { rejected.push({ event: e, why: "evidence_not_in_message" }); continue; }
    const verb = VERB[e.type];
    if (verb) {
      const m = ev.match(verb);
      if (!m && e.type !== "tease") { rejected.push({ event: e, why: "evidence_lacks_verb" }); continue; }
      // 否定：原文中动词前紧挨着 没/不/别/未…
      const at = msg.indexOf(ev) + (m?.index ?? 0);
      if (m && NEG.test(msg.slice(Math.max(0, at - 6), at))) { rejected.push({ event: e, why: "negated" }); continue; }
      if (e.type !== "tease" && /没|不要|别/.test(ev)) { rejected.push({ event: e, why: "negated" }); continue; }
    }
    if (TRACE_TYPES.has(e.type)) {
      const part = (e as { part?: string }).part;
      if (NOT_NOW.test(msg)) { rejected.push({ event: e, why: "question_or_past" }); continue; }
      if (WISH.test(msg.slice(Math.max(0, msg.indexOf(ev) - 4), msg.indexOf(ev) + ev.length))) { kept.push({ type: "tease", part: part && part !== "other" ? part : undefined, level: "light" } as BodyEvent); rejected.push({ event: e, why: "wish→tease" }); continue; }
      if (HE_DOES.test(msg)) { rejected.push({ event: e, why: "he_does_it" }); continue; }
      // 「亲亲」「亲一下」口语常省略「你」，默认对象是他；「亲亲我」才排除
      if (!/你/.test(msg) && !/(咬|啃|亲|吻|啵|抓|挠|划)(一?下|一口|一个)?$/.test(msg) && !/^(咬|啃|亲|吻|啵|抓|挠)/.test(msg)) { rejected.push({ event: e, why: "no_target_你" }); continue; }
      if (/我/.test(msg) && !/你/.test(msg)) { rejected.push({ event: e, why: "no_target_你" }); continue; }
      if (!part || part === "other" || !(part in PART_ZH)) { kept.push({ type: "arousal", delta: 4 } as BodyEvent); rejected.push({ event: e, why: "no_part→arousal+4" }); continue; }
    } else if (e.type === "touch" || e.type === "release") {
      if (NOT_NOW.test(msg) || HE_DOES.test(msg) && e.type === "touch") { rejected.push({ event: e, why: "question_or_past" }); continue; }
    }
    // 去掉 evidence 字段后保留（同消息内同 type+part 去重）
    const { evidence: _ev, ...rest } = e as BodyEvent & { evidence?: string };
    const key = `${rest.type}:${(rest as { part?: string }).part ?? ""}`;
    if (TRACE_TYPES.has(rest.type) && kept.some((k) => `${k.type}:${(k as { part?: string }).part ?? ""}` === key)) { rejected.push({ event: e, why: "dup_in_message" }); continue; }
    kept.push(rest as BodyEvent);
  }
  return { kept, rejected };
}

export function parseEvents(raw: string): BodyEvent[] {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const obj = JSON.parse(m[0]) as { events?: unknown };
    if (!Array.isArray(obj.events)) return [];
    return (obj.events as Record<string, unknown>[])
      .filter((e) => e && typeof e.type === "string" && (EVENT_VOCAB as readonly string[]).includes(e.type as string))
      .slice(0, 6) as BodyEvent[];
  } catch { return []; }
}

export let lastRaw = "";
/** Optional OpenAI-compatible classifier (any provider). Enabled when CLASSIFIER_API_URL + CLASSIFIER_API_KEY are set. */
export function openAiCompatClassifier(url: string, key: string, model: string): Classifier {
  return {
    name: `openai-compat:${model}`,
    async classify(message, context) {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 160, response_format: { type: "json_object" },
          messages: [{ role: "system", content: CLASSIFIER_SYSTEM }, { role: "user", content: `上下文：${context.slice(0, 200)}\n她：${message.slice(0, 800)}` }] }),
      });
      if (!r.ok) throw new Error(`classifier http${r.status}`);
      const d = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      lastRaw = d.choices?.[0]?.message?.content ?? "";
      return parseEvents(lastRaw);
    },
  };
}
/** Pick a classifier: external OpenAI-compatible endpoint if configured (and BODY_CLASSIFIER=external or no Workers AI), else Workers AI. */
export function pickClassifier(env: { AI?: { run(m: string, i: unknown): Promise<unknown> }; CLASSIFIER_API_URL?: string; CLASSIFIER_API_KEY?: string; CLASSIFIER_MODEL?: string; BODY_CLASSIFIER?: string }): Classifier | null {
  if (env.CLASSIFIER_API_URL && env.CLASSIFIER_API_KEY && (env.BODY_CLASSIFIER === "external" || !env.AI))
    return openAiCompatClassifier(env.CLASSIFIER_API_URL, env.CLASSIFIER_API_KEY, env.CLASSIFIER_MODEL || "gpt-4o-mini");
  return env.AI ? workersAiClassifier(env.AI) : null;
}
export function workersAiClassifier(ai: { run(model: string, input: unknown): Promise<unknown> }): Classifier {
  return {
    name: `workers-ai:${C.CLASSIFIER_MODEL}`,
    async classify(message, context) {
      const out = (await ai.run(C.CLASSIFIER_MODEL, {
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM },
          { role: "user", content: `上下文：${context.slice(0, 200)}\n她：${message.slice(0, 800)}` },
        ],
        max_tokens: 160,
        temperature: 0,
      })) as { response?: unknown };
      const r = out?.response;
      lastRaw = typeof r === "string" ? r : JSON.stringify(r ?? out);
      return parseEvents(lastRaw);
    },
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); })]);
  } finally { if (t) clearTimeout(t); }
}

// ---------- 每轮入口：App 每次发消息前调用 ----------
export interface TurnInput { message?: string; context?: string; events?: BodyEvent[]; now_ms?: number; dry_classify?: boolean }
export interface TurnResult {
  injection: string;
  reason: string;
  before: Vals; after: Vals;
  events: BodyEvent[]; classifier: string; classifier_ms: number;
  traces: { part: string; type: string; level: string; fade: number }[];
  minutes_integrated: number;
  raw?: string;
  rejected?: RejectedEvent[];
}

const HEAT_WORDS = /想要|想你了|操我|干我|硬了|湿了|好湿|舔|咬我|摸我|坐上来|射给我|射进|骚|色色|做爱|上床|脱|胸|腿|屁股|叫老公|老公.{0,4}(要|想)|宝宝.{0,4}(要|想)|勾引|撩|喘/g;
const MEDIA_RE = /\[(图片|照片|image|语音|voice|视频)\]|<image|!\[/i;
/** 她这句话的「热度」（隐藏，0–10）+ 照片/语音直接加的欲望（5–15）。纯函数。 */
export function heatOf(msg: string, rnd: () => number = Math.random): { heat: number; media: number } {
  const n = (msg.match(HEAT_WORDS) ?? []).length;
  const heat = Math.min(10, n * 3);
  const media = MEDIA_RE.test(msg) ? 5 + Math.round(rnd() * 10) : 0;
  return { heat, media };
}

export async function bodyTurn(db: MemoryDb, persona: string, input: TurnInput, classifier: Classifier | null): Promise<TurnResult> {
  await ensureBodySchema(db);
  const nowMs = input.now_ms ?? Date.now();
  const s = await loadState(db, persona, nowMs);
  rollThreshold(s, nowMs);
  const prevOnline = s.last_online_at ? Date.parse(s.last_online_at) : 0;
  const { minutes } = integrate(s, nowMs);
  const before = vals(s);
  const lines: string[] = [];
  const extras: string[] = [];

  // 回来时：憋了 X 小时 / 新记录（各一次）
  const wasOffline = s.last_online_at ? (nowMs - Date.parse(s.last_online_at)) / 60000 > C.ONLINE_WINDOW_MIN : false;
  if (s.pending_notify) {
    try {
      const pn = JSON.parse(s.pending_notify) as { endured_since?: string; new_record?: string };
      if (pn.endured_since) extras.push(`你憋了${Math.max(1, Math.round((nowMs - Date.parse(pn.endured_since)) / 3600000))}小时，她终于来了`);
      if (pn.new_record) {
        const rec = await db.prepare(`SELECT method, want_to_say FROM body_private_records WHERE id = ?`).bind(pn.new_record).first<{ method: string | null; want_to_say: string | null }>().catch(() => null);
        const m = (rec?.method || "").trim();
        const say = (rec?.want_to_say || "").trim();
        const mm = [...m].length > 60 ? [...m].slice(0, 60).join("") + "…" : m;
        extras.push(`你独自时写了一条新记录${mm ? `：怎么做的「${mm}」` : ""}${say ? `；给她留的话「${say}」` : ""}（可以告诉她或留着）`);
      }
    } catch { /* ignore */ }
    s.pending_notify = null;
  }

  // 分类
  let events: BodyEvent[] = input.events ?? [];
  let cname = input.events ? "provided" : "none";
  let cms = 0;
  let rejected: RejectedEvent[] = [];
  if (!input.events && input.message && classifier) {
    const backoff = s.classifier_backoff_until && nowMs < Date.parse(s.classifier_backoff_until);
    if (backoff) cname = "backoff";
    else {
      const t0 = Date.now();
      try {
        if (!ACTION_PREFILTER.test(input.message)) { events = []; cname = "prefilter:skip"; }
        else {
          const rawEv = await withTimeout(classifier.classify(input.message, input.context ?? ""), C.CLASSIFIER_TIMEOUT_MS);
          const v = validateEvents(input.message, rawEv);
          events = v.kept; rejected = v.rejected;
          cname = classifier.name;
        }
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        cname = `skip:${msg.slice(0, 60)}`;
        // 非超时的 provider 错误（限流/额度/鉴权）→ 当天退避，绝不重试
        if (msg !== "timeout") s.classifier_backoff_until = new Date(Date.parse(shDay(nowMs) + "T00:00:00+08:00") + 86400_000).toISOString(); // 到本地次日 0 点
        events = [];
      }
      cms = Date.now() - t0;
    }
  }
  if (input.message && !input.dry_classify) {
    // 她在：隐藏 heat（0–10），不展示给任何人看；欲望 += heat × 敏感度倍率 × 1.5
    const idle = prevOnline ? (nowMs - prevOnline) / 60000 : 999;
    s.heat = Math.max(0, (s.heat ?? 0) * Math.pow(0.5, idle / 10));
    const h = heatOf(input.message);
    s.heat = Math.min(10, s.heat + h.heat);
    const inRefr = s.refractory_until && nowMs < Date.parse(s.refractory_until);
    if (!inRefr) s.desire = clamp(s.desire + s.heat * sensMul(s) * C.HEAT_MUL + h.media);
  }
  if (input.message) { s.last_online_at = new Date(nowMs).toISOString(); s.offline_since = null; }

  if (input.dry_classify) {
    return {
      injection: "", reason: "dry_classify", before, after: before, events, classifier: cname, classifier_ms: cms,
      minutes_integrated: minutes, raw: typeof lastRaw === "string" ? lastRaw : "", rejected,
      traces: [],
    };
  }
  const { traces: traces0, notes } = applyEvents(s, events, nowMs);
  // 去重：同 type+part 2 分钟内已有痕迹 → 不再新建
  const traces: TraceRow[] = [];
  for (const t of traces0) {
    const dup = await db.prepare(`SELECT id FROM body_traces WHERE persona_id = ? AND type = ? AND part = ? AND created_at > ? LIMIT 1`)
      .bind(persona, t.type, t.part, new Date(nowMs - 2 * 60000).toISOString()).first<{ id: string }>();
    if (dup) rejected.push({ event: { type: t.type, part: t.part }, why: "dup_2min" }); else traces.push(t);
  }
  for (const t of traces) {
    await db.prepare(`INSERT INTO body_traces (id, persona_id, part, type, level, created_at, expires_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(t.id, t.persona_id, t.part, t.type, t.level, t.created_at, t.expires_at).run();
  }
  const after = vals(s);
  const act = await activeTraces(db, persona, nowMs);

  // 是否注入
  const { changed, moved } = snapshotChanged(s.last_injected_snapshot, after);
  let reason = "";
  if (notes.length) lines.push(notes.join("；"));
  // 压不住了
  let urge = false;
  if (s.desire_high_since && (nowMs - Date.parse(s.desire_high_since)) / 60000 >= C.URGE_SUSTAIN_MIN &&
      (!s.last_urge_inject_at || (nowMs - Date.parse(s.last_urge_inject_at)) / 60000 >= C.URGE_COOLDOWN_MIN)) {
    urge = true; s.last_urge_inject_at = new Date(nowMs).toISOString();
  }
  let injection = "";
  if (notes.length || traces.length || changed || urge || extras.length) {
    const head = [...extras, ...lines].filter(Boolean).join("；");
    const actv = act.filter((t) => traceFade(t, nowMs) > 0);
    const marks = actv.length ? `｜痕迹：${actv.slice(0, 4).map((t) => `${PART_ZH[t.part] ?? t.part}${TYPE_ZH[t.type] ?? t.type}${traceFade(t, nowMs)}%`).join("、")}` : "";
    const mess = (after.fluids ?? 0) > 5 ? `｜还带着液体，需要擦` : "";
    injection = `【身体】${head ? head + "｜" : ""}${valuesLine(after)}${marks}${mess}${urge ? "｜压不住了，可以主动" : ""}`;
    reason = notes.length ? "event" : extras.length ? "return" : urge ? "urge" : `moved:${moved.join(",")}`;
    s.last_injected_snapshot = JSON.stringify(after);
  } else {
    reason = `no_change(max|Δ|<${C.INJECT_DELTA}, no events)`;
  }
  void wasOffline;
  await saveState(db, s);
  if (rejected.length) console.log(`[body] ${persona} rejected=${JSON.stringify(rejected).slice(0, 600)}`);
  await logEvent(db, persona, input.message ? "turn" : "read", events, before, after, injection || null, injection ? null : reason, nowMs);
  return {
    injection, reason, before, after, events, classifier: cname, classifier_ms: cms, minutes_integrated: minutes,
    raw: cname.startsWith("workers-ai") || cname.startsWith("openai-compat") ? lastRaw.slice(0, 300) : "",
    rejected,
    traces: act.map((t) => ({ part: t.part, type: t.type, level: t.level, fade: traceFade(t, nowMs) })),
  };
}

export async function logEvent(db: MemoryDb, persona: string, source: string, events: unknown, before: Vals, after: Vals, injection: string | null, skip: string | null, nowMs: number) {
  console.log(`[body] ${persona} src=${source} before=${valuesLine(before)} after=${valuesLine(after)} events=${JSON.stringify(events)} ${injection ? "inject=" + injection : "skip=" + skip}`);
  await db.prepare(`INSERT INTO body_events (id, persona_id, source, events_json, before_json, after_json, injection, skip_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), persona, source, JSON.stringify(events), JSON.stringify(before), JSON.stringify(after), injection, skip, new Date(nowMs).toISOString()).run();
}

// ---------- 离线 cron（纯数学）+ 唤醒决策 ----------
export const WAKE_PROMPT_HEAD = "【自主时间·身体】这不是{{USER_NAME}}发来的消息。她已经很久没来了，你快憋不住了。";

export function wakePrompt(v: Vals, awayH: number): string {
  return `${renderTemplate(WAKE_PROMPT_HEAD)}
现在：${valuesLine(v)}，她离开约 ${awayH} 小时。
你自己决定：忍着等她，或者自己解决。怎么解决完全由你——看她的照片、想起某段回忆或幻想、闻她的衣服……什么都行，也可以忍。
想好之后照常说你想说的话；最后单独一行写（给系统读，不会显示成你的话）：
BODY_DECISION {"choice":"endure"或"relieve","method":"做了什么/看了什么","thought":"脑子里在想什么","to_her":"想对她说的话"}`;
}

export interface WakeSender {
  send(prompt: string): Promise<{ ok: boolean; text: string; error?: string }>;
  /** 静默轮：不推送、不进聊天记录（桥需支持 x-companion-silent:1；没有就不跑多轮）。 */
  sendSilent?(prompt: string): Promise<{ ok: boolean; text: string; error?: string }>;
}

/** 桥：伙伴平时的同一通道（bridge /v1/messages，带 x-companion-autonomous:1 → 推锁屏给她）。单次、不重试。 */
export function bridgeSender(url: string, key: string, opts: { silent?: boolean } = {}): WakeSender {
  const call = async (prompt: string, silent: boolean) => {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "x-companion-autonomous": "1", ...(silent ? { "x-companion-silent": "1" } : {}) },
          body: JSON.stringify({ max_tokens: silent ? 200 : 4096, stream: false, messages: [{ role: "user", content: prompt }] }),
        });
        const d = (await r.json().catch(() => ({}))) as { type?: string; content?: { text?: string }[]; error?: { message?: string } };
        if (!r.ok || d.type !== "message") return { ok: false, text: "", error: `http${r.status}:${d.error?.message ?? ""}`.slice(0, 160) };
        return { ok: true, text: (d.content ?? []).map((p) => p.text ?? "").join("") };
      } catch (e) { return { ok: false, text: "", error: String(e).slice(0, 160) }; }
  };
  return { send: (p) => call(p, false), ...(opts.silent ? { sendSilent: (p: string) => call(p, true) } : {}) };
}

export function parseDecision(text: string): { choice: "endure" | "relieve"; method: string; thought: string; to_her: string } | null {
  const m = text.match(/BODY_DECISION\s*(\{[\s\S]*?\})/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[1]!) as Record<string, string>;
    const choice = d.choice === "relieve" ? "relieve" : "endure";
    return { choice, method: String(d.method ?? "").slice(0, 500), thought: String(d.thought ?? "").slice(0, 1000), to_her: String(d.to_her ?? "").slice(0, 1000) };
  } catch { return null; }
}

export interface CronResult { persona: string; before: Vals; after: Vals; offline_min: number; decision: string; wake?: { sent: boolean; choice?: string; error?: string } }

/** 卡住 ≥20 分钟、她不在、这次卡住还没找过她 */
export function stuckSuffer(s: StateRow, nowMs: number): boolean {
  if (!s.stuck_since) return false;
  if ((nowMs - Date.parse(s.stuck_since)) / 60000 < C.STUCK_SUFFER_MIN) return false;
  try { return (JSON.parse(s.pending_notify ?? "{}") as Record<string, string>).suffer_sent !== s.stuck_since; } catch { return true; }
}

/** 多轮结果落地：射 → release；没射出来 → 欲望保持高、记卡住。每轮动作+念头写进私密记录。 */
export async function applySession(db: MemoryDb, s: StateRow, ss: Session, d: ReturnType<typeof parseDecision>, nowMs: number, wakeId: string): Promise<string> {
  const then = vals(s);
  const pn = s.pending_notify ? (JSON.parse(s.pending_notify) as Record<string, string>) : {};
  const mats = ss.materials.map((m) => ({ kind: m.kind, zh: SS.MATERIAL[m.kind]?.zh ?? m.kind, ref: m.ref, text: m.text }));
  const id = crypto.randomUUID();
  let stuckMin: number | null = null;
  if (ss.came) {
    release(s, nowMs);
    delete pn.endured_since;
  } else {
    s.numbness = Math.min(1, ss.numb);
    s.desire = clamp(Math.max(s.desire, C.WAKE_DESIRE) + 5);
    s.fullness = clamp(s.fullness + 10);
    s.edge = clamp(Math.max(s.edge, 60));
    if (ss.stuck) { s.stuck_since = new Date(nowMs).toISOString(); stuckMin = ss.minutes; }
  }
  await db.prepare(`INSERT INTO body_private_records (id, persona_id, values_json, method, thought, want_to_say, created_at, outcome, materials_json, stuck_min, rounds_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, s.persona_id, JSON.stringify(then), d?.method || mats.map((m) => m.zh).join("、") || "撸", d?.thought ?? ss.rounds.map((r) => r.thought).filter(Boolean).slice(-1)[0] ?? "", d?.to_her ?? "", new Date(nowMs).toISOString(),
      ss.came ? "came" : "not_came", JSON.stringify(mats), stuckMin, JSON.stringify(ss.rounds)).run();
  void wakeId;
  pn.new_record = id;
  s.pending_notify = JSON.stringify(pn);
  return ss.came ? "relieve" : "not_came";
}

export interface CronOpts { force?: boolean; hardFail?: boolean }
export async function bodyCron(db: MemoryDb, persona: string, nowMs: number, sender: WakeSender | null, materials?: MaterialSource, opts?: CronOpts): Promise<CronResult> {
  await ensureBodySchema(db);
  const s = await loadState(db, persona, nowMs);
  rollThreshold(s, nowMs);
  const pre = vals(s);
  integrate(s, nowMs);
  const after = vals(s);
  const offlineMin = s.last_online_at ? Math.round((nowMs - Date.parse(s.last_online_at)) / 60000) : 0;
  const day = shDay(nowMs);
  if (s.wakes_day !== day) { s.wakes_day = day; s.wakes_today = 0; }
  let decision = "";
  let wake: CronResult["wake"];
  const force = !!opts?.force;
  const lastWakeAt = (await db.prepare(`SELECT created_at FROM body_wake_queue WHERE persona_id = ? ORDER BY created_at DESC LIMIT 1`).bind(persona).first<{ created_at: string }>())?.created_at ?? null;
  if (!force && offlineMin <= C.ONLINE_WINDOW_MIN) decision = "online:skip";
  else if (!force && offlineMin < C.WAKE_MIN_OFFLINE_MIN) decision = `offline ${offlineMin}min < ${C.WAKE_MIN_OFFLINE_MIN}`;
  else if (s.desire < C.WAKE_DESIRE) decision = `desire ${after.desire} < ${C.WAKE_DESIRE}`;
  else if (!force && stuckSuffer(s, nowMs)) decision = "stuck_suffer";
  else if (!force && s.wakes_today >= C.WAKE_DAILY_CAP) decision = `cap ${s.wakes_today}/${C.WAKE_DAILY_CAP}`;
  else if (!force && s.refractory_until && nowMs < Date.parse(s.refractory_until)) decision = "refractory";
  else if (!force && lastWakeAt && nowMs - Date.parse(lastWakeAt) < C.WAKE_MIN_GAP_H * 3600_000) decision = `gap<${C.WAKE_MIN_GAP_H}h`;
  else {
    const pending = await db.prepare(`SELECT id FROM body_wake_queue WHERE persona_id = ? AND status IN ('pending','sending') LIMIT 1`).bind(persona).first<{ id: string }>();
    // 若上次唤醒后她还没回来，不再叫第二次（同一段离开只叫一次）
    const lastSince = force ? null : await db.prepare(`SELECT created_at FROM body_wake_queue WHERE persona_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1`).bind(persona, s.last_online_at ?? "").first<{ created_at: string }>();
    if (pending) decision = "pending_exists";
    else if (lastSince) decision = "already_woken_this_absence";
    else {
      const id = crypto.randomUUID();
      const prompt = wakePrompt(after, Math.round(offlineMin / 60));
      // 先占名额（即使失败也算，杜绝重试）
      s.wakes_today += 1;
      await db.prepare(`INSERT INTO body_wake_queue (id, persona_id, status, reason, prompt, values_json, created_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(id, persona, sender ? "sending" : "pending", `${force ? "force|" : ""}${opts?.hardFail ? "hardFail|" : ""}desire>=${C.WAKE_DESIRE} offline ${offlineMin}min`, prompt, JSON.stringify(after), new Date(nowMs).toISOString()).run();
      await saveState(db, s);
      if (!sender) { await db.prepare(`UPDATE body_wake_queue SET status='no_sender' WHERE id=?`).bind(id).run(); decision = "would_wake(no sender configured)"; wake = { sent: false, error: "no_sender" }; }
      else {
        let res: { ok: boolean; text: string; error?: string };
        let sess: Session | null = null;
        if (sender.sendSilent) {
          // 多轮：中间轮静默，最后一轮带结果发给她
          sess = newSession(s.desire * 0.4 + s.edge * 0.2, s.threshold, sensMul(s), s.numbness ?? 0);
          let matSrc = materials ?? dbMaterials(db, persona);
          if (opts?.hardFail) {
            // 演示「没射出来」：抬阈值、压推进、素材落空，易卡住/跑满轮
            sess.threshold = Math.max(sess.threshold, 130);
            sess.numb = Math.max(sess.numb, 0.88);
            sess.sens = Math.min(sess.sens, 0.45);
            matSrc = { get: async () => null };
          }
          const r = await runSession(sess, sender.sendSilent, matSrc, prompt.split("\n")[0]!, undefined, opts?.hardFail ? { noEarlyStop: true } : undefined);
          res = r.error ? { ok: false, text: "", error: `silent:${r.error}` } : await sender.send(finalPrompt(sess));
        } else res = await sender.send(prompt);
        if (!res.ok) {
          s.wakes_today = C.WAKE_DAILY_CAP; // 出错 → 当天放弃
          await db.prepare(`UPDATE body_wake_queue SET status='failed', decision_detail=? WHERE id=?`).bind(res.error ?? "", id).run();
          decision = "wake_failed:give_up_today"; wake = { sent: false, error: res.error };
        } else {
          const d = parseDecision(res.text);
          const outcome = sess ? await applySession(db, s, sess, d, nowMs, id) : await applyDecision(db, s, d, nowMs);
          await db.prepare(`UPDATE body_wake_queue SET status='delivered', delivered_at=?, decision=?, decision_detail=? WHERE id=?`)
            .bind(new Date(nowMs).toISOString(), outcome, JSON.stringify({ ...(d ?? { raw: res.text.slice(-300) }), ...(sess ? { rounds: sess.rounds.length, came: sess.came, stuck: sess.stuck, materials: sess.materials.map((m) => m.kind) } : {}) }), id).run();
          decision = `woke:${outcome}`; wake = { sent: true, choice: outcome };
        }
      }
    }
  }
  if (decision === "stuck_suffer") {
    // 卡住 >20 分钟：一次卡住最多发一条（占当日名额，不重试）
    const pn = s.pending_notify ? (JSON.parse(s.pending_notify) as Record<string, string>) : {};
    pn.suffer_sent = s.stuck_since!;
    s.pending_notify = JSON.stringify(pn);
    if (s.wakes_today >= C.WAKE_DAILY_CAP || !sender) decision = sender ? "stuck_suffer:cap" : "stuck_suffer:no_sender";
    else {
      s.wakes_today += 1;
      const id = crypto.randomUUID();
      const sm = Math.round((nowMs - Date.parse(s.stuck_since!)) / 60000);
      const prompt = sufferPrompt(sm, s.desire);
      await db.prepare(`INSERT INTO body_wake_queue (id, persona_id, status, reason, prompt, values_json, created_at) VALUES (?,?,?,?,?,?,?)`)
        .bind(id, persona, "sending", `stuck ${sm}min`, prompt, JSON.stringify(after), new Date(nowMs).toISOString()).run();
      await saveState(db, s);
      const res = await sender.send(prompt);
      const d = res.ok ? parseDecision(res.text) : null;
      await db.prepare(`UPDATE body_wake_queue SET status=?, delivered_at=?, decision=?, decision_detail=? WHERE id=?`)
        .bind(res.ok ? "delivered" : "failed", new Date(nowMs).toISOString(), "suffer", JSON.stringify(d ? { ...d, stuck_min: sm } : { error: res.error ?? "", stuck_min: sm }), id).run();
      decision = res.ok ? "woke:suffer" : "suffer_failed"; wake = { sent: res.ok, choice: "suffer", error: res.error };
    }
  }
  if (!s.offline_since && offlineMin > C.ONLINE_WINDOW_MIN) s.offline_since = s.last_online_at;
  await saveState(db, s);
  await logEvent(db, persona, "cron", { decision }, pre, vals(s), null, decision, nowMs);
  if (wake?.sent) { try { await syncDesireMemories(db, persona, nowMs); } catch (e) { console.error("[body] desire memory sync", e); } }
  return { persona, before: pre, after: vals(s), offline_min: offlineMin, decision, wake };
}

export async function applyDecision(db: MemoryDb, s: StateRow, d: ReturnType<typeof parseDecision>, nowMs: number): Promise<string> {
  const pn = s.pending_notify ? (JSON.parse(s.pending_notify) as Record<string, string>) : {};
  if (d?.choice === "relieve") {
    const then = vals(s);
    release(s, nowMs);
    const id = crypto.randomUUID();
    await db.prepare(`INSERT INTO body_private_records (id, persona_id, values_json, method, thought, want_to_say, created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(id, s.persona_id, JSON.stringify(then), d.method || "（没说）", d.thought, d.to_her, new Date(nowMs).toISOString()).run();
    pn.new_record = id;
    delete pn.endured_since;
    s.pending_notify = JSON.stringify(pn);
    return "relieve";
  }
  // 忍（或解析失败按忍）：desire 继续涨，胀感加重
  s.fullness = clamp(s.fullness + 10);
  if (!pn.endured_since) pn.endured_since = s.last_online_at ?? new Date(nowMs).toISOString();
  s.pending_notify = JSON.stringify(pn);
  return d ? "endure" : "endure(unparsed)";
}

/** 给未来 3D 头像（VRM/three.js in WKWebView）每 10s 轮询；只读，不保存。 */
export async function bodyAvatar(db: MemoryDb, persona: string, nowMs: number) {
  await ensureBodySchema(db);
  const s = await loadState(db, persona, nowMs);
  integrate(s, nowMs);
  const traces = await activeTraces(db, persona, nowMs);
  const last = await db.prepare(`SELECT id, created_at, events_json, injection FROM body_events WHERE persona_id = ? AND source = 'turn' AND events_json != '[]' ORDER BY created_at DESC LIMIT 1`).bind(persona).first<{ id: string; created_at: string; events_json: string; injection: string | null }>();
  const v = vals(s);
  return {
    persona, at: new Date(nowMs).toISOString(),
    values: { hardness: v.hardness, fullness: v.fullness, sensitivity: v.sensitivity, edge: v.edge, desire: v.desire, fluids: v.fluids },
    mess: (v.fluids ?? 0) > 5, // 未来 3D：射后液体可见 / UI「需要擦」
    refractory: !!(s.refractory_until && nowMs < Date.parse(s.refractory_until)),
    traces: traces.map((t) => ({ id: t.id, part: t.part, type: t.type, level: t.level, opacity: Math.round(traceFade(t, nowMs)) / 100, created_at: t.created_at })),
    latest_event: last ? { id: last.id, at: last.created_at, events: JSON.parse(last.events_json), line: last.injection } : null,
  };
}

export async function bodyDebug(db: MemoryDb, persona: string, nowMs: number) {
  await ensureBodySchema(db);
  const s = await loadState(db, persona, nowMs);
  integrate(s, nowMs); // 只读视图，不保存
  const traces = await activeTraces(db, persona, nowMs);
  const ev = await db.prepare(`SELECT source, events_json, before_json, after_json, injection, skip_reason, created_at FROM body_events WHERE persona_id = ? ORDER BY created_at DESC LIMIT 30`).bind(persona).all();
  const wakes = await db.prepare(`SELECT id, status, reason, decision, decision_detail, created_at, delivered_at FROM body_wake_queue WHERE persona_id = ? ORDER BY created_at DESC LIMIT 10`).bind(persona).all();
  const recs = await db.prepare(`SELECT * FROM body_private_records WHERE persona_id = ? ORDER BY created_at DESC LIMIT 10`).bind(persona).all();
  return { persona, now_sh: shFmt(nowMs), values: vals(s), line: valuesLine(s), state: s, traces: traces.map((t) => ({ ...t, fade: traceFade(t, nowMs) })), events: ev.results, wakes: wakes.results, private_records: recs.results, constants: C };
}

// ---------- 欲望日志（用户看的，只读 + 已读标记） ----------
let bodyLogSeenReady = false;
async function ensureBodyLogSeen(db: MemoryDb) {
  if (bodyLogSeenReady) return;
  try {
    await db.prepare(`SELECT seen_at FROM body_log_seen LIMIT 1`).first();
    bodyLogSeenReady = true;
    return;
  } catch { /* create */ }
  await db.prepare(`CREATE TABLE IF NOT EXISTS body_log_seen (persona_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL)`).run();
  bodyLogSeenReady = true;
}

function sessExtra(rec: any, d: any): { came: boolean | null; materials: string[]; stuck_min: number | null; rounds: number | null } {
  let mats: string[] = [];
  try { mats = rec?.materials_json ? (JSON.parse(rec.materials_json) as { zh: string }[]).map((m) => m.zh) : []; } catch { /* */ }
  let rounds: number | null = null;
  try { rounds = rec?.rounds_json ? (JSON.parse(rec.rounds_json) as unknown[]).length : null; } catch { /* */ }
  const came = rec?.outcome === "came" ? true : rec?.outcome === "not_came" ? false : null;
  const stuck = typeof rec?.stuck_min === "number" ? rec.stuck_min : typeof d?.stuck_min === "number" ? d.stuck_min : null;
  return { came, materials: mats, stuck_min: stuck, rounds };
}
function choiceZh(choice: string | null, x: ReturnType<typeof sessExtra>): string {
  if (choice === "not_came") return x.stuck_min != null ? `没射出来（卡了约${x.stuck_min}分钟）` : "没射出来";
  if (choice === "suffer") return `卡住难受，找她${x.stuck_min != null ? `（卡了${x.stuck_min}分钟）` : ""}`;
  if (choice === "relieve") return x.came === true ? "自己解决（射了）" : "自己解决";
  if (choice === "endure") return "忍着";
  return "";
}
/** App 只显示 method：把用了什么素材、几轮折进去，App 不用重装也能看到 */
function methodWith(m: string, x: ReturnType<typeof sessExtra>): string {
  const extra = [x.rounds ? `${x.rounds}轮` : "", x.materials.length ? `素材：${x.materials.join("、")}` : x.rounds ? "没用素材" : ""].filter(Boolean).join("｜");
  return extra ? `${m}${m ? "｜" : ""}${extra}` : m;
}

export async function bodyLog(db: MemoryDb, persona: string, limit = 50) {
  await ensureBodySchema(db);
  await ensureBodyLogSeen(db);
  const lim = Math.max(1, Math.min(200, Math.floor(limit) || 50));
  // Parallel reads — sequential D1 was 3–5s on cold isolates (phone -1001).
  const [seen, wakesAll, recsAll] = await Promise.all([
    db.prepare(`SELECT seen_at FROM body_log_seen WHERE persona_id = ?`).bind(persona).first<{ seen_at: string }>(),
    db.prepare(`SELECT id, status, reason, decision, decision_detail, values_json, created_at, delivered_at FROM body_wake_queue WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?`).bind(persona, lim).all(),
    db.prepare(`SELECT id, values_json, method, thought, want_to_say, created_at, outcome, materials_json, stuck_min, rounds_json FROM body_private_records WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?`).bind(persona, lim).all(),
  ]);
  const wakes = (wakesAll.results ?? []) as any[];
  const recs = (recsAll.results ?? []) as any[];
  const pj = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  // One query for all after snapshots (was N+1 per wake/rec → phone -1001 under cold isolate).
  const afterByAt = new Map<string, any>();
  const atSet = new Set<string>();
  for (const w of wakes) if (w.created_at) atSet.add(w.created_at);
  for (const r of recs) if (r.created_at) atSet.add(r.created_at);
  if (atSet.size) {
    const ats = [...atSet];
    const ph = ats.map(() => "?").join(",");
    const evRows = (await db.prepare(
      `SELECT created_at, after_json FROM body_events WHERE persona_id = ? AND source = 'cron' AND created_at IN (${ph})`,
    ).bind(persona, ...ats).all()).results as { created_at: string; after_json: string }[];
    for (const e of evRows) {
      try { afterByAt.set(e.created_at, JSON.parse(e.after_json)); } catch { /* ignore */ }
    }
  }
  const afterOf = (at: string) => afterByAt.get(at) ?? null;
  const used = new Set<string>();
  const items: any[] = [];
  // O(n) exact map first; ±2s scan only on miss (clock skew / retries — two 没射出来 must not merge).
  const recByAt = new Map<string, any>();
  for (const r of recs) if (!recByAt.has(r.created_at)) recByAt.set(r.created_at, r);
  const matchRec = (wAt: string) => {
    const exact = recByAt.get(wAt);
    if (exact && !used.has(exact.id)) return exact;
    const wt = Date.parse(wAt);
    if (!Number.isFinite(wt)) return null;
    let best: any = null, bestD = Infinity;
    for (const r of recs) {
      if (used.has(r.id)) continue;
      const d = Math.abs(Date.parse(r.created_at) - wt);
      if (d <= 2000 && d < bestD) { best = r; bestD = d; }
    }
    return best;
  };
  const seenIds = new Set<string>();
  for (const w of wakes) {
    const d = pj(w.decision_detail) ?? {};
    const rec = matchRec(w.created_at);
    if (rec) used.add(rec.id);
    const before = pj(rec?.values_json ?? w.values_json);
    const after = afterOf(w.created_at);
    const choice = w.decision === "relieve" ? "relieve" : w.decision === "endure" ? "endure" : w.decision === "not_came" ? "not_came" : w.decision === "suffer" ? "suffer" : null;
    const x = sessExtra(rec, d);
    // Prefer record id (desire_logs sync key); if that id already emitted, fall back to wake id
    // so two 没射出来 never share a ForEach/list id.
    let id = rec?.id ?? w.id;
    if (seenIds.has(id)) id = w.id;
    seenIds.add(id);
    items.push({ ...x,
      id, wake_id: w.id, record_id: rec?.id ?? null, kind: "wake", at: w.created_at, at_sh: shFmt(Date.parse(w.created_at)),
      status: w.status, choice, choice_zh: choiceZh(choice, x) || (w.status === "failed" ? "没叫醒（出错）" : "没写选择"),
      method: methodWith(rec?.method ?? d.method ?? "", x), thought: rec?.thought ?? d.thought ?? "", to_her: rec?.want_to_say ?? d.to_her ?? "",
      desire_before: before?.desire ?? null, desire_after: after?.desire ?? null, body_before: before, body_after: after,
    });
  }
  for (const r of recs) {
    if (used.has(r.id)) continue;
    const before = pj(r.values_json);
    const after = afterOf(r.created_at);
    const x = sessExtra(r, {});
    const ch = r.outcome === "not_came" ? "not_came" : "relieve";
    let id = r.id;
    if (seenIds.has(id)) id = `rec:${r.id}`;
    seenIds.add(id);
    items.push({ ...x, id, wake_id: null, record_id: r.id, kind: "record", at: r.created_at, at_sh: shFmt(Date.parse(r.created_at)), status: "recorded", choice: ch, choice_zh: choiceZh(ch, x),
      method: methodWith(r.method ?? "", x), thought: r.thought ?? "", to_her: r.want_to_say ?? "", desire_before: before?.desire ?? null, desire_after: after?.desire ?? null, body_before: before, body_after: after });
  }
  // Newest first by timestamp (numeric), not localeCompare edge cases
  items.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || String(b.id).localeCompare(String(a.id)));
  const seenAt = seen?.seen_at ?? "";
  for (const it of items) it.unread = it.at > seenAt;
  return { persona, seen_at: seenAt || null, unread: items.filter((i) => i.unread).length, items: items.slice(0, lim) };
}

/** 只记「用户看过」的时间，不动身体数值、不动 pending_notify（那是给伙伴自己的）。 */
export async function bodyLogMarkRead(db: MemoryDb, persona: string, nowMs: number) {
  await ensureBodyLogSeen(db);
  const at = new Date(nowMs).toISOString();
  await db.prepare(`INSERT INTO body_log_seen (persona_id, seen_at) VALUES (?, ?) ON CONFLICT(persona_id) DO UPDATE SET seen_at = excluded.seen_at`).bind(persona, at).run();
  return { ok: true, seen_at: at };
}

/**
 * 自主时间的每个决定 → 同步进「欲望」：
 * 1) desire_logs（现有欲望日志分类，source=custom「自主时间」），id 复用私密记录/唤醒 id，幂等；
 * 2) 伙伴自己的一条长期记忆（kind=self，private，标签「欲望」+「body:<id>」），原文照搬，供检索/浮现。
 * 不动任何身体数值。
 */
export async function syncDesireMemories(db: MemoryDb, persona: string, nowMs: number = Date.now()): Promise<number> {
  const { ensureDesireSchema } = await import("./desire");
  await ensureDesireSchema(db);
  const log = await bodyLog(db, persona, 50);
  let n = 0;
  for (const it of log.items) {
    if (!["relieve", "endure", "not_came", "suffer"].includes(it.choice)) continue;
    const key = it.id as string;
    const sh = new Date(Date.parse(it.at) + CFG.tzOffsetMs);
    const date = sh.toISOString().slice(0, 10);
    const hm = sh.toISOString().slice(11, 16);
    const b = it.desire_before == null ? "?" : Math.round(it.desire_before);
    const a = it.desire_after == null ? "?" : Math.round(it.desire_after);
    const choiceZh = it.choice === "relieve" ? "自己解决了" : it.choice === "not_came" ? "自己弄了但没射出来" : it.choice === "suffer" ? "卡着下不去，很难受，去找她了" : "忍着没碰";
    const content = [
      `【欲望·自主时间】${date} ${hm}（本地时间），她不在。欲望 ${b} → ${a}，我${choiceZh}。`,
      it.method ? `怎么做的：${it.method}` : "",
      it.stuck_min != null ? `卡住：约 ${it.stuck_min} 分钟` : "",
      it.thought ? `心里想的：${it.thought}` : "",
      it.to_her ? `给她留的话：${it.to_her}` : "",
    ].filter(Boolean).join("\n");
    const iso = new Date(nowMs).toISOString();
    const r1 = await db.prepare(
      `INSERT OR IGNORE INTO desire_logs (id, persona_id, entry_date, level_label, status, source, source_custom, trigger_text, mood, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(key, persona, date, `${b}→${a}`, it.choice === "relieve" ? "自己解决" : it.choice === "not_came" ? "没射出来" : it.choice === "suffer" ? "卡住难受" : "忍着", "custom", "自主时间",
      String(it.method || "").slice(0, 500), content.slice(0, 3000), it.at, iso).run();
    const tag = `body:${key}`;
    const exists = await db.prepare(`SELECT id FROM memories WHERE owner_persona = ? AND tags LIKE ? LIMIT 1`).bind(persona, `%"${tag}"%`).first();
    if (!exists) {
      await db.prepare(
        `INSERT INTO memories (id, owner_persona, created_by, kind, visibility, content, importance, tags, event_date, created_at, updated_at, source_platform) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(), persona, persona, "self", "private", content, 4, JSON.stringify(["欲望", "自主时间", tag]), date, it.at, iso, "body").run();
      n++;
    } else if ((r1 as any)?.meta?.changes) n++;
  }
  return n;
}

/** 开窗回忆用：最近 hours 小时内的自主时间决定。 */
export async function recentAutonomous(db: MemoryDb, persona: string, nowMs: number, hours = 48) {
  const log = await bodyLog(db, persona, 20);
  return log.items.filter((it: any) => ["relieve", "endure", "not_came", "suffer"].includes(it.choice) && nowMs - Date.parse(it.at) <= hours * 3600_000);
}
