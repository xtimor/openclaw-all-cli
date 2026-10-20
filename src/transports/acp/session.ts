import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  CliError,
  type CliCapability,
  type CliErrorInfo,
  type CliSession,
  type NormalizedEvent,
  type NormalizedUsage,
  type PermissionDecision,
  type PromptImage,
  type RequiredCapability,
} from "../../core/ports.ts";
import { setup, toCliError } from "./handshake.ts";
import {
  KILL_GRACE_MS,
  assertDirectory,
  cancelPermissions,
  createClient,
  createTurnChannel,
  deathError,
  settleExit,
  spawnRuntime,
  terminate,
  type Runtime,
  type TurnQueue,
} from "./runtime.ts";
import { ToolCallTable, type DescribeToolCall } from "./tool-calls.ts";

export type { AcpToolCallView, AcpToolDisplay, DescribeToolCall } from "./tool-calls.ts";

/**
 * A generic ACP client session over a spawned process. It knows no CLI: the adapter supplies
 * the command, the login method, the mode it needs, and the policy for permission requests.
 */

/**
 * A permission request as the agent sent it, joined with what its earlier `tool_call` updates
 * said about the same call. The adapter turns it into a canonical request (AD-2).
 */
export type AcpPermissionRequest = {
  toolCallId: string;
  title: string;
  kind?: string;
  /** The tool's raw input, when the agent reported it before or with the request. */
  rawInput?: Record<string, unknown>;
  /** Paths the call touches. */
  paths: string[];
  /** The request's own content blocks (a diff, a note, JSON arguments). */
  content: readonly acp.ToolCallContent[];
  /** The option IDs the agent offers. */
  optionIds: string[];
};

/** A model the agent offers: its exact ID and its own display name. */
export type AcpModelInfo = { id: string; name: string };

export type AcpSessionOptions = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** MCP servers handed to `session/new`. Empty until the MCP proxy exists. */
  mcpServers?: acp.McpServer[];
  /** ACP `authenticate` method ID, called when the agent lists it. */
  authMethodId?: string;
  /** Name used in a capability mismatch message. Default "The CLI". */
  displayName?: string;
  /**
   * Capabilities the adapter needs. A missing one fails the open right after `initialize`, before
   * the login, `session/new`, or `session/load`, with the core's `capability_mismatch` message.
   */
  requiredCapabilities?: readonly RequiredCapability[];
  /** Session mode the adapter requires. The session fails closed when the agent lacks it. */
  requiredModeId?: string;
  /** Exact model ID to select. Left unset (and without `selectModel`), the agent keeps its current model. */
  modelId?: string;
  /**
   * Picks the exact model ID from what the agent offers, so the adapter can map its own model
   * names onto the agent's IDs. Returns the ID to switch to, `null` to keep the current model, or
   * `undefined` when the agent has no such model. Wins over `modelId`.
   */
  selectModel?: (available: readonly AcpModelInfo[], currentId: string | undefined) => string | null | undefined;
  /** Native session to resume with `session/load`. */
  resumeSessionId?: string;
  /** Called once with the process ID right after the spawn, before the handshake. */
  onProcessStart?: (pid: number) => void;
  /** Answers a permission request. Throwing counts as `cancelled`. */
  onPermissionRequest: (request: AcpPermissionRequest) => Promise<PermissionDecision>;
  /**
   * Names a tool call for display. It cannot hide or filter a call: returning `undefined` only
   * defers the start by one update, and the final update falls back to the agent's own name.
   */
  describeToolCall?: DescribeToolCall;
  /**
   * Recognises a text chunk that is really a failure the agent reported as its reply. A recognised
   * chunk is held back: if the turn ends right after it (`end_turn`), the turn is that error and the
   * chunk is not part of the reply; if anything else follows (text, thinking, a tool), the chunk is
   * ordinary text and goes out in order. Retryable is cleared when a tool call started.
   */
  classifyReplyError?: (text: string) => CliErrorInfo | undefined;
  clientName?: string;
  clientVersion?: string;
  signal?: AbortSignal;
};

function mapUsage(usage: acp.Usage | null | undefined): NormalizedUsage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    ...(usage.cachedReadTokens != null ? { cacheRead: usage.cachedReadTokens } : {}),
    ...(usage.cachedWriteTokens != null ? { cacheWrite: usage.cachedWriteTokens } : {}),
    total: usage.totalTokens,
  };
}

export class AcpSession implements CliSession {
  private closed = false;

  private constructor(
    readonly sessionId: string,
    private readonly runtime: Runtime,
    private readonly connection: acp.ClientSideConnection,
    private readonly command: string,
    /** The models the agent offered when the session started. */
    readonly models: readonly AcpModelInfo[],
    /** What the agent reported in `initialize`, in the core's names. */
    readonly capabilities: ReadonlySet<CliCapability>,
  ) {}

  get pid(): number | undefined {
    return this.runtime.child.pid;
  }

  get alive(): boolean {
    return !this.closed && !this.runtime.hasExited;
  }

  /** Spawns the process, negotiates the protocol, and starts or resumes a session. */
  static async open(options: AcpSessionOptions): Promise<AcpSession> {
    options.signal?.throwIfAborted();
    assertDirectory(options.cwd);
    const runtime = spawnRuntime(options);
    const { child } = runtime;

    const clientHandler = createClient(runtime, options.onPermissionRequest);
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const connection = new acp.ClientSideConnection(() => clientHandler, stream);

    const stopOnAbort = () => terminate(runtime);
    options.signal?.addEventListener("abort", stopOnAbort, { once: true });

    const died = runtime.exited.then(() => {
      throw deathError(runtime, options.command);
    });
    // The race below may never read `died`; keep a lost race from becoming an unhandled rejection.
    died.catch(() => {});

    try {
      const started = await Promise.race([setup(connection, options), died]);
      return new AcpSession(started.sessionId, runtime, connection, options.command, started.models, started.capabilities);
    } catch (error) {
      return await failedOpen(runtime, options, error);
    } finally {
      options.signal?.removeEventListener("abort", stopOnAbort);
    }
  }

  async *prompt(text: string, images: readonly PromptImage[] = []): AsyncGenerator<NormalizedEvent> {
    const { runtime } = this;
    if (!this.alive || runtime.turn) {
      const message = this.alive ? "A turn is already running in this session." : "The CLI session is closed.";
      yield { kind: "error", error: { code: "server_error", retryable: !this.alive, message } };
      return;
    }

    const channel = createTurnChannel();
    runtime.turn = channel.queue;
    const tools = new ToolCallTable(runtime.describeToolCall);
    runtime.tools = tools;
    runtime.held = undefined;

    // A death after a tool call started is not retryable: the call may already have run (AD-11).
    const died = runtime.exited.then(() => {
      throw deathError(runtime, this.command, !tools.started);
    });
    died.catch(() => {});

    const { connection, sessionId, command } = this;
    const settled = settleTurn({ connection, sessionId, command, runtime, tools, queue: channel.queue, died, text, images });

    let reply = "";
    try {
      for (;;) {
        const next = channel.take();
        if (next) {
          if (next.kind === "text") reply += next.text;
          // The transport owns the accumulated reply, so the closing event carries the full text.
          yield next.kind === "result" ? { ...next, text: reply } : next;
          continue;
        }
        if (channel.ended) break;
        await channel.wait();
      }
    } finally {
      if (!channel.ended) await this.stopTurn(settled);
      await settled;
      runtime.turn = undefined;
      runtime.tools = undefined;
      runtime.held = undefined;
      runtime.toolCalls.clear();
    }
  }

  /**
   * The consumer stopped early (abort): stop the turn and let it settle. A CLI that ignores the
   * cancel gets the kill grace, then the process is closed.
   */
  private async stopTurn(settled: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), KILL_GRACE_MS);
    });
    const timedOut = await Promise.race([
      this.cancel().then(() => settled).then(() => false),
      gaveUp,
    ]);
    clearTimeout(timer);
    if (timedOut) await this.close();
  }

  async cancel(): Promise<void> {
    cancelPermissions(this.runtime);
    if (!this.alive) return;
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
    } catch {
      // The process may already be gone; close() handles the rest.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return this.runtime.exited;
    this.closed = true;
    cancelPermissions(this.runtime);
    this.runtime.child.stdin?.end();
    terminate(this.runtime);
    await this.runtime.exited;
  }

  waitForExit(): Promise<void> {
    return this.runtime.exited;
  }
}

/** The error of an open that failed: a death is reported as one, anything else as the failure it was. */
async function failedOpen(runtime: Runtime, options: AcpSessionOptions, error: unknown): Promise<never> {
  // A dead process closes its pipes before `exit` fires, and the pipe error can win the race
  // against the exit: give the exit a moment, so a death is reported as one (retryable).
  // A deliberate answer (a lost chat, a missing capability) is not a death, whatever follows.
  const deliberate = error instanceof CliError && error.code !== "server_error";
  if (!deliberate) {
    await settleExit(runtime);
  }
  const diedOnItsOwn = runtime.hasExited;
  terminate(runtime);
  await runtime.exited;
  options.signal?.throwIfAborted();
  if (runtime.spawnError || (diedOnItsOwn && !deliberate)) throw deathError(runtime, options.command);
  throw toCliError(error, "server_error", "The CLI session failed to start");
}

/** Everything one turn's prompt call needs besides the session itself. */
type TurnParams = {
  connection: acp.ClientSideConnection;
  sessionId: string;
  command: string;
  runtime: Runtime;
  tools: ToolCallTable;
  queue: TurnQueue;
  /** Rejects when the process exits. */
  died: Promise<never>;
  text: string;
  images: readonly PromptImage[];
};

function takeHeld(runtime: Runtime): Runtime["held"] {
  const held = runtime.held;
  runtime.held = undefined;
  return held;
}

/** Runs the prompt and settles the turn's queue with its closing events; never rejects. */
async function settleTurn({ connection, sessionId, command, runtime, tools, queue, died, text, images }: TurnParams): Promise<void> {
  try {
    const response = await Promise.race([
      connection.prompt({
        sessionId,
        // The data is never logged. The text block is omitted when empty (an image-only turn).
        prompt: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...images.map((image) => ({ type: "image" as const, mimeType: image.mimeType, data: image.data })),
        ],
      }),
      died,
    ]);
    // A held chunk is the turn's error only when the agent ended the turn right after it; a cancel
    // drops it; on any other stop it was ordinary text, said before the tools below closed.
    const held = takeHeld(runtime);
    const replyError = response.stopReason === "end_turn" ? held?.error : undefined;
    if (held && !replyError && response.stopReason !== "cancelled") queue.push({ kind: "text", text: held.text });
    // Nothing stays pending for the host when the turn closes.
    for (const event of tools.closeOpen()) queue.push(event);
    const usage = mapUsage(response.usage);
    if (usage) queue.push({ kind: "usage", usage });
    if (replyError) {
      // A tool that started may already have had an effect: the turn is not safe to retry (AD-11).
      queue.push({ kind: "error", error: { ...replyError, retryable: replyError.retryable && !tools.started } });
    } else if (response.stopReason === "cancelled") {
      queue.push({
        kind: "error",
        error: { code: "unknown", retryable: false, message: "The CLI cancelled the turn." },
      });
    } else if (response.stopReason === "refusal") {
      queue.push({
        kind: "error",
        error: { code: "unclassified", retryable: false, message: "The CLI refused the request." },
      });
    } else {
      queue.push({ kind: "result", text: "", stopReason: response.stopReason });
    }
  } catch (error) {
    // A dead process closes its pipes before `exit` fires; give the exit a moment to land.
    await settleExit(runtime);
    const failure = runtime.hasExited
      ? deathError(runtime, command, !tools.started)
      : toCliError(error, "server_error", "The CLI turn failed");
    const held = takeHeld(runtime);
    if (held) queue.push({ kind: "text", text: held.text });
    for (const event of tools.closeOpen()) queue.push(event);
    queue.push({ kind: "error", error: failure.toInfo() });
  } finally {
    queue.end();
  }
}
