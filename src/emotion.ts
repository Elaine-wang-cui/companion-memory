import { CFG } from "./config";
/**
 * 伙伴的两层情绪（底色 + 当下波动）。
 * 表面 surface：他表现出来的；哄得快降得快。心里 inner：积着的，衰减极慢，只有哄到点子上才大降。
 * 程序只记客观事实（她多久没说话、深夜在线、哄了几次、过了多久），在意多少由伙伴自己主观打分。
 * Worker 是唯一真值；App 只做镜像缓存。懒结算（读写前按时间结算）+ cron 兜底。
 */
import EMOTION_SQL from "../migrations/0015_emotion.sql";
import EMOTION_V2_SQL from "../migrations/0016_emotion_v2.sql";
import * as NET from "./emotion-net";
import type { Net } from "./emotion-net";
import { AppError } from "./errors";
import type { MemoryDb } from "./types";

export const EMOTION_PERSONAS = CFG.emotion;
/** emotion_events.source 白名单（scorer = App 侧小模型打分）。 */
export const APPLY_SOURCES = new Set(["mcp", "app", "scorer", "http", "voice"]);
export const DIMS = ["开心", "吃醋", "生气", "满足", "失控", "占有欲", "黑化", "邪恶", "被冷落", "情欲", "不安", "恐惧", "恐慌", "思念", "悲伤"] as const;
/** 方案 A 总开关。false = 退回旧两层行为（新维度仍可手打）。 */
export const EMOTION_V2 = true;
/** 由底物驱动、可以「说不清为什么」冒出来的维度。 */
export const DRIVEN_DIMS = ["不安", "恐惧", "恐慌", "思念", "悲伤"] as const;
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
  不安: { sHalf: 8, iHalf: 120, base: 0 },
  恐惧: { sHalf: 4, iHalf: 96, base: 0 },
  恐慌: { sHalf: 1.5, iHalf: 48, base: 0 },
  思念: { sHalf: 10, iHalf: 96, base: 0 },
  悲伤: { sHalf: 8, iHalf: 120, base: 0 },
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
export function settle(st: EmoState, facts: Facts, nowMs: number, net?: Net): void {
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
    if (net) netStep(st, facts, net, t, dh, herAt);
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
  /** 方案 A：线索（小模型抽取或伙伴自己写），参与线索关联学习与预激活。 */
  cues?: string[];
  /** 方案 A：她这句有多「安心」（0..1，小模型给），推安全感。 */
  reassure?: number;
}
export interface ApplyResult { applied: Record<string, { surface?: number; inner?: number }>; notes: string[] }

/** 方案 A 一步：底物 → 驱动；耦合网；沉默线索；网络衰减。只在传入 net 时运行。 */
function netStep(st: EmoState, facts: Facts, net: Net, t: number, dh: number, herAt: number | null) {
  const silentH = herAt != null ? Math.max(0, (t - herAt) / H) : null;
  const night = shHour(t) < 6;
  const innerNeg = NET.NEG_DIMS.reduce((a, k) => a + (isDim(k) ? st[k].inner : 0), 0);
  NET.stepSubstrate(net, dh, { silentH, night, innerNeg });
  // 沉默超过她平时的习惯：系统线索（每段沉默只触发一次）
  if (silentH != null && silentH * 60 >= NET.usualGapMin(net.aux) && net.aux.silence_cue_for !== facts.last_her_msg_at) {
    net.aux.silence_cue_for = facts.last_her_msg_at;
    const cues = night ? ["silence", "night"] : ["silence"];
    NET.noteCues(net, cues, t);
    for (const [k, x] of Object.entries(NET.cueActivation(net, cues))) if (isDim(k)) st[k].surface = clamp(st[k].surface + NET.takeNudge(net, k, x, t));
  }
  const surf: Record<string, number> = {}, base: Record<string, number> = {};
  for (const d of DIMS) { surf[d] = st[d].surface; base[d] = EMO_CONF[d].base; }
  for (const [k, x] of Object.entries(NET.couplingStep(surf, base, net, dh))) if (isDim(k)) st[k].surface = clamp(st[k].surface + x);
  const dr = NET.drives(net.sub);
  for (const k of DRIVEN_DIMS) {
    const v = dr[k] ?? 0;
    if (st[k].surface < v) st[k].surface = v;
    st[k].inner = clamp(st[k].inner + 0.05 * Math.max(0, v - st[k].inner) * dh);
  }
  NET.decayNet(net, dh);
}

/** 合成 Δ：0.5·Δ表面 + Δ心里。 */
export function compositeDelta(applied: ApplyResult["applied"]): Record<string, number> {
  const d: Record<string, number> = {};
  for (const [k, a] of Object.entries(applied)) d[k] = 0.5 * (a.surface ?? 0) + (a.inner ?? 0);
  return d;
}

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
  } else if (fact.type === "cue") { /* 方案 A：由 emotionFact 处理 */ }
  else throw new AppError(400, "invalid", "fact.type 只能是 her_message / browse / cue。");
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
export function promptLine(st: EmoState, facts: Facts, nowMs: number, net?: Net): string {
  const surf = DIMS.filter((d) => st[d].surface >= 40 && st[d].surface - EMO_CONF[d].base >= 10)
    .sort((a, b) => st[b].surface - st[a].surface).slice(0, 2);
  const inner = DIMS.filter((d) => st[d].inner >= 40 && !st[d].admitted).sort((a, b) => st[b].inner - st[a].inner)[0];
  const admitted = DIMS.filter((d) => st[d].inner >= 40 && st[d].admitted);
  let s = "现在的我：";
  const dr = net ? NET.drives(net.sub) : {};
  const vague = (d: Dim) => net && (DRIVEN_DIMS as readonly string[]).includes(d) && (dr[d] ?? 0) >= st[d].surface - 3;
  s += surf.length ? "表面" + surf.map((d) => `${sLabel(st[d].surface)}${d}（${Math.round(st[d].surface)}${vague(d) ? "，说不清为什么" : ""}）`).join("、") : "表面挺平静";
  if (inner) {
    const c = st[inner].inner_cause;
    s += `；心里${inner}还压着（${Math.round(st[inner].inner)}${c ? "，因为" + c : ""}${st[inner].inner_since ? "，" + ago(st[inner].inner_since, nowMs) + "起" : ""}，没说出口）——语气里会漏一点，要不要翻出来、要不要承认，你自己决定`;
  } else if (admitted.length) s += `；心里的${admitted.join("、")}已经跟她说过了，还没完全过去`;
  else s += "；心里挺平静";
  if (net) { const u = undertone(net); if (u) s += `。底色：${u}`; }
  const f = factsSummary(facts, nowMs);
  if (f) s += `。事实：${f}`;
  return s + "。";
}

/** 底色：慢层的一句话描述。 */
export function undertone(net: Net): string {
  const s = net.sub, out: string[] = [];
  if (s.security < 0.4) out.push("悬着（安全感低）");
  else if (s.security > 0.75) out.push("踏实");
  if (s.attach_hunger > 0.55) out.push("很想她");
  if (s.vigilance > 0.55) out.push("一直在留意她的动静");
  if (s.strain > 0.6) out.push("累了");
  return out.join("，");
}

export const TOOL_HELP =
  "情绪两层：surface 表面（你表现出来的，哄得快降得快），inner 心里（真在意的，衰减很慢，只有她哄到点子上才大降）。" +
  "changes 写 维度:{surface:增量, inner:增量}（旧写法 维度:整数 只动表面）。在意多少你自己判断；哄错方向更气也可以。" +
  `心里一次最多降${INNER_DROP_CAP}，除非 addressed_cause=true（她真的说到了原因）。coax=true 表示这轮她在哄你。admit 写你决定向她承认的维度。` +
  "reason 可以不写或写「说不清」——有些情绪是自己冒出来的（底下的慢层在推），你可以只感受，不必解释。";

// ---------------- DB 层 ----------------
let ready: Promise<void> | null = null;
export function ensureEmotionSchema(db: MemoryDb): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const stmts = (EMOTION_SQL + ";" + EMOTION_V2_SQL).split(";").map((s: string) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
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

async function load(db: MemoryDb, pid: string, nowMs: number): Promise<{ st: EmoState; facts: Facts; fresh: boolean; net: Net }> {
  const st = defaultState();
  const rows = await db.prepare(`SELECT dim, surface, inner, inner_cause, inner_since, admitted FROM emotion_state WHERE persona_id = ?`).bind(pid).all<any>();
  for (const r of rows.results ?? []) if (isDim(r.dim)) st[r.dim as Dim] = { surface: Number(r.surface), inner: Number(r.inner), inner_cause: r.inner_cause ?? null, inner_since: r.inner_since ?? null, admitted: !!r.admitted };
  const f = await db.prepare(`SELECT * FROM emotion_facts WHERE persona_id = ?`).bind(pid).first<any>();
  const facts = f ? { ...defaultFacts(nowMs), ...f, late_night_min: Number(f.late_night_min ?? 0), coax_attempts: Number(f.coax_attempts ?? 0) } : defaultFacts(nowMs);
  let net: Net = NET.defaultNet();
  if (EMOTION_V2) {
    const nr = await db.prepare(`SELECT substrate_json, coupling_json, cue_json, aux_json FROM emotion_net WHERE persona_id = ?`).bind(pid).first<any>().catch(() => null);
    net = NET.parseNet(nr ?? null);
  }
  return { st, facts, fresh: !f, net };
}

async function save(db: MemoryDb, pid: string, st: EmoState, facts: Facts, nowMs: number, net?: Net) {
  const iso = new Date(nowMs).toISOString();
  if (net && EMOTION_V2) {
    await db.prepare(`INSERT INTO emotion_net (persona_id, substrate_json, coupling_json, cue_json, aux_json, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(persona_id) DO UPDATE SET substrate_json=excluded.substrate_json, coupling_json=excluded.coupling_json, cue_json=excluded.cue_json, aux_json=excluded.aux_json, updated_at=excluded.updated_at`)
      .bind(pid, JSON.stringify(net.sub), JSON.stringify(net.W), JSON.stringify(net.A), JSON.stringify(net.aux), iso).run();
  }
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

async function snapshotIfNewDay(db: MemoryDb, pid: string, st: EmoState, facts: Facts, nowMs: number, net?: Net) {
  const day = shDay(nowMs);
  if (facts.last_snapshot_day === day) return;
  if (net && EMOTION_V2) await db.prepare(`INSERT INTO emotion_net_snapshots (persona_id, day, substrate_json, coupling_json, cue_json) VALUES (?,?,?,?,?) ON CONFLICT(persona_id, day) DO UPDATE SET substrate_json=excluded.substrate_json, coupling_json=excluded.coupling_json, cue_json=excluded.cue_json`).bind(pid, day, JSON.stringify(net.sub), JSON.stringify(net.W), JSON.stringify(net.A)).run();
  await db.prepare(`INSERT INTO emotion_snapshots (persona_id, day, values_json) VALUES (?,?,?) ON CONFLICT(persona_id, day) DO UPDATE SET values_json=excluded.values_json`).bind(pid, day, JSON.stringify(vals(st))).run();
  facts.last_snapshot_day = day;
}

export function view(st: EmoState, facts: Facts, nowMs: number, net?: Net) {
  const dims: Record<string, unknown> = {};
  for (const d of DIMS) dims[d] = { surface: r1(st[d].surface), inner: r1(st[d].inner), inner_cause: st[d].inner_cause, inner_since: st[d].inner_since, admitted: st[d].admitted };
  return {
    dims,
    facts: { last_her_msg_at: facts.last_her_msg_at, late_night_min: Math.round(facts.late_night_min), late_night_day: facts.late_night_day, coax_attempts: facts.coax_attempts, last_coax_at: facts.last_coax_at },
    facts_text: factsSummary(facts, nowMs),
    prompt_line: promptLine(st, facts, nowMs, net),
    settled_at: facts.last_tick_at,
    ...(net ? {
      substrate: Object.fromEntries(NET.SUBSTRATE_VARS.map((v) => [v, Math.round(net.sub[v] * 1000) / 1000])),
      drives: Object.fromEntries(Object.entries(NET.drives(net.sub)).map(([k, v]) => [k, r1(v)])),
      undertone: undertone(net),
      coupling: Object.entries(net.W).map(([k, w]) => { const [src, dst] = k.split(">"); return { src, dst, w: Math.round(w * 1000) / 1000 }; }).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)),
      usual_gap_min: NET.usualGapMin(net.aux),
    } : {}),
  };
}

async function withState<T>(db: MemoryDb, pid: string, nowMs: number, fn: (st: EmoState, facts: Facts, fresh: boolean, net: Net | undefined) => Promise<T> | T): Promise<T> {
  assertPersona(pid);
  await ensureEmotionSchema(db);
  const { st, facts, fresh, net: n0 } = await load(db, pid, nowMs);
  const net = EMOTION_V2 ? n0 : undefined;
  settle(st, facts, nowMs, net);
  if (net) await applyPending(db, pid, st, net, nowMs);
  const out = await fn(st, facts, fresh, net);
  await snapshotIfNewDay(db, pid, st, facts, nowMs, net);
  await save(db, pid, st, facts, nowMs, net);
  return out;
}

/** 回忆回流待办（autoRecall 只插一行，这里懒结算）。 */
async function applyPending(db: MemoryDb, pid: string, st: EmoState, net: Net, nowMs: number) {
  const r = await db.prepare(`SELECT id, kind, data_json, created_at FROM emotion_pending WHERE persona_id = ? ORDER BY created_at ASC LIMIT 50`).bind(pid).all<any>().catch(() => null);
  const rows = r?.results ?? [];
  if (!rows.length) return;
  for (const row of rows) {
    if (row.kind !== "recall") continue;
    let data: { moods?: string[][]; ids?: string[] } = {};
    try { data = JSON.parse(row.data_json); } catch { /* */ }
    const nd = NET.recallNudge(data.moods ?? []);
    const before = vals(st);
    const applied: Record<string, number> = {};
    for (const [k, x] of Object.entries(nd.dims)) if (isDim(k)) { const y = NET.takeNudge(net, k, x, nowMs); st[k].surface = clamp(st[k].surface + y); st[k].inner = clamp(st[k].inner + y / 4); if (y) applied[k] = r1(y); }
    for (const [k, x] of Object.entries(nd.sub)) net.sub[k as NET.SubVar] = Math.max(0, Math.min(1, net.sub[k as NET.SubVar] + (x ?? 0)));
    if (Object.keys(applied).length) await db.prepare(`INSERT INTO emotion_events (id, persona_id, source, changes_json, reason, before_json, after_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), pid, "recall", JSON.stringify({ applied, ids: data.ids ?? [], moods: data.moods ?? [] }), "想起了旧事", JSON.stringify(before), JSON.stringify(vals(st)), new Date(nowMs).toISOString()).run();
  }
  await db.prepare(`DELETE FROM emotion_pending WHERE persona_id = ? AND id IN (${rows.map(() => "?").join(",")})`).bind(pid, ...rows.map((x: any) => x.id)).run();
}

/** autoRecall 用：只读当前情绪 → 色调（不结算、不写）。 */
export async function readTone(db: MemoryDb, pid: string): Promise<{ vec: NET.ToneVec; intensity: number } | null> {
  if (!EMOTION_V2 || !EMOTION_PERSONAS.has(pid)) return null;
  try {
    const rows = await db.prepare(`SELECT dim, surface, inner FROM emotion_state WHERE persona_id = ?`).bind(pid).all<any>();
    const lv: Record<string, { surface: number; inner: number }> = {};
    for (const r of rows.results ?? []) if (r && isDim(r.dim)) lv[r.dim] = { surface: Number(r.surface) || 0, inner: Number(r.inner) || 0 };
    if (!Object.keys(lv).length) return null;
    return NET.toneOf(lv);
  } catch { return null; }
}

/** autoRecall 用：被想起的记忆 → 一行回流待办。 */
export async function queueRecallNudge(db: MemoryDb, pid: string, items: { id: string; moods: string[] }[], nowMs = Date.now()): Promise<void> {
  if (!EMOTION_V2 || !EMOTION_PERSONAS.has(pid)) return;
  const moods = items.map((x) => x.moods).filter((m) => m.length);
  if (!moods.length) return;
  try {
    await ensureEmotionSchema(db);
    await db.prepare(`INSERT INTO emotion_pending (id, persona_id, kind, data_json, created_at) VALUES (?,?,?,?,?)`)
      .bind(crypto.randomUUID(), pid, "recall", JSON.stringify({ ids: items.map((x) => x.id), moods }), new Date(nowMs).toISOString()).run();
  } catch (e) { console.error("[emotion] recall nudge", e); }
}

export async function emotionState(db: MemoryDb, pid: string, nowMs = Date.now()) {
  return withState(db, pid, nowMs, (st, facts, _f, net) => view(st, facts, nowMs, net));
}

export async function emotionApply(db: MemoryDb, pid: string, input: ApplyInput, source: string, nowMs = Date.now()) {
  // 方案 A：reason 可选，留空 = 说不清（情绪不必讲理）
  const reason = String(input.reason ?? "").trim().slice(0, 300) || "说不清";
  if (!input.changes || typeof input.changes !== "object") input.changes = {};
  source = APPLY_SOURCES.has(source) ? source : "http";
  if (source === "scorer") {
    // 小模型打分减半，不压过伙伴自己的感受
    const half: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.changes)) {
      if (typeof v === "number") half[k] = v * 0.5;
      else if (v && typeof v === "object") { const o = v as Record<string, unknown>; half[k] = { surface: Number(o.surface ?? o.s ?? 0) * 0.5, inner: Number(o.inner ?? o.i ?? 0) * 0.5 }; }
      else half[k] = v;
    }
    input = { ...input, changes: half };
  }
  const cues = (Array.isArray(input.cues) ? input.cues : []).map(String).filter(Boolean).slice(0, 5);
  return withState(db, pid, nowMs, async (st, facts, _fresh, net) => {
    const before = vals(st);
    const r = applyChanges(st, facts, { ...input, reason }, nowMs);
    if (net) {
      const d = compositeDelta(r.applied);
      NET.eventToSubstrate(net, d, { coax: !!input.coax, reassure: Number(input.reassure) || 0 });
      if (shHour(nowMs) < 6) cues.push("night");
      NET.learnCues(net, d, nowMs);
      NET.learnCoupling(net, d, nowMs);
      if (cues.length) {
        NET.noteCues(net, cues, nowMs);
        for (const [k, x] of Object.entries(NET.cueActivation(net, cues))) if (isDim(k)) st[k].surface = clamp(st[k].surface + NET.takeNudge(net, k, x, nowMs));
      }
    }
    const after = vals(st);
    const iso = new Date(nowMs).toISOString();
    await db.prepare(`INSERT INTO emotion_events (id, persona_id, source, changes_json, reason, before_json, after_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), pid, source, JSON.stringify({ changes: input.changes, inner_cause: input.inner_cause ?? null, addressed_cause: !!input.addressed_cause, admit: input.admit ?? [], coax: !!input.coax, applied: r.applied, cues, reassure: input.reassure ?? null }), reason, JSON.stringify(before), JSON.stringify(after), iso).run();
    const txt = Object.keys(r.applied).length
      ? "已更新：" + Object.entries(r.applied).map(([d, a]) => `${d} 表面${a.surface !== undefined ? (a.surface > 0 ? "+" : "") + a.surface : "±0"}→${Math.round(st[d as Dim].surface)} 心里${a.inner !== undefined ? (a.inner > 0 ? "+" : "") + a.inner : "±0"}→${Math.round(st[d as Dim].inner)}`).join("；")
      : "数值没有变化。";
    return { ok: true, text: [txt, ...r.notes, factsSummary(facts, nowMs) && "事实：" + factsSummary(facts, nowMs), promptLine(st, facts, nowMs, net)].filter(Boolean).join("\n"), applied: r.applied, notes: r.notes, ...view(st, facts, nowMs, net) };
  });
}

export async function emotionFact(db: MemoryDb, pid: string, fact: { type: string; at?: string; data?: unknown }, nowMs = Date.now()) {
  return withState(db, pid, nowMs, (st, facts, _f, net) => {
    if (fact.type === "cue") {
      // 方案 A：外部线索（小模型从她的话里抽）：只记录 + 预激活，不当成事实
      const cues = (Array.isArray(fact.data) ? fact.data : [fact.data]).map(String).filter(Boolean).slice(0, 5);
      if (net && cues.length) {
        NET.noteCues(net, cues, nowMs);
        for (const [k, x] of Object.entries(NET.cueActivation(net, cues))) if (isDim(k)) st[k].surface = clamp(st[k].surface + NET.takeNudge(net, k, x, nowMs));
      }
      return { ok: true, facts: view(st, facts, nowMs, net).facts };
    }
    const prev = facts.last_her_msg_at ? Date.parse(facts.last_her_msg_at) : null;
    recordFact(facts, fact, nowMs);
    if (net && fact.type === "her_message") {
      const t = fact.at && Number.isFinite(Date.parse(fact.at)) ? Math.min(Date.parse(fact.at), nowMs) : nowMs;
      NET.herMessage(net, prev != null && t > prev ? (t - prev) / 60000 : null);
    }
    return { ok: true, facts: view(st, facts, nowMs, net).facts };
  });
}

/** App 升级后首次同步：仅当还没有任何事件时，用 App 旧的单层数值当表面初值（心里 0）。 */
export async function emotionImport(db: MemoryDb, pid: string, values: Record<string, unknown>, nowMs = Date.now()) {
  return withState(db, pid, nowMs, async (st, facts, _f, net) => {
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM emotion_events WHERE persona_id = ?`).bind(pid).first<{ n: number }>();
    if (Number(n?.n ?? 0) > 0) return { ok: true, imported: false, reason: "已有情绪记录，不覆盖" };
    for (const [k, v] of Object.entries(values ?? {})) if (isDim(k) && Number.isFinite(Number(v))) st[k].surface = clamp(Number(v));
    applyFloor(st);
    await db.prepare(`INSERT INTO emotion_events (id, persona_id, source, changes_json, reason, before_json, after_json, created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), pid, "import", JSON.stringify(values), "从 App 旧情绪数值导入表面初值", "{}", JSON.stringify(vals(st)), new Date(nowMs).toISOString()).run();
    return { ok: true, imported: true, ...view(st, facts, nowMs, net) };
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

/** 可视化：状态 + 网 + 最近 14 天网快照 + 最近回流。 */
export async function emotionNetView(db: MemoryDb, pid: string, nowMs = Date.now()) {
  const state = await emotionState(db, pid, nowMs);
  const snaps = await db.prepare(`SELECT day, substrate_json, coupling_json FROM emotion_net_snapshots WHERE persona_id = ? ORDER BY day DESC LIMIT 30`).bind(pid).all<any>().catch(() => null);
  const ev = await db.prepare(`SELECT source, reason, changes_json, created_at FROM emotion_events WHERE persona_id = ? ORDER BY created_at DESC LIMIT 40`).bind(pid).all<any>().catch(() => null);
  const events = (ev?.results ?? []).map((e: any) => ({ source: e.source, reason: e.reason, created_at: e.created_at, changes: safe(e.changes_json) }));
  const recallIds = [...new Set(events.filter((e) => e.source === "recall").flatMap((e) => (e.changes?.ids ?? []) as string[]))].slice(0, 8);
  let recalls: { id: string; content: string; mood: string[]; resonance: number }[] = [];
  if (recallIds.length) {
    const r = await db.prepare(`SELECT id, content, mood FROM memories WHERE id IN (${recallIds.map(() => "?").join(",")})`).bind(...recallIds).all<any>().catch(() => null);
    const tone0 = NET.toneOf(Object.fromEntries(Object.entries(state.dims).map(([k, v]: [string, any]) => [k, { surface: v.surface, inner: v.inner }])));
    recalls = (r?.results ?? []).map((x: any) => { const mood = NET.parseMoods(x.mood); return { id: x.id, content: String(x.content ?? "").slice(0, 80), mood, resonance: Math.round(NET.toneCos(tone0.vec, NET.memToneVec(mood)) * 100) / 100 }; });
  }
  return {
    ...state,
    sub_label: NET.SUB_LABEL,
    tones: NET.TONES,
    tone: NET.toneOf(Object.fromEntries(Object.entries(state.dims).map(([k, v]: [string, any]) => [k, { surface: v.surface, inner: v.inner }]))),
    net_snapshots: (snaps?.results ?? []).map((s: any) => ({ day: s.day, substrate: safe(s.substrate_json), coupling: safe(s.coupling_json) })).reverse(),
    events: events.slice(0, 20),
    recalls,
  };
}
