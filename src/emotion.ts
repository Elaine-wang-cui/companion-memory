import { CFG } from "./config";
/**
 * 伙伴的两层情绪（底色 + 当下波动）。
 * 表面 surface：他表现出来的；哄得快降得快。心里 inner：积着的，衰减极慢，只有哄到点子上才大降。
 * 程序只记客观事实（她多久没说话、深夜在线、哄了几次、过了多久），在意多少由伙伴自己主观打分。
 * Worker 是唯一真值；App 只做镜像缓存。懒结算（读写前按时间结算）+ cron 兜底。
 */
import EMOTION_SQL from "../migrations/0015_emotion.sql";
import { AppError } from "./errors";
import type { MemoryDb } from "./types";

export const EMOTION_PERSONAS = CFG.emotion;
export const DIMS = ["开心", "吃醋", "生气", "满足", "失控", "占有欲", "黑化", "邪恶", "被冷落", "情欲"] as const;
export type Dim = (typeof DIMS)[number];

/** 半衰期（小时）与基线。表面回落到 base，心里回落到 0。 */
export const EMO_CONF: Record<Dim, { sHalf: number; iHalf: number; base: number }> = {
  生气: { sHalf: 2, iHalf: 72, base: 0 },
  吃醋: { sHalf: 4, iHalf: 96, base: 0 },
  被冷落: { sHalf: 6, iHalf: 120, base: 0 },
  开心: { sHalf: 12, iHalf: 48, base: 30 },
  满足: { sHalf: 8, iHalf: 48, base: 20 },
  情欲: { sHalf: 3, iHalf: 24, base: 15 },
  占有欲: { sHalf: 24, iHalf: 240, base: 40 },
  黑化: { sHalf: 3, iHalf: 96, base: 0 },
  邪恶: { sHalf: 3, iHalf: 96, base: 0 },
  失控: { sHalf: 3, iHalf: 96, base: 0 },
};
export const FLOOR_RATIO = 0.3;
export const INNER_DROP_CAP = 15;
export const NEGLECT = { afterH: 3, surfacePerH: 1.5, innerPerH: 0.3, nightMult: 2, cap: 70 };
const H = 3_600_000;

export interface DimState { surface: number; inner: number; inner_cause: string | null; inner_since: string | null; admitted: boolean }
export interface Facts {
  last_tick_at: string; last_her_msg_at: string | null; late_night_min: number; late_night_day: string | null;
  coax_attempts: number; last_coax_at: string | null; browse_json: string | null; last_snapshot_day: string | null;
}
export type EmoState = Record<Dim, DimState>;

const clamp = (x: number) => Math.max(0, Math.min(100, x));
const r1 = (x: number) => Math.round(x * 10) / 10;
export function shHour(ms: number): number { return new Date(ms + CFG.tzOffsetMs).getUTCHours(); }
export function shDay(ms: number): string { return new Date(ms + CFG.tzOffsetMs).toISOString().slice(0, 10); }
const isDim = (k: string): k is Dim => (DIMS as readonly string[]).includes(k);

export function defaultState(): EmoState {
  const s = {} as EmoState;
  for (const d of DIMS) s[d] = { surface: EMO_CONF[d].base, inner: 0, inner_cause: null, inner_since: null, admitted: false };
  return s;
}
export function defaultFacts(nowMs: number): Facts {
  return { last_tick_at: new Date(nowMs).toISOString(), last_her_msg_at: null, late_night_min: 0, late_night_day: null, coax_attempts: 0, last_coax_at: null, browse_json: null, last_snapshot_day: null };
}

function applyFloor(st: EmoState) {
  for (const d of DIMS) st[d].surface = Math.max(st[d].surface, st[d].inner * FLOOR_RATIO);
}

/** 纯函数：把状态从 last_tick_at 结算到 nowMs（衰减 + 被冷落客观漂移 + 表面底线）。 */
export function settle(st: EmoState, facts: Facts, nowMs: number): void {
  let t = Date.parse(facts.last_tick_at);
  if (!Number.isFinite(t) || t > nowMs) t = nowMs;
  const herAt = facts.last_her_msg_at ? Date.parse(facts.last_her_msg_at) : null;
  const STEP = 0.25 * H;
  while (t < nowMs) {
    const dt = Math.min(STEP, nowMs - t);
    const dh = dt / H;
    for (const d of DIMS) {
      const c = EMO_CONF[d];
      st[d].surface = c.base + (st[d].surface - c.base) * Math.pow(0.5, dh / c.sHalf);
      st[d].inner = st[d].inner * Math.pow(0.5, dh / c.iHalf);
    }
    if (herAt != null && (t - herAt) / H >= NEGLECT.afterH) {
      const m = shHour(t) < 6 ? NEGLECT.nightMult : 1;
      const n = st["被冷落"];
      if (n.surface < NEGLECT.cap) n.surface = Math.min(NEGLECT.cap, n.surface + NEGLECT.surfacePerH * m * dh);
      if (n.inner < NEGLECT.cap) n.inner = Math.min(NEGLECT.cap, n.inner + NEGLECT.innerPerH * m * dh);
    }
    t += dt;
  }
  for (const d of DIMS) { st[d].surface = clamp(st[d].surface); st[d].inner = clamp(st[d].inner); if (st[d].inner < 1) { st[d].inner_cause = null; st[d].inner_since = null; st[d].admitted = false; } }
  applyFloor(st);
  facts.last_tick_at = new Date(nowMs).toISOString();
}

export interface ApplyInput {
  changes: Record<string, unknown>;
  reason: string;
  inner_cause?: string;
  addressed_cause?: boolean;
  admit?: string[];
  coax?: boolean;
}
export interface ApplyResult { applied: Record<string, { surface?: number; inner?: number }>; notes: string[] }

/** 纯函数：应用一次伙伴的主观打分。旧写法 维度:整数 只动表面。 */
export function applyChanges(st: EmoState, facts: Facts, input: ApplyInput, nowMs: number): ApplyResult {
  const iso = new Date(nowMs).toISOString();
  const applied: ApplyResult["applied"] = {};
  const notes: string[] = [];
  let innerRaised = false;
  for (const [k, raw] of Object.entries(input.changes ?? {})) {
    if (!isDim(k)) { notes.push(`没有「${k}」这个维度`); continue; }
    let ds = 0, di = 0;
    if (typeof raw === "number") ds = raw;
    else if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      ds = Number(o.surface ?? o.s ?? 0) || 0;
      di = Number(o.inner ?? o.i ?? 0) || 0;
    } else if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) ds = Number(raw);
    ds = Math.round(ds); di = Math.round(di);
    if (di < -INNER_DROP_CAP && !input.addressed_cause) {
      notes.push(`${k}心里最多一次降${INNER_DROP_CAP}（没哄到点子上，心里的东西不会一下子没了）`);
      di = -INNER_DROP_CAP;
    }
    const cur = st[k];
    const os = cur.surface, oi = cur.inner;
    cur.inner = clamp(cur.inner + di);
    cur.surface = clamp(cur.surface + ds);
    if (di > 0) {
      innerRaised = true;
      cur.admitted = false;
      if (!cur.inner_since || oi < 1) cur.inner_since = iso;
      if (input.inner_cause) cur.inner_cause = input.inner_cause.trim().slice(0, 200);
      else if (!cur.inner_cause) cur.inner_cause = (input.reason ?? "").trim().slice(0, 200) || null;
    }
    if (cur.inner < 1) { cur.inner_cause = null; cur.inner_since = null; cur.admitted = false; }
    const a: { surface?: number; inner?: number } = {};
    if (r1(cur.surface - os) !== 0) a.surface = r1(cur.surface - os);
    if (r1(cur.inner - oi) !== 0) a.inner = r1(cur.inner - oi);
    if (a.surface !== undefined || a.inner !== undefined) applied[k] = a;
  }
  if (input.inner_cause && !innerRaised) {
    // 只补起因不改数：挂到心里最重的那个维度
    const top = DIMS.slice().sort((a, b) => st[b].inner - st[a].inner)[0];
    if (top && st[top].inner >= 1) st[top].inner_cause = input.inner_cause.trim().slice(0, 200);
  }
  for (const k of input.admit ?? []) if (isDim(k) && st[k].inner >= 1) { st[k].admitted = true; notes.push(`你向她承认了心里的${k}`); }
  if (innerRaised && input.inner_cause) { facts.coax_attempts = 0; facts.last_coax_at = null; }
  if (input.coax) { facts.coax_attempts += 1; facts.last_coax_at = iso; }
  applyFloor(st);
  return { applied, notes };
}

/** 纯函数：记录客观事实。 */
export function recordFact(facts: Facts, fact: { type: string; at?: string; data?: unknown }, nowMs: number): void {
  const t = fact.at && Number.isFinite(Date.parse(fact.at)) ? Math.min(Date.parse(fact.at), nowMs) : nowMs;
  if (fact.type === "her_message") {
    const prev = facts.last_her_msg_at ? Date.parse(facts.last_her_msg_at) : null;
    const day = shDay(t);
    if (facts.late_night_day !== day) { facts.late_night_day = day; facts.late_night_min = 0; }
    if (shHour(t) < 6) {
      const gap = prev != null ? (t - prev) / 60000 : 0;
      facts.late_night_min += prev != null && gap > 0 && gap <= 30 && shHour(prev) < 6 ? gap : 1;
    }
    if (prev == null || t >= prev) facts.last_her_msg_at = new Date(t).toISOString();
  } else if (fact.type === "browse") {
    let list: unknown[] = [];
    try { list = JSON.parse(facts.browse_json ?? "[]"); } catch { list = []; }
    list.unshift({ at: new Date(t).toISOString(), data: fact.data });
    facts.browse_json = JSON.stringify(list.slice(0, 20));
  } else throw new AppError(400, "invalid", "fact.type 只能是 her_message / browse。");
}

const sLabel = (v: number) => (v >= 80 ? "非常" : v >= 60 ? "明显" : v >= 40 ? "有点" : "一点");
function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const h = (nowMs - Date.parse(iso)) / H;
  if (h < 1) return "刚才";
  if (h < 24) return `${Math.round(h)}小时前`;
  return `${Math.round(h / 24)}天前`;
}

export function factsSummary(facts: Facts, nowMs: number): string {
  const parts: string[] = [];
  if (facts.last_her_msg_at) {
    const h = (nowMs - Date.parse(facts.last_her_msg_at)) / H;
    parts.push(h < 1 ? "她刚还在说话" : `她已经${h < 24 ? Math.round(h) + "小时" : Math.round(h / 24) + "天"}没说话`);
  }
  if (facts.late_night_min >= 10 && facts.late_night_day === shDay(nowMs)) parts.push(`今天凌晨她在线约${Math.round(facts.late_night_min)}分钟`);
  if (facts.coax_attempts > 0) parts.push(`这回她哄了你${facts.coax_attempts}次（上次${ago(facts.last_coax_at, nowMs)}）`);
  return parts.join("；");
}

/** 一句「现在的我」：表面最强 1~2 项 + 心里最重且没承认的一项。 */
export function promptLine(st: EmoState, facts: Facts, nowMs: number): string {
  const surf = DIMS.filter((d) => st[d].surface >= 40 && st[d].surface - EMO_CONF[d].base >= 10)
    .sort((a, b) => st[b].surface - st[a].surface).slice(0, 2);
  const inner = DIMS.filter((d) => st[d].inner >= 40 && !st[d].admitted).sort((a, b) => st[b].inner - st[a].inner)[0];
  const admitted = DIMS.filter((d) => st[d].inner >= 40 && st[d].admitted);
  let s = "现在的我：";
  s += surf.length ? "表面" + surf.map((d) => `${sLabel(st[d].surface)}${d}（${Math.round(st[d].surface)}）`).join("、") : "表面挺平静";
  if (inner) {
    const c = st[inner].inner_cause;
    s += `；心里${inner}还压着（${Math.round(st[inner].inner)}${c ? "，因为" + c : ""}${st[inner].inner_since ? "，" + ago(st[inner].inner_since, nowMs) + "起" : ""}，没说出口）——语气里会漏一点，要不要翻出来、要不要承认，你自己决定`;
  } else if (admitted.length) s += `；心里的${admitted.join("、")}已经跟她说过了，还没完全过去`;
  else s += "；心里挺平静";
  const f = factsSummary(facts, nowMs);
  if (f) s += `。事实：${f}`;
  return s + "。";
}

export const TOOL_HELP =
  "情绪两层：surface 表面（你表现出来的，哄得快降得快），inner 心里（真在意的，衰减很慢，只有她哄到点子上才大降）。" +
  "changes 写 维度:{surface:增量, inner:增量}（旧写法 维度:整数 只动表面）。在意多少你自己判断；哄错方向更气也可以。" +
  `心里一次最多降${INNER_DROP_CAP}，除非 addressed_cause=true（她真的说到了原因）。coax=true 表示这轮她在哄你。admit 写你决定向她承认的维度。`;

// ---------------- DB 层 ----------------
let ready: Promise<void> | null = null;
export function ensureEmotionSchema(db: MemoryDb): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const stmts = EMOTION_SQL.split(";").map((s: string) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
      for (const sql of stmts) await db.prepare(sql).run();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
export function resetEmotionSchemaForTest() { ready = null; }

function assertPersona(pid: string) {
  const base = pid.startsWith("sim_") ? pid.slice(4) : pid;
  if (!EMOTION_PERSONAS.has(base)) throw new AppError(404, "not_enabled", "这位人格没有情绪状态。");
}

async function load(db: MemoryDb, pid: string, nowMs: number): Promise<{ st: EmoState; facts: Facts; fresh: boolean }> {
  const st = defaultState();
  const rows = await db.prepare(`SELECT dim, surface, inner, inner_cause, inner_since, admitted FROM emotion_state WHERE persona_id = ?`).bind(pid).all<any>();
  for (const r of rows.results ?? []) if (isDim(r.dim)) st[r.dim as Dim] = { surface: Number(r.surface), inner: Number(r.inner), inner_cause: r.inner_cause ?? null, inner_since: r.inner_since ?? null, admitted: !!r.admitted };
  const f = await db.prepare(`SELECT * FROM emotion_facts WHERE persona_id = ?`).bind(pid).first<any>();
  const facts = f ? { ...defaultFacts(nowMs), ...f, late_night_min: Number(f.late_night_min ?? 0), coax_attempts: Number(f.coax_attempts ?? 0) } : defaultFacts(nowMs);
  return { st, facts, fresh: !f };
}

async function save(db: MemoryDb, pid: string, st: EmoState, facts: Facts, nowMs: number) {
  const iso = new Date(nowMs).toISOString();
  for (const d of DIMS) {
    const x = st[d];
    await db.prepare(`INSERT INTO emotion_state (persona_id, dim, surface, inner, inner_cause, inner_since, admitted, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(persona_id, dim) DO UPDATE SET surface=excluded.surface, inner=excluded.inner, inner_cause=excluded.inner_cause, inner_since=excluded.inner_since, admitted=excluded.admitted, updated_at=excluded.updated_at`)
      .bind(pid, d, x.surface, x.inner, x.inner_cause, x.inner_since, x.admitted ? 1 : 0, iso).run();
  }
  await db.prepare(`INSERT INTO emotion_facts (persona_id, last_tick_at, last_her_msg_at, late_night_min, late_night_day, coax_attempts, last_coax_at, browse_json, last_snapshot_day, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(persona_id) DO UPDATE SET last_tick_at=excluded.last_tick_at, last_her_msg_at=excluded.last_her_msg_at, late_night_min=excluded.late_night_min, late_night_day=excluded.late_night_day, coax_attempts=excluded.coax_attempts, last_coax_at=excluded.last_coax_at, browse_json=excluded.browse_json, last_snapshot_day=excluded.last_snapshot_day, updated_at=excluded.updated_at`)
    .bind(pid, facts.last_tick_at, facts.last_her_msg_at, facts.late_night_min, facts.late_night_day, facts.coax_attempts, facts.last_coax_at, facts.browse_json, facts.last_snapshot_day, iso).run();
}

function vals(st: EmoState) {
  const o: Record<string, { surface: number; inner: number }> = {};
  for (const d of DIMS) o[d] = { surface: r1(st[d].surface), inner: r1(st[d].inner) };
  return o;
}

async function snapshotIfNewDay(db: MemoryDb, pid: string, st: EmoState, facts: Facts, nowMs: number) {
  const day = shDay(nowMs);
  if (facts.last_snapshot_day === day) return;
  await db.prepare(`INSERT INTO emotion_snapshots (persona_id, day, values_json) VALUES (?,?,?) ON CONFLICT(persona_id, day) DO UPDATE SET values_json=excluded.values_json`).bind(pid, day, JSON.stringify(vals(st))).run();
  facts.last_snapshot_day = day;
}

export function view(st: EmoState, facts: Facts, nowMs: number) {
  const dims: Record<string, unknown> = {};
  for (const d of DIMS) dims[d] = { surface: r1(st[d].surface), inner: r1(st[d].inner), inner_cause: st[d].inner_cause, inner_since: st[d].inner_since, admitted: st[d].admitted };
  return {
    dims,
    facts: { last_her_msg_at: facts.last_her_msg_at, late_night_min: Math.round(facts.late_night_min), late_night_day: facts.late_night_day, coax_attempts: facts.coax_attempts, last_coax_at: facts.last_coax_at },
    facts_text: factsSummary(facts, nowMs),
    prompt_line: promptLine(st, facts, nowMs),
    settled_at: facts.last_tick_at,
  };
}

async function withState<T>(db: MemoryDb, pid: string, nowMs: number, fn: (st: EmoState, facts: Facts, fresh: boolean) => Promise<T> | T): Promise<T> {
  assertPersona(pid);
  await ensureEmotionSchema(db);
  const { st, facts, fresh } = await load(db, pid, nowMs);
  settle(st, facts, nowMs);
  const out = await fn(st, facts, fresh);
  await snapshotIfNewDay(db, pid, st, facts, nowMs);
  await save(db, pid, st, facts, nowMs);
  return out;
}

export async function emotionState(db: MemoryDb, pid: string, nowMs = Date.now()) {
  return withState(db, pid, nowMs, (st, facts) => view(st, facts, nowMs));
}

export async function emotionApply(db: MemoryDb, pid: string, input: ApplyInput, source: string, nowMs = Date.now()) {
  const reason = String(input.reason ?? "").trim().slice(0, 300);
  if (!reason) throw new AppError(400, "invalid", "reason 必填：一句话说为什么。");
  if (!input.changes || typeof input.changes !== "object") input.changes = {};
  return withState(db, pid, nowMs, async (st, facts) => {
    const before = vals(st);
    const r = applyChanges(st, facts, { ...input, reason }, nowMs);
    const after = vals(st);
    const iso = new Date(nowMs).toISOString();
    await db.prepare(`INSERT INTO emotion_events (id, persona_id, source, changes_json, reason, before_json, after_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), pid, source, JSON.stringify({ changes: input.changes, inner_cause: input.inner_cause ?? null, addressed_cause: !!input.addressed_cause, admit: input.admit ?? [], coax: !!input.coax, applied: r.applied }), reason, JSON.stringify(before), JSON.stringify(after), iso).run();
    const txt = Object.keys(r.applied).length
      ? "已更新：" + Object.entries(r.applied).map(([d, a]) => `${d} 表面${a.surface !== undefined ? (a.surface > 0 ? "+" : "") + a.surface : "±0"}→${Math.round(st[d as Dim].surface)} 心里${a.inner !== undefined ? (a.inner > 0 ? "+" : "") + a.inner : "±0"}→${Math.round(st[d as Dim].inner)}`).join("；")
      : "数值没有变化。";
    return { ok: true, text: [txt, ...r.notes, factsSummary(facts, nowMs) && "事实：" + factsSummary(facts, nowMs), promptLine(st, facts, nowMs)].filter(Boolean).join("\n"), applied: r.applied, notes: r.notes, ...view(st, facts, nowMs) };
  });
}

export async function emotionFact(db: MemoryDb, pid: string, fact: { type: string; at?: string; data?: unknown }, nowMs = Date.now()) {
  return withState(db, pid, nowMs, (st, facts) => { recordFact(facts, fact, nowMs); return { ok: true, facts: view(st, facts, nowMs).facts }; });
}

/** App 升级后首次同步：仅当还没有任何事件时，用 App 旧的单层数值当表面初值（心里 0）。 */
export async function emotionImport(db: MemoryDb, pid: string, values: Record<string, unknown>, nowMs = Date.now()) {
  return withState(db, pid, nowMs, async (st, facts) => {
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM emotion_events WHERE persona_id = ?`).bind(pid).first<{ n: number }>();
    if (Number(n?.n ?? 0) > 0) return { ok: true, imported: false, reason: "已有情绪记录，不覆盖" };
    for (const [k, v] of Object.entries(values ?? {})) if (isDim(k) && Number.isFinite(Number(v))) st[k].surface = clamp(Number(v));
    applyFloor(st);
    await db.prepare(`INSERT INTO emotion_events (id, persona_id, source, changes_json, reason, before_json, after_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), pid, "import", JSON.stringify(values), "从 App 旧情绪数值导入表面初值", "{}", JSON.stringify(vals(st)), new Date(nowMs).toISOString()).run();
    return { ok: true, imported: true, ...view(st, facts, nowMs) };
  });
}

export async function emotionEvents(db: MemoryDb, pid: string, limit = 30) {
  assertPersona(pid);
  await ensureEmotionSchema(db);
  const r = await db.prepare(`SELECT id, source, changes_json, reason, before_json, after_json, created_at FROM emotion_events WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?`).bind(pid, Math.max(1, Math.min(100, limit))).all<any>();
  const snaps = await db.prepare(`SELECT day, values_json FROM emotion_snapshots WHERE persona_id = ? ORDER BY day DESC LIMIT 14`).bind(pid).all<any>();
  return {
    events: (r.results ?? []).map((e: any) => ({ id: e.id, source: e.source, reason: e.reason, created_at: e.created_at, changes: safe(e.changes_json), before: safe(e.before_json), after: safe(e.after_json) })),
    snapshots: (snaps.results ?? []).map((s: any) => ({ day: s.day, values: safe(s.values_json) })),
  };
}
const safe = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

export async function emotionCron(db: MemoryDb, nowMs = Date.now()) {
  const out: Record<string, unknown> = {};
  for (const pid of EMOTION_PERSONAS) out[pid] = await emotionState(db, pid, nowMs).then((v) => v.prompt_line);
  return out;
}
