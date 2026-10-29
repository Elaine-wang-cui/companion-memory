import { describe, expect, it } from "vitest";
import { initialFields, reinforcePatch, stateOf, strengthNow, surfaceWeight, displayContent } from "../src/forgetting";
import { rankByStrength } from "../src/service";

const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = new Date(T0).toISOString();
function row(importance: number, emotion: number, extra: Record<string, unknown> = {}) {
  const f = initialFields({ importance, kind: "event", tags: "[]", content: "那天一起去看海", emotion }, iso);
  return { id: `m${importance}`, owner_persona: "companion", created_by: "companion", kind: "event", visibility: "private", content: "那天一起去看海", importance, tags: "[]", event_date: null, created_at: iso, updated_at: iso, source_platform: null, ...f, ...extra } as any;
}

describe("forgetting phase 1", () => {
  it("importance 2, emotion 0, +10 days → faded", () => {
    const r = row(2, 0);
    expect(r.half_life_days).toBe(5);
    const s = strengthNow(r, T0 + 10 * DAY);
    expect(s).toBeGreaterThanOrEqual(0.15);
    expect(s).toBeLessThan(0.5);
    expect(stateOf(r, T0 + 10 * DAY)).toBe("faded");
    expect(displayContent(r, "faded")).toContain("记得不太清了");
  });
  it("reinforce → clear, half-life 7.5", () => {
    const r = row(2, 0);
    const now = T0 + 10 * DAY;
    const p = reinforcePatch(r, now);
    expect(p.half_life_days).toBeCloseTo(7.5);
    expect(p.recall_count).toBe(1);
    const next = { ...r, ...p };
    expect(stateOf(next, now)).toBe("clear");
  });
  it("importance 5 +1 year → still clear (pinned)", () => {
    const r = row(5, 0);
    const st = stateOf(r, T0 + 365 * DAY);
    expect(["clear", "pinned"]).toContain(st);
    expect(strengthNow(r, T0 + 365 * DAY)).toBe(1);
  });
  it("trace excluded from recall unless include_trace or near-exact; nothing deleted", () => {
    const old = row(1, 0);
    const later = T0 + 120 * DAY;
    expect(stateOf(old, later)).toBe("trace");
    expect(rankByStrength([old], "海边", { nowMs: later })).toHaveLength(0);
    expect(rankByStrength([old], "海边", { nowMs: later, includeTrace: true })).toHaveLength(1);
    expect(rankByStrength([old], "那天一起去看海", { nowMs: later })).toHaveLength(1);
    expect(rankByStrength([row(2, 0)], "x", { nowMs: T0 + 10 * DAY, includeFaded: false })).toHaveLength(0);
  });
  it("surface weight: 0 within 48h of last surfacing; favors faded", () => {
    const now = T0 + 10 * DAY;
    expect(surfaceWeight(row(2, 0, { last_surfaced_at: new Date(now - DAY).toISOString() }), { nowMs: now })).toBe(0);
    expect(surfaceWeight(row(2, 0), { nowMs: now, recentOverlap: true })).toBeGreaterThan(surfaceWeight(row(2, 0), { nowMs: now }));
  });
  it("no DELETE in forgetting module", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/forgetting.ts", "utf8"));
    expect(/DELETE\s+FROM/i.test(src)).toBe(false);
  });
});
