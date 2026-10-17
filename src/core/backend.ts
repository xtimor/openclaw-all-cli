import type { BackendConfig } from "./config.ts";
import { parseJsonlEvent } from "./events.ts";
import { createExecute, errorRecord, type ExecuteOptions } from "./execute.ts";
import { prepareAgentHome } from "./home.ts";
import { deriveFlags } from "./manifest.ts";
import type { CliAdapter } from "./ports.ts";
import type { CliBackendPlugin } from "./sdk-types.ts";

/** The backend ID and model-ref prefix for an adapter (AD-1). */
export function backendIdFor(adapter: CliAdapter): string {
  return `${adapter.id}-cli`;
}

/** Marker OpenClaw stores in place of a key when the CLI's own login counts as auth. */
export function nativeAuthMarkerFor(adapter: CliAdapter): string {
  return `openclaw:${backendIdFor(adapter)}-native-auth`;
}

export type BuildBackendOptions = {
  settings: BackendConfig;
  execute?: Pick<ExecuteOptions, "idleMs" | "abortGraceMs">;
};

/**
 * Builds the OpenClaw CLI backend for one adapter. Backend flags come from the adapter's
 * manifest alone (AD-10); everything CLI-specific stays in the adapter.
 */
export function buildCliBackend(adapter: CliAdapter, options: BuildBackendOptions): CliBackendPlugin {
  const flags = deriveFlags(adapter.manifest);
  const command = options.settings.command ?? adapter.command;
  const args = [...adapter.launchArgs];

  return {
    id: backendIdFor(adapter),
    liveTest: {
      defaultModelRef: adapter.defaultModel,
      defaultImageProbe: false,
      defaultMcpProbe: false,
    },
    // Native read, grep and glob stay reachable; the host must fail closed for callers that
    // need no native tools until the tool-availability contract (entry 3) makes them selectable.
    nativeToolMode: "always-on",
    config: {
      command,
      args,
      // OpenClaw resumes only when `resumeArgs` is set; the adapter resumes by ID itself.
      ...(flags.resume ? { resumeArgs: args } : {}),
      output: "jsonl",
      input: "stdin",
      ...(flags.liveSession ? { liveSession: "claude-stdio" as const } : {}),
      sessionMode: "existing",
      ...(adapter.modelAliases ? { modelAliases: { ...adapter.modelAliases } } : {}),
    },
    parseJsonlEvent: (line) => parseJsonlEvent(line),
    prepareExecution: async (ctx) => {
      try {
        const home = await prepareAgentHome(adapter, backendIdFor(adapter), ctx.agentDir);
        return { execute: createExecute(adapter, { ...options.execute, home }) };
      } catch (error) {
        // Fail the turn the way an open failure does: an error record, never a shared home.
        const record = errorRecord(error);
        return {
          execute: async function* () {
            yield record;
          },
        };
      }
    },
  };
}
