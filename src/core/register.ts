import { backendIdFor, buildCliBackend } from "./backend.ts";
import { buildConfigSchema, readBackendConfig } from "./config.ts";
import type { CliAdapter } from "./ports.ts";
import type { OpenClawPluginApi } from "./sdk-types.ts";

/** Registers one CLI backend per adapter (AD-1). */
export function registerAdapters(api: OpenClawPluginApi, adapters: readonly CliAdapter[]): void {
  for (const adapter of adapters) {
    const settings = readBackendConfig(api.pluginConfig, backendIdFor(adapter), (message) => api.logger.warn(message));
    api.registerCliBackend(buildCliBackend(adapter, { settings }));
  }
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
