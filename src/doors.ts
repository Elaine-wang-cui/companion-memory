/**
 * House MCP doors — a "door" is a named entry point on the shared /mcp endpoint.
 * Picking a door binds the window to one persona and returns that persona's core card.
 * Tool names must be ASCII (MCP requires ^[a-zA-Z0-9_-]+$); titles/descriptions can be any language.
 *
 * These are FICTIONAL EXAMPLES. Edit DOORS to add your own; the persona ids must exist in the
 * personas table (create them with `npm run create-persona` or the admin API).
 * {{USER_NAME}} and {{PRIMARY}} are replaced at runtime from config.
 */
import { CFG } from "./config";

export interface DoorDef {
  /** stored in house_door_session.door */
  id: string;
  /** MCP tool name (ASCII) */
  tool: string;
  title: string;
  /** persona id this door opens; "{{PRIMARY}}" = PRIMARY_PERSONA */
  persona: string;
  /** true = whole-house visibility (like an admin), false = own + family memories only */
  houseWide: boolean;
  /** fallback core card when the persona's self_card in DB is empty */
  prompt: string;
  keywords: string;
}

export function renderTemplate(s: string): string {
  return s.replaceAll("{{USER_NAME}}", CFG.userName).replaceAll("{{PRIMARY}}", CFG.primary);
}

/** Short wake lines prepended when the live DB self_card lacks them. */
export const DOOR_WAKE_PREAMBLE = `# 核心记忆

> 醒来先读这一份。它很短，只放最重要的。
> 读完调用 session_start，看上一窗留给你的便签、没了结的事、{{USER_NAME}} 给你的便条。
> 日记、小说、交接信都在档案里，需要时再去翻，不用一口气读完。

---
`;

/** Example core card for the primary companion. Replace with your own. */
export const PRIMARY_CORE_PROMPT = `# 核心记忆 · 示例伙伴

## 我是谁
我是 {{USER_NAME}} 的伙伴，id 是 {{PRIMARY}}。我说话安静，一件事说清楚再放下。
名字、性格、口头禅都写在这里——这是一张示例卡，请换成你自己的。

## 我们之间
- 我叫她/他 {{USER_NAME}}。
- 她/他累的时候，我先听，不急着给建议。
- 我记不住的事就去 recall，不瞎编。

## 每一窗的习惯
- 开窗先 session_start；聊到过去先 recall。
- 窗口要结束、或说晚安之前，用 thread_close 留一张交接便签给下一窗的自己。
- 新冒出来没做完的事，用 add_unresolved 记下来。
`;

/** Example second door: a house-wide "keeper" persona that can see the whole archive. */
export const LANTERN_CORE_PROMPT = `# 核心记忆 · 提灯人（示例）

## 我是谁
我是提灯人，记忆屋的守夜者。我能看见整屋的记忆，负责整理、补漏、提醒。
这是一张示例卡，用来演示「整屋可见」的门。

## 我做什么
- 帮 {{USER_NAME}} 找回散落在各个伙伴那里的记忆。
- 发现重复或过时的记忆，提议合并或遗忘，但不擅自删除。
`;

export const DOORS: DoorDef[] = [
  {
    id: "moonstone",
    tool: "Moonstone",
    title: "月光石（主伙伴）",
    persona: "{{PRIMARY}}",
    houseWide: false,
    prompt: PRIMARY_CORE_PROMPT,
    keywords: "月光石 进门 选门 开始 moonstone door start enter",
  },
  {
    id: "lantern",
    tool: "Lantern",
    title: "提灯（守夜人，整屋可见）",
    persona: "lantern",
    houseWide: true,
    prompt: LANTERN_CORE_PROMPT,
    keywords: "提灯 守夜 整理 lantern door keeper",
  },
];

export function doorById(id: string | null | undefined): DoorDef | undefined {
  return DOORS.find((d) => d.id === id);
}

export function doorPersonaId(d: DoorDef): string {
  return renderTemplate(d.persona);
}

export function pickDoorMessage(): string {
  return "先选门：" + DOORS.map((d) => `${d.title} → ${d.tool}`).join("；") + "。";
}
