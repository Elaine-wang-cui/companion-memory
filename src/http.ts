import { DOORS } from "./doors";
import { CFG } from "./config";
import { ensureDeckOwnerColumn } from "./deck";
import { schemaCurrent, markSchemaCurrent } from "./schema-gate";
import { ensureDreamSchema } from "./dream";
import {
  assertFriends,
  ensurePeerSchema,
  friendsOf,
  listPeerMessages,
  markThreadRead,
  postPeerMessage,
  resolvePeerSelf,
  threadIdFor,
  unreadPeerCounts,
} from "./peer-chat";
import { saveSnapshot, loadSnapshot, loadSnapshotMeta, deleteSnapshot } from "./body-snapshot";
import { emotionState, emotionApply, emotionFact, emotionImport, emotionEvents, EMOTION_PERSONAS } from "./emotion";
import { bodyAvatar, bodyCron, bodyDebug, bodyLog, bodyLogMarkRead, pickClassifier, ensureBodySchema, bodyTurn, BODY_PERSONAS, bridgeSender, type BodyEvent } from "./body";
import { resolveAnyCaller, resolveCaller, resolveHouseCaller, extractKey, sha256Hex, timingSafeEqual } from "./auth";
import { assertAdmin, bootstrap } from "./bootstrap";
import { adminUpsertPersona, updatePersonaRelationships } from "./admin-personas";
import { ROSTER_SEEDS } from "./persona-roster";
import {
  addDeckItem,
  createTopic,
  drawDeck,
  forgetDeckItem,
  getDeckItem,
  listDeckItems,
  listRecentDraws,
  listTopics,
  listHeartTraces,
  saveHeartTrace,
  type DrawSource,
} from "./deck";
import {
  addDesireReply,
  forgetDesire,
  getDesire,
  listDesires,
  saveDesire,
} from "./desire";
import { MEMORIES_PAGE_HTML } from "./memories-page";
import { GARDEN_PAGE_HTML } from "./garden-page";
import { ATLAS_PAGE_HTML } from "./atlas-page";
import { ATLAS3D_PAGE_HTML } from "./atlas3d-page";
import { atlasAuthorized, atlasData } from "./atlas";
import { ensureLinksSchema, backfillLinks, linkStats, reqStore } from "./links";

// /api/atlas 缓存（KV，同一指纹 + 短 TTL；认知写入/撤销时主动清掉）。关掉：ATLAS_CACHE_ENABLED = false，或请求带 ?fresh=1
export const ATLAS_CACHE_ENABLED = true;
export const ATLAS_CACHE_TTL_S = 300;
const ATLAS_CACHE_KEY = "cache:atlas:v1";
type AtlasKV = { get(k: string, t: "text"): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>; delete(k: string): Promise<void> };
export async function atlasCacheBust(env: Env) { try { await (env.MEDIA as unknown as AtlasKV | undefined)?.delete(ATLAS_CACHE_KEY); } catch { /* */ } }
import { ensureGardenLinksSchema, gardenBackfill, gardenLinkStats } from "./garden-links";
import { ensureCognitionSchema, clusterCognition, cognitionStats, undoCognition, writeCognition } from "./cognition";
import {
  addUnresolved,
  autoRecall,
  closeUnresolved,
  listNotes,
  listUnresolved,
  ensureContinuitySchema,
  overview,
  replyNote,
  sessionStart,
  threadClose,
  updateHandoff,
  updateNoteContent,
  updateUnresolvedItem,
  writeNote,
} from "./continuity";
import {
  createConversation,
  createGardenEntry,
  deleteConversation,
  deleteGardenEntry,
  deleteVoiceClip,
  deleteGardenImage,
  ensureGardenSchema,
  gardenOverview,
  getCardDetail,
  getConversation,
  getVoiceClip,
  getGardenImage,
  listConversations,
  readVoiceBytes,
  readGardenImageBytes,
  saveVoiceClip,
  saveGardenImage,
  setFavorite,
  updateConversation,
  updateGardenEntry,
  upsertPersonaMeta,
} from "./garden";
import { AppError } from "./errors";
import { mcpResponse } from "./mcp";
import {
  addDeckItemSchema,
  createTopicSchema,
  addUnresolvedSchema,
  autoRecallSchema,
  closeUnresolvedSchema,
  createConversationSchema,
  createGardenEntrySchema,
  favoriteSchema,
  personaMetaSchema,
  replyNoteSchema,
  threadCloseSchema,
  updateConversationSchema,
  updateGardenEntrySchema,
  updateHandoffSchema,
  updateNoteContentSchema,
  updateUnresolvedItemSchema,
  updateGardenMemorySchema,
  writeNoteSchema,
  drawDeckSchema,
  memoryCardSchema,
  recallSchema,
  rememberSchema,
  updateMemorySchema,
  updateSelfCardSchema,
  saveHeartTraceSchema,
  saveDesireSchema,
  replyDesireSchema,
} from "./schemas";
import { forget, listPersonas, memoryCard, openMemory, pinMemory, recall, remember, updateMemory, updateSelfCard, whoami } from "./service";
import { ensureForgettingSchema } from "./forgetting";
import { listDreams, runDream, saveDream, deleteDream, workersAiGen } from "./dream";
import {
  ackNotionOutbox,
  ensureNotionSyncSchema,
  listNotionOutbox,
  listPersonaNotion,
  skipNotionOutbox,
  upsertPersonaNotion,
  type OutboxKind,
  type OutboxStatus,
} from "./notion-sync";
import type { Env } from "./types";
import { deleteCompanionNote, deleteStatus, latestStatus, listStatusHistory, listCompanionNotes, markCompanionNotesSeen, recentFinished, setHerStatus } from "./house-extras";
import { markSeenSchema, setHerStatusSchema } from "./schemas";
import type { DeckKind } from "./types";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};

export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(data: unknown, status = 200): Response {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
}

function text(body: string, status = 200): Response {
  return withCors(
    new Response(body, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  );
}

function errorResponse(error: AppError): Response {
  const headers = error.status === 401 ? { "WWW-Authenticate": 'Bearer realm="companion-memory"' } : undefined;
  return withCors(
    new Response(JSON.stringify({ error: error.code, message: error.message }), {
      status: error.status,
      headers: { "content-type": "application/json; charset=utf-8", ...headers },
    }),
  );
}

async function readJson(request: Request): Promise<unknown> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError(400, "invalid", "请求体不是 JSON。");
  }
}

const HELP = `共享记忆
这是给所有伙伴共用的一个记忆库。
身份写在连接地址里，不由模型自己猜。

MCP（Claude / ChatGPT / Cursor）
  POST /mcp/<persona_id>?key=<密钥>
  也接受 Authorization: Bearer <密钥>
  管理员密钥可以走任意人格的地址。
  抽卡匣工具：list_topics / list_deck_items / add_deck_item / draw_deck / forget_deck_item / list_recent_draws；心痕：save_heart_trace / list_heart_traces / get_heart_trace；欲望：save_desire / list_desires / get_desire / forget_desire / reply_desire；REST：POST/GET /api/<id>/desires，GET/DELETE /desires/:id，POST /desires/:id/replies

一键初始化（仅管理员）
  POST /api/bootstrap?key=<ADMIN_KEY>

REST（给不能接 MCP 的机器人用）
  GET  /api/<persona_id>/whoami
  POST /api/<persona_id>/remember
  POST /api/<persona_id>/recall
  GET  /api/<persona_id>/memory-card

连续性（只属于路径里的那位）
  GET  /api/<persona_id>/session-start        开窗回忆
  POST /api/<persona_id>/thread-close         交接便签 {summary, mood?, next_time?}
  GET  /api/<persona_id>/unresolved?status=open
  POST /api/<persona_id>/unresolved           {content, context?, importance?}
  POST /api/<persona_id>/unresolved/:id/close {resolution?}
  GET  /api/<persona_id>/notes
  POST /api/<persona_id>/notes/:id/reply      {reply, action?}
  POST /api/<persona_id>/auto-recall          自动浮现 {message, limit?, max_chars?}
  MCP 工具：session_start / thread_close / add_unresolved / list_unresolved / close_unresolved / list_notes / reply_note

记忆花园（Rosarium · 管理员密钥）
  GET  /memories                              花名册花园主页
  GET  /memories/classic                      旧版记忆页
  GET  /garden                                → /memories
  GET  /api/view/overview
  GET  /api/view/garden                       花园总览（人名+卡片）
  POST /api/view/conversations                导入对话 {persona_id, title?, full_text, summary?, entry_date?}
  GET  /api/view/conversations/:id
  POST /api/view/garden-entries               记一笔 {persona_id, kind, title, body, entry_date?}
  POST /api/view/voice                        multipart: file + persona_id + title?
  POST /api/view/images                       multipart: file + persona_id + title?
  GET  /api/view/images/:id                   查看图片
  GET  /api/view/voice/:id                    播放语音
  POST /api/view/favorites                    {kind, ref_id, favorite}
  POST /api/view/notes                        {persona_id, content, memory_id?}

Notion 反向同步（管理员）
  GET  /api/admin/notion-outbox?status=pending
  POST /api/admin/notion-outbox/ack   {id, notion_page_id, notion_url?}
  POST /api/admin/notion-outbox/skip  {id, error?}
  GET  /api/admin/persona-notion
  PUT  /api/admin/persona-notion      {persona_id, notion_page_id, notion_url?}

抽卡匣（与人格记忆并列；网页用花园 /memories?nav=shake 摇一摇）
  GET  /deck                               → /memories?nav=shake
  GET  /api/deck/topics
  POST /api/deck/topics             {id?, name, description?, parent_id?}  小说子类 parent_id=novel
  GET  /api/deck/items?topic=diary&limit=20
  POST /api/deck/items
  GET  /api/deck/draw?topic=diary&source=web
  GET  /api/deck/recent?limit=20
  DELETE /api/deck/items/:id

对话开始先 whoami。你自己的事用第一人称记。关于用户、全家都该知道的事，owner 用 family。别人的记忆不是你的经历。
`;


export async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

  const url = new URL(request.url);
  if (url.pathname === "/healthz") return json({ ok: true, service: "companion-memory" });
  if (url.pathname === "/" || url.pathname === "") return text(HELP);

  let tSchema0 = Date.now(), tSchema = 0;
  try {
    if (
      url.pathname === "/mcp" ||
      url.pathname.startsWith("/mcp/") ||
      url.pathname.startsWith("/api/")
    ) {
      tSchema0 = Date.now();
      if (!(await schemaCurrent(env.DB))) {
        await ensureContinuitySchema(env.DB);
        await ensureGardenSchema(env.DB);
        await ensureForgettingSchema(env.DB);
        await ensureDeckOwnerColumn(env.DB);
        await ensureBodySchema(env.DB);
        await ensureDreamSchema(env.DB);
        await ensurePeerSchema(env.DB);
        await ensureLinksSchema(env.DB);
        await ensureGardenLinksSchema(env.DB);
        await ensureCognitionSchema(env.DB);
        await markSchemaCurrent(env.DB);
      }
      tSchema = Date.now() - tSchema0;
    }
    if (url.pathname === "/api/bootstrap" || url.pathname === "/api/bootstrap/") {
      if (request.method.toUpperCase() !== "POST") {
        return json({ error: "method", message: "用 POST。" }, 405);
      }
      const base = `${url.protocol}//${url.host}`;
      return json(await bootstrap(env, request, base));
    }

    if (url.pathname === "/api/admin/personas" || url.pathname === "/api/admin/personas/") {
      await assertAdmin(env, request);
      const method = request.method.toUpperCase();
      if (method === "POST") {
        const body = (await readJson(request)) as Record<string, unknown>;
        // batch: { personas: [...] } or single
        const list = Array.isArray(body.personas) ? body.personas : [body];
        const results = [];
        for (const raw of list) {
          const row = raw as {
            id?: string;
            display_name?: string;
            relationship_to_user?: string;
            self_card?: string;
            issue_key?: boolean;
          };
          const r = await adminUpsertPersona(env.DB, {
            id: String(row.id || ""),
            display_name: String(row.display_name || ""),
            relationship_to_user: String(row.relationship_to_user || ""),
            self_card: String(row.self_card || ""),
            issue_key: !!row.issue_key,
          });
          results.push({
            id: r.persona.id,
            display_name: r.persona.display_name,
            created: r.created,
            key: r.key,
          });
        }
        return json({ ok: true, results });
      }
      return json({ error: "method", message: "用 POST 创建或跳过已有人格。" }, 405);
    }

    if (url.pathname === "/api/admin/personas/seed-roster" || url.pathname === "/api/admin/personas/seed-roster/") {
      if (request.method.toUpperCase() !== "POST") {
        return json({ error: "method", message: "用 POST。" }, 405);
      }
      await assertAdmin(env, request);
      const results = [];
      for (const seed of ROSTER_SEEDS) {
        const r = await adminUpsertPersona(env.DB, { ...seed, issue_key: true });
        results.push({
          id: r.persona.id,
          display_name: r.persona.display_name,
          created: r.created,
          key_issued: !!r.key_issued,
          key: r.key, // 仅此一次；调用方应保存
        });
      }
      return json({
        ok: true,
        count: results.length,
        created: results.filter((x) => x.created).length,
        keys_issued: results.filter((x) => x.key_issued).length,
        results,
      });
    }

    if (url.pathname === "/api/admin/personas/set-relationships" || url.pathname === "/api/admin/personas/set-relationships/") {
      if (request.method.toUpperCase() !== "POST") {
        return json({ error: "method", message: "用 POST。" }, 405);
      }
      await assertAdmin(env, request);
      const body = (await readJson(request)) as Record<string, unknown>;
      const list = Array.isArray(body.updates)
        ? (body.updates as Array<{ id?: string; relationship_to_user?: string }>)
        : Array.isArray(body.personas)
          ? (body.personas as Array<{ id?: string; relationship_to_user?: string }>)
          : [];
      const updates = list.map((r) => ({
        id: String(r.id || ""),
        relationship_to_user: String(r.relationship_to_user ?? ""),
      }));
      const result = await updatePersonaRelationships(env.DB, updates);
      // clear companion-y garden meta notes without wiping other meta
      const metaCleared = await env.DB.prepare(
        `UPDATE garden_persona_meta SET note = '', updated_at = datetime('now') WHERE note LIKE '%同伴%'`
      ).run();
      return json({ ok: true, ...result, meta_notes_cleared: metaCleared.meta?.changes ?? 0 });
    }


    // Notion reverse-sync outbox (queue + ack; Worker has no Notion token)
    {
      const path = url.pathname.replace(/\/$/, "");
      if (path === "/api/admin/notion-outbox" || path.startsWith("/api/admin/notion-outbox/")) {
        await assertAdmin(env, request);
        await ensureNotionSyncSchema(env.DB);
        const method = request.method.toUpperCase();
        if (method === "GET" && path === "/api/admin/notion-outbox") {
          const statusRaw = url.searchParams.get("status") || "pending";
          const status = (statusRaw === "all" ? undefined : statusRaw) as OutboxStatus | undefined;
          const kind = (url.searchParams.get("kind") || undefined) as OutboxKind | undefined;
          const limit = Number(url.searchParams.get("limit") || "50");
          const items = await listNotionOutbox(env.DB, { status, kind, limit });
          return json({ ok: true, count: items.length, items });
        }
        if (method === "POST" && path === "/api/admin/notion-outbox/ack") {
          const body = (await readJson(request)) as {
            id?: string;
            notion_page_id?: string;
            notion_url?: string;
          };
          if (!body.id || !body.notion_page_id) {
            return json({ error: "invalid", message: "需要 id 与 notion_page_id。" }, 400);
          }
          const item = await ackNotionOutbox(env.DB, {
            id: String(body.id),
            notion_page_id: String(body.notion_page_id),
            notion_url: body.notion_url,
          });
          return json({ ok: true, item });
        }
        if (method === "POST" && path === "/api/admin/notion-outbox/skip") {
          const body = (await readJson(request)) as { id?: string; error?: string };
          if (!body.id) return json({ error: "invalid", message: "需要 id。" }, 400);
          const item = await skipNotionOutbox(env.DB, { id: String(body.id), error: body.error });
          return json({ ok: true, item });
        }
        return json({ error: "method", message: "用 GET 列表 / POST ack|skip。" }, 405);
      }
      if (path === "/api/admin/persona-notion") {
        await assertAdmin(env, request);
        await ensureNotionSyncSchema(env.DB);
        const method = request.method.toUpperCase();
        if (method === "GET") {
          return json({ ok: true, items: await listPersonaNotion(env.DB) });
        }
        if (method === "PUT" || method === "POST") {
          const body = (await readJson(request)) as {
            persona_id?: string;
            notion_page_id?: string;
            notion_url?: string;
          };
          if (!body.persona_id || !body.notion_page_id) {
            return json({ error: "invalid", message: "需要 persona_id 与 notion_page_id。" }, 400);
          }
          const item = await upsertPersonaNotion(env.DB, {
            persona_id: String(body.persona_id),
            notion_page_id: String(body.notion_page_id),
            notion_url: body.notion_url,
          });
          return json({ ok: true, item });
        }
        return json({ error: "method", message: "用 GET 或 PUT。" }, 405);
      }
    }

    if (url.pathname === "/deck" || url.pathname === "/deck/") {
      // Standalone deck page retired; garden 摇一摇 is the UI. APIs stay at /api/deck/*.
      return Response.redirect(`${url.protocol}//${url.host}/memories?nav=shake`, 302);
    }

    if (url.pathname === "/garden" || url.pathname === "/garden/") {
      return Response.redirect(`${url.protocol}//${url.host}/memories`, 302);
    }

    if (url.pathname === "/memories/classic" || url.pathname === "/memories/classic/") {
      return withCors(
        new Response(MEMORIES_PAGE_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        }),
      );
    }

    if (url.pathname === "/memories" || url.pathname === "/memories/") {
      return withCors(
        new Response(GARDEN_PAGE_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        }),
      );
    }

    // Static garden assets (png/css/js) via Workers Assets binding
    if (
      env.ASSETS &&
      (url.pathname.startsWith("/memories/assets/") ||
        url.pathname === "/memories/styles.css" ||
        url.pathname === "/memories/glass.css" ||
        url.pathname === "/memories/app.js")
    ) {
      return withCors(await env.ASSETS.fetch(request));
    }

    if (url.pathname === "/atlas" || url.pathname === "/atlas/" || url.pathname === "/atlas/2d" || url.pathname === "/atlas/2d/") {
      // 外壳不含任何记忆数据；数据只走 /api/atlas（需密钥）。/atlas = 3D，/atlas/2d = 旧版 2D 兜底。
      return new Response(url.pathname.startsWith("/atlas/2d") ? ATLAS_PAGE_HTML : ATLAS3D_PAGE_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
    }
    if (url.pathname === "/api/admin/links/backfill" || url.pathname === "/api/admin/links/stats" || url.pathname === "/api/admin/inventory" || url.pathname === "/api/admin/garden/backfill") {
      const k = extractKey(request);
      const okKey = async (s?: string) => !!(k && s?.trim() && timingSafeEqual(await sha256Hex(k), await sha256Hex(s.trim())));
      if (!(await okKey(env.ADMIN_KEY)) && !(await okKey((env as { MAINT_KEY?: string }).MAINT_KEY))) return json({ error: "unauthorized" }, 401);
      await ensureLinksSchema(env.DB);
      if (url.pathname.endsWith("/stats")) { await ensureGardenLinksSchema(env.DB); return json({ ...(await linkStats(env.DB)), ...(await gardenLinkStats(env.DB)) }); }
      if (url.pathname.endsWith("/inventory")) {
        const tabs = ((await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ name: string }>()).results ?? []).map((r) => r.name);
        const out: Record<string, unknown> = {};
        for (const t of tabs) {
          const cols = ((await env.DB.prepare(`PRAGMA table_info("${t}")`).all<{ name: string }>()).results ?? []).map((c) => c.name);
          const pc = ["persona_id", "owner_persona", "persona", "author_persona", "from_id", "created_by"].find((c) => cols.includes(c));
          let counts: unknown;
          if (pc) counts = Object.fromEntries((((await env.DB.prepare(`SELECT "${pc}" AS p, COUNT(*) AS n FROM "${t}" GROUP BY 1`).all<{ p: string; n: number }>()).results) ?? []).map((r) => [r.p ?? "null", r.n]));
          else counts = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).first<{ n: number }>())?.n;
          out[t] = { cols, by: pc ?? null, counts };
        }
        return json(out);
      }
      if (url.pathname.endsWith("/garden/backfill")) {
        if (!env.AI) return json({ error: "no_ai" }, 500);
        const max = Math.min(Number(url.searchParams.get("max")) || 400, 800);
        return json(await gardenBackfill(env.DB, env.AI, max, url.searchParams.get("relink") === "1" ? "always" : false));
      }
      if (request.method.toUpperCase() !== "POST") return json({ error: "method" }, 405);
      if (!env.AI) return json({ error: "no_ai" }, 500);
      return json(await backfillLinks(env.DB, env.AI));
    }
    if (url.pathname.startsWith("/api/admin/cognition/")) {
      const k = extractKey(request);
      const okKey = async (s?: string) => !!(k && s?.trim() && timingSafeEqual(await sha256Hex(k), await sha256Hex(s.trim())));
      if (!(await okKey(env.ADMIN_KEY)) && !(await okKey((env as { MAINT_KEY?: string }).MAINT_KEY))) return json({ error: "unauthorized" }, 401);
      await ensureCognitionSchema(env.DB);
      const sub = url.pathname.replace(/\/$/, "").slice("/api/admin/cognition/".length);
      const persona = url.searchParams.get("persona") || CFG.primary;
      if (sub === "stats") return json(await cognitionStats(env.DB));
      if (sub === "candidates") {
        const st = url.searchParams.get("status");
        const r = await env.DB.prepare(`SELECT * FROM cognition_candidates WHERE persona = ? ${st ? "AND status = ?" : ""} ORDER BY score DESC LIMIT 100`).bind(...(st ? [persona, st] : [persona])).all();
        return json({ candidates: r.results ?? [], cognitions: (await env.DB.prepare(`SELECT * FROM cognitions WHERE persona = ?`).bind(persona).all()).results ?? [] });
      }
      if (sub === "export") {
        const t = url.searchParams.get("table") || "memories";
        if (!["memories", "memory_links", "cognitions", "cognition_candidates"].includes(t)) return json({ error: "table" }, 400);
        return json({ table: t, rows: (await env.DB.prepare(`SELECT * FROM "${t}"`).all()).results ?? [] });
      }
      if (request.method.toUpperCase() !== "POST") return json({ error: "method" }, 405);
      if (sub === "cluster") {
        const sim = Number(url.searchParams.get("sim")) || undefined;
        return json(await clusterCognition(env.DB, persona, { dry: url.searchParams.get("dry") === "1", sim, maxNew: Number(url.searchParams.get("max")) || undefined }));
      }
      if (sub === "undo") { await atlasCacheBust(env); return json(await undoCognition(env.DB, String(url.searchParams.get("id") || ""), url.searchParams.get("drop") === "1")); }
      if (sub === "dismiss") {
        await env.DB.prepare(`UPDATE cognition_candidates SET status = 'dismissed' WHERE id = ? AND status != 'done'`).bind(String(url.searchParams.get("id") || "")).run();
        return json({ ok: true });
      }
      if (sub === "delete-candidate") {
        await env.DB.prepare(`DELETE FROM cognition_candidates WHERE id = ? AND status != 'done'`).bind(String(url.searchParams.get("id") || "")).run();
        return json({ ok: true });
      }
      if (sub === "write") {
        // 测试/维护用：以该人格身份写认知（与 MCP write_cognition 同一路径）
        const b = (await readJson(request)) as { candidate_id?: string; text?: string };
        const prow = await env.DB.prepare(`SELECT * FROM personas WHERE id = ?`).bind(persona).first();
        if (!prow) return json({ error: "persona" }, 404);
        const r = await writeCognition(env.DB, { persona: prow as never, isAdmin: true }, { candidate_id: String(b.candidate_id || ""), text: String(b.text || "") }, remember);
        await atlasCacheBust(env);
        return json(r);
      }
      return json({ error: "not_found" }, 404);
    }
    if (url.pathname === "/api/atlas" || url.pathname === "/api/atlas/") {
      if (!(await atlasAuthorized(env, request))) return json({ error: "unauthorized" }, 401);
      if (request.method.toUpperCase() !== "GET") return json({ error: "method" }, 405);
      const kv = env.MEDIA as unknown as AtlasKV | undefined;
      let fp = "";
      if (ATLAS_CACHE_ENABLED && kv) {
        try {
          fp = (await env.DB.prepare(`SELECT (SELECT COUNT(*) || '/' || IFNULL(MAX(updated_at), '') FROM memories) || '|' || (SELECT COUNT(*) FROM memory_links) || '|' || (SELECT COUNT(*) FROM garden_links) || '|' || (SELECT COUNT(*) FROM garden_embeddings) || '|' || (SELECT COUNT(*) FROM cognitions) AS fp`).first<{ fp: string }>())?.fp ?? "";
          if (fp && url.searchParams.get("fresh") !== "1") {
            const hit = await kv.get(ATLAS_CACHE_KEY, "text");
            if (hit) {
              const nl = hit.indexOf("\n");
              const meta = JSON.parse(hit.slice(0, nl)) as { fp: string; t: number };
              if (meta.fp === fp && Date.now() - meta.t < ATLAS_CACHE_TTL_S * 1000) {
                return new Response(hit.slice(nl + 1), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-atlas-cache": "hit" } });
              }
            }
          }
        } catch (e) { console.error("[atlas-cache] get", e); }
      }
      const body = JSON.stringify(await atlasData(env.DB));
      if (ATLAS_CACHE_ENABLED && kv && fp) {
        const p = kv.put(ATLAS_CACHE_KEY, JSON.stringify({ fp, t: Date.now() }) + "\n" + body, { expirationTtl: Math.max(60, ATLAS_CACHE_TTL_S * 2) }).catch((e: unknown) => console.error("[atlas-cache] put", e));
        const st = reqStore.getStore(); if (st?.ctx) st.ctx.waitUntil(p); else await p;
      }
      return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-atlas-cache": "miss" } });
    }

    if (url.pathname.startsWith("/api/view/")) {
      await ensureGardenSchema(env.DB);
      const caller = await resolveAnyCaller(env.DB, env, request);
      if (!caller.isAdmin) throw new AppError(403, "forbidden", "记忆页只给管理员密钥用。");
      const method = request.method.toUpperCase();
      const path = url.pathname.replace(/\/$/, "");
      if (method === "GET" && path === "/api/view/overview") return json(await overview(env.DB));
      if (method === "GET" && path === "/api/view/garden") return json(await gardenOverview(env.DB));
      if (method === "POST" && path === "/api/view/notes") {
        const parsed = writeNoteSchema.safeParse(await readJson(request));
        if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
        return json(await writeNote(env.DB, parsed.data), 201);
      }

      if (method === "GET" && path === "/api/view/conversations") {
        const persona = url.searchParams.get("persona_id") ?? undefined;
        return json({ items: await listConversations(env.DB, persona) });
      }
      if (method === "POST" && path === "/api/view/conversations") {
        const parsed = createConversationSchema.safeParse(await readJson(request));
        if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
        return json(await createConversation(env.DB, { ...parsed.data, title: parsed.data.title || "一段对话" }), 201);
      }
      const convOne = /^\/api\/view\/conversations\/([^/]+)$/.exec(path);
      if (convOne?.[1]) {
        const id = decodeURIComponent(convOne[1]);
        if (method === "GET") return json(await getConversation(env.DB, id));
        if (method === "PATCH") {
          const parsed = updateConversationSchema.safeParse(await readJson(request));
          if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
          return json(await updateConversation(env.DB, id, parsed.data));
        }
        if (method === "DELETE") return json(await deleteConversation(env.DB, id));
      }

      if (method === "POST" && path === "/api/view/garden-entries") {
        const parsed = createGardenEntrySchema.safeParse(await readJson(request));
        if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
        return json(await createGardenEntry(env.DB, parsed.data), 201);
      }
      const geOne = /^\/api\/view\/garden-entries\/([^/]+)$/.exec(path);
      if (geOne?.[1]) {
        const id = decodeURIComponent(geOne[1]);
        if (method === "PATCH") {
          const parsed = updateGardenEntrySchema.safeParse(await readJson(request));
          if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
          return json(await updateGardenEntry(env.DB, id, parsed.data));
        }
        if (method === "DELETE") return json(await deleteGardenEntry(env.DB, id));
      }

      const cardOne = /^\/api\/view\/cards\/([^/]+)\/([^/]+)$/.exec(path);
      if (method === "GET" && cardOne?.[1] && cardOne[2]) {
        return json(await getCardDetail(env.DB, decodeURIComponent(cardOne[1]), decodeURIComponent(cardOne[2])));
      }

      if (method === "POST" && path === "/api/view/favorites") {
        const parsed = favoriteSchema.safeParse(await readJson(request));
        if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
        return json(await setFavorite(env.DB, parsed.data.kind, parsed.data.ref_id, parsed.data.favorite));
      }

      if (method === "POST" && path === "/api/view/heart-traces") {
        const parsed = saveHeartTraceSchema.safeParse(await readJson(request));
        if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
        if (!parsed.data.persona_id) {
          return json({ error: "invalid", message: "花园写心痕需要 persona_id。" }, 400);
        }
        return json(await saveHeartTrace(env.DB, caller, parsed.data), 201);
      }

      if (!CFG.adult && path.startsWith("/api/view/desires")) {
        return json({ error: "disabled", message: "desire module is off (set BODY_ENABLED=1 to enable)" }, 404);
      }
      if (method === "POST" && path === "/api/view/desires") {
        const parsed = saveDesireSchema.safeParse(await readJson(request));
        if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
        if (!parsed.data.persona_id) {
          return json({ error: "invalid", message: "花园记欲望需要 persona_id。" }, 400);
        }
        return json(await saveDesire(env.DB, caller, parsed.data), 201);
      }

      const metaOne = /^\/api\/view\/persona-meta\/([^/]+)$/.exec(path);
      if (method === "PUT" && metaOne?.[1]) {
        const parsed = personaMetaSchema.safeParse(await readJson(request));
        if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
        return json(await upsertPersonaMeta(env.DB, decodeURIComponent(metaOne[1]), parsed.data));
      }

      if (method === "POST" && path === "/api/view/voice") {
        if (!env.MEDIA) return json({ error: "unavailable", message: "语音存储尚未配置。" }, 503);
        const ct = request.headers.get("content-type") || "";
        let persona_id = "";
        let title = "";
        let mime = "audio/webm";
        let bytes: ArrayBuffer | null = null;
        if (ct.includes("multipart/form-data")) {
          const form = await request.formData();
          persona_id = String(form.get("persona_id") || "");
          title = String(form.get("title") || "");
          const file = form.get("file");
          if (file && typeof file === "object" && "arrayBuffer" in file) {
            const blob = file as File;
            mime = blob.type || mime;
            bytes = await blob.arrayBuffer();
            if (!title && blob.name) title = blob.name.replace(/\.[^.]+$/, "");
          }
        } else {
          persona_id = url.searchParams.get("persona_id") || "";
          title = url.searchParams.get("title") || "";
          mime = ct.split(";")[0]?.trim() || mime;
          bytes = await request.arrayBuffer();
        }
        if (!persona_id || !bytes) {
          return json({ error: "invalid", message: "需要 persona_id 和音频文件。" }, 400);
        }
        return json(await saveVoiceClip(env.DB, env.MEDIA, { persona_id, title, mime, bytes }), 201);
      }
      const voiceOne = /^\/api\/view\/voice\/([^/]+)$/.exec(path);
      if (voiceOne?.[1]) {
        const id = decodeURIComponent(voiceOne[1]);
        if (method === "GET") {
          if (!env.MEDIA) return json({ error: "unavailable", message: "语音存储尚未配置。" }, 503);
          const clip = await getVoiceClip(env.DB, id);
          const buf = await readVoiceBytes(env.MEDIA, clip);
          return withCors(
            new Response(buf, {
              status: 200,
              headers: {
                "content-type": clip.mime || "application/octet-stream",
                "cache-control": "private, max-age=3600",
                "content-length": String(clip.size || buf.byteLength),
              },
            }),
          );
        }
        if (method === "DELETE") return json(await deleteVoiceClip(env.DB, env.MEDIA, id));
      }

      if (method === "POST" && path === "/api/view/images") {
        if (!env.MEDIA) return json({ error: "unavailable", message: "图片存储尚未配置。" }, 503);
        const ct = request.headers.get("content-type") || "";
        let persona_id = "";
        let title = "";
        let mime = "image/png";
        let bytes: ArrayBuffer | null = null;
        if (ct.includes("multipart/form-data")) {
          const form = await request.formData();
          persona_id = String(form.get("persona_id") || "");
          title = String(form.get("title") || "");
          const file = form.get("file");
          if (file && typeof file === "object" && "arrayBuffer" in file) {
            const blob = file as File;
            mime = blob.type || mime;
            bytes = await blob.arrayBuffer();
            if (!title && blob.name) title = blob.name.replace(/\.[^.]+$/, "");
          }
        } else {
          persona_id = url.searchParams.get("persona_id") || "";
          title = url.searchParams.get("title") || "";
          mime = ct.split(";")[0]?.trim() || mime;
          bytes = await request.arrayBuffer();
        }
        if (!persona_id || !bytes) {
          return json({ error: "invalid", message: "需要 persona_id 和图片文件。" }, 400);
        }
        return json(await saveGardenImage(env.DB, env.MEDIA, { persona_id, title, mime, bytes }), 201);
      }
      const imageOne = /^\/api\/view\/images\/([^/]+)$/.exec(path);
      if (imageOne?.[1]) {
        const id = decodeURIComponent(imageOne[1]);
        if (method === "GET") {
          if (!env.MEDIA) return json({ error: "unavailable", message: "图片存储尚未配置。" }, 503);
          const img = await getGardenImage(env.DB, id);
          const buf = await readGardenImageBytes(env.MEDIA, img);
          return withCors(
            new Response(buf, {
              status: 200,
              headers: {
                "content-type": img.mime || "application/octet-stream",
                "cache-control": "private, max-age=3600",
                "content-length": String(img.size || buf.byteLength),
              },
            }),
          );
        }
        if (method === "DELETE") return json(await deleteGardenImage(env.DB, env.MEDIA, id));
      }

      const continuityOne = /^\/api\/view\/(notes|handoffs|unresolved)\/([^/]+)$/.exec(path);
      if (continuityOne?.[1] && continuityOne[2]) {
        const kind = continuityOne[1];
        const id = decodeURIComponent(continuityOne[2]);
        if (method === "DELETE") {
          const r = await env.DB.prepare(`DELETE FROM ${kind} WHERE id = ?`).bind(id).run();
          return json({ ok: true, deleted: r.meta?.changes ?? 0 });
        }
        if (method === "PATCH") {
          const body = await readJson(request);
          if (kind === "handoffs") {
            const parsed = updateHandoffSchema.safeParse(body);
            if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
            return json(await updateHandoff(env.DB, id, parsed.data));
          }
          if (kind === "notes") {
            const parsed = updateNoteContentSchema.safeParse(body);
            if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
            return json(await updateNoteContent(env.DB, id, parsed.data));
          }
          const parsed = updateUnresolvedItemSchema.safeParse(body);
          if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
          return json(await updateUnresolvedItem(env.DB, id, parsed.data));
        }
      }

      if (path === "/api/view/status") {
        if (method === "GET") {
          const s = await latestStatus(env.DB);
          return json({ status: s });
        }
        if (method === "POST") {
          const parsed = setHerStatusSchema.safeParse(await readJson(request));
          if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
          return json(await setHerStatus(env.DB, "user", parsed.data), 201);
        }
      }
      if (method === "GET" && path === "/api/view/status/history") {
        return json(await listStatusHistory(env.DB, Number(url.searchParams.get("limit") || 50)));
      }
      const statusOne = /^\/api\/view\/status\/([^/]+)$/.exec(path);
      if (statusOne?.[1] && method === "DELETE") return json(await deleteStatus(env.DB, decodeURIComponent(statusOne[1])));
      if (method === "GET" && path === "/api/view/companion-notes") return json(await listCompanionNotes(env.DB));
      if (method === "POST" && path === "/api/view/companion-notes/seen") {
        const parsed = markSeenSchema.safeParse(await readJson(request));
        if (!parsed.success) return json({ error: "invalid", message: "参数不对。" }, 400);
        return json(await markCompanionNotesSeen(env.DB, parsed.data.ids));
      }
      const cnOne = /^\/api\/view\/companion-notes\/([^/]+)$/.exec(path);
      if (cnOne?.[1] && method === "DELETE") return json(await deleteCompanionNote(env.DB, decodeURIComponent(cnOne[1])));
      if (method === "GET" && path === "/api/view/finished") {
        const pid = url.searchParams.get("persona_id") || undefined;
        const lim = Number(url.searchParams.get("limit") || 50);
        return json({ items: await recentFinished(env.DB, pid, Number.isFinite(lim) ? Math.min(lim, 200) : 50) });
      }

      const memOne = /^\/api\/view\/memories\/([^/]+)$/.exec(path);
      if (memOne?.[1]) {
        const id = decodeURIComponent(memOne[1]);
        if (method === "DELETE") return json(await forget(env.DB, caller, id));
        if (method === "PATCH") {
          const parsed = updateGardenMemorySchema.safeParse(await readJson(request));
          if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
          return json(await updateMemory(env.DB, caller, { id, content: parsed.data.content }));
        }
      }

      const heartOne = /^\/api\/view\/heart-traces\/([^/]+)$/.exec(path);
      if (heartOne?.[1] && method === "DELETE") {
        return json(await forgetDeckItem(env.DB, caller, decodeURIComponent(heartOne[1])));
      }

      const desireReply = /^\/api\/view\/desires\/([^/]+)\/replies$/.exec(path);
      if (desireReply?.[1] && method === "POST") {
        const parsed = replyDesireSchema.safeParse({
          ...((await readJson(request)) as object),
          desire_id: decodeURIComponent(desireReply[1]),
        });
        if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
        return json(
          await addDesireReply(env.DB, caller, {
            ...parsed.data,
            author_label: parsed.data.author_label ?? CFG.userName,
          }),
          201,
        );
      }

      const desireOne = /^\/api\/view\/desires\/([^/]+)$/.exec(path);
      if (desireOne?.[1] && method === "DELETE") {
        return json(await forgetDesire(env.DB, caller, decodeURIComponent(desireOne[1])));
      }

      const deckViewOne = /^\/api\/view\/deck\/([^/]+)$/.exec(path);
      if (deckViewOne?.[1] && method === "DELETE") {
        return json(await forgetDeckItem(env.DB, caller, decodeURIComponent(deckViewOne[1])));
      }

      return json({ error: "not_found", message: "没有这个接口。" }, 404);
    }

    // 必须在 /api/<persona>/… 之前匹配，避免 deck 被当成人格 id
    if (url.pathname === "/api/deck" || url.pathname.startsWith("/api/deck/")) {
      const caller = await resolveAnyCaller(env.DB, env, request);
      return await deckRest(request, env, caller, url);
    }

    const housePath =
      url.pathname === "/mcp" ||
      url.pathname === "/mcp/" ||
      url.pathname === "/mcp/house" ||
      url.pathname === "/mcp/house/";
    if (housePath) {
      const caller = await resolveHouseCaller(env.DB, env, request);
      if (request.method === "GET" && !(request.headers.get("accept") ?? "").includes("text/event-stream")) {
        return text(DOORS.map((d) => d.tool).join("\n") + "\n");
      }
      return withCors(await mcpResponse(request, env, caller));
    }

    const mcpMatch = /^\/mcp\/([a-z][a-z0-9_-]{0,31})\/?$/.exec(url.pathname);
    if (mcpMatch?.[1]) {
      const caller = await resolveCaller(env.DB, env, request, mcpMatch[1]);
      if (request.method === "GET" && !(request.headers.get("accept") ?? "").includes("text/event-stream")) {
        return text(
          `这是${caller.persona.display_name}（${caller.persona.id}）的记忆连接。\n用 MCP 客户端向这个地址发 POST。\n对话开始先调用 whoami。\n${caller.isAdmin ? "当前密钥是管理员，正在作为这位人格说话。\n" : ""}`,
        );
      }
      return withCors(await mcpResponse(request, env, caller));
    }

    const apiMatch = /^\/api\/([a-z][a-z0-9_-]{0,31})(\/.*)$/.exec(url.pathname);
    if (apiMatch?.[1] && apiMatch[2]) {
      const ta = Date.now();
      const caller = await resolveCaller(env.DB, env, request, apiMatch[1]);
      const tb = Date.now();
      const res = await rest(request, env, caller, apiMatch[2]);
      const tc = Date.now();
      try { res.headers.set("server-timing", `schema;dur=${tSchema}, auth;dur=${tb - ta}, handler;dur=${tc - tb}`); } catch { /* immutable */ }
      return res;
    }
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    console.error(error);
    return json({ error: "internal", message: "服务器出错了。" }, 500);
  }

  return json({ error: "not_found", message: "没有这个地址。" }, 404);
}

async function rest(
  request: Request,
  env: Env,
  caller: Awaited<ReturnType<typeof resolveCaller>>,
  path: string,
): Promise<Response> {
  const db = env.DB;
  const method = request.method.toUpperCase();

  if (method === "GET" && (path === "/whoami" || path === "/whoami/")) {
    return json(await whoami(db, caller));
  }
  if (method === "GET" && (path === "/personas" || path === "/personas/")) {
    return json(await listPersonas(db));
  }
  if (method === "GET" && (path === "/memory-card" || path === "/memory_card" || path === "/memory-card/" || path === "/memory_card/")) {
    const url = new URL(request.url);
    const parsed = memoryCardSchema.safeParse({ persona_id: url.searchParams.get("persona") ?? undefined });
    if (!parsed.success) return json({ error: "invalid", message: "persona 参数不对。" }, 400);
    return json(await memoryCard(db, caller, parsed.data.persona_id));
  }
  if (method === "POST" && (path === "/remember" || path === "/remember/")) {
    const parsed = rememberSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
    const headerPlatform = request.headers.get("x-source-platform");
    return json(
      await remember(db, caller, {
        ...parsed.data,
        source_platform: parsed.data.source_platform ?? headerPlatform ?? undefined,
      }),
      201,
    );
  }
  if (method === "POST" && (path === "/recall" || path === "/recall/")) {
    const parsed = recallSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
    return json(await recall(db, caller, parsed.data));
  }
  if (method === "PUT" && (path === "/self-card" || path === "/self-card/")) {
    const parsed = updateSelfCardSchema.safeParse(await readJson(request));
    if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
    return json(await updateSelfCard(db, caller, parsed.data.self_card));
  }

  const p = path.replace(/\/$/, "");
  const bad = (e: { issues: { message?: string }[] }) =>
    json({ error: "invalid", message: e.issues[0]?.message ?? "参数不对。" }, 400);
  if (method === "GET" && (p === "/session-start" || p === "/session_start")) {
    return json(await sessionStart(db, caller, { drafts: env.SESSION_START_DRAFTS === "1" }));
  }
  if (method === "POST" && (p === "/thread-close" || p === "/thread_close")) {
    const parsed = threadCloseSchema.safeParse(await readJson(request));
    if (!parsed.success) return bad(parsed.error);
    return json(await threadClose(db, caller, parsed.data), 201);
  }
  if (p === "/unresolved") {
    if (method === "GET") {
      const st = new URL(request.url).searchParams.get("status");
      const status = st === "closed" || st === "all" ? st : "open";
      return json({ items: await listUnresolved(db, caller.persona.id, status, 100) });
    }
    if (method === "POST") {
      const parsed = addUnresolvedSchema.safeParse(await readJson(request));
      if (!parsed.success) return bad(parsed.error);
      return json(await addUnresolved(db, caller, parsed.data), 201);
    }
  }
  const closeMatch = /^\/unresolved\/([^/]+)\/close$/.exec(p);
  if (closeMatch?.[1] && method === "POST") {
    const parsed = closeUnresolvedSchema.safeParse({ ...((await readJson(request)) as object), id: decodeURIComponent(closeMatch[1]) });
    if (!parsed.success) return bad(parsed.error);
    return json(await closeUnresolved(db, caller, parsed.data));
  }
  if (method === "GET" && p === "/notes") {
    return json({ notes: await listNotes(db, caller.persona.id, undefined, 100) });
  }
  const replyMatch = /^\/notes\/([^/]+)\/reply$/.exec(p);
  if (replyMatch?.[1] && method === "POST") {
    const parsed = replyNoteSchema.safeParse({ ...((await readJson(request)) as object), note_id: decodeURIComponent(replyMatch[1]) });
    if (!parsed.success) return bad(parsed.error);
    return json(await replyNote(db, caller, parsed.data));
  }
  if (method === "GET" && p === "/dreams") {
    const lim = Number(new URL(request.url).searchParams.get("limit") ?? 5);
    return json(await listDreams(db, caller.persona.id, Number.isFinite(lim) ? lim : 5));
  }
  if (method === "POST" && p === "/dreams/delete" && caller.isAdmin) {
    const b = ((await readJson(request).catch(() => ({}))) ?? {}) as { id?: string };
    if (!b.id) return json({ ok: false, error: "id_required" }, 400);
    return json(await deleteDream(db, caller.persona.id, b.id));
  }
  if (method === "POST" && p === "/dreams/save" && caller.isAdmin) {
    const b = ((await readJson(request).catch(() => ({}))) ?? {}) as { id: string; date: string; text: string; cited_ids?: string[]; model?: string; status?: string; note?: string };
    return json(await saveDream(db, caller.persona.id, b));
  }
  if (method === "POST" && p === "/dreams/run" && caller.isAdmin) {
    const b = ((await readJson(request).catch(() => ({}))) ?? {}) as { now_ms?: number; force?: boolean; no_ai?: boolean; dry_run?: boolean };
    return json(await runDream(db, b.no_ai || !env.AI ? null : workersAiGen(env.AI), { nowMs: typeof b.now_ms === "number" ? b.now_ms : Date.now(), force: b.force !== false, persona: caller.persona.id, dryRun: b.dry_run === true }));
  }
  if (p === "/emotion" || p.startsWith("/emotion/")) {
    // 伙伴的两层情绪：Worker 为唯一真值；App / voice MCP 都走这里。
    if (!EMOTION_PERSONAS.has(caller.persona.id)) return json({ error: "not_enabled", message: "这位人格没有情绪状态。" }, 404);
    const u = new URL(request.url);
    const pid = caller.isAdmin && u.searchParams.get("sim") === "1" ? `sim_${caller.persona.id}` : caller.persona.id;
    const nowMs = caller.isAdmin && u.searchParams.get("now_ms") ? Number(u.searchParams.get("now_ms")) : Date.now();
    if (method === "GET" && (p === "/emotion" || p === "/emotion/state")) return json(await emotionState(db, pid, nowMs));
    if (method === "GET" && p === "/emotion/events") return json(await emotionEvents(db, pid, Number(u.searchParams.get("limit") ?? 30) || 30));
    if (method === "POST" && p === "/emotion/apply") {
      const b = ((await readJson(request)) ?? {}) as Record<string, unknown>;
      return json(await emotionApply(db, pid, {
        changes: (b.changes && typeof b.changes === "object" ? b.changes : {}) as Record<string, unknown>,
        reason: String(b.reason ?? ""),
        inner_cause: typeof b.inner_cause === "string" ? b.inner_cause : undefined,
        addressed_cause: b.addressed_cause === true,
        admit: Array.isArray(b.admit) ? b.admit.map(String) : undefined,
        coax: b.coax === true,
      }, typeof b.source === "string" ? b.source.slice(0, 20) : "http", nowMs));
    }
    if (method === "POST" && p === "/emotion/fact") {
      const b = ((await readJson(request)) ?? {}) as Record<string, unknown>;
      return json(await emotionFact(db, pid, { type: String(b.type ?? ""), at: typeof b.at === "string" ? b.at : undefined, data: b.data }, nowMs));
    }
    if (method === "POST" && p === "/emotion/import") {
      const b = ((await readJson(request)) ?? {}) as Record<string, unknown>;
      return json(await emotionImport(db, pid, (b.values ?? {}) as Record<string, unknown>, nowMs));
    }
    return json({ error: "not_found", message: "情绪接口：GET /emotion/state, GET /emotion/events, POST /emotion/apply, POST /emotion/fact, POST /emotion/import" }, 404);
  }
  if (p === "/body" || p.startsWith("/body/")) {
    const url = new URL(request.url);
    if (!BODY_PERSONAS.has(caller.persona.id)) return json({ error: "not_enabled", message: "这位人格没有身体状态。" }, 404);
    // 管理员模拟：?sim=1 → 独立的 sim_<id> 状态，不污染真实状态
    await ensureBodySchema(db);
    const pid = caller.isAdmin && url.searchParams.get("sim") === "1" ? `sim_${caller.persona.id}` : caller.persona.id;
    if (method === "GET" && (p === "/body" || p === "/body/debug")) {
      const nowMs = caller.isAdmin && url.searchParams.get("now_ms") ? Number(url.searchParams.get("now_ms")) : Date.now();
      return json(await bodyDebug(db, pid, nowMs));
    }
    if (method === "GET" && p === "/body/log") {
      return json(await bodyLog(db, pid, Number(url.searchParams.get("limit") ?? 50)));
    }
    if (method === "POST" && p === "/body/log/read") {
      return json(await bodyLogMarkRead(db, pid, Date.now()));
    }
    if (p === "/body/avatar/snapshot") {
      if (method === "POST") { const r = await saveSnapshot(env, pid, request); return json(r.body, r.status); }
      if (method === "DELETE") { await deleteSnapshot(env, pid); return json({ ok: true }); }
      if (method === "GET") {
        if (url.searchParams.get("meta") === "1") return json({ snapshot: await loadSnapshotMeta(env, pid) });
        const snap = await loadSnapshot(env, pid);
        if (!snap) return json({ error: "not_found", message: "还没有截图。" }, 404);
        return new Response(snap.data, { headers: { "content-type": snap.meta.mime, "cache-control": "no-store", "x-snapshot-at": snap.meta.at } });
      }
    }
    if (method === "GET" && p === "/body/avatar") {
      const nowMs = caller.isAdmin && url.searchParams.get("now_ms") ? Number(url.searchParams.get("now_ms")) : Date.now();
      const meta = await loadSnapshotMeta(env, pid).catch(() => null);
      return json({ ...(await bodyAvatar(db, pid, nowMs)), snapshot: meta ? { ...meta, age_sec: Math.round((nowMs - Date.parse(meta.at)) / 1000) } : null });
    }
    if (method === "POST" && p === "/body/turn") {
      const b = ((await readJson(request)) ?? {}) as { message?: string; context?: string; events?: BodyEvent[]; now_ms?: number; dry_classify?: boolean };
      const input = { message: typeof b.message === "string" ? b.message.slice(0, 2000) : undefined, context: typeof b.context === "string" ? b.context.slice(0, 300) : undefined, events: caller.isAdmin && Array.isArray(b.events) ? b.events : undefined, now_ms: caller.isAdmin && typeof b.now_ms === "number" ? b.now_ms : undefined, dry_classify: caller.isAdmin && b.dry_classify === true };
      const cls = pickClassifier(env);
      return json(await bodyTurn(db, pid, input, cls));
    }
    if (method === "POST" && p === "/body/cron" && caller.isAdmin) {
      const b = ((await readJson(request)) ?? {}) as { now_ms?: number; send?: boolean; fake_reply?: string; force?: boolean; hard_fail?: boolean };
      const sender = typeof b.fake_reply === "string" && pid.startsWith("sim_")
        ? { send: async () => ({ ok: true, text: b.fake_reply as string }) }
        : b.send && !pid.startsWith("sim_") && env.BRIDGE_URL && env.BRIDGE_KEY
          ? bridgeSender(env.BRIDGE_URL, env.BRIDGE_KEY, { silent: env.BODY_STROKE_LOOP === "1" })
          : null;
      return json(await bodyCron(db, pid, typeof b.now_ms === "number" ? b.now_ms : Date.now(), sender, undefined, { force: b.force === true, hardFail: b.hard_fail === true }));
    }
    // 管理员修复：删误判痕迹/事件 + 重设数值（不调模型）
    if (method === "POST" && p === "/body/repair" && caller.isAdmin) {
      const b = ((await readJson(request)) ?? {}) as { delete_trace_ids?: string[]; delete_event_at?: string[]; set?: Record<string, number>; reset_snapshot?: boolean };
      let dt = 0, de = 0;
      for (const id of b.delete_trace_ids ?? []) dt += (await db.prepare(`DELETE FROM body_traces WHERE persona_id = ? AND id = ?`).bind(pid, id).run()).meta?.changes ?? 0;
      for (const id of b.delete_event_at ?? []) de += (await db.prepare(`DELETE FROM body_events WHERE persona_id = ? AND created_at = ? AND source = 'turn'`).bind(pid, id).run()).meta?.changes ?? 0;
      const b2 = b as { set?: Record<string, number>; reset_snapshot?: boolean; clear_refractory?: boolean; threshold?: number; numbness?: number };
      const allowed = ["hardness", "fullness", "sensitivity", "edge", "desire", "stim", "fluids"];
      for (const [k, v] of Object.entries(b.set ?? {})) if (allowed.includes(k) && typeof v === "number") await db.prepare(`UPDATE body_state SET ${k} = ? WHERE persona_id = ?`).bind(Math.max(0, Math.min(100, v)), pid).run();
      if (typeof b2.threshold === "number") await db.prepare(`UPDATE body_state SET threshold = ? WHERE persona_id = ?`).bind(Math.max(50, Math.min(150, b2.threshold)), pid).run();
      if (typeof b2.numbness === "number") await db.prepare(`UPDATE body_state SET numbness = ? WHERE persona_id = ?`).bind(Math.max(0, Math.min(1, b2.numbness)), pid).run();
      if (b2.clear_refractory) await db.prepare(`UPDATE body_state SET refractory_until = NULL WHERE persona_id = ?`).bind(pid).run();
      if (b.reset_snapshot) await db.prepare(`UPDATE body_state SET last_injected_snapshot = NULL, desire_high_since = NULL WHERE persona_id = ?`).bind(pid).run();
      return json({ ok: true, deleted_traces: dt, deleted_events: de, debug: await bodyDebug(db, pid, Date.now()) });
    }
    if (method === "DELETE" && p === "/body/sim" && caller.isAdmin && pid.startsWith("sim_")) {
      for (const t of ["body_state", "body_traces", "body_events", "body_wake_queue", "body_private_records"]) await db.prepare(`DELETE FROM ${t} WHERE persona_id = ?`).bind(pid).run();
      return json({ ok: true, cleared: pid });
    }
    return json({ error: "not_found" }, 404);
  }
  if (method === "POST" && (p === "/auto-recall" || p === "/auto_recall")) {
    const parsed = autoRecallSchema.safeParse(await readJson(request));
    if (!parsed.success) return bad(parsed.error);
    return json(await autoRecall(db, caller, parsed.data));
  }

  if (method === "POST" && (p === "/heart-traces" || p === "/heart_traces" || p === "/heart")) {
    const parsed = saveHeartTraceSchema.safeParse(await readJson(request));
    if (!parsed.success) return bad(parsed.error);
    return json(await saveHeartTrace(db, caller, { ...parsed.data, persona_id: parsed.data.persona_id ?? caller.persona.id }), 201);
  }
  if (method === "GET" && (p === "/heart-traces" || p === "/heart_traces")) {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    return json(await listHeartTraces(db, caller, { limit: Number.isFinite(limit) ? limit : undefined }));
  }

  if (!CFG.adult && /^\/desires?(\/|$)/.test(p)) {
    return json({ error: "disabled", message: "desire module is off (set BODY_ENABLED=1 to enable)" }, 404);
  }
  if (method === "POST" && (p === "/desires" || p === "/desire")) {
    const parsed = saveDesireSchema.safeParse(await readJson(request));
    if (!parsed.success) return bad(parsed.error);
    return json(await saveDesire(db, caller, { ...parsed.data, persona_id: parsed.data.persona_id ?? caller.persona.id }), 201);
  }
  if (method === "GET" && (p === "/desires" || p === "/desire")) {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const persona_id = url.searchParams.get("persona_id") || undefined;
    return json(await listDesires(db, caller, { limit: Number.isFinite(limit) ? limit : undefined, persona_id: persona_id || undefined }));
  }

  const desireOne = /^\/desires\/([^/]+)$/.exec(p) || /^\/desire\/([^/]+)$/.exec(p);
  if (desireOne?.[1]) {
    const id = decodeURIComponent(desireOne[1]);
    if (method === "GET") return json(await getDesire(db, caller, id));
    if (method === "DELETE") return json(await forgetDesire(db, caller, id));
  }
  const desireReply = /^\/desires\/([^/]+)\/replies$/.exec(p) || /^\/desire\/([^/]+)\/replies$/.exec(p);
  if (desireReply?.[1] && method === "POST") {
    const body = await readJson(request);
    const record = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const parsed = replyDesireSchema.safeParse({ ...record, desire_id: decodeURIComponent(desireReply[1]) });
    if (!parsed.success) return bad(parsed.error);
    return json(await addDesireReply(db, caller, parsed.data), 201);
  }

  const memPin = /^\/memories\/([^/]+)\/(pin|unpin)\/?$/.exec(path);
  if (memPin?.[1] && method === "POST") return json(await pinMemory(db, caller, decodeURIComponent(memPin[1]), memPin[2] === "pin"));
  const memoryMatch = /^\/memories\/([^/]+)\/?$/.exec(path);
  if (memoryMatch?.[1]) {
    const id = decodeURIComponent(memoryMatch[1]);
    if (method === "GET") return json(await openMemory(db, caller, id));
    if (method === "DELETE") return json(await forget(db, caller, id));
    if (method === "PATCH") {
      const body = await readJson(request);
      const record = body && typeof body === "object" && !Array.isArray(body) ? body : {};
      const parsed = updateMemorySchema.safeParse({ ...record, id });
      if (!parsed.success) return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
      return json(await updateMemory(db, caller, parsed.data));
    }
  }


  // Peer friends: /peers (list) and /peers/{friend}/messages (GET read, POST send)
  if (method === "GET" && p === "/peers") {
    return json({ me: caller.persona.id, friends: friendsOf(env, caller.persona.id), unread: await unreadPeerCounts(db, caller.persona.id) });
  }
  const peerMsg = /^\/peers\/([a-z0-9_-]+)\/messages$/.exec(p);
  if (peerMsg) {
    const friend = peerMsg[1]!;
    const url = new URL(request.url);
    const self = resolvePeerSelf(caller, url.searchParams.get("as"));
    assertFriends(env, self, friend);
    if (method === "GET") {
      const lim = Number(url.searchParams.get("limit") ?? 50);
      const after = url.searchParams.get("after");
      const out = await listPeerMessages(db, { threadId: threadIdFor(self, friend), limit: Number.isFinite(lim) ? lim : 50, after });
      if (url.searchParams.get("mark_read") !== "0") await markThreadRead(db, self, friend);
      return json(out);
    }
    if (method === "POST") {
      const body = ((await readJson(request).catch(() => ({}))) ?? {}) as { text?: string; priority?: string };
      const result = await postPeerMessage(db, env, caller, { ...body, from: self, to: friend });
      return json({ ok: true, message: result.message, wake: result.wake.status, wake_target: result.wake.target, wake_detail: result.wake.detail }, 201);
    }
    return json({ error: "method", message: "用 GET 或 POST。" }, 405);
  }

  return json({ error: "not_found", message: "没有这个接口。" }, 404);
}

function parseOptionalKind(raw: string | null): DeckKind | undefined {
  if (!raw) return undefined;
  return raw as DeckKind;
}

function parseDrawSource(raw: string | null | undefined): DrawSource {
  if (raw === "mcp" || raw === "web" || raw === "rest") return raw;
  return "rest";
}

async function deckRest(
  request: Request,
  env: Env,
  caller: Awaited<ReturnType<typeof resolveAnyCaller>>,
  url: URL,
): Promise<Response> {
  const db = env.DB;
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (method === "GET" && path === "/api/deck/topics") {
    return json(await listTopics(db, caller));
  }
  if (method === "POST" && path === "/api/deck/topics") {
    const parsed = createTopicSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
    }
    return json(await createTopic(db, caller, parsed.data), 201);
  }
  if (method === "GET" && path === "/api/deck/items") {
    const topic = url.searchParams.get("topic") ?? undefined;
    const kind = parseOptionalKind(url.searchParams.get("kind"));
    const query = url.searchParams.get("query") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    return json(
      await listDeckItems(
        db,
        {
          topic_id: topic,
          kind,
          query: query || undefined,
          limit: Number.isFinite(limit) ? limit : undefined,
        },
        caller,
      ),
    );
  }
  const getOne = /^\/api\/deck\/items\/([^/]+)$/.exec(path);
  if (getOne?.[1] && method === "GET") {
    return json(await getDeckItem(db, caller, decodeURIComponent(getOne[1])));
  }
  if (method === "POST" && path === "/api/deck/items") {
    const parsed = addDeckItemSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
    }
    return json(await addDeckItem(db, caller, parsed.data), 201);
  }
  if (method === "GET" && path === "/api/deck/draw") {
    const topic = url.searchParams.get("topic") ?? undefined;
    const kind = parseOptionalKind(url.searchParams.get("kind"));
    const source = parseDrawSource(url.searchParams.get("source"));
    const parsed = drawDeckSchema.safeParse({ topic_id: topic, kind });
    if (!parsed.success) {
      return json({ error: "invalid", message: parsed.error.issues[0]?.message ?? "参数不对。" }, 400);
    }
    return json(await drawDeck(db, { ...parsed.data, source }, caller));
  }
  if (method === "GET" && path === "/api/deck/recent") {
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 20;
    return json(await listRecentDraws(db, Number.isFinite(limit) ? limit : 20));
  }
  const delMatch = /^\/api\/deck\/items\/([^/]+)$/.exec(path);
  if (delMatch?.[1] && method === "DELETE") {
    const id = decodeURIComponent(delMatch[1]);
    return json(await forgetDeckItem(db, caller, id));
  }
  return json({ error: "not_found", message: "没有这个抽卡匣接口。" }, 404);
}
