import type { AgentHome } from "./home.ts";
import { claimChat, rekeyChat } from "./chat-registry.ts";
import { liveEntries, type LiveEntry, type OpenEntry } from "./live-entry.ts";
import { OPENCLAW_MCP_SERVER } from "./mcp-target.ts";
import { capabilityMismatch, missingCapabilities, requiredCapabilities } from "./manifest.ts";
import { routePermission } from "./permissions.ts";
import { recordProcess, type ProcessLock } from "./pid-locks.ts";
import { CliError, type CliAdapter, type CliSession, type ExecutionMode } from "./ports.ts";
import type { ExecuteContext } from "./sdk-types.ts";
import { modeOf } from "./turn-prompt.ts";

/** What opening a process needs from the execute that asks for it. */
export type AttachDeps = {
  adapter: CliAdapter;
  home: AgentHome;
  warn: (message: string) => void;
  approvals: boolean;
  continuity: boolean;
  required: ReturnType<typeof requiredCapabilities>;
  abortGraceMs: number;
};

const closedError = () =>
  new CliError({
    code: "server_error",
    message: "The live session was closed while the CLI was starting.",
    retryable: true,
  });

/** Opens the process behind a registered entry. The proxy already points at the turn's target. */
export async function attachSession(
  deps: AttachDeps,
  entry: LiveEntry,
  ctx: ExecuteContext,
  hostShell: boolean,
  args: string[],
): Promise<OpenEntry> {
  // Closed (unload, eviction, the host) before the open: no process may start.
  if (entry.closed) throw closedError();
  const mode = modeOf(ctx);
  // A side question is a throwaway chat: it never resumes and never reaches the real one.
  const resumeSessionId = mode === "agent" && ctx.useResume && ctx.sessionId ? ctx.sessionId : undefined;
  if (resumeSessionId) await claimChat(entry, deps.home, resumeSessionId, ctx.abortSignal, deps.abortGraceMs);
  if (entry.closed) throw closedError();
  const session = await openProcess(deps, entry, ctx, mode, resumeSessionId, hostShell, args);
  await settleOpened(deps, entry, ctx, session, mode, resumeSessionId);
  return entry as OpenEntry;
}

/** Starts the CLI process and records it in the agent home from its spawn. */
async function openProcess(
  { adapter, home, warn, approvals, required }: AttachDeps,
  entry: LiveEntry,
  ctx: ExecuteContext,
  mode: ExecutionMode,
  resumeSessionId: string | undefined,
  hostShell: boolean,
  args: string[],
): Promise<CliSession> {
  const { proxy } = entry;
  // The process is recorded in the agent home from its spawn, so a killed Gateway leaves a trail (AD-14).
  let lock: Promise<ProcessLock | undefined> | undefined;
  const releaseLock = () => lock?.then((held) => held?.release());
  let session: CliSession;
  try {
    session = await adapter.open({
      command: ctx.command,
      args,
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
      onProcessStart: (pid, info) => {
        lock = recordProcess(home.dir, pid, warn, { group: info?.processGroup === true });
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
  // A side question's chat is a throwaway: once its process is gone (nothing writes there any
  // more) the directory the CLI made for it goes too. The pool waits for this before it counts
  // the process as gone. A discard failure is ignored.
  if (mode === "side-question") {
    const discard = () => adapter.discardSession?.({ env: { ...ctx.env, ...home.env }, sessionId: session.sessionId });
    entry.afterExit = session.waitForExit().then(discard, discard).then(
      () => {},
      () => {},
    );
  }
  return session;
}

/** Checks the opened process, then hands it to the entry: capabilities, chat claim, exit hooks. */
async function settleOpened(
  { adapter, home, continuity }: AttachDeps,
  entry: LiveEntry,
  ctx: ExecuteContext,
  session: CliSession,
  mode: ExecutionMode,
  resumeSessionId: string | undefined,
): Promise<void> {
  const { proxy } = entry;
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
  if (mode === "agent") rekeyChat(entry, home, session.sessionId);
  // The proxy ends with its process, however the process ends.
  if (proxy) {
    void session.waitForExit().then(
      () => proxy.close(),
      () => proxy.close(),
    );
  }
  liveEntries.set(entry.handle, entry);
}
