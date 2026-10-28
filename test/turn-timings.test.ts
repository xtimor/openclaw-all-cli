import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import { buildCliBackend } from "../src/core/backend.ts";
import { registerAdapters } from "../src/core/register.ts";
import { TurnTimings } from "../src/core/turn-timings.ts";
import type { LiveSessionCapability, LiveSessionHandle } from "../src/core/sdk-types.ts";
import { parseJsonlEvent } from "../src/core/events.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";
import { MCP_CONFIG_TEST_KEY, withHostMcp } from "./fixtures/host-mcp.ts";

/** Issue #44: one debug line per turn with the phases of the first-reply wait. */

describe("TurnTimings line", () => {
  it("lists only the phases that happened, in the order a turn reaches them", () => {
    const timings = new TurnTimings(performance.now() - 50);
    timings.recordOpen("initialize", 600);
    timings.recordOpen("spawn", 4);
    timings.recordOpen("new_session", 3200);
    timings.markPromptSent();
    timings.markEvent("thinking");
    timings.markEvent("text");
    timings.markEnd("ok");
    const line = timings.line("cursor", "grok-4.7");
    expect(line).toMatch(
      /^turn timings \(cursor\): model=grok-4\.7 process=new outcome=ok spawn=4ms initialize=600ms new_session=3200ms prompt_sent=\d+ms first_thought=\d+ms first_text=\d+ms end=\d+ms$/,
    );
    expect(line).not.toMatch(/\b\w+=0ms/);
    expect(line).not.toContain("load_session");
    expect(line).not.toContain("set_model");
  });

  it("marks a reused process and leaves a missing first thought out", () => {
    const timings = new TurnTimings();
    timings.markReused();
    timings.markPromptSent();
    timings.markEvent("text");
    timings.markEnd("ok");
    const line = timings.line("cursor", "auto");
    expect(line).toContain("process=reused");
    expect(line).not.toContain("first_thought");
    expect(line).not.toMatch(/spawn=|initialize=|new_session=|load_session=|set_model=/);
  });

  it("ignores marks before the prompt, counts only the first thought and text, and keeps the first end", () => {
    const timings = new TurnTimings();
    timings.markEvent("text");
    timings.markPromptSent();
    timings.markEvent("thinking");
    timings.markEvent("thinking");
    timings.markEnd("error", "rate_limit");
    timings.markEnd("ok");
    timings.markFailed("server_error");
    const line = timings.line("cursor", "auto");
    expect(line).toContain("outcome=ok");
    expect(line).not.toContain("first_text");
    expect(line.match(/first_thought=/g)).toHaveLength(1);
    expect(line.match(/end=/g)).toHaveLength(1);
  });

  it("reports a turn that never sent its prompt with its error code and no marks", () => {
    const timings = new TurnTimings();
    timings.recordOpen("initialize", 7);
    timings.markFailed("auth");
    expect(timings.line("cursor", "auto")).toBe("turn timings (cursor): model=auto process=new outcome=error code=auth initialize=7ms");
  });

  it("keeps a hostile model name to one safe token", () => {
    const line = new TurnTimings().line("cursor", "a b\n/home/me/secret=1 \u0000");
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toMatch(/model=a_b_\/home\/me\/secret=1__ /);
  });
});

describe("turn timing line on the fake cursor-agent", () => {
  const scratch = mkdtempSync(join(tmpdir(), "oac-timings-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  type Run = { prompt?: string; model?: string; env?: Record<string, string>; resume?: string; live?: LiveSessionCapability };

  function setup(agentName: string) {
    const lines: string[] = [];
    const backend = buildCliBackend(cursorAdapter, { settings: {}, debug: (message) => lines.push(message) });
    const agentDir = join(scratch, agentName);
    mkdirSync(agentDir, { recursive: true });
    async function turn({ prompt = "say:pong", model = "auto", env = {}, resume, live }: Run = {}) {
      const prepared = await backend.prepareExecution!({ agentDir } as never);
      const records: Record<string, unknown>[] = [];
      for await (const record of prepared!.execute!({
        command: FAKE_CURSOR_AGENT,
        ...withHostMcp(["acp"], fakeEnv(env)),
        cwd: process.cwd(),
        prompt,
        modelId: model,
        systemPrompt: "",
        useResume: Boolean(resume),
        ...(resume ? { sessionId: resume } : {}),
        ...(live ? { liveSession: live } : {}),
        timeoutMs: 20_000,
        requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
        requestUserInput: async () => ({ status: "cancelled", message: "no" }),
      } as never)) {
        records.push(record);
      }
      const events = records.map((record) => parseJsonlEvent(JSON.stringify(record)) as Record<string, unknown> | null);
      return { records, events, line: lines.at(-1) };
    }
    return { lines, turn };
  }

  const ms = (line: string | undefined, key: string): number | undefined => {
    const found = new RegExp(`\\b${key}=(\\d+)ms`).exec(line ?? "");
    return found ? Number(found[1]) : undefined;
  };

  it("logs one line for a new chat with every phase that ran, thought before text", async () => {
    const { lines, turn } = setup("new-chat");
    const { events, line } = await turn({ prompt: "[[sleep:80]] say:pong", model: "fake-fast" });
    expect(events.at(-1)).toMatchObject({ kind: "result", text: "pong" });
    expect(lines).toHaveLength(1);
    expect(line).toMatch(/^turn timings \(cursor\): model=fake-fast process=new outcome=ok /);
    for (const key of ["spawn", "initialize", "new_session", "set_mode", "set_model", "prompt_sent", "first_thought", "first_text", "end"]) {
      expect(ms(line, key), key).toBeGreaterThanOrEqual(1);
    }
    // The fake sleeps after its thought and before its text: the marks tell the silence from the thinking.
    expect(ms(line, "first_text")! - ms(line, "first_thought")!).toBeGreaterThanOrEqual(60);
    expect(ms(line, "end")!).toBeGreaterThanOrEqual(ms(line, "first_text")!);
    expect(line).not.toContain("load_session");
    // No prompt text, key, or path.
    expect(line).not.toContain("pong");
    expect(line).not.toContain(scratch);
  });

  it("leaves set_model out when the session already runs the model, and the first thought out when there is none", async () => {
    const { turn } = setup("no-switch");
    const { line } = await turn({ prompt: "[[no-think]] say:pong" });
    expect(line).toContain("outcome=ok");
    expect(line).not.toContain("set_model");
    expect(line).not.toContain("first_thought");
    expect(ms(line, "first_text")).toBeGreaterThanOrEqual(1);
  });

  it("times the login when no API key is set", async () => {
    const { turn } = setup("login");
    const { line } = await turn();
    expect(ms(line, "login")).toBeGreaterThanOrEqual(1);
  });

  it("logs load_session, not new_session, for a resumed chat", async () => {
    const { turn } = setup("resume");
    const store = join(scratch, "resume-store");
    mkdirSync(store);
    const first = await turn({ env: { FAKE_CURSOR_STORE: store } });
    const sessionId = (first.events.find((event) => event?.kind === "sessionId") as { sessionId: string }).sessionId;
    const { line } = await turn({ env: { FAKE_CURSOR_STORE: store }, resume: sessionId });
    expect(ms(line, "load_session")).toBeGreaterThanOrEqual(1);
    expect(line).not.toContain("new_session");
  });

  it("marks a reused process and drops every open phase", async () => {
    const { lines, turn } = setup("reuse");
    let current: LiveSessionHandle | undefined;
    const live: LiveSessionCapability = {
      fingerprint: "fp",
      current: () => current,
      restart: async () => {
        current?.close("restart");
        current = undefined;
      },
      register: (handle) => {
        current = handle;
      },
      activate: () => {},
      remove: (handle) => {
        if (current === handle) current = undefined;
      },
    };
    // A usable MCP config keeps the process healthy enough to reuse.
    const settings = join(scratch, "reuse-settings.json");
    writeFileSync(settings, JSON.stringify({ mcpServers: { openclaw: { url: "http://127.0.0.1:1/mcp", headers: {} } } }));
    const env = { FAKE_CURSOR_STORE: join(scratch, "reuse-store"), [MCP_CONFIG_TEST_KEY]: settings };
    mkdirSync(env.FAKE_CURSOR_STORE);
    const first = await turn({ env, live });
    expect(first.line).toContain("process=new");
    const sessionId = (first.events.find((event) => event?.kind === "sessionId") as { sessionId: string }).sessionId;
    const second = await turn({ env, live, resume: sessionId });
    expect(lines).toHaveLength(2);
    expect(second.line).toContain("process=reused");
    expect(second.line).not.toMatch(/spawn=|initialize=|login=|new_session=|load_session=|set_mode=|set_model=/);
    expect(ms(second.line, "first_text")).toBeGreaterThanOrEqual(1);
    current?.close("abort");
  });

  it("still logs a line for a turn that fails after the prompt went out", async () => {
    const { lines, turn } = setup("crash");
    const { events, line } = await turn({ prompt: "[[crash]]" });
    expect(events.at(-1)).toMatchObject({ kind: "result", errorText: expect.any(String) });
    expect(lines).toHaveLength(1);
    expect(line).toMatch(/outcome=error code=server_error /);
    expect(ms(line, "prompt_sent")).toBeGreaterThanOrEqual(1);
    expect(ms(line, "end")).toBeGreaterThanOrEqual(1);
    expect(line).not.toContain("first_text");
  });

  it("still logs a line, with the phases reached, for a chat that cannot be loaded", async () => {
    const { lines, turn } = setup("load-fails");
    const { line } = await turn({
      env: { FAKE_CURSOR_LOAD_ERROR: JSON.stringify({ code: -32602, message: "Invalid params", data: { message: 'Session "x" not found' } }) },
      resume: "lost-chat",
    });
    expect(lines).toHaveLength(1);
    expect(line).toMatch(/outcome=error code=session_expired /);
    expect(ms(line, "initialize")).toBeGreaterThanOrEqual(1);
    expect(ms(line, "load_session")).toBeGreaterThanOrEqual(1);
    expect(line).not.toMatch(/prompt_sent|first_|end=|set_model/);
  });

  it("sends model selection only after the session answered, because the exact model ID comes from its answer", async () => {
    const log = join(scratch, "order.jsonl");
    const { turn } = setup("order");
    await turn({ model: "fake-fast", env: { FAKE_CURSOR_LOG: log } });
    const methods = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((entry) => JSON.parse(entry) as { method?: string })
      .map((entry) => entry.method);
    const session = methods.indexOf("session/new");
    const select = methods.findIndex((method) => method === "session/set_config_option" || method === "session/set_model");
    expect(session).toBeGreaterThan(-1);
    expect(select).toBeGreaterThan(session);
    expect(methods.indexOf("session/set_mode")).toBeGreaterThan(session);
    expect(methods.indexOf("session/prompt")).toBeGreaterThan(select);
  });

  it("changes nothing the agent receives", async () => {
    const withLog = join(scratch, "wire-with.jsonl");
    const { turn } = setup("wire");
    await turn({ env: { FAKE_CURSOR_LOG: withLog } });
    const withoutLog = join(scratch, "wire-without.jsonl");
    const quiet = buildCliBackend(cursorAdapter, { settings: {} });
    const agentDir = join(scratch, "wire-quiet");
    mkdirSync(agentDir);
    const prepared = await quiet.prepareExecution!({ agentDir } as never);
    for await (const _ of prepared!.execute!({
      command: FAKE_CURSOR_AGENT,
      args: ["acp"],
      env: fakeEnv({ FAKE_CURSOR_LOG: withoutLog }),
      cwd: process.cwd(),
      prompt: "say:pong",
      modelId: "auto",
      systemPrompt: "",
      useResume: false,
      timeoutMs: 20_000,
      requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
      requestUserInput: async () => ({ status: "cancelled", message: "no" }),
    } as never)) {
      // Drain.
    }
    const wire = (file: string) =>
      readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((entry) => JSON.parse(entry) as { method?: string; params?: unknown })
        .map((entry) =>
          JSON.stringify({ method: entry.method, params: entry.method === "initialize" ? undefined : entry.params })
            // The proxy's port and token differ per run.
            .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT")
            .replace(/Bearer [0-9a-f]+/g, "Bearer TOKEN"),
        );
    expect(wire(withLog)).toEqual(wire(withoutLog));
  });
});

describe("registerAdapters debug channel", () => {
  type Backend = { prepareExecution: (ctx: unknown) => Promise<{ execute: (ctx: unknown) => AsyncIterable<unknown> }> };
  function fakeApi(logger: Record<string, unknown>) {
    const backends: Backend[] = [];
    const api = {
      logger,
      pluginConfig: {},
      registrationMode: "setup-only",
      config: {},
      registerCliBackend: (backend: never) => backends.push(backend),
      registerProvider: () => {},
      registerService: () => {},
    };
    return { api, backends };
  }

  async function oneTurn(backend: Backend, agentDir: string) {
    const prepared = await backend.prepareExecution({ agentDir });
    for await (const _ of prepared.execute({
      command: FAKE_CURSOR_AGENT,
      args: ["acp"],
      env: fakeEnv(),
      cwd: process.cwd(),
      prompt: "say:pong",
      modelId: "auto",
      systemPrompt: "",
      useResume: false,
      timeoutMs: 20_000,
      requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
      requestUserInput: async () => ({ status: "cancelled", message: "no" }),
    })) {
      // Drain.
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), "oac-timings-register-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("sends the line to the plugin logger's debug channel", async () => {
    const debug: string[] = [];
    const warn: string[] = [];
    const { api, backends } = fakeApi({ debug: (m: string) => debug.push(m), info: () => {}, warn: (m: string) => warn.push(m), error: () => {} });
    registerAdapters(api as never, [cursorAdapter]);
    await oneTurn(backends[0]!, join(scratch, "a"));
    expect(debug).toHaveLength(1);
    expect(debug[0]).toMatch(/^turn timings \(cursor\): /);
    expect(warn.filter((m) => m.includes("timings"))).toEqual([]);
  });

  it("drops the line quietly when the host logger has no debug channel", async () => {
    const warn: string[] = [];
    const { api, backends } = fakeApi({ info: () => {}, warn: (m: string) => warn.push(m), error: () => {} });
    registerAdapters(api as never, [cursorAdapter]);
    await oneTurn(backends[0]!, join(scratch, "b"));
    expect(warn.filter((m) => m.includes("timings"))).toEqual([]);
  });
});
