import { randomUUID } from "node:crypto";
import { releaseChat } from "./chat-registry.ts";
import { startMcpProxy, type McpProxy } from "./mcp-proxy.ts";
import type { PermissionTurn } from "./permissions.ts";
import { CliError, type CliSession } from "./ports.ts";
import type { PoolMember, ProcessPool } from "./pool.ts";
import type { ExecuteContext, LiveSessionCapability, LiveSessionHandle } from "./sdk-types.ts";

export type LiveEntry = {
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
  /** The chat this process holds, once open: `<home>\0<native session id>`. See the chat registry. */
  chat?: string;
  handle: LiveSessionHandle;
  /** The process as the pool counts it, from creation until the handle closes. */
  member: PoolMember;
  /** The open in progress, so the pool can wait for a process that is still starting. */
  opening?: Promise<unknown>;
  /** Work that follows the process's exit and must finish before the process counts as gone (a side question's discard). */
  afterExit?: Promise<void>;
  /** Aborted by the handle's close, so a process that is still starting stops starting. */
  stopOpening: AbortController;
  /** The process opened a fresh agent chat and has not sent its first prompt yet (P15). */
  freshChat?: boolean;
  busy: boolean;
  idleTimer?: NodeJS.Timeout;
};

export type OpenEntry = LiveEntry & { session: CliSession };

/** Live processes by their host handle. The host owns the lifecycle; this only finds the process. */
export const liveEntries = new WeakMap<LiveSessionHandle, LiveEntry>();

/** What a new entry needs from the execute that creates it. */
export type LiveEntryDeps = { pool: ProcessPool; callDeadlineMs: number | undefined };

/**
 * Creates the host handle and the proxy for a process that is not open yet, and counts it in
 * the pool: at the process cap an idle process makes room, or the turn fails as `overloaded`.
 */
export async function createLiveEntry(
  deps: LiveEntryDeps,
  key: string,
  ctx: ExecuteContext,
  live: LiveSessionCapability | undefined,
  withMcp: boolean,
): Promise<LiveEntry> {
  const { pool, callDeadlineMs } = deps;
  const entry: LiveEntry = {
    key,
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
        await entry.afterExit;
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
