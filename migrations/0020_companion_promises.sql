-- 0020_companion_promises.sql
-- Repeatable. Every statement is CREATE TABLE IF NOT EXISTS or
-- CREATE INDEX IF NOT EXISTS. No ALTER. No DROP.
-- Running this file twice does not change tables that already exist.
--
-- Live D1, from a read-only check that did not read row contents:
--   database_name = yanyan-memory
--   database_id   = edadcb8c-94c7-4cb3-a828-8f84739f5fa7
--   binding       = DB
-- That database has no d1_migrations table, so it is not on the standard
-- wrangler migration ledger. Do not apply this repository's migrations
-- directory. After a separate user approval, execute only this file.
--
-- The live worker source's highest referenced migration filename is
-- 0019_bottles.sql. Whether that file has been applied is still 待核对.
-- If a later check finds a higher referenced migration, rename this file
-- before executing it. The same check found no companion_promises,
-- companion_promise_replies, or any other promise/surface table.
-- companion_notes and emotion_pending are unrelated and must be left alone.
--
-- This public repository is not the live worker. Do not deploy it.
-- Do not copy garden_entries or unresolved into these tables.
-- checked_at here is the promise check, not memory_pair_checks.
-- See Docs/deploy/promises-port-to-live-v216.md. Every live step needs
-- its own user approval.

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
