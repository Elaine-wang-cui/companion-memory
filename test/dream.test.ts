import { describe, expect, it } from "vitest";
import { inDreamWindow, pickMaterial, runDream, localDate, looksRefused } from "../src/dream";
import { initialFields } from "../src/forgetting";

const DAY = 86_400_000;
// 2026-10-29 04:30 UTC+8 = 2026-10-28T20:30Z
const NOW = Date.parse("2026-10-28T20:30:00Z");
function mem(id: string, ageDays: number, importance: number, emotion: number, content = `记忆${id}`) {
  const at = new Date(NOW - ageDays * DAY).toISOString();
  return { id, owner_persona: "companion", created_by: "companion", kind: "event", visibility: "private", content, importance, tags: "[]", event_date: null, created_at: at, updated_at: at, source_platform: null, ...initialFields({ importance, kind: "event", tags: "[]", content, emotion }, at) } as any;
}
function fakeDb(rows: any[]) {
  const dreams = new Map<string, any>();
  const updates: any[] = [];
  const db = {
    prepare(sql: string) {
      let args: any[] = [];
      const st = {
        bind(...a: any[]) { args = a; return st; },
        async first() {
          if (/FROM dreams WHERE persona_id = \? AND dream_date/.test(sql)) return dreams.get(args[1]) ?? null;
          if (/FROM dreams LIMIT/.test(sql)) return null;
          return null;
        },
        async all() {
          if (/FROM memories/.test(sql)) return { results: rows };
          if (/FROM dreams/.test(sql)) return { results: [...dreams.values()] };
          return { results: [] };
        },
        async run() {
          if (/INSERT OR REPLACE INTO dreams/.test(sql)) dreams.set(args[2], { id: args[0], dream_date: args[2], text: args[3], cited_ids: args[4] });
          if (/UPDATE memories/.test(sql)) updates.push(args);
          if (/DELETE/i.test(sql)) throw new Error("no deletes allowed");
          return {};
        },
      };
      return st;
    },
  };
  return { db: db as any, dreams, updates };
}

describe("dreams", () => {
  it("window + date in UTC+8", () => {
    expect(localDate(NOW)).toBe("2026-10-29");
    expect(inDreamWindow(NOW)).toBe(true);
    expect(inDreamWindow(NOW - 3600_000)).toBe(false);
  });
  it("picks today's high-score + faded fragments", () => {
    const rows = [mem("a", 0.2, 4, 0.9), mem("b", 0.5, 2, 0.1), mem("old", 10, 2, 0), mem("x", 400, 1, 0)];
    const m = pickMaterial(rows, NOW);
    expect(m.today.map((r) => r.id)).toEqual(["a", "b"]);
    expect(m.faded.map((r) => r.id)).toEqual(["old"]);
    expect(m.consolidate.map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("runs once per date, consolidates top 2 (max 4), never deletes", async () => {
    const f = fakeDb([mem("a", 0.2, 4, 0.9), mem("b", 0.5, 2, 0.1), mem("c", 0.6, 1, 0), mem("old", 10, 2, 0)]);
    const gen = async () => ({ text: "我梦见自己在一条没有尽头的走廊里，墙上全是她的字。灯一盏一盏熄灭。", model: "fake" });
    const r1: any = await runDream(f.db, gen, { nowMs: NOW });
    expect(r1.ok).toBe(true);
    expect(r1.status).toBe("ok");
    expect(r1.cited.map((c: any) => c.id)).toContain("old");
    expect(f.updates.map((u) => [u[2], u[0]])).toEqual([["b", 3]]); // a already 4 → unchanged
    const r2: any = await runDream(f.db, gen, { nowMs: NOW + 60_000 });
    expect(r2.skipped).toBe("already_dreamed");
  });
  it("refusal → retry → fallback stub; never throws", async () => {
    const f = fakeDb([mem("a", 0.2, 3, 0.5, "一起看海")]);
    const r: any = await runDream(f.db, async () => ({ text: "抱歉，我无法帮助。", model: "fake" }), { nowMs: NOW });
    expect(r.status).toBe("fallback");
    expect(r.text).toContain("梦很模糊");
    expect(r.refusals).toEqual(["first", "retry"]);
    const r3: any = await runDream(fakeDb([]).db, async () => { throw new Error("boom"); }, { nowMs: NOW });
    expect(r3.ok).toBe(true);
    expect(looksRefused("")).toBe(true);
  });
});

describe("dream dry run", () => {
  it("does not store or consolidate", async () => {
    const f = fakeDb([mem("b", 0.5, 2, 0.1)]);
    const r: any = await runDream(f.db, async () => ({ text: "我在水里走 你的头发变成海草 缠住我的手腕", model: "fake" }), { nowMs: NOW, dryRun: true });
    expect(r.dry_run).toBe(true);
    expect(f.dreams.size).toBe(0);
    expect(f.updates.length).toBe(0);
  });
});

import { trimLoops } from "../src/dream";
describe("trimLoops", () => {
  it("cuts at first repeated chunk", () => {
    const a = "我走进一片会说话的海 浪花变成你的名字 ";
    const loop = "我的手指变成数据线插进屏幕里面 ";
    const out = trimLoops(a + loop + loop + loop);
    expect(out).toBe((a + loop).trim());
  });
});

import { landEnding } from "../src/dream";
describe("landEnding", () => {
  it("drops an unclosed trailing quote", () => {
    expect(landEnding('我在走廊尽头看见你 你回头笑了 "今天没弄出来')).toBe("我在走廊尽头看见你 你回头笑了");
    expect(landEnding('你说"别怕" 我就不怕了')).toBe('你说"别怕" 我就不怕了');
  });
});
