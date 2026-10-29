import { handleRequest } from "./http";
import { reqStore, cronLinks } from "./links";
import { cronGarden } from "./garden-links";
import { cronCognition } from "./cognition";
import { emotionCron } from "./emotion";
import { bodyCron, BODY_PERSONAS, bridgeSender } from "./body";
import type { Env } from "./types";
import { applyConfig, CFG } from "./config";
import { dreamPersona, inDreamWindow, runDream, workersAiGen } from "./dream";

export default {
  fetch(request: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    applyConfig(env);
    return reqStore.run({ env, ctx }, () => handleRequest(request, env));
  },
  /** Every 30 min: links / garden / cognition housekeeping, plus optional emotion, body (18+) and dream jobs. */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    applyConfig(env);
    const log = (tag: string) => (r: unknown) => console.log(`[${tag}]`, JSON.stringify(r));
    const err = (tag: string) => (e: unknown) => console.error(`[${tag}] err`, e);
    if (CFG.adult) {
      const sender = env.DESIRE_WAKE === "1" && env.BRIDGE_URL && env.BRIDGE_KEY ? bridgeSender(env.BRIDGE_URL, env.BRIDGE_KEY, { silent: env.BODY_STROKE_LOOP === "1" }) : null;
      for (const pid of BODY_PERSONAS) ctx.waitUntil(bodyCron(env.DB, pid, Date.now(), pid === CFG.primary ? sender : null).then(log("body-cron")).catch(err("body-cron")));
    }
    if (CFG.emotion.size) ctx.waitUntil(emotionCron(env.DB).then(log("emotion-cron")).catch(err("emotion-cron")));
    ctx.waitUntil(cronLinks(env.DB, env.AI).then(log("links-cron")).catch(err("links-cron")));
    ctx.waitUntil(cronGarden(env.DB, env.AI).catch(err("garden-cron")));
    ctx.waitUntil(cronCognition(env.DB).then(log("cognition-cron")).catch(err("cognition-cron")));
    const now = Date.now();
    const dp = dreamPersona();
    if (dp && inDreamWindow(now)) {
      ctx.waitUntil(runDream(env.DB, env.AI ? workersAiGen(env.AI) : null, { nowMs: now, persona: dp }).then((r) => console.log("[dream-cron]", r.ok, r.date)).catch(err("dream-cron")));
    }
  },
};
