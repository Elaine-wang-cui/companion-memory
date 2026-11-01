/**
 * 方案 A（2026-11-01）：底物慢层 + 习得耦合网（Hebbian）+ 线索关联 + 全局稳态。
 * 纯函数；不按情绪写剧本，涌现只来自：底物动力学、学到的权重、记忆回流。
 */
export const SUBSTRATE_VARS = ["attach_hunger", "vigilance", "security", "craving", "strain"] as const;
export type SubVar = (typeof SUBSTRATE_VARS)[number];
export const SUB_LABEL: Record<SubVar, string> = { attach_hunger: "依恋饥渴", vigilance: "警觉", security: "安全感", craving: "渴求", strain: "压力" };
/** 基线与半衰期（小时）。attach_hunger 为积累型：不在时长、在时被消耗；half 用于她在时回落。 */
export const SUB_CONF: Record<SubVar, { base: number; half: number }> = {
  attach_hunger: { base: 0.2, half: 12 },
  vigilance: { base: 0.25, half: 6 },
  security: { base: 0.6, half: 72 },
  craving: { base: 0.4, half: 12 },
  strain: { base: 0.15, half: 48 },
};
export type Substrate = Record<SubVar, number>;
export type Coupling = Record<string, number>; // "src>dst" -> w
export type CueAssoc = Record<string, Record<string, number>>; // cue -> dim -> w
export interface Aux {
  gap_hist: number[]; // 她最近的沉默时长（分钟），最多 60 条
  recent_cues: { cue: string; at: number }[];
  last_delta: { at: number; d: Record<string, number> } | null;
  nudges: Record<string, { hour: number; sum: number }>; // dim -> 本小时 cue/recall 累计
  silence_cue_for: string | null;
}
export interface Net { sub: Substrate; W: Coupling; A: CueAssoc; aux: Aux }

export const LEARN = { eta: 0.2, lambdaEvent: 0.002, lambdaDay: 0.002, wCap: 0.3, rowCap: 0.6, topK: 4, prune: 0.01, temporalMin: 60, temporalTau: 30 };
export const CUE = { eta: 0.05, lambdaDay: 0.01, cap: 0.5, perDim: 30, gain: 20, windowMin: 60 };
export const BOUNDS = { stepCap: 3, negEnergy: 250, strainHigh: 0.7, nudgeHourCap: 10, subHourCap: 0.05 };
export const NEG_DIMS = ["生气", "吃醋", "被冷落", "黑化", "邪恶", "失控", "不安", "恐惧", "恐慌", "悲伤"];
/** 细线起头：几条极小的先验，会被真实数据淹没。 */
export const SEED_W: Coupling = { "被冷落>不安": 0.03, "不安>占有欲": 0.03, "满足>不安": -0.03, "开心>恐惧": -0.03, "思念>恐慌": 0.03 };

const H = 3_600_000;
const c01 = (x: number) => Math.max(0, Math.min(1, x));
const sig = (x: number) => 1 / (1 + Math.exp(-x));

export function defaultNet(): Net {
  const sub = {} as Substrate;
  for (const v of SUBSTRATE_VARS) sub[v] = SUB_CONF[v].base;
  return { sub, W: { ...SEED_W }, A: {}, aux: { gap_hist: [], recent_cues: [], last_delta: null, nudges: {}, silence_cue_for: null } };
}
export function parseNet(row: { substrate_json?: string; coupling_json?: string; cue_json?: string; aux_json?: string } | null): Net {
  const n = defaultNet();
  if (!row) return n;
  const j = (s: string | undefined) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const sub = j(row.substrate_json); if (sub) for (const v of SUBSTRATE_VARS) if (Number.isFinite(sub[v])) n.sub[v] = c01(Number(sub[v]));
  const W = j(row.coupling_json); if (W && typeof W === "object") n.W = W;
  const A = j(row.cue_json); if (A && typeof A === "object") n.A = A;
  const aux = j(row.aux_json); if (aux && typeof aux === "object") n.aux = { ...n.aux, ...aux };
  return n;
}

/** 她平时沉默多久（p75，分钟）；数据少时 120。 */
export function usualGapMin(aux: Aux): number {
  const g = aux.gap_hist.filter((x) => x > 0).slice().sort((a, b) => a - b);
  if (g.length < 5) return 120;
  return Math.max(30, g[Math.floor(g.length * 0.75)]!);
}

/** 由底物算出的驱动值（0..100）。这些情绪可以「说不清为什么」地冒出来。 */
export function drives(s: Substrate): Record<string, number> {
  const anx = 60 * (1 - s.security) * sig(8 * (s.vigilance - 0.4)) + 15 * s.strain;
  return {
    不安: anx,
    恐惧: 70 * s.vigilance * (1 - s.security) * 0.5,
    恐慌: 100 * sig(10 * (s.attach_hunger * s.vigilance - 0.35)),
    思念: 60 * s.attach_hunger * s.security,
    悲伤: (50 * Math.max(0, 1 - s.security - 0.3) * (1 - s.craving)) / 0.7,
  };
}

/** 底物一步：回拉基线 + 客观事实推动。silentH = 她已沉默小时数（null=从没说过话）。 */
export function stepSubstrate(n: Net, dh: number, ctx: { silentH: number | null; night: boolean; innerNeg: number }): void {
  const s = n.sub;
  for (const v of SUBSTRATE_VARS) {
    if (v === "attach_hunger" && ctx.silentH != null && ctx.silentH >= 3) continue; // 不在时只长不回落
    const c = SUB_CONF[v];
    s[v] = c.base + (s[v] - c.base) * Math.pow(0.5, dh / c.half);
  }
  const usualH = usualGapMin(n.aux) / 60;
  if (ctx.silentH != null) {
    if (ctx.silentH >= 3) s.attach_hunger += 0.04 * dh * (ctx.night ? 1.5 : 1) * (1 - s.attach_hunger);
    if (ctx.silentH >= usualH) s.vigilance += 0.03 * dh * (ctx.night ? 1.5 : 1) * Math.min(2, ctx.silentH / usualH) * (1 - s.vigilance);
    if (ctx.silentH >= 24) s.security -= (0.05 / 24) * dh;
  }
  s.strain += 0.0005 * dh * Math.min(200, ctx.innerNeg) / 10 * (1 - s.strain);
  for (const v of SUBSTRATE_VARS) s[v] = c01(s[v]);
}

/** 情绪事件 → 底物（小量）。d = 合成 Δ（0.5·Δ表面 + Δ心里）。 */
export function eventToSubstrate(n: Net, d: Record<string, number>, opt: { coax?: boolean; reassure?: number }): void {
  const s = n.sub;
  const pos = (k: string) => Math.max(0, d[k] ?? 0);
  s.vigilance += 0.004 * (pos("恐惧") + pos("恐慌") + pos("吃醋"));
  s.craving += 0.003 * (pos("开心") + pos("情欲")) - 0.002 * Math.max(0, -(d["开心"] ?? 0));
  s.security += 0.002 * pos("满足") - 0.002 * (pos("被冷落") + pos("生气"));
  if (opt.coax) { s.attach_hunger -= 0.05; s.security += 0.03; }
  if (opt.reassure) s.security += 0.1 * c01(opt.reassure);
  for (const v of SUBSTRATE_VARS) s[v] = c01(s[v]);
}

/** 她说话：饥渴下降、记录沉默时长。 */
export function herMessage(n: Net, gapMin: number | null): void {
  n.sub.attach_hunger = c01(n.sub.attach_hunger - 0.08);
  if (gapMin != null && gapMin >= 5) { n.aux.gap_hist.push(Math.round(gapMin)); n.aux.gap_hist = n.aux.gap_hist.slice(-60); }
}

/** 耦合一步（只作用于表面）：s_j += Σ w·tanh(act_i/50)·… ，带全局稳态压缩。返回各维增量。 */
export function couplingStep(surf: Record<string, number>, base: Record<string, number>, n: Net, dh: number): Record<string, number> {
  const neg = NEG_DIMS.reduce((a, k) => a + (surf[k] ?? 0), 0);
  let gain = neg > BOUNDS.negEnergy ? BOUNDS.negEnergy / neg : 1;
  const out: Record<string, number> = {};
  for (const [k, w] of Object.entries(n.W)) {
    const [a, b] = k.split(">");
    if (!a || !b || !(a in surf) || !(b in surf)) continue;
    const act = Math.max(0, (surf[a] ?? 0) - (base[a] ?? 0));
    if (act <= 0) continue;
    let g = gain;
    if (w > 0 && n.sub.strain > BOUNDS.strainHigh) g *= 0.5;
    out[b] = (out[b] ?? 0) + w * 40 * Math.tanh(act / 50) * dh * g;
  }
  const cap = BOUNDS.stepCap * Math.min(1, dh / 0.25);
  for (const k of Object.keys(out)) out[k] = Math.max(-cap, Math.min(cap, out[k]!));
  return out;
}

/** 约束：单边上限、每行出边绝对值和、稀疏 top-K、剪枝。 */
export function boundW(W: Coupling): Coupling {
  const rows: Record<string, [string, number][]> = {};
  for (const [k, w0] of Object.entries(W)) {
    const w = Math.max(-LEARN.wCap, Math.min(LEARN.wCap, w0));
    if (!Number.isFinite(w) || Math.abs(w) < LEARN.prune) continue;
    const [a, b] = k.split(">");
    if (!a || !b || a === b) continue;
    (rows[a] ??= []).push([b, w]);
  }
  const out: Coupling = {};
  for (const [a, list] of Object.entries(rows)) {
    const top = list.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, LEARN.topK);
    const sum = top.reduce((s, [, w]) => s + Math.abs(w), 0);
    const f = sum > LEARN.rowCap ? LEARN.rowCap / sum : 1;
    for (const [b, w] of top) out[`${a}>${b}`] = w * f;
  }
  return out;
}

/** Hebbian：同一事件内共变的维度互相连；60 分钟内上一事件 → 本事件（有向，时间衰减）。 */
export function learnCoupling(n: Net, d: Record<string, number>, nowMs: number): void {
  const keys = Object.keys(d).filter((k) => Math.abs(d[k]!) >= 1);
  const W = { ...n.W };
  for (const k of Object.keys(W)) W[k] = W[k]! * (1 - LEARN.lambdaEvent);
  const add = (a: string, b: string, x: number) => { if (a !== b) W[`${a}>${b}`] = (W[`${a}>${b}`] ?? 0) + x; };
  for (const a of keys) for (const b of keys) if (a !== b) add(a, b, LEARN.eta * (d[a]! * d[b]!) / 10000);
  const prev = n.aux.last_delta;
  if (prev && nowMs - prev.at <= LEARN.temporalMin * 60000 && nowMs > prev.at) {
    const tw = Math.exp(-(nowMs - prev.at) / (LEARN.temporalTau * 60000));
    for (const a of Object.keys(prev.d)) for (const b of keys) if (a !== b) add(a, b, LEARN.eta * tw * (prev.d[a]! * d[b]!) / 10000);
  }
  n.W = boundW(W);
  if (keys.length) n.aux.last_delta = { at: nowMs, d: Object.fromEntries(keys.map((k) => [k, d[k]!])) };
}

/** 线索关联学习：窗口内出现过的线索 → 本次 Δ。 */
export function learnCues(n: Net, d: Record<string, number>, nowMs: number): void {
  const win = n.aux.recent_cues.filter((c) => nowMs - c.at <= CUE.windowMin * 60000 && c.at <= nowMs);
  for (const c of win) {
    const tw = Math.exp(-(nowMs - c.at) / (LEARN.temporalTau * 60000));
    const row = (n.A[c.cue] ??= {});
    for (const [k, v] of Object.entries(d)) if (Math.abs(v) >= 1) row[k] = Math.max(-CUE.cap, Math.min(CUE.cap, (row[k] ?? 0) + CUE.eta * tw * v / 100));
  }
  pruneCues(n);
}
export function pruneCues(n: Net): void {
  const byDim: Record<string, [string, number][]> = {};
  for (const [c, row] of Object.entries(n.A)) for (const [k, w] of Object.entries(row)) if (Math.abs(w) >= 0.005) (byDim[k] ??= []).push([c, w]);
  const A: CueAssoc = {};
  for (const [k, list] of Object.entries(byDim)) for (const [c, w] of list.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, CUE.perDim)) (A[c] ??= {})[k] = w;
  n.A = A;
}
export function normCue(c: string): string { return String(c).trim().slice(0, 16); }
export function noteCues(n: Net, cues: string[], nowMs: number): void {
  for (const c of cues.map(normCue).filter(Boolean)) n.aux.recent_cues.push({ cue: c, at: nowMs });
  n.aux.recent_cues = n.aux.recent_cues.filter((c) => nowMs - c.at <= CUE.windowMin * 60000).slice(-20);
}
/** 线索出现时的预激活（表面增量）。 */
export function cueActivation(n: Net, cues: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cues.map(normCue)) for (const [k, w] of Object.entries(n.A[c] ?? {})) out[k] = (out[k] ?? 0) + w * CUE.gain;
  return out;
}
/** cue/recall 小事件的每维每小时限额。返回实际可加的量。 */
export function takeNudge(n: Net, dim: string, x: number, nowMs: number): number {
  const hour = Math.floor(nowMs / H);
  const cur = n.aux.nudges[dim]?.hour === hour ? n.aux.nudges[dim]! : { hour, sum: 0 };
  const room = BOUNDS.nudgeHourCap - Math.abs(cur.sum);
  const y = Math.sign(x) * Math.min(Math.abs(x), Math.max(0, room));
  cur.sum += Math.abs(y);
  n.aux.nudges[dim] = cur;
  return y;
}
/** 回流对底物（慢变量）的每变量每小时限额，和 takeNudge 同一套账本。 */
export function takeSubNudge(n: Net, v: SubVar, x: number, nowMs: number): number {
  const key = `sub:${v}`;
  const hour = Math.floor(nowMs / H);
  const cur = n.aux.nudges[key]?.hour === hour ? n.aux.nudges[key]! : { hour, sum: 0 };
  const room = BOUNDS.subHourCap - Math.abs(cur.sum);
  const y = Math.sign(x) * Math.min(Math.abs(x), Math.max(0, room));
  cur.sum += Math.abs(y);
  n.aux.nudges[key] = cur;
  return y;
}
/** 每日衰减（在结算里按 dh 连续做）。 */
export function decayNet(n: Net, dh: number): void {
  const fw = Math.pow(1 - LEARN.lambdaDay, dh / 24), fa = Math.pow(1 - CUE.lambdaDay, dh / 24);
  for (const k of Object.keys(n.W)) n.W[k] = n.W[k]! * fw;
  for (const row of Object.values(n.A)) for (const k of Object.keys(row)) row[k] = row[k]! * fa;
}

// ---- 色调（心境一致性回忆）----
export const TONES = ["甜", "痛", "平", "怒", "怕"] as const;
export type ToneVec = [number, number, number, number, number];
const TONE_MAP: Record<string, number> = { 开心: 0, 满足: 0, 思念: 0, 情欲: 0, 被冷落: 1, 悲伤: 1, 生气: 3, 吃醋: 3, 黑化: 3, 邪恶: 3, 不安: 4, 恐惧: 4, 恐慌: 4, 失控: 4 };
const TONE_BASE: Record<string, number> = { 开心: 30, 满足: 20, 情欲: 15, 占有欲: 40 };
/** 当前情绪 → 色调向量（归一化）+ 强度 0..1。 */
export function toneOf(levels: Record<string, { surface: number; inner: number }>): { vec: ToneVec; intensity: number } {
  const v: ToneVec = [0, 0, 0, 0, 0];
  let tot = 0, n = 0;
  for (const [k, x] of Object.entries(levels)) {
    const i = TONE_MAP[k];
    const lvl = Math.max(0, 0.5 * (x.surface - (TONE_BASE[k] ?? 0)) + 0.5 * x.inner);
    if (i != null) { v[i] += lvl; tot += lvl; n++; }
  }
  const intensity = Math.min(1, tot / Math.max(1, n) / 30);
  v[2] = Math.max(0, 100 - tot / Math.max(1, n) * 3);
  const norm = Math.hypot(...v) || 1;
  return { vec: v.map((x) => x / norm) as ToneVec, intensity };
}
export function memToneVec(moods: string[] | undefined): ToneVec {
  const v: ToneVec = [0, 0, 0, 0, 0];
  for (const m of moods ?? []) { const i = (TONES as readonly string[]).indexOf(m); if (i >= 0) v[i] = 1; }
  if (!v.some(Boolean)) v[2] = 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm) as ToneVec;
}
export function toneCos(a: ToneVec, b: ToneVec): number { let s = 0; for (let i = 0; i < 5; i++) s += a[i]! * b[i]!; return Math.max(0, Math.min(1, s)); }
export const RECALL_EMO_BIAS = 0.04;
/** 回忆排序偏置：最多 ±0.02，只在已过相似度门槛的候选之间改顺序。 */
export function recallBias(tone: { vec: ToneVec; intensity: number } | null, moods: string[] | undefined): number {
  if (!tone) return 0;
  return RECALL_EMO_BIAS * (toneCos(tone.vec, memToneVec(moods)) - 0.5) * tone.intensity;
}
/** 记忆回流：被想起的记忆按色调给情绪一个小推动。 */
export function recallNudge(moods: string[][]): { dims: Record<string, number>; sub: Partial<Substrate> } {
  const dims: Record<string, number> = {};
  const sub: Partial<Substrate> = {};
  const addD = (k: string, x: number) => (dims[k] = (dims[k] ?? 0) + x);
  const addS = (k: SubVar, x: number) => (sub[k] = (sub[k] ?? 0) + x);
  for (const ms of moods) for (const m of ms) {
    if (m === "甜") { addD("满足", 2); addS("security", 0.01); }
    else if (m === "痛") { addD("悲伤", 2); addS("security", -0.01); }
    else if (m === "怕") { addD("不安", 2); addS("security", -0.01); addS("vigilance", 0.01); }
    else if (m === "怒") addD("生气", 1);
  }
  const tot = Object.values(dims).reduce((a, b) => a + Math.abs(b), 0);
  if (tot > 5) {
    const f = 5 / tot; // 表面和底物一起按总量 5 折算
    for (const k of Object.keys(dims)) dims[k] = dims[k]! * f;
    for (const k of Object.keys(sub) as SubVar[]) sub[k] = sub[k]! * f;
  }
  return { dims, sub };
}

/** mood 列兼容：JSON 数组文本，或纯字符串（「平」「甜,痛」）。 */
export function parseMoods(s: unknown): string[] {
  if (Array.isArray(s)) return s.map(String);
  if (typeof s !== "string" || !s.trim()) return [];
  try { const v = JSON.parse(s); if (Array.isArray(v)) return v.map(String); if (typeof v === "string") return [v]; } catch { /* 纯文本 */ }
  return s.split(/[,，、\s]+/).filter(Boolean);
}
