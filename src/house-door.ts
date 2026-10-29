import { CFG } from "./config";
/** Persist which house MCP door was picked (stateless MCP needs storage). */

import type { Caller, MemoryDb, Persona } from "./types";
import { HOUSE_PERSONA } from "./types";
import { AppError } from "./errors";
import { doorById, doorPersonaId, type DoorDef } from "./doors";

export type HouseDoor = string;

/** Per-window door state (legacy singleton table house_door id=1 is left unused). */
const TABLE = `CREATE TABLE IF NOT EXISTS house_door_session (
  session_key TEXT PRIMARY KEY,
  door TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;
const STARTED_TABLE = `CREATE TABLE IF NOT EXISTS house_door_session_started (
  session_key TEXT PRIMARY KEY,
  started INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
)`;

export async function ensureHouseDoorTable(db: MemoryDb): Promise<void> {
  await db.prepare(TABLE).run();
  // One-time copy from old singleton if present and default empty.
  try {
    const existing = await db
      .prepare(`SELECT door FROM house_door_session WHERE session_key = 'default'`)
      .first<{ door: string }>();
    if (!existing) {
    const legacy = await db
      .prepare(`SELECT door FROM house_door WHERE id = 1`)
      .first<{ door: string }>();
    if (legacy && doorById(legacy.door)) {
      await db
        .prepare(
          `INSERT INTO house_door_session (session_key, door, updated_at) VALUES ('default', ?, datetime('now'))`,
        )
        .bind(legacy.door)
        .run();
    }
    }
  } catch {
    // Old table may not exist.
  }
  await db.prepare(STARTED_TABLE).run();
}

export async function setHouseDoor(
  db: MemoryDb,
  door: HouseDoor,
  sessionKey = "default",
): Promise<void> {
  await ensureHouseDoorTable(db);
  const key = sessionKey.trim() || "default";
  await db
    .prepare(
      `INSERT INTO house_door_session (session_key, door, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(session_key) DO UPDATE SET door = excluded.door, updated_at = excluded.updated_at`,
    )
    .bind(key, door)
    .run();
  // Choosing a door resets session_started — caller must session_start next.
  await db
    .prepare(
      `INSERT INTO house_door_session_started (session_key, started, updated_at) VALUES (?, 0, datetime('now'))
       ON CONFLICT(session_key) DO UPDATE SET started = 0, updated_at = excluded.updated_at`,
    )
    .bind(key)
    .run();
}

export async function markHouseSessionStarted(
  db: MemoryDb,
  sessionKey = "default",
): Promise<void> {
  await ensureHouseDoorTable(db);
  const key = sessionKey.trim() || "default";
  await db
    .prepare(
      `INSERT INTO house_door_session_started (session_key, started, updated_at) VALUES (?, 1, datetime('now'))
       ON CONFLICT(session_key) DO UPDATE SET started = 1, updated_at = excluded.updated_at`,
    )
    .bind(key)
    .run();
}

export async function isHouseSessionStarted(
  db: MemoryDb,
  sessionKey = "default",
): Promise<boolean> {
  await ensureHouseDoorTable(db);
  const key = sessionKey.trim() || "default";
  const row = await db
    .prepare(`SELECT started FROM house_door_session_started WHERE session_key = ?`)
    .bind(key)
    .first<{ started: number }>();
  return Boolean(row && row.started);
}

export async function getHouseDoor(
  db: MemoryDb,
  sessionKey = "default",
): Promise<HouseDoor | null> {
  await ensureHouseDoorTable(db);
  const key = sessionKey.trim() || "default";
  const row = await db
    .prepare(`SELECT door FROM house_door_session WHERE session_key = ?`)
    .bind(key)
    .first<{ door: string }>();
  if (!row) return null;
  if (doorById(row.door)) return row.door;
  return null;
}

async function loadPersonaCaller(db: MemoryDb, id: string, isAdmin: boolean): Promise<Caller> {
  const row = await db
    .prepare(
      `SELECT id, display_name, relationship_to_user, self_card, created_at, updated_at
       FROM personas WHERE id = ?`,
    )
    .bind(id)
    .first<Persona>();
  if (!row) throw new AppError(404, "not_found", `没有人格「${id}」。先建这个人格再开门。`);
  return { persona: row, isAdmin };
}

/** The primary companion (PRIMARY_PERSONA). */
export function loadPrimaryCaller(db: MemoryDb): Promise<Caller> {
  return loadPersonaCaller(db, CFG.primary, false);
}

/** Caller for a configured door (see DOORS in doors.ts). */
export function loadDoorCaller(db: MemoryDb, door: DoorDef): Promise<Caller> {
  return loadPersonaCaller(db, doorPersonaId(door), door.houseWide);
}

/** After a door is picked the window acts as that persona; unset stays the house keeper. */
export async function activeDoorCaller(
  db: MemoryDb,
  houseCaller: Caller,
  sessionKey = "default",
): Promise<Caller> {
  if (houseCaller.persona.id !== "house") return houseCaller;
  const door = doorById(await getHouseDoor(db, sessionKey));
  if (door) return loadDoorCaller(db, door);
  return { persona: HOUSE_PERSONA, isAdmin: true };
}

/** Resolve a per-window door key from the MCP HTTP request. */
export function doorSessionKeyFromRequest(request: Request): string {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("door_session")?.trim();
  if (fromQuery) return fromQuery.slice(0, 128);
  const fromHeader =
    request.headers.get("mcp-session-id")?.trim() ||
    request.headers.get("Mcp-Session-Id")?.trim();
  if (fromHeader) return fromHeader.slice(0, 128);
  return "default";
}
