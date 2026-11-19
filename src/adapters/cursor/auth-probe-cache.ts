import { createHash } from "node:crypto";

export type KeyCheckVerdict = "valid" | "invalid" | "unknown";

export type CursorKeyCheckCacheOptions = {
  /** How long a `valid` or `invalid` verdict is served without re-checking `checkKey`. */
  ttlMs?: number;
  /**
   * How long an `unknown` verdict is served. Short on purpose: cursor-agent 2026.11.11 answers
   * `unknown` for a refused key (not `invalid`, see `parseAboutOutput`), so without this every
   * single probe of that key would re-pay `checkKey`'s full cost (two `about` runs, up to
   * `KEY_CHECK_TIMEOUT_MS` each) instead of "rarely", defeating AC3 for that CLI version. Shorter
   * than `ttlMs` so a transient failure (a spawn error, a slow first run in a fresh home) is not
   * stuck for as long as a settled verdict.
   */
  unknownTtlMs?: number;
  now?: () => number;
};

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_UNKNOWN_TTL_MS = 30_000;

type Entry = { verdict: KeyCheckVerdict; expiresAt: number };

/**
 * Caches a validated `CURSOR_API_KEY`'s verdict per command+key signature, so the ongoing auth
 * probe (issue #98) does not pay `checkKey`'s cost on every probe. Keyed by signature (not one
 * shared slot): different agents can resolve different keys for the same command, and a single
 * slot would have each one evict the other's verdict on every probe. `invalidate` clears every
 * signature: a live turn only knows the credential was rejected, not which cached signature it
 * came from (AC4).
 */
export function createCursorKeyCheckCache(options: CursorKeyCheckCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const unknownTtlMs = options.unknownTtlMs ?? DEFAULT_UNKNOWN_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  const signatureOf = (command: string, key: string) => `${command}\u0000${createHash("sha256").update(key).digest("hex")}`;
  return {
    get(command: string, key: string): KeyCheckVerdict | undefined {
      const signature = signatureOf(command, key);
      const entry = entries.get(signature);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(signature);
        return undefined;
      }
      return entry.verdict;
    },
    set(command: string, key: string, verdict: KeyCheckVerdict): void {
      const signature = signatureOf(command, key);
      entries.set(signature, { verdict, expiresAt: now() + (verdict === "unknown" ? unknownTtlMs : ttlMs) });
    },
    invalidate(): void {
      entries.clear();
    },
  };
}

/** One cache per plugin process: like `usageReader`/`quotaReader` in `index.ts`, it outlives a turn. */
export const cursorKeyCheckCache = createCursorKeyCheckCache();
