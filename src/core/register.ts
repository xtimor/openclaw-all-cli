import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { backendIdFor, buildCliBackend } from "./backend.ts";
import { closeListings } from "./catalog.ts";
import { RELEASING_REASONS } from "./conversation.ts";
import { buildConfigSchema, capsOf, readBackendConfig } from "./config.ts";
import { homeDirFor } from "./home.ts";
import { reapOnce } from "./pid-locks.ts";
import { ProcessPool } from "./pool.ts";
import { createUsageHooks } from "./quota.ts";
import { createAuthProvider, type PoolControl } from "./provider-auth.ts";
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

/** Ids of the agents the config names, plus the default `main`. */
function configuredAgentIds(config: unknown): string[] {
  const agents = (config as { agents?: { entries?: Record<string, unknown>; list?: Array<{ id?: unknown }> } } | undefined)
    ?.agents;
  const ids = new Set<string>(["main"]);
  for (const id of Object.keys(agents?.entries ?? {})) ids.add(id);
  for (const entry of agents?.list ?? []) if (typeof entry?.id === "string") ids.add(entry.id);
  return [...ids];
}

/**
 * Registers one CLI backend per adapter (AD-1), each with its own process pool (AD-14). The pools
 * close when the plugin unloads, and a full load reaps what a killed Gateway left in the homes of
 * the configured agents (any other agent's home is reaped at its first use).
 */
export function registerAdapters(api: OpenClawPluginApi, adapters: readonly CliAdapter[]): void {
  const warn = (message: string) => api.logger.warn(message);
  // Hosts without a debug channel drop the per-turn timing line.
  const debug = (message: string) => api.logger.debug?.(message);
  const pools: ProcessPool[] = [];
  for (const adapter of adapters) {
    const backendId = backendIdFor(adapter);
    const settings = readBackendConfig(api.pluginConfig, backendId, warn);
    const pool = new ProcessPool(capsOf(settings));
    pools.push(pool);
    api.registerCliBackend(buildCliBackend(adapter, { settings, warn, debug, pool }));
    // The Control UI's provider list and `models auth login` read the provider's auth methods.
    // An adapter with a quota reader also offers OpenClaw's usage surfaces a plan-quota snapshot.
    // Only a full load serves turns; a setup-mode load must not replace the live pool.
    if (api.registrationMode === "full") livePools.set(backendId, pool);
    const authDeps = {
      stateDir: () => resolvePluginStateDir(api),
      // Looked up per call, so a fetch the host sets up later (a proxy dispatcher) is the one used.
      fetch: ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)) as typeof fetch,
      pools: (id: string) => livePools.get(id),
    };
    api.registerProvider({ ...createAuthProvider(adapter, PLUGIN_ID, authDeps), ...createUsageHooks(adapter, PLUGIN_ID, warn) });
    if (api.registrationMode === "full") {
      for (const agentId of configuredAgentIds(api.config)) {
        try {
          void reapOnce(homeDirFor(api.runtime.agent.resolveAgentDir(api.config, agentId), backendId), warn);
        } catch (error) {
          warn(`Could not look for leftover ${adapter.displayName} processes of agent "${agentId}": ${String(error)}`);
        }
      }
    }
  }
  const closeAll = async () => {
    for (const [id, pool] of livePools) if (pools.includes(pool as ProcessPool)) livePools.delete(id);
    // The model listings live outside the pools: abort them too, or their processes outlive the unload.
    await Promise.all([...pools.map((pool) => pool.closeAll()), closeListings()]);
  };
  // Checked against OpenClaw 2026.10.3: a Gateway SIGTERM runs `registerService.stop` and
  // `lifecycle.onDispose`; `registerRuntimeLifecycle.dispose` does not run. `closeAll` is
  // idempotent, so a host version that runs both is fine.
  api.lifecycle?.onDispose?.(closeAll);
  // A finished conversation releases its process (AD-14). `session_end` is a metadata hook: it needs
  // no conversation access. A host without hooks keeps the idle close.
  api.on?.("session_end", (event, ctx) => {
    const key = event.sessionKey || ctx.sessionKey;
    if (!key || !event.reason || !RELEASING_REASONS.has(event.reason)) return;
    for (const pool of pools) pool.releaseConversation(key);
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
