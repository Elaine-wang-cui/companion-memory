import { describe, expect, it } from "vitest";
import { applyChanges, compositeDelta, defaultFacts, defaultState, DIMS, promptLine, recordFact, settle } from "../src/emotion";
import * as NET from "../src/emotion-net";

const H = 3_600_000;
const T0 = Date.parse("2026-10-29T04:00:00Z"); // 12:00 UTC

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

describe("substrate", () => {
  it("long silence raises hunger/vigilance, lowers security, drives 不安/思念 without any tool call", () => {
    const st = defaultState(); const f = defaultFacts(T0); const n = NET.defaultNet();
    recordFact(f, { type: "her_message", at: new Date(T0).toISOString() }, T0);
    settle(st, f, T0 + 30 * H, n);
    expect(n.sub.attach_hunger).toBeGreaterThan(0.4);
    expect(n.sub.security).toBeLessThan(0.6);
    expect(st["不安"].surface).toBeGreaterThan(5);
    expect(st["思念"].surface).toBeGreaterThan(5);
    expect(promptLine(st, f, T0 + 30 * H, n)).toContain("说不清为什么");
    for (const v of NET.SUBSTRATE_VARS) { expect(n.sub[v]).toBeGreaterThanOrEqual(0); expect(n.sub[v]).toBeLessThanOrEqual(1); }
  });
  it("her message consumes hunger", () => {
    const n = NET.defaultNet(); n.sub.attach_hunger = 0.8;
    NET.herMessage(n, 600);
    expect(n.sub.attach_hunger).toBeLessThan(0.8);
  });
  it("without net, settle behaves exactly as before", () => {
    const a = defaultState(), b = defaultState(); const fa = defaultFacts(T0), fb = defaultFacts(T0);
    applyChanges(a, fa, { changes: { 生气: { surface: 60, inner: 50 } }, reason: "x" }, T0);
    applyChanges(b, fb, { changes: { 生气: { surface: 60, inner: 50 } }, reason: "x" }, T0);
    settle(a, fa, T0 + 6 * H); settle(b, fb, T0 + 6 * H);
    expect(a).toEqual(b);
    expect(a["不安"].surface).toBe(0);
  });
});

describe("coupling", () => {
  it("seeds exist and co-occurrence grows a link", () => {
    const n = NET.defaultNet();
    expect(n.W["被冷落>不安"]).toBeCloseTo(0.03);
    const before = n.W["吃醋>生气"] ?? 0;
    for (let i = 0; i < 20; i++) NET.learnCoupling(n, { 吃醋: 30, 生气: 30 }, T0 + i * 3 * H);
    expect(n.W["吃醋>生气"]!).toBeGreaterThan(before + 0.02);
  });
  it("coupling actually moves surface", () => {
    const st = defaultState(); const f = defaultFacts(T0); const n = NET.defaultNet();
    f.last_her_msg_at = new Date(T0).toISOString();
    n.W = { "吃醋>生气": 0.3 };
    st["吃醋"].surface = 80;
    settle(st, f, T0 + 1 * H, n);
    expect(st["生气"].surface).toBeGreaterThan(1);
  });
});

describe("global bounds", () => {
  it("10k random events + settles stay bounded and finite", () => {
    const r = rng(7); const st = defaultState(); const f = defaultFacts(T0); const n = NET.defaultNet();
    let t = T0;
    for (let i = 0; i < 10000; i++) {
      t += Math.floor(r() * 3 * H);
      if (r() < 0.3) recordFact(f, { type: "her_message", at: new Date(t).toISOString() }, t);
      const ch: Record<string, { surface: number; inner: number }> = {};
      for (let j = 0; j < 3; j++) { const d = DIMS[Math.floor(r() * DIMS.length)]!; ch[d] = { surface: (r() - 0.3) * 80, inner: (r() - 0.3) * 40 }; }
      settle(st, f, t, n);
      const res = applyChanges(st, f, { changes: ch, reason: "" }, t);
      const d = compositeDelta(res.applied);
      NET.learnCoupling(n, d, t); NET.learnCues(n, d, t);
      NET.noteCues(n, [["night", "busy", "silence", "x" + (i % 50)][Math.floor(r() * 4)]!], t);
    }
    for (const d of DIMS) { for (const k of ["surface", "inner"] as const) { expect(Number.isFinite(st[d][k])).toBe(true); expect(st[d][k]).toBeGreaterThanOrEqual(0); expect(st[d][k]).toBeLessThanOrEqual(100); } }
    const rows: Record<string, number[]> = {};
    for (const [k, w] of Object.entries(n.W)) { expect(Math.abs(w)).toBeLessThanOrEqual(NET.LEARN.wCap + 1e-9); (rows[k.split(">")[0]!] ??= []).push(w); }
    for (const ws of Object.values(rows)) { expect(ws.length).toBeLessThanOrEqual(NET.LEARN.topK); expect(ws.reduce((a, b) => a + Math.abs(b), 0)).toBeLessThanOrEqual(NET.LEARN.rowCap + 1e-9); }
    for (const v of NET.SUBSTRATE_VARS) { expect(n.sub[v]).toBeGreaterThanOrEqual(0); expect(n.sub[v]).toBeLessThanOrEqual(1); }
  });
  it("boundW enforces cap, top-k, prune, no self loops", () => {
    const W = NET.boundW({ "a>a": 0.2, "a>b": 5, "a>c": 0.2, "a>d": 0.2, "a>e": 0.2, "a>f": 0.2, "a>g": 0.001 });
    expect(W["a>a"]).toBeUndefined(); expect(W["a>g"]).toBeUndefined();
    expect(Object.keys(W).length).toBeLessThanOrEqual(NET.LEARN.topK);
    expect(Object.values(W).reduce((s, w) => s + Math.abs(w), 0)).toBeLessThanOrEqual(NET.LEARN.rowCap + 1e-9);
  });
});

describe("recall bias", () => {
  it("is at most ±0.02 and favors congruent moods", () => {
    const tone = NET.toneOf({ 悲伤: { surface: 100, inner: 100 }, 被冷落: { surface: 100, inner: 100 } });
    const pain = NET.recallBias(tone, ["痛"]), sweet = NET.recallBias(tone, ["甜"]);
    expect(pain).toBeGreaterThan(sweet);
    for (const m of [["痛"], ["甜"], ["怕"], ["怒"], [], undefined]) expect(Math.abs(NET.recallBias(tone, m as string[] | undefined))).toBeLessThanOrEqual(0.02 + 1e-9);
    expect(NET.recallBias(null, ["痛"])).toBe(0);
  });
  it("recall nudge is small and capped", () => {
    const nd = NET.recallNudge([["甜", "痛", "怕", "怒"], ["痛"], ["怕"]]);
    expect(Object.values(nd.dims).reduce((a, b) => a + Math.abs(b), 0)).toBeLessThanOrEqual(5 + 1e-9);
  });
  it("parseNet tolerates missing/garbage rows (old format)", () => {
    expect(NET.parseNet(null).W["被冷落>不安"]).toBeCloseTo(0.03);
    const n = NET.parseNet({ substrate_json: "{bad", coupling_json: null, cue_json: "[]", aux_json: "" } as any);
    expect(n.sub.security).toBeCloseTo(0.6);
  });
});
