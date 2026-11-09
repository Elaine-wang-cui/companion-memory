/**
 * Business timezone for promise surface days.
 *
 * The default is America/New_York (IANA, daylight-saving rules included).
 * Callers pass another canonical IANA name to override it. Numeric offsets,
 * abbreviations such as EST, and the house clock TZ_OFFSET_MINUTES are not
 * accepted. Shanghai / bjTime in the live session text are a different clock
 * and are not read here.
 */

export const DEFAULT_PROMISE_TIMEZONE = "America/New_York";

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

let canonicalZones: Set<string> | null = null;

function canonicalZoneSet(): Set<string> {
  if (!canonicalZones) {
    if (typeof Intl.supportedValuesOf !== "function") {
      throw new Error("Intl.supportedValuesOf is required to validate IANA time zones");
    }
    canonicalZones = new Set(Intl.supportedValuesOf("timeZone"));
  }
  return canonicalZones;
}

/** Canonical IANA zone. Empty input selects America/New_York. */
export function resolvePromiseTimezone(raw: string | null | undefined): ParseResult<string> {
  const zone = (raw ?? "").trim() || DEFAULT_PROMISE_TIMEZONE;
  let known: Set<string>;
  try {
    known = canonicalZoneSet();
  } catch {
    return { ok: false, message: "运行时不能枚举 IANA 时区，约定拒绝用数字偏移顶上。" };
  }
  if (!known.has(zone)) {
    return {
      ok: false,
      message: `业务时区「${zone}」不是可用的 IANA 时区。默认是 America/New_York，不接受数字偏移或 EST 这类缩写。`,
    };
  }
  return { ok: true, value: zone };
}

export function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  let day = Number(bag.day);
  let month = Number(bag.month);
  let year = Number(bag.year);
  // A few engines report midnight as 24:00 on the previous civil date.
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  return {
    year,
    month,
    day,
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
    ms: Number(bag.fractionalSecond ?? "0"),
  };
}

/** Minutes east of UTC at this instant. Changes across a daylight-saving transition. */
export function offsetMinutes(epochMs: number, timeZone: string): number {
  const parts = zonedParts(epochMs, timeZone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.ms);
  return Math.round((wall - epochMs) / 60_000);
}

/** UTC epoch of local midnight. Fails closed if that civil midnight does not exist. */
export function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  let epoch = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let i = 0; i < 4; i++) {
    const shift = offsetMinutes(epoch, timeZone);
    const next = Date.UTC(year, month - 1, day, 0, 0, 0) - shift * 60_000;
    if (next === epoch) break;
    epoch = next;
  }
  const got = zonedParts(epoch, timeZone);
  if (got.year !== year || got.month !== month || got.day !== day || got.hour !== 0 || got.minute !== 0 || got.second !== 0 || got.ms !== 0) {
    throw new Error(`no local midnight for ${year}-${month}-${day} in ${timeZone}`);
  }
  return epoch;
}

export function startOfLocalDay(epochMs: number, timeZone: string): number {
  const parts = zonedParts(epochMs, timeZone);
  return localMidnight(parts.year, parts.month, parts.day, timeZone);
}

export function civilDate(epochMs: number, timeZone: string): string {
  const parts = zonedParts(epochMs, timeZone);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function formatOffsetIso(epochMs: number, timeZone: string): string {
  const parts = zonedParts(epochMs, timeZone);
  const offset = offsetMinutes(epochMs, timeZone);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}` +
    `T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(parts.ms, 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** An exact instant. Naive wall times are rejected so UTC is not assumed. */
export function parseInstant(raw: string): ParseResult<number> {
  const text = raw.trim();
  if (!INSTANT.test(text)) {
    return { ok: false, message: "时间点要带时区偏移，例如 2026-11-08T15:00:00-05:00。" };
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return { ok: false, message: "时间点无法解析。" };
  return { ok: true, value: ms };
}

/**
 * A surface value. YYYY-MM-DD is local midnight in the business zone,
 * not UTC midnight. An offset instant is kept as that instant.
 */
export function parseSurface(raw: string, timeZone: string): ParseResult<number> {
  const text = raw.trim();
  const date = DATE_ONLY.exec(text);
  if (date) {
    const year = Number(date[1]);
    const month = Number(date[2]);
    const day = Number(date[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return { ok: false, message: "冒出日期不是合法的公历日期。" };
    }
    try {
      const epoch = localMidnight(year, month, day, timeZone);
      const got = zonedParts(epoch, timeZone);
      if (got.year !== year || got.month !== month || got.day !== day) {
        return { ok: false, message: "冒出日期不是合法的公历日期。" };
      }
      return { ok: true, value: epoch };
    } catch {
      return { ok: false, message: "这个业务时区里没有该日的零点。" };
    }
  }
  return parseInstant(text);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}
