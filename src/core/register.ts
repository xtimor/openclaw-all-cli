import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { API_KEY_METHOD_ID } from "./auth-ids.ts";
import { findAnyStoredKey, settleSharedAuthStore, type FindAnyStoredKey, type SettleOutcome } from "./auth-store.ts";
import { backendIdFor, buildCliBackend } from "./backend.ts";
import { closeListings } from "./catalog.ts";
import { RELEASING_REASONS, releaseConversationEverywhere, shareConversationPool } from "./conversation.ts";
import { buildConfigSchema, capsOf, readBackendConfig, type BackendConfig } from "./config.ts";
import { withoutKeys } from "./env.ts";
import { homeDirFor } from "./home.ts";
import { dropKeyCache, keyCacheDirFor } from "./key-cache.ts";
import { isInside, managedRoot, sweepManagedInstall, type KeyPresence, type SweepOutcome, type SweepTrigger } from "./managed-install.ts";
import { reapOnce } from "./pid-locks.ts";
import { ProcessPool } from "./pool.ts";
import { createUsageHooks } from "./quota.ts";
import { createAuthProvider, type PoolControl } from "./provider-auth.ts";
import { createStreamHook } from "./stream.ts";
import type { CliAdapter } from "./ports.ts";
import type { OpenClawPluginApi } from "./sdk-types.ts";
import { PLUGIN_ID } from "./synthetic-auth.ts";

/**
 * The live pools by backend ID, for the remove method (it closes idle processes and refuses while a
 * turn runs). Best effort: a setup-mode load of the plugin in another module instance sees an empty
 * map, and removing files under a running process is safe on Linux and macOS.
 */
const livePools = new Map<string, PoolControl>();

/** OpenClaw's state directory: the host's own answer, else its documented defaults. */
export function resolvePluginStateDir(api: Pick<OpenClawPluginApi, "runtime">, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const dir = api.runtime?.state?.resolveStateDir?.(env);
    if (typeof dir === "string" && dir.trim()) return resolve(dir);
  } catch {
    // A setup-mode runtime may not offer it: fall back below.
  }
  if (env.OPENCLAW_STATE_DIR?.trim()) return resolve(env.OPENCLAW_STATE_DIR.trim());
  if (env.OPENCLAW_HOME?.trim()) return join(resolve(env.OPENCLAW_HOME.trim()), ".openclaw");
  return join(homedir(), ".openclaw");
}

/** What the sweep needs besides the adapter. */
export type SweepDeps = {
  stateDir: () => string;
  settings: BackendConfig;
  pool?: PoolControl | undefined;
  /**
   * The directories of every agent whose auth store may hold a key (the configured agents, `main`
   * included). A throw counts as a store that cannot be read. Absent: the main store only.
   */
  agentDirs?: () => readonly string[];
  /** Looks for any key of the provider in an agent's auth store (tests). Default: `findAnyStoredKey`. */
  findAnyKey?: FindAnyStoredKey;
  /** The Gateway's environment (tests). Default: `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Unsets `command` in OpenClaw's config when it points into `root` (tests). Default: OpenClaw's config mutation. */
  unsetCommand?: (backendId: string, root: string) => Promise<boolean>;
};

/**
 * Whether the plugin has a key for the backend anywhere: the plugin config, the Gateway's env, or any
 * `api_key` profile of the provider in any of the agents' auth stores. `unreadable` when no key was
 * found but a store (or the agent list) could not be read.
 */
export async function keyPresence(
  adapter: CliAdapter,
  deps: Pick<SweepDeps, "settings" | "agentDirs" | "findAnyKey" | "env">,
): Promise<KeyPresence> {
  const keyVar = adapter.apiKeyEnvVar;
  if (!keyVar) return "none";
  if (deps.settings.env?.[keyVar]?.trim() || (deps.env ?? process.env)[keyVar]?.trim()) return "key";
  let dirs: ReadonlyArray<string | undefined>;
  try {
    dirs = deps.agentDirs ? deps.agentDirs() : [undefined];
  } catch {
    return "unreadable";
  }
  const find = deps.findAnyKey ?? findAnyStoredKey;
  let unreadable = false;
  for (const agentDir of dirs.length > 0 ? dirs : [undefined]) {
    const found = await find({ agentDir, provider: backendIdFor(adapter) });
    if (found.kind === "key") return "key";
    if (found.kind === "unreadable") unreadable = true;
  }
  return unreadable ? "unreadable" : "none";
}

/** What the unset uses of OpenClaw's config mutation (`openclaw/plugin-sdk/config-mutation`, 2026.10.3 and 2026.11.x). */
type ConfigMutation = {
  mutateConfigFile: (params: { mutate: (draft: Record<string, unknown>) => boolean }) => Promise<{ result?: unknown }>;
};

/**
 * Unsets `plugins.entries.<plugin>.config.<backendId>.command` in OpenClaw's config file, only while
 * it points into `root`. `load` is the host module (tests pass the isolated OpenClaw's).
 */
export async function unsetManagedCommand(
  backendId: string,
  root: string,
  load: () => Promise<ConfigMutation> = async () => (await import("openclaw/plugin-sdk/config-mutation")) as unknown as ConfigMutation,
): Promise<boolean> {
  const { mutateConfigFile } = await load();
  const done = await mutateConfigFile({
    mutate: (draft) => {
      const entries = (draft as { plugins?: { entries?: Record<string, { config?: Record<string, unknown> } | undefined> } }).plugins?.entries;
      const backend = entries?.[PLUGIN_ID]?.config?.[backendId] as Record<string, unknown> | undefined;
      const command = backend?.command;
      if (typeof command !== "string" || !isInside(root, command)) return false;
      delete backend!.command;
      return true;
    },
  });
  return done.result === true;
}

/**
 * The sweep of one backend's managed CLI (plan 27): a CLI the plugin installed and saved a key for
 * goes when the key is gone everywhere (every `api_key` profile of the provider in every agent's
 * auth store, the plugin config, the Gateway's env) and the CLI has no login of its own. A store
 * that cannot be read keeps it. Calls that overlap share one run.
 */
export function createManagedSweep(adapter: CliAdapter, deps: SweepDeps): (trigger?: SweepTrigger) => Promise<SweepOutcome> {
  const keyVar = adapter.apiKeyEnvVar;
  const backendId = backendIdFor(adapter);
  let running: Promise<SweepOutcome> | undefined;
  const sweepOnce = async (ownTurns: number): Promise<SweepOutcome> => {
    if (!keyVar || !adapter.managedInstall) return { kind: "none" };
    const stateDir = deps.stateDir();
    const env = deps.env ?? process.env;
    const settings = deps.settings;
    return sweepManagedInstall({
      stateDir,
      root: managedRoot(stateDir, adapter.command),
      hasKey: () => keyPresence(adapter, deps),
      // The CLI's own login, in the user's own config: no key in the probe's env, or the probe would
      // say "available" for it. Keyed runs cache their key elsewhere, so a removed key is not a login.
      login: () =>
        adapter.probeAuth({
          command: settings.command ?? adapter.command,
          env: withoutKeys({ ...withoutKeys(env, adapter.clearEnv), ...settings.env }, [keyVar]),
        }),
      pool: deps.pool,
      unsetCommand: (root) => (deps.unsetCommand ?? unsetManagedCommand)(backendId, root),
      ownTurns,
    });
  };
  // A run already going is shared, with the trigger it started with.
  return (trigger) => {
    running ??= (async () => {
      try {
        return await sweepOnce(trigger?.fromTurn ? 1 : 0);
      } catch (error) {
        return { kind: "failed" as const, reason: error instanceof Error ? error.message : String(error) };
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
}

/**
 * Deletes the key cache of every listed agent home for which the plugin has no key any more: no key
 * in the plugin config and none in that agent's auth store (an unreadable store keeps it). Homes
 * without a cache are skipped before the store is read. Never throws.
 */
export async function dropStaleKeyCaches(
  adapter: CliAdapter,
  deps: { settings: BackendConfig; homes: ReadonlyArray<{ agentDir: string; home: string }>; findAnyKey?: FindAnyStoredKey },
): Promise<string[]> {
  const keyVar = adapter.apiKeyEnvVar;
  const dropped: string[] = [];
  if (!keyVar || !adapter.keyCacheEnv || deps.settings.env?.[keyVar]?.trim()) return dropped;
  const find = deps.findAnyKey ?? findAnyStoredKey;
  for (const { agentDir, home } of deps.homes) {
    try {
      if (!(await lstat(keyCacheDirFor(home)).catch(() => undefined))) continue;
      if ((await find({ agentDir, provider: backendIdFor(adapter) })).kind !== "absent") continue;
      await dropKeyCache(home);
      dropped.push(home);
    } catch {
      // Best effort: the next keyless turn of that agent drops it.
    }
  }
  return dropped;
}

/** One log line for a sweep that did something; nothing for one that kept the CLI. */
export function reportSweep(adapter: CliAdapter, outcome: SweepOutcome, log: { info: (message: string) => void; warn: (message: string) => void }): void {
  if (outcome.kind === "removed") {
    log.info(
      `Removed ${outcome.root}: the plugin had installed ${adapter.displayName} there for an API key, and that key is gone.` +
        (outcome.commandUnset ? ` ${backendIdFor(adapter)}.command pointed there and is unset.` : "") +
        ` To use ${adapter.displayName} again, connect it in Settings > Models > Connect provider, or run \`openclaw models auth login --provider ${backendIdFor(adapter)} --method ${API_KEY_METHOD_ID}\` on the Gateway host.`,
    );
  } else if (outcome.kind === "failed") {
    log.warn(`Could not remove the ${adapter.displayName} the plugin installed for a removed API key: ${outcome.reason}`);
  }
}

/** Ids of the agents the config names, plus the default `main`. */
function configuredAgentIds(config: unknown): string[] {
  const agents = (config as { agents?: { entries?: Record<string, unknown>; list?: Array<{ id?: unknown }> } } | undefined)
    ?.agents;
  const ids = new Set<string>(["main"]);
  for (const id of Object.keys(agents?.entries ?? {})) ids.add(id);
  for (const entry of agents?.list ?? []) if (typeof entry?.id === "string") ids.add(entry.id);
  return [...ids];
}

/** What `registerAdapters` takes besides the host's API (tests). */
export type RegisterOptions = {
  /** Settles the auth store's location at a full load (issue #106). Default: `settleSharedAuthStore`. */
  settleAuthStore?: () => Promise<SettleOutcome>;
};

/**
 * Registers one CLI backend per adapter (AD-1), each with its own process pool (AD-14). The pools
 * close when the plugin unloads, and a full load reaps what a killed Gateway left in the homes of
 * the configured agents (any other agent's home is reaped at its first use).
 */
export function registerAdapters(api: OpenClawPluginApi, adapters: readonly CliAdapter[], options: RegisterOptions = {}): void {
  const warn = (message: string) => api.logger.warn(message);
  // Issue #106: on OpenClaw 2026.10.3 a fresh state's auth store location is settled at a full load, so
  // a key saved later shows in `models.authStatus`. It runs in the background and races the host's
  // model-catalog worker, which reads the location when it starts: in one probe the settle took about
  // 6 ms and the worker read 4.5 s later, but nothing orders them. Not settled means the key may show
  // only after a restart, so that is logged once; on 2026.11.x there is nothing to settle.
  if (api.registrationMode === "full") {
    void (options.settleAuthStore ?? settleSharedAuthStore)().then((outcome) => {
      if (outcome === "failed") warn("could not settle the auth store location on OpenClaw 2026.10.3; a key saved before the next restart may show as Not configured");
    });
  }
  // Hosts without a debug channel drop the per-turn timing line.
  const debug = (message: string) => api.logger.debug?.(message);
  const pools: ProcessPool[] = [];
  for (const adapter of adapters) {
    const backendId = backendIdFor(adapter);
    const settings = readBackendConfig(api.pluginConfig, backendId, warn);
    const pool = new ProcessPool(capsOf(settings));
    pools.push(pool);
    const log = { info: (message: string) => (api.logger.info ? api.logger.info(message) : warn(message)), warn };
    // Every configured agent's store may hold a key (the host saves a Control UI profile under the
    // agent the dialog names, and falls back from an agent to main, never the other way).
    const agentDirs = () => configuredAgentIds(api.config).map((agentId) => api.runtime.agent.resolveAgentDir(api.config, agentId));
    // Only a full load serves turns and may remove a managed CLI; a setup-mode load leaves it alone.
    const sweep =
      api.registrationMode === "full" ? createManagedSweep(adapter, { stateDir: () => resolvePluginStateDir(api), settings, pool, agentDirs }) : undefined;
    const sweepAndReport = sweep
      ? async (trigger?: SweepTrigger) => {
          const outcome = await sweep(trigger);
          reportSweep(adapter, outcome, log);
          return outcome;
        }
      : undefined;
    api.registerCliBackend(buildCliBackend(adapter, { settings, warn, debug, pool, ...(sweepAndReport ? { sweep: sweepAndReport } : {}) }));
    // The Control UI's provider list and `models auth login` read the provider's auth methods.
    // An adapter with a quota reader also offers OpenClaw's usage surfaces a plan-quota snapshot.
    // Only a full load serves turns; a setup-mode load must not replace the live pool.
    if (api.registrationMode === "full") livePools.set(backendId, pool);
    const authDeps = {
      stateDir: () => resolvePluginStateDir(api),
      // Looked up per call, so a fetch the host sets up later (a proxy dispatcher) is the one used.
      fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
      pools: (id: string) => livePools.get(id),
      // OpenClaw's fallback store for every agent: `OPENCLAW_AGENT_DIR`, else main's directory.
      mainAgentDir: () => process.env.OPENCLAW_AGENT_DIR?.trim() || api.runtime.agent.resolveAgentDir(api.config, "main"),
    };
    // OpenClaw's own runtime (Test connection, skill review, companion "ask") reaches the CLI through the stream hook.
    api.registerProvider({
      ...createAuthProvider(adapter, PLUGIN_ID, authDeps),
      ...createUsageHooks(adapter, PLUGIN_ID, warn),
      ...createStreamHook(adapter, PLUGIN_ID),
    });
    if (api.registrationMode === "full") {
      // At Gateway start: a managed CLI whose key was removed (OpenClaw's Remove key) goes now.
      void sweepAndReport?.();
      const homes: Array<{ agentDir: string; home: string }> = [];
      for (const agentId of configuredAgentIds(api.config)) {
        try {
          const agentDir = api.runtime.agent.resolveAgentDir(api.config, agentId);
          const home = homeDirFor(agentDir, backendId);
          homes.push({ agentDir, home });
          void reapOnce(home, warn);
        } catch (error) {
          warn(`Could not look for leftover ${adapter.displayName} processes of agent "${agentId}": ${String(error)}`);
        }
      }
      // A cached copy of a removed key goes with the key.
      void dropStaleKeyCaches(adapter, { settings, homes });
    }
  }
  // Every loaded copy's conversation end reaches these pools (issue #105): the host may run this copy's turns while
  // its `session_end` runs in another copy. Any registration mode: a turn can run in a copy the host did not activate.
  const unshare = pools.map((pool) => shareConversationPool(pool));
  const closeAll = async () => {
    for (const stop of unshare) stop();
    for (const [id, pool] of livePools) if (pools.includes(pool as ProcessPool)) livePools.delete(id);
    // The model listings live outside the pools: abort them too, or their processes outlive the unload.
    await Promise.all([...pools.map((pool) => pool.closeAll()), closeListings()]);
  };
  // Checked against OpenClaw 2026.10.3: a Gateway SIGTERM runs `registerService.stop` and
  // `lifecycle.onDispose`; `registerRuntimeLifecycle.dispose` does not run. `closeAll` is
  // idempotent, so a host version that runs both is fine.
  api.lifecycle?.onDispose?.(closeAll);
  // A finished conversation releases its process (AD-14), in whichever loaded copy of the plugin holds it.
  // `session_end` is a metadata hook: it needs no conversation access. A host without hooks keeps the idle close.
  api.on?.("session_end", (event, ctx) => {
    const key = event.sessionKey || ctx.sessionKey;
    if (!key || !event.reason || !RELEASING_REASONS.has(event.reason)) return;
    releaseConversationEverywhere(key);
  });
  api.registerService?.({ id: "openclaw-all-cli-processes", start: () => {}, stop: closeAll });
}

/** The plugin's runtime config validator, in the shape `definePluginEntry` takes. */
export function createConfigValidator(adapters: readonly CliAdapter[]) {
  const schema = buildConfigSchema(adapters.map(backendIdFor));
  return {
    safeParse: (value: unknown) => {
      const parsed = schema.safeParse(value ?? {});
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : {
            success: false as const,
            error: {
              issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })),
            },
          };
    },
  };
}
