import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROMISE_SCHEMA_SQL, promiseSchemaStatements } from "../src/promises/schema";
import { PromiseStore, ensurePromiseSchema } from "../src/promises/store";
import { parseSurface } from "../src/promises/zone";
import { openSyntheticDb } from "./promise-sqlite";

const NY = "America/New_York";
const MIGRATION = "migrations/9000_companion_promises_placeholder.sql";

async function storeAt(zone = NY) {
  const db = openSyntheticDb();
  await ensurePromiseSchema(db);
  return { db, store: new PromiseStore(db, zone) };
}

function surface(day: string, zone = NY): number {
  const parsed = parseSurface(day, zone);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

describe("placeholder migration", () => {
  it("uses a placeholder number and the same DDL the module applies", () => {
    const file = readFileSync(MIGRATION, "utf8");
    expect(MIGRATION).toMatch(/9000_/);
    expect(file).toContain("PLACEHOLDER");
    expect(file).toContain("0019_bottles.sql");
    expect(file).toContain("重新编号");
    expect(file).not.toMatch(/^0018_/);
    const ddl = file
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    expect(ddl).toBe(PROMISE_SCHEMA_SQL);
    expect(PROMISE_SCHEMA_SQL).not.toContain("garden_entries");
    expect(PROMISE_SCHEMA_SQL).not.toContain("unresolved");
    expect(PROMISE_SCHEMA_SQL).not.toContain("memory_pair_checks");
    for (const statement of promiseSchemaStatements()) {
      expect(statement.startsWith("CREATE")).toBe(true);
    }
  });

  it("applies from the migration file without touching the older tables", () => {
    const file = readFileSync(MIGRATION, "utf8");
    const db = openSyntheticDb();
    db.raw.exec(`
      CREATE TABLE garden_entries (id TEXT PRIMARY KEY, kind TEXT, body TEXT);
      CREATE TABLE unresolved (id TEXT PRIMARY KEY, content TEXT, status TEXT);
      CREATE TABLE memory_pair_checks (a TEXT, b TEXT, verdict TEXT, checked_at TEXT);
      INSERT INTO garden_entries (id, kind, body) VALUES ('g1', 'promise', 'old-garden-note');
      INSERT INTO unresolved (id, content, status) VALUES ('u1', 'old-open-loop', 'open');
      INSERT INTO memory_pair_checks (a, b, verdict, checked_at) VALUES ('m1', 'm2', 'same', '2026-01-01T00:00:00.000Z');
    `);
    db.raw.exec(file);
    const names = db.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[];
    expect(names.map((row) => row.name)).toEqual([
      "companion_promise_replies",
      "companion_promises",
      "garden_entries",
      "memory_pair_checks",
      "unresolved",
    ]);
    expect(db.raw.prepare(`SELECT body FROM garden_entries`).get()).toEqual({ body: "old-garden-note" });
    expect(db.raw.prepare(`SELECT content, status FROM unresolved`).get()).toEqual({ content: "old-open-loop", status: "open" });
    expect(db.raw.prepare(`SELECT checked_at FROM memory_pair_checks`).get()).toEqual({ checked_at: "2026-01-01T00:00:00.000Z" });
  });
});

describe("promise store", () => {
  it("writes due only from the page and surface only from content", async () => {
    const { db, store } = await storeAt();
    const now = Date.parse("2026-11-08T16:00:00.000Z");
    const page = await store.addPage({
      personaId: "chu",
      author: "yanyan",
      text: "  synthetic-page  ",
      dueAt: Date.parse("2026-11-09T20:00:00.000Z"),
      now,
    });
    const content = await store.addContent({
      personaId: "chu",
      text: "synthetic-content",
      surfaceAt: surface("2026-11-18"),
      now,
    });
    expect(page?.surfaceAt).toBeNull();
    expect(page?.dueAt).toBe(Date.parse("2026-11-09T20:00:00.000Z"));
    expect(page?.author).toBe("yanyan");
    expect(content?.dueAt).toBeNull();
    expect(content?.author).toBe("chu");
    expect(content?.surfaceAt).toBe(surface("2026-11-18"));
    const raw = db.raw.prepare(`SELECT id, surface_at, due_at FROM companion_promises ORDER BY id`).all() as {
      id: string;
      surface_at: string | null;
      due_at: string | null;
    }[];
    const pageRow = raw.find((row) => row.id.startsWith("p-"));
    const contentRow = raw.find((row) => row.id.startsWith("c-"));
    expect(pageRow?.surface_at).toBeNull();
    expect(contentRow?.due_at).toBeNull();
    expect(await store.addPage({ personaId: "chu", author: "yanyan", text: "   ", dueAt: null, now })).toBeNull();
  });

  it("stores a summer date at eastern daylight midnight, not a fixed -05:00", async () => {
    const { db, store } = await storeAt();
    const now = Date.parse("2026-07-01T15:00:00.000Z");
    const item = await store.addContent({ personaId: "chu", text: "summer", surfaceAt: surface("2026-07-15"), now });
    const winter = await store.addContent({ personaId: "chu", text: "winter", surfaceAt: surface("2026-01-15"), now });
    expect(item?.surfaceAt).toBe(Date.parse("2026-07-15T04:00:00.000Z"));
    expect(winter?.surfaceAt).toBe(Date.parse("2026-01-15T05:00:00.000Z"));
    const rows = db.raw.prepare(`SELECT "text" AS promise_text, surface_at FROM companion_promises`).all() as {
      promise_text: string;
      surface_at: string;
    }[];
    expect(rows.find((row) => row.promise_text === "summer")?.surface_at).toBe("2026-07-15T04:00:00.000Z");
    expect(rows.find((row) => row.promise_text === "winter")?.surface_at).toBe("2026-01-15T05:00:00.000Z");
  });

  it("lets only the other person check, and only the checker undo", async () => {
    const { store } = await storeAt();
    let now = Date.parse("2026-11-08T15:00:00.000Z");
    const item = await store.addPage({
      personaId: "chu",
      author: "yanyan",
      text: "synthetic-sleep",
      dueAt: Date.parse("2026-11-08T23:00:00.000Z"),
      now,
    });
    expect(item).not.toBeNull();
    const id = item!.id;
    const earlySelf = await store.toggleCheck("chu", id, "yanyan", now);
    expect(earlySelf.ok && earlySelf.applied).toBe(false);
    if (earlySelf.ok && !earlySelf.applied) expect(earlySelf.reason).toBe("self");
    const earlyOther = await store.toggleCheck("chu", id, "chu", now);
    expect(earlyOther.ok && earlyOther.applied).toBe(false);
    if (earlyOther.ok && !earlyOther.applied) expect(earlyOther.reason).toBe("early");
    now = Date.parse("2026-11-08T23:00:00.000Z");
    const checked = await store.toggleCheck("chu", id, "chu", now);
    expect(checked.ok && checked.applied && checked.action).toBe("check");
    if (checked.ok && checked.applied) {
      expect(checked.item.checkedBy).toBe("chu");
      expect(checked.item.status).toBe("done");
      expect(checked.item.bloom).toBe("open");
    }
    const wrongUndo = await store.toggleCheck("chu", id, "yanyan", now);
    expect(wrongUndo.ok && wrongUndo.applied).toBe(false);
    const undone = await store.toggleCheck("chu", id, "chu", now);
    expect(undone.ok && undone.applied && undone.action).toBe("uncheck");
    if (undone.ok && undone.applied) {
      expect(undone.item.checkedAt).toBeNull();
      expect(undone.item.checkedBy).toBeNull();
      expect(undone.item.resolution).toBeNull();
      expect(undone.item.status).toBe("open");
    }
  });

  it("closes as chu, including chu's own item, and ignores defer after that", async () => {
    const { store } = await storeAt();
    const now = Date.parse("2026-11-08T16:00:00.000Z");
    const own = await store.addContent({ personaId: "chu", text: "synthetic-own", surfaceAt: null, now });
    expect(own).not.toBeNull();
    const blocked = await store.toggleCheck("chu", own!.id, "chu", now);
    expect(blocked.ok && blocked.applied).toBe(false);
    const closed = await store.close("chu", own!.id, "synthetic-resolution", now);
    expect(closed.ok && closed.applied).toBe(true);
    if (closed.ok && closed.applied) {
      expect(closed.item.checkedBy).toBe("chu");
      expect(closed.item.resolution).toBe("synthetic-resolution");
    }
    const wake = await store.wake("chu", now);
    expect(wake.items).toEqual([]);
    expect(wake.remaining).toBe(0);
    const deferred = await store.defer("chu", own!.id, surface("2026-12-01"), now);
    expect(deferred.ok && deferred.applied).toBe(false);
    if (deferred.ok) expect(deferred.item.surfaceAt).toBeNull();

    const hers = await store.addPage({ personaId: "chu", author: "yanyan", text: "synthetic-hers", dueAt: null, now });
    const attributed = await store.close("chu", hers!.id, null, now);
    expect(attributed.ok && attributed.applied).toBe(true);
    if (attributed.ok && attributed.applied) expect(attributed.item.checkedBy).toBe("chu");
    const again = await store.close("chu", hers!.id, "later", now);
    expect(again.ok && again.applied).toBe(false);
  });

  it("defers an open item off the wake list and keeps a null surface in front", async () => {
    const { store } = await storeAt();
    let now = Date.parse("2026-11-08T16:00:00.000Z");
    const pushed = await store.addContent({ personaId: "chu", text: "synthetic-push", surfaceAt: null, now });
    const dated = await store.addContent({
      personaId: "chu",
      text: "synthetic-dated",
      surfaceAt: surface("2026-11-02"),
      now: now + 1,
    });
    now += 2;
    const empty = await store.addPage({ personaId: "chu", author: "yanyan", text: "synthetic-empty", dueAt: null, now });
    let wake = await store.wake("chu", now);
    expect(wake.items.map((item) => item.id)).toEqual([pushed!.id, empty!.id, dated!.id]);
    await store.defer("chu", pushed!.id, surface("2026-11-09"), now);
    wake = await store.wake("chu", now);
    expect(wake.items.map((item) => item.id)).toEqual([empty!.id, dated!.id]);
  });

  it("returns ten wake rows and counts the eleventh", async () => {
    const { store } = await storeAt();
    const base = Date.parse("2026-11-08T12:00:00.000Z");
    for (let index = 0; index < 11; index++) {
      await store.addContent({
        personaId: "chu",
        text: `synthetic-${index}`,
        surfaceAt: null,
        now: base + index * 60_000,
      });
    }
    const wake = await store.wake("chu", base + 11 * 60_000);
    expect(wake.items.map((item) => item.text)).toEqual(Array.from({ length: 10 }, (_, index) => `synthetic-${index}`));
    expect(wake.remaining).toBe(1);
  });

  it("does not spend a wake slot on a checked item or a future surface", async () => {
    const { store } = await storeAt();
    const now = Date.parse("2026-11-08T16:00:00.000Z");
    const kept = await store.addContent({ personaId: "chu", text: "synthetic-keep", surfaceAt: null, now });
    const done = await store.addContent({ personaId: "chu", text: "synthetic-done", surfaceAt: null, now: now + 1 });
    await store.addContent({ personaId: "chu", text: "synthetic-later", surfaceAt: surface("2026-11-20"), now: now + 2 });
    await store.close("chu", done!.id, null, now + 3);
    const wake = await store.wake("chu", now + 3);
    expect(wake.items.map((item) => item.id)).toEqual([kept!.id]);
    expect(wake.remaining).toBe(0);
  });

  it("a future due with no surface still wakes, and a past due with a future surface does not", async () => {
    const { store } = await storeAt();
    const now = Date.parse("2026-11-08T16:00:00.000Z");
    const page = await store.addPage({
      personaId: "chu",
      author: "yanyan",
      text: "future-due",
      dueAt: Date.parse("2026-12-01T15:00:00.000Z"),
      now,
    });
    const owed = await store.addPage({
      personaId: "chu",
      author: "chu",
      text: "owed-but-not-awake",
      dueAt: Date.parse("2026-11-01T15:00:00.000Z"),
      now,
    });
    await store.defer("chu", owed!.id, surface("2026-11-20"), now);
    const early = await store.toggleCheck("chu", page!.id, "chu", now);
    expect(early.ok && !early.applied && early.reason).toBe("early");
    const wake = await store.wake("chu", now);
    expect(wake.items.map((item) => item.text)).toEqual(["future-due"]);
    const pageRows = await store.page("chu", now);
    expect(pageRows[0]?.id).toBe(owed!.id);
    expect(pageRows[0]?.bloom).toBe("owed");
    expect(pageRows[0]?.dueAt).toBe(Date.parse("2026-11-01T15:00:00.000Z"));
    expect(pageRows[0]?.surfaceAt).toBe(surface("2026-11-20"));
    const checked = await store.toggleCheck("chu", owed!.id, "yanyan", now);
    expect(checked.ok && checked.applied && checked.action).toBe("check");
    const after = await store.wake("chu", now);
    expect(after.items.map((item) => item.text)).toEqual(["future-due"]);
  });

  it("keeps personas apart and stores a quote as text", async () => {
    const { db, store } = await storeAt();
    const now = Date.parse("2026-11-08T16:00:00.000Z");
    const mine = await store.addContent({ personaId: "chu", text: "'); DROP TABLE companion_promises; --", surfaceAt: null, now });
    await store.addContent({ personaId: "other", text: "other-persona", surfaceAt: null, now });
    const wake = await store.wake("chu", now);
    expect(wake.items.map((item) => item.id)).toEqual([mine!.id]);
    const missing = await store.toggleCheck("other", mine!.id, "yanyan", now);
    expect(missing).toEqual({ ok: false, reason: "missing" });
    const names = db.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'companion_promises'`).all();
    expect(names).toHaveLength(1);
    const stored = db.raw.prepare(`SELECT "text" AS promise_text FROM companion_promises WHERE persona_id = 'chu'`).get() as {
      promise_text: string;
    };
    expect(stored.promise_text).toContain("DROP TABLE");
  });

  it("rejects a reply aimed at another persona's row", async () => {
    const { db, store } = await storeAt();
    const now = Date.parse("2026-11-08T16:00:00.000Z");
    const item = await store.addContent({ personaId: "chu", text: "with-reply", surfaceAt: null, now });
    const replied = await store.reply("chu", item!.id, "yanyan", "heard", now);
    expect(replied.ok && replied.applied).toBe(true);
    if (replied.ok && replied.applied) {
      expect(replied.item.replies).toHaveLength(1);
      expect(replied.item.replies[0]?.author).toBe("yanyan");
    }
    const foreign = await store.reply("other", item!.id, "chu", "nope", now);
    expect(foreign).toEqual({ ok: false, reason: "missing" });
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO companion_promise_replies (id, promise_id, persona_id, author, "text", created_at)
           VALUES ('r-foreign', ?, 'other', 'chu', 'nope', '2026-11-08T16:00:00.000Z')`,
        )
        .run(item!.id),
    ).toThrow();
  });

  it("leaves garden, unresolved, and memory-pair rows unchanged", async () => {
    const db = openSyntheticDb();
    db.raw.exec(`
      CREATE TABLE garden_entries (id TEXT PRIMARY KEY, kind TEXT, body TEXT);
      CREATE TABLE unresolved (id TEXT PRIMARY KEY, content TEXT, status TEXT);
      CREATE TABLE memory_pair_checks (a TEXT, b TEXT, verdict TEXT, checked_at TEXT);
      INSERT INTO garden_entries VALUES ('g1', 'promise', 'keep');
      INSERT INTO unresolved VALUES ('u1', 'keep', 'open');
      INSERT INTO memory_pair_checks VALUES ('a', 'b', 'same', '2026-01-01T00:00:00.000Z');
    `);
    await ensurePromiseSchema(db);
    const store = new PromiseStore(db, NY);
    const now = Date.parse("2026-11-08T16:00:00.000Z");
    const item = await store.addPage({ personaId: "chu", author: "yanyan", text: "new", dueAt: null, now });
    await store.toggleCheck("chu", item!.id, "chu", now);
    await store.close("chu", item!.id, "no", now);
    expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM garden_entries`).get()).toEqual({ n: 1 });
    expect(db.raw.prepare(`SELECT body FROM garden_entries`).get()).toEqual({ body: "keep" });
    expect(db.raw.prepare(`SELECT content, status FROM unresolved`).get()).toEqual({ content: "keep", status: "open" });
    expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM memory_pair_checks`).get()).toEqual({ n: 1 });
  });
});
