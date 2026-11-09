/**
 * DDL for the promise tables.
 *
 * The migration file migrations/9000_companion_promises_placeholder.sql
 * repeats this text after a warning banner. A test locks the two copies
 * together. 9000 is a placeholder: before any approved transplant, rename
 * that file to the number after the live database's actual last migration.
 * Source references include 0018_moments.sql and 0019_bottles.sql; that
 * list is incomplete and does not prove 0019 is last. This repo stops at
 * 0017 and is not the live baseline.
 *
 * These statements create new tables only. They do not read or write
 * garden_entries, unresolved, or memory_pair_checks.
 */
export const PROMISE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS companion_promises (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('chu', 'yanyan')),
  "text" TEXT NOT NULL CHECK (length("text") > 0),
  due_at TEXT,
  surface_at TEXT,
  checked_by TEXT CHECK (checked_by IS NULL OR checked_by IN ('chu', 'yanyan')),
  checked_at TEXT,
  resolution TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'done')),
  created_at TEXT NOT NULL,
  CHECK (
    (status = 'open' AND checked_at IS NULL AND checked_by IS NULL AND resolution IS NULL)
    OR (status = 'done' AND checked_at IS NOT NULL AND checked_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_promises_id_persona
  ON companion_promises (id, persona_id);

CREATE INDEX IF NOT EXISTS idx_companion_promises_persona_status
  ON companion_promises (persona_id, status, created_at);

CREATE TABLE IF NOT EXISTS companion_promise_replies (
  id TEXT PRIMARY KEY,
  promise_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('chu', 'yanyan')),
  "text" TEXT NOT NULL CHECK (length("text") > 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (promise_id, persona_id) REFERENCES companion_promises (id, persona_id)
);

CREATE INDEX IF NOT EXISTS idx_companion_promise_replies_promise
  ON companion_promise_replies (persona_id, promise_id, created_at);
`.trim();

export function promiseSchemaStatements(): string[] {
  return PROMISE_SCHEMA_SQL.split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => `${part};`);
}
