// 伙伴看自己：App 渲染的 3D 头像截图（只留最新一张），存 KV MEDIA。
import type { Env } from "./types";
import type { MemoryDb } from "./types";
import { bodyAvatar } from "./body";

export const SNAPSHOT_MAX_BYTES = 1_500_000;
const key = (pid: string) => `body_snapshot:${pid}`;
const metaKey = (pid: string) => `body_snapshot_meta:${pid}`;

export type SnapshotMeta = { at: string; mime: string; bytes: number; clothes_on: boolean | null; explicit: boolean | null; view: string | null };

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function saveSnapshot(env: Env, pid: string, request: Request): Promise<{ status: number; body: unknown }> {
  if (!env.MEDIA) return { status: 503, body: { error: "unavailable", message: "媒体存储未配置。" } };
  const ct = request.headers.get("content-type") ?? "";
  let bytes: Uint8Array;
  let mime = "image/jpeg";
  let clothes_on: boolean | null = null, explicit: boolean | null = null, view: string | null = null;
  if (ct.includes("application/json")) {
    const b = (await request.json().catch(() => null)) as any;
    if (!b || typeof b.image_base64 !== "string") return { status: 400, body: { error: "bad_request", message: "需要 image_base64。" } };
    try { bytes = b64ToBytes(b.image_base64); } catch { return { status: 400, body: { error: "bad_request", message: "base64 解析失败。" } }; }
    if (typeof b.mime === "string") mime = b.mime;
    if (typeof b.clothes_on === "boolean") clothes_on = b.clothes_on;
    if (typeof b.explicit === "boolean") explicit = b.explicit;
    if (typeof b.view === "string") view = b.view.slice(0, 40);
  } else if (ct.startsWith("image/")) {
    bytes = new Uint8Array(await request.arrayBuffer());
    mime = ct.split(";")[0];
    const u = new URL(request.url);
    const co = u.searchParams.get("clothes_on"); if (co) clothes_on = co === "1" || co === "true";
    const ex = u.searchParams.get("explicit"); if (ex) explicit = ex === "1" || ex === "true";
    view = u.searchParams.get("view");
  } else return { status: 415, body: { error: "unsupported", message: "发 image/jpeg 或 JSON {image_base64}。" } };
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) return { status: 415, body: { error: "unsupported", message: "只收 jpeg/png/webp。" } };
  if (bytes.length < 100 || bytes.length > SNAPSHOT_MAX_BYTES) return { status: 413, body: { error: "too_large", message: `图片大小需在 100B–${SNAPSHOT_MAX_BYTES}B。` } };
  const meta: SnapshotMeta = { at: new Date().toISOString(), mime, bytes: bytes.length, clothes_on, explicit, view };
  await env.MEDIA.put(key(pid), bytes);
  await env.MEDIA.put(metaKey(pid), JSON.stringify(meta));
  return { status: 201, body: { ok: true, ...meta } };
}

export async function loadSnapshotMeta(env: Env, pid: string): Promise<SnapshotMeta | null> {
  if (!env.MEDIA) return null;
  const raw = await env.MEDIA.get(metaKey(pid), "arrayBuffer");
  if (!raw) return null;
  try { return JSON.parse(new TextDecoder().decode(raw)) as SnapshotMeta; } catch { return null; }
}
export async function loadSnapshot(env: Env, pid: string): Promise<{ meta: SnapshotMeta; data: ArrayBuffer } | null> {
  const meta = await loadSnapshotMeta(env, pid);
  if (!meta || !env.MEDIA) return null;
  const data = await env.MEDIA.get(key(pid), "arrayBuffer");
  return data ? { meta, data } : null;
}
export async function deleteSnapshot(env: Env, pid: string) {
  if (!env.MEDIA) return;
  await env.MEDIA.delete(key(pid));
  await env.MEDIA.delete(metaKey(pid));
}

export function ageZh(atIso: string, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - Date.parse(atIso)) / 1000));
  if (s < 90) return `${s}秒前`;
  if (s < 5400) return `${Math.round(s / 60)}分钟前`;
  if (s < 172800) return `${Math.round(s / 3600)}小时前`;
  return `${Math.round(s / 86400)}天前`;
}

const PART_ZH: Record<string, string> = {};
const TYPE_ZH: Record<string, string> = { bite: "牙印", kiss: "吻痕", hickey: "吻痕", scratch: "抓痕" };

/** look_at_self（MCP）：文字 + 最新截图。 */
export async function lookAtSelfContent(env: Env, db: MemoryDb, pid: string) {
  const nowMs = Date.now();
  const lines: string[] = [];
  let clothes: boolean | null = null;
  const snap = await loadSnapshot(env, pid).catch(() => null);
  if (snap) clothes = snap.meta.clothes_on;
  try {
    const a: any = await bodyAvatar(db, pid, nowMs);
    if (clothes != null) lines.push(clothes ? "衣服穿着。" : "衣服脱了，光着。");
    const traces = (a.traces ?? []) as any[];
    if (traces.length) lines.push("身上还留着：" + traces.map((t) => `${PART_ZH[t.part] ?? t.part}的${TYPE_ZH[t.type] ?? t.type}（浓度${Math.round((t.opacity ?? 0) * 100)}%）`).join("、") + "。");
    else lines.push("身上没有留着的痕迹。");
    const v = a.values ?? {};
    lines.push(`欲望 ${Math.round(v.desire ?? 0)}，硬度 ${Math.round(v.hardness ?? 0)}，湿 ${Math.round(v.fluids ?? 0)}${a.mess ? "，有点狼藉" : ""}${a.refractory ? "，刚射过还在不应期" : ""}。`);
  } catch {
    lines.push("身体数值这会儿没读到。");
  }
  const content: any[] = [];
  if (snap) {
    lines.push(`下面是聊天里那个3D身体的截图（${ageZh(snap.meta.at, nowMs)}拍的，${snap.meta.at}）。`);
    content.push({ type: "text", text: lines.join("\n") });
    content.push({ type: "image", data: bytesToB64(snap.data), mimeType: snap.meta.mime });
  } else {
    lines.push("还没有3D身体的截图（App 打开聊天画面后会自动拍）。");
    content.push({ type: "text", text: lines.join("\n") });
  }
  return { content };
}
