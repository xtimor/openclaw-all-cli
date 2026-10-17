import { randomUUID } from "node:crypto";
import type { AgentHome } from "./home.ts";
import { toRecord, type CoreRecord, type TurnSummary } from "./events.ts";
import { startMcpProxy, type McpProxy } from "./mcp-proxy.ts";
import { OPENCLAW_MCP_SERVER, readTurnTarget, type TurnTarget } from "./mcp-target.ts";
import { routePermission, type PermissionTurn } from "./permissions.ts";
import { CliError, type CliAdapter, type CliSession, type NormalizedEvent } from "./ports.ts";
import type { CliBackendExecute, ExecuteContext, LiveSessionCapability, LiveSessionHandle } from "./sdk-types.ts";

/** AD-14: live processes close after 15 idle minutes. */
export const DEFAULT_IDLE_MS = 15 * 60_000;
/** AD-11: after an abort, the process gets this long to stop before it is closed. */
export const DEFAULT_ABORT_GRACE_MS = 5_000;

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
};

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
  handle: LiveSessionHandle;
  busy: boolean;
  idleTimer?: NodeJS.Timeout;
};

type OpenEntry = LiveEntry & { session: CliSession };

/** Live processes by their host handle. The host owns the lifecycle; this only finds the process. */
const entries = new WeakMap<LiveSessionHandle, LiveEntry>();

function reuseKey(ctx: ExecuteContext, home: AgentHome): string {
  return JSON.stringify([ctx.modelId, ctx.cwd, home.dir]);
}

function composePrompt(ctx: ExecuteContext): string {
  const { prependContext, appendContext } = ctx.promptContext ?? {};
  return [prependContext, ctx.prompt, appendContext].filter((part): part is string => Boolean(part)).join("\n\n");
}

/**
 * The turn's native tool calls as the host sees them: one start and at most one result per call.
 * Whatever is still open when the turn closes gets an aborted result, so the host shows nothing
 * pending whatever the adapter did.
 */
class ToolLedger {
  private readonly calls = new Map<string, { name: string; open: boolean }>();

  /** Whether the event may go to the host. A second start or result for one call is dropped. */
  admit(event: NormalizedEvent): boolean {
    if (event.kind === "toolStart") {
      if (this.calls.has(event.toolCallId)) return false;
      this.calls.set(event.toolCallId, { name: event.name, open: true });
    } else if (event.kind === "toolResult") {
      const call = this.calls.get(event.toolCallId);
      if (call && !call.open) return false;
      if (call) call.open = false;
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

  function reusable(ctx: ExecuteContext, live: LiveSessionCapability | undefined): OpenEntry | undefined {
    const current = live?.current();
    if (!live || !current || current.fingerprint !== live.fingerprint) return undefined;
    const entry = entries.get(current);
    if (!entry?.session || entry.busy || entry.degraded || !entry.session.alive) return undefined;
    if (!ctx.useResume || ctx.sessionId !== entry.session.sessionId) return undefined;
    return entry.key === reuseKey(ctx, home) ? (entry as OpenEntry) : undefined;
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

  /** Creates the host handle and the proxy for a process that is not open yet. */
  async function createEntry(ctx: ExecuteContext, live: LiveSessionCapability | undefined): Promise<LiveEntry> {
    let proxy: McpProxy | undefined;
    if (mcp) {
      try {
        proxy = await startMcpProxy();
      } catch (error) {
        throw new CliError(
          {
            code: "server_error",
            message: `Could not start the MCP proxy: ${error instanceof Error ? error.message : String(error)}`,
            retryable: true,
          },
          { cause: error },
        );
      }
    }
    const entry: LiveEntry = {
      proxy,
      key: reuseKey(ctx, home),
      busy: false,
      handle: {
        generation: randomUUID(),
        fingerprint: live?.fingerprint ?? randomUUID(),
        isIdle: () => !entry.busy && Boolean(entry.session?.alive),
        close: () => {
          if (entry.closed) return;
          entry.closed = true;
          clearTimeout(entry.idleTimer);
          live?.remove(entry.handle);
          void entry.session?.close();
          void proxy?.close();
        },
        waitForExit: () => entry.session?.waitForExit() ?? Promise.resolve(),
      },
    };
    return entry;
  }

  /** Opens the process behind a registered entry. The proxy already points at the turn's target. */
  async function attachSession(entry: LiveEntry, ctx: ExecuteContext): Promise<OpenEntry> {
    const { proxy } = entry;
    const session = await adapter.open({
      command: ctx.command,
      args: ctx.args,
      cwd: ctx.cwd,
      env: { ...ctx.env, ...home.env },
      modelId: ctx.modelId,
      ...(ctx.useResume && ctx.sessionId ? { resumeSessionId: ctx.sessionId } : {}),
      // The CLI gets only the proxy: the host's per-run URL and token never leave the core.
      ...(proxy
        ? {
            mcpServers: [
              { name: OPENCLAW_MCP_SERVER, url: proxy.url, headers: { Authorization: `Bearer ${proxy.token}` } },
            ],
          }
        : {}),
      // The process outlives turns: each request goes to the turn running when it arrives.
      onPermissionRequest: (request) => routePermission(entry.turn, request, warn),
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    });
    // The host may have closed the handle while the process was starting: the close found no
    // process to stop, so this one would leak and run against a closed proxy.
    if (entry.closed) {
      // A failing close must not hide the reason the turn cannot run.
      await session.close().catch(() => {});
      throw new CliError({
        code: "server_error",
        message: "The live session was closed while the CLI was starting.",
        retryable: true,
      });
    }
    entry.session = session;
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

  return async function* execute(ctx) {
    ctx.assertCurrent?.();
    ctx.abortSignal?.throwIfAborted();
    const live = ctx.liveSession;

    const turnTarget: TurnTarget = mcp ? await readTurnTarget(ctx.env) : { ok: false, reason: "MCP is off" };
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
        fresh = await createEntry(ctx, live);
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
        void fresh.proxy?.close();
        throw error;
      }
      // A host that tracks live sessions must know the process and activate its MCP grant before
      // the CLI connects: a CLI connects to its MCP servers while it opens the session, and one
      // rejected connection drops the server for good. So register and activate first. Host
      // errors keep propagating as throws, not error records.
      try {
        live?.register(fresh.handle);
      } catch (error) {
        void fresh.proxy?.close();
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
        entry = await attachSession(fresh, ctx);
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

      const summary: TurnSummary = { sessionId: active.session.sessionId };
      yield toRecord({ kind: "sessionId", sessionId: active.session.sessionId });

      let closed = false;
      // Each event goes to the host as it arrives; nothing waits for the turn to end.
      for await (const event of active.session.prompt(composePrompt(ctx))) {
        if (event.kind === "usage") {
          summary.usage = event.usage;
          continue;
        }
        if (!tools.admit(event)) continue;
        if (event.kind === "error") turnFailed = true;
        if (event.kind === "result" || event.kind === "error") {
          closed = true;
          for (const record of tools.closeOpen()) yield record;
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
      if (turnFailed || active.degraded || !live || !active.session.alive || ctx.abortSignal?.aborted) {
        active.handle.close("abort");
      } else {
        active.idleTimer = setTimeout(() => active.handle.close("idle"), idleMs);
        active.idleTimer.unref();
      }
    }
  };
}
