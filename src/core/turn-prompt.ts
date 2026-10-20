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

/** Whether the host serves a shell tool for this turn, and the launch args without the marker. */
export function splitHostShell(ctx: ExecuteContext): { hostShell: boolean; args: string[] } {
  // The system-prompt marker is the host's to read, never the CLI's: strip it if a host passes it on.
  return {
    hostShell: ctx.args.includes(HOST_SHELL_ARG),
    args: ctx.args.filter((arg) => arg !== HOST_SHELL_ARG && arg !== SYSTEM_PROMPT_TRANSPORT_MARKER),
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
