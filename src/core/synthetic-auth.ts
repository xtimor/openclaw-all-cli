import { isPluginSupplied, readStoredKey, resolveCliKey, type ReadStoredKey } from "./auth-store.ts";
import { nativeAuthMarkerFor, backendIdFor } from "./backend.ts";
import { defaultCatalogRow, type CatalogRow, type ModelCatalog } from "./catalog.ts";
import { readBackendConfig } from "./config.ts";
import { withoutKeys } from "./env.ts";
import { homeDirFor } from "./home.ts";
import { withThrowawayKeyCache } from "./key-cache.ts";
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
  /** The main agent's directory: the listing's process is recorded in its home. Absent: the listing is not recorded. */
  agentDir?: string;
  /** Providers the host asks about; absent means all. */
  providerIds?: readonly string[];
};

/** A catalog row in the shape of OpenClaw's model definition. The CLI reports no price or limits; a window is set only when the adapter knows it, else the host's default applies. */
function toModelDefinition(row: CatalogRow, input: Array<"text" | "image">) {
  return {
    id: row.id,
    name: row.name,
    // A model whose CLI shows an effort setting lets OpenClaw's Effort control through.
    reasoning: row.reasoning === true,
    input,
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
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
export function createSyntheticAuthProvider(adapter: CliAdapter, catalog?: ModelCatalog, options: { readKey?: ReadStoredKey } = {}) {
  const backendId = backendIdFor(adapter);
  const flags = deriveFlags(adapter.manifest);
  const readKey = options.readKey ?? readStoredKey;
  /**
   * The probes and the listing run with the same clean env as a turn: the Gateway's without the
   * cleared keys, the plugin config's `env`, and a key from OpenClaw's auth store, which wins as it
   * does in a turn (the profile the API key method saves; the main agent's store without an agent).
   * `isolate` says the key came from the plugin, so a CLI run with it caches the key in a throwaway
   * folder, never in the user's own config.
   */
  const probeEnv = async (env: Record<string, string | undefined> | undefined, extra: Record<string, string> | undefined, agentDir?: string) => {
    const keyVar = adapter.apiKeyEnvVar;
    const base = { ...withoutKeys(env ?? process.env, adapter.clearEnv), ...extra };
    if (!keyVar) return { env: base, isolate: false };
    const resolved = await resolveCliKey({ readKey, keyVar, provider: backendId, agentDir, pluginEnv: extra, env: base });
    return {
      env: { ...base, ...(resolved.source === "store" ? { [keyVar]: resolved.key } : {}) },
      isolate: Boolean(resolved.key) && isPluginSupplied(resolved),
    };
  };
  /** The login probe; with a key from the plugin, any CLI process it starts caches the key in a throwaway folder. */
  const probe = (command: string, env: Record<string, string | undefined>, isolate: boolean, home: string | undefined, signal: AbortSignal | undefined) => {
    const run = (cacheEnv: Readonly<Record<string, string>>) => adapter.probeAuth({ command, env: { ...env, ...cacheEnv }, ...(signal ? { signal } : {}) });
    return isolate ? withThrowawayKeyCache(adapter, home, run) : run({});
  };
  return {
    id: backendId,
    label: adapter.providerLabel ?? adapter.displayName,
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
              const settings = readBackendConfig(pluginConfig, backendId, () => {});
              const command = settings.command ?? adapter.command;
              // The listing and the probe run with the same clean env as a turn.
              const agentDir = context.agentDir?.trim() || undefined;
              const { env, isolate } = await probeEnv(context.env, settings.env, agentDir);
              context.signal?.throwIfAborted();
              const home = agentDir ? homeDirFor(agentDir, backendId) : undefined;
              const status = await probe(command, env, isolate, home, context.signal);
              context.signal?.throwIfAborted();
              // Images are offered only when the manifest decided the adapter handles them (P13).
              const input: Array<"text" | "image"> = flags.images ? ["text", "image"] : ["text"];
              const rows =
                status === "available"
                  ? await catalog.list({
                      command,
                      env,
                      ...(context.signal ? { signal: context.signal } : {}),
                      ...(home ? { lockDir: home } : {}),
                      ...(isolate ? { isolateKey: true } : {}),
                    })
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
      const { env, isolate } = await probeEnv(context.env, settings.env);
      context.signal?.throwIfAborted();
      const status = await probe(settings.command ?? adapter.command, env, isolate, undefined, context.signal);
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
