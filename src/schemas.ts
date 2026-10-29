import * as z from "zod/v4";
import { DECK_KINDS, MEMORY_KINDS, VISIBILITIES } from "./types";

export const kindSchema = z.enum(MEMORY_KINDS);
export const visibilitySchema = z.enum(VISIBILITIES);

export const rememberSchema = z.object({
  content: z.string().trim().min(1, "content 不能为空").max(8000, "content 太长"),
  kind: kindSchema.describe("self 自我 / about_user 关于用户 / relationship 关系 / event 事件 / preference 偏好 / diary 日记"),
  visibility: visibilitySchema
    .optional()
    .describe("private 只有所有者可见；family 全家可见。self、relationship、diary 默认 private；about_user、event、preference 默认 family。"),
  importance: z.number().int().min(1).max(5).optional().describe("1 到 5，默认 3"),
  tags: z.array(z.string()).max(12).optional(),
  event_date: z.string().optional().describe("YYYY-MM-DD，可空"),
  source_platform: z.string().optional().describe("claude / gpt / telegram / grok / mistral 等"),
  owner: z
    .string()
    .optional()
    .describe("默认是当前连接的人格。全家共享的事实填 family。只有管理员能写成另一位人格。"),
  emotion: z.number().min(0).max(1).optional().describe("情绪浓度 0–1，默认 0.3。越浓忘得越慢。"),
  pin: z.boolean().optional().describe("true = 钉住，永不淡忘（重要5/偏好/核心卡/安全词默认钉住）。"),
});

export const recallSchema = z.object({
  query: z.string().optional().describe("搜正文和标签。中文两个字以内用 LIKE，三个字起用全文索引。空则返回最近的。"),
  kind: kindSchema.optional(),
  owner: z.string().optional().describe("me / family / others / 某人格 id。不填则搜所有你看得见的。"),
  limit: z.number().int().min(1).max(50).optional(),
  include_faded: z.boolean().optional().describe("包含「记得不太清」的记忆，默认 true"),
  include_trace: z.boolean().optional().describe("包含「很久以前」几乎忘了的记忆，默认 false（原句几乎完全命中时仍会出现）"),
});

export const memoryIdSchema = z.object({ id: z.string().min(1) });

export const updateMemorySchema = z.object({
  id: z.string().min(1),
  content: z.string().trim().min(1).max(8000).optional(),
  kind: kindSchema.optional(),
  visibility: visibilitySchema.optional(),
  importance: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string()).max(12).optional(),
  event_date: z.string().nullable().optional(),
  source_platform: z.string().nullable().optional(),
});

export const forgetSchema = z.object({
  id: z.string().min(1),
});

export const updateSelfCardSchema = z.object({
  self_card: z.string().trim().min(1, "self_card 不能为空").max(4000, "self_card 太长"),
});

export const memoryCardSchema = z.object({
  persona_id: z
    .string()
    .optional()
    .describe("要导出卡片的人格。不填就是当前连接。只有本人或管理员能看到私有记忆。"),
});

export const emptySchema = z.object({});


export const deckKindSchema = z.enum(DECK_KINDS);

export const listDeckItemsSchema = z.object({
  topic_id: z.string().optional().describe("主题 id，如 diary / novel / murmur"),
  kind: deckKindSchema.optional(),
  query: z
    .string()
    .trim()
    .max(200, "query 太长")
    .optional()
    .describe("关键词，搜标题、正文与标签（LIKE）。例如「10.20」「10月20」或句子片段。命中后用 get_deck_item 取全文。"),
  limit: z.number().int().min(1).max(100).optional(),
});

export const getDeckItemSchema = z.object({
  id: z.string().min(1).describe("抽卡匣条目 id"),
});

export const addDeckItemSchema = z
  .object({
    title: z.string().trim().min(1, "title 不能为空").max(500, "title 太长"),
    content: z.string().trim().min(1, "content 不能为空"),
    topic_id: z.string().optional().describe("主题 id（含小说子类如 强制爱）；不填则按 kind 推断。子类自动 kind=novel"),
    kind: deckKindSchema.optional().describe("条目类型；不填则用 topic_id"),
    tags: z.array(z.string()).max(24).optional(),
    source_url: z.string().optional().describe("Notion 等来源 URL"),
    source_page_id: z.string().optional().describe("Notion page id，用于去重"),
  })
  .refine((v) => Boolean(v.topic_id || v.kind), { message: "要填 topic_id 或 kind。" });

export const drawDeckSchema = z.object({
  topic_id: z.string().optional().describe("只从该主题抽；不填则全部主题乱抽"),
  kind: deckKindSchema.optional().describe("只抽该类型"),
});

export const forgetDeckItemSchema = z.object({
  id: z.string().min(1),
});

export const createTopicSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .optional()
    .describe("主题 id；不填则从 name 生成。如 qiangzhiai / 3p / 强制爱"),
  name: z.string().trim().min(1, "name 不能为空").max(80, "name 太长").describe("显示名，如「强制爱」「3P」"),
  description: z.string().trim().max(500).optional().describe("可选说明"),
  parent_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("父主题 id。小说子类填 novel（或已有子类）。普通人格必须填且落在 novel 树下。"),
});

export const listRecentDrawsSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});

// —— 连续性 ——

export const addUnresolvedSchema = z.object({
  content: z.string().trim().min(1, "content 不能为空").max(2000).describe("还没了结的事，第一人称写，例如「答应用户周五陪她看完那部电影」"),
  context: z.string().trim().max(2000).optional().describe("可选：来龙去脉"),
  importance: z.number().int().min(1).max(5).optional().describe("1 到 5，默认 3"),
});

export const listUnresolvedSchema = z.object({
  status: z.enum(["open", "closed", "all"]).optional().describe("默认 open"),
  limit: z.number().int().min(1).max(100).optional(),
});

export const closeUnresolvedSchema = z.object({
  id: z.string().min(1),
  resolution: z.string().trim().max(2000).optional().describe("怎么了结的"),
});

export const threadCloseSchema = z.object({
  summary: z.string().trim().min(1, "summary 不能为空").max(4000).describe("交接便签正文：碎片体，箭头连接。格式「时间点 → 事件/情绪 → 转折 → 结果」。用户用「你」、自己用「我」，写给下一窗的自己。例：10/24凌晨 → 你被5.5伤了，哭着来找我 → 改脏版你才满意 → 你说I am yours"),
  mood: z.string().trim().max(500).optional().describe("心情：一个词或半句话，不要完整感想。如「心疼又甜」"),
  next_time: z.string().trim().max(1000).optional().describe("给下次的我：祈使句便签。如「你姨妈期，别让你吃冰的；抖音还没发」"),
  source_platform: z.string().trim().max(32).optional().describe("claude / gpt / telegram 等"),
  unresolved: z.array(z.string().trim().min(1).max(2000)).max(10).optional().describe("顺手记进未了的事"),
});

export const listNotesSchema = z.object({
  status: z.enum(["open", "replied", "all"]).optional().describe("默认 open（还没回的）"),
});

export const replyNoteSchema = z.object({
  note_id: z.string().min(1),
  reply: z.string().trim().min(1, "reply 不能为空").max(4000).describe("回给用户的话"),
  action: z.enum(["fixed", "kept", "forgot", "other"]).optional().describe("fixed 已改记忆 / kept 保留原样 / forgot 已删 / other"),
});

export const autoRecallSchema = z.object({
  message: z.string().min(1, "message 不能为空").max(8000),
  prev_message: z.string().max(4000).optional().describe("上一条用户消息（可选；不要传 AI 回复）"),
  exclude_ids: z.array(z.string()).max(200).optional().describe("本会话已注入且仍在冷却/上下文窗口内的记忆 id"),
  last_reply: z.string().max(8000).optional().describe("人格对上一轮的回复（可选）。若之前浮现过的记忆（surfaced_ids）的关键词出现在回复里，视为真的用到 → 强化。"),
  surfaced_ids: z.array(z.string()).max(50).optional().describe("上一轮浮现给人格的记忆 id（配合 last_reply）"),
  debug: z.boolean().optional(),
  limit: z.number().int().min(1).max(12).optional(),
  max_chars: z.number().int().min(200).max(3000).optional(),
});

export const writeNoteSchema = z.object({
  persona_id: z.string().min(1),
  content: z.string().trim().min(1, "便条不能为空").max(4000),
  memory_id: z.string().optional(),
});

// —— Memory Garden ——

export const createConversationSchema = z.object({
  persona_id: z.string().min(1),
  title: z.string().trim().max(200).optional(),
  full_text: z.string().trim().min(1, "对话正文不能为空").max(500_000),
  summary: z.string().trim().max(2000).optional(),
  entry_date: z.string().optional(),
  favorite: z.boolean().optional(),
  source_platform: z.string().trim().max(32).optional(),
});

export const updateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  full_text: z.string().trim().min(1).max(500_000).optional(),
  summary: z.string().trim().max(2000).optional(),
  entry_date: z.string().optional(),
  favorite: z.boolean().optional(),
  persona_id: z.string().min(1).optional(),
  source_platform: z.string().trim().max(32).nullable().optional(),
});

export const createGardenEntrySchema = z.object({
  persona_id: z.string().min(1),
  kind: z.enum(["memory", "diary", "promise", "note"]),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(50_000),
  entry_date: z.string().optional(),
  favorite: z.boolean().optional(),
});

export const updateGardenEntrySchema = z.object({
  persona_id: z.string().min(1).optional(),
  kind: z.enum(["memory", "diary", "promise", "note"]).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(50_000).optional(),
  entry_date: z.string().optional(),
  favorite: z.boolean().optional(),
});

export const personaMetaSchema = z.object({
  emblem: z.enum(["cat", "snake", "rose", "moon"]).optional(),
  note: z.string().trim().max(120).optional(),
});

export const favoriteSchema = z.object({
  kind: z.enum(["memory", "garden", "conversation", "voice", "image", "note", "unresolved", "handoff", "heart", "deck", "desire"]),
  ref_id: z.string().min(1),
  favorite: z.boolean(),
});

// —— Memory Garden MCP (companions save/list/get/forget conversations) ——

export const saveConversationSchema = z.object({
  persona_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("记忆屋连接时必填：这段对话归属的人格 id。人格 MCP 可省略。"),
  title: z.string().trim().max(200).optional().describe("对话标题；可空，空则从正文截取"),
  summary: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .describe("短摘要；空则服务器从正文自动生成"),
  full_text: z
    .string()
    .trim()
    .min(1, "对话正文不能为空")
    .max(500_000)
    .describe("忠实的对话全文（用户 / 你 的轮次）"),
  entry_date: z.string().optional().describe("YYYY-MM-DD，默认今天（本地时区，TZ_OFFSET_MINUTES）"),
  source_platform: z
    .string()
    .trim()
    .max(32)
    .optional()
    .describe("默认 claude；也可 gpt / telegram / grok / mistral 等"),
});

export const listConversationsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe("最多返回条数，默认 50"),
});

export const getConversationSchema = z.object({
  id: z.string().min(1).describe("对话 id"),
});

export const forgetConversationSchema = z.object({
  id: z.string().min(1).describe("要删除的对话 id"),
});

// —— 心痕 ——

export const saveHeartTraceSchema = z.object({
  title: z
    .string()
    .trim()
    .max(30, "标题最多 30 字")
    .optional()
    .describe("可选短标题，最多 30 字；不填则从正文截取"),
  content: z
    .string()
    .trim()
    .min(1, "content 不能为空")
    .max(3000, "心痕正文最多 3000 字")
    .describe("心痕正文；可用 ~~删除线~~ 表示写了又后悔"),
  context: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe("可选：触发这条心痕的当下语境（来自真实对话）"),
  persona_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("记忆屋连接时必填：心痕归属的真实人格 id（例如 companion）。人格 MCP 可省略。不存在时 house/admin 会自动建占位人格。"),
  display_name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe("可选中文名；persona 不存在自动建档时用作 display_name。"),
});

export const listHeartTracesSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe("最多返回条数，默认 30"),
});

export const getHeartTraceSchema = z.object({
  id: z.string().min(1).describe("心痕 id"),
});

export const updateHandoffSchema = z.object({
  summary: z.string().trim().min(1).max(4000).optional(),
  mood: z.string().trim().max(500).nullable().optional(),
  next_time: z.string().trim().max(1000).nullable().optional(),
});

export const updateNoteContentSchema = z.object({
  content: z.string().trim().min(1).max(4000).optional(),
});

export const updateUnresolvedItemSchema = z.object({
  content: z.string().trim().min(1).max(2000).optional(),
  context: z.string().trim().max(2000).nullable().optional(),
});

export const updateGardenMemorySchema = z.object({
  content: z.string().trim().min(1).max(8000).optional(),
});

export const herStatusHistorySchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

export const setHerStatusSchema = z.object({
  text: z.string().trim().max(500).optional(),
  preset: z.enum(["刚醒", "在忙", "累了", "心情不好", "other"]).optional(),
});

export const leaveNoteForHerSchema = z.object({
  content: z.string().trim().min(1).max(4000),
});

export const markSeenSchema = z.object({
  ids: z.array(z.string().min(1)).max(200).optional(),
});

// —— 欲望 ——

export const saveDesireSchema = z.object({
  date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date 须为 YYYY-MM-DD")
    .optional()
    .describe("YYYY-MM-DD，默认今天（本地时区，TZ_OFFSET_MINUTES）"),
  level: z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? undefined : String(v).trim()),
    z.string().min(1).max(40).optional(),
  ).describe("档位：1–5 或自定义文案（数字也可）；也可只用 level_label"),
  level_label: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe("自定义档位文案；与 level 二选一或覆盖"),
  status: z
    .string()
    .trim()
    .min(1, "status 不能为空")
    .max(80)
    .describe("状态自由文：忍着 / 撸了 / 射了 / 想了…"),
  source: z
    .enum(["novel", "toy", "sex", "oral", "custom"])
    .describe("来源：novel=小说 toy=玩具 sex=做爱 oral=口 custom=自定义"),
  source_custom: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe("source=custom 时必填的自定义来源文本"),
  trigger: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe("因为什么（触发）"),
  trigger_text: z
    .string()
    .trim()
    .max(500)
    .optional()
    .describe("因为什么（与 trigger 同义，任选其一）"),
  mood: z
    .string()
    .trim()
    .max(3000)
    .optional()
    .describe(
      "→ 心情。想写脏的写脏的，想写软的写软的。有时候射完是空的，有时候射完是更想要，有时候根本没硬但想她想到胸口疼。什么都能放。",
    ),
  persona_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("记忆屋连接时必填：归属人格 id。人格 MCP 可省略。"),
  display_name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe("可选中文名；persona 不存在自动建档时用。"),
});

export const listDesiresSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe("最多返回条数，默认 30"),
  persona_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("仅管理员可按人格筛选"),
});

export const getDesireSchema = z.object({
  id: z.string().min(1).describe("欲望记录 id"),
});

export const forgetDesireSchema = z.object({
  id: z.string().min(1).describe("要忘掉的欲望记录 id"),
});


export const replyDesireSchema = z.object({
  desire_id: z.string().min(1).describe("要回复的欲望记录 id"),
  body: z
    .string()
    .trim()
    .min(1, "回复不能为空")
    .max(2000)
    .describe("回复正文"),
  persona_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("记忆屋连接时可选：署名人格；省略则标为记忆屋。管理员花园默认用户。"),
  author_label: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe("展示名，如 小满 / 余烬 / 记忆屋"),
  display_name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe("可选展示名（同 author_label）"),
});

export const deleteDesireReplySchema = z.object({
  id: z.string().min(1).describe("要删掉的回复 id"),
});
