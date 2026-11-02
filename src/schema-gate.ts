import type { MemoryDb } from "./types";

/**
 * 冷启动快速通道：所有运行时建表/迁移都跑过一次后，在 _schema_meta 记一个版本号。
 * 之后每个新 isolate 只需 1 次查询就能跳过 ~25 条串行 DDL（那是手机端 -1001 超时的元凶）。
 * 改了任何 ensure*Schema / 迁移 SQL 时，务必改 SCHEMA_VERSION。
 */
export const SCHEMA_VERSION = "2026-11-02-emotion-net-recall-tags-v1";
let gate: Promise<boolean> | null = null;

export function schemaCurrent(db: MemoryDb): Promise<boolean> {
  if (!gate) {
    gate = db
      .prepare(`SELECT v FROM _schema_meta WHERE k = 'schema'`)
      .first<{ v: string }>()
      .then((r) => r?.v === SCHEMA_VERSION)
      .catch(() => false);
  }
  return gate;
}

/** 只在全部 ensure 成功后调用。 */
export async function markSchemaCurrent(db: MemoryDb): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS _schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`).run();
  await db.prepare(`INSERT INTO _schema_meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(SCHEMA_VERSION).run();
  gate = Promise.resolve(true);
}

/** 测试用 */
export function resetSchemaGate() { gate = null; }
