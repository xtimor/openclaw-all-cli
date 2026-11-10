import { createHash } from "node:crypto";
import type { QuotaQuery, QuotaReport, QuotaSnapshot, QuotaWindow } from "../../core/ports.ts";
import { DEFAULT_BASE_URL, EXCHANGE_PATH, tokenExpiry } from "./usage.ts";

/**
 * The account's plan quota from Cursor's dashboard API (ticket 26, issue #82), for OpenClaw's usage
 * surfaces. Spike 2026-11-10 (cursor-agent 2026.10.22 account, API key): with the access token that
 * `exchange_user_api_key` returns, `GetPlanInfo` answers the plan name and the billing cycle end,
 * and `GetCurrentPeriodUsage` the cycle's start and end, the spend in cents, and the used percent
 * of the included total, of Auto + Composer, and of API models. Nothing here is computed from
 * anything but those fields.
 *
 * Calls are cached per key for `ttlMs`, merged while one is in flight, and held off for `backoffMs`
 * after a failure (the last reading is answered, marked stale). The access token is reused until
 * shortly before its expiry. Secrets: the key and the token stay in memory; warnings name only an
 * endpoint path and an HTTP status, never a response body. The turn path never calls this.
 */

const PLAN_PATH = "/aiserver.v1.DashboardService/GetPlanInfo";
const PERIOD_PATH = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

export type CursorQuotaOptions = {
  /** A reading is served for this long without asking Cursor again. */
  ttlMs?: number;
  /** After a failure Cursor is not asked for this long. */
  backoffMs?: number;
  requestTimeoutMs?: number;
  /** A cached token is replaced this long before its expiry. */
  tokenMarginMs?: number;
  now?: () => number;
  /** Transport; tests inject an in-memory one. Defaults to the global `fetch`, looked up per call. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  baseUrl?: string;
};

/** How a call failed. The message holds the path and status only. */
class QuotaError extends Error {
  readonly kind: "rejected" | "changed" | "transient";
  constructor(kind: QuotaError["kind"], path: string, status?: number) {
    super(`${path}: ${status === undefined ? "network error" : `HTTP ${status}`}`);
    this.kind = kind;
  }
}

class Unauthorized extends Error {}

type Reading = { snapshot: QuotaSnapshot; at: number };

type KeyState = {
  token?: { value: string; expiresAt: number };
  reading?: Reading;
  inflight?: Promise<void>;
  /** No request before this time; 0 when the last request succeeded. */
  holdUntil: number;
  /** The last failure's log line, until a caller takes it. */
  warning?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A finite number from a JSON number or a numeric string (Cursor sends 64-bit values as strings). */
const asNumber = (value: unknown): number | undefined => {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

const dollars = (cents: number): string => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Cursor's two answers as a snapshot. Windows come from the percentages Cursor reports; the
 * summary line from the spend it reports (cents). Anything missing is left out. Throws when the
 * period answer has neither a window nor a spend value: the shape changed.
 */
export function toSnapshot(plan: unknown, period: unknown): QuotaSnapshot {
  const usage = isRecord(period) && isRecord(period.planUsage) ? period.planUsage : undefined;
  if (!isRecord(period) || !usage) throw new QuotaError("changed", PERIOD_PATH, 200);
  const resetAt = asNumber(period.billingCycleEnd) ?? (isRecord(plan) && isRecord(plan.planInfo) ? asNumber(plan.planInfo.billingCycleEnd) : undefined);
  const windows: QuotaWindow[] = [];
  const add = (label: string, percent: unknown) => {
    const usedPercent = asNumber(percent);
    if (usedPercent !== undefined) windows.push({ label, usedPercent, ...(resetAt !== undefined ? { resetAt } : {}) });
  };
  add("Total", usage.totalPercentUsed);
  add("Auto + Composer", usage.autoPercentUsed);
  add("API models", usage.apiPercentUsed);

  const total = asNumber(usage.totalSpend);
  const included = asNumber(usage.includedSpend);
  const limit = asNumber(usage.limit);
  const bonus = asNumber(usage.bonusSpend);
  let summary: string | undefined;
  if (included !== undefined && limit !== undefined && limit > 0) {
    summary = `Spend this cycle: ${dollars(included)} of ${dollars(limit)} included` + (bonus ? `, ${dollars(bonus)} bonus` : "");
  } else if (total !== undefined) {
    summary = `Spend this cycle: ${dollars(total)}`;
  }
  if (windows.length === 0 && summary === undefined) throw new QuotaError("changed", PERIOD_PATH, 200);

  const info = isRecord(plan) && isRecord(plan.planInfo) ? plan.planInfo : undefined;
  const name = typeof info?.planName === "string" && info.planName.trim() ? info.planName.trim() : undefined;
  return { ...(name ? { plan: name } : {}), windows, ...(summary ? { summary } : {}) };
}

export function createCursorQuotaReader(options: CursorQuotaOptions = {}) {
  const ttlMs = options.ttlMs ?? 60_000;
  const backoffMs = options.backoffMs ?? 600_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 6000;
  const tokenMarginMs = options.tokenMarginMs ?? 5 * 60_000;
  const now = options.now ?? (() => Date.now());
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

  const keys = new Map<string, KeyState>();
  const stateFor = (key: string): KeyState => {
    const id = createHash("sha256").update(key).digest("hex");
    let state = keys.get(id);
    if (!state) {
      state = { holdUntil: 0 };
      keys.set(id, state);
    }
    return state;
  };

  async function post(path: string, bearer: string, body: string): Promise<unknown> {
    let response: Response;
    try {
      response = await send(baseUrl + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}`, "Connect-Protocol-Version": "1" },
        body,
        // The key must not follow a redirect to another host.
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new QuotaError("transient", path);
    }
    const status = response.status;
    if (status !== 200) await response.body?.cancel().catch(() => {});
    if (status === 401) throw new Unauthorized(path);
    if (status === 403 && path === EXCHANGE_PATH) throw new QuotaError("rejected", path, status);
    if (status === 400 || status === 404 || status === 415) throw new QuotaError("changed", path, status);
    if (status !== 200) throw new QuotaError("transient", path, status);
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new QuotaError("changed", path, status);
    }
  }

  async function accessToken(key: string, state: KeyState, fresh: boolean): Promise<string> {
    if (!fresh && state.token && state.token.expiresAt > now()) return state.token.value;
    state.token = undefined;
    let body: unknown;
    try {
      body = await post(EXCHANGE_PATH, key, "{}");
    } catch (error) {
      // The key is the credential here: a 401 means it is rejected.
      if (error instanceof Unauthorized) throw new QuotaError("rejected", EXCHANGE_PATH, 401);
      throw error;
    }
    const value = isRecord(body) ? body.accessToken : undefined;
    if (typeof value !== "string" || !value) throw new QuotaError("changed", EXCHANGE_PATH, 200);
    state.token = { value, expiresAt: tokenExpiry(value, now(), tokenMarginMs) };
    return value;
  }

  /** Both dashboard calls with one token; a 401 renews the token once and repeats both. */
  async function fetchReading(key: string, state: KeyState): Promise<Reading> {
    for (let attempt = 0; ; attempt += 1) {
      const token = await accessToken(key, state, attempt > 0);
      try {
        const [plan, period] = await Promise.all([
          // The plan name is a nicety: only a rejected token stops the reading.
          post(PLAN_PATH, token, "{}").catch((error: unknown) => {
            if (error instanceof Unauthorized) throw error;
            return undefined;
          }),
          post(PERIOD_PATH, token, "{}"),
        ]);
        return { snapshot: toSnapshot(plan, period), at: now() };
      } catch (error) {
        if (!(error instanceof Unauthorized)) throw error;
        state.token = undefined;
        if (attempt > 0) throw new QuotaError("rejected", PERIOD_PATH, 401);
      }
    }
  }

  const stale = (state: KeyState): QuotaSnapshot | undefined => {
    const reading = state.reading;
    return reading ? { ...reading.snapshot, staleSince: reading.at } : undefined;
  };

  /** The one request of a key: it records its own outcome, so it counts even when every caller stopped waiting. */
  function start(key: string, state: KeyState): Promise<void> {
    const request = (async () => {
      try {
        state.reading = await fetchReading(key, state);
        state.holdUntil = 0;
      } catch (error) {
        state.holdUntil = now() + backoffMs;
        if (error instanceof QuotaError) {
          const what = error.kind === "rejected" ? "the API key was rejected" : error.kind === "changed" ? "unexpected dashboard answer" : "request failed";
          state.warning = `Cursor quota: ${what} (${error.message}); not asked again for ${Math.round(backoffMs / 60_000)} min`;
        } else {
          state.warning = `Cursor quota: internal error; not asked again for ${Math.round(backoffMs / 60_000)} min`;
        }
      } finally {
        state.inflight = undefined;
      }
    })();
    state.inflight = request;
    return request;
  }

  /** The newest reading, or the stale one when the last request failed; the failure's warning goes out once. */
  function answer(state: KeyState): QuotaReport {
    const warning = state.warning;
    state.warning = undefined;
    const ok = state.reading && state.holdUntil === 0;
    const snapshot = ok ? state.reading?.snapshot : stale(state);
    return { ...(snapshot ? { snapshot } : {}), ...(warning ? { warning } : {}) };
  }

  async function read(query: QuotaQuery): Promise<QuotaReport> {
    const key = query.apiKey.trim();
    if (!key) return {};
    const state = stateFor(key);
    const time = now();
    if (state.reading && state.holdUntil === 0 && time - state.reading.at < ttlMs) return { snapshot: state.reading.snapshot };
    if (state.holdUntil > time) return answer(state);
    const settled = await waitFor(state.inflight ?? start(key, state), query.signal);
    if (settled === undefined && query.signal?.aborted) return pick(stale(state));
    return answer(state);
  }

  return { read };
}

const pick = (snapshot: QuotaSnapshot | undefined): QuotaReport => (snapshot ? { snapshot } : {});

/** `true` once the shared request has settled, or `undefined` when the caller's signal aborts first. */
function waitFor(promise: Promise<void>, signal?: AbortSignal): Promise<true | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const onAbort = () => resolve(undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    });
  });
}
