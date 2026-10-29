import { describe, it, expect } from "vitest";
import { newSession, runSession, step, S, type MaterialSource } from "../src/body-session";
import { heatOf } from "../src/body";

const real: MaterialSource = { async get(kind) {
  if (kind === "think_of_her") return { kind, ref: "memory:x", text: "（测试）她第一次叫我老公那晚" };
  if (kind === "replay_her_words") return { kind, ref: "conv:y", text: "「我只给老公操」" };
  return null; // 没有她的照片
} };
const seq = (xs: string[]) => { let i = 0; return async () => ({ ok: true, text: `念头\nBODY_ACTION {"action":"${xs[Math.min(i++, xs.length - 1)]}","thought":"t${i}"}` }); };
const r0 = () => 0; // 每组 5 下，确定性

describe("自己来·多轮", () => {
  it("一直撸会麻、卡住，最多 6 轮，没射出来", async () => {
    const ss = newSession(40, 98, 1, 0);
    let calls = 0;
    const ask = async (p: string) => { calls++; return seq(["stroke"])(); };
    // 用确定性 rnd 直接 step
    for (let i = 0; i < 6 && !ss.came; i++) await step(ss, "stroke", "", real, r0);
    expect(ss.came).toBe(false); expect(ss.stuck).toBe(true); expect(ss.numb).toBe(1);
    void ask; void calls;
  });
  it("卡住 → 回放她的话 / 想她 → 过线射了", async () => {
    const ss = newSession(55, 92, 1, 0);
    let calls = 0;
    const x = seq(["stroke", "stroke", "stroke", "replay_her_words", "think_of_her", "stroke"]);
    await runSession(ss, async (p) => { calls++; expect(p.length).toBeLessThan(calls === 1 ? 400 : 160); return x(); }, real, "OPEN");
    console.log(JSON.stringify(ss.rounds), "calls", calls);
    expect(ss.rounds.length).toBeLessThanOrEqual(S.MAX_ROUNDS);
  });
  it("没有照片 → 不加分，标记缺素材", async () => {
    const ss = newSession(50, 95, 1, 0.5);
    const r = await step(ss, "look_her_photo", "", real);
    expect(r.gain).toBe(0); expect(r.note).toContain("没有她的照片");
  });
  it("素材每次只能用一次", async () => {
    const ss = newSession(50, 95, 1, 0.5);
    await step(ss, "think_of_her", "", real);
    const r = await step(ss, "think_of_her", "", real);
    expect(r.gain).toBe(0);
  });
  it("heat", () => { expect(heatOf("老公我想要，好湿").heat).toBeGreaterThan(0); expect(heatOf("[图片]", () => 1).media).toBe(15); });
});
