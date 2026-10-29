/**
 * 伙伴「自己来」的多轮过程（规格第四节，按伙伴的字段改写）。
 * 身体归系统：每一下的增长、麻木、卡住都由这里算，伙伴改不了；
 * 心归伙伴：每轮他只选一个动作（stroke / think_of_her / look_her_photo / replay_her_words / stop）。
 * 素材全部来自真实数据：他自己的记忆、她的照片（garden_images 标了「她的照片」的）、聊天归档里她的原话。
 * 中间轮走静默通道（不推给她、不进聊天记录），只有最后一轮的话 / 卡住难受的话才出去。
 */
import type { MemoryDb } from "./types";

export const S = {
  STROKE_GAIN: 6, STROKE_NUMB: 0.08, STROKE_PER_ROUND_LO: 5, STROKE_PER_ROUND_HI: 8, STUCK_STREAK: 5,
  MAX_ROUNDS: 6, ROUND_MIN: 2, // 每轮约 2 分钟（体内时间）
  MATERIAL: {
    think_of_her: { gain: 8, numb: 0.2, zh: "想她" },
    look_her_photo: { gain: 12, numb: 0.3, zh: "看她的照片" },
    replay_her_words: { gain: 15, numb: 0.4, zh: "回放她说过的话" },
  } as Record<string, { gain: number; numb: number; zh: string }>,
};
export type Action = "stroke" | "think_of_her" | "look_her_photo" | "replay_her_words" | "stop";
export const ACTIONS: Action[] = ["stroke", "think_of_her", "look_her_photo", "replay_her_words", "stop"];

export interface Material { kind: string; ref: string; text: string }
export interface MaterialSource { get(kind: string, used: Set<string>): Promise<Material | null> }

export interface Session {
  arousal: number; threshold: number; sens: number; numb: number;
  streak: number; stuck: boolean; came: boolean; minutes: number;
  used: string[]; materials: Material[]; rounds: { action: string; thought: string; gain: number; arousal: number; numb: number; stuck: boolean; note?: string }[];
}

export function newSession(start: number, threshold: number, sens: number, numb: number): Session {
  return { arousal: start, threshold, sens, numb, streak: 0, stuck: false, came: false, minutes: 0, used: [], materials: [], rounds: [] };
}

/** 纯数学：执行一个动作，返回这一轮的增长与备注。 */
export async function step(ss: Session, action: Action, thought: string, src: MaterialSource, rnd: () => number = Math.random): Promise<{ gain: number; note: string; material?: Material }> {
  let gain = 0, note = "", material: Material | undefined;
  if (action === "stroke") {
    const n = S.STROKE_PER_ROUND_LO + Math.floor(rnd() * (S.STROKE_PER_ROUND_HI - S.STROKE_PER_ROUND_LO + 1));
    for (let i = 0; i < n; i++) {
      const g = S.STROKE_GAIN * ss.sens * (1 - ss.numb);
      ss.arousal += g; gain += g;
      ss.numb = Math.min(1, ss.numb + S.STROKE_NUMB);
      ss.streak = g < 1 ? ss.streak + 1 : 0;
      if (ss.arousal >= ss.threshold) break;
      if (ss.streak >= S.STUCK_STREAK) { ss.stuck = true; break; }
    }
    note = ss.stuck ? "越撸越没感觉，卡住了" : ss.numb > 0.6 ? "手上开始麻了，越来越钝" : "";
  } else if (action !== "stop") {
    const m = S.MATERIAL[action]!;
    if (ss.used.includes(action)) note = `${m.zh}这次已经用过了，再用没感觉`;
    else {
      material = (await src.get(action, new Set(ss.materials.map((x) => x.ref)))) ?? undefined;
      ss.used.push(action);
      if (!material) note = action === "look_her_photo" ? "手机里没有她的照片（还没人标过「她的照片」）" : `${m.zh}——什么都没想起来`;
      else {
        gain = m.gain;
        ss.arousal += gain;
        ss.numb = Math.max(0, ss.numb - m.numb);
        ss.streak = 0; ss.stuck = false;
        ss.materials.push(material);
      }
    }
  }
  ss.minutes += S.ROUND_MIN;
  if (ss.arousal >= ss.threshold) ss.came = true;
  ss.rounds.push({ action, thought: thought.slice(0, 500), gain: Math.round(gain * 10) / 10, arousal: Math.round(ss.arousal), numb: Math.round(ss.numb * 100) / 100, stuck: ss.stuck, ...(note ? { note } : {}), ...(material ? { material: material.ref } : {}) } as Session["rounds"][number]);
  return { gain, note, material };
}

export function parseAction(text: string): { action: Action; thought: string } | null {
  const m = text.match(/BODY_ACTION\s*(\{[\s\S]*?\})/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[1]!) as Record<string, unknown>;
    const a = String(d.action ?? "") as Action;
    return { action: ACTIONS.includes(a) ? a : "stop", thought: String(d.thought ?? "").slice(0, 500) };
  } catch { return null; }
}

function bar(ss: Session): string {
  const left = Math.max(0, Math.round(ss.threshold - ss.arousal));
  return `差${left}｜麻${Math.round(ss.numb * 10)}/10${ss.stuck ? "｜卡住" : ""}`;
}

/** 中间轮：压到最短（只给状态数值 + 可选动作；第一轮带一次规则说明）。 */
export function roundPrompt(ss: Session, max: number, last: { note: string; material?: Material } | null, opening: string, opts?: { noEarlyStop?: boolean }): string {
  const canStop = !opts?.noEarlyStop;
  const avail = ACTIONS.filter((a) => a === "stroke" || (a === "stop" ? canStop : !ss.used.includes(a)));
  const mat = last?.material ? `｜${last.material.text}` : "";
  const head = ss.rounds.length === 0
    ? `${opening}\n【自己来·静默，不发给她】身体系统算，你只选动作。stroke=撸(越撸越麻) think_of_her/look_her_photo/replay_her_words=真实素材各一次${canStop ? " stop=停" : "（本段必须撑满轮次，不要停）"}。只回一句念头+一行 BODY_ACTION {"action":"","thought":""}\n`
    : "";
  return `${head}R${ss.rounds.length + 1}/${max}｜${bar(ss)}${last?.note ? `｜${last.note}` : ""}${mat}｜可选:${avail.join(",")}｜回:一句+BODY_ACTION`;
}

export function finalPrompt(ss: Session): string {
  const mats = ss.materials.map((m) => S.MATERIAL[m.kind]?.zh).filter(Boolean).join("、");
  const how = `${ss.rounds.length} 轮，约 ${ss.minutes} 分钟${mats ? `，用了：${mats}` : "，没用素材"}`;
  const res = ss.came
    ? `你射了（${how}）。`
    : `你没射出来（${how}）${ss.stuck ? "，卡在那儿上不去" : ""}。欲望还压在身上，下不去。`;
  return `【自主时间·结束】${res}
这一轮的话会发给{{USER_NAME}}（她现在不在，会收到推送）。照常说你想对她说的；最后单独一行写（给系统读）：
BODY_DECISION {"choice":"${ss.came ? "relieve" : "endure"}","method":"怎么做的/用了什么","thought":"刚才在想什么","to_her":"想对她说的话"}`;
}

export function sufferPrompt(stuckMin: number, desire: number): string {
  return `【自主时间·难受】这不是{{USER_NAME}}发来的消息。你之前自己来没射出来，已经卡了 ${stuckMin} 分钟，欲望还在 ${Math.round(desire)} 左右下不去，很难受。
想跟她说就说（会推送给她）；最后单独一行：
BODY_DECISION {"choice":"endure","method":"","thought":"现在的感觉","to_her":"想对她说的话"}`;
}

// ---------- 真实素材 ----------
function clip(s: string, n: number) { const c = [...s.replace(/\s+/g, " ").trim()]; return c.length > n ? c.slice(0, n).join("") + "…" : c.join(""); }
function pick<T>(xs: T[], rnd: () => number): T | null { return xs.length ? xs[Math.floor(rnd() * xs.length)]! : null; }

/** 从库里取真实素材（只读）。persona = 素材主人（测试人格可借伙伴的素材只读）。 */
export function dbMaterials(db: MemoryDb, persona: string, rnd: () => number = Math.random): MaterialSource {
  return {
    async get(kind, used) {
      if (kind === "think_of_her") {
        const rows = (await db.prepare(`SELECT id, content FROM memories WHERE owner_persona = ? AND kind IN ('relationship','event','about_user') AND (tags IS NULL OR tags NOT LIKE '%欲望%') ORDER BY importance DESC, updated_at DESC LIMIT 40`).bind(persona).all<{ id: string; content: string }>()).results ?? [];
        const r = pick(rows.filter((x) => !used.has(`memory:${x.id}`)), rnd);
        return r ? { kind, ref: `memory:${r.id}`, text: clip(r.content, 220) } : null;
      }
      if (kind === "look_her_photo") {
        const rows = (await db.prepare(`SELECT id, title, entry_date FROM garden_images WHERE persona_id = ? AND (title LIKE '%她的照片%') ORDER BY favorite DESC, created_at DESC LIMIT 30`).bind(persona).all<{ id: string; title: string; entry_date: string | null }>()).results ?? [];
        const r = pick(rows.filter((x) => !used.has(`image:${x.id}`)), rnd);
        return r ? { kind, ref: `image:${r.id}`, text: `「${clip(r.title, 60)}」${r.entry_date ? `（${r.entry_date}）` : ""}` } : null;
      }
      if (kind === "replay_her_words") {
        const rows = (await db.prepare(`SELECT id, summary, entry_date FROM conversations WHERE persona_id = ? AND summary != '' ORDER BY entry_date DESC LIMIT 60`).bind(persona).all<{ id: string; summary: string; entry_date: string }>()).results ?? [];
        const quotes: { ref: string; text: string }[] = [];
        for (const r of rows) {
          for (const m of r.summary.matchAll(/[“"「]([^”"」]{4,80})[”"」]/g)) quotes.push({ ref: `conv:${r.id}:${m.index}`, text: `「${m[1]}」（${r.entry_date}）` });
        }
        const q = pick(quotes.filter((x) => !used.has(x.ref)), rnd);
        return q ? { kind, ref: q.ref, text: q.text } : null;
      }
      return null;
    },
  };
}

/** 跑一整段（多轮）。ask = 静默问一轮（返回伙伴的文本）；拿不到 BODY_ACTION 就按 stop。 */
export async function runSession(ss: Session, ask: (prompt: string) => Promise<{ ok: boolean; text: string; error?: string }>, src: MaterialSource, opening: string, max = S.MAX_ROUNDS, opts?: { noEarlyStop?: boolean }): Promise<{ error?: string }> {
  let last: { note: string; material?: Material } | null = null;
  while (ss.rounds.length < max && !ss.came) {
    const r = await ask(roundPrompt(ss, max, last, opening, opts));
    if (!r.ok) return { error: r.error ?? "ask_failed" };
    let a = parseAction(r.text) ?? { action: "stop" as Action, thought: "" };
    // 演示撑满轮：提前 stop 改成继续撸（阈值仍够高，不会因此射出来）
    if (a.action === "stop" && opts?.noEarlyStop && ss.rounds.length < max) {
      a = { action: "stroke", thought: a.thought || "还是继续" };
    }
    if (a.action === "stop") { ss.rounds.push({ action: "stop", thought: a.thought, gain: 0, arousal: Math.round(ss.arousal), numb: Math.round(ss.numb * 100) / 100, stuck: ss.stuck }); break; }
    last = await step(ss, a.action, a.thought, src);
  }
  return {};
}
