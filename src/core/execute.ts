import { randomUUID } from "node:crypto";
import type { AgentHome } from "./home.ts";
import { toRecord, type CoreRecord, type TurnSummary } from "./events.ts";
import { takeHostImages } from "./images.ts";
import { listToolNames, startMcpProxy, type McpProxy } from "./mcp-proxy.ts";
import { OPENCLAW_MCP_SERVER, readTurnTarget, type TurnTarget } from "./mcp-target.ts";
import { recordProcess, type ProcessLock } from "./pid-locks.ts";
import { capabilityMismatch, missingCapabilities, requiredCapabilities } from "./manifest.ts";
import { readTurnUsage } from "./usage.ts";
import {
  DeliveredPrompts,
  SYSTEM_PROMPT_TRANSPORT_MARKER,
  deliveredFileFor,
  neutralizeBlockMarkers,
  runtimeUpdateNote,
  systemPromptBlock,
} from "./system-prompt.ts";
import { ProcessPool, type PoolMember, type TurnSlot } from "./pool.ts";
import { routePermission, type PermissionTurn } from "./permissions.ts";
import {
  CliError,
  type CliAdapter,
  type CliSession,
  type ExecutionMode,
  type NormalizedEvent,
} from "./ports.ts";
import type { CliBackendExecute, ExecuteContext, LiveSessionCapability, LiveSessionHandle } from "./sdk-types.ts";

/** AD-14: live processes close after 15 idle minutes. */
export const DEFAULT_IDLE_MS = 15 * 60_000;
/** AD-11: after an abort, the process gets this long to stop before it is closed. */
export const DEFAULT_ABORT_GRACE_MS = 5_000;

/** How long before the CLI's MCP timeout the proxy stops a call. */
const MCP_DEADLINE_MARGIN_MS = 5_000;

export type ExecuteOptions = {
  /** The agent's CLI home (AD-6). Every process the execute opens runs in it. */
  home: AgentHome;
  idleMs?: number;
  abortGraceMs?: number;
  /** Receives warnings. Never pass it a token, an auth header, or prompt text. */
  warn?: (message: string) => void;
  /**
   * Whether OpenClaw's tools reach the CLI through the MCP proxy (parity row P7). When false the
   * core starts no proxy, hands the CLI no MCP server, and reads no settings file. Default true.
   */
  mcp?: boolean;
  /**
   * Whether the CLI's permission requests go to the host (parity row P9). When false every request
   * is rejected like a side question's and the host is never asked. Default true.
   */
  approvals?: boolean;
  /**
   * Whether the core asks the adapter for a turn's usage when the CLI reports none (parity row
   * P16). Default true.
   */
  usage?: boolean;
  /**
   * The auth profile the host picked for the run (`prepareExecution` knows it, `execute` does
   * not). It is part of the reuse key: a process never serves another profile (AD-13).
   */
  authProfileId?: string;
  /** Deadline for one MCP tool call through the proxy, in ms. Default: the adapter's `mcpCallTimeoutMs` minus 5 s, or none. Tests inject a small one. */
  callDeadlineMs?: number;
  /**
   * The backend's limits (AD-14): the turn cap, the process cap, the version check memo, and
   * close-all on unload. Absent: a private pool without limits.
   */
  pool?: ProcessPool;
  /**
   * Parity row P15: the first prompt of a fresh agent chat that has the MCP proxy starts with a
   * note that points the model to OpenClaw's `sessions_history`. Default false.
   */
  continuity?: boolean;
  /**
   * Parity row P12: the host's system prompt (`ctx.systemPrompt`) goes in a marked block at the
   * start of a chat's first prompt, and again whenever it changes (AD-15). Default false.
   */
  systemPrompt?: boolean;
  /**
   * Parity row P13: the host's image paths at the end of `ctx.prompt` are taken off the text and the
   * images go to the CLI as image blocks (AD-16). Off: the prompt goes through unchanged. Default false.
   */
  images?: boolean;
  /** The allowed `openclaw-cli-images` directories for P13. Default: the host's cache under the temp dir. Tests inject one. */
  imageRoots?: readonly string[];
};

/**
 * AD-2, AD-5: names OpenClaw and its tool, never a CLI. The host refuses to copy history across
 * an auth boundary, so the model reads it through a tool that stays under OpenClaw's policy.
 */
export const CONTINUITY_NOTE =
  "[OpenClaw] This chat is part of an OpenClaw conversation. Turns answered by other models, before this chat started or between your turns, are not in your context. " +
  'When the user refers to something you cannot see here, read the conversation with the OpenClaw tool `sessions_history` (sessionKey "current") before you answer, if that tool is available.';

type LiveEntry = {
  /** Set once the process is open; the handle exists (and is registered) before that. */
  session?: CliSession;
  /** The session's MCP endpoint (AD-12). It lives and dies with the process. Absent when `mcp` is off. */
  proxy?: McpProxy;
  /** Set by the handle's close, which may arrive while the process is still opening. */
  closed?: boolean;
  /**
   * The first turn had no usable OpenClaw endpoint, so the CLI connected to a proxy that answered
   * 503 and dropped the server. Such a process never serves another turn.
   */
  degraded?: boolean;
  /** The running turn, which the CLI's permission requests belong to (AD-11). */
  turn?: PermissionTurn;
  /** What must match for the process to serve the next turn (AD-13). */
  key: string;
  /** The chat this process holds, once open: `<home>\0<native session id>`. See `chats`. */
  chat?: string;
  handle: LiveSessionHandle;
  /** The process as the pool counts it, from creation until the handle closes. */
  member: PoolMember;
  /** The open in progress, so the pool can wait for a process that is still starting. */
  opening?: Promise<unknown>;
  /** Aborted by the handle's close, so a process that is still starting stops starting. */
  stopOpening: AbortController;
  /** The process opened a fresh agent chat and has not sent its first prompt yet (P15). */
  freshChat?: boolean;
  busy: boolean;
  idleTimer?: NodeJS.Timeout;
};

type OpenEntry = LiveEntry & { session: CliSession };

/** Live processes by their host handle. The host owns the lifecycle; this only finds the process. */
const entries = new WeakMap<LiveSessionHandle, LiveEntry>();

/**
 * The open processes by the native chat they hold. Two processes that load one chat each keep
 * their own view and the last writer wins (live probe, spec Q4), so at most one process holds a
 * chat: opening a resume closes an idle holder first.
 */
const chats = new Map<string, LiveEntry>();

function chatKey(home: AgentHome, sessionId: string): string {
  return JSON.stringify([home.dir, sessionId]);
}

/**
 * An argument the backend's `resolveExecutionArgs` appends when the host serves its own `exec` for
 * the run (`hostOwnedTools`), which `execute` does not receive otherwise. `execute` removes it
 * before the CLI is launched and tells the adapter through `OpenParams.hostShell`.
 */
export const HOST_SHELL_ARG = "--openclaw-all-cli:host-shell";

/** The tool whose presence in the host's tool list makes a turn a host-shell turn. */
const HOST_SHELL_TOOL = "exec";

/** Whether the host serves a shell tool for this turn, and the launch args without the marker. */
function splitHostShell(ctx: ExecuteContext): { hostShell: boolean; args: string[] } {
  // The system-prompt marker is the host's to read, never the CLI's: strip it if a host passes it on.
  return {
    hostShell: ctx.args.includes(HOST_SHELL_ARG),
    args: ctx.args.filter((arg) => arg !== HOST_SHELL_ARG && arg !== SYSTEM_PROMPT_TRANSPORT_MARKER),
  };
}

/** A side question runs beside the chat, never in it (AD-13: mode is part of the reuse key). */
function modeOf(ctx: ExecuteContext): ExecutionMode {
  return ctx.executionMode === "side-question" ? "side-question" : "agent";
}

/** AD-13: model, mode, working directory, home, and auth profile. The native session ID is checked on the session. */
function reuseKey(ctx: ExecuteContext, home: AgentHome, authProfileId: string | undefined): string {
  return JSON.stringify([ctx.modelId, modeOf(ctx), splitHostShell(ctx).hostShell, ctx.cwd, home.dir, authProfileId ?? null]);
}

/**
 * `system` is the block, when this turn sends one. With a system prompt on, the rest of the turn's
 * text (user text and both contexts, which may carry channel messages or tool output) is stripped of
 * the block's header and tags, so it can never pass for a system block.
 */
function composePrompt(ctx: ExecuteContext, note?: string, system?: string, guard = false, promptText = ctx.prompt): string {
  const { prependContext, appendContext } = ctx.promptContext ?? {};
  const plain = (text: string | undefined) => (guard && text ? neutralizeBlockMarkers(text) : text);
  return [system, note, plain(prependContext), plain(promptText), plain(appendContext)].filter((part): part is string => Boolean(part)).join("\n\n");
}

/**
 * The turn's native tool calls as the host sees them: one start and at most one result per call.
 * Whatever is still open when the turn closes gets an aborted result, so the host shows nothing
 * pending whatever the adapter did.
 */
class ToolLedger {
  private readonly calls = new Map<string, { name: string; open: boolean }>();

  /** Whether the event may go to the host. A second start, and a result without an open start, are dropped. */
  admit(event: NormalizedEvent): boolean {
    if (event.kind === "toolStart") {
      if (this.calls.has(event.toolCallId)) return false;
      this.calls.set(event.toolCallId, { name: event.name, open: true });
    } else if (event.kind === "toolResult") {
      const call = this.calls.get(event.toolCallId);
      if (!call?.open) return false;
      call.open = false;
    }
    return true;
  }

  closeOpen(): CoreRecord[] {
    const records: CoreRecord[] = [];
    for (const [toolCallId, call] of this.calls) {
      if (!call.open) continue;
      call.open = false;
      records.push(
        toRecord({ kind: "toolResult", toolCallId, name: call.name, isError: true, result: { aborted: true } }),
      );
    }
    return records;
  }
}

export function errorRecord(error: unknown): CoreRecord {
  const info =
    error instanceof CliError
      ? error.toInfo()
      : {
          code: "unknown" as const,
          retryable: false,
          message: error instanceof Error ? error.message : String(error),
        };
  return toRecord({ kind: "error", error: info });
}

/**
 * The one execution seam (AD-3). It finds or opens the adapter's process, sends the prompt, and
 * yields core records. The host owns timers and per-session queueing (AD-8, AD-11); the core
 * adds only the abort grace and the idle close.
 */
export function createExecute(adapter: CliAdapter, options: ExecuteOptions): CliBackendExecute {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  const { home } = options;
  const warn = options.warn ?? (() => {});
  const mcp = options.mcp ?? true;
  // The proxy stops a tool call a little before the CLI's own MCP client gives up on it.
  const callDeadlineMs = options.callDeadlineMs ?? (adapter.mcpCallTimeoutMs ? Math.max(1_000, adapter.mcpCallTimeoutMs - MCP_DEADLINE_MARGIN_MS) : undefined);
  const continuity = options.continuity ?? false;
  const deliversSystemPrompt = options.systemPrompt ?? false;
  const deliversImages = options.images ?? false;
  // AD-15: what each chat of this home last received (hashes only), kept in the home so a restart or a `--local` run does not resend.
  const delivered = deliversSystemPrompt ? new DeliveredPrompts(deliveredFileFor(home.dir)) : undefined;
  const approvals = options.approvals ?? true;
  const readsUsage = options.usage ?? true;
  const required = requiredCapabilities(adapter.manifest);
  const { authProfileId } = options;
  const pool = options.pool ?? new ProcessPool({ maxTurns: Infinity, maxProcesses: Infinity });

  function reusable(ctx: ExecuteContext, live: LiveSessionCapability | undefined): OpenEntry | undefined {
    const current = live?.current();
    if (!live || !current || current.fingerprint !== live.fingerprint) return undefined;
    const entry = entries.get(current);
    if (!entry?.session || entry.busy || entry.degraded || !entry.session.alive) return undefined;
    if (!ctx.useResume || ctx.sessionId !== entry.session.sessionId) return undefined;
    return entry.key === reuseKey(ctx, home, authProfileId) ? (entry as OpenEntry) : undefined;
  }

  /**
   * The host mints a new URL and token per run, so every turn points the proxy at its own. A
   * turn whose settings file has no usable target runs without OpenClaw tools.
   */
  function pointProxy(proxy: McpProxy, turnTarget: TurnTarget): void {
    if (turnTarget.ok) {
      proxy.setTarget(turnTarget.target);
    } else {
      proxy.clearTarget();
      warn(`OpenClaw tools are unavailable in this turn: ${turnTarget.reason}.`);
    }
  }

  /**
   * Creates the host handle and the proxy for a process that is not open yet, and counts it in
   * the pool: at the process cap an idle process makes room, or the turn fails as `overloaded`.
   */
  async function createEntry(
    ctx: ExecuteContext,
    live: LiveSessionCapability | undefined,
    withMcp: boolean,
  ): Promise<LiveEntry> {
    const entry: LiveEntry = {
      key: reuseKey(ctx, home, authProfileId),
      busy: false,
      stopOpening: new AbortController(),
      member: {
        // A process that died while idle is evictable too: it has nothing left to lose.
        isIdle: () => !entry.busy && Boolean(entry.session),
        lastUsed: Date.now(),
        close: () => entry.handle.close("idle"),
        exited: async () => {
          await entry.opening?.then(
            () => {},
            () => {},
          );
          await entry.session?.waitForExit();
        },
      },
      handle: {
        generation: randomUUID(),
        fingerprint: live?.fingerprint ?? randomUUID(),
        isIdle: () => !entry.busy && Boolean(entry.session?.alive),
        close: () => {
          if (entry.closed) return;
          entry.closed = true;
          entry.stopOpening.abort();
          clearTimeout(entry.idleTimer);
          pool.remove(entry.member);
          releaseChat(entry);
          live?.remove(entry.handle);
          void entry.session?.close();
          void entry.proxy?.close();
        },
        waitForExit: () => entry.session?.waitForExit() ?? Promise.resolve(),
      },
    };
    await pool.add(entry.member, ctx.abortSignal);
    if (withMcp) {
      let proxy: McpProxy;
      try {
        proxy = await startMcpProxy(callDeadlineMs === undefined ? {} : { callDeadlineMs });
      } catch (error) {
        pool.remove(entry.member);
        throw new CliError(
          {
            code: "server_error",
            message: `Could not start the MCP proxy: ${error instanceof Error ? error.message : String(error)}`,
            retryable: true,
          },
          { cause: error },
        );
      }
      entry.proxy = proxy;
      // The pool or the host closed the handle while the proxy started: the close found no proxy to stop.
      if (entry.closed) void proxy.close();
    }
    return entry;
  }

  function releaseChat(entry: LiveEntry): void {
    if (entry.chat && chats.get(entry.chat) === entry) chats.delete(entry.chat);
    entry.chat = undefined;
  }

  /**
   * Registers `entry` as the one process holding the chat `sessionId`, before the process opens,
   * so two concurrent resumes of one chat cannot both pass the check. The check and the
   * registration have no await between them. An idle holder is closed (this turn is the newest
   * word on the chat) and given a bounded time to exit. A holder that is mid-turn or still
   * opening means two turns of one chat at once, which the host's lanes should prevent: refuse
   * with a retryable error rather than fork the chat.
   */
  async function claimChat(entry: LiveEntry, sessionId: string, signal: AbortSignal | undefined): Promise<void> {
    const key = chatKey(home, sessionId);
    const holder = chats.get(key);
    if (holder && holder !== entry) {
      if (holder.busy || !holder.session) {
        throw new CliError({
          code: "server_error",
          message: "Another turn of this chat is still running in a CLI process, so the chat cannot be resumed yet.",
          retryable: true,
        });
      }
      holder.handle.close("restart");
    }
    entry.chat = key;
    chats.set(key, entry);
    if (holder && holder !== entry) await waitForExit(holder, signal);
  }

  /** Waits for a closed holder's process to exit: until it does, until the abort, or for the abort grace. */
  async function waitForExit(holder: LiveEntry, signal: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<"timeout" | "abort">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), abortGraceMs);
      onAbort = () => resolve("abort");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      // The session's own close already escalates SIGTERM to SIGKILL; this only bounds the wait.
      const outcome = await Promise.race([
        (holder.session?.waitForExit() ?? Promise.resolve()).then(
          () => "exited" as const,
          () => "exited" as const,
        ),
        interrupted,
      ]);
      if (outcome === "abort") signal?.throwIfAborted();
      if (outcome !== "exited") {
        throw new CliError({
          code: "server_error",
          message: "The previous CLI process of this chat did not exit in time, so the chat cannot be resumed yet.",
          retryable: true,
        });
      }
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * AD-14: the first process of a backend and command waits for the CLI's version check. A pass is
   * remembered; a CLI whose version cannot be read runs with a warning and is checked again.
   */
  async function ensureVersion(ctx: ExecuteContext): Promise<void> {
    // The run is shared by simultaneous turns, so it takes no caller's signal (the adapter times it
    // out itself); each caller stops waiting on its own abort.
    const shared = pool.checkVersionOnce(ctx.command, () =>
      adapter.checkVersion({ command: ctx.command, env: { ...ctx.env, ...home.env } }),
    );
    const signal = ctx.abortSignal;
    let onAbort: (() => void) | undefined;
    const result = await (signal
      ? Promise.race([
          shared,
          new Promise<never>((_resolve, reject) => {
            signal.throwIfAborted();
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]).finally(() => onAbort && signal.removeEventListener("abort", onAbort))
      : shared);
    signal?.throwIfAborted();
    if (result !== "ok") warn(result.warning);
  }

  /** Opens the process behind a registered entry. The proxy already points at the turn's target. */
  async function attachSession(entry: LiveEntry, ctx: ExecuteContext, hostShell: boolean): Promise<OpenEntry> {
    const { proxy } = entry;
    const closedError = () =>
      new CliError({
        code: "server_error",
        message: "The live session was closed while the CLI was starting.",
        retryable: true,
      });
    // Closed (unload, eviction, the host) before the open: no process may start.
    if (entry.closed) throw closedError();
    const mode = modeOf(ctx);
    // A side question is a throwaway chat: it never resumes and never reaches the real one.
    const resumeSessionId = mode === "agent" && ctx.useResume && ctx.sessionId ? ctx.sessionId : undefined;
    if (resumeSessionId) await claimChat(entry, resumeSessionId, ctx.abortSignal);
    if (entry.closed) throw closedError();
    // The process is recorded in the agent home from its spawn, so a killed Gateway leaves a trail (AD-14).
    let lock: Promise<ProcessLock | undefined> | undefined;
    const releaseLock = () => lock?.then((held) => held?.release());
    let session: CliSession;
    try {
      session = await adapter.open({
        command: ctx.command,
        args: splitHostShell(ctx).args,
        cwd: ctx.cwd,
        env: { ...ctx.env, ...home.env },
        modelId: ctx.modelId,
        executionMode: mode,
        hostShell,
        // The transport can fail right after the handshake, before it creates or loads a chat.
        ...(required.length > 0 ? { requiredCapabilities: required } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        // The CLI gets only the proxy: the host's per-run URL and token never leave the core.
        ...(proxy
          ? {
              mcpServers: [
                { name: OPENCLAW_MCP_SERVER, url: proxy.url, headers: { Authorization: `Bearer ${proxy.token}` } },
              ],
            }
          : {}),
        // The process outlives turns: each request goes to the turn running when it arrives. A side
        // question has no tools to approve: every request is rejected and the host is never asked.
        onPermissionRequest:
          mode === "side-question" || !approvals
            ? async () => (!entry.turn || entry.turn.ended || ctx.abortSignal?.aborted ? "cancelled" : "reject_once")
            : (request) => routePermission(entry.turn, request, warn),
        onProcessStart: (pid) => {
          lock = recordProcess(home.dir, pid, warn);
        },
        signal: ctx.abortSignal ? AbortSignal.any([ctx.abortSignal, entry.stopOpening.signal]) : entry.stopOpening.signal,
      });
    } catch (error) {
      // A failed open has stopped its process: nothing is left to guard.
      await releaseLock();
      throw error;
    }
    // The lock goes with the process, however the process ends.
    void session.waitForExit().then(releaseLock, releaseLock);
    // The host may have closed the handle while the process was starting: the close found no
    // process to stop, so this one would leak and run against a closed proxy.
    if (entry.closed) {
      // A failing close must not hide the reason the turn cannot run.
      await session.close().catch(() => {});
      throw closedError();
    }
    // AD-10: the CLI must report what the manifest's decided rows need. Nothing was sent yet.
    if (session.capabilities) {
      const missing = missingCapabilities(adapter.manifest, session.capabilities);
      if (missing.length > 0) {
        // A failing close must not hide the reason the turn cannot run.
        await session.close().catch(() => {});
        // A new chat the CLI stored is an orphan; a resumed one is the user's and stays.
        if (!resumeSessionId) {
          await adapter.discardSession?.({ env: { ...ctx.env, ...home.env }, sessionId: session.sessionId }).catch(() => {});
        }
        throw capabilityMismatch(adapter.displayName, missing);
      }
    }
    entry.session = session;
    // P15: a chat opened without a resume ID has no earlier turns of the conversation in its context.
    entry.freshChat = continuity && mode === "agent" && !resumeSessionId && Boolean(proxy);
    // A process that exits while idle gives its slot back at once; a running turn closes its own.
    void session.waitForExit().then(
      () => {
        if (!entry.busy) entry.handle.close("abort");
      },
      () => {},
    );
    // Whatever id the CLI ended up with is the chat this process holds (a new session, or a
    // load that moved the chat, has no claim yet or a claim on the old id).
    if (mode === "agent") {
      const key = chatKey(home, session.sessionId);
      if (entry.chat !== key) {
        releaseChat(entry);
        const other = chats.get(key);
        if (other && other !== entry) other.handle.close("restart");
        entry.chat = key;
        chats.set(key, entry);
      }
    }
    // The proxy ends with its process, however the process ends.
    if (proxy) {
      void session.waitForExit().then(
        () => proxy.close(),
        () => proxy.close(),
      );
    }
    entries.set(entry.handle, entry);
    return entry as OpenEntry;
  }

  async function* run(ctx: ExecuteContext): ReturnType<CliBackendExecute> {
    ctx.assertCurrent?.();
    ctx.abortSignal?.throwIfAborted();
    const sideQuestion = modeOf(ctx) === "side-question";
    // The host gives a side question no live session; if it ever did, the side question must not
    // restart or replace the chat's process.
    const live = sideQuestion ? undefined : ctx.liveSession;
    // A side question gets no OpenClaw tools: no proxy, no MCP server, no settings file read.
    const withMcp = mcp && !sideQuestion;

    const turnTarget: TurnTarget = withMcp ? await readTurnTarget(ctx.env) : { ok: false, reason: "MCP is off" };
    ctx.abortSignal?.throwIfAborted();
    let entry = reusable(ctx, live);
    if (!entry && live) await live.restart();
    // A superseded run must throw, not turn into an error record.
    ctx.assertCurrent?.();
    let opened = false;
    if (!entry) {
      opened = true;
      let fresh: LiveEntry;
      try {
        await ensureVersion(ctx);
        fresh = await createEntry(ctx, live, withMcp);
      } catch (error) {
        if (ctx.abortSignal?.aborted) throw error;
        // A superseded run must throw, not turn into an error record.
        ctx.assertCurrent?.();
        yield errorRecord(error);
        return;
      }
      try {
        ctx.assertCurrent?.();
      } catch (error) {
        fresh.handle.close("abort");
        throw error;
      }
      // Closed while the proxy started (unload): never hand the host a closed handle.
      if (fresh.closed) {
        yield errorRecord(
          new CliError({ code: "server_error", message: "The plugin is shutting down.", retryable: true }),
        );
        return;
      }
      // A host that tracks live sessions must know the process and activate its MCP grant before
      // the CLI connects: a CLI connects to its MCP servers while it opens the session, and one
      // rejected connection drops the server for good. So register and activate first. Host
      // errors keep propagating as throws, not error records.
      try {
        live?.register(fresh.handle);
      } catch (error) {
        fresh.handle.close("abort");
        throw error;
      }
      try {
        live?.activate(fresh.handle);
      } catch (error) {
        // The host holds the registered handle: close removes it and stops the proxy.
        fresh.handle.close("abort");
        throw error;
      }
      try {
        ctx.abortSignal?.throwIfAborted();
        fresh.turn = { ctx, ended: false };
        if (fresh.proxy) {
          pointProxy(fresh.proxy, turnTarget);
          fresh.degraded = !turnTarget.ok;
        }
        // The marker only says the host MAY serve exec: its tool policy can still drop the tool. The
        // tool list the CLI is about to read is the truth; if it cannot be read, assume no exec.
        const marked = splitHostShell(ctx).hostShell && turnTarget.ok;
        const listed = marked && turnTarget.ok ? await listToolNames(turnTarget.target, ctx.abortSignal) : undefined;
        const hostShell = listed?.includes(HOST_SHELL_TOOL) === true;
        // The host may serve exec but the list could not be read (an error, a cold cache): this
        // process opened in the restrictive mode. Never reuse it, so the next turn reads the list again.
        if (marked && listed === undefined) fresh.degraded = true;
        ctx.abortSignal?.throwIfAborted();
        const opening = attachSession(fresh, ctx, hostShell);
        fresh.opening = opening;
        entry = await opening;
      } catch (error) {
        fresh.handle.close("abort");
        if (ctx.abortSignal?.aborted) throw error;
        // A newer run's restart closes the handle during the open: that run is superseded.
        ctx.assertCurrent?.();
        yield errorRecord(error);
        return;
      }
    }

    const active = entry;
    clearTimeout(active.idleTimer);
    active.busy = true;
    active.turn ??= { ctx, ended: false };
    const turn = active.turn;

    let graceTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      void active.session.cancel();
      graceTimer = setTimeout(() => active.handle.close("abort"), abortGraceMs);
      graceTimer.unref();
    };
    ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });

    let turnFailed = false;
    const tools = new ToolLedger();
    try {
      // A process opened for this turn is already registered, activated, and pointed.
      if (!opened) {
        live?.activate(active.handle);
        ctx.abortSignal?.throwIfAborted();
        if (active.proxy) pointProxy(active.proxy, turnTarget);
      }
      ctx.abortSignal?.throwIfAborted();

      // The host binds the chat to the id the CLI ended up with, so every turn names it, also when
      // `session/load` returned another one. A side question's chat is thrown away: no id.
      const summary: TurnSummary = sideQuestion ? {} : { sessionId: active.session.sessionId };
      if (!sideQuestion) yield toRecord({ kind: "sessionId", sessionId: active.session.sessionId });

      let closed = false;
      // Each event goes to the host as it arrives; nothing waits for the turn to end.
      // The note goes once, on the first prompt of a fresh chat; it is not part of the host's transcript.
      const note = active.freshChat ? CONTINUITY_NOTE : undefined;
      active.freshChat = false;
      // AD-15: the host's system prompt, once per chat and again when it changes. A side question's
      // chat is thrown away, so it always gets the block and leaves the ledger alone.
      const system = deliversSystemPrompt ? (ctx.systemPrompt ?? "").trim() : "";
      // The chat is the id the CLI ended up with, which the host stores for the next turn. A load that
      // moved the chat answers with a new id, so the id the turn resumed counts as the same chat.
      const chat = sideQuestion ? undefined : active.session.sessionId;
      const resumed = sideQuestion || !ctx.useResume ? undefined : ctx.sessionId;
      // A side question always gets the block; a chat gets the block, a short runtime update (only the date,
      // model, channel, capabilities, or active computer changed), or nothing.
      const delivering = !system ? "none" : !chat ? "block" : delivered!.decide([chat, ...(resumed ? [resumed] : [])], system);
      const lead =
        delivering === "block" ? systemPromptBlock(system) : delivering === "note" ? runtimeUpdateNote(system) : undefined;
      const startedAt = Date.now();
      // AD-16: the host's image paths leave the text and the images go as blocks. Nothing is written.
      const host = deliversImages
        ? await takeHostImages(ctx.prompt, { ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}), warn, ...(options.imageRoots ? { roots: options.imageRoots } : {}) })
        : undefined;
      ctx.abortSignal?.throwIfAborted();
      for await (const event of active.session.prompt(
        composePrompt(ctx, note, lead, deliversSystemPrompt, host?.text ?? ctx.prompt),
        host?.images,
      )) {
        if (event.kind === "usage") {
          summary.usage = event.usage;
          continue;
        }
        if (!tools.admit(event)) continue;
        if (event.kind === "error") turnFailed = true;
        // Recorded only for a finished turn: a failed or aborted one resends next time. A moved chat is recorded under its new id.
        if (event.kind === "result" && chat && system && (delivering !== "none" || (resumed && resumed !== chat))) delivered?.record(chat, system);
        if (event.kind === "result" || event.kind === "error") {
          closed = true;
          for (const record of tools.closeOpen()) yield record;
        }
        if (event.kind === "result" && readsUsage && !summary.usage) {
          summary.usage = await readTurnUsage(
            adapter,
            {
              sessionId: active.session.sessionId,
              startedAt,
              endedAt: Date.now(),
              env: { ...ctx.env, ...home.env },
              ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
            },
            warn,
          );
        }
        yield toRecord(event satisfies NormalizedEvent, summary);
      }
      ctx.abortSignal?.throwIfAborted();
      if (!closed) {
        turnFailed = true;
        for (const record of tools.closeOpen()) yield record;
        yield errorRecord(
          new CliError({ code: "empty_response", message: "The CLI ended the turn without a result." }),
        );
      }
    } catch (error) {
      turnFailed = true;
      if (ctx.abortSignal?.aborted) throw error;
      for (const record of tools.closeOpen()) yield record;
      yield errorRecord(error);
    } finally {
      ctx.abortSignal?.removeEventListener("abort", onAbort);
      clearTimeout(graceTimer);
      // A request that arrives from now on belongs to no turn.
      turn.ended = true;
      active.turn = undefined;
      active.proxy?.clearTarget();
      active.busy = false;
      active.member.lastUsed = Date.now();
      if (turnFailed || active.degraded || !live || !active.session.alive || ctx.abortSignal?.aborted) {
        active.handle.close("abort");
      } else {
        active.idleTimer = setTimeout(() => active.handle.close("idle"), idleMs);
        active.idleTimer.unref();
      }
    }
  }

  return async function* execute(ctx) {
    ctx.abortSignal?.throwIfAborted();
    // AD-14: the turn slot comes first and is held for the whole turn. The wait has no timer of
    // its own (AD-11): it ends on a free slot or on the host's abort.
    let slot: TurnSlot;
    try {
      slot = await pool.acquireTurn(ctx.abortSignal);
    } catch (error) {
      if (ctx.abortSignal?.aborted) throw error;
      // A superseded run must throw, not turn into an error record.
      ctx.assertCurrent?.();
      yield errorRecord(error);
      return;
    }
    try {
      yield* run(ctx);
    } finally {
      slot.release();
    }
  };
}
