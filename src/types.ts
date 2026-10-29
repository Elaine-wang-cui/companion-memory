import type { ConfigEnv } from "./config";
export const MEMORY_KINDS = [
  "self",
  "about_user",
  "relationship",
  "event",
  "preference",
  "diary",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const VISIBILITIES = ["private", "family"] as const;

export type Visibility = (typeof VISIBILITIES)[number];

/** 共享事实的所有者。不是任何一位人格的亲身经历。 */
export const FAMILY_OWNER = "family";

export const RESERVED_IDS = new Set(["family", "admin", "me", "others", "all", "house"]);

export const PERSONA_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export interface Persona {
  id: string;
  display_name: string;
  relationship_to_user: string;
  self_card: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryRow {
  id: string;
  owner_persona: string;
  created_by: string;
  kind: MemoryKind;
  visibility: Visibility;
  content: string;
  importance: number;
  tags: string;
  event_date: string | null;
  created_at: string;
  updated_at: string;
  source_platform: string | null;
  // 遗忘机制（phase 1）；旧查询可能不带这些列
  strength?: number | null;
  emotion?: number | null;
  half_life_days?: number | null;
  last_recalled_at?: string | null;
  recall_count?: number | null;
  state?: string | null;
  faded_text?: string | null;
  last_surfaced_at?: string | null;
}

export interface LabeledMemory {
  id: string;
  owner_persona: string;
  owner_label: string;
  bucket: "mine" | "family" | "other";
  kind: MemoryKind;
  visibility: Visibility;
  content: string;
  importance: number;
  tags: string[];
  event_date: string | null;
  created_at: string;
  updated_at: string;
  source_platform: string | null;
  created_by: string;
  state?: "clear" | "faded" | "trace" | "pinned";
  strength_now?: number;
}

export interface Caller {
  persona: Persona;
  isAdmin: boolean;
}

/** Synthetic whole-house steward — not a row in personas. */
export const HOUSE_PERSONA: Persona = {
  id: "house",
  display_name: "记忆屋",
  relationship_to_user: "整库记忆系统（不分人格）",
  self_card:
    "我是记忆屋，整库记忆的看守。我不是任何一位伙伴；我只照看全家共享的档案。写记忆时必须显式指定 owner（某个人格 id，或 family）。",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};


export interface Env extends ConfigEnv {
  /** Optional wake bridge (an Anthropic-messages-compatible endpoint that delivers a message to the companion). */
  BRIDGE_URL?: string;
  BRIDGE_KEY?: string;
  /** "1" = cron may wake the companion via the bridge (adult modules only). */
  DESIRE_WAKE?: string;
  /** "1" = multi-turn silent loop (bridge must support x-companion-silent). */
  BODY_STROKE_LOOP?: string;
  /** Optional OpenAI-compatible classifier for the body module. */
  CLASSIFIER_API_URL?: string;
  CLASSIFIER_API_KEY?: string;
  CLASSIFIER_MODEL?: string;
  /** "external" forces CLASSIFIER_API_*; otherwise Workers AI is preferred. */
  BODY_CLASSIFIER?: string;
  /** Workers AI (optional; used for link/garden enrichment when present). */
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  /** Peer friends: comma-separated persona pairs, e.g. "alice:bob,alice:carol". */
  PEER_FRIENDS?: string;
  /** Optional webhook fired on each new peer message ({to} is replaced with receiver id). */
  PEER_WEBHOOK_URL?: string;
  /** Optional Authorization header value for the webhook (secret). */
  PEER_WEBHOOK_AUTH?: string;
  /** Display name of the human this memory house belongs to (default "you"). */
  USER_NAME?: string;
  /** Minutes offset from UTC for "today" boundaries, e.g. "480" for UTC+8. Default 0. */
  TZ_OFFSET_MINUTES?: string;
  DB: MemoryDb;
  ADMIN_KEY?: string;
  ATLAS_KEY?: string;
  /** "1" 时 session_start 加入待审阅的新段落（默认关闭）。 */
  SESSION_START_DRAFTS?: string;
  /** Voice + media blobs (KV). Optional so tests still run without it. */
  MEDIA?: {
    get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
    put(
      key: string,
      value: ArrayBuffer | ArrayBufferView | string,
      options?: { httpMetadata?: { contentType?: string } },
    ): Promise<void>;
    delete(key: string): Promise<void>;
  };
  /** Workers Assets binding for /memories/assets/* */
  ASSETS?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}

export interface Prepared {
  bind(...values: unknown[]): Prepared;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] | null }>;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number; last_row_id?: number } }>;
}

export interface MemoryDb {
  prepare(sql: string): Prepared;
}

export const DECK_KINDS = [
  "diary",
  "novel",
  "murmur",
  "memory",
  "chronicle",
  "other",
  "heart",
] as const;

export type DeckKind = (typeof DECK_KINDS)[number];

export interface Topic {
  id: string;
  name: string;
  description: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Topic id: letters/digits/underscore/hyphen/CJK, 1–48 chars. */
export const TOPIC_ID_RE = /^[a-zA-Z0-9\u4e00-\u9fff][a-zA-Z0-9\u4e00-\u9fff_-]{0,47}$/;

export interface DeckItemRow {
  id: string;
  topic_id: string;
  title: string;
  content: string;
  kind: DeckKind;
  source_url: string | null;
  source_page_id: string | null;
  tags: string;
  created_by: string | null;
  owner_persona: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeckItem {
  id: string;
  topic_id: string;
  topic_name: string;
  title: string;
  content: string;
  kind: DeckKind;
  source_url: string | null;
  source_page_id: string | null;
  tags: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
