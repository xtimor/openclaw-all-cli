import { backendIdFor, buildCliBackend } from "./backend.ts";
import { closeListings } from "./catalog.ts";
import { buildConfigSchema, capsOf, readBackendConfig } from "./config.ts";
import { homeDirFor } from "./home.ts";
import { reapOnce } from "./pid-locks.ts";
import { ProcessPool } from "./pool.ts";
import type { CliAdapter } from "./ports.ts";
import type { OpenClawPluginApi } from "./sdk-types.ts";

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
  const pools: ProcessPool[] = [];
  for (const adapter of adapters) {
    const backendId = backendIdFor(adapter);
    const settings = readBackendConfig(api.pluginConfig, backendId, warn);
    const pool = new ProcessPool(capsOf(settings));
    pools.push(pool);
    api.registerCliBackend(buildCliBackend(adapter, { settings, warn, pool }));
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
    // The model listings live outside the pools: abort them too, or their processes outlive the unload.
    await Promise.all([...pools.map((pool) => pool.closeAll()), closeListings()]);
  };
  // Checked against OpenClaw 2026.10.3: a Gateway SIGTERM runs `registerService.stop` and
  // `lifecycle.onDispose`; `registerRuntimeLifecycle.dispose` does not run. `closeAll` is
  // idempotent, so a host version that runs both is fine.
  api.lifecycle?.onDispose?.(closeAll);
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
