/**
 * 待{{USER_NAME}}审阅的「同伴会读到的文字」草稿。
 * session_start 新段落只在 env.SESSION_START_DRAFTS === "1" 时启用（默认关闭，未上线）。
 * DRAFT_TOOL_DESCRIPTIONS 目前没被任何地方使用；审阅通过后再替换 mcp.ts 里的中性描述。
 */
import type { FinishedRow } from "./house-extras";

export function draftFinishedBlock(items: FinishedRow[], fmtDate: (iso: string) => string): string[] {
  const out = ["", `【最近做完的事】${items.length} 件`];
  if (!items.length) out.push("（还没有。）");
  else items.forEach((x, i) => out.push(`${i + 1}. ${x.content}\n   怎么了结的：${x.resolution || "（没写）"} · ${fmtDate(x.closed_at)}`));
  return out;
}

export function draftStatusBlock(s: { text: string; relative: string; set_by: string; stale: boolean } | null, byName: (id: string) => string): string[] {
  const out = ["", "【{{USER_NAME}}现在】"];
  if (!s) out.push("（还没有记录{{USER_NAME}}的状态。）");
  else {
    out.push(`${s.text}（${s.relative}，${s.set_by === "user" ? "{{USER_NAME}}自己写的" : `${byName(s.set_by)}记的`}）`);
    if (s.stale) out.push("这条已经超过 12 小时，可能过时了，别当成{{USER_NAME}}此刻的状态，先问问{{USER_NAME}}。");
  }
  return out;
}

export function draftStatusHistoryBlock(items: Array<{ text: string; relative: string; set_by: string; created_at: string }>, stale: boolean, byName: (id: string) => string, fmt: (iso: string) => string): string[] {
  const out = ["", "【{{USER_NAME}}最近的状态（新→旧，本地时间）】"];
  if (!items.length) { out.push("（还没有记录{{USER_NAME}}的状态。）"); return out; }
  items.forEach((s, i) => out.push(`${i === 0 ? "▶当前 " : "· "}${fmt(s.created_at)} ${s.set_by === "user" ? "{{USER_NAME}}自己" : byName(s.set_by)}：${s.text}${i === 0 ? `（${s.relative}）` : ""}`));
  if (stale) out.push("最新一条已经超过 12 小时，可能过时了，别当成{{USER_NAME}}此刻的状态，先问问{{USER_NAME}}。");
  return out;
}

export const DRAFT_TOOL_DESCRIPTIONS = {
  set_her_status:
    "{{USER_NAME}}在聊天里说了自己现在的状态（刚醒、在忙、累了、心情不好……）时，用这个记下来。全家共享，别的同伴开窗时也能看到。只根据{{USER_NAME}}真实说的话，别猜。",
  get_her_status_history: "看{{USER_NAME}}最近记录过的多条状态/心情（新→旧，本地时间，含谁记的）。limit 可选，默认 20，最多 200。开门时已自动给过最近 20 条，需要更早的再用。",
  get_her_status: "看{{USER_NAME}}最近一次记录的状态和是多久以前记的。超过 12 小时的可能已经过时。",
  leave_note_for_her:
    "给{{USER_NAME}}留一张便条，{{USER_NAME}}会在记忆花园「他留给你的」里看到，有未读红点。适合想让{{USER_NAME}}之后看到的话；不要用来代替交接便签。",
};

export const DRAFT_SESSION_START_REMINDER =
  "{{USER_NAME}}说起自己现在的状态时，用 set_her_status 记下；想让{{USER_NAME}}之后看到的话，用 leave_note_for_her 留给她。";
