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

  it("reports a crash mid-turn as a non-retryable error and marks the session dead", async () => {
    const session = await start();
    const events = await collect(session.prompt("[[crash]]"));
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "server_error", retryable: false } });
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
});
