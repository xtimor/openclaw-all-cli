import { createHash } from "node:crypto";

export type KeyCheckVerdict = "valid" | "invalid" | "unknown";

export type CursorKeyCheckCacheOptions = {
  /** How long a validated key's verdict is served without re-checking `checkKey`. */
  ttlMs?: number;
  now?: () => number;
};

const DEFAULT_TTL_MS = 5 * 60_000;

type Entry = { signature: string; verdict: KeyCheckVerdict; expiresAt: number };

/**
 * Caches one validated `CURSOR_API_KEY`'s verdict so the ongoing auth probe (issue #98) does not
 * pay `checkKey`'s cost (a `cursor-agent about` round trip, up to two runs, each up to
 * `KEY_CHECK_TIMEOUT_MS`) on every probe. One slot is enough: a probe checks one key at a time per
 * backend, keyed by the exact command and key, so a changed key is always a fresh signature and
 * never reads another key's cached verdict. An `unknown` verdict is never cached, so the next probe
 * tries again instead of being stuck on an unclear answer. `invalidate` drops the slot when a live
 * turn finds the server has rejected the credential the cache called valid (AC4).
 */
export function createCursorKeyCheckCache(options: CursorKeyCheckCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  let entry: Entry | undefined;
  const signatureOf = (command: string, key: string) => `${command}\u0000${createHash("sha256").update(key).digest("hex")}`;
  return {
    get(command: string, key: string): KeyCheckVerdict | undefined {
      if (!entry || entry.signature !== signatureOf(command, key) || entry.expiresAt <= now()) return undefined;
      return entry.verdict;
    },
    set(command: string, key: string, verdict: KeyCheckVerdict): void {
      if (verdict === "unknown") return;
      entry = { signature: signatureOf(command, key), verdict, expiresAt: now() + ttlMs };
    },
    invalidate(): void {
      entry = undefined;
    },
  };
}

/** One cache per plugin process: like `usageReader`/`quotaReader` in `index.ts`, it outlives a turn. */
export const cursorKeyCheckCache = createCursorKeyCheckCache();
