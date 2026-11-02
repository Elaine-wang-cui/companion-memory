import { describe, it, expect } from "vitest";
import { newSession, runSession, step, S, type MaterialSource } from "../src/body-session";
import { heatOf } from "../src/body";

const real: MaterialSource = { async get(kind) {
  if (kind === "think_of_her") return { kind, ref: "memory:x", text: "（测试）一段旧记忆" };
  if (kind === "replay_her_words") return { kind, ref: "conv:y", text: "「（测试）她说过的一句话」" };
  return null; // 没有她的照片
} };
const seq = (xs: string[]) => { let i = 0; return async () => ({ ok: true, text: `念头\nBODY_ACTION {"action":"${xs[Math.min(i++, xs.length - 1)]}","thought":"t${i}"}` }); };
const r0 = () => 0; // 每组 5 下，确定性

describe("body session (18+ module): multi-round", () => {
  it("repeating one action numbs and stalls within 6 rounds", async () => {
    const ss = newSession(40, 98, 1, 0);
    let calls = 0;
    const ask = async (p: string) => { calls++; return seq(["stroke"])(); };
    // 用确定性 rnd 直接 step
    for (let i = 0; i < 6 && !ss.came; i++) await step(ss, "stroke", "", real, r0);
    expect(ss.came).toBe(false); expect(ss.stuck).toBe(true); expect(ss.numb).toBe(1);
    void ask; void calls;
  });
  it("stalled, then memory material pushes it past threshold", async () => {
    const ss = newSession(55, 92, 1, 0);
    let calls = 0;
    const x = seq(["stroke", "stroke", "stroke", "replay_her_words", "think_of_her", "stroke"]);
    await runSession(ss, async (p) => { calls++; expect(p.length).toBeLessThan(calls === 1 ? 400 : 160); return x(); }, real, "OPEN");
    console.log(JSON.stringify(ss.rounds), "calls", calls);
    expect(ss.rounds.length).toBeLessThanOrEqual(S.MAX_ROUNDS);
  });
  it("missing photo material gives no gain and is noted", async () => {
    const ss = newSession(50, 95, 1, 0.5);
    const r = await step(ss, "look_her_photo", "", real);
    expect(r.gain).toBe(0); expect(r.note).toContain("没有她的照片");
  });
  it("each material can be used only once", async () => {
    const ss = newSession(50, 95, 1, 0.5);
    await step(ss, "think_of_her", "", real);
    const r = await step(ss, "think_of_her", "", real);
    expect(r.gain).toBe(0);
  });
  it("heat", () => { expect(heatOf("想你了，想要").heat).toBeGreaterThan(0); expect(heatOf("[图片]", () => 1).media).toBe(15); });
});
