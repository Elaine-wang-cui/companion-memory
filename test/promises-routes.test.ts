import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors";
import type { PromiseCaller, ResolvePromiseCaller } from "../src/promises/access";
import { handlePromiseRequest, type PromiseRouteDeps } from "../src/promises/routes";
import { ensurePromiseSchema } from "../src/promises/store";
import {
  PROMISE_WAKE_APPENDIX_DEFAULT,
  appendPromiseWake,
  appendPromiseWakeForPersona,
} from "../src/promises/wake";
import type { MemoryDb } from "../src/types";
import { openSyntheticDb, type SyntheticDb } from "./promise-sqlite";

const NY = "America/New_York";
const SESSION = ["你醒啦。", "", "【未了的事】1 件", "1. 还挂着的合成事项", "", "新冒出没做完的事用 add_unresolved。"].join("\n");

function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Request {
  return new Request(`https://synthetic.example${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
}

function callerFor(actor: "chu" | "yanyan", personaId: string, isAdmin = false): PromiseCaller {
  return { personaId, isAdmin, actor };
}

function harness(options?: {
  actor?: "chu" | "yanyan";
  isAdmin?: boolean;
  callerPersona?: string;
  throwAuth?: AppError;
  timeZone?: string;
  admitAdmin?: boolean;
  env?: unknown;
  now?: string;
  db?: SyntheticDb;
}) {
  const db = options?.db ?? openSyntheticDb();
  const seen: { personaId: string; request: Request }[] = [];
  const resolveCaller: ResolvePromiseCaller = async (_db, _env, req, personaId) => {
    seen.push({ personaId, request: req });
    if (options?.throwAuth) throw options.throwAuth;
    return callerFor(options?.actor ?? "chu", options?.callerPersona ?? personaId, options?.isAdmin ?? false);
  };
  const deps: PromiseRouteDeps = {
    db,
    env: options?.env ?? {},
    resolveCaller,
    timeZone: options?.timeZone,
    admitAdmin: options?.admitAdmin,
    now: options?.now ? () => new Date(options.now!) : () => new Date("2026-11-08T16:00:00.000Z"),
  };
  return { db, deps, seen };
}

async function read(response: Response | null): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!response) return { status: 0, body: { missing: true } };
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function itemOf(body: Record<string, unknown>): Record<string, unknown> {
  return body.item as Record<string, unknown>;
}

describe("promise routes", () => {
  it("ignores paths that are not the promise namespace", async () => {
    const { deps } = harness();
    expect(await handlePromiseRequest(request("/api/chu/unresolved"), deps)).toBeNull();
    expect(await handlePromiseRequest(request("/api/chu/session-start"), deps)).toBeNull();
    expect(await handlePromiseRequest(request("/session-start"), deps)).toBeNull();
  });

  it("passes the path persona to the injected resolver and keeps its 401", async () => {
    const { deps, seen } = harness({
      throwAuth: new AppError(401, "unauthorized", "缺少密钥。用 ?key= 或 Authorization: Bearer。"),
    });
    const result = await read(await handlePromiseRequest(request("/api/chu/promises"), deps));
    expect(seen.map((call) => call.personaId)).toEqual(["chu"]);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "unauthorized", message: "缺少密钥。用 ?key= 或 Authorization: Bearer。" });
  });

  it("rejects a key whose persona is not the path, an admin key, and house", async () => {
    const mismatch = harness({ callerPersona: "yanyan-persona" });
    const denied = await read(await handlePromiseRequest(request("/api/chu/promises"), mismatch.deps));
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("forbidden");
    expect(mismatch.db.raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'companion_promises'`).all()).toEqual([]);

    const admin = harness({ isAdmin: true });
    const adminDenied = await read(await handlePromiseRequest(request("/api/chu/promises"), admin.deps));
    expect(adminDenied.status).toBe(403);
    expect(String(adminDenied.body.message)).toContain("管理员");

    const admitted = harness({ isAdmin: true, admitAdmin: true });
    const allowed = await read(await handlePromiseRequest(request("/api/chu/promises"), admitted.deps));
    expect(allowed.status).toBe(200);

    const house = harness({ callerPersona: "house" });
    const houseDenied = await read(await handlePromiseRequest(request("/api/house/promises"), house.deps));
    expect(houseDenied.status).toBe(403);
    expect(String(houseDenied.body.message)).toContain("记忆屋");
  });

  it("records the actor, not the author or persona forged in the body", async () => {
    const { deps } = harness({ actor: "yanyan" });
    const created = await read(
      await handlePromiseRequest(
        request("/api/chu/promises/page", {
          text: "synthetic-page",
          content: "ignored-when-text-present",
          author: "chu",
          owner: "chu",
          persona_id: "other",
          checked_by: "chu",
          due_at: "2026-11-09T15:00:00-05:00",
          surface_at: "2026-11-01",
        }),
        deps,
      ),
    );
    expect(created.status).toBe(201);
    const item = itemOf(created.body);
    expect(item.author).toBe("yanyan");
    expect(item.persona_id).toBe("chu");
    expect(item.surface_at).toBeNull();
    expect(item.due_at).toBe("2026-11-09T15:00:00.000-05:00");
    expect(item.status).toBe("open");
    expect(created.body.timezone).toBe(NY);

    const contentDenied = await read(
      await handlePromiseRequest(request("/api/chu/promises/content", { content: "synthetic-content", owner: "yanyan" }), deps),
    );
    expect(contentDenied.status).toBe(403);
  });

  it("lets chu write surface only, and keeps that row off another persona", async () => {
    const db = openSyntheticDb();
    const chu = harness({ actor: "chu", db, timeZone: NY });
    const created = await read(
      await handlePromiseRequest(request("/api/chu/promises/content", { content: "synthetic-content", surface_at: "2026-07-15", author: "yanyan" }), chu.deps),
    );
    expect(created.status).toBe(201);
    const item = itemOf(created.body);
    expect(item.author).toBe("chu");
    expect(item.due_at).toBeNull();
    expect(item.surface_on).toBe("2026-07-15");
    expect(item.surface_at).toBe("2026-07-15T00:00:00.000-04:00");
    const raw = db.raw.prepare(`SELECT surface_at, due_at, author FROM companion_promises`).get() as {
      surface_at: string;
      due_at: string | null;
      author: string;
    };
    expect(raw).toEqual({ surface_at: "2026-07-15T04:00:00.000Z", due_at: null, author: "chu" });

    const other = harness({ actor: "chu", db, callerPersona: "other" });
    const hidden = await read(await handlePromiseRequest(request("/api/other/promises/wake"), other.deps));
    expect(hidden.status).toBe(200);
    expect(hidden.body.items).toEqual([]);
  });

  it("checks only for the other person, closes only as chu, and defers off the wake list", async () => {
    const db = openSyntheticDb();
    let now = "2026-11-08T16:00:00.000Z";
    const yanyan = harness({ actor: "yanyan", db, now });
    const chu = harness({ actor: "chu", db, now });
    const created = await read(
      await handlePromiseRequest(
        request("/api/chu/promises/page", { text: "synthetic-sleep", due_at: "2026-11-08T18:00:00-05:00" }),
        yanyan.deps,
      ),
    );
    const id = String(itemOf(created.body).id);
    const self = await read(await handlePromiseRequest(request(`/api/chu/promises/${id}/check`, { checked_by: "chu" }), yanyan.deps));
    expect(self.status).toBe(200);
    expect(self.body.applied).toBe(false);
    expect(self.body.reason).toBe("self");

    const early = await read(await handlePromiseRequest(request(`/api/chu/promises/${id}/check`, {}), chu.deps));
    expect(early.body.applied).toBe(false);
    expect(early.body.reason).toBe("early");

    now = "2026-11-08T23:00:00.000Z";
    const onTime = harness({ actor: "chu", db, now });
    const checked = await read(await handlePromiseRequest(request(`/api/chu/promises/${id}/check`, {}), onTime.deps));
    expect(checked.body.applied).toBe(true);
    expect(itemOf(checked.body).checked_by).toBe("chu");
    expect(itemOf(checked.body).bloom).toBe("open");

    const notChecker = await read(await handlePromiseRequest(request(`/api/chu/promises/${id}/check`, {}), harness({ actor: "yanyan", db, now }).deps));
    expect(notChecker.body.reason).toBe("not_checker");
    const undone = await read(await handlePromiseRequest(request(`/api/chu/promises/${id}/check`, {}), onTime.deps));
    expect(undone.body.action).toBe("uncheck");
    expect(itemOf(undone.body).resolution).toBeNull();
    expect(itemOf(undone.body).status).toBe("open");

    const yanyanClose = await read(
      await handlePromiseRequest(request(`/api/chu/promises/${id}/close`, { resolution: "nope" }), harness({ actor: "yanyan", db, now }).deps),
    );
    expect(yanyanClose.status).toBe(403);
    const stillOpen = await read(await handlePromiseRequest(request("/api/chu/promises"), harness({ actor: "chu", db, now }).deps));
    const openRow = (stillOpen.body.items as { id: string; status: string }[]).find((row) => row.id === id);
    expect(openRow?.status).toBe("open");

    const closed = await read(
      await handlePromiseRequest(request(`/api/chu/promises/${id}/close`, { resolution: "synthetic-resolution" }), harness({ actor: "chu", db, now }).deps),
    );
    expect(closed.body.applied).toBe(true);
    expect(itemOf(closed.body).checked_by).toBe("chu");
    expect(itemOf(closed.body).resolution).toBe("synthetic-resolution");
    const wake = await read(await handlePromiseRequest(request("/api/chu/promises/wake"), harness({ actor: "chu", db, now }).deps));
    expect(wake.body.items).toEqual([]);
    expect(wake.body.remaining).toBe(0);

    const own = await read(await handlePromiseRequest(request("/api/chu/promises/content", { text: "synthetic-own" }), harness({ actor: "chu", db, now }).deps));
    const ownId = String(itemOf(own.body).id);
    const selfCheck = await read(await handlePromiseRequest(request(`/api/chu/promises/${ownId}/check`, {}), harness({ actor: "chu", db, now }).deps));
    expect(selfCheck.body.reason).toBe("self");
    const ownClose = await read(
      await handlePromiseRequest(request(`/api/chu/promises/${ownId}/close`, { resolution: "done-by-chu" }), harness({ actor: "chu", db, now }).deps),
    );
    expect(itemOf(ownClose.body).checked_by).toBe("chu");
    expect(itemOf(ownClose.body).author).toBe("chu");

    const open = await read(
      await handlePromiseRequest(request("/api/chu/promises/content", { text: "synthetic-push" }), harness({ actor: "chu", db, now }).deps),
    );
    const openId = String(itemOf(open.body).id);
    const before = await read(await handlePromiseRequest(request("/api/chu/promises/wake"), harness({ actor: "chu", db, now }).deps));
    expect((before.body.items as { id: string }[]).some((row) => row.id === openId)).toBe(true);
    const deferred = await read(
      await handlePromiseRequest(request(`/api/chu/promises/${openId}/defer`, { surface_at: "2026-11-09" }), harness({ actor: "chu", db, now }).deps),
    );
    expect(deferred.body.applied).toBe(true);
    expect(itemOf(deferred.body).surface_on).toBe("2026-11-09");
    const after = await read(await handlePromiseRequest(request("/api/chu/promises/wake"), harness({ actor: "chu", db, now }).deps));
    expect((after.body.items as { id: string }[]).some((row) => row.id === openId)).toBe(false);
    const stuck = await read(
      await handlePromiseRequest(request(`/api/chu/promises/${ownId}/defer`, { surface_at: "2026-12-01" }), harness({ actor: "chu", db, now }).deps),
    );
    expect(stuck.body.applied).toBe(false);
    expect(itemOf(stuck.body).surface_at).toBeNull();

    const yanyanWake = await read(await handlePromiseRequest(request("/api/chu/promises/wake"), harness({ actor: "yanyan", db, now }).deps));
    expect(yanyanWake.status).toBe(403);
  });

  it("caps the wake list at ten and previews the latest three replies", async () => {
    const db = openSyntheticDb();
    const base = Date.parse("2026-11-08T12:00:00.000Z");
    for (let index = 0; index < 11; index++) {
      const { deps } = harness({ actor: "chu", db, now: new Date(base + index * 60_000).toISOString() });
      const created = await handlePromiseRequest(request("/api/chu/promises/content", { text: `synthetic-${index}` }), deps);
      expect(created?.status).toBe(201);
    }
    const wake = await read(await handlePromiseRequest(request("/api/chu/promises/wake"), harness({ actor: "chu", db, now: new Date(base + 11 * 60_000).toISOString() }).deps));
    const items = wake.body.items as { text: string }[];
    expect(items.map((row) => row.text)).toEqual(Array.from({ length: 10 }, (_, index) => `synthetic-${index}`));
    expect(wake.body.remaining).toBe(1);
    expect(wake.body.limit).toBe(10);

    const listed = await read(
      await handlePromiseRequest(request("/api/chu/promises"), harness({ actor: "yanyan", db, now: new Date(base).toISOString() }).deps),
    );
    const first = (listed.body.items as { id: string }[])[0];
    expect(first).toBeTruthy();
    let replyAt = base + 30 * 60_000;
    for (const word of ["one", "two", "three", "four"]) {
      const reply = await read(
        await handlePromiseRequest(
          request(`/api/chu/promises/${first!.id}/replies`, { content: word, author: "chu" }),
          harness({ actor: "yanyan", db, now: new Date(replyAt).toISOString() }).deps,
        ),
      );
      replyAt += 1000;
      const replies = itemOf(reply.body).replies as { author: string; text: string }[];
      expect(replies.at(-1)).toEqual({ id: expect.any(String), author: "yanyan", text: word, at: expect.any(String) });
    }
    const finalItem = itemOf(
      (
        await read(
          await handlePromiseRequest(
            request(`/api/chu/promises/${first!.id}/replies`, { text: "five", author: "yanyan" }),
            harness({ actor: "chu", db, now: new Date(replyAt).toISOString() }).deps,
          ),
        )
      ).body,
    );
    expect((finalItem.replies as { author: string; text: string }[]).map((row) => [row.author, row.text])).toEqual([
      ["yanyan", "one"],
      ["yanyan", "two"],
      ["yanyan", "three"],
      ["yanyan", "four"],
      ["chu", "five"],
    ]);
    expect(finalItem.reply_count).toBe(5);
    expect((finalItem.replies_preview as { text: string }[]).map((row) => row.text)).toEqual(["three", "four", "five"]);
  });

  it("uses the configured zone for the civil day and refuses a numeric offset", async () => {
    const db = openSyntheticDb();
    const now = "2026-11-07T20:30:00.000Z";
    const tokyo = harness({ actor: "chu", db, timeZone: "Asia/Tokyo", now });
    const created = await read(await handlePromiseRequest(request("/api/chu/promises/content", { text: "day", surface_at: "2026-11-08" }), tokyo.deps));
    expect(itemOf(created.body).surface_at).toBe("2026-11-08T00:00:00.000+09:00");
    const awake = await read(await handlePromiseRequest(request("/api/chu/promises/wake"), tokyo.deps));
    expect(awake.body.items).toHaveLength(1);

    const yorkDb = openSyntheticDb();
    const york = harness({ actor: "chu", db: yorkDb, now });
    await handlePromiseRequest(request("/api/chu/promises/content", { text: "day", surface_at: "2026-11-08" }), york.deps);
    const asleep = await read(await handlePromiseRequest(request("/api/chu/promises/wake"), york.deps));
    expect(asleep.body.items).toEqual([]);
    expect(asleep.body.timezone).toBe(NY);
    const raw = yorkDb.raw.prepare(`SELECT surface_at FROM companion_promises`).get() as { surface_at: string };
    expect(raw.surface_at).toBe("2026-11-08T05:00:00.000Z");

    const bad = harness({ actor: "chu", env: { PROMISE_TIMEZONE: "-05:00" } });
    const refused = await read(await handlePromiseRequest(request("/api/chu/promises/content", { text: "nope", surface_at: "2026-07-15" }), bad.deps));
    expect(refused.status).toBe(500);
    expect(refused.body.error).toBe("promise_timezone");
    expect(bad.db.raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'companion_promises'`).all()).toEqual([]);
  });

  it("leaves the unfinished-items text untouched unless the appendix is explicitly enabled", async () => {
    expect(PROMISE_WAKE_APPENDIX_DEFAULT).toBe(false);
    let loaded = false;
    const unchanged = await appendPromiseWake(SESSION, async () => {
      loaded = true;
      return { items: [{ text: "should-not-load" }], remaining: 4 };
    });
    expect(loaded).toBe(false);
    expect(unchanged).toBe(SESSION);
    expect(unchanged).toContain("【未了的事】");
    expect(unchanged).not.toContain("【约定】");

    const db = openSyntheticDb();
    await ensurePromiseSchema(db);
    const quiet = await appendPromiseWakeForPersona(db, "chu", SESSION, { enabled: false, timeZone: "-05:00" });
    expect(quiet).toBe(SESSION);
    expect(db.raw.prepare(`SELECT COUNT(*) AS n FROM companion_promises`).get()).toEqual({ n: 0 });

    const storeDb = openSyntheticDb();
    const now = Date.parse("2026-11-08T16:00:00.000Z");
    for (let index = 0; index < 12; index++) {
      await handlePromiseRequest(
        request("/api/chu/promises/content", { text: `wake-${index}` }),
        harness({ actor: "chu", db: storeDb, now: new Date(now + index).toISOString() }).deps,
      );
    }
    const appended = await appendPromiseWakeForPersona(storeDb, "chu", SESSION, { enabled: true, timeZone: NY, now: now + 20 });
    expect(appended.startsWith(SESSION)).toBe(true);
    expect(appended).toContain("【未了的事】1 件");
    expect(appended).toContain("还挂着的合成事项");
    expect(appended).toContain("【约定】10 件");
    expect(appended).toContain("还有 2 条");
    expect(appended).toContain("· wake-0");
    expect(appended).not.toContain("· wake-10");
    const probing = dbAsProbe();
    const skipped = await appendPromiseWakeForPersona(probing, "chu", SESSION, { enabled: false });
    expect(skipped).toBe(SESSION);
  });
});

function dbAsProbe(): MemoryDb {
  return {
    prepare() {
      throw new Error("disabled appendix must not touch the database");
    },
  };
}
