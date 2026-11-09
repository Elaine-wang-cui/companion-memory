/**
 * In-memory rules from ChuApp PromiseModels / PromiseDemoStore at
 * 057e2be0b529a3028009758e38cece6257dd44bd.
 *
 * due_at and surface_at do not read each other.
 * due_at decides the flower and whether the page can check.
 * surface_at decides only the wake list. An empty surface on an open
 * item wakes every time, including a page item that never set one.
 * Overdue is due_at < now. The exact due instant can be checked and is
 * still a bud, not an owed flower.
 */

import { startOfLocalDay } from "./zone";

export const PROMISE_AUTHORS = ["chu", "yanyan"] as const;
export type PromiseAuthor = (typeof PROMISE_AUTHORS)[number];

export const WAKE_LIMIT = 10;
/** The flower page shows the latest replies. The store still keeps every reply. */
export const REPLY_PREVIEW_LIMIT = 3;

export type Bloom = "bud" | "owed" | "open";
export type PromiseStatus = "open" | "done";

export interface PromiseFields {
  id: string;
  author: PromiseAuthor;
  createdAt: number;
  dueAt: number | null;
  surfaceAt: number | null;
  checkedBy: PromiseAuthor | null;
  checkedAt: number | null;
}

export function isPromiseAuthor(value: unknown): value is PromiseAuthor {
  return value === "chu" || value === "yanyan";
}

export function statusOf(item: { checkedAt: number | null }): PromiseStatus {
  return item.checkedAt == null ? "open" : "done";
}

/** Flower. surface_at is not an input. */
export function bloom(item: { checkedAt: number | null; dueAt: number | null }, now: number): Bloom {
  if (item.checkedAt != null) return "open";
  if (item.dueAt != null && item.dueAt < now) return "owed";
  return "bud";
}

/** Wake membership. due_at is not an input. Checked items never wake. */
export function surfaced(
  item: { checkedAt: number | null; surfaceAt: number | null },
  now: number,
  timeZone: string,
): boolean {
  if (item.checkedAt != null) return false;
  if (item.surfaceAt == null) return true;
  return startOfLocalDay(item.surfaceAt, timeZone) <= startOfLocalDay(now, timeZone);
}

/** Page toggle. The author cannot check their own item. due_at must have arrived. */
export function canCheck(
  item: { author: PromiseAuthor; checkedAt: number | null; dueAt: number | null },
  viewer: PromiseAuthor,
  now: number,
): boolean {
  if (item.checkedAt != null || viewer === item.author) return false;
  if (item.dueAt == null) return true;
  return now >= item.dueAt;
}

/** Only the person who checked can undo. Undo clears resolution. */
export function canUncheck(
  item: { checkedAt: number | null; checkedBy: PromiseAuthor | null },
  viewer: PromiseAuthor,
): boolean {
  return item.checkedAt != null && item.checkedBy === viewer;
}

export function wakeList<T extends PromiseFields>(
  items: readonly T[],
  now: number,
  timeZone: string,
  limit = WAKE_LIMIT,
): { items: T[]; remaining: number } {
  const due = items.filter((item) => surfaced(item, now, timeZone));
  due.sort((a, b) => {
    const aEmpty = a.surfaceAt == null ? 0 : 1;
    const bEmpty = b.surfaceAt == null ? 0 : 1;
    if (aEmpty !== bEmpty) return aEmpty - bEmpty;
    const aSurface = a.surfaceAt ?? 0;
    const bSurface = b.surfaceAt ?? 0;
    if (aSurface !== bSurface) return aSurface - bSurface;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return { items: due.slice(0, limit), remaining: Math.max(0, due.length - limit) };
}

/**
 * Flower timeline order: oldest owed, then nearest upcoming due,
 * then undated newest first, then recently checked.
 * Unchecking drops the item back into the open bucket.
 */
export function pageOrder<T extends PromiseFields>(items: readonly T[], now: number): T[] {
  const rank = (item: T): [number, number, string] => {
    if (item.checkedAt == null && item.dueAt != null && item.dueAt < now) return [0, item.dueAt, item.id];
    if (item.checkedAt == null && item.dueAt != null) return [1, item.dueAt, item.id];
    if (item.checkedAt == null) return [2, -item.createdAt, item.id];
    return [3, -(item.checkedAt ?? 0), item.id];
  };
  return [...items].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    if (left[0] !== right[0]) return left[0] - right[0];
    if (left[1] !== right[1]) return left[1] - right[1];
    if (left[2] < right[2]) return -1;
    if (left[2] > right[2]) return 1;
    return 0;
  });
}
