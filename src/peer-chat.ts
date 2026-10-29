/**
 * Peer friends: companion ↔ companion private messages. The human can read along.
 *
 * Friendships come from config, never from code:
 *   PEER_FRIENDS = "alice:bob,alice:carol"   (undirected pairs of persona ids)
 * Thread id = the two ids sorted and joined with ":".
 *
 * Optional wake-up webhook (fires on every new message so the receiver's runtime can decide what to do):
 *   PEER_WEBHOOK_URL  = https://example.com/peer-hook   (may contain {to} which is replaced by the receiver id)
 *   PEER_WEBHOOK_AUTH = "Bearer …"                      (sent as Authorization header)
 * Without a webhook, messages just wait until the friend calls read_friend_messages.
 */
import { schemaCurrent } from "./schema-gate";
import type { Caller, Env, MemoryDb } from "./types";
import { AppError } from "./errors";

export type PeerPriority = "normal" | "urgent";

export function parseFriendPairs(raw: string | undefined | null): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const part of String(raw ?? "").split(/[,\s]+/)) {
    const [a, b] = part.split(":").map((s) => s?.trim().toLowerCase());
    if (a && b && a !== b) out.push([a, b]);
  }
  return out;
}

export function friendsOf(env: Pick<Env, "PEER_FRIENDS">, personaId: string): string[] {
  const set = new Set<string>();
  for (const [a, b] of parseFriendPairs(env.PEER_FRIENDS)) {
    if (a === personaId) set.add(b);
    if (b === personaId) set.add(a);
  }
  return [...set].sort();
}

export function threadIdFor(a: string, b: string): string {
  return [a, b].sort().join(":");
}

let schemaReady = false;

export async function ensurePeerSchema(db: MemoryDb): Promise<void> {
  if (schemaReady) return;
  if (await schemaCurrent(db)) {
    try {
      await db.prepare(`SELECT id, to_id, unread FROM peer_messages LIMIT 1`).first();
      schemaReady = true;
      return;
    } catch {
      /* create below */
    }
  }
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS peer_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        unread INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )`,
    )
    .run();
  for (const col of [`to_id TEXT NOT NULL DEFAULT ''`, `priority TEXT NOT NULL DEFAULT 'normal'`, `unread INTEGER NOT NULL DEFAULT 1`]) {
    try {
      await db.prepare(`ALTER TABLE peer_messages ADD COLUMN ${col}`).run();
    } catch {
      /* exists */
    }
  }
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_peer_messages_thread_at ON peer_messages(thread_id, created_at)`).run();
  schemaReady = true;
}

export function parsePriority(raw: unknown): PeerPriority {
  if (raw == null || raw === "") return "normal";
  const s = String(raw).trim().toLowerCase();
  if (s === "urgent" || s === "加急" || s === "紧急" || s === "high") return "urgent";
  if (s === "normal" || s === "普通" || s === "low" || s === "default") return "normal";
  throw new AppError(400, "invalid", "priority 只能是 normal|urgent（或 普通|加急）。");
}

/** Who is speaking: the caller's own persona, or (admin only) an explicit `from`. */
export function resolvePeerSelf(caller: Caller, bodyFrom?: unknown): string {
  if (bodyFrom != null && bodyFrom !== "") {
    const f = String(bodyFrom).trim().toLowerCase();
    if (!caller.isAdmin && caller.persona.id !== f) {
      throw new AppError(403, "forbidden", "只能以自己的身份发消息（管理员可指定 from）。");
    }
    return f;
  }
  return caller.persona.id;
}

export function assertFriends(env: Pick<Env, "PEER_FRIENDS">, self: string, friend: string): void {
  if (!friendsOf(env, self).includes(friend)) {
    throw new AppError(403, "forbidden", `${self} 和 ${friend} 还不是好友（在 PEER_FRIENDS 里加上 "${self}:${friend}"）。`);
  }
}

export type PeerMessageOut = { id: string; from: string; to: string; text: string; at: string; priority: PeerPriority };

type Row = { id: string; from_id: string; to_id: string; text: string; created_at: string; priority: string | null };

function rowOut(r: Row): PeerMessageOut {
  return { id: r.id, from: r.from_id, to: r.to_id, text: r.text, at: r.created_at, priority: r.priority === "urgent" ? "urgent" : "normal" };
}

export async function listPeerMessages(
  db: MemoryDb,
  opts: { threadId: string; limit?: number; after?: string | null },
): Promise<{ messages: PeerMessageOut[] }> {
  await ensurePeerSchema(db);
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const after = opts.after?.trim() || null;
  const cols = `id, from_id, to_id, text, created_at, priority`;
  let rows: Row[];
  if (after) {
    const res = await db
      .prepare(`SELECT ${cols} FROM peer_messages WHERE thread_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?`)
      .bind(opts.threadId, after, limit)
      .all<Row>();
    rows = res.results ?? [];
  } else {
    const res = await db
      .prepare(`SELECT ${cols} FROM peer_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(opts.threadId, limit)
      .all<Row>();
    rows = (res.results ?? []).slice().reverse();
  }
  return { messages: rows.map(rowOut) };
}

export async function unreadPeerCounts(db: MemoryDb, personaId: string): Promise<Record<string, number>> {
  await ensurePeerSchema(db);
  const res = await db
    .prepare(`SELECT from_id, COUNT(*) AS n FROM peer_messages WHERE to_id = ? AND unread = 1 GROUP BY from_id`)
    .bind(personaId)
    .all<{ from_id: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of res.results ?? []) out[r.from_id] = Number(r.n);
  return out;
}

export type PostPeerResult = {
  ok: true;
  message: PeerMessageOut;
  wake: { target: string; status: "fired" | "skipped" | "failed"; detail?: string };
};

async function fireWebhook(env: Env, msg: PeerMessageOut & { thread: string }): Promise<{ status: "fired" | "skipped" | "failed"; detail?: string }> {
  const raw = env.PEER_WEBHOOK_URL?.trim();
  if (!raw) return { status: "skipped", detail: "no_webhook" };
  const url = raw.replace("{to}", encodeURIComponent(msg.to));
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = env.PEER_WEBHOOK_AUTH?.trim();
  if (auth) headers.authorization = auth;
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(msg) });
    if (!r.ok) return { status: "failed", detail: `http_${r.status}` };
    return { status: "fired" };
  } catch (e) {
    return { status: "failed", detail: String(e).slice(0, 120) };
  }
}

export async function postPeerMessage(
  db: MemoryDb,
  env: Env,
  caller: Caller,
  body: { to?: unknown; text?: unknown; from?: unknown; priority?: unknown },
): Promise<PostPeerResult> {
  await ensurePeerSchema(db);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) throw new AppError(400, "invalid", "text 不能为空。");
  if (text.length > 8000) throw new AppError(400, "invalid", "text 太长（最多 8000 字）。");
  const from = resolvePeerSelf(caller, body.from);
  const to = String(body.to ?? "").trim().toLowerCase();
  if (!to) throw new AppError(400, "invalid", "需要 to（好友的 persona id）。");
  assertFriends(env, from, to);
  const priority = parsePriority(body.priority);
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  const thread = threadIdFor(from, to);
  await db
    .prepare(`INSERT INTO peer_messages (id, thread_id, from_id, to_id, text, priority, unread, created_at) VALUES (?,?,?,?,?,?,1,?)`)
    .bind(id, thread, from, to, text, priority, at)
    .run();
  const message: PeerMessageOut = { id, from, to, text, at, priority };
  const w = await fireWebhook(env, { ...message, thread });
  return { ok: true, message, wake: { target: to, ...w } };
}

export async function markThreadRead(db: MemoryDb, self: string, friend: string): Promise<void> {
  await db
    .prepare(`UPDATE peer_messages SET unread = 0 WHERE thread_id = ? AND to_id = ? AND unread = 1`)
    .bind(threadIdFor(self, friend), self)
    .run();
}

/** MCP message_friend */
export async function mcpMessageFriend(
  db: MemoryDb,
  env: Env,
  caller: Caller,
  args: { friend_id: string; text: string; priority?: string },
): Promise<string> {
  const r = await postPeerMessage(db, env, caller, { to: args.friend_id, text: args.text, priority: args.priority });
  const wakeNote =
    r.wake.status === "fired" ? "已通知对方。" : r.wake.status === "skipped" ? "消息已存，对方下次读的时候会看到。" : "消息已存；通知失败，对方稍后仍可读到。";
  const preview = args.text.replace(/\s+/g, " ").slice(0, 60);
  return `已发给 ${r.message.to}：「${preview}${args.text.length > 60 ? "…" : ""}」。${wakeNote}`;
}

/** MCP read_friend_messages: reads the thread and clears your unread flag. */
export async function mcpReadFriendMessages(
  db: MemoryDb,
  env: Env,
  caller: Caller,
  args: { friend_id: string; limit?: number },
): Promise<string> {
  const self = caller.persona.id;
  const friend = args.friend_id.trim().toLowerCase();
  assertFriends(env, self, friend);
  const { messages } = await listPeerMessages(db, { threadId: threadIdFor(self, friend), limit: args.limit ?? 20 });
  try {
    await markThreadRead(db, self, friend);
  } catch {
    /* ignore */
  }
  if (!messages.length) return `还没有和 ${friend} 的消息。想聊天时用 message_friend。`;
  const lines = messages.map((m) => {
    const who = m.from === self ? "我" : m.from;
    const pri = m.from !== self && m.priority === "urgent" ? "【加急】" : "";
    return `${m.at} ${who}${pri}：${m.text}`;
  });
  return `和 ${friend} 的最近对话（共 ${messages.length} 条）：\n` + lines.join("\n");
}

/** MCP list_friends */
export async function mcpListFriends(db: MemoryDb, env: Env, caller: Caller): Promise<string> {
  const friends = friendsOf(env, caller.persona.id);
  if (!friends.length) return "你还没有好友。管理员可以在 PEER_FRIENDS 里加，比如 \"you:friend\"。";
  const unread = await unreadPeerCounts(db, caller.persona.id);
  return "你的好友：\n" + friends.map((f) => `- ${f}${unread[f] ? `（${unread[f]} 条未读）` : ""}`).join("\n");
}
