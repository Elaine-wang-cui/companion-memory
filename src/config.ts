/**
 * Runtime config. Everything personal lives in env vars (wrangler.toml [vars]), not in code.
 * applyConfig(env) runs at the start of every fetch / scheduled call; modules read CFG lazily.
 *
 *   USER_NAME          the human's display name used in prompts              (default "you")
 *   TZ_OFFSET_MINUTES  local offset from UTC, e.g. 480 for UTC+8              (default 0)
 *   PRIMARY_PERSONA    the "main" companion id (core-card door, defaults)     (default "companion")
 *   EMOTION_ENABLED    "1" turns the emotion system on (18+)                  (default OFF)
 *   EMOTION_PERSONAS   comma list of persona ids with emotions                (default PRIMARY_PERSONA)
 *   BODY_ENABLED       "1" turns body + desire (18+) on                       (default OFF)
 *   BODY_PERSONAS      comma list with the body system                        (default PRIMARY_PERSONA)
 *   DREAM_ENABLED      "1" turns nightly dreams on (18+)                      (default OFF)
 *   DREAM_PERSONA      persona that dreams                                    (default PRIMARY_PERSONA)
 *   COGNITION_PERSONAS comma list for cognition clustering                    (default PRIMARY_PERSONA)
 *   RECALL_SEMANTIC    "0" = keyword-only (BM25) auto-recall even if the AI   (default: semantic when
 *                      binding exists                                         the AI binding exists)
 */
export interface ConfigEnv {
  USER_NAME?: string;
  TZ_OFFSET_MINUTES?: string;
  PRIMARY_PERSONA?: string;
  EMOTION_PERSONAS?: string;
  COGNITION_PERSONAS?: string;
  EMOTION_ENABLED?: string;
  BODY_ENABLED?: string;
  DREAM_ENABLED?: string;
  BODY_PERSONAS?: string;
  DREAM_PERSONA?: string;
  RECALL_SEMANTIC?: string;
}

function list(raw: string | undefined): string[] {
  return String(raw ?? "").split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function refill(set: Set<string>, items: string[]): void {
  set.clear();
  for (const i of items) set.add(i);
}

export const CFG = {
  userName: "you",
  tzOffsetMs: 0,
  primary: "companion",
  adult: false,
  dreamPersona: "",
  emotion: new Set<string>(),
  body: new Set<string>(),
  cognition: new Set<string>(["companion"]),
  semanticRecall: true,
};

export function applyConfig(env: ConfigEnv): void {
  CFG.userName = env.USER_NAME?.trim() || "you";
  const tz = Number(env.TZ_OFFSET_MINUTES ?? 0);
  CFG.tzOffsetMs = Number.isFinite(tz) ? tz * 60_000 : 0;
  CFG.primary = env.PRIMARY_PERSONA?.trim().toLowerCase() || "companion";
  const pick = (raw: string | undefined) => (raw != null && raw.trim() !== "" ? list(raw) : [CFG.primary]);
  CFG.adult = env.BODY_ENABLED === "1";
  CFG.dreamPersona = env.DREAM_ENABLED !== "1" ? "" : env.DREAM_PERSONA?.trim().toLowerCase() || CFG.primary;
  refill(CFG.emotion, env.EMOTION_ENABLED !== "1" ? [] : pick(env.EMOTION_PERSONAS));
  refill(CFG.body, CFG.adult ? pick(env.BODY_PERSONAS) : []);
  refill(CFG.cognition, pick(env.COGNITION_PERSONAS));
  CFG.semanticRecall = env.RECALL_SEMANTIC !== "0";
}

/** Local-time Date shifted by the configured offset (read with getUTC* / toISOString). */
export function localShift(ms: number): Date {
  return new Date(ms + CFG.tzOffsetMs);
}
