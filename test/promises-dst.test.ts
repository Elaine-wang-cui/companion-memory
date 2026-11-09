import { describe, expect, it } from "vitest";
import { surfaced } from "../src/promises/rules";
import {
  DEFAULT_PROMISE_TIMEZONE,
  formatOffsetIso,
  localMidnight,
  offsetMinutes,
  parseSurface,
  resolvePromiseTimezone,
  startOfLocalDay,
} from "../src/promises/zone";

const NY = "America/New_York";

describe("America/New_York daylight saving", () => {
  it("defaults to America/New_York and refuses offsets and abbreviations", () => {
    expect(DEFAULT_PROMISE_TIMEZONE).toBe(NY);
    expect(resolvePromiseTimezone(undefined)).toEqual({ ok: true, value: NY });
    expect(resolvePromiseTimezone("  ")).toEqual({ ok: true, value: NY });
    expect(resolvePromiseTimezone(" America/New_York ")).toEqual({ ok: true, value: NY });
    expect(resolvePromiseTimezone("Asia/Tokyo").ok).toBe(true);
    for (const bad of ["-05:00", "+09:00", "UTC-5", "EST", "EDT", "UTC", "Etc/GMT+5", "america/new_york"]) {
      const result = resolvePromiseTimezone(bad);
      expect(result.ok, bad).toBe(false);
    }
  });

  it("uses a -05:00 midnight in January and a -04:00 midnight in July", () => {
    const winter = localMidnight(2026, 1, 15, NY);
    const summer = localMidnight(2026, 7, 15, NY);
    expect(new Date(winter).toISOString()).toBe("2026-01-15T05:00:00.000Z");
    expect(new Date(summer).toISOString()).toBe("2026-07-15T04:00:00.000Z");
    expect(offsetMinutes(winter, NY)).toBe(-300);
    expect(offsetMinutes(summer, NY)).toBe(-240);
    expect(formatOffsetIso(winter, NY)).toBe("2026-01-15T00:00:00.000-05:00");
    expect(formatOffsetIso(summer, NY)).toBe("2026-07-15T00:00:00.000-04:00");
    expect(Date.parse(formatOffsetIso(summer, NY))).toBe(summer);
    const fixedEastern = Date.parse("2026-07-15T05:00:00.000Z");
    expect(summer).not.toBe(fixedEastern);
  });

  it("keeps March 8 midnight on standard time and March 9 midnight on daylight time", () => {
    const before = localMidnight(2026, 3, 8, NY);
    const after = localMidnight(2026, 3, 9, NY);
    expect(new Date(before).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(new Date(after).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(offsetMinutes(before, NY)).toBe(-300);
    expect(offsetMinutes(after, NY)).toBe(-240);
    const jumped = Date.parse("2026-03-08T07:30:00.000Z");
    expect(startOfLocalDay(jumped, NY)).toBe(before);
    expect(formatOffsetIso(jumped, NY)).toBe("2026-03-08T03:30:00.000-04:00");
  });

  it("keeps November 1 midnight on daylight time and November 2 midnight on standard time", () => {
    const fallbackDay = localMidnight(2026, 11, 1, NY);
    const nextDay = localMidnight(2026, 11, 2, NY);
    expect(new Date(fallbackDay).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(new Date(nextDay).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(offsetMinutes(fallbackDay, NY)).toBe(-240);
    expect(offsetMinutes(nextDay, NY)).toBe(-300);
    expect(offsetMinutes(Date.parse("2026-11-01T05:30:00.000Z"), NY)).toBe(-240);
    expect(offsetMinutes(Date.parse("2026-11-01T06:30:00.000Z"), NY)).toBe(-300);
  });

  it("does not surface a date before local midnight, including across both transitions", () => {
    const march = must(parseSurface("2026-03-08", NY));
    expect(surfaced({ checkedAt: null, surfaceAt: march }, Date.parse("2026-03-08T04:30:00.000Z"), NY)).toBe(false);
    expect(surfaced({ checkedAt: null, surfaceAt: march }, Date.parse("2026-03-08T05:00:00.000Z"), NY)).toBe(true);
    expect(surfaced({ checkedAt: null, surfaceAt: march }, Date.parse("2026-03-08T07:30:00.000Z"), NY)).toBe(true);

    const november = must(parseSurface("2026-11-01", NY));
    expect(surfaced({ checkedAt: null, surfaceAt: november }, Date.parse("2026-11-01T03:30:00.000Z"), NY)).toBe(false);
    expect(surfaced({ checkedAt: null, surfaceAt: november }, Date.parse("2026-11-01T04:30:00.000Z"), NY)).toBe(true);
    expect(surfaced({ checkedAt: null, surfaceAt: november }, Date.parse("2026-11-01T06:30:00.000Z"), NY)).toBe(true);

    const afterFallback = must(parseSurface("2026-11-02", NY));
    expect(surfaced({ checkedAt: null, surfaceAt: afterFallback }, Date.parse("2026-11-02T04:30:00.000Z"), NY)).toBe(false);
    expect(surfaced({ checkedAt: null, surfaceAt: afterFallback }, Date.parse("2026-11-02T05:30:00.000Z"), NY)).toBe(true);
  });

  it("at 2026-11-07T20:30Z the New York date has not arrived and the Tokyo date has", () => {
    const now = Date.parse("2026-11-07T20:30:00.000Z");
    const york = must(parseSurface("2026-11-08", NY));
    const tokyo = must(parseSurface("2026-11-08", "Asia/Tokyo"));
    expect(surfaced({ checkedAt: null, surfaceAt: york }, now, NY)).toBe(false);
    expect(surfaced({ checkedAt: null, surfaceAt: tokyo }, now, "Asia/Tokyo")).toBe(true);
    const utcDay = new Date(now).toISOString().slice(0, 10);
    expect(utcDay).toBe("2026-11-07");
    expect(surfaced({ checkedAt: null, surfaceAt: york }, now, NY)).toBe(false);
  });
});

function must(result: { ok: true; value: number } | { ok: false; message: string }): number {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
