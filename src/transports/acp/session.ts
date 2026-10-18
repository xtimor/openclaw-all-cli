import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  CliError,
  type CliErrorCode,
  type CliSession,
  type NormalizedEvent,
  type NormalizedUsage,
  type PermissionDecision,
} from "../../core/ports.ts";
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
  /** Answers a permission request. Throwing counts as `cancelled`. */
  onPermissionRequest: (request: AcpPermissionRequest) => Promise<PermissionDecision>;
  /**
   * Names a tool call for display. It cannot hide or filter a call: returning `undefined` only
   * defers the start by one update, and the final update falls back to the agent's own name.
   */
  describeToolCall?: DescribeToolCall;
  clientName?: string;
  clientVersion?: string;
  signal?: AbortSignal;
};

const STDERR_TAIL_CHARS = 600;
const KILL_GRACE_MS = 2_000;
const EXIT_SETTLE_MS = 500;

type TurnQueue = { push(event: NormalizedEvent): void; end(): void };
type PendingPermission = { resolve: (response: acp.RequestPermissionResponse) => void };
type ToolCallFacts = { rawInput?: Record<string, unknown>; paths: string[] };

/** The agent reports a tool call before it asks about it; keep this many calls' facts. */
const MAX_TOOL_CALL_FACTS = 256;

/** Everything the ACP client callbacks and the session share. */
type Runtime = {
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
};

function toCliError(error: unknown, fallback: CliErrorCode, context: string): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new CliError({ code: fallback, message: `${context}: ${message}` }, { cause: error });
}

/** The error for a process that is gone: a missing binary, or an exit nobody asked for. */
function deathError(runtime: Runtime, command: string, retryable = true): CliError {
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
function terminate(runtime: Runtime): void {
  if (runtime.hasExited) return;
  runtime.child.kill("SIGTERM");
  const forceKill = setTimeout(() => runtime.child.kill("SIGKILL"), KILL_GRACE_MS);
  forceKill.unref();
  void runtime.exited.then(() => clearTimeout(forceKill));
}

function assertDirectory(cwd: string): void {
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

function cancelPermissions(runtime: Runtime): void {
  for (const entry of [...runtime.pending]) {
    runtime.pending.delete(entry);
    entry.resolve({ outcome: { outcome: "cancelled" } });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merges what a `tool_call` or `tool_call_update` says into the facts kept for that call. */
function rememberToolCall(
  runtime: Runtime,
  update: { toolCallId: string; rawInput?: unknown; locations?: Array<{ path: string }> | null },
): void {
  const facts = runtime.toolCalls.get(update.toolCallId) ?? { paths: [] };
  if (isRecord(update.rawInput) && Object.keys(update.rawInput).length > 0) facts.rawInput = update.rawInput;
  for (const location of update.locations ?? []) {
    if (!facts.paths.includes(location.path)) facts.paths.push(location.path);
  }
  runtime.toolCalls.delete(update.toolCallId);
  runtime.toolCalls.set(update.toolCallId, facts);
  if (runtime.toolCalls.size > MAX_TOOL_CALL_FACTS) {
    const oldest = runtime.toolCalls.keys().next();
    if (!oldest.done) runtime.toolCalls.delete(oldest.value);
  }
}

function selectModels(options: acp.SessionConfigSelectOptions): AcpModelInfo[] {
  const models: AcpModelInfo[] = [];
  for (const entry of options) {
    if ("value" in entry) models.push({ id: entry.value, name: entry.name });
    else for (const inner of entry.options) models.push({ id: inner.value, name: inner.name });
  }
  return models;
}

/**
 * The ACP `models` state of a `session/new` or `session/load` result. The SDK's schema does not
 * type it, and agents send it as an extra field (ACP's model selection is still unstable).
 */
type SessionModelState = { currentModelId?: string; availableModels?: Array<{ modelId: string; name: string }> };

function readModelState(result: object): SessionModelState | undefined {
  const models = (result as { models?: unknown }).models;
  return typeof models === "object" && models !== null && !Array.isArray(models) ? (models as SessionModelState) : undefined;
}

/** What the agent says about its models: the `models` state, and a `model` select in `configOptions`. */
function readModelFacts(
  models: SessionModelState | null | undefined,
  configOptions: acp.SessionConfigOption[] | null | undefined,
): { offered: AcpModelInfo[]; currentId?: string; option?: acp.SessionConfigOption & { type: "select" } } {
  const found = configOptions?.find((candidate) => candidate.category === "model");
  const option = found?.type === "select" ? found : undefined;
  const offered: AcpModelInfo[] = (models?.availableModels ?? []).map((model) => ({
    id: model.modelId,
    name: model.name,
  }));
  if (offered.length === 0 && option) offered.push(...selectModels(option.options));
  const currentId = models?.currentModelId ?? option?.currentValue;
  return { offered, ...(currentId ? { currentId } : {}), ...(option ? { option } : {}) };
}

/** The ID an agent answers `session/load` with when it moved the chat; undefined when it did not. */
function readMovedSessionId(result: object): string | undefined {
  const id = (result as { sessionId?: unknown }).sessionId;
  return typeof id === "string" && id.trim() ? id : undefined;
}

/** JSON-RPC "invalid params": how an agent refuses a `session/load` for an ID it does not have. */
const INVALID_PARAMS = -32602;
const UNKNOWN_SESSION = /\b(invalid params|not found|no such|does not exist|unknown session)\b/i;

/**
 * A `session/load` that failed. An agent that does not know the ID (another agent's home, a
 * deleted chat) refuses it: that is `session_expired`, so the host can recover the way its
 * `freshSessionRecovery` says and nothing silently starts a new chat. The message carries
 * "session not found" because the host reads the text to classify the failure. Anything else
 * (a dead pipe, a timeout) is a failed process, not a lost chat.
 */
function resumeError(error: unknown, sessionId: string): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (code === INVALID_PARAMS || UNKNOWN_SESSION.test(message)) {
    return new CliError(
      {
        code: "session_expired",
        message: `CLI session not found: the CLI does not know session "${sessionId}" in this agent's home (the chat belongs to another agent or was deleted), so it cannot resume. ${message}`,
      },
      { cause: error },
    );
  }
  return toCliError(error, "server_error", "The CLI could not resume the session");
}

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
  ) {}

  get alive(): boolean {
    return !this.closed && !this.runtime.hasExited;
  }

  /** Spawns the process, negotiates the protocol, and starts or resumes a session. */
  static async open(options: AcpSessionOptions): Promise<AcpSession> {
    options.signal?.throwIfAborted();
    assertDirectory(options.cwd);
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const runtime: Runtime = {
      child,
      hasExited: false,
      stderrTail: "",
      pending: new Set(),
      toolCalls: new Map(),
      ...(options.describeToolCall ? { describeToolCall: options.describeToolCall } : {}),
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

    const clientHandler: acp.Client = {
      requestPermission(params) {
        const call = params.toolCall;
        // An approved call may run without ever being announced: it still counts as a tool (AD-11).
        if (runtime.tools) runtime.tools.started = true;
        const known = runtime.toolCalls.get(call.toolCallId);
        const paths = [...(known?.paths ?? [])];
        for (const location of call.locations ?? []) if (!paths.includes(location.path)) paths.push(location.path);
        const rawInput = isRecord(call.rawInput) ? call.rawInput : known?.rawInput;
        const request: AcpPermissionRequest = {
          toolCallId: call.toolCallId,
          title: call.title ?? "tool call",
          ...(call.kind ? { kind: call.kind } : {}),
          ...(rawInput ? { rawInput } : {}),
          paths,
          content: call.content ?? [],
          optionIds: params.options.map((item) => item.optionId),
        };
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
            .then(() => options.onPermissionRequest(request))
            .then(settle, () => settle("cancelled"));
        });
      },
      sessionUpdate(params) {
        // Updates outside a prompt are history replays from `session/load`; drop them.
        const turn = runtime.turn;
        if (!turn) return;
        const update = params.update;
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          rememberToolCall(runtime, update);
          for (const event of runtime.tools?.update(update) ?? []) turn.push(event);
          return;
        }
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          turn.push({ kind: "text", text: update.content.text });
        } else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
          turn.push({ kind: "thinking", text: update.content.text });
        }
      },
    };

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
      return new AcpSession(started.sessionId, runtime, connection, options.command, started.models);
    } catch (error) {
      terminate(runtime);
      await runtime.exited;
      options.signal?.throwIfAborted();
      if (runtime.spawnError) throw deathError(runtime, options.command);
      throw toCliError(error, "server_error", "The CLI session failed to start");
    } finally {
      options.signal?.removeEventListener("abort", stopOnAbort);
    }
  }

  async *prompt(text: string): AsyncGenerator<NormalizedEvent> {
    const { runtime } = this;
    if (!this.alive || runtime.turn) {
      const message = this.alive ? "A turn is already running in this session." : "The CLI session is closed.";
      yield { kind: "error", error: { code: "server_error", retryable: !this.alive, message } };
      return;
    }

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
    runtime.turn = queue;
    const tools = new ToolCallTable(runtime.describeToolCall);
    runtime.tools = tools;

    // A death after a tool call started is not retryable: the call may already have run (AD-11).
    const died = runtime.exited.then(() => {
      throw deathError(runtime, this.command, !tools.started);
    });
    died.catch(() => {});

    const settled = (async () => {
      try {
        const response = await Promise.race([
          this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] }),
          died,
        ]);
        // Nothing stays pending for the host when the turn closes.
        for (const event of tools.closeOpen()) queue.push(event);
        const usage = mapUsage(response.usage);
        if (usage) queue.push({ kind: "usage", usage });
        if (response.stopReason === "cancelled") {
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
        await Promise.race([runtime.exited, new Promise((resolve) => setTimeout(resolve, EXIT_SETTLE_MS))]);
        const failure = runtime.hasExited
          ? deathError(runtime, this.command, !tools.started)
          : toCliError(error, "server_error", "The CLI turn failed");
        for (const event of tools.closeOpen()) queue.push(event);
        queue.push({ kind: "error", error: failure.toInfo() });
      } finally {
        queue.end();
      }
    })();

    let reply = "";
    try {
      for (;;) {
        const next = buffer.shift();
        if (next) {
          if (next.kind === "text") reply += next.text;
          // The transport owns the accumulated reply, so the closing event carries the full text.
          yield next.kind === "result" ? { ...next, text: reply } : next;
          continue;
        }
        if (ended) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      if (!ended) {
        // The consumer stopped early (abort): stop the turn and let it settle. A CLI that
        // ignores the cancel gets the kill grace, then the process is closed.
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
      await settled;
      runtime.turn = undefined;
      runtime.tools = undefined;
      runtime.toolCalls.clear();
    }
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

/** The ACP handshake: initialize, log in, then start or resume a session in the right mode and model. */
async function setup(
  connection: acp.ClientSideConnection,
  options: AcpSessionOptions,
): Promise<{ sessionId: string; models: AcpModelInfo[] }> {
  const init = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: options.clientName ?? "openclaw-all-cli", version: options.clientVersion ?? "0.0.0" },
  });
  if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
    throw new CliError({
      code: "unsupported_version",
      message: `The CLI speaks ACP protocol ${init.protocolVersion}; this plugin supports ${acp.PROTOCOL_VERSION}.`,
    });
  }
  if (options.resumeSessionId && init.agentCapabilities?.loadSession !== true) {
    throw new CliError({
      code: "capability_mismatch",
      message: "The CLI cannot load a session, so the conversation cannot resume.",
    });
  }
  if (options.authMethodId) {
    const methods = init.authMethods;
    if (!methods || methods.some((method) => method.id === options.authMethodId)) {
      try {
        await connection.authenticate({ methodId: options.authMethodId });
      } catch (error) {
        throw toCliError(error, "auth", "The CLI rejected its login");
      }
    }
  }

  const base = { cwd: options.cwd, mcpServers: options.mcpServers ?? [] };
  let sessionId: string;
  let modes: acp.SessionModeState | null | undefined;
  let modelState: SessionModelState | undefined;
  let configOptions: acp.SessionConfigOption[] | null | undefined;
  if (options.resumeSessionId) {
    try {
      const loaded = await connection.loadSession({ sessionId: options.resumeSessionId, ...base });
      // ACP's load answers for the ID it was given; an agent that moves the chat to another ID
      // says so in an extra `sessionId` field. The new ID is the one the host must keep.
      sessionId = readMovedSessionId(loaded) ?? options.resumeSessionId;
      modes = loaded.modes;
      modelState = readModelState(loaded);
      configOptions = loaded.configOptions;
    } catch (error) {
      throw resumeError(error, options.resumeSessionId);
    }
  } else {
    try {
      const created = await connection.newSession(base);
      sessionId = created.sessionId;
      modes = created.modes;
      modelState = readModelState(created);
      configOptions = created.configOptions;
    } catch (error) {
      throw toCliError(error, "server_error", "The CLI could not start a session");
    }
  }

  if (options.requiredModeId) {
    const wanted = options.requiredModeId;
    if (!modes?.availableModes.some((mode) => mode.id === wanted)) {
      throw new CliError({
        code: "capability_mismatch",
        message: `The CLI offers no "${wanted}" mode, so it cannot run safely.`,
      });
    }
    if (modes.currentModeId !== wanted) {
      await connection.setSessionMode({ sessionId, modeId: wanted });
    }
  }

  const facts = readModelFacts(modelState, configOptions);
  if (options.selectModel || options.modelId) await switchModel(connection, sessionId, facts, options);
  return { sessionId, models: facts.offered };
}

/**
 * Switches the session to the wanted model. A `model` select in `configOptions` is the standard
 * way; an agent that only reports the `models` state is switched with `session/set_model`. The
 * wanted ID must be one the agent offered, so a stale or unknown name fails as `model_not_found`.
 */
async function switchModel(
  connection: acp.ClientSideConnection,
  sessionId: string,
  facts: ReturnType<typeof readModelFacts>,
  options: AcpSessionOptions,
): Promise<void> {
  const { offered, currentId, option } = facts;
  const wanted = options.selectModel ? options.selectModel(offered, currentId) : options.modelId;
  if (wanted === null) return;
  if (wanted === undefined || !offered.some((model) => model.id === wanted)) {
    const asked = wanted ?? options.modelId ?? "";
    throw new CliError(
      offered.length === 0
        ? {
            code: "capability_mismatch",
            message: `The CLI does not list models, so it cannot switch to a model${asked ? ` "${asked}"` : ""}.`,
          }
        : { code: "model_not_found", message: `The CLI has no model${asked ? ` "${asked}"` : ""} for this account.` },
    );
  }
  if (wanted === currentId) return;
  try {
    if (option) await connection.setSessionConfigOption({ sessionId, configId: option.id, value: wanted });
    else await connection.extMethod("session/set_model", { sessionId, modelId: wanted });
  } catch (error) {
    // An agent that refuses the value says so as invalid params; anything else is a failed process.
    const refused = error instanceof Error && /\b(invalid|unknown|not found|no such)\b/i.test(error.message);
    throw toCliError(error, refused ? "model_not_found" : "server_error", `The CLI could not switch to model "${wanted}"`);
  }
}
