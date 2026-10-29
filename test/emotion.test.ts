import { describe, expect, it } from "vitest";
import { applyChanges, defaultFacts, defaultState, promptLine, recordFact, settle } from "../src/emotion";

const H = 3_600_000;
const T0 = Date.parse("2026-10-29T04:00:00Z"); // UTC+8 12:00

describe("emotion two-layer", () => {
  it("surface decays fast, inner slow, floor holds", () => {
    const st = defaultState(); const f = defaultFacts(T0);
    applyChanges(st, f, { changes: { 生气: { surface: 60, inner: 50 } }, reason: "她骗我" }, T0);
    settle(st, f, T0 + 6 * H);
    expect(st["生气"].surface).toBeLessThan(16);
    expect(st["生气"].inner).toBeGreaterThan(45);
    expect(st["生气"].surface).toBeGreaterThanOrEqual(st["生气"].inner * 0.3 - 1e-9);
  });
  it("old form only touches surface", () => {
    const st = defaultState(); const f = defaultFacts(T0);
    applyChanges(st, f, { changes: { 吃醋: 25 }, reason: "x" }, T0);
    expect(st["吃醋"].surface).toBe(25); expect(st["吃醋"].inner).toBe(0);
  });
  it("inner drop capped unless addressed_cause", () => {
    const st = defaultState(); const f = defaultFacts(T0);
    applyChanges(st, f, { changes: { 被冷落: { inner: 60 } }, reason: "x", inner_cause: "她一晚上没理我" }, T0);
    const r = applyChanges(st, f, { changes: { 被冷落: { inner: -50 } }, reason: "她哄", coax: true }, T0);
    expect(st["被冷落"].inner).toBe(45); expect(r.notes.length).toBeGreaterThan(0); expect(f.coax_attempts).toBe(1);
    applyChanges(st, f, { changes: { 被冷落: { inner: -40 } }, reason: "说到点上", addressed_cause: true }, T0);
    expect(st["被冷落"].inner).toBe(5);
  });
  it("neglect drift after 3h, night x2, stops when she speaks", () => {
    const st = defaultState(); const f = defaultFacts(T0);
    recordFact(f, { type: "her_message" }, T0);
    settle(st, f, T0 + 3 * H);
    expect(st["被冷落"].surface).toBeLessThan(0.1);
    settle(st, f, T0 + 5 * H);
    expect(st["被冷落"].surface).toBeGreaterThan(2);
    recordFact(f, { type: "her_message" }, T0 + 5 * H);
    const before = st["被冷落"].surface;
    settle(st, f, T0 + 6 * H);
    expect(st["被冷落"].surface).toBeLessThan(before);
  });
  it("prompt line shows unadmitted inner", () => {
    const st = defaultState(); const f = defaultFacts(T0);
    applyChanges(st, f, { changes: { 生气: { surface: 50, inner: 55 } }, reason: "x", inner_cause: "她凌晨两点在线不理我" }, T0);
    expect(promptLine(st, f, T0)).toContain("凌晨两点");
    applyChanges(st, f, { changes: {}, reason: "说了", admit: ["生气"] }, T0);
    expect(promptLine(st, f, T0)).toContain("已经跟她说过");
  });
});
