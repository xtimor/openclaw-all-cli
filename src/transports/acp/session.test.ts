import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CliError, type CliSession, type NormalizedEvent } from "../../core/ports.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "../../../test/fixtures/paths.ts";
import { AcpSession, type AcpPermissionRequest, type AcpSessionOptions } from "./session.ts";

const open: CliSession[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((session) => session.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function options(overrides: Partial<AcpSessionOptions> & { env?: Record<string, string> } = {}): AcpSessionOptions {
  return {
    command: FAKE_CURSOR_AGENT,
    args: ["acp"],
    cwd: process.cwd(),
    authMethodId: "cursor_login",
    requiredModeId: "ask",
    onPermissionRequest: async () => "reject_once",
    ...overrides,
    env: fakeEnv(overrides.env),
  };
}

async function start(overrides?: Parameters<typeof options>[0]): Promise<AcpSession> {
  const session = await AcpSession.open(options(overrides));
  open.push(session);
  return session;
}

async function collect(stream: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function logFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "oac-acp-"));
  dirs.push(dir);
  return join(dir, "requests.jsonl");
}

function requests(file: string): { method: string; params: Record<string, unknown> }[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("AcpSession", () => {
  it("negotiates, logs in, selects the required mode, and streams one turn", async () => {
    const file = logFile();
    const session = await start({ env: { FAKE_CURSOR_LOG: file } });
    expect(session.sessionId).toBe("fake-session-1");
    expect(session.alive).toBe(true);

    const events = await collect(session.prompt("say:Hello there, how are you"));
    expect(events.map((event) => event.kind)).toEqual(["thinking", "text", "text", "result"]);
    const result = events.at(-1);
    expect(result).toEqual({ kind: "result", text: "Hello there, how are you", stopReason: "end_turn" });

    const methods = requests(file).map((entry) => entry.method);
    expect(methods).toEqual(["initialize", "authenticate", "session/new", "session/set_mode", "session/prompt"]);
    expect(requests(file).find((entry) => entry.method === "session/set_mode")?.params).toMatchObject({ modeId: "ask" });
  });

  it("keeps one process for several turns", async () => {
    const session = await start();
    const first = await collect(session.prompt("say:one"));
    const second = await collect(session.prompt("say:two"));
    expect(first.at(-1)).toMatchObject({ kind: "result", text: "one" });
    expect(second.at(-1)).toMatchObject({ kind: "result", text: "two" });
  });

  it("maps ACP usage onto a usage event when the agent reports it", async () => {
    const session = await start({ env: { FAKE_CURSOR_USAGE: "1" } });
    const events = await collect(session.prompt("say:x"));
    expect(events.find((event) => event.kind === "usage")).toEqual({
      kind: "usage",
      usage: { input: 3, output: 4, total: 7 },
    });
  });

  it("drops the history an agent replays while loading a session", async () => {
    const file = logFile();
    const session = await start({ resumeSessionId: "fake-session-9", env: { FAKE_CURSOR_LOG: file } });
    expect(session.sessionId).toBe("fake-session-9");
    const events = await collect(session.prompt("say:fresh"));
    const text = events.filter((event) => event.kind === "text").map((event) => (event as { text: string }).text);
    expect(text.join("")).toBe("fresh");
    expect(requests(file).map((entry) => entry.method)).toContain("session/load");
    expect(requests(file).map((entry) => entry.method)).not.toContain("session/new");
  });

  it("selects a listed model and rejects an unknown one", async () => {
    const file = logFile();
    await start({ modelId: "fake-fast", env: { FAKE_CURSOR_LOG: file } });
    expect(requests(file).find((entry) => entry.method === "session/set_config_option")?.params).toMatchObject({
      configId: "model",
      value: "fake-fast",
    });
    await expect(AcpSession.open(options({ modelId: "nope" }))).rejects.toMatchObject({ code: "model_not_found" });
  });

  it("answers a permission request through the adapter's policy", async () => {
    const seen: AcpPermissionRequest[] = [];
    const rejecting = await start({
      onPermissionRequest: async (request) => {
        seen.push(request);
        return "reject_once";
      },
    });
    const rejected = await collect(rejecting.prompt("[[ask-permission]]"));
    expect(seen).toEqual([
      {
        toolCallId: "call-1",
        title: "Run shell command",
        kind: "execute",
        paths: [],
        content: [],
        optionIds: ["allow", "reject"],
      },
    ]);
    expect(JSON.stringify(rejected)).toContain('\\"optionId\\":\\"reject\\"');

    const allowing = await start({ onPermissionRequest: async () => "allow_once" });
    const allowed = await collect(allowing.prompt("[[ask-permission]]"));
    expect(JSON.stringify(allowed)).toContain('\\"optionId\\":\\"allow\\"');
  });

  it("joins a permission request with what the agent said about the call before", async () => {
    const seen: AcpPermissionRequest[] = [];
    const session = await start({
      onPermissionRequest: async (request) => {
        seen.push(request);
        return "reject_once";
      },
    });
    const spec = {
      announce: {
        toolCallId: "call-2",
        title: "Edit File",
        kind: "edit",
        rawInput: { path: "/w/a.txt" },
        locations: [{ path: "/w/a.txt" }],
      },
      toolCall: {
        toolCallId: "call-2",
        title: "Edit `/w/a.txt`",
        kind: "edit",
        content: [{ type: "diff", path: "/w/a.txt", oldText: "a", newText: "b" }],
      },
    };
    await collect(session.prompt(`[[ask-json]]${JSON.stringify(spec)}`));
    expect(seen).toEqual([
      {
        toolCallId: "call-2",
        title: "Edit `/w/a.txt`",
        kind: "edit",
        rawInput: { path: "/w/a.txt" },
        paths: ["/w/a.txt"],
        content: spec.toolCall.content,
        optionIds: ["allow-once", "allow-always", "reject-once"],
      },
    ]);
  });

  it("answers cancelled when the adapter's policy throws, and when no option has the decided kind", async () => {
    const throwing = await start({
      onPermissionRequest: async () => {
        throw new Error("boom");
      },
    });
    expect(JSON.stringify(await collect(throwing.prompt("[[ask-permission]]")))).toContain('\\"outcome\\":\\"cancelled\\"');

    const onlyAllow = await start({ onPermissionRequest: async () => "reject_once" });
    const spec = {
      toolCall: { toolCallId: "call-3", title: "x", kind: "other" },
      options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }],
    };
    expect(JSON.stringify(await collect(onlyAllow.prompt(`[[ask-json]]${JSON.stringify(spec)}`)))).toContain(
      '\\"outcome\\":\\"cancelled\\"',
    );
  });

  it("answers a pending permission request as cancelled when the turn is cancelled", async () => {
    const session = await start({ onPermissionRequest: () => new Promise(() => {}) });
    const turn = collect(session.prompt("[[ask-permission]]"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await session.cancel();
    const events = await turn;
    expect(JSON.stringify(events)).toContain('\\"outcome\\":\\"cancelled\\"');
  });

  it("cancels a running turn", async () => {
    const session = await start();
    const turn = collect(session.prompt("[[hang]]"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await session.cancel();
    const events = await turn;
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { message: "The CLI cancelled the turn." } });
  });

  it("reports a crash before any tool as a retryable error and marks the session dead", async () => {
    const session = await start();
    const events = await collect(session.prompt("[[crash]]"));
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "server_error", retryable: true } });
    await session.waitForExit();
    expect(session.alive).toBe(false);
    const after = await collect(session.prompt("say:again"));
    expect(after).toMatchObject([{ kind: "error", error: { message: "The CLI session is closed." } }]);
  });

  it("maps a refusal stop reason to an unclassified error", async () => {
    const session = await start();
    const events = await collect(session.prompt("[[refuse]]"));
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "unclassified", retryable: false } });
  });

  it("cancels the CLI and keeps the session usable when the consumer stops early", async () => {
    const file = logFile();
    const session = await start({ env: { FAKE_CURSOR_LOG: file } });
    for await (const event of session.prompt("[[hang]]")) {
      if (event.kind === "thinking") break;
    }
    expect(requests(file).map((entry) => entry.method)).toContain("session/cancel");
    expect(session.alive).toBe(true);
    const next = await collect(session.prompt("say:still here"));
    expect(next.at(-1)).toMatchObject({ kind: "result", text: "still here" });
  });

  it("closes a CLI that ignores the cancel after the kill grace", async () => {
    const session = await start({ env: { FAKE_CURSOR_IGNORE_CANCEL: "1" } });
    for await (const event of session.prompt("[[hang]]")) {
      if (event.kind === "thinking") break;
    }
    expect(session.alive).toBe(false);
  }, 10_000);

  it("kills a CLI that ignores SIGTERM when it is closed", async () => {
    const session = await start({ env: { FAKE_CURSOR_IGNORE_TERM: "1", FAKE_CURSOR_IGNORE_STDIN_EOF: "1" } });
    await session.close();
    expect(session.alive).toBe(false);
  }, 10_000);

  it("ends the process when the signal aborts a hanging handshake", async () => {
    const controller = new AbortController();
    const opening = AcpSession.open(options({ env: { FAKE_CURSOR_NO_INIT: "1" }, signal: controller.signal }));
    const outcome = expect(opening).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort(new Error("stop"));
    await outcome;
  }, 10_000);

  it("reports a missing working directory instead of a missing binary", async () => {
    await expect(AcpSession.open(options({ cwd: "/nonexistent/workdir" }))).rejects.toMatchObject({
      code: "unclassified",
      message: expect.stringContaining("working directory"),
    });
  });

  it("refuses a second turn while one runs", async () => {
    const session = await start();
    const first = collect(session.prompt("[[hang]]"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await collect(session.prompt("say:x"));
    expect(second).toMatchObject([{ kind: "error", error: { message: "A turn is already running in this session." } }]);
    await session.cancel();
    await first;
  });

  it("fails closed when the agent lacks the required mode", async () => {
    await expect(AcpSession.open(options({ env: { FAKE_CURSOR_NO_ASK_MODE: "1" } }))).rejects.toMatchObject({
      code: "capability_mismatch",
    });
  });

  it("rejects an unsupported protocol version", async () => {
    await expect(AcpSession.open(options({ env: { FAKE_CURSOR_PROTOCOL: "2" } }))).rejects.toMatchObject({
      code: "unsupported_version",
    });
  });

  it("reports a missing binary as cli_not_found", async () => {
    const error = await AcpSession.open(options({ command: "/nonexistent/cursor-agent" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "cli_not_found" });
  });

  it("stops the process on close, and close is safe twice", async () => {
    const session = await start();
    await session.close();
    await session.close();
    expect(session.alive).toBe(false);
  });

  describe("tool calls", () => {
    const call = (id: string, extra: Record<string, unknown> = {}) => ({
      sessionUpdate: "tool_call",
      toolCallId: id,
      title: "Read a.txt",
      kind: "read",
      status: "pending",
      rawInput: { path: "/w/a.txt" },
      ...extra,
    });
    const change = (id: string, extra: Record<string, unknown>) => ({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      ...extra,
    });
    const script = (...items: unknown[]) => `[[updates]]${JSON.stringify(items)}`;
    const toolEvents = (events: NormalizedEvent[]) =>
      events.filter((event) => event.kind === "toolStart" || event.kind === "toolResult");

    it("streams text and thinking deltas before the turn ends, and the result text is their concatenation", async () => {
      const session = await start();
      const seen: { event: NormalizedEvent; at: number }[] = [];
      for await (const event of session.prompt(
        script({ $: "say", text: "one " }, { $: "say", text: "two " }, { $: "wait", ms: 300 }, { $: "say", text: "three" }),
      )) {
        seen.push({ event, at: Date.now() });
      }
      const kinds = seen.map((entry) => entry.event.kind);
      expect(kinds).toEqual(["thinking", "text", "text", "text", "result"]);
      const first = seen.find((entry) => entry.event.kind === "text")!;
      const last = seen.at(-1)!;
      expect(last.at - first.at).toBeGreaterThanOrEqual(250);
      const text = seen.flatMap((entry) => (entry.event.kind === "text" ? [entry.event.text] : []));
      expect(text).toEqual(["one ", "two ", "three"]);
      expect(last.event).toMatchObject({ kind: "result", text: "one two three" });
    });

    it("renders a call once however many updates it gets", async () => {
      const session = await start();
      const events = await collect(
        session.prompt(
          script(
            call("c1"),
            change("c1", { status: "in_progress" }),
            change("c1", { status: "in_progress" }),
            change("c1", { status: "completed", rawOutput: { content: "hello" } }),
            change("c1", { status: "completed", rawOutput: { content: "again" } }),
            change("c1", { status: "in_progress" }),
          ),
        ),
      );
      expect(toolEvents(events)).toEqual([
        { kind: "toolStart", toolCallId: "c1", name: "Read a.txt", args: { path: "/w/a.txt" } },
        { kind: "toolResult", toolCallId: "c1", name: "Read a.txt", isError: false, result: { content: "hello" } },
      ]);
      expect(events.at(-1)).toMatchObject({ kind: "result" });
    });

    it("keeps several calls apart and orders each start before its result", async () => {
      const session = await start();
      const events = await collect(
        session.prompt(
          script(
            call("a", { title: "one" }),
            call("b", { title: "two" }),
            change("b", { status: "completed" }),
            change("a", { status: "completed" }),
          ),
        ),
      );
      expect(toolEvents(events).map((event) => `${event.kind}:${(event as { toolCallId: string }).toolCallId}`)).toEqual([
        "toolStart:a",
        "toolStart:b",
        "toolResult:b",
        "toolResult:a",
      ]);
    });

    it("marks a failed call as an error", async () => {
      const session = await start();
      const events = await collect(
        session.prompt(
          script(call("c1"), change("c1", { status: "failed", content: [{ type: "content", content: { type: "text", text: "no such file" } }] })),
        ),
      );
      expect(toolEvents(events).at(-1)).toEqual({
        kind: "toolResult",
        toolCallId: "c1",
        name: "Read a.txt",
        isError: true,
        result: "no such file",
      });
    });

    it("closes a call that is still open when the turn ends", async () => {
      const session = await start();
      const events = await collect(session.prompt(script(call("c1"), change("c1", { status: "in_progress" }))));
      const kinds = events.map((event) => event.kind);
      expect(toolEvents(events)).toEqual([
        { kind: "toolStart", toolCallId: "c1", name: "Read a.txt", args: { path: "/w/a.txt" } },
        { kind: "toolResult", toolCallId: "c1", name: "Read a.txt", isError: true, result: { aborted: true } },
      ]);
      expect(kinds.at(-1)).toBe("result");
      expect(kinds.indexOf("toolResult")).toBeLessThan(kinds.indexOf("result"));
    });

    it("closes a call that is still open when the turn is cancelled", async () => {
      const session = await start();
      const turn = collect(session.prompt(script(call("c1"), { $: "hang" })));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await session.cancel();
      const events = await turn;
      const kinds = events.map((event) => event.kind);
      expect(kinds.slice(-2)).toEqual(["toolResult", "error"]);
      expect(toolEvents(events).at(-1)).toMatchObject({ kind: "toolResult", isError: true, result: { aborted: true } });
      expect(events.at(-1)).toMatchObject({ kind: "error", error: { retryable: false } });
    });

    it("treats an update for an unknown call as its start", async () => {
      const session = await start();
      const events = await collect(
        session.prompt(
          script(
            change("late", { title: "grep", kind: "search", rawInput: { pattern: "x" }, status: "in_progress" }),
            change("late", { status: "completed", rawOutput: { totalMatches: 1 } }),
          ),
        ),
      );
      expect(toolEvents(events)).toEqual([
        { kind: "toolStart", toolCallId: "late", name: "grep", args: { pattern: "x" } },
        { kind: "toolResult", toolCallId: "late", name: "grep", isError: false, result: { totalMatches: 1 } },
      ]);
    });

    it("starts and finishes a call that is first seen already completed", async () => {
      const session = await start();
      const events = await collect(session.prompt(script(call("c1", { status: "completed" }))));
      expect(toolEvents(events).map((event) => event.kind)).toEqual(["toolStart", "toolResult"]);
    });

    it("ignores an update kind it does not know", async () => {
      const session = await start();
      const events = await collect(
        session.prompt(
          script(
            { sessionUpdate: "future_kind", payload: 1 },
            { sessionUpdate: "plan", entries: [] },
            { sessionUpdate: "current_mode_update", currentModeId: "ask" },
            { $: "say", text: "fine" },
          ),
        ),
      );
      expect(events.map((event) => event.kind)).toEqual(["thinking", "text", "result"]);
      expect(events.at(-1)).toMatchObject({ text: "fine" });
    });

    it("reports a crash after a tool started as not retryable", async () => {
      const session = await start();
      const events = await collect(session.prompt(script(call("c1"), { $: "crash" })));
      expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "server_error", retryable: false } });
      expect(events.map((event) => event.kind).slice(-2)).toEqual(["toolResult", "error"]);
      expect(toolEvents(events).map((event) => event.kind)).toEqual(["toolStart", "toolResult"]);
      expect(toolEvents(events).at(-1)).toMatchObject({ isError: true, result: { aborted: true } });
    });

    it("reports a crash in the middle of a reply, before any tool, as retryable", async () => {
      const session = await start();
      const events = await collect(session.prompt(script({ $: "say", text: "partial" }, { $: "crash" })));
      expect(events.at(-1)).toMatchObject({ kind: "error", error: { retryable: true } });
    });

    it("lets the adapter name a call and wait one update for its details", async () => {
      const seen: Array<{ title: string; final: boolean; hasInput: boolean }> = [];
      const session = await start({
        describeToolCall: (view, final) => {
          seen.push({ title: view.title, final, hasInput: view.rawInput !== undefined });
          if (!view.rawInput && !final) return undefined;
          return { name: `native:${view.title}`, ...(view.rawInput ? { args: view.rawInput } : {}) };
        },
      });
      const events = await collect(
        session.prompt(
          script(
            call("c1", { title: "grep", rawInput: {} }),
            change("c1", { title: 'grep "x"', rawInput: { pattern: "x" } }),
            change("c1", { status: "completed" }),
          ),
        ),
      );
      expect(seen).toEqual([
        { title: "grep", final: false, hasInput: false },
        { title: 'grep "x"', final: true, hasInput: true },
      ]);
      expect(toolEvents(events)).toEqual([
        { kind: "toolStart", toolCallId: "c1", name: 'native:grep "x"', args: { pattern: "x" } },
        { kind: "toolResult", toolCallId: "c1", name: 'native:grep "x"', isError: false },
      ]);
    });

    it("shows a call the adapter kept waiting on as the agent called it, once the wait is over", async () => {
      const session = await start({ describeToolCall: () => undefined });
      const events = await collect(
        session.prompt(script(call("c1", { rawInput: {} }), change("c1", { status: "completed" }))),
      );
      expect(toolEvents(events).map((event) => event.kind)).toEqual(["toolStart", "toolResult"]);
      expect(toolEvents(events)[0]).toMatchObject({ name: "Read a.txt" });
    });

    it("starts a call that never left the adapter's wait when the turn ends", async () => {
      const session = await start({ describeToolCall: (_view, final) => (final ? { name: "late" } : undefined) });
      const events = await collect(session.prompt(script(call("c1", { rawInput: {} }))));
      expect(toolEvents(events)).toEqual([
        { kind: "toolStart", toolCallId: "c1", name: "late" },
        { kind: "toolResult", toolCallId: "c1", name: "late", isError: true, result: { aborted: true } },
      ]);
    });

    it("counts a call as a started tool even when no event was shown for it yet", async () => {
      // The adapter waits on a call whose details never arrive; the process dies meanwhile.
      const session = await start({ describeToolCall: () => undefined });
      const crashed = await collect(session.prompt(script(call("c1", { rawInput: {} }), { $: "crash" })));
      expect(crashed.at(-1)).toMatchObject({ kind: "error", error: { retryable: false } });
    });

    it("keeps a tool call from one turn out of the next", async () => {
      const session = await start();
      await collect(session.prompt(script(call("c1"))));
      const second = await collect(session.prompt(script(call("c1"), change("c1", { status: "completed" }))));
      expect(toolEvents(second).map((event) => event.kind)).toEqual(["toolStart", "toolResult"]);
      const third = await collect(session.prompt("say:no tools"));
      expect(toolEvents(third)).toEqual([]);
    });

    it("caps a very large result", async () => {
      const session = await start();
      const events = await collect(
        session.prompt(script(call("c1"), change("c1", { status: "completed", rawOutput: { content: "x".repeat(20_000) } }))),
      );
      const result = toolEvents(events).at(-1) as { result: string };
      expect(typeof result.result).toBe("string");
      expect(result.result.length).toBeLessThan(8_100);
      expect(result.result.endsWith("[truncated]")).toBe(true);
    });
  });
});
