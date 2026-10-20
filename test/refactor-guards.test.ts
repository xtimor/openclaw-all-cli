import { describe, expect, it, vi } from "vitest";
import { attachSession, type AttachDeps } from "../src/core/attach-session.ts";
import { claimChat } from "../src/core/chat-registry.ts";
import type { LiveEntry } from "../src/core/live-entry.ts";
import type { ExecuteContext } from "../src/core/sdk-types.ts";

/**
 * Guards of the turn path that the refactor sweep (ticket 1.16) moved: one process per chat after
 * an open, no process for a closed handle, and the proxy that ends with its process. The module
 * state of the chat registry is shared, so every test uses its own home directory.
 */

let counter = 0;
const newHome = () => ({ dir: `/refactor-guards/${process.pid}/${counter++}`, env: {} }) as never;

type Exit = { promise: Promise<void>; resolve: () => void; reject: () => void };
function exitOf(): Exit {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = () => rej(new Error("gone"));
  });
  return { promise, resolve, reject };
}

function sessionStub(sessionId: string, exit: Exit = exitOf()) {
  return {
    sessionId,
    alive: true,
    waitForExit: () => exit.promise,
    close: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    prompt: vi.fn(),
  };
}

function entryStub(overrides: Partial<LiveEntry> = {}): LiveEntry {
  const entry = {
    key: "k",
    busy: false,
    stopOpening: new AbortController(),
    member: {},
    handle: { close: vi.fn() },
    ...overrides,
  };
  return entry as unknown as LiveEntry;
}

function depsOf(home: never, session: ReturnType<typeof sessionStub> | undefined) {
  const open = vi.fn(async () => session);
  const deps = {
    adapter: { open, manifest: { rows: {} }, displayName: "Acme" },
    home,
    warn: () => {},
    approvals: true,
    continuity: false,
    required: [],
    abortGraceMs: 1000,
  } as unknown as AttachDeps;
  return { deps, open };
}

const ctxOf = (extra: Record<string, unknown> = {}) =>
  ({ command: "acme", cwd: "/", env: {}, modelId: "m", args: [], ...extra }) as unknown as ExecuteContext;

/** An entry that holds a chat as an idle, open process. */
async function holderOf(home: never, sessionId: string, exit: Exit = exitOf()): Promise<LiveEntry> {
  const holder = entryStub({ session: sessionStub(sessionId, exit) as never });
  await claimChat(holder, home, sessionId, undefined, 1000);
  return holder;
}

describe("one process per chat after the open", () => {
  it("closes an idle holder of the id the CLI moved the chat to, and releases the old claim", async () => {
    const home = newHome();
    const other = await holderOf(home, "moved-id");
    const entry = entryStub();
    const { deps } = depsOf(home, sessionStub("moved-id"));

    // The turn resumes "old-id" (claimed before the open); the CLI answers with another id.
    await attachSession(deps, entry, ctxOf({ useResume: true, sessionId: "old-id" }), false, []);

    expect(other.handle.close).toHaveBeenCalledWith("restart");
    // The old claim is gone: a newcomer for "old-id" finds no holder to close.
    const newcomer = entryStub();
    await claimChat(newcomer, home, "old-id", undefined, 1000);
    expect(entry.handle.close).not.toHaveBeenCalled();
    // The new id is claimed by the entry: a newcomer for it closes the entry (it is idle and open).
    entry.session!.waitForExit = () => Promise.resolve();
    await claimChat(entryStub(), home, "moved-id", undefined, 1000);
    expect(entry.handle.close).toHaveBeenCalledWith("restart");
  });

  it("claims the id of a new chat, so a later resume of it finds the holder", async () => {
    const home = newHome();
    const entry = entryStub();
    const { deps } = depsOf(home, sessionStub("fresh-id"));
    await attachSession(deps, entry, ctxOf(), false, []);

    entry.session!.waitForExit = () => Promise.resolve();
    await claimChat(entryStub(), home, "fresh-id", undefined, 1000);
    expect(entry.handle.close).toHaveBeenCalledWith("restart");
  });
});

describe("a closed handle never starts a process", () => {
  it("does not open when the entry was closed before the claim", async () => {
    const entry = entryStub({ closed: true });
    const { deps, open } = depsOf(newHome(), sessionStub("x"));
    await expect(attachSession(deps, entry, ctxOf({ useResume: true, sessionId: "c0" }), false, [])).rejects.toThrow(
      /closed while the CLI was starting/,
    );
    expect(open).not.toHaveBeenCalled();
  });

  it("does not open when the entry was closed while it waited for the old holder", async () => {
    const home = newHome();
    const holderExit = exitOf();
    await holderOf(home, "c1", holderExit);
    const entry = entryStub();
    const { deps, open } = depsOf(home, sessionStub("c1"));

    const attaching = attachSession(deps, entry, ctxOf({ useResume: true, sessionId: "c1" }), false, []);
    const outcome = expect(attaching).rejects.toThrow(/closed while the CLI was starting/);
    await Promise.resolve();
    entry.closed = true;
    holderExit.resolve();
    await outcome;
    expect(open).not.toHaveBeenCalled();
  });
});

describe("the MCP proxy ends with its process", () => {
  const proxyStub = () => ({ url: "http://127.0.0.1:1/mcp", token: "t", close: vi.fn(async () => {}) });

  async function attachWithProxy(busy: boolean) {
    const exit = exitOf();
    const proxy = proxyStub();
    const entry = entryStub({ busy, proxy: proxy as never });
    const { deps } = depsOf(newHome(), sessionStub("p-id", exit));
    await attachSession(deps, entry, ctxOf(), false, []);
    expect(proxy.close).not.toHaveBeenCalled();
    return { exit, proxy };
  }

  it("closes the proxy when an idle process exits", async () => {
    const { exit, proxy } = await attachWithProxy(false);
    exit.resolve();
    await vi.waitFor(() => expect(proxy.close).toHaveBeenCalledTimes(1));
  });

  it("closes the proxy when the process exits during a turn", async () => {
    const { exit, proxy } = await attachWithProxy(true);
    exit.resolve();
    await vi.waitFor(() => expect(proxy.close).toHaveBeenCalledTimes(1));
  });

  it("closes the proxy when waiting for the exit fails", async () => {
    const { exit, proxy } = await attachWithProxy(false);
    exit.reject();
    await vi.waitFor(() => expect(proxy.close).toHaveBeenCalledTimes(1));
  });
});
