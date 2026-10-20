import { createHash } from "node:crypto";
import { backendIdFor } from "./backend.ts";
import type { CliAdapter, CliModel } from "./ports.ts";

/** A model as `/model` and `openclaw models list` show it: `<backendId>/<id>`. */
export type CatalogRow = { id: string; name: string };

export type CatalogParams = {
  command: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
};

export type ModelCatalog = {
  /**
   * The account's models. A failed listing yields the default model alone and is logged; it never
   * throws for that. It rejects with the caller's own abort reason when `signal` aborts, and a
   * caller whose signal is already aborted starts no listing. `refresh` skips the cache.
   */
  list(params: CatalogParams, options?: { refresh?: boolean }): Promise<CatalogRow[]>;
};

export type ModelCatalogOptions = {
  /** How long a listing is reused. Default 1 minute: the host has no refresh signal, so this is what bounds a stale list. */
  ttlMs?: number;
  /** How long a failed listing is remembered, so a broken CLI is not spawned for every read. Default 30 seconds. */
  failureTtlMs?: number;
  now?: () => number;
  /** Receives failures. Never pass it a key or a header. */
  warn?: (message: string) => void;
};

const DEFAULT_CATALOG_TTL_MS = 60_000;
const DEFAULT_CATALOG_FAILURE_TTL_MS = 30_000;

/** The model every account has: the default model of the adapter, as a catalog row. */
export function defaultCatalogRow(adapter: CliAdapter): CatalogRow {
  const prefix = `${backendIdFor(adapter)}/`;
  const id = adapter.defaultModel.startsWith(prefix) ? adapter.defaultModel.slice(prefix.length) : adapter.defaultModel;
  return { id, name: id };
}

function toRow(model: CliModel): CatalogRow {
  return { id: model.name, name: model.label };
}

/**
 * Remembers the account's model listing (AD-2: it names no CLI). The listing is cached because the
 * host asks for the catalog often and each listing starts a CLI process. The cache key is the
 * command and the environment, so a changed API key lists again at once; a new login changes
 * neither, so it is noticed after the TTL, or at once from a logged-out state, where the caller
 * never asks and nothing was cached. A turn never reads it:
 * the adapter checks the model against the CLI's own list when it opens the session.
 */
export function createModelCatalog(adapter: CliAdapter, options: ModelCatalogOptions = {}): ModelCatalog {
  const ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_CATALOG_FAILURE_TTL_MS;
  const now = options.now ?? Date.now;
  const warn = options.warn ?? (() => {});
  const fallback = [defaultCatalogRow(adapter)];
  const cache = new Map<string, { until: number; rows: CatalogRow[] }>();
  const pending = new Map<string, Promise<CatalogRow[]>>();

  /** One key per command and environment; the environment is hashed so no value is kept. */
  function keyFor(params: CatalogParams): string {
    const env = Object.entries(params.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return createHash("sha256").update(JSON.stringify([params.command, env])).digest("hex");
  }

  /** The listing runs for every waiting caller, so it never takes one caller's signal. */
  async function load(key: string, params: CatalogParams): Promise<CatalogRow[]> {
    try {
      const env = Object.fromEntries(Object.entries(params.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const models = await adapter.listModels({
        command: params.command,
        args: adapter.launchArgs,
        env,
      });
      const rows = models.map(toRow);
      // A CLI that answers with nothing leaves the account with the default model, as a failure does.
      if (rows.length === 0) throw new Error("the CLI listed no models");
      cache.set(key, { until: now() + ttlMs, rows });
      return rows;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warn(`Could not list the ${adapter.displayName} models, so only ${fallback[0]?.id} is offered: ${reason}`);
      cache.set(key, { until: now() + failureTtlMs, rows: fallback });
      return fallback;
    }
  }

  /** Waits for the shared listing, or rejects when this caller's own signal aborts. */
  function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return work;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  return {
    async list(params, listOptions = {}) {
      params.signal?.throwIfAborted();
      const key = keyFor(params);
      if (!listOptions.refresh) {
        const hit = cache.get(key);
        if (hit && hit.until > now()) return hit.rows;
        const inFlight = pending.get(key);
        if (inFlight) return raceAbort(inFlight, params.signal);
      }
      const started = load(key, params).finally(() => {
        if (pending.get(key) === started) pending.delete(key);
      });
      pending.set(key, started);
      return raceAbort(started, params.signal);
    },
  };
}
