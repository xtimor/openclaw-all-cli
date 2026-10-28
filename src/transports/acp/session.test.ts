import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProcess } from "../../core/pid-locks.ts";
import { CliError, type CliSession, type NormalizedEvent, type NormalizedUsage, type ProcessStartInfo } from "../../core/ports.ts";
import { boundTurnUsage } from "../../core/usage.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "../../../test/fixtures/paths.ts";
import { KILL_GRACE_MS } from "./runtime.ts";
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

describe("AcpSession open phases (issue #44)", () => {
  it("reports the phases that ran, each at least 1 ms, in the order they ran", async () => {
    const seen: Array<[string, number]> = [];
    await start({ modelId: "fake-fast[speed=fast,fast=true]", onPhase: (phase, ms) => seen.push([phase, ms]) });
    expect(seen.map(([phase]) => phase)).toEqual(["spawn", "initialize", "login", "new_session", "set_mode", "set_model"]);
    for (const [phase, ms] of seen) expect(Number.isInteger(ms) && ms >= 1, phase).toBe(true);
  });

  it("reports load_session instead of new_session on a resume, and no login or model switch when none is needed", async () => {
    const store = mkdtempSync(join(tmpdir(), "oac-acp-store-"));
    dirs.push(store);
    const first = await start({ env: { FAKE_CURSOR_STORE: store } });
    const seen: string[] = [];
    await start({ env: { FAKE_CURSOR_STORE: store }, resumeSessionId: first.sessionId, onPhase: (phase) => seen.push(phase) });
    expect(seen).toContain("load_session");
    expect(seen).not.toContain("new_session");
    expect(seen).not.toContain("set_model");
  });

  it("reports the phase that failed, and nothing after it", async () => {
    const seen: string[] = [];
    await expect(
      start({
        env: { FAKE_CURSOR_NEW_ERROR: JSON.stringify({ code: -32603, message: "Internal error" }) },
        onPhase: (phase) => seen.push(phase),
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(seen).toEqual(["spawn", "initialize", "login", "new_session"]);
  });

  it("does not fail the open when the observer throws", async () => {
    const session = await start({
      onPhase: () => {
        throw new Error("observer");
      },
    });
    expect(session.alive).toBe(true);
  });
});

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

  it("sends images as image blocks after the text, and no text block when the text is empty (P13)", async () => {
    const file = logFile();
    const session = await start({ env: { FAKE_CURSOR_LOG: file } });
    const png = Buffer.from("\x89PNG-bytes");
    const jpeg = Buffer.from("jpeg-bytes!!");
    const images = [
      { mimeType: "image/png", data: png.toString("base64") },
      { mimeType: "image/jpeg", data: jpeg.toString("base64") },
    ];
    const first = await collect(session.prompt("[[images]]", images));
    expect(first.at(-1)).toMatchObject({ kind: "result", text: `images:2:image/png/${png.length},image/jpeg/${jpeg.length}` });
    const second = await collect(session.prompt("", [images[0]!, images[1]!]));
    expect(second.at(-1)).toMatchObject({ kind: "result", stopReason: "end_turn" });
    const prompts = requests(file).filter((entry) => entry.method === "session/prompt");
    // The fake's log shows each image block as its size and hash, never its data.
    expect((prompts[0]!.params.prompt as Array<{ type: string }>).map((block) => block.type)).toEqual(["text", "image", "image"]);
    expect((prompts[1]!.params.prompt as Array<{ type: string }>).map((block) => block.type)).toEqual(["image", "image"]);
    expect(readFileSync(file, "utf8")).not.toContain(images[0]!.data);
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

  describe("usage against the context ceiling (issue #40)", () => {
    const window = (id: string | undefined) => (id === "fake-slow[context=1m,effort=high]" ? 1_000_000 : 256_000);

    it("reports the ceiling for the model the session runs, after a switch and without one", async () => {
      const seen: Array<string | undefined> = [];
      const switched = await start({
        selectModel: () => "fake-slow[context=1m,effort=high]",
        contextCeilingOf: (id, offered) => {
          seen.push(id);
          expect(offered.length).toBeGreaterThan(0);
          return window(id);
        },
      });
      expect(switched.contextCeiling).toBe(1_000_000);
      const kept = await start({ selectModel: () => null, contextCeilingOf: (id) => (seen.push(id), window(id)) });
      expect(kept.contextCeiling).toBe(256_000);
      // No model choice at all: the agent's current model.
      await start({ contextCeilingOf: (id) => (seen.push(id), window(id)) });
      expect(seen).toEqual(["fake-slow[context=1m,effort=high]", "default[]", "default[]"]);
      const none = await start();
      expect(none.contextCeiling).toBeUndefined();
      const bad = await start({ contextCeilingOf: () => Number.NaN });
      expect(bad.contextCeiling).toBeUndefined();
    });

    it("keeps a plausible ACP total, and the core bound clamps an implausible one", async () => {
      const plausible = await start({ env: { FAKE_CURSOR_USAGE: "1" }, contextCeilingOf: () => 256_000 });
      const small = (await collect(plausible.prompt("say:x"))).find((event) => event.kind === "usage");
      expect(small).toEqual({ kind: "usage", usage: { input: 3, output: 4, total: 7 } });
      expect(boundTurnUsage((small as { usage: NormalizedUsage }).usage, plausible.contextCeiling)).toEqual({ input: 3, output: 4, total: 7 });

      const reported = { totalTokens: 5_600_000, inputTokens: 100_000, outputTokens: 86_800, cachedReadTokens: 5_413_200 };
      const summed = await start({ env: { FAKE_CURSOR_USAGE: JSON.stringify(reported) }, contextCeilingOf: () => 256_000 });
      const big = (await collect(summed.prompt("say:x"))).find((event) => event.kind === "usage") as { usage: NormalizedUsage };
      // The transport reports what the agent said; the core decides it is no context size.
      expect(big.usage).toEqual({ input: 100_000, output: 86_800, cacheRead: 5_413_200, total: 5_600_000 });
      expect(boundTurnUsage(big.usage, summed.contextCeiling)).toEqual({ input: 100_000, output: 86_800, cacheRead: 5_413_200, contextUnknown: true });
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

  describe("resume", () => {
    const store = () => {
      const dir = mkdtempSync(join(tmpdir(), "oac-acp-store-"));
      dirs.push(dir);
      return dir;
    };

    it("keeps the chat's context across a restart: a new process loads what the first one saw", async () => {
      const chats = store();
      const first = await start({ env: { FAKE_CURSOR_STORE: chats } });
      await collect(first.prompt("remember: banana"));
      await first.close();

      const second = await start({ resumeSessionId: first.sessionId, env: { FAKE_CURSOR_STORE: chats } });
      expect(second.sessionId).toBe(first.sessionId);
      const events = await collect(second.prompt("[[recall]]"));
      expect(events.at(-1)).toMatchObject({ kind: "result", text: "recall:remember: banana" });
    });

    it("starts an empty chat without a resume id", async () => {
      const chats = store();
      const first = await start({ env: { FAKE_CURSOR_STORE: chats } });
      await collect(first.prompt("remember: banana"));
      const fresh = await start({ env: { FAKE_CURSOR_STORE: chats } });
      expect(fresh.sessionId).not.toBe(first.sessionId);
      const events = await collect(fresh.prompt("[[recall]]"));
      expect(events.at(-1)).toMatchObject({ kind: "result", text: "recall:" });
    });

    it("fails a chat this home does not hold as session_expired, with a message the host classifies", async () => {
      const mine = store();
      const other = store();
      const first = await start({ env: { FAKE_CURSOR_STORE: other } });
      await expect(start({ resumeSessionId: first.sessionId, env: { FAKE_CURSOR_STORE: mine } })).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof CliError &&
          error.code === "session_expired" &&
          /session not found/i.test(error.message) &&
          error.message.includes(first.sessionId) &&
          !error.retryable,
      );
    });

    it("answers with the ID the agent moved the chat to", async () => {
      const chats = store();
      const first = await start({ env: { FAKE_CURSOR_STORE: chats } });
      const second = await start({
        resumeSessionId: first.sessionId,
        env: { FAKE_CURSOR_STORE: chats, FAKE_CURSOR_LOAD_RENAMES: "1" },
      });
      expect(second.sessionId).toBe(`${first.sessionId}-moved`);
      const events = await collect(second.prompt("say:still works"));
      expect(events.at(-1)).toMatchObject({ kind: "result", text: "still works" });
    });

    it("does not call a process that dies during session/load a lost chat", async () => {
      await expect(start({ resumeSessionId: "x", env: { FAKE_CURSOR_LOAD_CRASH: "1" } })).rejects.toSatisfy(
        (error: unknown) => error instanceof CliError && error.code === "server_error" && error.retryable,
      );
    });

    it.each([
      ["a bare invalid-params", { code: -32602, message: "Invalid params" }],
      ["a not-found about something else", { code: -32602, message: "Invalid params", data: { message: "API key not found" } }],
      ["a missing workspace", { code: -32603, message: "workspace does not exist" }],
    ])("keeps %s as server_error, not a lost chat", async (_name, error) => {
      await expect(
        start({ resumeSessionId: "x", env: { FAKE_CURSOR_LOAD_ERROR: JSON.stringify(error) } }),
      ).rejects.toMatchObject({ code: "server_error" });
    });

    it.each([
      ["in the message", { code: -32602, message: "Session x not found" }],
      ["in the detail, as Cursor sends it", { code: -32602, message: "Invalid params", data: { message: 'Session "x" not found' } }],
    ])("reads a session that is unknown %s as session_expired", async (_name, error) => {
      await expect(
        start({ resumeSessionId: "x", env: { FAKE_CURSOR_LOAD_ERROR: JSON.stringify(error) } }),
      ).rejects.toMatchObject({ code: "session_expired" });
    });
  });

  const FAST = "fake-fast[speed=fast,fast=true]";

  it("selects a listed model through the configOptions select and rejects an unknown one", async () => {
    const file = logFile();
    await start({ modelId: FAST, env: { FAKE_CURSOR_LOG: file } });
    const methods = requests(file).map((entry) => entry.method);
    expect(requests(file).find((entry) => entry.method === "session/set_config_option")?.params).toMatchObject({
      configId: "model",
      value: FAST,
    });
    expect(methods).not.toContain("session/set_model");
    await expect(AcpSession.open(options({ modelId: "nope" }))).rejects.toMatchObject({ code: "model_not_found" });
  });

  it("switches an agent that reports only the models state with session/set_model", async () => {
    const file = logFile();
    const session = await start({
      modelId: FAST,
      env: { FAKE_CURSOR_LOG: file, FAKE_CURSOR_MODEL_SURFACE: "state" },
    });
    expect(requests(file).find((entry) => entry.method === "session/set_model")?.params).toMatchObject({
      modelId: FAST,
    });
    expect(requests(file).map((entry) => entry.method)).not.toContain("session/set_config_option");
    const events = await collect(session.prompt("hello"));
    expect(events.at(-1)).toMatchObject({ kind: "result", text: expect.stringContaining(`model ${FAST}`) });
  });

  it("exposes the models the agent offered", async () => {
    const session = await start({ env: { FAKE_CURSOR_MODEL_SURFACE: "state" } });
    expect(session.models.map((model) => model.id)).toContain(FAST);
    expect(session.models[0]).toEqual({ id: "default[]", name: "Auto" });
    const viaOptions = await start({ env: { FAKE_CURSOR_MODEL_SURFACE: "options" } });
    expect(viaOptions.models.map((model) => model.id)).toEqual(session.models.map((model) => model.id));
  });

  it("lets the adapter pick the exact ID, keep the model, or report a missing one", async () => {
    const file = logFile();
    const seen: Array<{ count: number; current: string | undefined }> = [];
    await start({
      env: { FAKE_CURSOR_LOG: file },
      selectModel: (available, current) => {
        seen.push({ count: available.length, current });
        return available.find((model) => model.name === "fake-fast")?.id;
      },
    });
    expect(seen).toEqual([{ count: 5, current: "default[]" }]);
    expect(requests(file).find((entry) => entry.method === "session/set_config_option")?.params).toMatchObject({
      value: FAST,
    });

    const kept = logFile();
    await start({ env: { FAKE_CURSOR_LOG: kept }, selectModel: () => null });
    expect(requests(kept).map((entry) => entry.method)).not.toContain("session/set_config_option");

    const same = logFile();
    await start({ env: { FAKE_CURSOR_LOG: same }, selectModel: (_available, current) => current });
    expect(requests(same).map((entry) => entry.method)).not.toContain("session/set_config_option");

    await expect(AcpSession.open(options({ selectModel: () => undefined }))).rejects.toMatchObject({
      code: "model_not_found",
    });
  });

  it("fails with capability_mismatch when a model is wanted and the agent lists none", async () => {
    await expect(
      AcpSession.open(options({ modelId: FAST, env: { FAKE_CURSOR_NO_MODELS: "1" } })),
    ).rejects.toMatchObject({ code: "capability_mismatch" });
    await expect(
      AcpSession.open(options({ selectModel: () => undefined, env: { FAKE_CURSOR_NO_MODELS: "1" } })),
    ).rejects.toMatchObject({ code: "capability_mismatch" });
    // An adapter that only wants to keep the model works with an agent that lists none.
    const session = await start({ selectModel: () => null, env: { FAKE_CURSOR_NO_MODELS: "1" } });
    expect(session.models).toEqual([]);
  });

  it("reads the models of a resumed session too", async () => {
    const file = logFile();
    const session = await start({ resumeSessionId: "fake-session-9", modelId: FAST, env: { FAKE_CURSOR_LOG: file } });
    expect(session.models.length).toBe(5);
    expect(requests(file).map((entry) => entry.method)).toContain("session/load");
    expect(requests(file).find((entry) => entry.method === "session/set_config_option")?.params).toMatchObject({
      value: FAST,
    });
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

  it("reports the capabilities the agent lists in initialize, in the core's names", async () => {
    expect([...(await start()).capabilities].sort()).toEqual(["httpMcp", "imagePrompts", "resumeSession"]);
    const bare = await start({ env: { FAKE_CURSOR_CAPS: JSON.stringify({ loadSession: false, mcpCapabilities: { http: false, sse: true }, promptCapabilities: {} }) } });
    expect([...bare.capabilities]).toEqual([]);
    const none = await start({ env: { FAKE_CURSOR_CAPS: JSON.stringify({ mcpCapabilities: null }) } });
    expect(none.capabilities.has("httpMcp")).toBe(false);
  });

  it("logs in when the agent lists the method, or lists none, and skips the login for an empty list", async () => {
    const methods = async (authMethods: string | undefined) => {
      const file = logFile();
      await start({ env: { FAKE_CURSOR_LOG: file, ...(authMethods ? { FAKE_CURSOR_AUTH_METHODS: authMethods } : {}) } });
      return requests(file).map((request) => request.method);
    };
    expect(await methods(undefined)).toContain("authenticate");
    expect(await methods('[{"id":"cursor_login"}]')).toContain("authenticate");
    // No list at all: log in, as before.
    expect(await methods("null")).toContain("authenticate");
    expect(await methods("[]")).not.toContain("authenticate");
    expect(await methods("[]")).toContain("session/new");
  });

  it("fails with capability_mismatch, without logging in, when the login method is gone", async () => {
    const file = logFile();
    const failure = await AcpSession.open(options({ env: { FAKE_CURSOR_LOG: file, FAKE_CURSOR_AUTH_METHODS: '[{"id":"other"}]' } })).catch((error) => error);
    expect(failure).toMatchObject({ code: "capability_mismatch" });
    expect(failure.message).toContain('no "cursor_login" login method');
    expect(failure.message).toContain('"other"');
    expect(requests(file).map((request) => request.method)).not.toContain("authenticate");
  });

  it("fails right after initialize when a required capability is missing, before login or any session", async () => {
    const file = logFile();
    const failure = await AcpSession.open(
      options({
        displayName: "Acme",
        requiredCapabilities: [{ row: "P7", capability: "httpMcp" }],
        env: { FAKE_CURSOR_LOG: file, FAKE_CURSOR_CAPS: JSON.stringify({ mcpCapabilities: { http: false } }) },
      }),
    ).catch((error) => error);
    expect(failure).toMatchObject({ code: "capability_mismatch", retryable: false });
    expect(failure.message).toBe(
      "Capability mismatch: Acme does not report HTTP MCP servers (parity row P7), which the plugin's manifest needs. Update the CLI.",
    );
    expect(requests(file).map((request) => request.method)).toEqual(["initialize"]);
  });

  it("opens when the required capabilities are reported", async () => {
    const session = await start({ requiredCapabilities: [{ row: "P7", capability: "httpMcp" }, { row: "P5", capability: "resumeSession" }] });
    expect(session.sessionId).toBeTruthy();
  });

  it("gives a resume without loadSession the same message, naming P5, before session/load", async () => {
    const file = logFile();
    const failure = await AcpSession.open(
      options({ resumeSessionId: "fake-session-1", env: { FAKE_CURSOR_LOG: file, FAKE_CURSOR_CAPS: JSON.stringify({ loadSession: false }) } }),
    ).catch((error) => error);
    expect(failure).toMatchObject({ code: "capability_mismatch" });
    expect(failure.message).toMatch(/^Capability mismatch: The CLI does not report session resume \(parity row P5\).*Update the CLI\.$/);
    expect(requests(file).map((request) => request.method)).toEqual(["initialize"]);
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

    it("counts a call known only from a permission request as a started tool", async () => {
      const session = await start({ onPermissionRequest: async () => "allow_once" });
      const events = await collect(
        session.prompt(script({ $: "ask", toolCall: { toolCallId: "unannounced", title: "`ls`", kind: "execute" } }, { $: "crash" })),
      );
      expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "server_error", retryable: false } });
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

describe("AcpSession reply errors", () => {
  const FAIL = "FAIL: backend said no";
  const classify = (text: string) =>
    text.startsWith("FAIL:") ? { code: "rate_limit" as const, retryable: true, message: `limit hit, ${text}` } : undefined;
  const say = (text: string) => ({ $: "say", text });
  const script = (...items: unknown[]) => `[[updates]]${JSON.stringify(items)}`;
  const texts = (events: NormalizedEvent[]) => events.flatMap((event) => (event.kind === "text" ? [event.text] : []));
  const kinds = (events: NormalizedEvent[]) => events.map((event) => event.kind);

  it("turns a recognised final chunk into one error: no result, no text, retryable", async () => {
    const session = await start({ classifyReplyError: classify });
    const events = await collect(session.prompt(`[[error]]${FAIL}`));
    expect(kinds(events)).toEqual(["thinking", "error"]);
    expect(events.at(-1)).toEqual({ kind: "error", error: { code: "rate_limit", retryable: true, message: `limit hit, ${FAIL}` } });
  });

  it("keeps the session usable after an error turn", async () => {
    const session = await start({ classifyReplyError: classify });
    await collect(session.prompt(`[[error]]${FAIL}`));
    const next = await collect(session.prompt("say:fine"));
    expect(next.at(-1)).toMatchObject({ kind: "result", text: "fine" });
  });

  it("leaves a normal turn unchanged", async () => {
    const session = await start({ classifyReplyError: classify });
    const events = await collect(session.prompt("say:Hello there, how are you"));
    expect(kinds(events)).toEqual(["thinking", "text", "text", "result"]);
    expect(events.at(-1)).toEqual({ kind: "result", text: "Hello there, how are you", stopReason: "end_turn" });
  });

  it("treats the chunk as plain text without a hook", async () => {
    const session = await start();
    const events = await collect(session.prompt(`[[error]]${FAIL}`));
    expect(events.at(-1)).toEqual({ kind: "result", text: FAIL, stopReason: "end_turn" });
  });

  it("flushes the chunk as ordinary text, in order, when text follows", async () => {
    const session = await start({ classifyReplyError: classify });
    const events = await collect(session.prompt(script(say(FAIL), say(" and more"))));
    expect(texts(events)).toEqual([FAIL, " and more"]);
    expect(events.at(-1)).toEqual({ kind: "result", text: `${FAIL} and more`, stopReason: "end_turn" });
  });

  it("ignores an empty chunk after the failure chunk: the error still ends the turn", async () => {
    const session = await start({ classifyReplyError: classify });
    const events = await collect(session.prompt(script(say(FAIL), say(""))));
    expect(texts(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "rate_limit" } });
  });

  it("ignores a whitespace-only chunk after the failure chunk: the error still ends the turn", async () => {
    const session = await start({ classifyReplyError: classify });
    const events = await collect(session.prompt(script(say(FAIL), say("\n"))));
    expect(texts(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "rate_limit" } });
  });

  it("flushes the chunk when thinking follows", async () => {
    const session = await start({ classifyReplyError: classify });
    const thought = { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } };
    const events = await collect(session.prompt(script(say(FAIL), thought)));
    expect(kinds(events)).toEqual(["thinking", "text", "thinking", "result"]);
    expect(events.at(-1)).toMatchObject({ kind: "result", text: FAIL });
  });

  it("flushes the chunk before a tool call that follows", async () => {
    const session = await start({ classifyReplyError: classify });
    const events = await collect(
      session.prompt(
        script(say(FAIL), { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.txt", kind: "read", status: "completed", rawInput: { path: "/w/a.txt" } }),
      ),
    );
    expect(kinds(events).filter((kind) => kind !== "thinking")).toEqual(["text", "toolStart", "toolResult", "result"]);
    expect(events.at(-1)).toMatchObject({ kind: "result", text: FAIL });
  });

  it("flushes the chunk before a permission request that follows", async () => {
    const seen: string[] = [];
    const session = await start({
      classifyReplyError: classify,
      onPermissionRequest: async () => {
        seen.push("asked");
        return "reject_once";
      },
    });
    const events = await collect(
      session.prompt(script(say(FAIL), { $: "ask", toolCall: { toolCallId: "p1", title: "Run shell command", kind: "execute" } })),
    );
    expect(seen).toEqual(["asked"]);
    expect(events.at(-1)).toMatchObject({ kind: "result", text: FAIL });
  });

  it("keeps earlier text and reports only the last chunk as the error", async () => {
    const session = await start({ classifyReplyError: classify });
    const events = await collect(session.prompt(script(say("Working on it. "), say(FAIL))));
    expect(texts(events)).toEqual(["Working on it. "]);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "rate_limit" } });
  });

  it("flushes a recognised chunk that a second recognised chunk follows", async () => {
    const session = await start({ classifyReplyError: classify });
    const events = await collect(session.prompt(script(say("FAIL: first"), say("FAIL: second"))));
    expect(texts(events)).toEqual(["FAIL: first"]);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { message: "limit hit, FAIL: second" } });
  });

  it("makes the error not retryable once a tool started, and closes the tool first", async () => {
    const session = await start({ classifyReplyError: classify });
    const call = { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.txt", kind: "read", status: "in_progress", rawInput: { path: "/w/a.txt" } };
    const events = await collect(session.prompt(script(call, say(FAIL))));
    expect(kinds(events).filter((kind) => kind !== "thinking")).toEqual(["toolStart", "toolResult", "error"]);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "rate_limit", retryable: false } });
  });

  it("drops a held chunk on cancel and reports the cancel", async () => {
    const session = await start({ classifyReplyError: classify });
    const turn = collect(session.prompt(script(say(FAIL), { $: "hang" })));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await session.cancel();
    const events = await turn;
    expect(texts(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "unknown", message: "The CLI cancelled the turn." } });
  });

  it("flushes a held chunk as text on a refusal, which keeps its own error", async () => {
    const session = await start({ classifyReplyError: classify });
    const events = await collect(session.prompt(script(say(FAIL), { $: "end", stopReason: "refusal" })));
    expect(texts(events)).toEqual([FAIL]);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "unclassified" } });
  });

  it("reads a held chunk as an error only on end_turn", async () => {
    const session = await start({ classifyReplyError: classify });
    const events = await collect(session.prompt(script(say(FAIL), { $: "end", stopReason: "max_tokens" })));
    expect(events.at(-1)).toMatchObject({ kind: "result", text: FAIL, stopReason: "max_tokens" });
  });

  it("treats a throwing hook as ordinary text", async () => {
    const session = await start({
      classifyReplyError: () => {
        throw new Error("bad hook");
      },
    });
    const events = await collect(session.prompt("say:plain"));
    expect(events.at(-1)).toMatchObject({ kind: "result", text: "plain" });
  });

  it("keeps a held chunk from leaking into the next turn", async () => {
    const session = await start({ classifyReplyError: classify });
    const failed = await collect(session.prompt(`[[error]]${FAIL}`));
    expect(failed.at(-1)).toMatchObject({ kind: "error" });
    const next = await collect(session.prompt("say:two"));
    expect(texts(next)).toEqual(["two"]);
    expect(next.at(-1)).toMatchObject({ kind: "result", text: "two" });
  });
});

describe("AcpSession start failures", () => {
  it("adds the JSON-RPC data.message to a failed session/new", async () => {
    const env = { FAKE_CURSOR_NEW_ERROR: JSON.stringify({ code: -32603, message: "Internal error", data: { message: "Failed to initialize session services" } }) };
    const error = await AcpSession.open(options({ env })).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({
      code: "server_error",
      message: "The CLI could not start a session: Internal error: Failed to initialize session services",
    });
  });

  it("does not repeat a detail the message already holds", async () => {
    const env = { FAKE_CURSOR_NEW_ERROR: JSON.stringify({ code: -32603, message: "Failed: no network", data: { message: "no network" } }) };
    const error = await AcpSession.open(options({ env })).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ message: "The CLI could not start a session: Failed: no network" });
  });
});

describe("AcpSession process ID (AD-14)", () => {
  it("reports the pid once, before the handshake, and exposes it on the session", async () => {
    const seen: number[] = [];
    const session = await start({ onProcessStart: (pid) => seen.push(pid) });
    expect(seen).toHaveLength(1);
    expect(session.pid).toBe(seen[0]);
  });

  it("reports the pid even when the handshake fails", async () => {
    const seen: number[] = [];
    await expect(
      AcpSession.open(
        options({ onProcessStart: (pid) => seen.push(pid), resumeSessionId: "x", env: { FAKE_CURSOR_LOAD_CRASH: "1" } }),
      ),
    ).rejects.toBeInstanceOf(CliError);
    expect(seen).toHaveLength(1);
  });

  it("reports no pid for a binary that does not exist", async () => {
    const seen: number[] = [];
    await expect(
      AcpSession.open(options({ command: "/nonexistent/agent", onProcessStart: (pid) => seen.push(pid) })),
    ).rejects.toMatchObject({ code: "cli_not_found" });
    expect(seen).toEqual([]);
  });

  it("is not broken by an observer that throws", async () => {
    const session = await start({
      onProcessStart: () => {
        throw new Error("observer failed");
      },
    });
    expect(session.alive).toBe(true);
  });
});

describe("AcpSession process group (D22, AD-14)", () => {
  const posix = process.platform !== "win32";
  const killed: number[] = [];
  afterEach(() => {
    // A failed test must not leave a fake worker behind.
    for (const pid of killed.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  /** The pids of the workers the fake started, from its log. */
  function workers(file: string): number[] {
    const pids = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event?: string; pid?: number })
      .filter((entry) => entry.event === "worker")
      .map((entry) => entry.pid!);
    killed.push(...pids);
    return pids;
  }
  const running = async (pid: number) => (await inspectProcess(pid)).kind === "alive";
  const pgidOf = async (pid: number) => {
    const state = await inspectProcess(pid);
    return state.kind === "alive" ? state.pgid : undefined;
  };

  it.skipIf(!posix)("starts the process as the leader of its own group and says so", async () => {
    const seen: Array<{ pid: number; info: ProcessStartInfo }> = [];
    const session = await start({ onProcessStart: (pid, info) => seen.push({ pid, info }) });
    expect(seen).toEqual([{ pid: session.pid!, info: { processGroup: true } }]);
    expect(await pgidOf(session.pid!)).toBe(session.pid);
  });

  it.skipIf(!posix)("stops the worker with the process on close", async () => {
    const file = logFile();
    const session = await start({ env: { FAKE_CURSOR_LOG: file, FAKE_CURSOR_WORKER: "1" } });
    const [worker] = workers(file);
    expect(worker).toBeDefined();
    // The worker shares the agent's group: that is what the group stop reaches.
    expect(await pgidOf(worker!)).toBe(session.pid);
    await session.close();
    expect(await running(worker!)).toBe(false);
  });

  it.skipIf(!posix)("stops the worker when the process dies on its own, before waitForExit resolves", async () => {
    const file = logFile();
    const session = await start({ env: { FAKE_CURSOR_LOG: file, FAKE_CURSOR_WORKER: "1" } });
    const [worker] = workers(file);
    const events = await collect(session.prompt("[[crash]]"));
    expect(events.at(-1)).toMatchObject({ kind: "error" });
    await session.waitForExit();
    expect(await running(worker!)).toBe(false);
  });

  it.skipIf(!posix)("kills a worker that ignores SIGTERM after the leader crashed on its own, within the grace plus a second", async () => {
    const file = logFile();
    const session = await start({
      env: { FAKE_CURSOR_LOG: file, FAKE_CURSOR_WORKER: "1", FAKE_CURSOR_WORKER_IGNORE_TERM: "1" },
    });
    const [worker] = workers(file);
    const startedAt = Date.now();
    const events = await collect(session.prompt("[[crash]]"));
    expect(events.at(-1)).toMatchObject({ kind: "error" });
    await session.waitForExit();
    expect(Date.now() - startedAt).toBeLessThan(KILL_GRACE_MS + 1_000);
    expect(await running(worker!)).toBe(false);
  });

  it.skipIf(!posix)("kills a worker that ignores SIGTERM within the grace period plus a second", async () => {
    const file = logFile();
    const session = await start({
      env: { FAKE_CURSOR_LOG: file, FAKE_CURSOR_WORKER: "1", FAKE_CURSOR_WORKER_IGNORE_TERM: "1" },
    });
    const [worker] = workers(file);
    const startedAt = Date.now();
    await session.close();
    expect(Date.now() - startedAt).toBeLessThan(KILL_GRACE_MS + 1_000);
    expect(await running(worker!)).toBe(false);
  });

  it.skipIf(!posix)("kills the group of a leader that ignores SIGTERM, worker included", async () => {
    const file = logFile();
    const session = await start({
      env: { FAKE_CURSOR_LOG: file, FAKE_CURSOR_WORKER: "1", FAKE_CURSOR_IGNORE_TERM: "1", FAKE_CURSOR_WORKER_IGNORE_TERM: "1" },
    });
    const [worker] = workers(file);
    await session.close();
    expect(await running(worker!)).toBe(false);
    expect(await running(session.pid!)).toBe(false);
  });

  it.skipIf(!posix)("stops the worker of an open that failed after the session was created", async () => {
    const file = logFile();
    const seen: number[] = [];
    await expect(
      AcpSession.open(
        options({
          // The agent has no such mode: the open fails after `session/new`, when the worker already runs.
          requiredModeId: "no-such-mode",
          onProcessStart: (pid) => seen.push(pid),
          env: { FAKE_CURSOR_LOG: file, FAKE_CURSOR_WORKER: "1" },
        }),
      ),
    ).rejects.toBeInstanceOf(CliError);
    const [worker] = workers(file);
    expect(worker).toBeDefined();
    expect(await running(worker!)).toBe(false);
  });

  it.skipIf(!posix)("lets a second process of the same home finish its turn after the first one's group was stopped", async () => {
    // Cursor's worker is shared by the processes of one home; stopping the first group may take it away,
    // and the second process respawns it on its next request. The fake has no such sharing; this
    // pins that closing one session leaves the other's turn alone.
    const first = await start({ env: { FAKE_CURSOR_WORKER: "1" } });
    const second = await start({ env: { FAKE_CURSOR_WORKER: "1" } });
    await first.close();
    const events = await collect(second.prompt("say:still here"));
    expect(events.at(-1)).toMatchObject({ kind: "result", text: "still here" });
  });
});
