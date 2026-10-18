import { capsOf, type BackendConfig } from "./config.ts";
import { parseJsonlEvent } from "./events.ts";
import { createExecute, errorRecord, type ExecuteOptions } from "./execute.ts";
import { prepareAgentHome } from "./home.ts";
import { deriveFlags } from "./manifest.ts";
import { unenforceableNativeTools } from "./permissions.ts";
import type { CliAdapter } from "./ports.ts";
import { ProcessPool } from "./pool.ts";
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
  /** Receives warnings, for example a turn that runs without OpenClaw tools. */
  warn?: (message: string) => void;
  /** The backend's limits (AD-14). Absent: a pool sized from `settings`. The registrar passes its own to close it on unload. */
  pool?: ProcessPool;
};

/**
 * Builds the OpenClaw CLI backend for one adapter. Backend flags come from the adapter's
 * manifest alone (AD-10); everything CLI-specific stays in the adapter.
 */
export function buildCliBackend(adapter: CliAdapter, options: BuildBackendOptions): CliBackendPlugin {
  const flags = deriveFlags(adapter.manifest);
  const command = options.settings.command ?? adapter.command;
  const args = [...adapter.launchArgs];
  const pool = options.pool ?? new ProcessPool(capsOf(options.settings));

  return {
    id: backendIdFor(adapter),
    liveTest: {
      defaultModelRef: adapter.defaultModel,
      defaultImageProbe: false,
      defaultMcpProbe: false,
    },
    // P10: the host selects native tools per run through `ctx.toolAvailability`; `prepareExecution`
    // confirms only a selection it enforces. Without that, the host fails closed for restricted runs.
    ...(flags.toolPolicy
      ? { nativeToolMode: "selectable" as const, toolAvailabilityEnforcement: "prepare-execution" as const }
      : { nativeToolMode: "always-on" as const }),
    ...(flags.mcp
      ? {
          // P7: the host writes the turn's loopback URL and headers to a settings file, and the
          // MCP proxy (AD-12) reads it. The file is the only reason these flags are set.
          bundleMcp: true,
          bundleMcpMode: "gemini-system-settings" as const,
          hostOwnedTools: ["exec", "process"],
        }
      : {}),
    // P18: the host runs a side question (`executionMode: "side-question"`) without OpenClaw's
    // tools; the adapter opens it in its read-only mode with no MCP server and rejects every
    // permission request. Native readers the CLI keeps open stay (see the P18 row).
    ...(flags.sideQuestion ? { sideQuestionToolMode: "disabled" as const } : {}),
    config: {
      command,
      args,
      // OpenClaw resumes only when `resumeArgs` is set; the adapter resumes by ID itself.
      ...(flags.resume
        ? {
            resumeArgs: args,
            // P5: a resume the CLI refuses is a `session_expired` error. The host then starts a
            // fresh chat with its own history only when the error proves the chat is gone.
            freshSessionRecovery: "invalidated-only" as const,
          }
        : {}),
      // The host deletes these keys from the Gateway's env before a turn; the core applies the same list to its own probes.
      clearEnv: [...adapter.clearEnv],
      output: "jsonl",
      input: "stdin",
      ...(flags.liveSession ? { liveSession: "claude-stdio" as const } : {}),
      // P15: lets the host retry a lost chat with its own history (same as `claude-cli`).
      ...(flags.history ? { reseedFromRawTranscriptWhenUncompacted: true } : {}),
      sessionMode: "existing",
      ...(adapter.modelAliases ? { modelAliases: { ...adapter.modelAliases } } : {}),
    },
    parseJsonlEvent: (line) => parseJsonlEvent(line),
    prepareExecution: async (ctx) => {
      // The run's native selection must be one the adapter enforces: it cannot switch off the
      // tools its permission file keeps open. Refuse before any process starts (AD-9).
      const blocked = ctx.toolAvailability
        ? unenforceableNativeTools(ctx.toolAvailability, adapter.alwaysOnNativeTools)
        : [];
      if (blocked.length > 0) {
        throw new Error(
          `${backendIdFor(adapter)} keeps native ${blocked.join(", ")} on in every turn and cannot switch ${blocked.length > 1 ? "them" : "it"} off for this run. ` +
            "Select those native tools or run this turn on another model. OpenClaw did not start the run.",
        );
      }
      // Only a selection the adapter enforces is confirmed; a run without one needs no confirmation.
      const enforced = ctx.toolAvailability ? { toolAvailabilityEnforced: true as const } : {};
      try {
        const home = await prepareAgentHome(adapter, backendIdFor(adapter), ctx.agentDir, options.warn);
        return {
          ...enforced,
          execute: createExecute(adapter, {
            ...options.execute,
            home,
            pool,
            mcp: flags.mcp,
            continuity: flags.history && flags.mcp,
            ...(ctx.authProfileId ? { authProfileId: ctx.authProfileId } : {}),
            ...(options.warn ? { warn: options.warn } : {}),
          }),
        };
      } catch (error) {
        // Fail the turn the way an open failure does: an error record, never a shared home.
        const record = errorRecord(error);
        return {
          ...enforced,
          execute: async function* () {
            yield record;
          },
        };
      }
    },
  };
}
