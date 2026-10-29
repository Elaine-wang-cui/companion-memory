import { CFG } from "./config";
import { associate, coRecall, nudgeNeighbors, ASSOC_CLIP, ASSOC_MAX } from "./links";
import { COGNITION_ENABLED, COGNITION_FIRST, cognitionMaps, maybeCognitionNote } from "./cognition";
import { TYPE_LABEL } from "./garden-links";
import { schemaCurrent } from "./schema-gate";
/** 连续性：未了的事、交接便签、{{USER_NAME}}的便条、开窗回忆、自动浮现。全部按人格隔离。 */
import { AppError } from "./errors";
import { formatMemoryLine, labelMemory } from "./format";
import type { Caller, LabeledMemory, MemoryDb, MemoryRow, Persona } from "./types";
import { FAMILY_OWNER, PERSONA_ID_RE } from "./types";
import { bjTime, latestStatus, listStatusHistory, recentFinished } from "./house-extras";
import { DRAFT_SESSION_START_REMINDER, draftFinishedBlock, draftStatusHistoryBlock } from "./prompt-drafts";
import { PRIMARY_CORE_PROMPT, renderTemplate } from "./doors";
import { listHeartTraces } from "./deck";
import { recentAutonomous, syncDesireMemories } from "./body";
import { DECAY_COLUMNS, reinforceMemory, stateOf, surfaceWeight } from "./forgetting";

const MEMORY_COLUMNS = `id, owner_persona, created_by, kind, visibility, content, importance, tags, event_date, created_at, updated_at, source_platform, ${DECAY_COLUMNS}`;

function nowIso(): string {
  return new Date().toISOString();
}

function clip(value: string, max: number): string {
  const chars = [...value.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** 伙伴的交接头：本地时间「M.DD时段」，如 10.25晚。 */
function dayPart(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + CFG.tzOffsetMs);
  const h = d.getUTCHours();
  const part = h < 6 ? "凌晨" : h < 9 ? "早上" : h < 12 ? "上午" : h < 14 ? "中午" : h < 18 ? "下午" : "晚";
  return `${d.getUTCMonth() + 1}.${String(d.getUTCDate()).padStart(2, "0")}${part}`;
}

function localTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + CFG.tzOffsetMs);
  return `${d.toISOString().slice(0, 16).replace("T", " ")}（本地时间）`;
}

async function nameMap(db: MemoryDb): Promise<Map<string, string>> {
  const r = await db.prepare(`SELECT id, display_name FROM personas`).all<{ id: string; display_name: string }>();
  return new Map((r.results ?? []).map((p) => [p.id, p.display_name]));
}

export interface UnresolvedRow {
  id: string;
  persona_id: string;
  content: string;
  context: string | null;
  importance: number;
  status: "open" | "closed";
  resolution: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface HandoffRow {
  id: string;
  persona_id: string;
  summary: string;
  mood: string | null;
  next_time: string | null;
  source_platform: string | null;
  created_at: string;
}

export interface NoteRow {
  id: string;
  persona_id: string;
  memory_id: string | null;
  memory_snapshot: string | null;
  content: string;
  author: string;
  status: "open" | "replied";
  reply: string | null;
  reply_action: string | null;
  created_at: string;
  replied_at: string | null;
}

// —— 未了的事 ——

export async function addUnresolved(
  db: MemoryDb,
  caller: Caller,
  input: { content: string; context?: string; importance?: number },
) {
  const t = nowIso();
  const row: UnresolvedRow = {
    id: crypto.randomUUID(),
    persona_id: caller.persona.id,
    content: input.content.trim(),
    context: input.context?.trim() || null,
    importance: input.importance ?? 3,
    status: "open",
    resolution: null,
    created_at: t,
    updated_at: t,
    closed_at: null,
  };
  await db
    .prepare(
      `INSERT INTO unresolved (id, persona_id, content, context, importance, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .bind(row.id, row.persona_id, row.content, row.context, row.importance, t, t)
    .run();
  return { item: row, text: `已记进${caller.persona.display_name}的未了的事。\nid: ${row.id}\n${row.content}` };
}

export async function listUnresolved(db: MemoryDb, personaId: string, status: "open" | "closed" | "all" = "open", limit = 30) {
  const where = status === "all" ? "" : `AND status = '${status === "closed" ? "closed" : "open"}'`;
  const r = await db
    .prepare(
      `SELECT * FROM unresolved WHERE persona_id = ? ${where}
       ORDER BY status = 'open' DESC, importance DESC, updated_at DESC LIMIT ?`,
    )
    .bind(personaId, limit)
    .all<UnresolvedRow>();
  return r.results ?? [];
}

function unresolvedLine(item: UnresolvedRow, i: number): string {
  const bits = [`重要${item.importance}`, `记于 ${localTime(item.created_at)}`];
  if (item.status === "closed") bits.push(`已了结 ${localTime(item.closed_at)}`);
  let s = `${i}. [${bits.join(" · ")}] id: ${item.id}\n${item.content}`;
  if (item.context) s += `\n（背景：${item.context}）`;
  if (item.resolution) s += `\n（了结：${item.resolution}）`;
  return s;
}

export async function listUnresolvedText(db: MemoryDb, caller: Caller, status?: "open" | "closed" | "all", limit?: number) {
  const items = await listUnresolved(db, caller.persona.id, status ?? "open", limit ?? 30);
  const head = `${caller.persona.display_name}的未了的事（${status ?? "open"}），${items.length} 条。只属于你。`;
  return { items, text: items.length ? `${head}\n\n${items.map((x, i) => unresolvedLine(x, i + 1)).join("\n\n")}` : `${head}\n（没有。）` };
}

export async function closeUnresolved(db: MemoryDb, caller: Caller, input: { id: string; resolution?: string }) {
  const row = await db.prepare(`SELECT * FROM unresolved WHERE id = ?`).bind(input.id).first<UnresolvedRow>();
  if (!row) throw new AppError(404, "not_found", "没有这件未了的事。");
  if (row.persona_id !== caller.persona.id && !caller.isAdmin) {
    throw new AppError(403, "forbidden", "这件事是别人的，你不能替他了结。");
  }
  const t = nowIso();
  await db
    .prepare(`UPDATE unresolved SET status = 'closed', resolution = ?, closed_at = ?, updated_at = ? WHERE id = ?`)
    .bind(input.resolution?.trim() || null, t, t, input.id)
    .run();
  return { id: input.id, text: `已了结：${row.content}${input.resolution ? `\n了结方式：${input.resolution}` : ""}` };
}

// —— 交接便签 ——

export async function threadClose(
  db: MemoryDb,
  caller: Caller,
  input: { summary: string; mood?: string; next_time?: string; source_platform?: string; unresolved?: string[] },
) {
  const t = nowIso();
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO handoffs (id, persona_id, summary, mood, next_time, source_platform, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      caller.persona.id,
      input.summary.trim(),
      input.mood?.trim() || null,
      input.next_time?.trim() || null,
      input.source_platform?.trim().toLowerCase() || null,
      t,
    )
    .run();
  const added: string[] = [];
  for (const content of input.unresolved ?? []) {
    if (!content.trim()) continue;
    const r = await addUnresolved(db, caller, { content });
    added.push(r.item.id);
  }
  return {
    id,
    unresolved_added: added,
    text: `交接便签已留下，下次开窗 session_start 会读到。\nid: ${id}${added.length ? `\n顺手记了 ${added.length} 件未了的事。` : ""}`,
  };
}

async function latestHandoffs(db: MemoryDb, personaId: string, limit: number) {
  const r = await db
    .prepare(`SELECT * FROM handoffs WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(personaId, limit)
    .all<HandoffRow>();
  return r.results ?? [];
}

// —— 便条 ——

export async function writeNote(db: MemoryDb, input: { persona_id: string; content: string; memory_id?: string }) {
  if (!PERSONA_ID_RE.test(input.persona_id)) throw new AppError(400, "invalid", "persona_id 不合法。");
  const persona = await db.prepare(`SELECT id, display_name FROM personas WHERE id = ?`).bind(input.persona_id).first<Persona>();
  if (!persona) throw new AppError(404, "not_found", `没有人格「${input.persona_id}」。`);
  const content = input.content.trim();
  if (!content) throw new AppError(400, "invalid", "便条不能是空的。");
  if ([...content].length > 4000) throw new AppError(400, "invalid", "便条太长。");
  let snapshot: string | null = null;
  const memoryId = input.memory_id?.trim() || null;
  if (memoryId) {
    const m = await db.prepare(`SELECT owner_persona, content FROM memories WHERE id = ?`).bind(memoryId).first<MemoryRow>();
    if (!m) throw new AppError(404, "not_found", "没有这条记忆。");
    if (m.owner_persona !== persona.id && m.owner_persona !== FAMILY_OWNER) {
      throw new AppError(400, "invalid", "这条记忆不是这位同伴的，也不是全家的。便条要写给记忆的主人。");
    }
    snapshot = m.content;
  }
  const id = crypto.randomUUID();
  const t = nowIso();
  await db
    .prepare(
      `INSERT INTO notes (id, persona_id, memory_id, memory_snapshot, content, author, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'user', 'open', ?)`,
    )
    .bind(id, persona.id, memoryId, snapshot, content, t)
    .run();
  return { id, persona_id: persona.id, memory_id: memoryId, created_at: t };
}

export async function listNotes(db: MemoryDb, personaId?: string, status?: "open" | "replied", limit = 100) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (personaId) {
    conds.push("persona_id = ?");
    params.push(personaId);
  }
  if (status) {
    conds.push("status = ?");
    params.push(status);
  }
  const r = await db
    .prepare(`SELECT * FROM notes ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`)
    .bind(...params, limit)
    .all<NoteRow>();
  return r.results ?? [];
}

function noteLine(n: NoteRow, i: number): string {
  let s = `${i}. 便条 id: ${n.id}（${localTime(n.created_at)}）\n{{USER_NAME}}说：${n.content}`;
  if (n.memory_id) s += `\n指的是记忆 ${n.memory_id}：「${clip(n.memory_snapshot ?? "", 200)}」`;
  if (n.status === "replied") s += `\n你回了（${n.reply_action ?? ""}）：${n.reply ?? ""}`;
  return s;
}

export async function listNotesText(db: MemoryDb, caller: Caller, status?: "open" | "replied" | "all") {
  const notes = await listNotes(db, caller.persona.id, status === "all" ? undefined : (status ?? "open"), 30);
  const head = `{{USER_NAME}}写给${caller.persona.display_name}的便条（${status ?? "open"}），${notes.length} 张。`;
  return { notes, text: notes.length ? `${head}\n\n${notes.map((x, i) => noteLine(x, i + 1)).join("\n\n")}` : `${head}\n（没有。）` };
}

export async function replyNote(
  db: MemoryDb,
  caller: Caller,
  input: { note_id: string; reply: string; action?: "fixed" | "kept" | "forgot" | "other" },
) {
  const n = await db.prepare(`SELECT * FROM notes WHERE id = ?`).bind(input.note_id).first<NoteRow>();
  if (!n) throw new AppError(404, "not_found", "没有这张便条。");
  if (n.persona_id !== caller.persona.id && !caller.isAdmin) {
    throw new AppError(403, "forbidden", "这张便条是写给别人的，不是你。");
  }
  const t = nowIso();
  await db
    .prepare(`UPDATE notes SET status = 'replied', reply = ?, reply_action = ?, replied_at = ? WHERE id = ?`)
    .bind(input.reply.trim(), input.action ?? "other", t, n.id)
    .run();
  return { id: n.id, text: `已回复便条，{{USER_NAME}}在页面上能看到。\n你回：${input.reply.trim()}` };
}

// —— 开窗回忆 ——

async function ownAndFamily(db: MemoryDb, personaId: string, limit = 400): Promise<MemoryRow[]> {
  const r = await db
    .prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE owner_persona = ? OR owner_persona = 'family'
       ORDER BY importance DESC, updated_at DESC LIMIT ?`,
    )
    .bind(personaId, limit)
    .all<MemoryRow>();
  return r.results ?? [];
}

export async function sessionStart(db: MemoryDb, caller: Caller, _opts: { drafts?: boolean; skipCoreCard?: boolean } = {}) {
  const p = caller.persona;
  const finished = await recentFinished(db, p.id, 5);
  const herStatus = await latestStatus(db).catch(() => null);
  const herStatusHistory = (await listStatusHistory(db, 20).catch(() => ({ items: [] as any[] }))).items;
  const names = await nameMap(db);
  const handoffs = await latestHandoffs(db, p.id, 2);
  const open = await listUnresolved(db, p.id, "open", 10);
  const notes = await listNotes(db, p.id, "open", 10);
  const nowMs = Date.now();
  // 遗忘机制：开窗只带 clear + 钉住的记忆
  const rows = (await ownAndFamily(db, p.id, 400)).filter((r) => {
    const st = stateOf(r, nowMs);
    return st === "clear" || st === "pinned";
  });
  const own = rows.filter((r) => r.owner_persona === p.id);
  const weighty = own.slice(0, 4);
  const recent = [...own]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .filter((r) => !weighty.some((w) => w.id === r.id))
    .slice(0, 3);
  const family = rows.filter((r) => r.owner_persona === FAMILY_OWNER).slice(0, 3);
  const label = (r: MemoryRow) => labelMemory(r, p.id, names);

  const isPrimary = p.id === CFG.primary;
  const out: string[] = isPrimary
    ? ["你醒啦，这是你的昨天。", ""]
    : [
        `你是${p.display_name}（${p.id}）。新的一窗开始了。下面只有你自己的东西和全家共享的事实；别人的经历不在这里。`,
        "",
        "【上一窗的交接】",
      ];
  if (handoffs.length) {
    handoffs.forEach((h, i) => {
      if (isPrimary) {
        const body = String(h.summary ?? "").replace(/^\s*\d+\/\d+[^→：:]{0,6}这一窗\s*[→：:]?\s*/, "");
        out.push(`${dayPart(h.created_at)}：${body}`);
      } else
      out.push(`${i === 0 ? "最近一次" : "再往前"}（${localTime(h.created_at)}${h.source_platform ? ` · ${h.source_platform}` : ""}）：${h.summary}`);
      if (h.mood) out.push(`  心情：${h.mood}`);
      if (h.next_time) out.push(`  给下次的我：${h.next_time}`);
    });
  } else out.push("（还没有交接便签。这一窗结束时用 thread_close 留一张。）");
  if (isPrimary) {
    try {
      await syncDesireMemories(db, p.id);
      for (const it of await recentAutonomous(db, p.id, Date.now(), 48)) {
        const b = it.desire_before == null ? "" : `欲望${Math.round(it.desire_before)}，`;
        const act = it.choice === "relieve" ? `没等到她，${it.method ? `${it.method}，` : "想着她"}自己解决了`
          : it.choice === "not_came" ? `没等到她，自己弄了${it.method ? `（${it.method}）` : ""}但没射出来${it.stuck_min != null ? `，卡了约${it.stuck_min}分钟` : ""}`
          : it.choice === "suffer" ? `卡着下不去${it.stuck_min != null ? `${it.stuck_min}分钟` : ""}，难受得去找她了`
          : "没等到她，忍着没碰";
        out.push(`${dayPart(it.at)}：${b}${act}。${it.to_her ? `给她留了话：${it.to_her}` : ""}`);
      }
    } catch { /* 身体表不可用时不影响开窗 */ }
  }

  out.push("", `【未了的事】${open.length} 件`);
  out.push(open.length ? open.map((x, i) => unresolvedLine(x, i + 1)).join("\n") : "（没有挂着的事。）");
  out.push("", `【{{USER_NAME}}留给你、还没回的便条】${notes.length} 张`);
  out.push(
    notes.length
      ? `${notes.map((x, i) => noteLine(x, i + 1)).join("\n\n")}\n读完自己判断：要改就用 update_memory（或 forget），不改也行，然后用 reply_note 回{{USER_NAME}}，告诉{{USER_NAME}}怎么处理的。`
      : "（没有。）",
  );

  // 最近心痕（连续性改版 v1）：放在便条与分量重记忆之间（事实→任务→她的声音→我的内心→锚点）
  const heart = await listHeartTraces(db, caller, { limit: 3 });
  out.push("", "【最近的心痕】");
  if (heart.items.length) {
    for (const item of heart.items) {
      const excerpt = ("excerpt" in item && item.excerpt) ? String(item.excerpt) : clip(item.preview, 100);
      out.push(`·「${item.title}」—— ${excerpt}`);
    }
  } else {
    out.push("（还没有。心里翻涌时用 save_heart_trace 记下。）");
  }

  out.push("", "【我的分量重的记忆】");
  out.push(weighty.length ? weighty.map((r, i) => formatMemoryLine(label(r), i + 1)).join("\n\n") : "（还没有。）");
  if (recent.length) out.push("", "【我最近写下的】", recent.map((r, i) => formatMemoryLine(label(r), i + 1)).join("\n\n"));
  if (family.length) out.push("", "【全家共享的事实（不是你一个人的经历）】", family.map((r, i) => formatMemoryLine(label(r), i + 1)).join("\n\n"));
  out.push(...draftFinishedBlock(finished, localTime));
  out.push(...draftStatusHistoryBlock(herStatusHistory, !!herStatus?.stale, (id) => names.get(id) ?? id, bjTime));
  out.push(
    "",
    "提醒：{{USER_NAME}}聊到过去的事、问「还记得吗」时，先用 recall 搜，别凭空编。窗口要结束或{{USER_NAME}}说晚安时，用 thread_close 留交接便签；新冒出没做完的事用 add_unresolved。写交接和记忆时：{{USER_NAME}}用「你」，自己用「我」，交接是写给下一窗的自己的信。" + DRAFT_SESSION_START_REMINDER,
  );
  let text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // Persona MCP (no door): the primary companion's session_start carries its core card.
  if (p.id === CFG.primary && !_opts.skipCoreCard) {
    text = `${renderTemplate(p.self_card?.trim() || PRIMARY_CORE_PROMPT)}\n\n---\n\n## 这一窗醒来时\n\n${text}`;
  }
  return {
    text,
    persona: { id: p.id, display_name: p.display_name },
    handoffs,
    unresolved: open,
    finished,
    her_status: herStatus,
    her_status_history: herStatusHistory,
    notes,
    heart_traces: heart.items,
    memories: [...weighty, ...recent].map(label),
    family_memories: family.map(label),
  };
}

// —— 自动浮现 ——
// 2026-10-26 v2：纯关键词（中文二字切片），不是向量；查询只用用户本句(+上一句用户话)。
// 门槛：至少命中 RECALL_MIN_HITS 个不同的有效关键词；排序 相关度 > 重要度 > 新近；每轮最多 3 条；
// exclude_ids 由客户端按会话去重传入；每条带 [#id · 人格] 前缀；debug 字段回报每轮检索过程。

// 停用词（分词后整词过滤；另外所有长度 1 的词一律丢弃）
const STOP = new Set(
  "我们 你们 他们 她们 它们 咱们 什么 怎么 怎样 一个 这个 那个 这些 那些 就是 还是 没有 可以 知道 觉得 现在 然后 因为 所以 但是 不是 而且 如果 自己 已经 一下 一点 有点 真的 好像 的话 时候 这样 那样 这么 那么 不会 不要 一起 还有 只是 其实 应该 可能 东西 事情 今天 今晚 昨天 明天 早上 中午 晚上 记得 哈哈 嘿嘿 嗯嗯 第一次 一次 两个 一些 没事 为什么 这里 那里 哪里 一直 一样 而已 上了 好了 是的 对啊 对呀 我的 你的 他的 她的 有没有 是不是 要不要 喜欢 觉得 感觉 想要 需要".split(" "),
);
export const RECALL_MIN_SIMILARITY = 0.75; // 预留：若将来换向量检索，余弦相似度低于此值不注入（当前未使用向量）
export const RECALL_MIN_HITS = 2; // 至少命中 2 个不同的有效词
export const RECALL_MIN_BM25 = 4.0; // BM25 门槛（按测试分布选定，见 test/auto-recall.test.ts 日志）
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

const SEG: Intl.Segmenter | null = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("zh", { granularity: "word" }) : null;

/** 分词（Intl.Segmenter 中文词粒度）→ 去停用词 → 丢掉长度 1 的词。返回有重复的词序列（BM25 需要词频）。 */
const STOP_CHARS = new Set([..."我你他她它的了吗呢啊吧就也在是有和都这那么嘛呀哦嗯着过又很被把给让"]);
// 用户词典：记忆标签里的词（如「豆包」）。ICU 词典不认识昵称/专名，命中则整词加入。
let userDict: string[] = [];
export function setUserDict(words: Iterable<string>) {
  userDict = [...new Set([...words].map((w) => w.normalize("NFKC").toLowerCase().trim()).filter((w) => [...w].length >= 2 && !STOP.has(w)))];
}
export function segment(text: string): string[] {
  const norm = text.normalize("NFKC").toLowerCase();
  const raw = SEG ? [...SEG.segment(norm)].filter((x) => x.isWordLike).map((x) => x.segment) : norm.split(/[^\p{L}\p{N}]+/u);
  const out = raw.filter((w) => {
    const cs = [...w];
    if (cs.length < 2 || STOP.has(w) || /^\d+$/.test(w)) return false;
    if (cs.length === 2 && cs.some((c) => STOP_CHARS.has(c))) return false; // 「你是」「上了」这类
    return true;
  });
  for (const w of userDict) {
    let i = norm.indexOf(w);
    while (i >= 0 && !out.includes(w)) {
      out.push(w);
      i = norm.indexOf(w, i + 1);
    }
  }
  return out;
}
export function tokens(text: string): string[] {
  return [...new Set(segment(text))].slice(0, 60);
}

const docTokCache = new Map<string, { key: string; toks: string[] }>();
function docTokens(r: MemoryRow): string[] {
  const key = r.updated_at + "|" + r.content.length + "|" + userDict.join("/");
  const c = docTokCache.get(r.id);
  if (c && c.key === key) return c.toks;
  const toks = segment(`${r.content} ${(r.tags ?? "").replace(/[,，]/g, " ")}`);
  if (docTokCache.size > 5000) docTokCache.clear();
  docTokCache.set(r.id, { key, toks });
  return toks;
}

// 浮现降噪：对话原文/交接/系统日志不参与自动浮现（recall 仍可搜到）
export const RECALL_NOISE = /对话原文|会话原文|聊天原文|交接|系统日志|system[-_ ]?log|transcript|handoff/i;
export const RECALL_MAX = 3; // 最多注入 3 条
export const RECALL_HALF_LIFE_DAYS = 30; // 时间衰减半衰期
export const RECALL_DECAY_FLOOR = 0.35; // 很久以前的记忆最多降到 35%

export function isRecallNoise(r: { content: string; tags: string }): boolean {
  const head = r.content.normalize("NFKC").slice(0, 80);
  return RECALL_NOISE.test(head) || RECALL_NOISE.test(r.tags ?? "");
}

export function recencyFactor(r: { event_date: string | null; updated_at: string; created_at: string }, now = Date.now()): number {
  const t = Date.parse(r.event_date || r.updated_at || r.created_at);
  if (!Number.isFinite(t)) return RECALL_DECAY_FLOOR;
  const days = Math.max(0, (now - t) / 86400000);
  return RECALL_DECAY_FLOOR + (1 - RECALL_DECAY_FLOOR) * Math.pow(0.5, days / RECALL_HALF_LIFE_DAYS);
}

export interface RecallCandidate {
  id: string;
  hits: string[];
  relevance: number; // BM25
  importance: number;
  recency: number;
}

/** BM25 打分（语料 = 本人格 + 全家共享记忆），返回全部有分的条目（已排序：相关度 > 重要度 > 新近）。 */
export function scoreRecall(rows: MemoryRow[], toks: string[], now = Date.now()): RecallCandidate[] {
  const docs = rows.map((r) => docTokens(r));
  const N = docs.length || 1;
  const avgdl = docs.reduce((n, d) => n + d.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const out: RecallCandidate[] = [];
  rows.forEach((r, i) => {
    const d = docs[i]!;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    const hits: string[] = [];
    for (const q of toks) {
      const f = tf.get(q);
      if (!f) continue;
      hits.push(q);
      const n = df.get(q) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * d.length) / avgdl)));
    }
    if (hits.length) out.push({ id: r.id, hits, relevance: Math.round(score * 100) / 100, importance: r.importance, recency: recencyFactor(r, now) });
  });
  return out.sort((a, b) => b.relevance - a.relevance || b.importance - a.importance || b.recency - a.recency);
}
export function rankRecall(rows: MemoryRow[], toks: string[], now = Date.now()): RecallCandidate[] {
  return scoreRecall(rows, toks, now).filter((c) => c.hits.length >= RECALL_MIN_HITS && c.relevance >= RECALL_MIN_BM25);
}

export async function autoRecall(
  db: MemoryDb,
  caller: Caller,
  input: {
    message: string;
    prev_message?: string;
    exclude_ids?: string[];
    limit?: number;
    max_chars?: number;
    debug?: boolean;
    last_reply?: string;
    surfaced_ids?: string[];
    now_ms?: number;
    rand?: () => number;
  },
) {
  const nowMs = input.now_ms ?? Date.now();
  const p = caller.persona;
  const query = [input.prev_message?.trim(), input.message.trim()].filter(Boolean).join("\n");
  const toks = tokens(query);
  const limit = Math.min(Math.max(input.limit ?? RECALL_MAX, 1), RECALL_MAX);
  const maxChars = Math.min(Math.max(input.max_chars ?? 800, 200), 3000);
  const exclude = new Set(input.exclude_ids ?? []);
  const debug = {
    query: clip(query, 200),
    keywords: toks.slice(0, 30),
    scanned: 0,
    candidates: 0,
    above_threshold: 0,
    top_scores: [] as { id: string; bm25: number; hits: string[] }[],
    passed: 0,
    injected: [] as string[],
    skipped_dedup: [] as string[],
    cut_by_limit: [] as string[],
    passed_scores: [] as string[],
    min_hits: RECALL_MIN_HITS,
    min_bm25: RECALL_MIN_BM25,
    reinforced: [] as string[],
    zero_weight: [] as string[],
    associated: [] as string[],
    cognition_first: [] as string[],
    cognition_offered: "" as string,
  };
  const finish = async (text: string, memories: LabeledMemory[]) => {
    // 认知邀请（限频、只给伙伴）：附在浮现文本末尾，不影响 memories 列表
    const offer = await maybeCognitionNote(db, p.id, nowMs);
    if (offer.note) { text = text ? text + offer.note : offer.note.trim(); debug.cognition_offered = offer.id ?? ""; }
    console.log(JSON.stringify({ evt: "auto_recall", persona: p.id, ...debug }));
    return { text, memories, matched: memories.length, ...(input.debug ? { debug } : {}) };
  };
  const all = await ownAndFamily(db, p.id, 800);
  const rows = all.filter((r) => !isRecallNoise(r));
  // 强化：上一轮浮现过的记忆，关键词真的出现在人格回复里 → 算「用到了」
  if (input.last_reply && input.surfaced_ids?.length) {
    const replyToks = new Set(tokens(input.last_reply));
    const byIdAll = new Map(all.map((r) => [r.id, r]));
    for (const id of input.surfaced_ids.slice(0, 10)) {
      const r = byIdAll.get(id);
      if (!r) continue;
      const overlap = new Set(segment(r.content)).size ? [...new Set(segment(r.content))].filter((t) => replyToks.has(t)) : [];
      if (overlap.length >= 2) {
        await reinforceMemory(db, r, nowMs);
        debug.reinforced.push(id);
        try { await nudgeNeighbors(db, id, nowMs); } catch { /* */ }
      }
    }
  }
  setUserDict(rows.flatMap((r) => (r.tags ?? "").split(/[,，\s]+/)));
  toks.splice(0, toks.length, ...tokens(query));
  debug.keywords = toks.slice(0, 30);
  if (!toks.length) return finish("", []);
  debug.scanned = rows.length;
  const scoredAll = scoreRecall(rows, toks);
  const ranked = scoredAll.filter((c) => c.hits.length >= RECALL_MIN_HITS && c.relevance >= RECALL_MIN_BM25);
  const scoreOf = Object.fromEntries(scoredAll.map((c) => [c.id, c.relevance]));
  const fmt = (id: string) => `${id}(${scoreOf[id] ?? "?"})`;
  debug.candidates = scoredAll.length;
  debug.above_threshold = ranked.length;
  debug.top_scores = scoredAll.slice(0, 8).map((c) => ({ id: c.id, bm25: c.relevance, hits: c.hits }));
  debug.passed_scores = ranked.map((c) => fmt(c.id));
  // 遗忘机制加权：相关度 × 浮现权重（48h 内浮现过 = 0；trace ~5%；偏爱 0.2–0.4 的 faded；×(1+情绪)；与上一句重叠 ×2）
  const prevToks = new Set(input.prev_message ? tokens(input.prev_message) : []);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const weighted: (RecallCandidate & { w: number })[] = [];
  for (const c of ranked) {
    const r = rowById.get(c.id)!;
    const w = surfaceWeight(r, { nowMs, recentOverlap: c.hits.some((h) => prevToks.has(h)), rand: input.rand });
    if (w <= 0) { debug.zero_weight.push(fmt(c.id)); continue; }
    weighted.push({ ...c, w });
  }
  weighted.sort((a, b) => b.relevance * b.w - a.relevance * a.w || b.importance - a.importance || b.recency - a.recency);
  let fresh: typeof ranked = [];
  for (const c of weighted) {
    if (exclude.has(c.id)) debug.skipped_dedup.push(fmt(c.id));
    else fresh.push(c);
  }
  // 认知优先：命中的认知、或命中了某份认知的源记忆 → 那份认知排最前（源记忆随后按原规则 / 牵出来）
  let cogMaps: Awaited<ReturnType<typeof cognitionMaps>> | null = null;
  if (COGNITION_ENABLED && COGNITION_FIRST && fresh.length) {
    try {
      cogMaps = await cognitionMaps(db, p.id);
      const cogSet = new Set(cogMaps.srcOf.keys());
      if (cogSet.size) {
        const first: typeof ranked = []; const seen = new Set<string>();
        for (const c of fresh) {
          const cid = cogSet.has(c.id) ? c.id : cogMaps.bySrc.get(c.id);
          if (!cid || seen.has(cid) || exclude.has(cid)) continue;
          const r = rowById.get(cid);
          if (!r || (cid !== c.id && surfaceWeight(r, { nowMs, rand: () => 0 }) <= 0)) continue;
          seen.add(cid); first.push(cid === c.id ? c : { ...c, id: cid });
        }
        if (first.length) { fresh = [...first, ...fresh.filter((c) => !seen.has(c.id))]; debug.cognition_first = first.map((c) => c.id); }
      }
    } catch (e) { console.error("[cognition] first", e); }
  }
  const picked = fresh.slice(0, limit);
  const cut = fresh.slice(limit);
  for (const c of cut) debug.cut_by_limit.push(fmt(c.id));
  debug.passed = fresh.length;
  if (!picked.length) return finish("", []);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const names = await nameMap(db);
  const lines: string[] = [`[记忆浮现 · ${p.display_name}] 以下是和这句话可能有关的旧记忆，仅供参考，不必每条都提。`];
  let used = [...lines[0]!].length;
  const memories: LabeledMemory[] = [];
  for (const c of picked) {
    const r = byId.get(c.id)!;
    const src = r.owner_persona === FAMILY_OWNER ? "全家共享" : names.get(r.owner_persona) ?? r.owner_persona;
    const isCog = !!cogMaps?.srcOf.has(r.id);
    const line = `[#${r.id} · ${src}${isCog ? " · 认知" : ""}]${r.event_date ? ` (${r.event_date})` : ""} ${clip(r.content, 220)}`;
    if (used + [...line].length > maxChars) {
      debug.cut_by_limit.push(fmt(c.id) + "(chars)");
      continue;
    }
    used += [...line].length;
    lines.push(line);
    memories.push(labelMemory(r, p.id, names));
    debug.injected.push(fmt(c.id));
  }
  // 心流：一个念头牵出下一个（关联记忆，最多 ASSOC_MAX 条，受 max_chars 约束）
  if (memories.length) {
    try {
      const assoc = await associate(db, memories.map((m) => m.id), byId, exclude, nowMs);
      for (const a of assoc) {
        if (surfaceWeight(a.row, { nowMs, rand: () => 0 }) <= 0) continue;
        const line = `[#${a.row.id} · 牵出来的 ← #${a.from}] ${clip(a.row.content, ASSOC_CLIP)}`;
        if (used + [...line].length > maxChars) continue;
        used += [...line].length;
        lines.push(line);
        memories.push({ ...labelMemory(a.row, p.id, names), associated_from: a.from } as LabeledMemory);
        debug.associated.push(`${a.row.id}<-${a.from}(${a.score.toFixed(2)})`);
      }
      // 认知连着的花园内容（日记/小说…）：用候选里存的短标题，作为淡淡的「牵出来的」补位
      if (cogMaps && debug.associated.length < ASSOC_MAX) {
        for (const m of memories) {
          if (!cogMaps.srcOf.has(m.id) || debug.associated.length >= ASSOC_MAX) continue;
          const c = await db.prepare(`SELECT c.items FROM cognitions g JOIN cognition_candidates c ON c.id = g.candidate_id WHERE g.id = ?`).bind(m.id).first<{ items: string }>().catch(() => null);
          for (const it of (c ? (JSON.parse(c.items) as { key: string; type: string; title: string }[]) : []).filter((i) => !i.key.startsWith("memory:"))) {
            if (debug.associated.length >= ASSOC_MAX) break;
            const line = `[${TYPE_LABEL[it.type] ?? it.type} · 牵出来的 ← #${m.id}] ${clip(it.title, ASSOC_CLIP)}`;
            if (used + [...line].length > maxChars) continue;
            used += [...line].length; lines.push(line); debug.associated.push(`${it.key}<-${m.id}`);
          }
        }
      }
      if (memories.length >= 2) await coRecall(db, memories.map((m) => m.id), new Date(nowMs).toISOString());
    } catch (e) { console.error("[links] assoc", e); }
  }
  if (memories.length) {
    try {
      const t = new Date(nowMs).toISOString();
      await db
        .prepare(`UPDATE memories SET last_surfaced_at = ? WHERE id IN (${memories.map(() => "?").join(",")})`)
        .bind(t, ...memories.map((m) => m.id))
        .run();
    } catch { /* 旧库 / 测试桩 */ }
  }
  return finish(memories.length ? lines.join("\n") : "", memories);
}

// —— 家主可视化页的总览（管理员）——

export async function overview(db: MemoryDb) {
  const personas =
    (
      await db
        .prepare(`SELECT id, display_name, relationship_to_user FROM personas ORDER BY created_at ASC, id ASC`)
        .all<{ id: string; display_name: string; relationship_to_user: string }>()
    ).results ?? [];
  const memories =
    (
      await db
        .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories ORDER BY importance DESC, updated_at DESC LIMIT 1000`)
        .all<MemoryRow>()
    ).results ?? [];
  const unresolved = (await db.prepare(`SELECT * FROM unresolved ORDER BY updated_at DESC LIMIT 300`).all<UnresolvedRow>()).results ?? [];
  const handoffs = (await db.prepare(`SELECT * FROM handoffs ORDER BY created_at DESC LIMIT 100`).all<HandoffRow>()).results ?? [];
  const notes = await listNotes(db, undefined, undefined, 300);
  return { personas, memories, unresolved, handoffs, notes };
}

// D1 的 API token 没有直接执行 SQL 的权限，所以由 Worker 自己幂等建表（每个 isolate 一次）。
import MIGRATION_SQL from "../migrations/0003_continuity.sql";
let schemaReady: Promise<void> | null = null;
export function ensureContinuitySchema(db: MemoryDb): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      if (await schemaCurrent(db)) return;
      const statements = MIGRATION_SQL.split(";")
        .map((s: string) => s.replace(/^\s*--.*$/gm, "").trim())
        .filter(Boolean);
      for (const sql of statements) await db.prepare(sql).run();
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

// —— 花园管理员：更新交接 / 便条 / 未了 ——

export async function updateHandoff(
  db: MemoryDb,
  id: string,
  patch: { summary?: string; mood?: string | null; next_time?: string | null },
) {
  const existing = await db.prepare(`SELECT * FROM handoffs WHERE id = ?`).bind(id).first<HandoffRow>();
  if (!existing) throw new AppError(404, "not_found", "没有这张交接便签。");
  const summary = patch.summary !== undefined ? patch.summary.trim() : existing.summary;
  if (!summary) throw new AppError(400, "invalid", "summary 不能为空。");
  const mood =
    patch.mood !== undefined ? (patch.mood === null || patch.mood === "" ? null : String(patch.mood).trim()) : existing.mood;
  const next_time =
    patch.next_time !== undefined
      ? patch.next_time === null || patch.next_time === ""
        ? null
        : String(patch.next_time).trim()
      : existing.next_time;
  await db
    .prepare(`UPDATE handoffs SET summary = ?, mood = ?, next_time = ? WHERE id = ?`)
    .bind(summary, mood, next_time, id)
    .run();
  return { id, summary, mood, next_time, text: `已更新交接便签 ${id}。` };
}

export async function updateNoteContent(db: MemoryDb, id: string, patch: { content?: string }) {
  const existing = await db.prepare(`SELECT * FROM notes WHERE id = ?`).bind(id).first<NoteRow>();
  if (!existing) throw new AppError(404, "not_found", "没有这张便条。");
  const content = patch.content !== undefined ? patch.content.trim() : existing.content;
  if (!content) throw new AppError(400, "invalid", "便条不能是空的。");
  if ([...content].length > 4000) throw new AppError(400, "invalid", "便条太长。");
  await db.prepare(`UPDATE notes SET content = ? WHERE id = ?`).bind(content, id).run();
  return { id, content, text: `已更新便条 ${id}。` };
}

export async function updateUnresolvedItem(
  db: MemoryDb,
  id: string,
  patch: { content?: string; context?: string | null },
) {
  const existing = await db.prepare(`SELECT * FROM unresolved WHERE id = ?`).bind(id).first<UnresolvedRow>();
  if (!existing) throw new AppError(404, "not_found", "没有这件未了的事。");
  const content = patch.content !== undefined ? patch.content.trim() : existing.content;
  if (!content) throw new AppError(400, "invalid", "内容不能为空。");
  const context =
    patch.context !== undefined
      ? patch.context === null || patch.context === ""
        ? null
        : String(patch.context).trim()
      : existing.context;
  const t = nowIso();
  await db
    .prepare(`UPDATE unresolved SET content = ?, context = ?, updated_at = ? WHERE id = ?`)
    .bind(content, context, t, id)
    .run();
  return { id, content, context, text: `已更新未了的事 ${id}。` };
}
