/**
 * Identity boundary for the promise tables.
 *
 * The host injects a function with the same call shape as the live
 * resolveCaller(db, env, request, personaId): the persona id is the path
 * segment, a non-admin key whose api_keys.persona_id differs from that
 * path is 403, and an admin key may enter an already-existing persona.
 * This file does not implement extractKey, key hashing, or PERSONA_ID_RE.
 * Those bodies were not in the verified live fragments, and the public
 * repository's copy is not the live source.
 *
 * After that function returns, this module applies the promise table
 * policy: no house caller, no cross-persona read, and an admin whole-house
 * key stays out unless the host explicitly sets admitAdmin. Authors are
 * chu | yanyan and come from the injected caller, never from the body.
 */

import { AppError } from "../errors";
import type { MemoryDb } from "../types";
import { isPromiseAuthor, type PromiseAuthor } from "./rules";

export interface PromiseCaller {
  /** Persona id the resolver authenticated. Must equal the path id. */
  personaId: string;
  isAdmin: boolean;
  /**
   * Host-derived actor. The page viewer is yanyan; chu's own tool is chu.
   * Do not read this from the JSON body.
   */
  actor: PromiseAuthor;
}

/**
 * Injected equivalent of resolveCaller(db, env, request, personaId).
 * Throw AppError 401 / 403 / 404 the way the host function does.
 */
export type ResolvePromiseCaller = (
  db: MemoryDb,
  env: unknown,
  request: Request,
  personaId: string,
) => Promise<PromiseCaller>;

export interface PathCaller {
  personaId: string;
  isAdmin: boolean;
}

/** Same arguments as resolveCaller. The host passes its live function here. */
export type ResolvePathCaller = (
  db: MemoryDb,
  env: unknown,
  request: Request,
  personaId: string,
) => Promise<PathCaller>;

export const HOUSE_PERSONA_ID = "house";
export const PROMISE_ADMIT_ADMIN_DEFAULT = false;

/**
 * Compose a path resolver with a host-supplied actor mapping.
 * actorFor must not read the request body. A returned persona that is not
 * the path persona is rejected here, which is the non-admin 403 condition.
 */
export function bindPromiseCaller(
  resolvePathCaller: ResolvePathCaller,
  actorFor: (caller: PathCaller) => PromiseAuthor,
): ResolvePromiseCaller {
  return async (db, env, request, personaId) => {
    const caller = await resolvePathCaller(db, env, request, personaId);
    if (caller.personaId !== personaId) {
      throw new AppError(403, "forbidden", "这把密钥属于另一位人格，不能连接这个地址。");
    }
    const actor = actorFor(caller);
    if (!isPromiseAuthor(actor)) {
      throw new AppError(403, "forbidden", "约定的调用方只认初和燕燕。");
    }
    return { personaId: caller.personaId, isAdmin: caller.isAdmin, actor };
  };
}

export function assertPromiseAccess(caller: PromiseCaller, pathPersonaId: string, admitAdmin: boolean): void {
  if (pathPersonaId === HOUSE_PERSONA_ID || caller.personaId === HOUSE_PERSONA_ID) {
    throw new AppError(403, "forbidden", "约定不挂在记忆屋上，也不能按整屋列出全部人格。");
  }
  if (caller.personaId !== pathPersonaId) {
    throw new AppError(403, "forbidden", "这把密钥属于另一位人格，不能连接这个地址。");
  }
  if (!isPromiseAuthor(caller.actor)) {
    throw new AppError(403, "forbidden", "约定的调用方只认初和燕燕。");
  }
  if (caller.isAdmin && !admitAdmin) {
    throw new AppError(403, "forbidden", "管理员整库钥匙默认不能读约定。要看某一人格，用那个人格自己的钥匙。");
  }
}

/** close, content-add, defer, and the wake list are chu's channel. */
export function assertChuChannel(actor: PromiseAuthor): void {
  if (actor !== "chu") {
    throw new AppError(403, "forbidden", "这条是初的整理通道。");
  }
}
