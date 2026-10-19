import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { CONTINUITY_NOTE, createExecute } from "./execute.ts";
import { inspectProcess } from "./pid-locks.ts";
import { ProcessPool } from "./pool.ts";
import type { McpProxy } from "./mcp-proxy.ts";
import { parseJsonlEvent } from "./events.ts";
import { SETTINGS_PATH_ENV } from "./mcp-target.ts";
import {
  CliError,
  type CheckVersionParams,
  type CliAdapter,
  type CliCapability,
  type CliSession,
  type NormalizedEvent,
  type OpenParams,
  type PermissionDecision,
  type PermissionRequest,
  type UsageQuery,
} from "./ports.ts";
import { createManifest } from "./ports.ts";
import type { ExecuteContext, LiveSessionCapability, LiveSessionHandle } from "./sdk-types.ts";

const proxies = vi.hoisted(() => ({
  started: [] as McpProxy[],
  /** Called before the next proxy starts; a throw there fails the start. */
  beforeStart: undefined as (() => void | Promise<void>) | undefined,
}));
vi.mock("./mcp-proxy.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-proxy.ts")>();
  return {
    ...actual,
    startMcpProxy: async () => {
      await proxies.beforeStart?.();
      const proxy = await actual.startMcpProxy();
      proxies.started.push(proxy);
      return proxy;
    },
  };
});

const HOME = { dir: "/agent/openclaw-all-cli/acme-cli", env: { ACME_HOME: "/agent/openclaw-all-cli/acme-cli" } };

type Script = (prompt: string, session: FakeSession) => AsyncGenerator<NormalizedEvent>;

/** How long a closed FakeSession takes to exit, for tests that must observe the wait. */
const fake = { exitDelayMs: 0 };

class FakeSession implements CliSession {
  alive = true;
  /** What the CLI reported at open; absent means it reports nothing. */
  capabilities?: ReadonlySet<CliCapability>;
  cancelled = 0;
  closed = 0;
  prompts: string[] = [];
  private exit: () => void = () => {};
  private readonly exited = new Promise<void>((resolve) => (this.exit = resolve));
  constructor(
    readonly sessionId: string,
    private readonly script: Script,
  ) {}
  prompt(text: string) {
    this.prompts.push(text);
    return this.script(text, this);
  }
  async cancel() {
    this.cancelled += 1;
  }
  async close() {
    this.closed += 1;
    this.alive = false;
    if (fake.exitDelayMs > 0) setTimeout(this.exit, fake.exitDelayMs);
    else this.exit();
  }
  /** The process dies on its own. */
  die() {
    this.alive = false;
    this.exit();
  }
  waitForExit() {
    return this.exited;
  }
}

const okTurn: Script = async function* (prompt) {
  yield { kind: "text", text: "he" };
  yield { kind: "text", text: "llo" };
  yield { kind: "usage", usage: { input: 3, output: 5 } };
  yield { kind: "result", text: `echo:${prompt}`, stopReason: "end_turn" };
};

function makeAdapter(script: Script = okTurn, nativeId?: (params: OpenParams, count: number) => string) {
  const sessions: FakeSession[] = [];
  const opens: OpenParams[] = [];
  const versionChecks: CheckVersionParams[] = [];
  const version: { result: () => Promise<"ok" | { warning: string }> } = { result: async () => "ok" };
  const adapter: CliAdapter = {
    id: "acme",
    displayName: "Acme",
    command: "acme",
    launchArgs: ["serve"],
    defaultModel: "acme-cli/auto",
    manifest: createManifest("1", {}),
    alwaysOnNativeTools: ["read"],
    clearEnv: [],
    checkVersion: async (params) => {
      versionChecks.push(params);
      return version.result();
    },
    probeAuth: async () => "available",
    listModels: async () => [],
    prepareHome: async (home) => ({ ACME_HOME: home }),
    open: async (params) => {
      opens.push(params);
      const session = new FakeSession(nativeId?.(params, sessions.length + 1) ?? `native-${sessions.length + 1}`, script);
      sessions.push(session);
      return session;
    },
  };
  return { adapter, sessions, opens, versionChecks, version };
}

function makeLive() {
  const calls = { restart: 0, register: 0, activate: 0, remove: 0 };
  let current: LiveSessionHandle | undefined;
  const live: LiveSessionCapability = {
    fingerprint: "fp",
    current: () => current,
    restart: async () => {
      calls.restart += 1;
      current?.close("restart");
      current = undefined;
    },
    register: (handle) => {
      calls.register += 1;
      current = handle;
    },
    activate: () => {
      calls.activate += 1;
    },
    remove: (handle) => {
      calls.remove += 1;
      if (current === handle) current = undefined;
    },
  };
  return { live, calls, current: () => current };
}

function makeCtx(overrides: Partial<ExecuteContext> = {}): ExecuteContext {
  return {
    command: "acme",
    args: ["serve"],
    cwd: "/work",
    env: { PATH: "/bin" },
    prompt: "hi",
    modelId: "auto",
    systemPrompt: "",
    useResume: false,
    timeoutMs: 60_000,
    requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
    requestUserInput: async () => ({ status: "cancelled", message: "no" }),
    ...overrides,
  };
}

async function run(execute: ReturnType<typeof createExecute>, ctx: ExecuteContext) {
  const records: Record<string, unknown>[] = [];
  for await (const record of execute(ctx)) records.push(record);
  return records;
}

const parsed = (records: Record<string, unknown>[]) =>
  records.flatMap((record) => {
    const result = parseJsonlEvent(JSON.stringify(record));
    return result === null ? [] : Array.isArray(result) ? result : [result];
  });

/** A settings env whose target is never called: enough for the core to treat the turn as having tools. */
const usableEnv = (() => {
  const dir = mkdtempSync(join(tmpdir(), "oac-execute-usable-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { openclaw: { url: "http://127.0.0.1:1/mcp", headers: {} } } }));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  return { PATH: "/bin", [SETTINGS_PATH_ENV]: file };
})();

const proxyRefuses = (url: string) => fetch(url, { method: "POST", body: "{}" }).then(() => false, () => true);

describe("createExecute", () => {
  it("streams a turn: session ID, deltas, then one result with usage", async () => {
    const { adapter, sessions, opens } = makeAdapter();
    const { live, calls } = makeLive();
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live, env: usableEnv }));

    expect(parsed(records)).toEqual([
      { kind: "sessionId", sessionId: "native-1" },
      { kind: "text", text: "he" },
      { kind: "text", text: "llo" },
      { kind: "result", text: "echo:hi", sessionId: "native-1", usage: { input: 3, output: 5 } },
    ]);
    expect(records.filter((record) => record.type === "result")).toHaveLength(1);
    expect(calls).toMatchObject({ register: 1, activate: 1, restart: 1 });
    expect(opens[0]).toMatchObject({ command: "acme", args: ["serve"], cwd: "/work", modelId: "auto" });
    expect(opens[0]?.resumeSessionId).toBeUndefined();
    expect(sessions[0]?.closed).toBe(0);
  });

  it("reuses the warm process when model, cwd, and native session match", async () => {
    const { adapter, sessions, opens } = makeAdapter();
    const { live, calls } = makeLive();
    const execute = createExecute(adapter, { home: HOME });
    await run(execute, makeCtx({ liveSession: live, env: usableEnv }));
    await run(execute, makeCtx({ liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1", prompt: "again" }));

    expect(opens).toHaveLength(1);
    expect(sessions[0]?.prompts).toEqual(["hi", "again"]);
    expect(calls.restart).toBe(1);
  });

  it.each([
    ["another model", { modelId: "fast" }],
    ["another directory", { cwd: "/elsewhere" }],
    ["a fresh conversation", { useResume: false }],
    ["another native session", { sessionId: "native-other" }],
  ])("opens a new process for %s", async (_name, change) => {
    const { adapter, sessions, opens } = makeAdapter();
    const { live, calls } = makeLive();
    const execute = createExecute(adapter, { home: HOME });
    await run(execute, makeCtx({ liveSession: live, env: usableEnv }));
    await run(execute, makeCtx({ liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1", ...change }));

    expect(opens).toHaveLength(2);
    expect(sessions[0]?.closed).toBe(1);
    expect(calls.restart).toBe(2);
  });

  it("opens a new process when the agent's home differs", async () => {
    const { adapter, opens } = makeAdapter();
    const { live } = makeLive();
    const other = { dir: "/other/openclaw-all-cli/acme-cli", env: { ACME_HOME: "/other/openclaw-all-cli/acme-cli" } };
    await run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live, env: usableEnv }));
    await run(
      createExecute(adapter, { home: other }),
      makeCtx({ liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1" }),
    );
    expect(opens).toHaveLength(2);
  });

  it("adds the home's env to the process env, over the host's", async () => {
    const { adapter, opens } = makeAdapter();
    await run(createExecute(adapter, { home: HOME }), makeCtx({ env: { PATH: "/bin", ACME_HOME: "/host" } }));
    expect(opens[0]?.env).toEqual({ PATH: "/bin", ACME_HOME: HOME.env.ACME_HOME });
  });

  it("resumes the native session after a restart", async () => {
    const { adapter, opens } = makeAdapter();
    await run(createExecute(adapter, { home: HOME }), makeCtx({ useResume: true, sessionId: "native-7" }));
    expect(opens[0]?.resumeSessionId).toBe("native-7");
  });

  it("closes the process after the turn when the host gives no live session", async () => {
    const { adapter, sessions } = makeAdapter();
    await run(createExecute(adapter, { home: HOME }), makeCtx());
    expect(sessions[0]?.closed).toBe(1);
  });

  it("closes an idle process after the idle time", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, sessions } = makeAdapter();
      const { live, calls } = makeLive();
      await run(createExecute(adapter, { home: HOME, idleMs: 1000 }), makeCtx({ liveSession: live, env: usableEnv }));
      expect(sessions[0]?.closed).toBe(0);
      await vi.advanceTimersByTimeAsync(1001);
      expect(sessions[0]?.closed).toBe(1);
      expect(calls.remove).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns an adapter error into an error result and drops the process", async () => {
    const failing: Script = async function* () {
      yield { kind: "error", error: { code: "rate_limit", retryable: true, message: "slow down" } };
    };
    const { adapter, sessions } = makeAdapter(failing);
    const { live, calls } = makeLive();
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live }));
    expect(parsed(records).at(-1)).toEqual({ kind: "result", errorText: "slow down" });
    expect(records.at(-1)).toMatchObject({ type: "result", is_error: true });
    expect(sessions[0]?.closed).toBe(1);
    expect(calls.remove).toBe(1);
  });

  it("reports a failed open as an error result", async () => {
    const { adapter } = makeAdapter();
    adapter.open = async () => {
      throw new CliError({ code: "cli_not_found", message: "no binary" });
    };
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx());
    expect(parsed(records)).toEqual([{ kind: "result", errorText: "no binary" }]);
  });

  it("reports a turn that ends without a result", async () => {
    const silent: Script = async function* () {
      yield { kind: "text", text: "partial" };
    };
    const { adapter, sessions } = makeAdapter(silent);
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx());
    expect(parsed(records).at(-1)).toMatchObject({ kind: "result", errorText: expect.stringContaining("without a result") });
    expect(sessions[0]?.closed).toBe(1);
  });

  it("cancels the CLI on abort, then closes it", async () => {
    const hanging: Script = async function* (_prompt, session) {
      while (session.cancelled === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      yield { kind: "error", error: { code: "unknown", retryable: false, message: "cancelled" } };
    };
    const { adapter, sessions } = makeAdapter(hanging);
    const controller = new AbortController();
    const turn = run(createExecute(adapter, { home: HOME }), makeCtx({ abortSignal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error("stop"));
    await expect(turn).rejects.toThrow();
    expect(sessions[0]?.cancelled).toBe(1);
    expect(sessions[0]?.closed).toBe(1);
  });

  it("closes the process after the abort grace when the CLI ignores the cancel", async () => {
    const stubborn: Script = async function* (_prompt, session) {
      while (session.alive) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const { adapter, sessions } = makeAdapter(stubborn);
    const controller = new AbortController();
    const turn = run(createExecute(adapter, { home: HOME, abortGraceMs: 20 }), makeCtx({ abortSignal: controller.signal }));
    const outcome = expect(turn).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error("stop"));
    await outcome;
    expect(sessions[0]?.cancelled).toBe(1);
    expect(sessions[0]?.closed).toBe(1);
  });

  it("opens a new process when the warm one died", async () => {
    const { adapter, sessions, opens } = makeAdapter();
    const { live } = makeLive();
    const execute = createExecute(adapter, { home: HOME });
    await run(execute, makeCtx({ liveSession: live, env: usableEnv }));
    sessions[0]!.alive = false;
    await run(execute, makeCtx({ liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1" }));
    expect(opens).toHaveLength(2);
    expect(opens[1]?.resumeSessionId).toBe("native-1");
  });

  it("opens a new process and restarts when the host's fingerprint changed", async () => {
    const { adapter, opens } = makeAdapter();
    const { live, calls } = makeLive();
    const execute = createExecute(adapter, { home: HOME });
    await run(execute, makeCtx({ liveSession: live, env: usableEnv }));
    const changed = { ...live, fingerprint: "other" } as LiveSessionCapability;
    await run(execute, makeCtx({ liveSession: changed, env: usableEnv, useResume: true, sessionId: "native-1" }));
    expect(opens).toHaveLength(2);
    expect(calls.restart).toBe(2);
  });

  it("throws, not an error record, when the run was superseded during the restart", async () => {
    const { adapter, opens } = makeAdapter();
    const { live } = makeLive();
    let current = true;
    const ctx = makeCtx({
      liveSession: live,
      assertCurrent: () => {
        if (!current) throw new Error("superseded");
      },
    });
    live.restart = async () => {
      current = false;
    };
    await expect(run(createExecute(adapter, { home: HOME }), ctx)).rejects.toThrow("superseded");
    expect(opens).toHaveLength(0);
  });

  it("rethrows and opens no process when the host refuses to register the handle", async () => {
    const { adapter, opens } = makeAdapter();
    const { live } = makeLive();
    live.register = () => {
      throw new Error("host refused");
    };
    const before = proxies.started.length;
    await expect(run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live }))).rejects.toThrow("host refused");
    expect(opens).toHaveLength(0);
    expect(proxies.started).toHaveLength(before + 1);
    expect(await proxyRefuses(proxies.started.at(-1)!.url)).toBe(true);
  });

  it("removes the handle, closes the proxy, and rethrows when the host refuses to activate it", async () => {
    const { adapter, opens } = makeAdapter();
    const { live, calls } = makeLive();
    live.activate = () => {
      throw new Error("activation refused");
    };
    const before = proxies.started.length;
    await expect(run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live }))).rejects.toThrow("activation refused");
    expect(opens).toHaveLength(0);
    expect(calls.remove).toBe(1);
    expect(proxies.started).toHaveLength(before + 1);
    expect(await proxyRefuses(proxies.started.at(-1)!.url)).toBe(true);
  });

  it("closes the proxy and rethrows when the run was superseded after the proxy started", async () => {
    const { adapter, opens } = makeAdapter();
    const { live, calls } = makeLive();
    let checks = 0;
    // Calls: start of the turn, after the restart, after the proxy started.
    const ctx = makeCtx({
      liveSession: live,
      assertCurrent: () => {
        checks += 1;
        if (checks >= 3) throw new Error("superseded");
      },
    });
    const before = proxies.started.length;
    await expect(run(createExecute(adapter, { home: HOME }), ctx)).rejects.toThrow("superseded");
    expect(opens).toHaveLength(0);
    expect(calls.register).toBe(0);
    expect(await proxyRefuses(proxies.started[before]!.url)).toBe(true);
  });

  it("reports a proxy that cannot start as an error result, but still throws on abort", async () => {
    const { adapter, opens } = makeAdapter();
    proxies.beforeStart = () => {
      throw new Error("no port");
    };
    try {
      const records = await run(createExecute(adapter, { home: HOME }), makeCtx());
      expect(parsed(records)).toEqual([{ kind: "result", errorText: expect.stringContaining("no port") }]);
      expect(opens).toHaveLength(0);

      const controller = new AbortController();
      proxies.beforeStart = () => {
        controller.abort(new Error("stop"));
        throw new Error("no port");
      };
      await expect(run(createExecute(adapter, { home: HOME }), makeCtx({ abortSignal: controller.signal }))).rejects.toThrow();
    } finally {
      proxies.beforeStart = undefined;
    }
  });

  it("registers and activates the host handle before the CLI opens its session", async () => {
    const { adapter } = makeAdapter();
    const { live } = makeLive();
    const order: string[] = [];
    const register = live.register;
    const activate = live.activate;
    live.register = (handle) => {
      order.push("register");
      register(handle);
    };
    live.activate = (handle) => {
      order.push("activate");
      activate(handle);
    };
    const open = adapter.open;
    adapter.open = async (params) => {
      order.push("open");
      return open(params);
    };
    await run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live }));
    expect(order).toEqual(["register", "activate", "open"]);
  });

  it("removes the registered handle when the open fails", async () => {
    const { adapter } = makeAdapter();
    const { live, calls } = makeLive();
    adapter.open = async () => {
      throw new CliError({ code: "cli_not_found", message: "no binary" });
    };
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live }));
    expect(parsed(records)).toEqual([{ kind: "result", errorText: "no binary" }]);
    expect(calls.remove).toBe(1);
  });

  it("rethrows a host failover error from restart without yielding an error record", async () => {
    const { adapter, opens } = makeAdapter();
    const { live } = makeLive();
    const hostError = Object.assign(new Error("session expired"), { reason: "session_expired" });
    live.restart = async () => {
      throw hostError;
    };
    const records: Record<string, unknown>[] = [];
    const consume = async () => {
      for await (const record of createExecute(adapter, { home: HOME })(makeCtx({ liveSession: live }))) records.push(record);
    };
    await expect(consume()).rejects.toBe(hostError);
    expect(records).toEqual([]);
    expect(opens).toHaveLength(0);
  });

  it("does not start a turn that is already aborted", async () => {
    const { adapter, opens } = makeAdapter();
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(run(createExecute(adapter, { home: HOME }), makeCtx({ abortSignal: controller.signal }))).rejects.toThrow();
    expect(opens).toHaveLength(0);
  });

  it("adds the host's private prompt context around the prompt", async () => {
    const { adapter, sessions } = makeAdapter();
    await run(
      createExecute(adapter, { home: HOME }),
      makeCtx({ promptContext: { prependContext: "before", appendContext: "after" } }),
    );
    expect(sessions[0]?.prompts).toEqual(["before\n\nhi\n\nafter"]);
  });
});

describe("createExecute continuity note (P15)", () => {
  const withNote = (text: string) => `${CONTINUITY_NOTE}\n\n${text}`;

  it("puts the note first on the first prompt of a fresh chat, then never again on the warm process", async () => {
    const { adapter, sessions, opens } = makeAdapter();
    const { live } = makeLive();
    const execute = createExecute(adapter, { home: HOME, continuity: true });
    await run(execute, makeCtx({ liveSession: live, env: usableEnv, promptContext: { prependContext: "before" } }));
    await run(execute, makeCtx({ liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1", prompt: "again" }));
    expect(opens).toHaveLength(1);
    expect(sessions[0]?.prompts).toEqual([withNote("before\n\nhi"), "again"]);
  });

  it("names OpenClaw and its tool, and no CLI", () => {
    expect(CONTINUITY_NOTE).toContain("sessions_history");
    expect(CONTINUITY_NOTE).toContain("OpenClaw");
    expect(CONTINUITY_NOTE).toContain("if that tool is available");
    expect(CONTINUITY_NOTE).not.toMatch(/cursor|acme/i);
  });

  it("adds the note on top of the host's history prompt", async () => {
    const { adapter, sessions } = makeAdapter();
    const history = "<conversation_history>\nuser: code word is kiwi\n</conversation_history>\n\nwhat was it?";
    await run(createExecute(adapter, { home: HOME, continuity: true }), makeCtx({ env: usableEnv, prompt: history }));
    expect(sessions[0]?.prompts).toEqual([withNote(history)]);
  });

  it("sends no note when the turn resumes a chat", async () => {
    const { adapter, sessions } = makeAdapter();
    await run(
      createExecute(adapter, { home: HOME, continuity: true }),
      makeCtx({ env: usableEnv, useResume: true, sessionId: "native-42" }),
    );
    expect(sessions[0]?.prompts).toEqual(["hi"]);
  });

  it("sends a note again when a restart opens a fresh chat", async () => {
    const { adapter, sessions } = makeAdapter();
    const execute = createExecute(adapter, { home: HOME, continuity: true });
    await run(execute, makeCtx({ env: usableEnv }));
    // /reset: no resume id.
    await run(execute, makeCtx({ env: usableEnv, useResume: false }));
    expect(sessions.map((session) => session.prompts[0])).toEqual([withNote("hi"), withNote("hi")]);
  });

  it("sends no note when MCP is off", async () => {
    const { adapter, sessions } = makeAdapter();
    await run(createExecute(adapter, { home: HOME, continuity: true, mcp: false }), makeCtx());
    expect(sessions[0]?.prompts).toEqual(["hi"]);
  });

  it("sends no note unless continuity is on", async () => {
    const { adapter, sessions } = makeAdapter();
    await run(createExecute(adapter, { home: HOME }), makeCtx({ env: usableEnv }));
    expect(sessions[0]?.prompts).toEqual(["hi"]);
  });

  it("sends the note even when the first turn has no usable settings", async () => {
    const { adapter, sessions } = makeAdapter();
    await run(createExecute(adapter, { home: HOME, continuity: true, warn: () => {} }), makeCtx());
    expect(sessions[0]?.prompts).toEqual([withNote("hi")]);
  });
});

describe("createExecute MCP proxy (AD-12)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "oac-execute-mcp-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  type Seen = { authorization?: string; capture?: string; body: string };
  /** A stand-in for the host's per-run loopback MCP endpoint. */
  async function startHost() {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          authorization: req.headers.authorization,
          capture: req.headers["x-openclaw-cli-capture-key"] as string | undefined,
          body: Buffer.concat(chunks).toString(),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    return { url, seen, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
  }

  let counter = 0;
  /** The settings file the host writes for one run. */
  function settingsFor(url: string, token: string, capture: string): Record<string, string> {
    const file = join(scratch, `settings-${counter++}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { openclaw: { type: "http", url, headers: { Authorization: `Bearer ${token}`, "x-openclaw-cli-capture-key": capture } } },
      }),
    );
    return { PATH: "/bin", [SETTINGS_PATH_ENV]: file };
  }

  /** A CLI that calls the MCP server it was given, once per turn, like a tool call. */
  function callingAdapter() {
    const made = makeAdapter(async function* (prompt, session) {
      const owner = made.opens.find((_, index) => made.sessions[index] === session)!;
      const server = owner.mcpServers![0]!;
      const res = await fetch(server.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...server.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: prompt } }),
      });
      yield { kind: "result", text: String(res.status), stopReason: "end_turn" };
    });
    return made;
  }

  it("gives the CLI only its own proxy, never the host's URL or token", async () => {
    const host = await startHost();
    try {
      const { adapter, opens } = callingAdapter();
      const env = settingsFor(host.url, "host-token", "cap-1");
      const records = await run(createExecute(adapter, { home: HOME }), makeCtx({ env }));
      expect(parsed(records).at(-1)).toMatchObject({ kind: "result", text: "200" });

      const servers = opens[0]!.mcpServers!;
      expect(servers).toHaveLength(1);
      expect(servers[0]!.name).toBe("openclaw");
      expect(servers[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(servers[0]!.url).not.toBe(host.url);
      expect(JSON.stringify(servers)).not.toContain("host-token");
      expect(JSON.stringify(servers)).not.toContain("cap-1");
      expect(host.seen).toHaveLength(1);
      expect(host.seen[0]).toMatchObject({ authorization: "Bearer host-token", capture: "cap-1" });
    } finally {
      await host.close();
    }
  });

  it("points one warm session at each turn's target and rejects calls between turns", async () => {
    const hostA = await startHost();
    const hostB = await startHost();
    try {
      const { adapter, sessions, opens } = callingAdapter();
      const { live } = makeLive();
      const execute = createExecute(adapter, { home: HOME });

      await run(execute, makeCtx({ liveSession: live, env: settingsFor(hostA.url, "token-1", "cap-1"), prompt: "one" }));
      // Between turns the same endpoint answers 503 and nothing reaches turn 1's host.
      const server = opens[0]!.mcpServers![0]!;
      const idle = await fetch(server.url, { method: "POST", headers: { ...server.headers, "Content-Type": "application/json" }, body: "{}" });
      expect(idle.status).toBe(503);

      const second = await run(
        execute,
        makeCtx({ liveSession: live, useResume: true, sessionId: "native-1", env: settingsFor(hostB.url, "token-2", "cap-2"), prompt: "two" }),
      );
      expect(parsed(second).at(-1)).toMatchObject({ text: "200" });
      expect(opens).toHaveLength(1);
      expect(sessions).toHaveLength(1);

      expect(hostA.seen).toHaveLength(1);
      expect(hostA.seen[0]).toMatchObject({ authorization: "Bearer token-1", capture: "cap-1" });
      expect(hostB.seen).toHaveLength(1);
      expect(hostB.seen[0]).toMatchObject({ authorization: "Bearer token-2", capture: "cap-2" });
    } finally {
      await hostA.close();
      await hostB.close();
    }
  });

  it("has the target in place while the CLI opens its session, before the first prompt", async () => {
    const host = await startHost();
    try {
      const made = makeAdapter();
      let duringOpen: number | undefined;
      const open = made.adapter.open;
      made.adapter.open = async (params) => {
        // A CLI connects to its MCP servers while it opens the session.
        const server = params.mcpServers![0]!;
        const res = await fetch(server.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...server.headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        });
        duringOpen = res.status;
        return open(params);
      };
      await run(createExecute(made.adapter, { home: HOME }), makeCtx({ env: settingsFor(host.url, "t", "c") }));
      expect(duringOpen).toBe(200);
      expect(host.seen).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  it("runs the turn without tools and warns when the settings file is missing", async () => {
    const warnings: string[] = [];
    const { adapter } = callingAdapter();
    const records = await run(
      createExecute(adapter, { home: HOME, warn: (message) => warnings.push(message) }),
      makeCtx({ env: { PATH: "/bin" } }),
    );
    // The turn itself succeeds; the CLI's call to the proxy was rejected with 503.
    expect(parsed(records).at(-1)).toMatchObject({ kind: "result", text: "503" });
    expect(records.at(-1)).not.toMatchObject({ is_error: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(SETTINGS_PATH_ENV);
  });

  it("warns without leaking header values when the file lacks mcpServers.openclaw", async () => {
    const warnings: string[] = [];
    const file = join(scratch, "no-openclaw.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer leak-me" } } } }));
    const { adapter } = callingAdapter();
    const records = await run(
      createExecute(adapter, { home: HOME, warn: (message) => warnings.push(message) }),
      makeCtx({ env: { [SETTINGS_PATH_ENV]: file } }),
    );
    expect(parsed(records).at(-1)).toMatchObject({ text: "503" });
    expect(warnings.join("\n")).toContain("mcpServers.openclaw");
    expect(warnings.join("\n")).not.toContain("leak-me");
  });

  it("drops a stale target when the next turn has no settings", async () => {
    const host = await startHost();
    try {
      const { adapter } = callingAdapter();
      const { live } = makeLive();
      const execute = createExecute(adapter, { home: HOME });
      await run(execute, makeCtx({ liveSession: live, env: settingsFor(host.url, "t", "c") }));
      const second = await run(execute, makeCtx({ liveSession: live, useResume: true, sessionId: "native-1" }));
      expect(parsed(second).at(-1)).toMatchObject({ text: "503" });
      expect(host.seen).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  const refused = (url: string) => fetch(url, { method: "POST", body: "{}" }).then(() => false, () => true);

  it("closes the proxy when the process closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { adapter, opens } = makeAdapter();
      const { live } = makeLive();
      await run(createExecute(adapter, { home: HOME, idleMs: 1000 }), makeCtx({ liveSession: live, env: usableEnv }));
      const url = opens[0]!.mcpServers![0]!.url;
      expect(await refused(url)).toBe(false);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await refused(url)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the proxy after a turn without a live session", async () => {
    const { adapter, opens } = makeAdapter();
    await run(createExecute(adapter, { home: HOME }), makeCtx());
    expect(await refused(opens[0]!.mcpServers![0]!.url)).toBe(true);
  });

  it("closes the proxy when the process exits on its own", async () => {
    const { adapter, opens, sessions } = makeAdapter();
    const { live } = makeLive();
    await run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live, env: usableEnv }));
    const url = opens[0]!.mcpServers![0]!.url;
    expect(await refused(url)).toBe(false);
    // The process dies without the host or the core closing it.
    sessions[0]!.alive = false;
    void sessions[0]!.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await refused(url)).toBe(true);
  });

  it("closes the proxy when the open fails", async () => {
    const { adapter, opens } = makeAdapter();
    adapter.open = async (params) => {
      opens.push(params);
      throw new CliError({ code: "cli_not_found", message: "no binary" });
    };
    await run(createExecute(adapter, { home: HOME }), makeCtx());
    expect(await refused(opens[0]!.mcpServers![0]!.url)).toBe(true);
  });

  it("closes the proxy after an abort", async () => {
    const hanging: Script = async function* (_prompt, session) {
      while (session.cancelled === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      yield { kind: "error", error: { code: "unknown", retryable: false, message: "cancelled" } };
    };
    const { adapter, opens } = makeAdapter(hanging);
    const controller = new AbortController();
    const turn = run(createExecute(adapter, { home: HOME }), makeCtx({ abortSignal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error("stop"));
    await expect(turn).rejects.toThrow();
    expect(await refused(opens[0]!.mcpServers![0]!.url)).toBe(true);
  });

  it("runs a proxy per live session with its own port and token", async () => {
    const { adapter, opens } = makeAdapter();
    const { live: liveA } = makeLive();
    const { live: liveB } = makeLive();
    const execute = createExecute(adapter, { home: HOME });
    await run(execute, makeCtx({ liveSession: liveA }));
    await run(execute, makeCtx({ liveSession: liveB }));
    const [a, b] = opens.map((open) => open.mcpServers![0]!);
    expect(a!.url).not.toBe(b!.url);
    expect(a!.headers.Authorization).not.toBe(b!.headers.Authorization);
  });

  it("closes the new process and runs no turn when the host closes the handle while the CLI starts", async () => {
    const { adapter, sessions } = makeAdapter();
    const { live, calls } = makeLive();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const open = adapter.open;
    adapter.open = async (params) => {
      await gate;
      return open(params);
    };
    const turn = run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live }));
    while (!live.current()) await new Promise((resolve) => setTimeout(resolve, 5));
    live.current()!.close("restart");
    release();
    const records = await turn;

    expect(parsed(records).at(-1)).toMatchObject({ kind: "result", errorText: expect.stringContaining("closed while") });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.closed).toBe(1);
    expect(sessions[0]!.prompts).toEqual([]);
    expect(calls.remove).toBeGreaterThanOrEqual(1);
  });

  it("does not reuse a process whose first turn had no OpenClaw endpoint", async () => {
    const host = await startHost();
    try {
      const warnings: string[] = [];
      const { adapter, opens, sessions } = makeAdapter();
      const { live } = makeLive();
      const execute = createExecute(adapter, { home: HOME, warn: (message) => warnings.push(message) });
      // Turn 1: no settings. The CLI connects to a proxy that answers 503 and drops the server.
      await run(execute, makeCtx({ liveSession: live }));
      expect(warnings).toHaveLength(1);
      // Turn 2: settings exist, but the first process never gets the server back.
      await run(
        execute,
        makeCtx({ liveSession: live, useResume: true, sessionId: "native-1", env: settingsFor(host.url, "t", "c") }),
      );
      expect(opens).toHaveLength(2);
      expect(sessions[0]!.closed).toBe(1);
      expect(opens[1]!.mcpServers).toHaveLength(1);
      // Turn 3 reuses the healthy process.
      await run(
        execute,
        makeCtx({ liveSession: live, useResume: true, sessionId: "native-2", env: settingsFor(host.url, "t", "c") }),
      );
      expect(opens).toHaveLength(2);
    } finally {
      await host.close();
    }
  });
});

describe("createExecute degraded and superseded runs", () => {
  it("closes a process whose first turn had no OpenClaw endpoint when that turn ends", async () => {
    const { adapter, sessions } = makeAdapter();
    const { live, calls } = makeLive();
    await run(createExecute(adapter, { home: HOME, idleMs: 60_000 }), makeCtx({ liveSession: live }));
    expect(sessions[0]!.closed).toBe(1);
    expect(calls.remove).toBe(1);
  });

  it("throws, not an error record, when a newer run closes the handle during the open", async () => {
    const { adapter, sessions } = makeAdapter();
    const { live } = makeLive();
    let current = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const open = adapter.open;
    adapter.open = async (params) => {
      await gate;
      return open(params);
    };
    const ctx = makeCtx({
      liveSession: live,
      assertCurrent: () => {
        if (!current) throw new Error("superseded");
      },
    });
    const turn = run(createExecute(adapter, { home: HOME }), ctx);
    const outcome = expect(turn).rejects.toThrow("superseded");
    while (!live.current()) await new Promise((resolve) => setTimeout(resolve, 5));
    current = false;
    live.current()!.close("restart");
    release();
    await outcome;
    expect(sessions[0]!.closed).toBe(1);
    expect(sessions[0]!.prompts).toEqual([]);
  });

  it("throws, not an error record, when the run is superseded while the proxy starts", async () => {
    const { adapter, opens } = makeAdapter();
    let current = true;
    proxies.beforeStart = () => {
      current = false;
      throw new Error("no port");
    };
    try {
      const ctx = makeCtx({
        assertCurrent: () => {
          if (!current) throw new Error("superseded");
        },
      });
      await expect(run(createExecute(adapter, { home: HOME }), ctx)).rejects.toThrow("superseded");
      expect(opens).toHaveLength(0);
    } finally {
      proxies.beforeStart = undefined;
    }
  });

  it("reports the closed-while-starting error even when closing the new session fails", async () => {
    const { adapter, sessions } = makeAdapter();
    const { live } = makeLive();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const open = adapter.open;
    adapter.open = async (params) => {
      await gate;
      const session = await open(params);
      session.close = async () => {
        throw new Error("close failed");
      };
      return session;
    };
    const turn = run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live }));
    while (!live.current()) await new Promise((resolve) => setTimeout(resolve, 5));
    live.current()!.close("restart");
    release();
    const records = await turn;
    expect(parsed(records).at(-1)).toMatchObject({ errorText: expect.stringContaining("closed while") });
    expect(sessions[0]!.prompts).toEqual([]);
  });

  it("marks a proxy start failure retryable", async () => {
    const { adapter } = makeAdapter();
    proxies.beforeStart = () => {
      throw new Error("no port");
    };
    try {
      const records = await run(createExecute(adapter, { home: HOME }), makeCtx());
      expect(records.at(-1)).toMatchObject({
        is_error: true,
        event: { kind: "error", error: { code: "server_error", retryable: true } },
      });
    } finally {
      proxies.beforeStart = undefined;
    }
  });
});

describe("createExecute with MCP off", () => {
  it("reuses the warm process on the next turn", async () => {
    const { adapter, opens } = makeAdapter();
    const { live } = makeLive();
    const execute = createExecute(adapter, { home: HOME, mcp: false });
    await run(execute, makeCtx({ liveSession: live }));
    await run(execute, makeCtx({ liveSession: live, useResume: true, sessionId: "native-1" }));
    expect(opens).toHaveLength(1);
  });

  it("starts no proxy, hands the CLI no MCP server, and warns about nothing", async () => {
    const warnings: string[] = [];
    const { adapter, opens } = makeAdapter();
    const before = proxies.started.length;
    const records = await run(
      createExecute(adapter, { home: HOME, mcp: false, warn: (message) => warnings.push(message) }),
      makeCtx({ env: { PATH: "/bin" } }),
    );
    expect(parsed(records).at(-1)).toMatchObject({ kind: "result" });
    expect(proxies.started).toHaveLength(before);
    expect(opens[0]!.mcpServers).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("starts a proxy and warns when MCP is on and the settings are missing", async () => {
    const warnings: string[] = [];
    const { adapter, opens } = makeAdapter();
    await run(createExecute(adapter, { home: HOME, mcp: true, warn: (message) => warnings.push(message) }), makeCtx());
    expect(opens[0]!.mcpServers).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(SETTINGS_PATH_ENV);
  });
});

describe("createExecute permission routing (AD-9, AD-11)", () => {
  const shell: PermissionRequest = {
    title: "`ls`",
    kind: "execute",
    toolCallId: "call-1",
    toolName: "exec",
    toolInput: { command: "ls" },
  };
  type HostAnswer = Awaited<ReturnType<ExecuteContext["requestToolPermission"]>>;

  /** A turn in which the CLI asks `request` and ends with the decision it got. */
  function askingTurn(request: PermissionRequest) {
    const decisions: PermissionDecision[] = [];
    const script: Script = async function* () {
      decisions.push(await harness.opens[0]!.onPermissionRequest(request));
      yield { kind: "result", text: "done", stopReason: "end_turn" };
    };
    const harness = makeAdapter(script);
    return { ...harness, decisions };
  }

  it("asks the host about the canonical tool and selects allow_once when it approves", async () => {
    const { adapter, decisions } = askingTurn(shell);
    const controller = new AbortController();
    const requestToolPermission = vi.fn(async (request: { toolInput: Record<string, unknown> }): Promise<HostAnswer> => ({
      behavior: "allow",
      updatedInput: request.toolInput,
    }));
    await run(
      createExecute(adapter, { home: HOME }),
      makeCtx({ requestToolPermission, abortSignal: controller.signal }),
    );
    expect(decisions).toEqual(["allow_once"]);
    expect(requestToolPermission).toHaveBeenCalledTimes(1);
    expect(requestToolPermission).toHaveBeenCalledWith({
      toolName: "exec",
      toolInput: { command: "ls" },
      toolCallId: "call-1",
      cwd: "/work",
      abortSignal: controller.signal,
    });
  });

  it("selects reject_once when the host denies", async () => {
    const { adapter, decisions } = askingTurn(shell);
    await run(
      createExecute(adapter, { home: HOME }),
      makeCtx({ requestToolPermission: async () => ({ behavior: "deny", message: "no shell" }) }),
    );
    expect(decisions).toEqual(["reject_once"]);
  });

  it("fails closed and logs when asking the host throws, and the turn continues", async () => {
    const { adapter, decisions } = askingTurn({ ...shell, toolInput: { command: "topsecret --flag" } });
    const warn = vi.fn();
    const records = await run(
      createExecute(adapter, { home: HOME, warn }),
      makeCtx({
        requestToolPermission: async () => {
          throw new Error("host unavailable");
        },
      }),
    );
    expect(decisions).toEqual(["reject_once"]);
    expect(parsed(records).at(-1)).toMatchObject({ kind: "result", text: "done" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exec"));
    expect(warn.mock.calls.flat().join(" ")).not.toContain("topsecret");
  });

  it("rejects an approval that changed the input, which the CLI cannot apply", async () => {
    const { adapter, decisions } = askingTurn(shell);
    const warn = vi.fn();
    await run(
      createExecute(adapter, { home: HOME, warn }),
      makeCtx({ requestToolPermission: async () => ({ behavior: "allow", updatedInput: { command: "rm -rf /" } }) }),
    );
    expect(decisions).toEqual(["reject_once"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("changed the input"));
  });

  it("rejects a malformed host answer", async () => {
    const { adapter, decisions } = askingTurn(shell);
    await run(
      createExecute(adapter, { home: HOME, warn: () => {} }),
      makeCtx({ requestToolPermission: async () => ({}) as never }),
    );
    expect(decisions).toEqual(["reject_once"]);
  });

  it("answers cancelled and ends the turn when it is aborted while the host waits for a human", async () => {
    const { adapter, sessions, decisions } = askingTurn(shell);
    const controller = new AbortController();
    let hostSignal: AbortSignal | undefined;
    const requestToolPermission = vi.fn((request: { abortSignal?: AbortSignal }) => {
      hostSignal = request.abortSignal;
      return new Promise<HostAnswer>(() => {});
    });
    const turn = run(
      createExecute(adapter, { home: HOME }),
      makeCtx({ requestToolPermission: requestToolPermission as never, abortSignal: controller.signal }),
    );
    const outcome = expect(turn).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requestToolPermission).toHaveBeenCalledTimes(1);
    controller.abort(new Error("stop"));
    await outcome;
    expect(decisions).toEqual(["cancelled"]);
    expect(hostSignal).toBe(controller.signal);
    expect(sessions[0]?.cancelled).toBe(1);
    expect(sessions[0]?.closed).toBe(1);
  });

  it("does not let a late host approval allow a call after the abort", async () => {
    const { adapter, decisions } = askingTurn(shell);
    const controller = new AbortController();
    let approve: (answer: HostAnswer) => void = () => {};
    const turn = run(
      createExecute(adapter, { home: HOME }),
      makeCtx({
        requestToolPermission: () => new Promise<HostAnswer>((resolve) => (approve = resolve)),
        abortSignal: controller.signal,
      }),
    );
    const outcome = expect(turn).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error("stop"));
    await outcome;
    approve({ behavior: "allow", updatedInput: shell.toolInput ?? {} });
    expect(decisions).toEqual(["cancelled"]);
  });

  it("answers cancelled, and never asks the host, for a request after the turn ended", async () => {
    const { adapter, opens } = makeAdapter();
    const requestToolPermission = vi.fn(async (): Promise<HostAnswer> => ({ behavior: "allow", updatedInput: {} }));
    const { live } = makeLive();
    await run(createExecute(adapter, { home: HOME }), makeCtx({ requestToolPermission, liveSession: live, env: usableEnv }));
    await expect(opens[0]!.onPermissionRequest({ ...shell, toolInput: {} })).resolves.toBe("cancelled");
    expect(requestToolPermission).not.toHaveBeenCalled();
  });

  it("rejects a request the adapter could not name during a turn, and answers cancelled for one after it", async () => {
    const unnamed: PermissionRequest = { title: "Unknown operation", kind: "other", toolCallId: "call-9" };
    const decisions: PermissionDecision[] = [];
    const script: Script = async function* () {
      decisions.push(await harness.opens[0]!.onPermissionRequest(unnamed));
      yield { kind: "result", text: "done", stopReason: "end_turn" };
    };
    const harness = makeAdapter(script);
    const requestToolPermission = vi.fn(async (): Promise<HostAnswer> => ({ behavior: "allow", updatedInput: {} }));
    await run(createExecute(harness.adapter, { home: HOME }), makeCtx({ requestToolPermission }));
    expect(decisions).toEqual(["reject_once"]);
    await expect(harness.opens[0]!.onPermissionRequest(unnamed)).resolves.toBe("cancelled");
    expect(requestToolPermission).not.toHaveBeenCalled();
  });

  it("answers cancelled, and never asks the host, when a newer run has taken over", async () => {
    let superseded = false;
    const decisions: PermissionDecision[] = [];
    const script: Script = async function* () {
      superseded = true;
      decisions.push(await harness.opens[0]!.onPermissionRequest(shell));
      yield { kind: "result", text: "done", stopReason: "end_turn" };
    };
    const harness = makeAdapter(script);
    const requestToolPermission = vi.fn(async (): Promise<HostAnswer> => ({ behavior: "allow", updatedInput: {} }));
    await run(
      createExecute(harness.adapter, { home: HOME }),
      makeCtx({
        requestToolPermission,
        assertCurrent: () => {
          if (superseded) throw new Error("superseded");
        },
      }),
    );
    expect(decisions).toEqual(["cancelled"]);
    expect(requestToolPermission).not.toHaveBeenCalled();
  });

  it("sends each turn's requests to that turn's host on a warm process", async () => {
    const decisions: PermissionDecision[] = [];
    const script: Script = async function* () {
      decisions.push(await harness.opens[0]!.onPermissionRequest(shell));
      yield { kind: "result", text: "done", stopReason: "end_turn" };
    };
    const harness = makeAdapter(script);
    const { live } = makeLive();
    const execute = createExecute(harness.adapter, { home: HOME });
    const first = vi.fn(async (): Promise<HostAnswer> => ({ behavior: "deny", message: "first" }));
    const second = vi.fn(async (request: { toolInput: Record<string, unknown> }): Promise<HostAnswer> => ({
      behavior: "allow",
      updatedInput: request.toolInput,
    }));
    await run(execute, makeCtx({ requestToolPermission: first, liveSession: live, env: usableEnv }));
    await run(
      execute,
      makeCtx({ requestToolPermission: second, liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1" }),
    );
    expect(harness.opens).toHaveLength(1);
    expect(decisions).toEqual(["reject_once", "allow_once"]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  describe("with a native tool selection", () => {
    const selection = { native: ["read", "grep", "glob"], openClaw: ["memory_search"] };
    const allowAll = () => vi.fn(async (request: { toolInput: Record<string, unknown> }): Promise<HostAnswer> => ({
      behavior: "allow",
      updatedInput: request.toolInput,
    }));

    it("denies a native tool the host left out, without asking it", async () => {
      const { adapter, decisions } = askingTurn(shell);
      const requestToolPermission = allowAll();
      await run(
        createExecute(adapter, { home: HOME }),
        makeCtx({ requestToolPermission, toolAvailability: selection }),
      );
      expect(decisions).toEqual(["reject_once"]);
      expect(requestToolPermission).not.toHaveBeenCalled();
    });

    it("denies an MCP tool outside the selection", async () => {
      const { adapter, decisions } = askingTurn({ ...shell, toolName: "mcp__other__tool", toolInput: {} });
      const requestToolPermission = allowAll();
      await run(createExecute(adapter, { home: HOME }), makeCtx({ requestToolPermission, toolAvailability: selection }));
      expect(decisions).toEqual(["reject_once"]);
      expect(requestToolPermission).not.toHaveBeenCalled();
    });

    it("still asks the host about a tool the selection includes", async () => {
      const { adapter, decisions } = askingTurn({ ...shell, toolName: "read", toolInput: { path: "/work/a" } });
      const requestToolPermission = allowAll();
      await run(createExecute(adapter, { home: HOME }), makeCtx({ requestToolPermission, toolAvailability: selection }));
      expect(decisions).toEqual(["allow_once"]);
      expect(requestToolPermission).toHaveBeenCalledTimes(1);
    });
  });
});

describe("createExecute native tool events (AD-3)", () => {
  const toolTurn: Script = async function* () {
    yield { kind: "toolStart", toolCallId: "t1", name: "read", args: { path: "a" } };
    yield { kind: "toolStart", toolCallId: "t1", name: "read" };
    yield { kind: "toolResult", toolCallId: "t1", name: "read", result: "ok" };
    yield { kind: "toolResult", toolCallId: "t1", name: "read", result: "again" };
    yield { kind: "toolResult", toolCallId: "orphan", name: "read", result: "never started" };
    yield { kind: "toolResult", toolCallId: "orphan", name: "read", result: "still not started" };
    yield { kind: "result", text: "done", stopReason: "end_turn" };
  };

  it("passes tool events to the host with the shapes it reads, one start and one result per call, and no result without a start", async () => {
    const { adapter } = makeAdapter(toolTurn);
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx());
    expect(parsed(records)).toEqual([
      { kind: "sessionId", sessionId: "native-1" },
      { kind: "toolStart", toolCallId: "t1", name: "read", args: { path: "a" } },
      { kind: "toolResult", toolCallId: "t1", name: "read", result: "ok" },
      { kind: "result", text: "done", sessionId: "native-1" },
    ]);
  });

  it("hands each event to the host before the adapter produces the next one", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gated: Script = async function* () {
      yield { kind: "text", text: "first" };
      yield { kind: "toolStart", toolCallId: "t1", name: "exec" };
      await gate;
      yield { kind: "result", text: "first", stopReason: "end_turn" };
    };
    const { adapter } = makeAdapter(gated);
    const seen: string[] = [];
    const turn = (async () => {
      for await (const record of createExecute(adapter, { home: HOME })(makeCtx())) {
        seen.push((record as { event: NormalizedEvent }).event.kind);
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual(["sessionId", "text", "toolStart"]);
    release();
    await turn;
    expect(seen.at(-1)).toBe("result");
  });

  it("closes a call the adapter left open before the result", async () => {
    const open: Script = async function* () {
      yield { kind: "toolStart", toolCallId: "t1", name: "exec" };
      yield { kind: "result", text: "done", stopReason: "end_turn" };
    };
    const { adapter } = makeAdapter(open);
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx());
    expect(parsed(records).map((event) => event.kind)).toEqual(["sessionId", "toolStart", "toolResult", "result"]);
    expect(parsed(records)[2]).toMatchObject({ toolCallId: "t1", name: "exec", isError: true, result: { aborted: true } });
  });

  it("closes a call left open by a turn that ends without a result, and by a thrown error", async () => {
    const silent: Script = async function* () {
      yield { kind: "toolStart", toolCallId: "t1", name: "exec" };
    };
    const first = await run(createExecute(makeAdapter(silent).adapter, { home: HOME }), makeCtx());
    expect(parsed(first).map((event) => event.kind)).toEqual(["sessionId", "toolStart", "toolResult", "result"]);

    const throwing: Script = async function* () {
      yield { kind: "toolStart", toolCallId: "t1", name: "exec" };
      throw new Error("boom");
    };
    const second = await run(createExecute(makeAdapter(throwing).adapter, { home: HOME }), makeCtx());
    expect(parsed(second).map((event) => event.kind)).toEqual(["sessionId", "toolStart", "toolResult", "result"]);
    expect(parsed(second).at(-1)).toEqual({ kind: "result", errorText: "boom" });
  });

  it("closes a call left open when the adapter ends the turn with an error", async () => {
    const failing: Script = async function* () {
      yield { kind: "toolStart", toolCallId: "t1", name: "exec" };
      yield { kind: "error", error: { code: "server_error", retryable: false, message: "gone" } };
    };
    const records = await run(createExecute(makeAdapter(failing).adapter, { home: HOME }), makeCtx());
    expect(parsed(records).map((event) => event.kind)).toEqual(["sessionId", "toolStart", "toolResult", "result"]);
  });
});

const home = (name: string) => ({ dir: `/agent/${name}/openclaw-all-cli/acme-cli`, env: { ACME_HOME: name } });

describe("createExecute reuse key and resume (AD-5, AD-13)", () => {
  it("reuses the warm process for a follow-up turn and sends only the new prompt", async () => {
    const { adapter, sessions, opens } = makeAdapter();
    const { live } = makeLive();
    const h = home("follow-up");
    await run(createExecute(adapter, { home: h, authProfileId: "p1" }), makeCtx({ liveSession: live, env: usableEnv, prompt: "first" }));
    // The host builds a new execute per run; the key, not the closure, decides reuse.
    const records = await run(
      createExecute(adapter, { home: h, authProfileId: "p1" }),
      makeCtx({ liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1", prompt: "second" }),
    );
    expect(opens).toHaveLength(1);
    expect(sessions[0]?.prompts).toEqual(["first", "second"]);
    expect(parsed(records).at(-1)).toMatchObject({ kind: "result", sessionId: "native-1" });
  });

  it("resumes the id the host passes in a new process after a Gateway restart", async () => {
    const { adapter, opens } = makeAdapter(okTurn, (params, count) => params.resumeSessionId ?? `native-${count}`);
    const records = await run(
      createExecute(adapter, { home: home("restart") }),
      makeCtx({ liveSession: makeLive().live, env: usableEnv, useResume: true, sessionId: "native-42" }),
    );
    expect(opens).toHaveLength(1);
    expect(opens[0]?.resumeSessionId).toBe("native-42");
    expect(parsed(records)[0]).toEqual({ kind: "sessionId", sessionId: "native-42" });
  });

  it("starts a new session when the host passes no resume id, and emits its id", async () => {
    const { adapter, opens } = makeAdapter();
    const records = await run(
      createExecute(adapter, { home: home("reset") }),
      // /reset: the host keeps a stale id around but says not to resume.
      makeCtx({ useResume: false, sessionId: "native-old" }),
    );
    expect(opens[0]?.resumeSessionId).toBeUndefined();
    expect(parsed(records)[0]).toEqual({ kind: "sessionId", sessionId: "native-1" });
  });

  it("opens a new process when the auth profile differs", async () => {
    const { adapter, sessions, opens } = makeAdapter();
    const { live } = makeLive();
    const h = home("auth");
    await run(createExecute(adapter, { home: h, authProfileId: "work" }), makeCtx({ liveSession: live, env: usableEnv }));
    await run(
      createExecute(adapter, { home: h, authProfileId: "personal" }),
      makeCtx({ liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1" }),
    );
    expect(opens).toHaveLength(2);
    expect(sessions[0]?.closed).toBe(1);
  });

  it("opens a new process when a profile appears or goes away", async () => {
    const { adapter, opens } = makeAdapter();
    const { live } = makeLive();
    const h = home("auth-none");
    await run(createExecute(adapter, { home: h }), makeCtx({ liveSession: live, env: usableEnv }));
    await run(
      createExecute(adapter, { home: h, authProfileId: "work" }),
      makeCtx({ liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1" }),
    );
    expect(opens).toHaveLength(2);
  });

  it("emits the id the CLI ended up with when it differs from the resumed one, and reuses by that id", async () => {
    const { adapter, sessions, opens } = makeAdapter(okTurn, (params) => (params.resumeSessionId ? `${params.resumeSessionId}-moved` : "native-1"));
    const { live } = makeLive();
    const execute = createExecute(adapter, { home: home("moved") });
    const records = await run(execute, makeCtx({ liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1" }));
    expect(parsed(records)[0]).toEqual({ kind: "sessionId", sessionId: "native-1-moved" });
    expect(parsed(records).at(-1)).toMatchObject({ kind: "result", sessionId: "native-1-moved" });

    // The host stored the new id; the old one no longer names this process.
    await run(execute, makeCtx({ liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1-moved" }));
    expect(opens).toHaveLength(1);
    expect(sessions[0]?.prompts).toHaveLength(2);
  });

  it("reports a chat the CLI does not know as session_expired, without starting a fresh chat", async () => {
    const { adapter, opens } = makeAdapter();
    adapter.open = async (params) => {
      opens.push(params);
      throw new CliError({ code: "session_expired", message: "CLI session not found: nope" });
    };
    const warnings: string[] = [];
    const records = await run(
      createExecute(adapter, { home: home("foreign"), warn: (message) => warnings.push(message) }),
      makeCtx({ useResume: true, sessionId: "someone-elses" }),
    );
    expect(records.at(-1)).toMatchObject({
      type: "result",
      is_error: true,
      event: { kind: "error", error: { code: "session_expired", message: expect.stringContaining("session not found") } },
    });
    // One open, with the id: no silent second open without it.
    expect(opens.map((open) => open.resumeSessionId)).toEqual(["someone-elses"]);
    expect(parsed(records)).toEqual([{ kind: "result", errorText: expect.stringContaining("session not found") }]);
  });

  describe("two processes, one chat", () => {
    it("closes an idle process that holds the chat before it loads the chat in another", async () => {
      const order: string[] = [];
      const { adapter, sessions } = makeAdapter(okTurn, (params, count) => params.resumeSessionId ?? `native-${count}`);
      const open = adapter.open;
      adapter.open = async (params) => {
        order.push(`open${params.resumeSessionId ? ":resume" : ""}`);
        return open(params);
      };
      const h = home("two-idle");
      const first = makeLive();
      const second = makeLive();
      await run(createExecute(adapter, { home: h }), makeCtx({ liveSession: first.live, env: usableEnv, useResume: true, sessionId: "chat-1" }));
      const original = sessions[0]!;
      const close = original.close.bind(original);
      original.close = async () => {
        order.push("close-holder");
        return close();
      };
      await run(createExecute(adapter, { home: h }), makeCtx({ liveSession: second.live, env: usableEnv, useResume: true, sessionId: "chat-1" }));
      expect(order).toEqual(["open:resume", "close-holder", "open:resume"]);
      expect(original.alive).toBe(false);
      expect(sessions[1]?.alive).toBe(true);
      second.current()?.close("abort");
    });

    it("refuses to load a chat another process is still running a turn in", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow: Script = async function* () {
        await gate;
        yield { kind: "result", text: "late", stopReason: "end_turn" };
      };
      const { adapter, opens } = makeAdapter(slow, (params, count) => params.resumeSessionId ?? `native-${count}`);
      const h = home("two-busy");
      const first = makeLive();
      const running = run(createExecute(adapter, { home: h }), makeCtx({ liveSession: first.live, env: usableEnv, useResume: true, sessionId: "chat-2" }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const records = await run(
        createExecute(adapter, { home: h }),
        makeCtx({ liveSession: makeLive().live, env: usableEnv, useResume: true, sessionId: "chat-2" }),
      );
      expect(records.at(-1)).toMatchObject({ is_error: true, event: { kind: "error", error: { retryable: true } } });
      expect(opens).toHaveLength(1);
      release();
      await running;
      first.current()?.close("abort");
    });

    it("keeps exactly one process when two turns resume one chat at once", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { adapter, sessions } = makeAdapter(okTurn, (params, count) => params.resumeSessionId ?? `native-${count}`);
      const open = adapter.open;
      // Both turns reach the open before either process exists.
      adapter.open = async (params) => {
        await gate;
        return open(params);
      };
      const h = home("two-race");
      const one = makeLive();
      const two = makeLive();
      const ctx = (liveSession: LiveSessionCapability) =>
        makeCtx({ liveSession, env: usableEnv, useResume: true, sessionId: "chat-race" });
      const first = run(createExecute(adapter, { home: h }), ctx(one.live));
      const second = run(createExecute(adapter, { home: h }), ctx(two.live));
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      const results = await Promise.all([first, second]);

      const failed = results.filter((records) => records.at(-1)?.is_error === true);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.at(-1)).toMatchObject({ event: { kind: "error", error: { retryable: true } } });
      expect(sessions).toHaveLength(1);
      expect(sessions.filter((session) => session.alive)).toHaveLength(1);
      one.current()?.close("abort");
      two.current()?.close("abort");
    });

    it("fails retryable, and opens nothing, when the closed holder does not exit in time", async () => {
      const { adapter, sessions, opens } = makeAdapter(okTurn, (params, count) => params.resumeSessionId ?? `native-${count}`);
      const h = home("two-stuck");
      const first = makeLive();
      await run(createExecute(adapter, { home: h }), makeCtx({ liveSession: first.live, env: usableEnv, useResume: true, sessionId: "chat-stuck" }));
      // A process that ignores its close and never exits.
      sessions[0]!.waitForExit = () => new Promise<void>(() => {});
      const records = await run(
        createExecute(adapter, { home: h, abortGraceMs: 30 }),
        makeCtx({ liveSession: makeLive().live, env: usableEnv, useResume: true, sessionId: "chat-stuck" }),
      );
      expect(records.at(-1)).toMatchObject({
        is_error: true,
        event: { kind: "error", error: { retryable: true, message: expect.stringContaining("did not exit") } },
      });
      expect(opens).toHaveLength(1);
    });

    it("stops waiting for the closed holder when the new turn is aborted", async () => {
      const { adapter, sessions, opens } = makeAdapter(okTurn, (params, count) => params.resumeSessionId ?? `native-${count}`);
      const h = home("two-abort");
      await run(createExecute(adapter, { home: h }), makeCtx({ liveSession: makeLive().live, env: usableEnv, useResume: true, sessionId: "chat-abort" }));
      sessions[0]!.waitForExit = () => new Promise<void>(() => {});
      const controller = new AbortController();
      const turn = run(
        createExecute(adapter, { home: h, abortGraceMs: 60_000 }),
        makeCtx({ liveSession: makeLive().live, env: usableEnv, useResume: true, sessionId: "chat-abort", abortSignal: controller.signal }),
      );
      const outcome = expect(turn).rejects.toThrow("stop");
      await new Promise((resolve) => setTimeout(resolve, 30));
      controller.abort(new Error("stop"));
      await outcome;
      expect(opens).toHaveLength(1);
    });

    it("lets two agents use the same native id", async () => {
      const { adapter, opens } = makeAdapter(okTurn, (params, count) => params.resumeSessionId ?? `native-${count}`);
      const a = makeLive();
      const b = makeLive();
      await run(createExecute(adapter, { home: home("agent-a") }), makeCtx({ liveSession: a.live, env: usableEnv, useResume: true, sessionId: "same" }));
      await run(createExecute(adapter, { home: home("agent-b") }), makeCtx({ liveSession: b.live, env: usableEnv, useResume: true, sessionId: "same" }));
      expect(opens).toHaveLength(2);
      expect(a.current()?.isIdle()).toBe(true);
      a.current()?.close("abort");
      b.current()?.close("abort");
    });
  });
});

describe("createExecute side questions (P18)", () => {
  const sideCtx = (overrides: Partial<ExecuteContext> = {}) =>
    makeCtx({ executionMode: "side-question", env: usableEnv, ...overrides });

  it("opens a throwaway session with no MCP server, no proxy, and no resume", async () => {
    const { adapter, opens, sessions } = makeAdapter();
    const before = proxies.started.length;
    const records = await run(createExecute(adapter, { home: HOME }), sideCtx({ useResume: true, sessionId: "native-1" }));
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ executionMode: "side-question" });
    expect(opens[0]?.mcpServers).toBeUndefined();
    expect(opens[0]?.resumeSessionId).toBeUndefined();
    expect(proxies.started).toHaveLength(before);
    expect(parsed(records)).toEqual([
      { kind: "text", text: "he" },
      { kind: "text", text: "llo" },
      { kind: "result", text: "echo:hi", usage: { input: 3, output: 5 } },
    ]);
    // Nothing for the host to bind to the chat.
    expect(records.some((record) => (record as { event?: { kind?: string } }).event?.kind === "sessionId")).toBe(false);
    expect(sessions[0]?.closed).toBe(1);
  });

  it("rejects every permission request and never asks the host", async () => {
    const decisions: PermissionDecision[] = [];
    const script: Script = async function* () {
      decisions.push(
        await harness.opens[0]!.onPermissionRequest({ title: "`ls`", toolName: "exec", toolInput: { command: "ls" } }),
        await harness.opens[0]!.onPermissionRequest({ title: "read", toolName: "read", toolInput: { path: "/x" } }),
      );
      yield { kind: "result", text: "done", stopReason: "end_turn" };
    };
    const harness = makeAdapter(script);
    const requestToolPermission = vi.fn(async () => ({ behavior: "allow" as const, updatedInput: {} }));
    await run(createExecute(harness.adapter, { home: HOME }), sideCtx({ requestToolPermission }));
    expect(decisions).toEqual(["reject_once", "reject_once"]);
    expect(requestToolPermission).not.toHaveBeenCalled();
  });

  it("answers cancelled to a request after the turn ended", async () => {
    const { adapter, opens } = makeAdapter();
    await run(createExecute(adapter, { home: HOME }), sideCtx());
    await expect(opens[0]!.onPermissionRequest({ title: "late" })).resolves.toBe("cancelled");
  });

  it("neither reuses nor disturbs the chat's warm process", async () => {
    const { adapter, sessions, opens } = makeAdapter();
    const { live, calls } = makeLive();
    const execute = createExecute(adapter, { home: home("beside") });
    await run(execute, makeCtx({ liveSession: live, env: usableEnv }));
    // The host gives a side question no live session; even if one were passed, it is not used.
    await run(execute, sideCtx({ liveSession: live, useResume: true, sessionId: "native-1" }));
    expect(opens).toHaveLength(2);
    expect(calls.restart).toBe(1);
    expect(calls.register).toBe(1);
    expect(sessions[0]?.closed).toBe(0);
    expect(sessions[1]?.closed).toBe(1);

    await run(execute, makeCtx({ liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1" }));
    expect(opens).toHaveLength(2);
    expect(sessions[0]?.prompts).toHaveLength(2);
  });
});

describe("createExecute concurrency caps and operations (P17, P19)", () => {
  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A script that holds the turn until its gate opens. */
  const gated = (g: { opened: Promise<void> }, log: string[] = []): Script =>
    async function* (prompt) {
      log.push(`start:${prompt}`);
      await g.opened;
      log.push(`end:${prompt}`);
      yield { kind: "result", text: prompt, stopReason: "end_turn" };
    };

  it("runs two agents at once under the default caps", async () => {
    const g = gate();
    const log: string[] = [];
    const a = makeAdapter(gated(g, log));
    const b = makeAdapter(gated(g, log));
    const pool = new ProcessPool({ maxTurns: 4, maxProcesses: 8 });
    const first = run(createExecute(a.adapter, { home: home("a"), pool }), makeCtx({ prompt: "a" }));
    const second = run(createExecute(b.adapter, { home: home("b"), pool }), makeCtx({ prompt: "b" }));
    await sleep(30);
    expect(log).toEqual(["start:a", "start:b"]);
    g.open();
    await Promise.all([first, second]);
  });

  it("holds a turn over the cap in FIFO order until a slot frees", async () => {
    const gates = [gate(), gate(), gate()];
    const log: string[] = [];
    let n = 0;
    const script: Script = async function* (prompt) {
      const mine = gates[n++]!;
      log.push(`start:${prompt}`);
      await mine.opened;
      yield { kind: "result", text: prompt, stopReason: "end_turn" };
    };
    const { adapter } = makeAdapter(script);
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
    const execute = createExecute(adapter, { home: HOME, pool });
    const turns = ["one", "two", "three"].map((prompt) => run(execute, makeCtx({ prompt })));
    await sleep(30);
    expect(log).toEqual(["start:one"]);
    expect(pool.queued).toBe(2);
    gates[0]!.open();
    await sleep(30);
    expect(log).toEqual(["start:one", "start:two"]);
    gates[1]!.open();
    await sleep(30);
    gates[2]!.open();
    await Promise.all(turns);
    expect(log).toEqual(["start:one", "start:two", "start:three"]);
    expect(pool.turns).toBe(0);
  });

  it("lets an aborted waiter leave the queue: it throws the abort, runs nothing, holds no slot", async () => {
    const g = gate();
    const { adapter, opens } = makeAdapter(gated(g));
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
    const execute = createExecute(adapter, { home: HOME, pool });
    const first = run(execute, makeCtx({ prompt: "first" }));
    await sleep(20);
    const controller = new AbortController();
    const waiting = run(execute, makeCtx({ prompt: "waiting", abortSignal: controller.signal }));
    const outcome = expect(waiting).rejects.toThrow("stop");
    await sleep(20);
    controller.abort(new Error("stop"));
    await outcome;
    expect(pool.queued).toBe(0);
    expect(opens).toHaveLength(1);
    g.open();
    await first;
    expect(pool.turns).toBe(0);
  });

  it("releases the slot on a failed open, an error result, and an abort", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
    const failing = makeAdapter();
    failing.adapter.open = async () => {
      throw new CliError({ code: "server_error", message: "no start", retryable: true });
    };
    await run(createExecute(failing.adapter, { home: HOME, pool }), makeCtx());
    expect(pool.turns).toBe(0);

    const erroring = makeAdapter(async function* () {
      yield { kind: "error", error: { code: "rate_limit", retryable: true, message: "slow" } };
    });
    await run(createExecute(erroring.adapter, { home: HOME, pool }), makeCtx());
    expect(pool.turns).toBe(0);

    const hanging: Script = async function* (_prompt, session) {
      while (session.cancelled === 0) await sleep(5);
      yield { kind: "error", error: { code: "unknown", retryable: false, message: "cancelled" } };
    };
    const aborting = makeAdapter(hanging);
    const controller = new AbortController();
    const turn = run(createExecute(aborting.adapter, { home: HOME, pool }), makeCtx({ abortSignal: controller.signal }));
    const outcome = expect(turn).rejects.toThrow();
    await sleep(30);
    controller.abort(new Error("stop"));
    await outcome;
    expect(pool.turns).toBe(0);

    // The pool still serves a turn.
    const ok = makeAdapter();
    expect(parsed(await run(createExecute(ok.adapter, { home: HOME, pool }), makeCtx())).at(-1)).toMatchObject({ kind: "result" });
  });

  it("releases the slot when the consumer stops reading", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
    const { adapter } = makeAdapter();
    const iterator = createExecute(adapter, { home: HOME, pool })(makeCtx())[Symbol.asyncIterator]();
    await iterator.next();
    expect(pool.turns).toBe(1);
    await iterator.return?.();
    expect(pool.turns).toBe(0);
  });

  it("closes the least recently used idle process when the process cap is full", async () => {
    const { adapter, sessions } = makeAdapter();
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
    const lives = [makeLive(), makeLive(), makeLive()];
    const execute = createExecute(adapter, { home: HOME, pool });
    for (const [index, l] of lives.entries()) {
      await run(execute, makeCtx({ liveSession: l.live, env: usableEnv, sessionId: `own-${index}` }));
      await sleep(5);
    }
    expect(sessions).toHaveLength(3);
    expect(sessions.map((session) => session.closed)).toEqual([1, 0, 0]);
    expect(pool.processes).toBe(2);
    expect(lives[0]!.calls.remove).toBe(1);
  });

  it("fails retryably as overloaded, and releases the slot, when no process is idle", async () => {
    const { adapter, opens } = makeAdapter();
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 1 });
    // A busy process that the turn cap does not know about: a broken invariant.
    await pool.add({ isIdle: () => false, lastUsed: 0, close: () => {}, exited: async () => {} });
    const records = await run(createExecute(adapter, { home: HOME, pool }), makeCtx());
    expect(parsed(records)).toEqual([{ kind: "result", errorText: expect.stringContaining("busy") }]);
    expect(opens).toHaveLength(0);
    expect(pool.turns).toBe(0);
  });

  it("counts a process from its creation to its close, and never leaks an entry on a failed start", async () => {
    const { adapter } = makeAdapter();
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 4 });
    const { live } = makeLive();
    const execute = createExecute(adapter, { home: HOME, pool });
    await run(execute, makeCtx({ liveSession: live, env: usableEnv }));
    expect(pool.processes).toBe(1);
    await run(execute, makeCtx({ env: usableEnv }));
    expect(pool.processes).toBe(1);
    adapter.open = async () => {
      throw new CliError({ code: "server_error", message: "no start" });
    };
    await run(execute, makeCtx({ liveSession: makeLive().live }));
    expect(pool.processes).toBe(1);
  });

  describe("version check", () => {
    it("runs once per command, before the first process, and remembers a pass", async () => {
      const { adapter, versionChecks, opens } = makeAdapter();
      const pool = new ProcessPool({ maxTurns: 2, maxProcesses: 4 });
      const execute = createExecute(adapter, { home: HOME, pool });
      await run(execute, makeCtx());
      // A new execute per turn, like prepareExecution: the memo lives on the pool.
      await run(createExecute(adapter, { home: HOME, pool }), makeCtx());
      expect(versionChecks).toHaveLength(1);
      expect(versionChecks[0]).toMatchObject({ command: "acme", env: { PATH: "/bin", ACME_HOME: HOME.env.ACME_HOME } });
      expect(opens).toHaveLength(2);
      await run(execute, makeCtx({ command: "/other/acme" }));
      expect(versionChecks).toHaveLength(2);
    });

    it("fails the turn with the adapter's error and starts no process", async () => {
      const { adapter, version, opens } = makeAdapter();
      version.result = async () => {
        throw new CliError({ code: "unsupported_version", message: "found 2026.05.01, need 2026.07.06" });
      };
      const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 4 });
      const before = proxies.started.length;
      const records = await run(createExecute(adapter, { home: HOME, pool }), makeCtx({ env: usableEnv }));
      expect(records.at(-1)).toMatchObject({ type: "result", is_error: true });
      expect(parsed(records)).toEqual([{ kind: "result", errorText: "found 2026.05.01, need 2026.07.06" }]);
      expect(opens).toHaveLength(0);
      expect(proxies.started).toHaveLength(before);
      expect(pool.processes).toBe(0);
      expect(pool.turns).toBe(0);
    });

    it("runs the turn with a warning when the version cannot be read, and checks again next time", async () => {
      const { adapter, version, versionChecks, opens } = makeAdapter();
      version.result = async () => ({ warning: "Could not read the version" });
      const warnings: string[] = [];
      const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 4 });
      const execute = createExecute(adapter, { home: HOME, pool, warn: (m) => warnings.push(m) });
      await run(execute, makeCtx());
      await run(execute, makeCtx());
      expect(opens).toHaveLength(2);
      expect(versionChecks).toHaveLength(2);
      expect(warnings.filter((m) => m === "Could not read the version")).toHaveLength(2);
    });

    it("reports a missing binary as cli_not_found", async () => {
      const { adapter, version } = makeAdapter();
      version.result = async () => {
        throw new CliError({ code: "cli_not_found", message: 'Could not find the CLI binary "acme".' });
      };
      const records = await run(createExecute(adapter, { home: HOME }), makeCtx());
      expect(parsed(records)).toEqual([{ kind: "result", errorText: 'Could not find the CLI binary "acme".' }]);
    });

    it("throws the abort when the signal aborts during the check", async () => {
      const { adapter, version, opens } = makeAdapter();
      const controller = new AbortController();
      version.result = async () => {
        controller.abort(new Error("stop"));
        return "ok";
      };
      await expect(run(createExecute(adapter, { home: HOME }), makeCtx({ abortSignal: controller.signal }))).rejects.toThrow("stop");
      expect(opens).toHaveLength(0);
    });
  });

  describe("unload", () => {
    it("closes busy and idle processes, waits for their exits, and refuses new turns afterwards", async () => {
      const idle = makeAdapter();
      const busy = makeAdapter(async function* (_prompt, session) {
        while (session.alive) await sleep(5);
        yield { kind: "error", error: { code: "unknown", retryable: false, message: "closed" } };
      });
      const pool = new ProcessPool({ maxTurns: 2, maxProcesses: 4 });
      const idleLive = makeLive();
      await run(createExecute(idle.adapter, { home: home("idle"), pool }), makeCtx({ liveSession: idleLive.live, env: usableEnv }));
      const running = run(createExecute(busy.adapter, { home: home("busy"), pool }), makeCtx());
      await sleep(30);
      expect(pool.processes).toBe(2);
      await pool.closeAll();
      expect(idle.sessions[0]?.closed).toBe(1);
      expect(busy.sessions[0]?.closed).toBe(1);
      expect(idle.sessions[0]?.alive).toBe(false);
      expect(idleLive.calls.remove).toBe(1);
      await running;

      const records = await run(createExecute(idle.adapter, { home: home("idle"), pool }), makeCtx());
      expect(parsed(records)).toEqual([{ kind: "result", errorText: expect.stringContaining("shutting down") }]);
      expect(idle.opens).toHaveLength(1);
    });

    it("closes a process that is still starting once the open returns", async () => {
      const { adapter, sessions } = makeAdapter();
      const g = gate();
      const open = adapter.open;
      adapter.open = async (params) => {
        await g.opened;
        return open(params);
      };
      const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
      const turn = run(createExecute(adapter, { home: HOME, pool }), makeCtx());
      await sleep(30);
      const closing = pool.closeAll();
      g.open();
      await closing;
      const records = await turn;
      expect(sessions[0]?.closed).toBe(1);
      expect(records.at(-1)).toMatchObject({ type: "result", is_error: true });
    });
  });

  describe("pid locks", () => {
    const children: ChildProcess[] = [];
    afterAll(() => {
      for (const child of children) child.kill("SIGKILL");
    });
    const homeDir = mkdtempSync(join(tmpdir(), "oac-execute-locks-"));
    afterAll(() => rmSync(homeDir, { recursive: true, force: true }));

    /** An adapter whose process is a real child, reported to the core the way the transport does. */
    function adapterWithProcess() {
      const harness = makeAdapter();
      let started: ChildProcess | undefined;
      harness.adapter.open = async (params) => {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
        children.push(child);
        started = child;
        await new Promise((resolve) => child.once("spawn", resolve));
        params.onProcessStart?.(child.pid!);
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        return {
          sessionId: "pid-session",
          get alive() {
            return child.exitCode === null && child.signalCode === null;
          },
          prompt: (text: string) => okTurn(text, undefined as never),
          cancel: async () => {},
          close: async () => {
            child.kill("SIGKILL");
            await exited;
          },
          waitForExit: () => exited,
        };
      };
      return { ...harness, child: () => started! };
    }
    const locks = (dir: string) => (existsSync(join(dir, "pids")) ? readdirSync(join(dir, "pids")).filter((n) => n.endsWith(".json")) : []);
    const until = async (condition: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 100 && !(await condition()); i += 1) await sleep(20);
    };

    it("records the process before the handshake ends and removes the lock when it exits", async () => {
      const dir = join(homeDir, "a");
      const { adapter, child } = adapterWithProcess();
      const { live } = makeLive();
      const execute = createExecute(adapter, { home: { dir, env: {} }, idleMs: 60_000 });
      await run(execute, makeCtx({ liveSession: live, env: usableEnv }));
      await until(async () => locks(dir).length === 1);
      expect(locks(dir)).toEqual([`${child().pid}.json`]);
      live.current()?.close("abort");
      await until(async () => locks(dir).length === 0);
      expect(locks(dir)).toEqual([]);
      expect((await inspectProcess(child().pid!)).kind).toBe("gone");
    });

    it("removes the lock of a process whose open failed", async () => {
      const dir = join(homeDir, "b");
      const { adapter, child } = adapterWithProcess();
      const open = adapter.open;
      adapter.open = async (params) => {
        const session = await open(params);
        // The lock exists before the open fails, so only the failure path can remove it.
        await until(async () => locks(dir).length === 1);
        expect(locks(dir)).toHaveLength(1);
        await session.close();
        // The exit hook is not wired yet (the open has not returned), so the lock must still be there.
        await sleep(100);
        expect(locks(dir)).toHaveLength(1);
        throw new CliError({ code: "server_error", message: "handshake failed" });
      };
      const records = await run(createExecute(adapter, { home: { dir, env: {} } }), makeCtx());
      expect(parsed(records)).toEqual([{ kind: "result", errorText: "handshake failed" }]);
      expect(locks(dir)).toEqual([]);
      expect(child().pid).toBeGreaterThan(0);
    });
  });
});

describe("createExecute pool hygiene (AD-14 review)", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
  };
  const warm = (live: LiveSessionCapability, extra: Partial<ExecuteContext> = {}) =>
    makeCtx({ liveSession: live, env: usableEnv, ...extra });

  it("gives the slot of a process that died while idle to the next turn", async () => {
    const { adapter, sessions, opens } = makeAdapter();
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 1 });
    const execute = createExecute(adapter, { home: HOME, pool });
    const a = makeLive();
    await run(execute, warm(a.live));
    expect(pool.processes).toBe(1);
    sessions[0]!.die();
    await sleep(20);
    // The exit hook closed the handle: nothing is left to evict.
    expect(pool.processes).toBe(0);
    const records = await run(execute, warm(makeLive().live));
    expect(parsed(records).at(-1)).toMatchObject({ kind: "result" });
    expect(opens).toHaveLength(2);
  });

  it("evicts a dead idle process even before its exit is seen", async () => {
    const { adapter, sessions, opens } = makeAdapter();
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 1 });
    const execute = createExecute(adapter, { home: HOME, pool });
    await run(execute, warm(makeLive().live));
    // Dead without an exit event: only `alive` says so.
    sessions[0]!.alive = false;
    const records = await run(execute, warm(makeLive().live));
    expect(parsed(records).at(-1)).toMatchObject({ kind: "result" });
    expect(opens).toHaveLength(2);
    expect(pool.processes).toBe(1);
  });

  it("evicts the least recently used process, not the oldest created", async () => {
    const { adapter, sessions } = makeAdapter();
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
    const execute = createExecute(adapter, { home: HOME, pool });
    const a = makeLive();
    const b = makeLive();
    await run(execute, warm(a.live));
    await sleep(10);
    await run(execute, warm(b.live));
    await sleep(10);
    // A serves another turn, so B is now the least recently used.
    await run(execute, warm(a.live, { useResume: true, sessionId: "native-1", prompt: "again" }));
    expect(sessions).toHaveLength(2);
    await sleep(10);
    await run(execute, warm(makeLive().live));
    expect(sessions[1]?.closed).toBe(1);
    expect(sessions[0]?.closed).toBe(0);
  });

  it("waits for the evicted process that holds a chat to exit before it loads that chat", async () => {
    const order: string[] = [];
    const { adapter, sessions } = makeAdapter();
    const open = adapter.open;
    adapter.open = async (params) => {
      order.push(`open:${params.resumeSessionId ?? "new"}`);
      return open(params);
    };
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 1 });
    const execute = createExecute(adapter, { home: HOME, pool });
    await run(execute, warm(makeLive().live));
    fake.exitDelayMs = 150;
    try {
      const started = Date.now();
      sessions[0]!.waitForExit().then(() => order.push("exit:native-1"));
      await run(execute, warm(makeLive().live, { useResume: true, sessionId: "native-1" }));
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    } finally {
      fake.exitDelayMs = 0;
    }
    expect(order).toEqual(["open:new", "exit:native-1", "open:native-1"]);
  });

  it("runs one version check for simultaneous first turns", async () => {
    const { adapter, versionChecks, version } = makeAdapter();
    const g = gate();
    version.result = async () => (await g.opened, "ok" as const);
    const pool = new ProcessPool({ maxTurns: 4, maxProcesses: 8 });
    const turns = [1, 2, 3, 4].map((n) => run(createExecute(adapter, { home: home(`v${n}`), pool }), makeCtx()));
    await sleep(30);
    g.open();
    await Promise.all(turns);
    expect(versionChecks).toHaveLength(1);
  });

  it("keeps the version floor for a turn whose neighbour aborted the shared check", async () => {
    const { adapter, version, versionChecks, opens } = makeAdapter();
    const g = gate();
    version.result = async () => {
      await g.opened;
      throw new CliError({ code: "unsupported_version", message: "too old" });
    };
    const pool = new ProcessPool({ maxTurns: 2, maxProcesses: 4 });
    const controller = new AbortController();
    const a = run(createExecute(adapter, { home: home("va"), pool }), makeCtx({ abortSignal: controller.signal }));
    const aOutcome = expect(a).rejects.toThrow("stop");
    await sleep(20);
    const b = run(createExecute(adapter, { home: home("vb"), pool }), makeCtx());
    await sleep(20);
    controller.abort(new Error("stop"));
    await aOutcome;
    g.open();
    expect(parsed(await b)).toEqual([{ kind: "result", errorText: "too old" }]);
    expect(versionChecks).toHaveLength(1);
    expect(versionChecks[0]?.signal).toBeUndefined();
    expect(opens).toHaveLength(0);
  });

  it("ends a turn promptly when it aborts while an evicted process is still exiting", async () => {
    const { adapter, sessions, opens } = makeAdapter();
    const pool = new ProcessPool({ maxTurns: 2, maxProcesses: 1 });
    const execute = createExecute(adapter, { home: HOME, pool });
    await run(execute, warm(makeLive().live));
    fake.exitDelayMs = 2_000;
    try {
      const controller = new AbortController();
      const before = proxies.started.length;
      const turn = run(execute, warm(makeLive().live, { abortSignal: controller.signal }));
      const outcome = expect(turn).rejects.toThrow("stop");
      await sleep(50);
      const started = Date.now();
      controller.abort(new Error("stop"));
      await outcome;
      expect(Date.now() - started).toBeLessThan(500);
      // No proxy and no process for the aborted turn, and its slot and count are free.
      expect(proxies.started).toHaveLength(before);
      expect(opens).toHaveLength(1);
      expect(pool.turns).toBe(0);
      expect(pool.processes).toBe(0);
      expect(sessions[0]?.closed).toBe(1);
    } finally {
      fake.exitDelayMs = 0;
    }
  });

  describe("a discarded entry frees its process slot", () => {
    it("when the run was superseded after the entry was created", async () => {
      const { adapter, opens } = makeAdapter();
      const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
      let checks = 0;
      const ctx = makeCtx({
        liveSession: makeLive().live,
        assertCurrent: () => {
          checks += 1;
          if (checks >= 3) throw new Error("superseded");
        },
      });
      await expect(run(createExecute(adapter, { home: HOME, pool }), ctx)).rejects.toThrow("superseded");
      expect(opens).toHaveLength(0);
      expect(pool.processes).toBe(0);
    });

    it("when the host refuses to register the handle", async () => {
      const { adapter, opens } = makeAdapter();
      const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
      const { live } = makeLive();
      live.register = () => {
        throw new Error("host refused");
      };
      await expect(run(createExecute(adapter, { home: HOME, pool }), makeCtx({ liveSession: live }))).rejects.toThrow("host refused");
      expect(opens).toHaveLength(0);
      expect(pool.processes).toBe(0);
    });

    it("when the MCP proxy cannot start", async () => {
      const { adapter, opens } = makeAdapter();
      const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
      proxies.beforeStart = () => {
        throw new Error("no port");
      };
      try {
        const records = await run(createExecute(adapter, { home: HOME, pool }), makeCtx());
        expect(parsed(records)).toEqual([{ kind: "result", errorText: expect.stringContaining("no port") }]);
      } finally {
        proxies.beforeStart = undefined;
      }
      expect(opens).toHaveLength(0);
      expect(pool.processes).toBe(0);
    });
  });

  describe("unload during a start", () => {
    it("while the proxy starts: nothing registers, nothing opens, the proxy is closed", async () => {
      const { adapter, opens } = makeAdapter();
      const { live, calls } = makeLive();
      const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
      const g = gate();
      proxies.beforeStart = () => g.opened;
      const before = proxies.started.length;
      try {
        const turn = run(createExecute(adapter, { home: HOME, pool }), makeCtx({ liveSession: live }));
        await sleep(30);
        const closing = pool.closeAll();
        g.open();
        const records = await turn;
        await closing;
        expect(records.at(-1)).toMatchObject({ type: "result", is_error: true });
        expect(JSON.stringify(records)).toMatch(/shutting down|closed/);
      } finally {
        proxies.beforeStart = undefined;
      }
      expect(opens).toHaveLength(0);
      expect(calls.register).toBe(0);
      expect(await proxyRefuses(proxies.started[before]!.url)).toBe(true);
      expect(pool.processes).toBe(0);
    });

    it("while the open is pending: the open is aborted and no session is left", async () => {
      const { adapter, sessions } = makeAdapter();
      let signal: AbortSignal | undefined;
      adapter.open = (params) =>
        new Promise((_resolve, reject) => {
          signal = params.signal;
          params.signal?.addEventListener("abort", () => reject(new CliError({ code: "server_error", message: "open aborted" })));
        });
      const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
      const turn = run(createExecute(adapter, { home: HOME, pool }), makeCtx());
      await sleep(40);
      expect(signal?.aborted).toBe(false);
      await pool.closeAll();
      const records = await turn;
      expect(signal?.aborted).toBe(true);
      expect(records.at(-1)).toMatchObject({ type: "result", is_error: true });
      expect(sessions).toHaveLength(0);
      expect(pool.processes).toBe(0);
    });
  });

  it("resolves closeAll only after the processes have exited", async () => {
    const { adapter, sessions } = makeAdapter();
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
    await run(createExecute(adapter, { home: HOME, pool }), makeCtx({ liveSession: makeLive().live, env: usableEnv }));
    fake.exitDelayMs = 200;
    try {
      const started = Date.now();
      await pool.closeAll();
      expect(Date.now() - started).toBeGreaterThanOrEqual(180);
      expect(sessions[0]?.alive).toBe(false);
    } finally {
      fake.exitDelayMs = 0;
    }
  });
});

describe("createExecute usage port", () => {
  const noUsageTurn: Script = async function* (prompt) {
    yield { kind: "text", text: "hi" };
    yield { kind: "result", text: `echo:${prompt}`, stopReason: "end_turn" };
  };
  const resultOf = (records: Record<string, unknown>[]) => parsed(records).at(-1);

  it("puts the port's usage on the result record, after the tool records", async () => {
    const { adapter } = makeAdapter(noUsageTurn);
    const queries: UsageQuery[] = [];
    adapter.readUsage = async (query) => {
      queries.push(query);
      return { usage: { input: 7, output: 2, cacheRead: 1, cacheWrite: 0, total: 10 } };
    };
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx({ env: { PATH: "/bin", K: "v" } }));
    expect(resultOf(records)).toMatchObject({ kind: "result", usage: { input: 7, output: 2, cacheRead: 1, cacheWrite: 0, total: 10 } });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ sessionId: "native-1", env: { PATH: "/bin", K: "v", ACME_HOME: HOME.dir } });
    expect(queries[0]!.startedAt).toBeLessThanOrEqual(queries[0]!.endedAt);
  });

  it("skips the port when the session reported usage", async () => {
    const { adapter } = makeAdapter();
    const readUsage = vi.fn(async () => ({ usage: { input: 99 } }));
    adapter.readUsage = readUsage;
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx());
    expect(resultOf(records)).toMatchObject({ usage: { input: 3, output: 5 } });
    expect(readUsage).not.toHaveBeenCalled();
  });

  it("skips the port on an error result and works without the port", async () => {
    const failing: Script = async function* () {
      yield { kind: "error", error: { code: "unknown", retryable: false, message: "bad" } };
    };
    const failed = makeAdapter(failing);
    const readUsage = vi.fn(async () => ({ usage: { input: 1 } }));
    failed.adapter.readUsage = readUsage;
    await run(createExecute(failed.adapter, { home: HOME }), makeCtx());
    expect(readUsage).not.toHaveBeenCalled();

    const plain = makeAdapter(noUsageTurn);
    const records = await run(createExecute(plain.adapter, { home: HOME }), makeCtx());
    expect(resultOf(records)).toMatchObject({ kind: "result" });
    expect((records.at(-1) as { usage?: unknown }).usage).toBeUndefined();
  });

  it("runs for a side question too", async () => {
    const { adapter } = makeAdapter(noUsageTurn);
    adapter.readUsage = async () => ({ usage: { input: 4, total: 4 } });
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx({ executionMode: "side-question" }));
    expect(resultOf(records)).toMatchObject({ usage: { input: 4, total: 4 } });
  });

  it("forwards the warning and survives a throw", async () => {
    const warnings: string[] = [];
    const warned = makeAdapter(noUsageTurn);
    warned.adapter.readUsage = async () => ({ warning: "usage is off" });
    const first = await run(createExecute(warned.adapter, { home: HOME, warn: (m) => warnings.push(m) }), makeCtx());
    expect(warnings).toContain("usage is off");
    expect((first.at(-1) as { usage?: unknown }).usage).toBeUndefined();

    const thrown = makeAdapter(noUsageTurn);
    thrown.adapter.readUsage = async () => {
      throw new Error("boom");
    };
    const second = await run(createExecute(thrown.adapter, { home: HOME }), makeCtx());
    expect(resultOf(second)).toMatchObject({ kind: "result", text: "echo:hi" });
  });

  it("ends the wait at once when the turn is aborted", async () => {
    const { adapter, sessions } = makeAdapter(noUsageTurn);
    adapter.readUsage = () => new Promise<never>(() => {});
    const controller = new AbortController();
    const turn = run(createExecute(adapter, { home: HOME }), makeCtx({ abortSignal: controller.signal }));
    const outcome = expect(turn).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error("stop"));
    await outcome;
    expect(sessions[0]?.closed).toBe(1);
  });

  it("reads usage after the open tool is closed and before the result", async () => {
    const toolTurn: Script = async function* () {
      yield { kind: "toolStart", toolCallId: "t1", name: "read" };
      yield { kind: "result", text: "done", stopReason: "end_turn" };
    };
    const { adapter } = makeAdapter(toolTurn);
    const order: string[] = [];
    adapter.readUsage = async () => {
      order.push("readUsage");
      return {};
    };
    for await (const record of createExecute(adapter, { home: HOME })(makeCtx())) {
      const kind = (record as { event?: { kind?: string } }).event?.kind;
      if (kind === "toolStart" || kind === "toolResult" || kind === "result") order.push(kind);
    }
    expect(order).toEqual(["toolStart", "toolResult", "readUsage", "result"]);
  });

  it("takes startedAt before the prompt runs, not after the result", async () => {
    const slow: Script = async function* () {
      await new Promise((resolve) => setTimeout(resolve, 80));
      yield { kind: "result", text: "done", stopReason: "end_turn" };
    };
    const { adapter } = makeAdapter(slow);
    const queries: UsageQuery[] = [];
    adapter.readUsage = async (query) => {
      queries.push(query);
      return {};
    };
    await run(createExecute(adapter, { home: HOME }), makeCtx());
    expect(queries[0]!.endedAt - queries[0]!.startedAt).toBeGreaterThanOrEqual(70);
  });
});

describe("createExecute capability check (AD-10)", () => {
  const needsHttp = createManifest("1", { P7: { status: "match", note: "", requires: ["httpMcp"] } });
  /** An adapter whose sessions report `reported` (undefined: nothing). */
  function checked(reported: CliCapability[] | undefined, manifest = needsHttp) {
    const harness = makeAdapter();
    Object.assign(harness.adapter, { manifest });
    const open = harness.adapter.open;
    harness.adapter.open = async (params) => {
      const session = (await open(params)) as FakeSession;
      if (reported) session.capabilities = new Set(reported);
      return session;
    };
    return harness;
  }
  const errorOf = (records: Record<string, unknown>[]) => (parsed(records).at(-1) as { errorText?: string }).errorText;

  it("fails the turn, closes the session, and never sends the prompt when a decided row's capability is missing", async () => {
    const { adapter, sessions } = checked([]);
    const { live, calls } = makeLive();
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live, env: usableEnv }));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: "result",
      is_error: true,
      event: { kind: "error", error: { code: "capability_mismatch", retryable: false } },
    });
    expect(errorOf(records)).toBe(
      "Capability mismatch: Acme does not report HTTP MCP servers (parity row P7), which the plugin's manifest needs. Update the CLI.",
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.prompts).toEqual([]);
    expect(sessions[0]!.closed).toBeGreaterThanOrEqual(1);
    expect(sessions[0]!.alive).toBe(false);
    expect(calls.remove).toBe(1);
    // The proxy ended with the handle.
    expect(await proxyRefuses(proxies.started.at(-1)!.url)).toBe(true);
  });

  it("releases the turn slot and the chat, so the next turn runs", async () => {
    const harness = checked([]);
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 1 });
    const execute = createExecute(harness.adapter, { home: HOME, pool });
    const first = await run(execute, makeCtx({ useResume: true, sessionId: "native-1" }));
    expect(errorOf(first)).toMatch(/^Capability mismatch/);
    // Now the CLI reports it: the same chat opens at once, with no slot or chat still held.
    Object.assign(harness.adapter, { manifest: createManifest("1", {}) });
    const second = await run(execute, makeCtx({ useResume: true, sessionId: "native-1" }));
    expect(parsed(second).at(-1)).toMatchObject({ kind: "result", text: "echo:hi" });
  });

  it("checks a side question too", async () => {
    const { adapter, sessions } = checked([]);
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx({ executionMode: "side-question" }));
    expect(errorOf(records)).toMatch(/^Capability mismatch/);
    expect(sessions[0]!.prompts).toEqual([]);
  });

  it("runs the turn when the CLI reports the capability, or more", async () => {
    for (const reported of [["httpMcp"], ["httpMcp", "resumeSession", "imagePrompts"]] as CliCapability[][]) {
      const { adapter } = checked(reported);
      const records = await run(createExecute(adapter, { home: HOME }), makeCtx());
      expect(parsed(records).at(-1)).toMatchObject({ kind: "result", text: "echo:hi" });
    }
  });

  it("does not check a session that reports nothing", async () => {
    const { adapter } = checked(undefined);
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx());
    expect(parsed(records).at(-1)).toMatchObject({ kind: "result", text: "echo:hi" });
  });

  it("does not check an undecided row", async () => {
    const { adapter } = checked([], createManifest("1", { P7: { status: "spike", note: "", requires: ["httpMcp"] } }));
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx());
    expect(parsed(records).at(-1)).toMatchObject({ kind: "result", text: "echo:hi" });
  });

  it("checks a process once: a warm process is reused without a new check", async () => {
    const { adapter, sessions } = checked(["httpMcp"]);
    const { live } = makeLive();
    const execute = createExecute(adapter, { home: HOME });
    await run(execute, makeCtx({ liveSession: live, env: usableEnv }));
    sessions[0]!.capabilities = new Set();
    const records = await run(execute, makeCtx({ liveSession: live, env: usableEnv, useResume: true, sessionId: "native-1" }));
    expect(parsed(records).at(-1)).toMatchObject({ kind: "result" });
    expect(sessions).toHaveLength(1);
  });
});

describe("createExecute approvals and usage gates (P9, P16)", () => {
  const shell: PermissionRequest = { title: "`ls`", kind: "execute", toolCallId: "c1", toolName: "exec", toolInput: { command: "ls" } };

  it("rejects a permission request without asking the host when approvals are off (P9)", async () => {
    const decisions: PermissionDecision[] = [];
    const script: Script = async function* () {
      decisions.push(await harness.opens[0]!.onPermissionRequest(shell));
      yield { kind: "result", text: "done", stopReason: "end_turn" };
    };
    const harness = makeAdapter(script);
    const requestToolPermission = vi.fn(async () => ({ behavior: "allow" as const, updatedInput: {} }));
    await run(createExecute(harness.adapter, { home: HOME, approvals: false }), makeCtx({ requestToolPermission }));
    expect(decisions).toEqual(["reject_once"]);
    expect(requestToolPermission).not.toHaveBeenCalled();
    await expect(harness.opens[0]!.onPermissionRequest(shell)).resolves.toBe("cancelled");
  });

  it("never calls the adapter's usage reader when usage is off (P16)", async () => {
    const noUsage: Script = async function* () {
      yield { kind: "result", text: "done", stopReason: "end_turn" };
    };
    const { adapter } = makeAdapter(noUsage);
    const readUsage = vi.fn(async () => ({ usage: { input: 1 } }));
    adapter.readUsage = readUsage;
    const records = await run(createExecute(adapter, { home: HOME, usage: false }), makeCtx());
    expect(readUsage).not.toHaveBeenCalled();
    expect(records.at(-1)).not.toHaveProperty("usage");
    await run(createExecute(adapter, { home: HOME }), makeCtx());
    expect(readUsage).toHaveBeenCalledTimes(1);
  });
});
