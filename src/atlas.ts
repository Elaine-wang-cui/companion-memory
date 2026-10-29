/** 记忆星图：只读。不调用 reinforce / 不写库；强度用 strengthNow 纯计算。 */
import { sha256Hex, timingSafeEqual, extractKey } from "./auth";
import { strengthNow, stateOf, isPinned } from "./forgetting";
import type { Env, MemoryDb } from "./types";
import { allLinks } from "./links";
import { gardenItems, allGardenLinks, GARDEN_ATLAS_ENABLED, TYPE_LABEL } from "./garden-links";
import { cognitionMaps, COGNITION_ENABLED } from "./cognition";

export async function atlasAuthorized(env: Env, request: Request): Promise<boolean> {
  const key = extractKey(request);
  if (!key) return false;
  const h = await sha256Hex(key);
  for (const s of [(env as { ATLAS_KEY?: string }).ATLAS_KEY, env.ADMIN_KEY]) {
    const t = s?.trim();
    if (t && timingSafeEqual(h, await sha256Hex(t))) return true;
  }
  return false;
}

export async function atlasData(db: MemoryDb) {
  const now = Date.now();
  const res = await db
    .prepare(`SELECT m.id, m.owner_persona, m.kind, m.importance, m.tags, m.content, m.created_at, m.strength, m.emotion, m.half_life_days, m.last_recalled_at, m.recall_count, m.state, m.faded_text, m.last_surfaced_at, p.display_name FROM memories m LEFT JOIN personas p ON p.id = m.owner_persona ORDER BY m.created_at ASC`)
    .all<Record<string, unknown>>();
  const rows = (res.results ?? []) as any[];
  const stars = rows.map((r) => {
    let tags: string[] = [];
    try { const t = JSON.parse(r.tags || "[]"); if (Array.isArray(t)) tags = t.map(String); } catch { tags = String(r.tags || "").split(/[,，\s]+/).filter(Boolean); }
    return {
      id: r.id, persona: r.owner_persona, persona_name: r.display_name || r.owner_persona, kind: r.kind,
      importance: r.importance, tags, content: r.content, created_at: r.created_at,
      last_recalled_at: r.last_recalled_at, recall_count: Number(r.recall_count) || 0,
      emotion: r.emotion, half_life_days: r.half_life_days,
      strength: Math.round(strengthNow(r, now) * 1000) / 1000, state: stateOf(r, now), pinned: isPinned(r),
      last_surfaced_at: r.last_surfaced_at,
    };
  });
  const c = (f: (s: (typeof stars)[number]) => boolean) => stars.filter(f).length;
  const ids = new Set(stars.map((s) => s.id));
  const links = (await allLinks(db)).filter((l) => ids.has(l.a) && ids.has(l.b));
  let items: { id: string; type: string; persona: string; title: string; content: string; created_at: string; extra?: string }[] = [];
  if (GARDEN_ATLAS_ENABLED) {
    try {
      items = (await gardenItems(db)).map((i) => ({ id: i.key, type: i.type, persona: i.persona, title: i.title, content: i.text.slice(0, 300), created_at: i.date, extra: i.extra }));
      const iids = new Set(items.map((i) => i.id));
      const strip = (k: string) => (k.startsWith("memory:") ? k.slice(7) : k);
      for (const l of await allGardenLinks(db)) {
        const a = strip(l.a), b = strip(l.b);
        if ((ids.has(a) || iids.has(a)) && (ids.has(b) || iids.has(b))) links.push({ a, b, w: l.w, k: l.k });
      }
    } catch { items = []; }
  }
  // 认知星：自己的颜色（kind = cognition），和源记忆 / 花园内容连线
  let cogN = 0;
  if (COGNITION_ENABLED) {
    try {
      const { srcOf } = await cognitionMaps(db);
      const iids = new Set(items.map((i) => i.id));
      const have = new Set(links.map((l) => (l.a < l.b ? l.a + "|" + l.b : l.b + "|" + l.a)));
      for (const st of stars as any[]) {
        const src = srcOf.get(st.id); if (!src) continue;
        st.kind = "cognition"; st.cognition = true; cogN++;
        for (const k of src) {
          const o = k.startsWith("memory:") ? k.slice(7) : k;
          if (!ids.has(o) && !iids.has(o)) continue;
          const key = st.id < o ? st.id + "|" + o : o + "|" + st.id;
          if (have.has(key)) { for (const l of links) if ((l.a === st.id && l.b === o) || (l.b === st.id && l.a === o)) l.k = "cognition"; continue; }
          have.add(key); links.push({ a: st.id, b: o, w: 0.9, k: "cognition" });
        }
      }
    } catch (e) { console.error("[atlas] cognition", e); }
  }
  const personas = ((await db.prepare(`SELECT id, display_name, relationship_to_user, self_card FROM personas`).all<Record<string, string>>()).results ?? [])
    .filter((p) => stars.some((s) => s.persona === p.id) || items.some((i) => i.persona === p.id))
    .map((p) => ({ id: p.id, name: p.display_name, core: (p.self_card || "").slice(0, 600) }));
  const out = {
    generated_at: new Date(now).toISOString(),
    counts: { total: stars.length, pinned: c((s) => s.pinned), clear: c((s) => s.state === "clear"), faded: c((s) => s.state === "faded"), trace: c((s) => s.state === "trace"), recalled: c((s) => s.recall_count > 0), links: 0, items: 0, cognitions: cogN },
    stars,
    items,
    types: TYPE_LABEL,
    links,
    personas,
  };
  out.counts.links = links.length;
  out.counts.items = items.length;
  return out;
}
