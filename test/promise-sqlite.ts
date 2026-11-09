import { DatabaseSync } from "node:sqlite";
import type { MemoryDb, Prepared } from "../src/types";

type SqlValue = string | number | bigint | Uint8Array | null;

export interface SyntheticDb extends MemoryDb {
  raw: DatabaseSync;
}

/** In-memory SQLite with the same prepare/bind shape as D1. Nothing here is remote. */
export function openSyntheticDb(schemaSql?: string): SyntheticDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  if (schemaSql) raw.exec(schemaSql);
  return {
    raw,
    prepare(sql: string): Prepared {
      return statement(raw, sql, []);
    },
  };
}

function statement(raw: DatabaseSync, sql: string, values: unknown[]): Prepared {
  const args = values.map((value) => (value === undefined ? null : value)) as SqlValue[];
  return {
    bind(...next: unknown[]) {
      return statement(raw, sql, next);
    },
    async all<T>() {
      const results = raw.prepare(sql).all(...args) as T[];
      return { results };
    },
    async first<T>(column?: string) {
      const row = raw.prepare(sql).get(...args) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (column) return (row[column] ?? null) as T | null;
      return row as T;
    },
    async run() {
      const info = raw.prepare(sql).run(...args);
      return { meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) } };
    },
  };
}
