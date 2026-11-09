import { describe, expect, it } from "vitest";
import {
  REPLY_PREVIEW_LIMIT,
  WAKE_LIMIT,
  bloom,
  canCheck,
  canUncheck,
  pageOrder,
  surfaced,
  wakeList,
  type PromiseFields,
} from "../src/promises/rules";
import { parseSurface } from "../src/promises/zone";

const TOKYO = "Asia/Tokyo";
const NEW_YORK = "America/New_York";
const NOW = Date.parse("2026-11-08T12:00:00+09:00");

function at(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(iso);
  return ms;
}

function item(partial: Partial<PromiseFields> & Pick<PromiseFields, "id" | "author">): PromiseFields {
  return {
    createdAt: NOW,
    dueAt: null,
    surfaceAt: null,
    checkedBy: null,
    checkedAt: null,
    ...partial,
  };
}

describe("due_at and surface_at stay independent", () => {
  it("past due and future surface is owed, checkable, and not awake", () => {
    const row = item({
      id: "s1",
      author: "yanyan",
      dueAt: at("2026-11-01T09:00:00+09:00"),
      surfaceAt: at("2026-11-20T09:00:00+09:00"),
    });
    expect(bloom(row, NOW)).toBe("owed");
    expect(canCheck(row, "chu", NOW)).toBe(true);
    expect(surfaced(row, NOW, TOKYO)).toBe(false);
  });

  it("future due and past surface is awake, still a bud, and not checkable yet", () => {
    const row = item({
      id: "s2",
      author: "chu",
      dueAt: at("2026-11-21T09:00:00+09:00"),
      surfaceAt: at("2026-11-01T09:00:00+09:00"),
    });
    expect(bloom(row, NOW)).toBe("bud");
    expect(canCheck(row, "yanyan", NOW)).toBe(false);
    expect(surfaced(row, NOW, TOKYO)).toBe(true);
  });

  it("an empty surface wakes, and an empty due can be checked by the other person", () => {
    const page = item({ id: "page", author: "yanyan", dueAt: at("2026-11-09T15:00:00+09:00"), surfaceAt: null });
    const content = item({ id: "content", author: "chu", dueAt: null, surfaceAt: at("2026-11-18T08:00:00+09:00") });
    expect(surfaced(page, NOW, TOKYO)).toBe(true);
    expect(surfaced(content, NOW, TOKYO)).toBe(false);
    expect(canCheck(content, "yanyan", NOW)).toBe(true);
    expect(canCheck(content, "chu", NOW)).toBe(false);
  });

  it("the exact due instant can be checked and is not an owed flower", () => {
    const row = item({ id: "s3", author: "yanyan", dueAt: NOW });
    expect(bloom(row, NOW)).toBe("bud");
    expect(canCheck(row, "chu", NOW)).toBe(true);
    expect(bloom(row, NOW + 1)).toBe("owed");
  });

  it("the same civil surface date is a different instant in Tokyo and New York", () => {
    const now = Date.parse("2026-11-07T20:30:00Z");
    const tokyo = parseSurface("2026-11-08", TOKYO);
    const york = parseSurface("2026-11-08", NEW_YORK);
    expect(tokyo.ok && york.ok).toBe(true);
    if (!tokyo.ok || !york.ok) return;
    expect(surfaced({ checkedAt: null, surfaceAt: tokyo.value }, now, TOKYO)).toBe(true);
    expect(surfaced({ checkedAt: null, surfaceAt: york.value }, now, NEW_YORK)).toBe(false);
    expect(tokyo.value).not.toBe(york.value);
  });

  it("a surface later today is already awake, while a due later today is not checkable", () => {
    const now = Date.parse("2026-07-15T16:00:00Z"); // 12:00 in New York (EDT)
    const laterToday = Date.parse("2026-07-15T22:00:00Z"); // 18:00 EDT
    const row = item({ id: "later", author: "yanyan", dueAt: laterToday, surfaceAt: laterToday });
    expect(surfaced(row, now, NEW_YORK)).toBe(true);
    expect(canCheck(row, "chu", now)).toBe(false);
    expect(bloom(row, now)).toBe("bud");
    expect(canCheck(row, "chu", laterToday)).toBe(true);
    expect(bloom(row, laterToday)).toBe("bud");
  });
});

describe("page check and undo", () => {
  it("the author cannot check, and the other person cannot check early", () => {
    const row = item({ id: "sleep", author: "yanyan", dueAt: at("2026-11-08T18:00:00+09:00") });
    expect(canCheck(row, "yanyan", NOW)).toBe(false);
    expect(canCheck(row, "chu", NOW)).toBe(false);
    expect(canCheck(row, "chu", at("2026-11-08T18:00:00+09:00"))).toBe(true);
  });

  it("only the checker can undo, and undo is what clears a resolution", () => {
    const checked = item({ id: "undo", author: "chu", checkedBy: "yanyan", checkedAt: NOW });
    expect(canUncheck(checked, "chu")).toBe(false);
    expect(canUncheck(checked, "yanyan")).toBe(true);
    expect(canCheck(checked, "chu", NOW)).toBe(false);
  });
});

describe("wake ordering", () => {
  it("empty surface comes first, then earlier surface, then earlier created_at, then id", () => {
    const rows = [
      item({ id: "b", author: "chu", surfaceAt: at("2026-11-02T00:00:00+09:00"), createdAt: 3 }),
      item({ id: "a", author: "chu", surfaceAt: null, createdAt: 5 }),
      item({ id: "d", author: "yanyan", surfaceAt: at("2026-11-02T00:00:00+09:00"), createdAt: 3 }),
      item({ id: "c", author: "chu", surfaceAt: at("2026-11-01T00:00:00+09:00"), createdAt: 9 }),
      item({ id: "e", author: "chu", surfaceAt: null, createdAt: 4 }),
      item({ id: "gone", author: "chu", checkedAt: NOW, checkedBy: "yanyan" }),
      item({ id: "later", author: "chu", surfaceAt: at("2026-11-20T00:00:00+09:00") }),
    ];
    const wake = wakeList(rows, NOW, TOKYO);
    expect(wake.items.map((row) => row.id)).toEqual(["e", "a", "c", "b", "d"]);
    expect(wake.remaining).toBe(0);
  });

  it("keeps ten and counts the rest", () => {
    const rows = Array.from({ length: WAKE_LIMIT + 1 }, (_, index) =>
      item({ id: `n-${String(index).padStart(2, "0")}`, author: "chu", createdAt: index, surfaceAt: null }),
    );
    const wake = wakeList(rows, NOW, NEW_YORK);
    expect(wake.items).toHaveLength(WAKE_LIMIT);
    expect(wake.remaining).toBe(1);
    expect(wake.items.map((row) => row.id)).toEqual(rows.slice(0, WAKE_LIMIT).map((row) => row.id));
  });

  it("orders the flower page by owed, upcoming, undated, then checked", () => {
    const rows = [
      item({ id: "checked-old", author: "chu", checkedAt: 10, checkedBy: "yanyan", dueAt: 1 }),
      item({ id: "undated-new", author: "yanyan", createdAt: 50 }),
      item({ id: "upcoming-far", author: "chu", dueAt: NOW + 5_000 }),
      item({ id: "owed-newer", author: "yanyan", dueAt: NOW - 1_000 }),
      item({ id: "undated-old", author: "chu", createdAt: 10 }),
      item({ id: "upcoming-near", author: "yanyan", dueAt: NOW + 1_000 }),
      item({ id: "owed-older", author: "chu", dueAt: NOW - 9_000 }),
      item({ id: "checked-new", author: "yanyan", checkedAt: 80, checkedBy: "chu" }),
    ];
    expect(pageOrder(rows, NOW).map((row) => row.id)).toEqual([
      "owed-older",
      "owed-newer",
      "upcoming-near",
      "upcoming-far",
      "undated-new",
      "undated-old",
      "checked-new",
      "checked-old",
    ]);
    expect(REPLY_PREVIEW_LIMIT).toBe(3);
  });
});
