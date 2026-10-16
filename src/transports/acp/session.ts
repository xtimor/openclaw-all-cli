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
  type PermissionRequest,
} from "../../core/ports.ts";

/**
 * A generic ACP client session over a spawned process. It knows no CLI: the adapter supplies
 * the command, the login method, the mode it needs, and the policy for permission requests.
 */

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
  /** Model to select. Left unset, the agent keeps its default. */
  modelId?: string;
  /** Native session to resume with `session/load`. */
  resumeSessionId?: string;
  onPermissionRequest: (request: PermissionRequest) => Promise<PermissionDecision>;
  clientName?: string;
  clientVersion?: string;
  signal?: AbortSignal;
};

const STDERR_TAIL_CHARS = 600;
const KILL_GRACE_MS = 2_000;
const EXIT_SETTLE_MS = 500;

type TurnQueue = { push(event: NormalizedEvent): void; end(): void };
type PendingPermission = { resolve: (response: acp.RequestPermissionResponse) => void };

/** Everything the ACP client callbacks and the session share. */
type Runtime = {
  child: ChildProcess;
  exited: Promise<void>;
  hasExited: boolean;
  spawnError?: Error;
  stderrTail: string;
  turn?: TurnQueue;
  pending: Set<PendingPermission>;
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

function selectValues(options: acp.SessionConfigSelectOptions): string[] {
  const values: string[] = [];
  for (const entry of options) {
    if ("value" in entry) values.push(entry.value);
    else for (const inner of entry.options) values.push(inner.value);
  }
  return values;
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
        const request: PermissionRequest = {
          title: params.toolCall.title ?? "tool call",
          ...(params.toolCall.kind ? { kind: params.toolCall.kind } : {}),
          toolCallId: params.toolCall.toolCallId,
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
          options.onPermissionRequest(request).then(settle, () => settle("cancelled"));
        });
      },
      sessionUpdate(params) {
        // Updates outside a prompt are history replays from `session/load`; drop them.
        const turn = runtime.turn;
        if (!turn) return;
        const update = params.update;
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
      const sessionId = await Promise.race([setup(connection, options), died]);
      return new AcpSession(sessionId, runtime, connection, options.command);
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

    // A death mid-turn is never retryable: a tool call may already have run (AD-11).
    const died = runtime.exited.then(() => {
      throw deathError(runtime, this.command, false);
    });
    died.catch(() => {});

    const settled = (async () => {
      try {
        const response = await Promise.race([
          this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text }] }),
          died,
        ]);
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
          ? deathError(runtime, this.command, false)
          : toCliError(error, "server_error", "The CLI turn failed");
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
        await this.cancel();
        let timer: NodeJS.Timeout | undefined;
        const gaveUp = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), KILL_GRACE_MS);
        });
        const timedOut = await Promise.race([settled.then(() => false), gaveUp]);
        clearTimeout(timer);
        if (timedOut) await this.close();
      }
      await settled;
      runtime.turn = undefined;
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
async function setup(connection: acp.ClientSideConnection, options: AcpSessionOptions): Promise<string> {
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
  let configOptions: acp.SessionConfigOption[] | null | undefined;
  if (options.resumeSessionId) {
    try {
      const loaded = await connection.loadSession({ sessionId: options.resumeSessionId, ...base });
      sessionId = options.resumeSessionId;
      modes = loaded.modes;
      configOptions = loaded.configOptions;
    } catch (error) {
      throw toCliError(error, "session_expired", "The CLI could not resume the session");
    }
  } else {
    try {
      const created = await connection.newSession(base);
      sessionId = created.sessionId;
      modes = created.modes;
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

  if (options.modelId) {
    const option = configOptions?.find((candidate) => candidate.category === "model");
    if (!option || option.type !== "select") {
      throw new CliError({
        code: "capability_mismatch",
        message: `The CLI does not list models, so it cannot switch to "${options.modelId}".`,
      });
    }
    if (option.currentValue !== options.modelId) {
      if (!selectValues(option.options).includes(options.modelId)) {
        throw new CliError({
          code: "model_not_found",
          message: `The CLI has no model "${options.modelId}" for this account.`,
        });
      }
      await connection.setSessionConfigOption({ sessionId, configId: option.id, value: options.modelId });
    }
  }
  return sessionId;
}
