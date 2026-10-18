import { createHash } from "node:crypto";
import type { NormalizedUsage, UsageQuery, UsageReport } from "../../core/ports.ts";

/**
 * Per-turn usage from Cursor's usage ledger (ticket 1.10, parity row P16). ACP reports none, but
 * every model request is a ledger event keyed by `conversationId` = the ACP session id, with the
 * exact counts. The API key is exchanged for a short-lived access token, then
 * `GetFilteredUsageEvents` is polled until the turn's event shows up.
 *
 * Secrets: the key and the token stay in memory. Warnings and thrown messages name only an
 * endpoint path and an HTTP status, never a response body.
 */

/** Env var that moves the ledger calls elsewhere (tests). It is in `CURSOR_CLEAR_ENV`, so the host strips it from turns. */
export const USAGE_URL_ENV = "OPENCLAW_ALL_CLI_CURSOR_USAGE_URL";

const DEFAULT_BASE_URL = "https://api2.cursor.sh";
const EXCHANGE_PATH = "/auth/exchange_user_api_key";
const EVENTS_PATH = "/aiserver.v1.DashboardService/GetFilteredUsageEvents";

/** A token is renewed this long before its JWT `exp` (option `tokenMarginMs`). */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** A fresh token is used for at least this long, so a short-lived one is not exchanged on every poll. */
const MIN_TOKEN_USE_MS = 500;
/** Lifetime assumed for a token whose JWT has no readable `exp`. */
const FALLBACK_TOKEN_TTL_MS = 30 * 60_000;
const MAX_TRACKED_SESSIONS = 1000;

export type CursorUsageOptions = {
  /** Wait before the first poll. */
  firstPollMs?: number;
  pollIntervalMs?: number;
  /** Longest the turn waits for its event, counted from `endedAt`. */
  deadlineMs?: number;
  requestTimeoutMs?: number;
  /** How long the ledger is skipped for a key after a failure that will not heal by itself. */
  cooldownMs?: number;
  /** Turns in a row that end without usage before the cooldown starts. */
  missStreak?: number;
  pageSize?: number;
  /** Slack for clock skew between this host and Cursor's stamp. */
  skewMs?: number;
  /** A cached token is replaced this long before its expiry. */
  tokenMarginMs?: number;
};

type LedgerEvent = {
  conversationId?: unknown;
  timestamp?: unknown;
  tokenUsage?: Record<string, unknown> | null;
};

const asCount = (value: unknown): number => {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
};

const asMillis = (value: unknown): number | undefined => {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/**
 * The turn's events: same `conversationId`, stamped at or after `notBefore`, and newer than the
 * last event an earlier turn of this session consumed (`after`). Counts are summed; a missing
 * count is 0 and all zeros means no usage. `latest` is the newest matched stamp.
 */
export function matchTurnEvents(
  events: readonly LedgerEvent[],
  window: { sessionId: string; notBefore: number; after?: number },
): { usage?: NormalizedUsage; latest?: number } {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let latest: number | undefined;
  for (const event of events) {
    if (!event || typeof event !== "object" || event.conversationId !== window.sessionId) continue;
    const stamp = asMillis(event.timestamp);
    if (stamp === undefined || stamp < window.notBefore) continue;
    if (window.after !== undefined && stamp <= window.after) continue;
    const tokens = event.tokenUsage ?? {};
    input += asCount(tokens.inputTokens);
    output += asCount(tokens.outputTokens);
    cacheRead += asCount(tokens.cacheReadTokens);
    cacheWrite += asCount(tokens.cacheWriteTokens);
    latest = latest === undefined ? stamp : Math.max(latest, stamp);
  }
  const total = input + output + cacheRead + cacheWrite;
  if (latest === undefined || total === 0) return { ...(latest !== undefined ? { latest } : {}) };
  return { usage: { input, output, cacheRead, cacheWrite, total }, latest };
}

/** How a ledger call failed. The message holds the path and status only. */
class LedgerError extends Error {
  readonly kind: "rejected" | "changed" | "transient";
  constructor(kind: LedgerError["kind"], path: string, status?: number) {
    super(`${path}: ${status === undefined ? "network error" : `HTTP ${status}`}`);
    this.kind = kind;
  }
}

class Unauthorized extends Error {}

type KeyState = {
  token?: { value: string; expiresAt: number };
  exchange?: Promise<string>;
  cooldownUntil: number;
  misses: number;
};

function tokenExpiry(token: string, now: number, marginMs: number): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    const exp = asMillis(payload.exp);
    if (exp !== undefined) return Math.max(exp * 1000 - marginMs, now + MIN_TOKEN_USE_MS);
  } catch {
    // Not a JWT: use the fallback.
  }
  return now + FALLBACK_TOKEN_TTL_MS;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function createCursorUsageReader(options: CursorUsageOptions = {}) {
  const firstPollMs = options.firstPollMs ?? 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const deadlineMs = options.deadlineMs ?? 6000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 3000;
  const cooldownMs = options.cooldownMs ?? 600_000;
  const missStreak = options.missStreak ?? 3;
  const pageSize = options.pageSize ?? 50;
  const skewMs = options.skewMs ?? 5000;
  const tokenMarginMs = options.tokenMarginMs ?? TOKEN_MARGIN_MS;

  const keys = new Map<string, KeyState>();
  /** Newest event stamp a turn consumed, per session id; oldest dropped past the cap. */
  const consumed = new Map<string, number>();

  const stateFor = (key: string): KeyState => {
    const id = createHash("sha256").update(key).digest("hex");
    let state = keys.get(id);
    if (!state) {
      state = { cooldownUntil: 0, misses: 0 };
      keys.set(id, state);
    }
    return state;
  };

  const markConsumed = (sessionId: string, stamp: number) => {
    consumed.delete(sessionId);
    consumed.set(sessionId, stamp);
    if (consumed.size > MAX_TRACKED_SESSIONS) consumed.delete(consumed.keys().next().value as string);
  };

  async function post(url: string, path: string, bearer: string, body: string, extra: Record<string, string>, signal?: AbortSignal) {
    let response: Response;
    try {
      response = await fetch(url + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}`, ...extra },
        body,
        // The key must not follow a redirect to another host.
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new LedgerError("transient", path);
    }
    const status = response.status;
    if (status === 401) {
      await response.body?.cancel().catch(() => {});
      throw new Unauthorized(path);
    }
    if (status === 403 && path === EXCHANGE_PATH) {
      await response.body?.cancel().catch(() => {});
      throw new LedgerError("rejected", path, status);
    }
    if (status === 400 || status === 404 || status === 415) {
      await response.body?.cancel().catch(() => {});
      throw new LedgerError("changed", path, status);
    }
    if (status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new LedgerError("transient", path, status);
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new LedgerError("changed", path, status);
    }
  }

  /** One exchange shared by concurrent turns of a key. */
  function accessToken(key: string, state: KeyState, url: string, fresh: boolean): Promise<string> {
    const now = Date.now();
    if (!fresh && state.token && state.token.expiresAt > now) return Promise.resolve(state.token.value);
    if (state.exchange) return state.exchange;
    const exchange = (async () => {
      try {
        const body = await post(url, EXCHANGE_PATH, key, "{}", {});
        const value = (body as { accessToken?: unknown } | null)?.accessToken;
        if (typeof value !== "string" || !value) throw new LedgerError("changed", EXCHANGE_PATH, 200);
        state.token = { value, expiresAt: tokenExpiry(value, Date.now(), tokenMarginMs) };
        return value;
      } catch (error) {
        state.token = undefined;
        // The key is the credential here: a 401 means it is rejected.
        if (error instanceof Unauthorized) throw new LedgerError("rejected", EXCHANGE_PATH, 401);
        throw error;
      } finally {
        state.exchange = undefined;
      }
    })();
    state.exchange = exchange;
    return exchange;
  }

  async function fetchEvents(key: string, state: KeyState, url: string, signal?: AbortSignal): Promise<LedgerEvent[]> {
    const body = JSON.stringify({ page: 1, pageSize });
    const headers = { "Connect-Protocol-Version": "1" };
    for (let attempt = 0; ; attempt += 1) {
      const token = await accessToken(key, state, url, attempt > 0);
      try {
        const json = (await post(url, EVENTS_PATH, token, body, headers, signal)) as { usageEventsDisplay?: unknown } | null;
        if (!json || !Array.isArray(json.usageEventsDisplay)) throw new LedgerError("changed", EVENTS_PATH, 200);
        return json.usageEventsDisplay as LedgerEvent[];
      } catch (error) {
        if (!(error instanceof Unauthorized)) throw error;
        state.token = undefined;
        if (attempt > 0) throw new LedgerError("rejected", EVENTS_PATH, 401);
      }
    }
  }

  async function read(query: UsageQuery): Promise<UsageReport> {
    const key = query.env.CURSOR_API_KEY?.trim();
    if (!key) return {};
    const state = stateFor(key);
    if (state.cooldownUntil > Date.now()) return {};
    const url = (query.env[USAGE_URL_ENV]?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const { signal } = query;
    const window = { sessionId: query.sessionId, notBefore: query.startedAt - skewMs };
    const deadline = query.endedAt + deadlineMs;

    const coolDown = (warning: string): UsageReport => {
      state.cooldownUntil = Date.now() + cooldownMs;
      state.misses = 0;
      return { warning: `${warning}; usage is off for ${Math.round(cooldownMs / 60_000)} min` };
    };

    let last = "no event for the session";
    try {
      let wait = firstPollMs;
      for (;;) {
        await sleep(wait, signal);
        if (signal?.aborted) return {};
        wait = pollIntervalMs;
        try {
          const events = await fetchEvents(key, state, url, signal);
          const after = consumed.get(query.sessionId);
          const match = matchTurnEvents(events, after === undefined ? window : { ...window, after });
          if (match.usage) {
            if (match.latest !== undefined) markConsumed(query.sessionId, match.latest);
            state.misses = 0;
            return { usage: match.usage };
          }
          last = "no event for the session";
        } catch (error) {
          if (signal?.aborted) return {};
          if (!(error instanceof LedgerError)) throw error;
          if (error.kind === "rejected") return coolDown(`Cursor usage: the API key was rejected (${error.message})`);
          if (error.kind === "changed") return coolDown(`Cursor usage: unexpected ledger answer (${error.message})`);
          last = error.message;
          break;
        }
        if (Date.now() + pollIntervalMs > deadline) break;
      }
    } catch {
      last = "internal error";
    }
    if (signal?.aborted) return {};
    state.misses += 1;
    if (state.misses >= missStreak) {
      return coolDown(`Cursor usage unavailable for ${state.misses} turns in a row (last: ${last})`);
    }
    return {};
  }

  return { read };
}
