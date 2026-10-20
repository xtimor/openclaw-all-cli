import { z } from "zod";
import { DEFAULT_MAX_PROCESSES, DEFAULT_MAX_TURNS } from "./pool.ts";

/** Settings of one backend under `plugins.entries.openclaw-all-cli.config.<backendId>`. */
const backendConfigSchema = z
  .object({
    /** Path or name of the CLI binary. Defaults to the adapter's command. */
    command: z.string().min(1).optional(),
    /**
     * Variables given only to the CLI process (and the plugin's own probes), never to the Gateway's
     * environment. Put an API key here instead of exporting it: a command the model runs through
     * OpenClaw `exec` inherits the Gateway's environment, and so could read the key.
     */
    env: z.record(z.string().min(1), z.string()).optional(),
    /** Turns that run at once (AD-14). Later turns wait their turn. */
    maxConcurrentTurns: z.number().int().min(1).max(64).optional(),
    /** CLI processes alive at once, idle ones included. At least `maxConcurrentTurns`. */
    maxProcesses: z.number().int().min(1).max(64).optional(),
  })
  .strict()
  .refine(
    (config) => (config.maxProcesses ?? DEFAULT_MAX_PROCESSES) >= (config.maxConcurrentTurns ?? DEFAULT_MAX_TURNS),
    { message: "maxProcesses must be at least maxConcurrentTurns", path: ["maxProcesses"] },
  );
export type BackendConfig = z.infer<typeof backendConfigSchema>;

/** The caps a backend runs with: its settings, or the defaults. */
export function capsOf(settings: BackendConfig): { maxTurns: number; maxProcesses: number } {
  return {
    maxTurns: settings.maxConcurrentTurns ?? DEFAULT_MAX_TURNS,
    maxProcesses: settings.maxProcesses ?? DEFAULT_MAX_PROCESSES,
  };
}

/** The plugin's config schema: one optional object per backend ID. */
export function buildConfigSchema(backendIds: readonly string[]) {
  const shape = Object.fromEntries(backendIds.map((id) => [id, backendConfigSchema.optional()]));
  return z.object(shape).strict();
}

/** The JSON Schema for `openclaw.plugin.json` `configSchema`. */
export function buildConfigJsonSchema(backendIds: readonly string[]) {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(buildConfigSchema(backendIds), { io: "input" }) as Record<
    string,
    unknown
  >;
  return schema;
}

const CAP_KEYS = ["maxConcurrentTurns", "maxProcesses"] as const;

/**
 * Reads one backend's settings. Invalid settings fall back to defaults and are reported. When
 * only the caps are at fault (processes below turns, for example), the other valid settings, such
 * as `command`, are kept and only the caps return to their defaults.
 */
export function readBackendConfig(
  pluginConfig: Record<string, unknown> | undefined,
  backendId: string,
  warn: (message: string) => void,
): BackendConfig {
  const raw = pluginConfig?.[backendId] ?? {};
  const parsed = backendConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const reason = parsed.error.issues.map((issue) => issue.message).join("; ");
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const withoutCaps = Object.fromEntries(Object.entries(raw).filter(([key]) => !(CAP_KEYS as readonly string[]).includes(key)));
    const rest = backendConfigSchema.safeParse(withoutCaps);
    if (rest.success) {
      warn(`Ignoring the invalid caps for ${backendId}, using the defaults: ${reason}`);
      return rest.data;
    }
  }
  warn(`Ignoring invalid config for ${backendId}: ${reason}`);
  return {};
}
