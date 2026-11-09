import { splitMcpArgs } from "./mcp-target.ts";
import { SYSTEM_PROMPT_TRANSPORT_MARKER, neutralizeBlockMarkers } from "./system-prompt.ts";
import type { ExecutionMode } from "./ports.ts";
import type { ExecuteContext } from "./sdk-types.ts";

/**
 * AD-2, AD-5: names OpenClaw and its tool, never a CLI. The host refuses to copy history across
 * an auth boundary, so the model reads it through a tool that stays under OpenClaw's policy.
 */
export const CONTINUITY_NOTE =
  "[OpenClaw] This chat is part of an OpenClaw conversation. Turns answered by other models, before this chat started or between your turns, are not in your context. " +
  'When the user refers to something you cannot see here, read the conversation with the OpenClaw tool `sessions_history` (sessionKey "current") before you answer, if that tool is available.';

/**
 * An argument the backend's `resolveExecutionArgs` appends when the host serves its own `exec` for
 * the run (`hostOwnedTools`), which `execute` does not receive otherwise. `execute` removes it
 * before the CLI is launched and tells the adapter through `OpenParams.hostShell`.
 */
export const HOST_SHELL_ARG = "--openclaw-all-cli:host-shell";

/** The tool whose presence in the host's tool list makes a turn a host-shell turn. */
export const HOST_SHELL_TOOL = "exec";

/** The tool that polls a command `exec` moved to the background. */
export const HOST_PROCESS_TOOL = "process";

/**
 * AD-2: names OpenClaw and its tools, never a CLI. The CLI's own shell is refused by its config
 * without the host being asked, so the model learns where commands run from this sentence (issue #76).
 * Without `process` a command cannot be polled, so the text says to keep commands short instead.
 */
export function shellNote(hasProcess: boolean): string {
  return (
    "[OpenClaw] The native shell is disabled in this chat. Run commands with the OpenClaw `exec` tool. " +
    (hasProcess
      ? "Run long commands in the background and poll them with the OpenClaw `process` tool."
      : "Keep commands short: a command that runs too long is stopped.")
  );
}

/** The tool a run with an `outputSchema` must end by calling; the host fails the run without that call. */
export const HOST_STRUCTURED_TOOL = "structured_output";

/**
 * AD-2: names OpenClaw and its tool, never a CLI. A model that does not infer the need from the tool's
 * description answers in prose and the run fails, so the prompt says it (issue #75). No re-prompt follows.
 */
export function structuredOutputNote(): string {
  return "[OpenClaw] Give your final answer by calling the OpenClaw `structured_output` tool. An answer in prose alone fails the run.";
}

/**
 * What the host put into the launch args: whether it serves a shell tool for this turn, the path of
 * its MCP config file, and the launch args without any of that (the CLI must not see the host's flags).
 */
export function splitHostShell(ctx: ExecuteContext): { hostShell: boolean; mcpConfigPath: string | undefined; args: string[] } {
  // The system-prompt marker is the host's to read, never the CLI's: strip it if a host passes it on.
  const { args, mcpConfigPath } = splitMcpArgs(ctx.args);
  return {
    hostShell: ctx.args.includes(HOST_SHELL_ARG),
    mcpConfigPath,
    args: args.filter((arg) => arg !== HOST_SHELL_ARG && arg !== SYSTEM_PROMPT_TRANSPORT_MARKER),
  };
}

/** A side question runs beside the chat, never in it (AD-13: mode is part of the reuse key). */
export function modeOf(ctx: ExecuteContext): ExecutionMode {
  return ctx.executionMode === "side-question" ? "side-question" : "agent";
}

/**
 * `system` is the block, when this turn sends one. With a system prompt on, the rest of the turn's
 * text (user text and both contexts, which may carry channel messages or tool output) is stripped of
 * the block's header and tags, so it can never pass for a system block.
 */
export function composePrompt(ctx: ExecuteContext, note?: string, system?: string, guard = false, promptText = ctx.prompt): string {
  const { prependContext, appendContext } = ctx.promptContext ?? {};
  const plain = (text: string | undefined) => (guard && text ? neutralizeBlockMarkers(text) : text);
  return [system, note, plain(prependContext), plain(promptText), plain(appendContext)].filter((part): part is string => Boolean(part)).join("\n\n");
}
