import type { AgentHome } from "./home.ts";
import { CliError, type CliSession } from "./ports.ts";
import type { LiveSessionHandle } from "./sdk-types.ts";

/** What the registry needs of a live process entry. */
export type ChatHolder = {
  /** The chat this process holds, once open: `<home>\0<native session id>`. */
  chat?: string;
  busy: boolean;
  session?: Pick<CliSession, "waitForExit">;
  handle: Pick<LiveSessionHandle, "close">;
};

/**
 * The open processes by the native chat they hold. Two processes that load one chat each keep
 * their own view and the last writer wins (live probe, spec Q4), so at most one process holds a
 * chat: opening a resume closes an idle holder first.
 */
const chats = new Map<string, ChatHolder>();

function chatKey(home: AgentHome, sessionId: string): string {
  return JSON.stringify([home.dir, sessionId]);
}

export function releaseChat(entry: ChatHolder): void {
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
export async function claimChat(
  entry: ChatHolder,
  home: AgentHome,
  sessionId: string,
  signal: AbortSignal | undefined,
  abortGraceMs: number,
): Promise<void> {
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
  if (holder && holder !== entry) await waitForExit(holder, signal, abortGraceMs);
}

/** Waits for a closed holder's process to exit: until it does, until the abort, or for the abort grace. */
async function waitForExit(holder: ChatHolder, signal: AbortSignal | undefined, abortGraceMs: number): Promise<void> {
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
 * Whatever id the CLI ended up with is the chat this process holds (a new session, or a load that
 * moved the chat, has no claim yet or a claim on the old id).
 */
export function rekeyChat(entry: ChatHolder, home: AgentHome, sessionId: string): void {
  const key = chatKey(home, sessionId);
  if (entry.chat !== key) {
    releaseChat(entry);
    const other = chats.get(key);
    if (other && other !== entry) other.handle.close("restart");
    entry.chat = key;
    chats.set(key, entry);
  }
}
