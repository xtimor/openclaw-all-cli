import { attachSession, type AttachDeps } from "./attach-session.ts";
import type { AgentHome } from "./home.ts";
import { toRecord, type CoreRecord, type TurnSummary } from "./events.ts";
import { IMAGE_FRESHNESS_MS, takeHostImages } from "./images.ts";
import { createLiveEntry, liveEntries, type LiveEntry, type LiveEntryDeps, type OpenEntry } from "./live-entry.ts";
import { listToolNames, type McpProxy } from "./mcp-proxy.ts";
import { readTurnTarget, type TurnTarget } from "./mcp-target.ts";
import { requiredCapabilities } from "./manifest.ts";
import { readTurnUsage } from "./usage.ts";
import { DeliveredPrompts, deliveredFileFor, planDelivery } from "./system-prompt.ts";
import { ProcessPool, type TurnSlot } from "./pool.ts";
import { CONTINUITY_NOTE, HOST_SHELL_TOOL, composePrompt, modeOf, splitHostShell } from "./turn-prompt.ts";
import { ToolLedger } from "./tool-ledger.ts";
import { CliError, type CliAdapter, type NormalizedEvent } from "./ports.ts";
import type { CliBackendExecute, ExecuteContext, LiveSessionCapability } from "./sdk-types.ts";

export { CONTINUITY_NOTE, HOST_SHELL_ARG } from "./turn-prompt.ts";

/** AD-14: live processes close after 15 idle minutes. */
const DEFAULT_IDLE_MS = 15 * 60_000;
/** AD-11: after an abort, the process gets this long to stop before it is closed. */
const DEFAULT_ABORT_GRACE_MS = 5_000;

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

/** AD-13: model, mode, working directory, home, and auth profile. The native session ID is checked on the session. */
function reuseKey(ctx: ExecuteContext, home: AgentHome, authProfileId: string | undefined, hostShell: boolean): string {
  return JSON.stringify([ctx.modelId, modeOf(ctx), hostShell, ctx.cwd, home.dir, authProfileId ?? null]);
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

  const attachDeps: AttachDeps = { adapter, home, warn, approvals, continuity, required, abortGraceMs };
  const liveEntryDeps: LiveEntryDeps = { pool, callDeadlineMs };

  function reusable(ctx: ExecuteContext, live: LiveSessionCapability | undefined, hostShell: boolean): OpenEntry | undefined {
    const current = live?.current();
    if (!live || !current || current.fingerprint !== live.fingerprint) return undefined;
    const entry = liveEntries.get(current);
    if (!entry?.session || entry.busy || entry.degraded || !entry.session.alive) return undefined;
    if (!ctx.useResume || ctx.sessionId !== entry.session.sessionId) return undefined;
    return entry.key === reuseKey(ctx, home, authProfileId, hostShell) ? (entry as OpenEntry) : undefined;
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

  /** A process opened for this turn, or the record that says why it could not be. */
  type Fresh = { entry: OpenEntry } | { record: CoreRecord };

  /** Opens a process for a turn that found none to reuse: version check, handle, registration, proxy, session. */
  async function openFresh(
    ctx: ExecuteContext,
    live: LiveSessionCapability | undefined,
    withMcp: boolean,
    turnTarget: TurnTarget,
    shell: ReturnType<typeof splitHostShell>,
  ): Promise<Fresh> {
    let fresh: LiveEntry;
    try {
      await ensureVersion(ctx);
      fresh = await createLiveEntry(liveEntryDeps, reuseKey(ctx, home, authProfileId, shell.hostShell), ctx, live, withMcp);
    } catch (error) {
      if (ctx.abortSignal?.aborted) throw error;
      // A superseded run must throw, not turn into an error record.
      ctx.assertCurrent?.();
      return { record: errorRecord(error) };
    }
    try {
      ctx.assertCurrent?.();
    } catch (error) {
      fresh.handle.close("abort");
      throw error;
    }
    // Closed while the proxy started (unload): never hand the host a closed handle.
    if (fresh.closed) {
      return { record: errorRecord(new CliError({ code: "server_error", message: "The plugin is shutting down.", retryable: true })) };
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
      const marked = shell.hostShell && turnTarget.ok;
      const listed = marked && turnTarget.ok ? await listToolNames(turnTarget.target, ctx.abortSignal) : undefined;
      const hostShell = listed?.includes(HOST_SHELL_TOOL) === true;
      // The host may serve exec but the list could not be read (an error, a cold cache): this
      // process opened in the restrictive mode. Never reuse it, so the next turn reads the list again.
      if (marked && listed === undefined) fresh.degraded = true;
      ctx.abortSignal?.throwIfAborted();
      const opening = attachSession(attachDeps, fresh, ctx, hostShell, shell.args);
      fresh.opening = opening;
      return { entry: await opening };
    } catch (error) {
      fresh.handle.close("abort");
      if (ctx.abortSignal?.aborted) throw error;
      // A newer run's restart closes the handle during the open: that run is superseded.
      ctx.assertCurrent?.();
      return { record: errorRecord(error) };
    }
  }

  /** What one turn's helpers share. */
  type TurnArgs = {
    ctx: ExecuteContext;
    live: LiveSessionCapability | undefined;
    turnTarget: TurnTarget;
    /** The process was opened for this turn: it is already registered, activated, and pointed. */
    opened: boolean;
    turnStart: number;
    sideQuestion: boolean;
  };

  async function* run(ctx: ExecuteContext, turnStart: number): ReturnType<CliBackendExecute> {
    ctx.assertCurrent?.();
    ctx.abortSignal?.throwIfAborted();
    const sideQuestion = modeOf(ctx) === "side-question";
    // The host gives a side question no live session; if it ever did, the side question must not
    // restart or replace the chat's process.
    const live = sideQuestion ? undefined : ctx.liveSession;
    // A side question gets no OpenClaw tools: no proxy, no MCP server, no settings file read.
    const withMcp = mcp && !sideQuestion;
    const shell = splitHostShell(ctx);

    const turnTarget: TurnTarget = withMcp ? await readTurnTarget(ctx.env) : { ok: false, reason: "MCP is off" };
    ctx.abortSignal?.throwIfAborted();
    let entry = reusable(ctx, live, shell.hostShell);
    if (!entry && live) await live.restart();
    // A superseded run must throw, not turn into an error record.
    ctx.assertCurrent?.();
    const opened = !entry;
    if (!entry) {
      const fresh = await openFresh(ctx, live, withMcp, turnTarget, shell);
      if ("record" in fresh) {
        yield fresh.record;
        return;
      }
      entry = fresh.entry;
    }
    yield* runTurn({ ctx, live, turnTarget, opened, turnStart, sideQuestion }, entry);
  }

  /** The turn on an open process: abort handling, the prompt, and the cleanup that decides whether the process lives on. */
  async function* runTurn(turnArgs: TurnArgs, active: OpenEntry): ReturnType<CliBackendExecute> {
    const { ctx, live, turnTarget, opened } = turnArgs;
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

    const state = { failed: false };
    const tools = new ToolLedger();
    try {
      // A process opened for this turn is already registered, activated, and pointed.
      if (!opened) {
        live?.activate(active.handle);
        ctx.abortSignal?.throwIfAborted();
        if (active.proxy) pointProxy(active.proxy, turnTarget);
      }
      ctx.abortSignal?.throwIfAborted();
      yield* promptTurn(turnArgs, active, tools, state);
    } catch (error) {
      state.failed = true;
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
      if (state.failed || active.degraded || !live || !active.session.alive || ctx.abortSignal?.aborted) {
        active.handle.close("abort");
      } else {
        active.idleTimer = setTimeout(() => active.handle.close("idle"), idleMs);
        active.idleTimer.unref();
      }
    }
  }

  /** The prompt of a turn and its events as host records. `state.failed` is set when the turn did not end well. */
  async function* promptTurn(
    { ctx, turnStart, sideQuestion }: TurnArgs,
    active: OpenEntry,
    tools: ToolLedger,
    state: { failed: boolean },
  ): ReturnType<CliBackendExecute> {
    // AD-16: the host's image paths leave the text and the images go as blocks. Nothing is written. Read
    // first: an abort here must leave the chat's fresh-chat mark and the continuity note untouched.
    const host = deliversImages
      ? await takeHostImages(ctx.prompt, {
          ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
          warn,
          notBefore: turnStart - IMAGE_FRESHNESS_MS,
          ...(options.imageRoots ? { roots: options.imageRoots } : {}),
        })
      : undefined;
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
    const delivery = planDelivery({
      enabled: deliversSystemPrompt,
      systemPrompt: ctx.systemPrompt,
      sideQuestion,
      sessionId: active.session.sessionId,
      useResume: ctx.useResume,
      resumedId: ctx.sessionId,
      delivered,
    });
    const startedAt = Date.now();
    ctx.abortSignal?.throwIfAborted();
    for await (const event of active.session.prompt(
      composePrompt(ctx, note, delivery.lead, deliversSystemPrompt, host?.text ?? ctx.prompt),
      host?.images,
    )) {
      if (event.kind === "usage") {
        summary.usage = event.usage;
        continue;
      }
      if (!tools.admit(event)) continue;
      if (event.kind === "error") state.failed = true;
      if (event.kind === "result") delivery.recordResult();
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
      state.failed = true;
      for (const record of tools.closeOpen()) yield record;
      yield errorRecord(new CliError({ code: "empty_response", message: "The CLI ended the turn without a result." }));
    }
  }

  return async function* execute(ctx) {
    // The host wrote the turn's image files just before it called us; the wait for a slot may be long.
    const turnStart = Date.now();
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
      yield* run(ctx, turnStart);
    } finally {
      slot.release();
    }
  };
}

