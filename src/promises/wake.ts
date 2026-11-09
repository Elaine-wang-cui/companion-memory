/**
 * Optional session-start appendix.
 *
 * Default off. When off, the original text is returned and the database
 * is not touched. When on, the section is appended after the existing
 * text. It does not remove 【未了的事】 and it does not call sessionStart.
 * The host may call this after its own sessionStart. This module does not.
 */

import { AppError } from "../errors";
import type { MemoryDb } from "../types";
import { ensurePromiseSchema, PromiseStore, type PromiseRecord } from "./store";
import { resolvePromiseTimezone } from "./zone";

export const PROMISE_WAKE_APPENDIX_DEFAULT = false;

export function renderPromiseWakeSection(items: readonly { text: string }[], remaining: number): string {
  const lines = [`【约定】${items.length} 件`];
  for (const item of items) lines.push(`· ${item.text}`);
  if (remaining > 0) lines.push(`还有 ${remaining} 条`);
  return lines.join("\n");
}

/** Pure append. `enabled` defaults to false, and a false value does not call `load`. */
export async function appendPromiseWake(
  sessionText: string,
  load: () => Promise<{ items: readonly { text: string }[]; remaining: number }>,
  enabled: boolean = PROMISE_WAKE_APPENDIX_DEFAULT,
): Promise<string> {
  if (!enabled) return sessionText;
  const wake = await load();
  const base = sessionText.replace(/\s*$/, "");
  return `${base}\n\n${renderPromiseWakeSection(wake.items, wake.remaining)}`;
}

export async function appendPromiseWakeForPersona(
  db: MemoryDb,
  personaId: string,
  sessionText: string,
  opts?: { enabled?: boolean; timeZone?: string; now?: number },
): Promise<string> {
  return appendPromiseWake(
    sessionText,
    async () => {
      const zone = resolvePromiseTimezone(opts?.timeZone);
      if (!zone.ok) throw new AppError(500, "promise_timezone", zone.message);
      await ensurePromiseSchema(db);
      const store = new PromiseStore(db, zone.value);
      const wake = await store.wake(personaId, opts?.now ?? Date.now());
      return { items: wake.items.map((item: PromiseRecord) => ({ text: item.text })), remaining: wake.remaining };
    },
    opts?.enabled ?? PROMISE_WAKE_APPENDIX_DEFAULT,
  );
}
