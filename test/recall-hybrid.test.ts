import { describe, it, expect } from "vitest";
import { autoRecall, inferQueryTags } from "../src/continuity";
import { reqStore } from "../src/links";
import { CFG } from "../src/config";
import { surfaceWeight } from "../src/forgetting";

// 虚构数据：3 维“向量”就够测排序逻辑
const VEC: Record<string, number[]> = {
  m_lamp: [1, 0, 0],   // 提灯的旧灯
  m_lamp2: [0.99, 0.05, 0], // 几乎重复
  m_tea: [0, 1, 0],
  m_rain: [0, 0, 1],
};
const mem = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  id, owner_persona: "companion", created_by: "companion", kind: "fact", visibility: "private", content, importance: 3, tags: "",
  event_date: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", source_platform: "app", ...extra,
});
const ROWS = [
  mem("m_lamp", "小桃在旧货市场买了一盏黄铜提灯。"),
  mem("m_lamp2", "那盏黄铜提灯是小桃在旧货市场买的。"),
  mem("m_tea", "阿岚泡茶总是放太多叶子。"),
  mem("m_rain", "雨夜里一起听收音机。"),
];
const TAGS = [{ id: "m_tea", topic: '["日常"]', people: '["阿岚"]', mood: "平" }];
function fakeDb() {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const api: any = {
        bind: (...a: unknown[]) => ((args = a), api),
        async first() { if (/memory_embeddings/.test(sql)) return { k: "4/x" }; return null; },
        async run() { return {}; },
        async all() {
          if (/FROM personas/.test(sql)) return { results: [{ id: "companion", display_name: "小雾" }] };
          if (/FROM memory_embeddings/.test(sql)) return { results: Object.entries(VEC).map(([memory_id, v]) => ({ memory_id, vec: JSON.stringify(v) })) };
          if (/SELECT id, topic, people, mood/.test(sql)) return { results: TAGS };
          if (/FROM memories/.test(sql)) return { results: ROWS.filter((r) => r.owner_persona === args[0] || r.owner_persona === "family") };
          return { results: [] };
        },
      };
      return api;
    },
  } as any;
}
const caller = { persona: { id: "companion", display_name: "小雾" } } as any;
const fakeAI = (q: number[]) => ({ run: async (_m: string, b: { text: string[] }) => ({ data: b.text.map(() => q) }) });
const run = (env: any, message: string) =>
  reqStore.run({ env }, () => autoRecall(fakeDb(), caller, { message, debug: true, dry_run: true, now_ms: Date.parse("2026-02-01T00:00:00Z") }));

describe("hybrid recall", () => {
  it("zero config (no AI binding) → bm25 mode", async () => {
    const r: any = await run({}, "那盏提灯还在吗");
    expect(r.debug.mode).toBe("bm25");
  });
  it("AI binding → semantic match even without shared keywords; near-duplicates collapsed", async () => {
    const r: any = await run({ AI: fakeAI([1, 0, 0]) }, "我想起很久以前买的那个照明的东西");
    expect(r.debug.mode).toBe("hybrid");
    const ids = r.memories.map((m: any) => m.id);
    expect(ids).toContain("m_lamp");
    expect(ids.includes("m_lamp") && ids.includes("m_lamp2")).toBe(false);
    expect(ids).not.toContain("m_rain");
  });
  it("RECALL_SEMANTIC=0 forces bm25 even with the binding", async () => {
    CFG.semanticRecall = false;
    try {
      const r: any = await run({ AI: fakeAI([1, 0, 0]) }, "那盏提灯还在吗");
      expect(r.debug.mode).toBe("bm25");
    } finally { CFG.semanticRecall = true; }
  });
  it("embedding failure falls back to bm25", async () => {
    const r: any = await run({ AI: { run: async () => { throw new Error("down"); } } }, "那盏提灯还在吗");
    expect(r.debug.mode).toBe("bm25");
  });
});

describe("tags", () => {
  it("infers topic hints and free-form people", () => {
    const t = inferQueryTags("今天加班好累，阿岚还在等我", ["阿岚", "小雾"]);
    expect([...t.topic]).toEqual(expect.arrayContaining(["工作", "失落"]));
    expect([...t.people]).toEqual(["阿岚"]);
  });
  it("auto surfacing never randomly picks trace memories", () => {
    const old = { importance: 1, emotion: 0, strength: 0.01, half_life_days: 1, last_recalled_at: "2020-01-01T00:00:00Z", recall_count: 0, created_at: "2020-01-01T00:00:00Z", pinned: 0 } as any;
    expect(surfaceWeight(old, { auto: true, rand: () => 0 })).toBe(0);
  });
});
