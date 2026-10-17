import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createExecute } from "./execute.ts";
import type { McpProxy } from "./mcp-proxy.ts";
import { parseJsonlEvent } from "./events.ts";
import { SETTINGS_PATH_ENV } from "./mcp-target.ts";
import {
  CliError,
  type CliAdapter,
  type CliSession,
  type NormalizedEvent,
  type OpenParams,
  type PermissionDecision,
  type PermissionRequest,
} from "./ports.ts";
import { createManifest } from "./ports.ts";
import type { ExecuteContext, LiveSessionCapability, LiveSessionHandle } from "./sdk-types.ts";

const proxies = vi.hoisted(() => ({
  started: [] as McpProxy[],
  /** Called before the next proxy starts; a throw there fails the start. */
  beforeStart: undefined as (() => void) | undefined,
}));
vi.mock("./mcp-proxy.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mcp-proxy.ts")>();
  return {
    ...actual,
    startMcpProxy: async () => {
      proxies.beforeStart?.();
      const proxy = await actual.startMcpProxy();
      proxies.started.push(proxy);
      return proxy;
    },
  };
});

const HOME = { dir: "/agent/openclaw-all-cli/acme-cli", env: { ACME_HOME: "/agent/openclaw-all-cli/acme-cli" } };

type Script = (prompt: string, session: FakeSession) => AsyncGenerator<NormalizedEvent>;

class FakeSession implements CliSession {
  alive = true;
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

function makeAdapter(script: Script = okTurn) {
  const sessions: FakeSession[] = [];
  const opens: OpenParams[] = [];
  const adapter: CliAdapter = {
    id: "acme",
    displayName: "Acme",
    command: "acme",
    launchArgs: ["serve"],
    defaultModel: "acme-cli/auto",
    manifest: createManifest("1", {}),
    alwaysOnNativeTools: ["read"],
    probeAuth: async () => "available",
    prepareHome: async (home) => ({ ACME_HOME: home }),
    open: async (params) => {
      opens.push(params);
      const session = new FakeSession(`native-${sessions.length + 1}`, script);
      sessions.push(session);
      return session;
    },
  };
  return { adapter, sessions, opens };
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
