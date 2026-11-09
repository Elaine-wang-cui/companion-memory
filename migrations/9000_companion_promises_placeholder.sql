-- PLACEHOLDER MIGRATION NUMBER 9000.
-- This file is not the next live migration and must not be applied to the
-- live D1 database. Do not run `wrangler d1 migrations apply --remote`.
-- Do not deploy this repository's Worker over the live Worker.
--
-- Public companion-memory main stops at migrations/0017_memory_tags.sql.
-- Live source references include 0018_moments.sql and 0019_bottles.sql.
-- That filename list is incomplete: it does not prove those numbers exist
-- as applied migrations, and it does not prove 0019 is the last one.
-- Before a user-approved transplant, rename this file to
-- (live database's actual last migration number + 1) and re-port the
-- module onto the live source. Do not replay 0001–0017 onto that database.
-- 上线前必须按线上实际最后一条迁移重新编号，并经用户批准后再移植。不得把本仓库整包覆盖线上。
--
-- New tables only. Do not copy rows from garden_entries (including
-- kind = 'promise') or from unresolved. Do not write memory_pair_checks.
-- checked_at here is the promise check, not the memory-pair column.

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
