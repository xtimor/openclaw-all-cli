import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
import { CliError, type CliErrorInfo, type NormalizedEvent, type PermissionDecision } from "../../core/ports.ts";
import type { AcpPermissionRequest, AcpSessionOptions } from "./session.ts";
import { ToolCallTable, isRecord, mergeToolFacts, type DescribeToolCall } from "./tool-calls.ts";

/**
 * The process and the client side of one ACP session: spawning and killing the process, answering
 * the agent's permission requests, and folding its updates into a turn's events.
 */

const STDERR_TAIL_CHARS = 600;
export const KILL_GRACE_MS = 2_000;
const EXIT_SETTLE_MS = 500;

export type TurnQueue = { push(event: NormalizedEvent): void; end(): void };
type PendingPermission = { resolve: (response: acp.RequestPermissionResponse) => void };
type ToolCallFacts = { rawInput?: Record<string, unknown>; paths: string[] };

/** The agent reports a tool call before it asks about it; keep this many calls' facts. */
const MAX_TOOL_CALL_FACTS = 256;

/** Everything the ACP client callbacks and the session share. */
export type Runtime = {
  child: ChildProcess;
  exited: Promise<void>;
  hasExited: boolean;
  spawnError?: Error;
  stderrTail: string;
  turn?: TurnQueue;
  pending: Set<PendingPermission>;
  /** What `tool_call` updates said about each call of the running turn, for permission requests. */
  toolCalls: Map<string, ToolCallFacts>;
  describeToolCall?: DescribeToolCall;
  /** The running turn's tool calls, folded into `toolStart` and `toolResult` events. */
  tools?: ToolCallTable;
  /** The adapter's recogniser for a failure the agent sends as reply text. */
  classifyReplyError?: (text: string) => CliErrorInfo | undefined;
  /**
   * A text chunk the adapter recognised as a failure, held back until the turn shows whether it was
   * the last thing said. Anything after it flushes it as ordinary text.
   */
  held?: { text: string; error: CliErrorInfo };
};

/** Pushes a held chunk as ordinary text: something followed it, so it was not the end of the turn. */
function flushHeld(runtime: Runtime, turn: TurnQueue): void {
  const held = runtime.held;
  if (!held) return;
  runtime.held = undefined;
  turn.push({ kind: "text", text: held.text });
}

/** What the adapter's hook says about a chunk; a throwing hook counts as "not an error". */
function classifyChunk(runtime: Runtime, text: string): CliErrorInfo | undefined {
  if (!runtime.classifyReplyError || !text) return undefined;
  try {
    return runtime.classifyReplyError(text);
  } catch {
    return undefined;
  }
}

/** The error for a process that is gone: a missing binary, or an exit nobody asked for. */
export function deathError(runtime: Runtime, command: string, retryable = true): CliError {
  if (runtime.spawnError) {
    const missing = (runtime.spawnError as NodeJS.ErrnoException).code === "ENOENT";
    return new CliError({
      code: missing ? "cli_not_found" : "server_error",
      message: missing
        ? `Could not find the CLI binary "${command}". Install it or set its path in the plugin config.`
        : `Could not start "${command}": ${runtime.spawnError.message}`,
    });
  }
  const tail = runtime.stderrTail.trim();
  return new CliError({
    code: "server_error",
    message: `The CLI process exited unexpectedly${tail ? `: ${tail}` : "."}`,
    retryable,
  });
}

/** SIGTERM now, SIGKILL if the process is still there after the grace period. */
export function terminate(runtime: Runtime): void {
  if (runtime.hasExited) return;
  runtime.child.kill("SIGTERM");
  const forceKill = setTimeout(() => runtime.child.kill("SIGKILL"), KILL_GRACE_MS);
  forceKill.unref();
  void runtime.exited.then(() => clearTimeout(forceKill));
}

export function assertDirectory(cwd: string): void {
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    // Reported below.
  }
  if (!isDirectory) {
    throw new CliError({ code: "unclassified", message: `The working directory "${cwd}" does not exist.` });
  }
}

export function cancelPermissions(runtime: Runtime): void {
  for (const entry of [...runtime.pending]) {
    runtime.pending.delete(entry);
    entry.resolve({ outcome: { outcome: "cancelled" } });
  }
}

/** Merges what a `tool_call` or `tool_call_update` says into the facts kept for that call. */
function rememberToolCall(
  runtime: Runtime,
  update: { toolCallId: string; rawInput?: unknown; locations?: Array<{ path: string }> | null },
): void {
  const facts = runtime.toolCalls.get(update.toolCallId) ?? { paths: [] };
  mergeToolFacts(facts, update);
  runtime.toolCalls.delete(update.toolCallId);
  runtime.toolCalls.set(update.toolCallId, facts);
  if (runtime.toolCalls.size > MAX_TOOL_CALL_FACTS) {
    const oldest = runtime.toolCalls.keys().next();
    if (!oldest.done) runtime.toolCalls.delete(oldest.value);
  }
}

/** Waits for the process to exit, but at most a moment. A dead process closes its pipes before `exit` fires. */
export function settleExit(runtime: Runtime): Promise<unknown> {
  return Promise.race([runtime.exited, new Promise((resolve) => setTimeout(resolve, EXIT_SETTLE_MS))]);
}

/** Spawns the process and starts watching its exit, its stderr, and its pipes. */
export function spawnRuntime(options: AcpSessionOptions): Runtime {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // A process that failed to spawn has no pid; its `error` event reports why.
  if (child.pid !== undefined) {
    try {
      options.onProcessStart?.(child.pid);
    } catch {
      // A failing observer must not leak the process it was told about.
    }
  }

  const runtime: Runtime = {
    child,
    hasExited: false,
    stderrTail: "",
    pending: new Set(),
    toolCalls: new Map(),
    ...(options.describeToolCall ? { describeToolCall: options.describeToolCall } : {}),
    ...(options.classifyReplyError ? { classifyReplyError: options.classifyReplyError } : {}),
    exited: Promise.resolve(),
  };
  runtime.exited = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      runtime.spawnError = error;
      runtime.hasExited = true;
      resolve();
    });
    child.once("exit", () => {
      runtime.hasExited = true;
      resolve();
    });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    runtime.stderrTail = (runtime.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });
  // A closed pipe after the process dies must not crash the host with an unhandled error.
  child.stdin?.on("error", () => {});
  return runtime;
}

/** A permission request joined with what the earlier `tool_call` updates said about the same call. */
function permissionRequest(runtime: Runtime, params: acp.RequestPermissionRequest): AcpPermissionRequest {
  const call = params.toolCall;
  const known = runtime.toolCalls.get(call.toolCallId);
  const paths = [...(known?.paths ?? [])];
  for (const location of call.locations ?? []) if (!paths.includes(location.path)) paths.push(location.path);
  const rawInput = isRecord(call.rawInput) ? call.rawInput : known?.rawInput;
  return {
    toolCallId: call.toolCallId,
    title: call.title ?? "tool call",
    ...(call.kind ? { kind: call.kind } : {}),
    ...(rawInput ? { rawInput } : {}),
    paths,
    content: call.content ?? [],
    optionIds: params.options.map((item) => item.optionId),
  };
}

/** The ACP client callbacks: permission requests from the agent, and the updates of the running turn. */
export function createClient(runtime: Runtime, onPermissionRequest: AcpSessionOptions["onPermissionRequest"]): acp.Client {
  return {
    requestPermission(params) {
      // An approved call may run without ever being announced: it still counts as a tool (AD-11).
      if (runtime.tools) runtime.tools.started = true;
      if (runtime.turn) flushHeld(runtime, runtime.turn);
      const request = permissionRequest(runtime, params);
      return new Promise<acp.RequestPermissionResponse>((resolve) => {
        const entry: PendingPermission = { resolve };
        runtime.pending.add(entry);
        const settle = (decision: PermissionDecision) => {
          if (!runtime.pending.delete(entry)) return;
          const kind = decision === "allow_once" ? "allow_once" : "reject_once";
          const option = decision === "cancelled" ? undefined : params.options.find((item) => item.kind === kind);
          resolve(
            option
              ? { outcome: { outcome: "selected", optionId: option.optionId } }
              : { outcome: { outcome: "cancelled" } },
          );
        };
        Promise.resolve()
          .then(() => onPermissionRequest(request))
          .then(settle, () => settle("cancelled"));
      });
    },
    sessionUpdate(params) {
      // Updates outside a prompt are history replays from `session/load`; drop them.
      const turn = runtime.turn;
      if (!turn) return;
      const update = params.update;
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        flushHeld(runtime, turn);
        rememberToolCall(runtime, update);
        for (const event of runtime.tools?.update(update) ?? []) turn.push(event);
        return;
      }
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        // An empty chunk says nothing: it must not flush a held failure.
        if (!update.content.text) return;
        flushHeld(runtime, turn);
        const error = classifyChunk(runtime, update.content.text);
        if (error) runtime.held = { text: update.content.text, error };
        else turn.push({ kind: "text", text: update.content.text });
      } else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
        flushHeld(runtime, turn);
        turn.push({ kind: "thinking", text: update.content.text });
      }
    },
  };
}

/** The events of a running turn: the client callbacks push, the consumer loop takes. */
export function createTurnChannel() {
  const buffer: NormalizedEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const queue: TurnQueue = {
    push: (event) => {
      buffer.push(event);
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
  };
  return {
    queue,
    take: () => buffer.shift(),
    get ended() {
      return ended;
    },
    wait: () =>
      new Promise<void>((resolve) => {
        wake = () => {
          wake = undefined;
          resolve();
        };
      }),
  };
}
