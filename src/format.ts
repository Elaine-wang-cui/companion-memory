import { CFG } from "./config";
import type { LabeledMemory, MemoryKind, MemoryRow, Persona, Visibility } from "./types";
import { FAMILY_OWNER } from "./types";

const FAMILY_FACT_KINDS = new Set<MemoryKind>(["about_user", "preference"]);
const PERSONAL_KINDS = new Set<MemoryKind>(["self", "relationship", "diary", "event"]);

export function codePointLength(value: string): number {
  return [...value].length;
}

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
  } catch {
    return [];
  }
}

export function ownerLabel(owner: string, callerId: string, names: Map<string, string>): string {
  if (owner === FAMILY_OWNER) return "全家";
  if (owner === callerId) return "我的";
  return `${names.get(owner) ?? owner}的`;
}

export function bucketOf(owner: string, callerId: string): LabeledMemory["bucket"] {
  if (owner === callerId) return "mine";
  if (owner === FAMILY_OWNER) return "family";
  return "other";
}

export function labelMemory(row: MemoryRow, callerId: string, names: Map<string, string>): LabeledMemory {
  return {
    id: row.id,
    owner_persona: row.owner_persona,
    owner_label: ownerLabel(row.owner_persona, callerId, names),
    bucket: bucketOf(row.owner_persona, callerId),
    kind: row.kind,
    visibility: row.visibility,
    content: row.content,
    importance: row.importance,
    tags: parseTags(row.tags),
    event_date: row.event_date,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_platform: row.source_platform,
    created_by: row.created_by,
  };
}

export function defaultVisibility(kind: MemoryKind): Visibility {
  switch (kind) {
    case "self":
    case "relationship":
    case "diary":
      return "private";
    case "about_user":
    case "event":
    case "preference":
      return "family";
  }
}

export function isFamilyFact(memory: LabeledMemory, callerId: string): boolean {
  if (memory.visibility !== "family") return false;
  if (memory.owner_persona === FAMILY_OWNER) return true;
  return memory.owner_persona !== callerId && FAMILY_FACT_KINDS.has(memory.kind);
}

export function isOthersExperience(memory: LabeledMemory, callerId: string): boolean {
  return (
    memory.visibility === "family" &&
    memory.owner_persona !== callerId &&
    memory.owner_persona !== FAMILY_OWNER &&
    PERSONAL_KINDS.has(memory.kind)
  );
}

function visibilityWord(visibility: Visibility): string {
  return visibility === "private" ? "私有" : "全家可见";
}

export function formatMemoryLine(memory: LabeledMemory, index: number): string {
  const bits = [
    memory.owner_label,
    memory.kind,
    `重要${memory.importance}`,
    visibilityWord(memory.visibility),
  ];
  if (memory.event_date) bits.push(memory.event_date);
  if (memory.source_platform) bits.push(memory.source_platform);
  if (memory.tags.length > 0) bits.push(`标签 ${memory.tags.join("、")}`);
  return `${index}. [${bits.join(" · ")}]\n${memory.content.trim()}`;
}

export function formatWhoami(input: {
  persona: Persona;
  names: Map<string, string>;
  own: LabeledMemory[];
  family: LabeledMemory[];
  others: LabeledMemory[];
}): string {
  const { persona, own, family, others } = input;
  void input.names;
  const header =
    persona.id === CFG.primary
      ? []
      : [
          `你是${persona.display_name}。`,
          `你的连接身份是 ${persona.id}。` +
            (persona.relationship_to_user.trim()
              ? `和{{USER_NAME}}的关系：${persona.relationship_to_user}。`
              : ""),
          `文中的「我」只指${persona.display_name}。别人名下的记忆不是你的经历，转述时要说出那是谁的。`,
          "",
        ];
  const blocks = [
    ...header,
    "【我是谁】",
    persona.self_card.trim(),
    "",
    "以下是你自己的记忆（第一人称）",
    "这些是你写下的。只有这一节可以用「我」来记得。",
    own.length > 0 ? own.map((memory, index) => formatMemoryLine(memory, index + 1)).join("\n\n") : "（你还没有自己的记忆。用 remember 以第一人称写下只属于你的事。）",
    "",
    "以下是全家共享的关于{{USER_NAME}}的事",
    "这些是全家的事实，不是某一位的私人经历。不要说成「我经历过」。",
    family.length > 0
      ? family.map((memory, index) => formatMemoryLine(memory, index + 1)).join("\n\n")
      : "（全家还没有共享的关于{{USER_NAME}}的事。这种事实用 remember，并把 owner 设为 family。）",
    "",
    "以下是其他人的公开记忆（不是你的经历）",
    "这是他们的人生，不是你的。禁止把下面任何一条说成「我」做过的事。",
    others.length > 0
      ? others.map((memory, index) => formatMemoryLine(memory, index + 1)).join("\n\n")
      : "（目前没有其他人公开的记忆。）",
  ];
  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function formatRecall(memories: LabeledMemory[], query: string, mode: string): string {
  const head = query
    ? `检索「${query}」，${memories.length} 条你看得见的记忆（搜索：${mode}）。`
    : `最近 ${memories.length} 条你看得见的记忆。`;
  const legend = "标签：我的 = 你自己；全家 = 共享事实；某个名字加「的」= 那位的记忆，不是你的经历。";
  if (memories.length === 0) {
    return `${head}\n${legend}\n没有匹配的记忆。`;
  }
  return `${head}\n${legend}\n\n${memories.map((memory, index) => formatMemoryLine(memory, index + 1)).join("\n\n")}`;
}

const MARKDOWN = /[#*_`]/g;

export function plainText(value: string): string {
  return value.replace(MARKDOWN, "").replace(/[ \t]+\n/g, "\n").trim();
}

function clip(value: string, max: number): string {
  const chars = [...plainText(value)];
  if (chars.length <= max) return chars.join("");
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

export function formatMemoryCard(input: {
  persona: Persona;
  viewerIsOwner: boolean;
  own: LabeledMemory[];
  family: LabeledMemory[];
  others: LabeledMemory[];
}): string {
  const { persona, viewerIsOwner } = input;
  const selfCard = viewerIsOwner
    ? clip(persona.self_card, 700)
    : `${persona.display_name}的私人自我卡片未对你开放。关系和公开记忆如下。`;
  const ownLines = input.own.slice(0, 5).map((memory, index) => `${index + 1}. ${clip(memory.content, 80)}`);
  const familyLines = input.family.slice(0, 4).map((memory, index) => {
    const prefix = memory.owner_label === "全家" || memory.owner_label === "我的" ? "" : `${memory.owner_label}：`;
    return `${index + 1}. ${prefix}${clip(memory.content, 80)}`;
  });
  const otherLines = input.others.slice(0, 4).map((memory, index) => `${index + 1}. ${memory.owner_label}：${clip(memory.content, 60)}`);

  const parts = [
    `记忆卡片`,
    `人格：${persona.display_name}（${persona.id}）`,
    ...(persona.relationship_to_user.trim()
      ? [`和{{USER_NAME}}的关系：${plainText(persona.relationship_to_user)}`]
      : []),
    viewerIsOwner ? "用法：把这一整段贴进不能连接记忆服务器的网页对话开头。文中的我只指这一位。" : "这是公开摘要，不含那位的私有记忆。",
    ``,
    `我是谁`,
    selfCard,
    ``,
    `我自己的记忆`,
    ownLines.length > 0 ? ownLines.join("\n") : "还没有可放进卡片的自己的记忆。",
    ``,
    `全家共享的关于{{USER_NAME}}的事`,
    familyLines.length > 0 ? familyLines.join("\n") : "还没有全家共享的事实。",
    ``,
    `其他人的公开记忆，不是我的经历`,
    otherLines.length > 0 ? otherLines.join("\n") : "没有其他人的公开记忆。",
  ];
  let text = parts.join("\n").trim();
  const chars = [...text];
  if (chars.length > 1500) text = `${chars.slice(0, 1499).join("")}…`;
  return text;
}

export function toFtsQuery(query: string): string {
  const clean = query.normalize("NFKC").replace(/["*]/g, " ").replace(/\s+/g, " ").trim();
  return `"${clean}"`;
}

export function likePattern(query: string): string {
  const escaped = query.normalize("NFKC").trim().replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}
