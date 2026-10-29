import { describe, it, expect } from "vitest";
import { autoRecall, tokens, scoreRecall, setUserDict } from "../src/continuity";

const mem = (id: string, owner: string, content: string, importance = 3, tags = "", event_date: string | null = null) => ({
  id, owner_persona: owner, created_by: owner, kind: "fact", visibility: "private", content, importance, tags, event_date,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", source_platform: "app",
});
const ROWS = [
  mem("m_cat01", "companion", "小满的猫叫豆包，橘猫，怕打雷，喜欢趴在键盘上。", 4, "猫,豆包"),
  mem("m_cat02", "family", "豆包去年秋天打疫苗时咬了兽医一口。", 3, "猫"),
  mem("m_sea01", "companion", "第一次一起看海是在海边小镇，小满捡了一块贝壳。", 5, "海边小镇,海"),
  mem("m_noodle", "companion", "小满最爱吃楼下那家牛肉面。", 3, "吃"),
  mem("m_log", "companion", "系统日志：同步完成", 1, "系统日志"),
  mem("m_rain", "companion", "下雨天小满喜欢窝在沙发上听雨声，喝热可可。", 2, "雨"),
  mem("m_work", "companion", "小满在书店打工，周一盘点最烦。", 3, "工作"),
  mem("m_mom", "family", "小满奶奶住在山里，每周日打电话。", 4, "奶奶,山里"),
  mem("m_bday", "companion", "小满生日是某个春天，喜欢栀子花。", 5, "生日"),
  mem("m_movie", "companion", "一起看过《海上钢琴师》，小满哭了很久。", 3, "电影"),
  mem("m_sleep", "companion", "小满睡不着的时候要听雨声，下大雨最好。", 3, "失眠"),
  mem("m_pool", "companion", "泳池那天小满穿了蓝色泳衣，水有点凉。", 4, "泳池"),
  mem("m_ring", "family", "那枚锡做的小戒指是集市上套圈赢的。", 5, "戒指,集市"),
  mem("m_cook", "companion", "小满做的番茄炒蛋放糖，我说好吃。", 2, "做饭"),
  mem("m_trip", "companion", "计划明年冬天去雪山脚下，看极光。", 3, "旅行,雪山"),
  mem("m_ember", "ember", "余烬的私人记忆：豆包猫在海边小镇海边", 5, "猫"),
];
function fakeDb() {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const api = {
        bind: (...a: unknown[]) => ((args = a), api),
        async all() {
          if (/FROM personas/.test(sql)) return { results: [{ id: "companion", display_name: "小雾" }, { id: "ember", display_name: "余烬" }] };
          const pid = args[0];
          return { results: ROWS.filter((r) => r.owner_persona === pid || r.owner_persona === "family") };
        },
      };
      return api;
    },
  } as any;
}
const caller = { persona: { id: "companion", display_name: "小雾" } } as any;

// —— 客户端去重逻辑镜像（与客户端去重账本同规则）——
const COOLDOWN_TURNS = 10;
function simulate(userMsgs: string[], maxHistoryMessages = 20) {
  const injectedAt = new Map<string, number>();
  const log: string[] = [];
  let prev: string | undefined;
  return (async () => {
    for (let turn = 1; turn <= userMsgs.length; turn++) {
      const msg = userMsgs[turn - 1]!;
      const windowTurns = Math.ceil(maxHistoryMessages / 2);
      const exclude = [...injectedAt].filter(([, t]) => turn - t <= Math.max(COOLDOWN_TURNS, windowTurns)).map(([id]) => id);
      const r: any = await autoRecall(fakeDb(), caller, { message: msg, prev_message: prev, exclude_ids: exclude, debug: true });
      for (const id of r.debug.injected) injectedAt.set(String(id).split("(")[0]!, turn);
      log.push(`turn ${turn} | query="${r.debug.query.replace(/\n/g, " ⏎ ")}" | 分词=${r.debug.keywords.join(",")} | 候选=${r.debug.candidates} | 过门槛=${r.debug.above_threshold} scores=${JSON.stringify(r.debug.passed_scores)} | 注入=${JSON.stringify(r.debug.injected)} | 去重跳过=${JSON.stringify(r.debug.skipped_dedup)} | 名额砍掉=${JSON.stringify(r.debug.cut_by_limit)}`);
      if (r.text) log.push("   " + r.text.split("\n").slice(1).join("\n   "));
      prev = msg;
    }
    return log;
  })();
}

describe("auto-recall v2", () => {
  it("stopword chars never form keywords", () => {
    expect(tokens("我的你是了吗")).toEqual([]);
    expect(tokens("第一次")).toEqual([]);
  });
  it("score distribution", () => {
    const rows = ROWS.filter((r) => r.owner_persona !== "ember") as any;
    setUserDict(rows.flatMap((r: any) => r.tags.split(",")));
    const qs = ["豆包猫今天又趴我键盘上了", "下雨了好想喝热可可", "我奶奶今天打电话了", "明天周一又要盘点", "你还记得我生日吗", "睡不着，想听雨声", "我们去泳池吧", "今天吃番茄炒蛋", "冬天想去雪山", "你爱我吗", "今天好累啊", "集市套圈赢的戒指还记得吗", "海上钢琴师好好哭", "海边小镇的贝壳还在吗", "在干嘛呢"];
    const lines = qs.map((q) => { const t = tokens(q); const sc = scoreRecall(rows, t).slice(0, 3); return `${q} | 分词=${t.join(",")} | ` + (sc.map((c) => `${c.id}:${c.relevance}(${c.hits.length}词)`).join(" ") || "无命中"); });
    console.log("\n[DIST]\n" + lines.join("\n"));
  });
  it("single keyword does not inject", async () => {
    const r: any = await autoRecall(fakeDb(), caller, { message: "豆包", debug: true });
    expect(r.debug.injected).toEqual([]);
  });
  it("isolation: never sees ember's memory; noise excluded; prefix format", async () => {
    const r: any = await autoRecall(fakeDb(), caller, { message: "豆包猫又趴在键盘上，好怕打雷", debug: true });
    expect(r.debug.injected).not.toContain("m_ember");
    expect(r.debug.injected).not.toContain("m_log");
    expect(r.text).toMatch(/\[#m_cat01 · 小雾\]/);
  });
  it("multi-turn dedup", async () => {
    const log = await simulate([
      "豆包猫今天又趴我键盘上了",
      "对啊豆包猫就是喜欢键盘",
      "今天晚饭吃什么好呢",
      "豆包猫打雷的时候躲床底",
      "我想起第一次在海边小镇看海",
      "海边小镇的贝壳还留着吗",
      "豆包猫要打疫苗了",
    ]);
    console.log("\n" + log.join("\n"));
    expect(log.join("\n")).toMatch(/去重跳过=\["m_sea01\(/);
  });
});
