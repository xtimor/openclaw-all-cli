import { describe, expect, it, vi } from "vitest";
import { createExecute } from "./execute.ts";
import { parseJsonlEvent } from "./events.ts";
import { CliError, type CliAdapter, type CliSession, type NormalizedEvent, type OpenParams } from "./ports.ts";
import { createManifest } from "./ports.ts";
import type { ExecuteContext, LiveSessionCapability, LiveSessionHandle } from "./sdk-types.ts";

const HOME = { dir: "/agent/openclaw-all-cli/acme-cli", env: { ACME_HOME: "/agent/openclaw-all-cli/acme-cli" } };

type Script = (prompt: string, session: FakeSession) => AsyncGenerator<NormalizedEvent>;

class FakeSession implements CliSession {
  alive = true;
  cancelled = 0;
  closed = 0;
  prompts: string[] = [];
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
  }
  async waitForExit() {}
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

describe("createExecute", () => {
  it("streams a turn: session ID, deltas, then one result with usage", async () => {
    const { adapter, sessions, opens } = makeAdapter();
    const { live, calls } = makeLive();
    const records = await run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live }));

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

  it("rejects CLI permission requests until routing exists", async () => {
    const { adapter, opens } = makeAdapter();
    await run(createExecute(adapter, { home: HOME }), makeCtx());
    await expect(
      opens[0]?.onPermissionRequest({ title: "Run shell command", kind: "execute" }),
    ).resolves.toBe("reject_once");
  });

  it("reuses the warm process when model, cwd, and native session match", async () => {
    const { adapter, sessions, opens } = makeAdapter();
    const { live, calls } = makeLive();
    const execute = createExecute(adapter, { home: HOME });
    await run(execute, makeCtx({ liveSession: live }));
    await run(execute, makeCtx({ liveSession: live, useResume: true, sessionId: "native-1", prompt: "again" }));

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
    await run(execute, makeCtx({ liveSession: live }));
    await run(execute, makeCtx({ liveSession: live, useResume: true, sessionId: "native-1", ...change }));

    expect(opens).toHaveLength(2);
    expect(sessions[0]?.closed).toBe(1);
    expect(calls.restart).toBe(2);
  });

  it("opens a new process when the agent's home differs", async () => {
    const { adapter, opens } = makeAdapter();
    const { live } = makeLive();
    const other = { dir: "/other/openclaw-all-cli/acme-cli", env: { ACME_HOME: "/other/openclaw-all-cli/acme-cli" } };
    await run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live }));
    await run(
      createExecute(adapter, { home: other }),
      makeCtx({ liveSession: live, useResume: true, sessionId: "native-1" }),
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
      await run(createExecute(adapter, { home: HOME, idleMs: 1000 }), makeCtx({ liveSession: live }));
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
    await run(execute, makeCtx({ liveSession: live }));
    sessions[0]!.alive = false;
    await run(execute, makeCtx({ liveSession: live, useResume: true, sessionId: "native-1" }));
    expect(opens).toHaveLength(2);
    expect(opens[1]?.resumeSessionId).toBe("native-1");
  });

  it("opens a new process and restarts when the host's fingerprint changed", async () => {
    const { adapter, opens } = makeAdapter();
    const { live, calls } = makeLive();
    const execute = createExecute(adapter, { home: HOME });
    await run(execute, makeCtx({ liveSession: live }));
    const changed = { ...live, fingerprint: "other" } as LiveSessionCapability;
    await run(execute, makeCtx({ liveSession: changed, useResume: true, sessionId: "native-1" }));
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

  it("closes the new process and rethrows when the host refuses to register it", async () => {
    const { adapter, sessions } = makeAdapter();
    const { live } = makeLive();
    live.register = () => {
      throw new Error("host refused");
    };
    await expect(run(createExecute(adapter, { home: HOME }), makeCtx({ liveSession: live }))).rejects.toThrow("host refused");
    expect(sessions[0]?.closed).toBe(1);
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
