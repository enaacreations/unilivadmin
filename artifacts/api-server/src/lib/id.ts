import { randomUUID } from "crypto";

export function newId(): string {
  return randomUUID();
}

/**
 * Runs `fn`, retrying on a unique-constraint violation. Used for human-readable
 * sequential codes (TKT-, EMP-, LB-, IND-…) generated via MAX()+1, which can
 * collide under concurrent inserts. `fn` must recompute the number each attempt.
 */
export async function withUniqueRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const msg = String((e as { message?: string })?.message ?? e);
      if (i < attempts && /unique|duplicate/i.test(msg)) continue;
      throw e;
    }
  }
}
