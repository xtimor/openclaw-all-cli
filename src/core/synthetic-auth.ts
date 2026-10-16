import { nativeAuthMarkerFor, backendIdFor } from "./backend.ts";
import { readBackendConfig } from "./config.ts";
import type { CliAdapter } from "./ports.ts";

/** The plugin ID, which is also the key of the plugin's config entry. */
export const PLUGIN_ID = "openclaw-all-cli";

type DiscoveryContext = {
  config?: { plugins?: { entries?: Record<string, { config?: Record<string, unknown> } | undefined> } };
  provider?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
};

/**
 * The provider-catalog entry that lets a CLI login count as auth (AD-1). OpenClaw loads it before
 * the plugin runtime, asks `prepareSyntheticAuth` whether the login works, and shows the models
 * as available when it returns a marker.
 */
export function createSyntheticAuthProvider(adapter: CliAdapter) {
  const backendId = backendIdFor(adapter);
  return {
    id: backendId,
    label: adapter.displayName,
    docsPath: "/providers/models",
    auth: [] as never[],
    async prepareSyntheticAuth(context: DiscoveryContext) {
      context.signal?.throwIfAborted();
      if (!context.config || context.provider?.toLowerCase() !== backendId) return undefined;
      const pluginConfig = context.config.plugins?.entries?.[PLUGIN_ID]?.config;
      const settings = readBackendConfig(pluginConfig, backendId, () => {});
      const status = await adapter.probeAuth({
        command: settings.command ?? adapter.command,
        env: context.env ?? process.env,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      context.signal?.throwIfAborted();
      if (status !== "available") return undefined;
      return {
        apiKey: nativeAuthMarkerFor(adapter),
        source: `${adapter.displayName} native auth`,
        mode: "oauth" as const,
      };
    },
  };
}
