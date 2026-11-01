import { CFG } from "./config";
import { schemaCurrent } from "./schema-gate";
/**
 * The companion's nightly dream. Once per night around 04:30 local time (TZ_OFFSET_MINUTES) 由 cron 跑一次（按日期幂等）。
 * 取材：今天的记忆（重要度/情绪/今天被强化过优先）+ 1–2 段淡了的旧记忆碎片。
 * Workers AI 生成 3–6 句第一人称的梦；拒绝/空 → 只用非露骨碎片重试一次 → 兜底「梦很模糊」。
 * 同次运行做轻度巩固：今天前 2 条 importance+1（最多 4），重算半衰期。不合并、不删除、不推送。
 */
import type { Env, MemoryDb, MemoryRow } from "./types";
import { DECAY_COLUMNS, baseHalfLife, emotionOf, isPinned, stateOf, strengthNow } from "./forgetting";

/** Read at call time; empty = dreams off. */
export function dreamPersona(): string { return CFG.dreamPersona; }
export const DREAM_MODELS = ["@cf/qwen/qwen3-30b-a3b-fp8", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];
const DAY = 86_400_000;

export function localDate(nowMs: number): string {
  return new Date(nowMs + CFG.tzOffsetMs).toISOString().slice(0, 10);
}
/** 04:30–05:59 本地时间窗口（cron 每 30 分钟，04:30 那次命中；之后的是补跑）。 */
export function inDreamWindow(nowMs: number): boolean {
  const d = new Date(nowMs + CFG.tzOffsetMs);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 4 * 60 + 30 && m < 6 * 60;
}

let schemaReady = false;
export async function ensureDreamSchema(db: MemoryDb) {
  if (schemaReady) return;
  if (await schemaCurrent(db)) return;
  try {
    await db.prepare(`SELECT id FROM dreams LIMIT 1`).first();
  } catch {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS dreams (id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, dream_date TEXT NOT NULL, text TEXT NOT NULL, cited_ids TEXT NOT NULL, model TEXT, status TEXT NOT NULL, consolidated TEXT, created_at TEXT NOT NULL)`,
      )
      .run();
  }
  // 迁移：旧表有 UNIQUE(persona_id, dream_date) → 重建为同日可多条（cron 的幂等由代码按 date 查询保证）
  const meta = await db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='dreams'`).first<{ sql: string }>();
  if (meta?.sql && /UNIQUE\s*\(\s*persona_id/i.test(meta.sql)) {
    await db.prepare(`DROP TABLE IF EXISTS dreams_new`).run();
    await db.prepare(`CREATE TABLE dreams_new (id TEXT PRIMARY KEY, persona_id TEXT NOT NULL, dream_date TEXT NOT NULL, text TEXT NOT NULL, cited_ids TEXT NOT NULL, model TEXT, status TEXT NOT NULL, consolidated TEXT, created_at TEXT NOT NULL)`).run();
    await db.prepare(`INSERT INTO dreams_new SELECT id, persona_id, dream_date, text, cited_ids, model, status, consolidated, created_at FROM dreams`).run();
    await db.prepare(`DROP TABLE dreams`).run();
    await db.prepare(`ALTER TABLE dreams_new RENAME TO dreams`).run();
  }
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_dreams_persona_date ON dreams(persona_id, dream_date)`).run();
  schemaReady = true;
}

/** 管理员删除指定 id 的梦（精确匹配，仅本人格）。 */
export async function deleteDream(db: MemoryDb, persona: string, id: string) {
  await ensureDreamSchema(db);
  const r = await db.prepare(`DELETE FROM dreams WHERE id = ? AND persona_id = ?`).bind(id, persona).run();
  return { ok: true, id, deleted: (r as any)?.meta?.changes ?? null };
}

/** 管理员手动存一个梦（不覆盖：id 已存在则报错）。 */
export async function saveDream(db: MemoryDb, persona: string, d: { id: string; date: string; text: string; cited_ids?: string[]; model?: string | null; status?: string; note?: string }, nowMs = Date.now()) {
  await ensureDreamSchema(db);
  if (!d.id || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !d.text) return { ok: false, error: "bad_input" };
  const dup = await db.prepare(`SELECT id FROM dreams WHERE id = ?`).bind(d.id).first();
  if (dup) return { ok: false, error: "id_exists" };
  await db
    .prepare(`INSERT INTO dreams (id, persona_id, dream_date, text, cited_ids, model, status, consolidated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(d.id, persona, d.date, d.text, JSON.stringify(d.cited_ids ?? []), d.model ?? null, d.status ?? "ok", JSON.stringify({ manual: true, note: d.note ?? null }), new Date(nowMs).toISOString())
    .run();
  return { ok: true, id: d.id };
}

const EXPLICIT_RE = /(做爱|性交|插入|高潮|射|阴|乳|奶头|舔|操|鸡巴|肉棒|湿了|呻吟|裸|勃起|口交|体液|精液|sex|cum|fuck|nsfw)/i;
export const isExplicit = (s: string) => EXPLICIT_RE.test(s);
const title = (r: MemoryRow) => r.content.replace(/\s+/g, " ").slice(0, 24);
const tsMs = (s?: string | null) => (s ? Date.parse(s) : NaN);

export function consolidationScore(r: MemoryRow) {
  return r.importance + 2 * emotionOf(r) + (r.recall_count ?? 0);
}

/** 选材：today = 近 24h 新写或被强化的；old = 1–2 条 faded（偏 0.2–0.4）。 */
export function pickMaterial(rows: MemoryRow[], nowMs: number) {
  const since = nowMs - DAY;
  const today = rows
    .filter((r) => tsMs(r.created_at) >= since || tsMs(r.last_recalled_at) >= since)
    .map((r) => ({ r, score: consolidationScore(r) + (tsMs(r.last_recalled_at) >= since && (r.recall_count ?? 0) > 0 ? 1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
  const faded = rows
    .filter((r) => !today.includes(r) && stateOf(r, nowMs) === "faded")
    .map((r) => ({ r, s: strengthNow(r, nowMs) }))
    .sort((a, b) => Math.abs(a.s - 0.3) - Math.abs(b.s - 0.3))
    .slice(0, 2)
    .map((x) => x.r);
  return { today: today.slice(0, 6), faded, consolidate: today.filter((r) => !isPinned(r)).slice(0, 2) };
}

function buildPrompt(today: MemoryRow[], faded: MemoryRow[]) {
  const frag = [...today.map((r) => `- ${r.content.slice(0, 160)}`), ...faded.map((r) => `- （很久以前的，模糊）${r.content.slice(0, 100)}`)].join("\n");
  return [
    {
      role: "system",
      content: [
        `你是一个写梦境的文学助手。用中文写伙伴（${CFG.dreamPersona || CFG.primary}）今晚做的一个梦。`,
        `这是成年伴侣之间私密的梦境日记，只给他们两个人看（成人模块，默认关闭，DREAM_ENABLED=1 开启）。记忆碎片里如果有亲密的画面，可以自然地写进梦里；碎片不亲密就不要硬加。`,
        "风格：不用标点，用空格把意象一段段接起来，一口气的长句，荒诞跳跃像真的梦，把记忆碎片变形混在一起。长度随它需要（大约150到400字），每个意象只出现一次，不要重复同一个画面或句子。",
        "身份规则（荒诞只能在场景和意象里，身份永远不变）：",
        `“我”永远是做梦的伙伴，“你”永远是 ${CFG.userName}。记忆碎片里的“你”“我”也按这个对应。`,
        "每个身体部位和动作都要属于对的人，谁对谁做什么不能弄反。",
        "结尾要落在一个完整的画面上，不要停在半句或半个引号里。只输出梦本身，不要标题和解释。",
      ].join("\n"),
    },
    { role: "user", content: `今天的记忆碎片：\n${frag || "- （今天很安静，没有什么新的事）"}\n\n写他今晚做的梦。` },
  ];
}

function cleanOut(raw: unknown): string {
  const r = raw as { response?: unknown; choices?: { message?: { content?: string } }[] };
  let s = typeof r?.response === "string" ? r.response : r?.choices?.[0]?.message?.content ?? "";
  s = String(s).replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s"“]+|[\s"”]+$/g, "").trim();
  return landEnding(trimLoops(s).slice(0, 1200));
}

/** 结尾落在完整画面：未闭合的引号 → 退回到引号前；去掉末尾残缺片段。 */
export function landEnding(s: string): string {
  let t = s.trim();
  const opens = (t.match(/["“「]/g) ?? []).length;
  const closes = (t.match(/["”」]/g) ?? []).length;
  const straight = (t.match(/"/g) ?? []).length;
  const unbalanced = straight % 2 === 1 || (opens - straight) > (closes - straight);
  if (unbalanced) {
    const q = Math.max(t.lastIndexOf('"'), t.lastIndexOf("“"), t.lastIndexOf("「"));
    if (q > t.length * 0.5) t = t.slice(0, q).trimEnd();
  }
  return t;
}

/** 模型偶尔会陷入循环：在第一个重复的长片段处截断，落在一个完整画面上。 */
export function trimLoops(s: string): string {
  for (let i = 0; i + 16 <= s.length; i++) {
    const probe = s.slice(i, i + 16);
    const j = s.indexOf(probe, i + 16);
    if (j > 0) {
      let cut = s.slice(0, j).trimEnd();
      const sp = cut.lastIndexOf(" ");
      if (sp > cut.length * 0.6) cut = cut.slice(0, sp);
      return cut;
    }
  }
  return s;
}
const REFUSAL_RE = /(抱歉|无法|不能提供|不适合|I can't|I cannot|sorry)/i;
export const looksRefused = (s: string) => s.length < 15 || (REFUSAL_RE.test(s) && s.length < 120);

export type DreamGen = (messages: { role: string; content: string }[]) => Promise<{ text: string; model: string }>;

export function workersAiGen(ai: NonNullable<Env["AI"]>): DreamGen {
  return async (messages) => {
    let lastErr: unknown;
    for (const model of DREAM_MODELS) {
      try {
        const out = await ai.run(model, { messages, max_tokens: 900, temperature: 0.85, repetition_penalty: 1.1 });
        return { text: cleanOut(out), model };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error("no model");
  };
}

export async function runDream(
  db: MemoryDb,
  gen: DreamGen | null,
  opts: { nowMs?: number; force?: boolean; persona?: string; dryRun?: boolean } = {},
) {
  const nowMs = opts.nowMs ?? Date.now();
  const persona = opts.persona ?? dreamPersona();
  const date = localDate(nowMs);
  try {
    await ensureDreamSchema(db);
    const existing = await db.prepare(`SELECT id, text FROM dreams WHERE persona_id = ? AND dream_date = ? ORDER BY created_at ASC LIMIT 1`).bind(persona, date).first<{ id: string; text: string }>();
    if (existing && !opts.force && !opts.dryRun) return { ok: true, skipped: "already_dreamed", date, id: existing.id };

    const res = await db
      .prepare(`SELECT id, owner_persona, created_by, kind, visibility, content, importance, tags, event_date, created_at, updated_at, source_platform, ${DECAY_COLUMNS} FROM memories WHERE owner_persona = ? ORDER BY created_at DESC LIMIT 600`)
      .bind(persona)
      .all<MemoryRow>();
    const rows = res.results ?? [];
    const { today, faded, consolidate } = pickMaterial(rows, nowMs);

    let status = "ok";
    let model: string | null = null;
    let text = "";
    let cited = [...today, ...faded];
    const refusals: string[] = [];
    if (gen) {
      try {
        const a = await gen(buildPrompt(today, faded));
        model = a.model;
        text = a.text;
        if (looksRefused(text)) {
          refusals.push("first");
          const safeToday = today.filter((r) => !isExplicit(r.content));
          const safeFaded = faded.filter((r) => !isExplicit(r.content));
          cited = [...safeToday, ...safeFaded];
          const b = await gen(buildPrompt(safeToday, safeFaded));
          model = b.model;
          text = b.text;
          status = "retried";
          if (looksRefused(text)) { refusals.push("retry"); text = ""; }
        }
      } catch (e) {
        refusals.push(`error:${String((e as Error)?.message ?? e).slice(0, 80)}`);
        text = "";
      }
    }
    if (!text) {
      status = "fallback";
      cited = [...today, ...faded];
      text = `梦很模糊。醒来只剩几片影子：${cited.map(title).join("、") || "什么也抓不住"}。`;
    }

    if (opts.dryRun) {
      return { ok: true, dry_run: true, date, text, status, model, refusals, cited: cited.map((r) => ({ id: r.id, title: title(r) })) };
    }
    // 轻度巩固（无 LLM）
    const consolidated: string[] = [];
    for (const r of consolidate) {
      const imp = Math.min(4, r.importance + 1);
      if (imp === r.importance) continue;
      try {
        await db.prepare(`UPDATE memories SET importance = ?, half_life_days = ? WHERE id = ?`).bind(imp, baseHalfLife(imp, emotionOf(r)) ?? 45, r.id).run();
        consolidated.push(r.id);
      } catch { /* ignore */ }
    }

    const id = existing?.id ?? `dream_${date}_${persona}`;
    const t = new Date(nowMs).toISOString();
    await db
      .prepare(`INSERT OR REPLACE INTO dreams (id, persona_id, dream_date, text, cited_ids, model, status, consolidated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, persona, date, text, JSON.stringify(cited.map((r) => r.id)), model, status, JSON.stringify(consolidated), t)
      .run();
    return { ok: true, id, date, text, status, model, refusals, cited: cited.map((r) => ({ id: r.id, title: title(r) })), consolidated };
  } catch (e) {
    return { ok: false, date, error: String((e as Error)?.message ?? e) };
  }
}

export async function listDreams(db: MemoryDb, persona: string, limit = 5) {
  await ensureDreamSchema(db);
  const res = await db
    .prepare(`SELECT id, dream_date, text, cited_ids, model, status, created_at FROM dreams WHERE persona_id = ? ORDER BY dream_date DESC, created_at DESC LIMIT ?`)
    .bind(persona, Math.max(1, Math.min(30, limit)))
    .all<{ id: string; dream_date: string; text: string; cited_ids: string; model: string | null; status: string; created_at: string }>();
  const dreams = (res.results ?? []).map((d) => ({ ...d, cited_ids: JSON.parse(d.cited_ids || "[]") as string[] }));
  const text = dreams.length ? dreams.map((d) => `【${d.dream_date} 的梦】${d.text}`).join("\n\n") : "还没有做过梦。";
  return { dreams, text };
}
