import { nativeAuthMarkerFor, backendIdFor } from "./backend.ts";
import { defaultCatalogRow, type CatalogRow, type ModelCatalog } from "./catalog.ts";
import { readBackendConfig } from "./config.ts";
import { withoutKeys } from "./env.ts";
import { deriveFlags } from "./manifest.ts";
import type { CliAdapter } from "./ports.ts";

/** The plugin ID, which is also the key of the plugin's config entry. */
export const PLUGIN_ID = "openclaw-all-cli";

/**
 * OpenClaw drops a catalog provider that has no base URL or no `api` (checked against OpenClaw
 * 2026.10.3: without `api` the models never reach `/model`). A CLI backend has neither, and the
 * turn runs through the backend's `execute`, so no request is ever made to this URL or API.
 */
const CLI_BASE_URL = "cli://local";
const CLI_PLACEHOLDER_API = "openai-completions";

/** The catalog hook's context, reduced to what the plugin reads. */
type CatalogContext = {
  config?: DiscoveryContext["config"];
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** Providers the host asks about; absent means all. */
  providerIds?: readonly string[];
};

/** A catalog row in the shape of OpenClaw's model definition. The CLI reports no price, window, or limits. */
function toModelDefinition(row: CatalogRow, input: Array<"text" | "image">) {
  return {
    id: row.id,
    name: row.name,
    reasoning: false,
    input,
    // A CLI login bills the user's own plan, not OpenClaw.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

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
export function createSyntheticAuthProvider(adapter: CliAdapter, catalog?: ModelCatalog) {
  const backendId = backendIdFor(adapter);
  const flags = deriveFlags(adapter.manifest);
  // The probes and the listing run with the same clean env as a turn.
  const probeEnv = (env: Record<string, string | undefined> | undefined) => withoutKeys(env ?? process.env, adapter.clearEnv);
  return {
    id: backendId,
    label: adapter.displayName,
    docsPath: "/providers/models",
    auth: [] as never[],
    ...(catalog && flags.models
      ? {
          /**
           * The account's models, listed by the CLI itself. Without a working login the CLI cannot
           * list anything, so only the default model is offered and the host shows it unavailable.
           */
          catalog: {
            order: "late" as const,
            async run(context: CatalogContext) {
              context.signal?.throwIfAborted();
              if (context.providerIds && !context.providerIds.some((id) => id.toLowerCase() === backendId)) return null;
              const pluginConfig = context.config?.plugins?.entries?.[PLUGIN_ID]?.config;
              const command = readBackendConfig(pluginConfig, backendId, () => {}).command ?? adapter.command;
              // The listing and the probe run with the same clean env as a turn.
              const env = probeEnv(context.env);
              const status = await adapter.probeAuth({
                command,
                env,
                ...(context.signal ? { signal: context.signal } : {}),
              });
              context.signal?.throwIfAborted();
              // Images are offered only when the manifest decided the adapter handles them (P13).
              const input: Array<"text" | "image"> = flags.images ? ["text", "image"] : ["text"];
              const rows =
                status === "available"
                  ? await catalog.list({ command, env, ...(context.signal ? { signal: context.signal } : {}) })
                  : [defaultCatalogRow(adapter)];
              return {
                provider: { baseUrl: CLI_BASE_URL, api: CLI_PLACEHOLDER_API, models: rows.map((row) => toModelDefinition(row, input)) },
              };
            },
          },
        }
      : {}),
    async prepareSyntheticAuth(context: DiscoveryContext) {
      context.signal?.throwIfAborted();
      // P2: undecided, the CLI's login does not count as auth and nothing is probed.
      if (!flags.auth) return undefined;
      if (!context.config || context.provider?.toLowerCase() !== backendId) return undefined;
      const pluginConfig = context.config.plugins?.entries?.[PLUGIN_ID]?.config;
      const settings = readBackendConfig(pluginConfig, backendId, () => {});
      const status = await adapter.probeAuth({
        command: settings.command ?? adapter.command,
        env: probeEnv(context.env),
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
