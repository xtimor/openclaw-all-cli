import { capsOf, type BackendConfig } from "./config.ts";
import { parseJsonlEvent } from "./events.ts";
import { HOST_SHELL_ARG, createExecute, errorRecord, type ExecuteOptions } from "./execute.ts";
import { prepareAgentHome } from "./home.ts";
import { deriveFlags } from "./manifest.ts";
import { unenforceableNativeTools } from "./permissions.ts";
import type { CliAdapter } from "./ports.ts";
import { ProcessPool } from "./pool.ts";
import { SYSTEM_PROMPT_TRANSPORT_MARKER } from "./system-prompt.ts";
import type { CliBackendPlugin, PrepareExecutionContext } from "./sdk-types.ts";

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
  execute?: Pick<ExecuteOptions, "idleMs" | "abortGraceMs" | "callDeadlineMs" | "imageRoots">;
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
    // P19: the host's live-test defaults, read only by its own tests, never at runtime.
    ...(flags.liveTest
      ? {
          liveTest: {
            defaultModelRef: adapter.defaultModel,
            defaultImageProbe: flags.images,
            defaultMcpProbe: flags.mcp,
          },
        }
      : {}),
    // P10: the host selects native tools per run through `ctx.toolAvailability`. Like claude-cli, the
    // backend declares `execution-args`: `resolveExecutionArgs` confirms only a selection the adapter
    // enforces (nullish makes the host fail the run), and the host then serves its own tools (P8).
    ...(flags.toolPolicy
      ? {
          nativeToolMode: "selectable" as const,
          toolAvailabilityEnforcement: "execution-args" as const,
          // The launch args stay the host's `baseArgs`; when the host serves its `exec` for this run, a
          // marker rides along for `execute` to read and strip (see `HOST_SHELL_ARG`).
          resolveExecutionArgs: resolveExecutionArgsFor(adapter),
        }
      : { nativeToolMode: "always-on" as const }),
    ...(flags.mcp
      ? {
          // P7: the host writes the turn's loopback URL and headers to a config file named by
          // `--mcp-config`, and the MCP proxy (AD-12) reads it. The file is the only reason these
          // flags are set; `execute` strips them before the launch. The mode matters for P4: the
          // host's live-session fingerprint ignores that flag's value (as for `claude-cli`), while the
          // `gemini-system-settings` mode puts a new file path into the env, which restarts the
          // process every turn.
          bundleMcp: true,
          bundleMcpMode: "claude-config-file" as const,
        }
      : {}),
    // P8: the host serves its own exec tools in place of the CLI's native shell. It does so only for
    // `execution-args` (P10) and over its MCP loopback (P7), so all three rows must be decided.
    ...(flags.hostTools && flags.toolPolicy && flags.mcp ? { hostOwnedTools: ["exec", "process"] } : {}),
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
      // A safety list, applied whenever the adapter declares one (not gated by a row): the host deletes these keys from the Gateway's env before a turn; the core applies the same list to its own probes.
      clearEnv: [...adapter.clearEnv],
      // The plugin config's `env`: the host gives it to the CLI process only, not to host tools like `exec`.
      ...(options.settings.env && Object.keys(options.settings.env).length > 0 ? { env: { ...options.settings.env } } : {}),
      // P12: the plugin delivers the system prompt itself (AD-15). The marker makes the host keep a
      // chat whose system prompt drifts; it never reaches a plugin-owned execute's launch.
      ...(flags.systemPrompt
        ? { systemPromptArg: SYSTEM_PROMPT_TRANSPORT_MARKER, systemPromptWhen: "always" as const }
        : {}),
      output: "jsonl",
      input: "stdin",
      ...(flags.liveSession ? { liveSession: "claude-stdio" as const } : {}),
      // P15: lets the host retry a lost chat with its own history (same as `claude-cli`).
      ...(flags.history ? { reseedFromRawTranscriptWhenUncompacted: true } : {}),
      sessionMode: "existing",
      // P1: the adapter's own spellings of its models.
      ...(flags.models && adapter.modelAliases ? { modelAliases: { ...adapter.modelAliases } } : {}),
    },
    parseJsonlEvent: (line) => parseJsonlEvent(line),
    prepareExecution: prepareExecutionFor(adapter, flags, pool, options),
  };
}

/**
 * `resolveExecutionArgs` for one backend. A selection that lists native `exec` is accepted although
 * the CLI can never run it (`Shell(*)` is denied): over-restrictive, not a bypass. Refusing it would
 * break runs that select every native tool.
 */
function resolveExecutionArgsFor(adapter: CliAdapter): NonNullable<CliBackendPlugin["resolveExecutionArgs"]> {
  const enforceableSelection = (availability: PrepareExecutionContext["toolAvailability"]): boolean =>
    !availability || unenforceableNativeTools(availability, adapter.alwaysOnNativeTools).length === 0;
  return (ctx) =>
    !enforceableSelection(ctx.toolAvailability)
      ? undefined
      : ctx.hostOwnedTools?.includes("exec")
        ? [...ctx.baseArgs, HOST_SHELL_ARG]
        : ctx.baseArgs;
}

/**
 * `prepareExecution` for one backend: refuses a tool selection the adapter cannot enforce, prepares
 * the agent's home, and returns the run's `execute`.
 */
function prepareExecutionFor(
  adapter: CliAdapter,
  flags: ReturnType<typeof deriveFlags>,
  pool: ProcessPool,
  options: BuildBackendOptions,
): NonNullable<CliBackendPlugin["prepareExecution"]> {
  return async (ctx) => {
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
    try {
      const home = await prepareAgentHome(adapter, backendIdFor(adapter), ctx.agentDir, options.warn);
      return {
        execute: createExecute(adapter, {
          ...options.execute,
          home,
          pool,
          mcp: flags.mcp,
          approvals: flags.approvals,
          usage: flags.usage,
          continuity: flags.history && flags.mcp,
          systemPrompt: flags.systemPrompt,
          images: flags.images,
          ...(ctx.authProfileId ? { authProfileId: ctx.authProfileId } : {}),
          ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
          ...(options.warn ? { warn: options.warn } : {}),
        }),
      };
    } catch (error) {
      // Fail the turn the way an open failure does: an error record, never a shared home.
      const record = errorRecord(error);
      return {
        execute: async function* () {
          yield record;
        },
      };
    }
  };
}
