import { z } from "zod";

/** Settings of one backend under `plugins.entries.openclaw-all-cli.config.<backendId>`. */
export const backendConfigSchema = z
  .object({
    /** Path or name of the CLI binary. Defaults to the adapter's command. */
    command: z.string().min(1).optional(),
  })
  .strict();
export type BackendConfig = z.infer<typeof backendConfigSchema>;

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

/** Reads one backend's settings. Invalid settings fall back to defaults and are reported. */
export function readBackendConfig(
  pluginConfig: Record<string, unknown> | undefined,
  backendId: string,
  warn: (message: string) => void,
): BackendConfig {
  const parsed = backendConfigSchema.safeParse(pluginConfig?.[backendId] ?? {});
  if (parsed.success) return parsed.data;
  warn(`Ignoring invalid config for ${backendId}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  return {};
}
