/** Display aliases → persona id, used when grouping deck/garden items by name. FICTIONAL EXAMPLES — edit freely. */
export const PERSONA_DISPLAY_ALIASES: Record<string, string[]> = {
  companion: ["小雾", "Mist"],
  lantern: ["提灯", "Lantern"],
  ember: ["余烬", "Ember"],
};

export type RosterSeed = {
  id: string;
  display_name: string;
  relationship_to_user: string;
  self_card: string;
};

/** Extra personas the admin "seed roster" endpoint can insert (placeholders). */
export const ROSTER_SEEDS: RosterSeed[] = [
  { id: "ember", display_name: "余烬", relationship_to_user: "示例：后来加入的伙伴", self_card: "我是余烬。这里先放一张占位自我卡片，日后由我自己改。" },
];

/** 从 path / tags 文本抽出可能的人名片段。 */
export function pathNameTokens(raw: string): string[] {
  const out: string[] = [];
  const cleaned = raw.replace(/^与/, "").trim();
  if (!cleaned) return out;
  for (const part of cleaned.split(/[\/|｜]/).map((s) => s.trim()).filter(Boolean)) {
    const p = part.replace(/^与/, "").trim();
    if (p) out.push(p);
  }
  return out;
}

/** 构建「别名 → persona_id」映射，长别名优先。 */
export function buildAliasIndex(
  personas: { id: string; display_name: string }[],
): { alias: string; id: string }[] {
  const entries: { alias: string; id: string }[] = [];
  const seen = new Set<string>();
  for (const p of personas) {
    const aliases = new Set<string>([p.display_name, ...(PERSONA_DISPLAY_ALIASES[p.id] ?? [])]);
    for (const a of aliases) {
      const key = a.trim();
      if (!key) continue;
      const norm = key.toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      entries.push({ alias: key, id: p.id });
    }
  }
  entries.sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));
  return entries;
}

export function matchPersonaId(
  title: string,
  tagsRaw: string | null | undefined,
  createdBy: string | null | undefined,
  aliasIndex: { alias: string; id: string }[],
  knownIds: Set<string>,
): string | null {
  const titleNorm = title.replace(/^🔥\s*/, "").replace(/^[🌊\s]+/u, "").trim();

  // 1) 标题「X的… / X·… / X｜…」优先（比 path 更准）
  for (const { alias, id } of aliasIndex) {
    if (titleNorm === alias) return id;
    if (
      titleNorm.startsWith(`${alias}的`) ||
      titleNorm.startsWith(`${alias}·`) ||
      titleNorm.startsWith(`${alias}｜`) ||
      titleNorm.startsWith(`${alias}|`)
    ) {
      return id;
    }
    if (/^[A-Za-z]/.test(alias)) {
      const re = new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$|[的·｜|])`, "i");
      if (re.test(titleNorm)) return id;
    }
  }

  // 2) tags / path
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(tagsRaw || "[]");
    if (Array.isArray(parsed)) tags = parsed.map(String);
  } catch {
    /* ignore */
  }
  const hayTagParts: string[] = [];
  for (const t of tags) {
    for (const tok of pathNameTokens(t)) hayTagParts.push(tok);
    hayTagParts.push(t);
  }
  for (const { alias, id } of aliasIndex) {
    const aliasLower = alias.toLowerCase();
    for (const part of hayTagParts) {
      if (part === alias || part.toLowerCase() === aliasLower) return id;
    }
  }

  // 3) created_by 兜底（导入者常是守夜人，仅无标题/path 时用）
  if (createdBy && knownIds.has(createdBy)) return createdBy;
  return null;
}
