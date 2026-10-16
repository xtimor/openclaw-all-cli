import { randomUUID } from "node:crypto";
import { toRecord, type CoreRecord, type TurnSummary } from "./events.ts";
import {
  CliError,
  type CliAdapter,
  type CliSession,
  type NormalizedEvent,
  type PermissionDecision,
} from "./ports.ts";
import type { CliBackendExecute, ExecuteContext, LiveSessionCapability, LiveSessionHandle } from "./sdk-types.ts";

/** AD-14: live processes close after 15 idle minutes. */
export const DEFAULT_IDLE_MS = 15 * 60_000;
/** AD-11: after an abort, the process gets this long to stop before it is closed. */
export const DEFAULT_ABORT_GRACE_MS = 5_000;

export type ExecuteOptions = {
  idleMs?: number;
  abortGraceMs?: number;
};

type LiveEntry = {
  session: CliSession;
  /** What must match for the process to serve the next turn (AD-13). */
  key: string;
  handle: LiveSessionHandle;
  busy: boolean;
  idleTimer?: NodeJS.Timeout;
};

/** Live processes by their host handle. The host owns the lifecycle; this only finds the process. */
const entries = new WeakMap<LiveSessionHandle, LiveEntry>();

function reuseKey(ctx: ExecuteContext): string {
  return JSON.stringify([ctx.modelId, ctx.cwd]);
}

function composePrompt(ctx: ExecuteContext): string {
  const { prependContext, appendContext } = ctx.promptContext ?? {};
  return [prependContext, ctx.prompt, appendContext].filter((part): part is string => Boolean(part)).join("\n\n");
}

/** Until permission routing exists (entry 4) every CLI permission request is rejected. */
async function rejectPermission(): Promise<PermissionDecision> {
  return "reject_once";
}

function errorRecord(error: unknown): CoreRecord {
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

  function reusable(ctx: ExecuteContext, live: LiveSessionCapability | undefined): LiveEntry | undefined {
    const current = live?.current();
    if (!live || !current || current.fingerprint !== live.fingerprint) return undefined;
    const entry = entries.get(current);
    if (!entry || entry.busy || !entry.session.alive) return undefined;
    if (!ctx.useResume || ctx.sessionId !== entry.session.sessionId) return undefined;
    return entry.key === reuseKey(ctx) ? entry : undefined;
  }

  async function openEntry(ctx: ExecuteContext, live: LiveSessionCapability | undefined): Promise<LiveEntry> {
    const session = await adapter.open({
      command: ctx.command,
      args: ctx.args,
      cwd: ctx.cwd,
      env: ctx.env,
      modelId: ctx.modelId,
      ...(ctx.useResume && ctx.sessionId ? { resumeSessionId: ctx.sessionId } : {}),
      onPermissionRequest: rejectPermission,
      ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
    });
    let closing = false;
    const entry: LiveEntry = {
      session,
      key: reuseKey(ctx),
      busy: false,
      handle: {
        generation: randomUUID(),
        fingerprint: live?.fingerprint ?? randomUUID(),
        isIdle: () => !entry.busy && session.alive,
        close: () => {
          if (closing) return;
          closing = true;
          clearTimeout(entry.idleTimer);
          live?.remove(entry.handle);
          void session.close();
        },
        waitForExit: () => session.waitForExit(),
      },
    };
    return entry;
  }

  /** Hands a new process to the host. A host refusal must not orphan the process. */
  function registerEntry(entry: LiveEntry, live: LiveSessionCapability | undefined): void {
    try {
      live?.register(entry.handle);
    } catch (error) {
      void entry.session.close();
      throw error;
    }
    entries.set(entry.handle, entry);
  }

  return async function* execute(ctx) {
    ctx.assertCurrent?.();
    ctx.abortSignal?.throwIfAborted();
    const live = ctx.liveSession;

    let entry = reusable(ctx, live);
    if (!entry && live) await live.restart();
    // A superseded run must throw, not turn into an error record.
    ctx.assertCurrent?.();
    let opened = false;
    try {
      if (!entry) {
        entry = await openEntry(ctx, live);
        opened = true;
      }
    } catch (error) {
      if (ctx.abortSignal?.aborted) throw error;
      yield errorRecord(error);
      return;
    }

    const active = entry;
    // Host errors from register keep propagating as throws, not error records.
    if (opened) registerEntry(active, live);
    clearTimeout(active.idleTimer);
    active.busy = true;

    let graceTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      void active.session.cancel();
      graceTimer = setTimeout(() => active.handle.close("abort"), abortGraceMs);
      graceTimer.unref();
    };
    ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });

    let turnFailed = false;
    try {
      live?.activate(active.handle);
      ctx.abortSignal?.throwIfAborted();

      const summary: TurnSummary = { sessionId: active.session.sessionId };
      yield toRecord({ kind: "sessionId", sessionId: active.session.sessionId });

      let closed = false;
      for await (const event of active.session.prompt(composePrompt(ctx))) {
        if (event.kind === "usage") {
          summary.usage = event.usage;
          continue;
        }
        if (event.kind === "error") turnFailed = true;
        if (event.kind === "result" || event.kind === "error") closed = true;
        yield toRecord(event satisfies NormalizedEvent, summary);
      }
      ctx.abortSignal?.throwIfAborted();
      if (!closed) {
        turnFailed = true;
        yield errorRecord(
          new CliError({ code: "empty_response", message: "The CLI ended the turn without a result." }),
        );
      }
    } catch (error) {
      turnFailed = true;
      if (ctx.abortSignal?.aborted) throw error;
      yield errorRecord(error);
    } finally {
      ctx.abortSignal?.removeEventListener("abort", onAbort);
      clearTimeout(graceTimer);
      active.busy = false;
      if (turnFailed || !live || !active.session.alive || ctx.abortSignal?.aborted) {
        active.handle.close("abort");
      } else {
        active.idleTimer = setTimeout(() => active.handle.close("idle"), idleMs);
        active.idleTimer.unref();
      }
    }
  };
}
