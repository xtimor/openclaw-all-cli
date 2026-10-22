import { inspectProcess } from "../../core/pid-locks.ts";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLedgerStub } from "../../../test/fixtures/ledger-stub.ts";
import { createExecute } from "../../core/execute.ts";
import { parseJsonlEvent } from "../../core/events.ts";
import { USAGE_URL_ENV } from "./usage.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "../../../test/fixtures/paths.ts";
import {
  CliError,
  type CliSession,
  type NormalizedEvent,
  type PermissionDecision,
  type PermissionRequest,
} from "../../core/ports.ts";
import { PARITY_ROWS } from "../../core/ports.ts";
import { CURSOR_CLEAR_ENV, CURSOR_PERMISSIONS, cursorAdapter, parseStatusOutput } from "./index.ts";
import { CURSOR_MIN_VERSION, cursorManifest } from "./manifest.ts";

const open: CliSession[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((session) => session.close()));
});

describe("cursor adapter", () => {
  it("reads cursor-agent status output", () => {
    expect(parseStatusOutput("Logged in as me@example.com")).toBe("available");
    expect(parseStatusOutput("Logged in (unable to fetch user details)")).toBe("available");
    expect(parseStatusOutput("Authenticated as me@example.com")).toBe("available");
    expect(parseStatusOutput("Signed in as me@example.com")).toBe("available");
    expect(parseStatusOutput("Not logged in")).toBe("missing");
    expect(parseStatusOutput("You are not currently logged in")).toBe("missing");
    expect(parseStatusOutput("You have been logged out")).toBe("missing");
    expect(parseStatusOutput("Not authenticated. Run cursor-agent login")).toBe("missing");
    expect(parseStatusOutput("Signed out")).toBe("missing");
    expect(parseStatusOutput("something else")).toBe("unreadable");
  });

  it("probes the login through `status`", async () => {
    const probe = (extra: Record<string, string>) =>
      cursorAdapter.probeAuth({ command: FAKE_CURSOR_AGENT, env: fakeEnv(extra) });
    await expect(probe({})).resolves.toBe("available");
    await expect(probe({ FAKE_CURSOR_LOGGED_IN: "0" })).resolves.toBe("missing");
    await expect(
      cursorAdapter.probeAuth({ command: "/nonexistent/cursor-agent", env: fakeEnv() }),
    ).resolves.toBe("missing");
  });

  it("accepts CURSOR_API_KEY as a login without running the CLI", async () => {
    await expect(
      cursorAdapter.probeAuth({ command: "/nonexistent/cursor-agent", env: { CURSOR_API_KEY: "key" } }),
    ).resolves.toBe("available");
  });

  it("opens a read-only ACP session and answers a turn", async () => {
    const session = await cursorAdapter.open({
      command: FAKE_CURSOR_AGENT,
      args: cursorAdapter.launchArgs,
      cwd: process.cwd(),
      env: fakeEnv(),
      modelId: "auto",
      onPermissionRequest: async () => "reject_once",
    });
    open.push(session);
    const events: NormalizedEvent[] = [];
    for await (const event of session.prompt("say:hi")) events.push(event);
    expect(events.at(-1)).toMatchObject({ kind: "result", text: "hi" });
  });

  const openOn = async (modelId: string, env: Record<string, string> = {}, thinkingLevel?: string) => {
    const session = await cursorAdapter.open({
      command: FAKE_CURSOR_AGENT,
      args: cursorAdapter.launchArgs,
      cwd: process.cwd(),
      env: fakeEnv(env),
      modelId,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      onPermissionRequest: async () => "reject_once",
    });
    open.push(session);
    return session;
  };
  const replyOf = async (session: CliSession) => {
    const events: NormalizedEvent[] = [];
    for await (const event of session.prompt("hello")) events.push(event);
    return events.at(-1);
  };

  it("runs the turn on the exact Cursor ID behind a readable model name", async () => {
    const session = await openOn("fake-fast");
    expect(await replyOf(session)).toMatchObject({
      kind: "result",
      text: expect.stringContaining("model fake-fast[speed=fast,fast=true]"),
    });
  });

  it("accepts the exact ID, any case, and the suffixed name of a model that shares its base", async () => {
    expect(await replyOf(await openOn("fake-slow[context=1m,effort=high]"))).toMatchObject({
      text: expect.stringContaining("model fake-slow[context=1m,effort=high]"),
    });
    expect(await replyOf(await openOn("FAKE-SLOW"))).toMatchObject({
      text: expect.stringContaining("model fake-slow[context=1m,effort=high]"),
    });
    expect(await replyOf(await openOn("twin"))).toMatchObject({
      text: expect.stringContaining("model twin[effort=low]"),
    });
    expect(await replyOf(await openOn("twin-high"))).toMatchObject({
      text: expect.stringContaining("model twin[effort=high]"),
    });
  });

  it("runs a reasoning model on the listed variant that matches the thinking level, else on the row's own", async () => {
    expect(await replyOf(await openOn("twin", {}, "high"))).toMatchObject({ text: expect.stringContaining("model twin[effort=high]") });
    expect(await replyOf(await openOn("twin-high", {}, "low"))).toMatchObject({ text: expect.stringContaining("model twin[effort=low]") });
    // No variant for the level: the row's own ID.
    expect(await replyOf(await openOn("twin-high", {}, "xhigh"))).toMatchObject({ text: expect.stringContaining("model twin[effort=high]") });
    expect(await replyOf(await openOn("twin"))).toMatchObject({ text: expect.stringContaining("model twin[effort=low]") });
    // Rows without an effort variant are not touched.
    expect(await replyOf(await openOn("fake-fast", {}, "high"))).toMatchObject({ text: expect.stringContaining("model fake-fast[speed=fast,fast=true]") });
    expect(await replyOf(await openOn("auto", {}, "high"))).toMatchObject({ text: expect.stringContaining("model default[]") });
  });

  it("works with an agent that reports only the models state", async () => {
    const session = await openOn("fake-fast", { FAKE_CURSOR_MODEL_SURFACE: "state" });
    expect(await replyOf(session)).toMatchObject({ text: expect.stringContaining("model fake-fast[") });
  });

  it("fails an unknown model with model_not_found", async () => {
    await expect(openOn("not-a-model")).rejects.toMatchObject({
      code: "model_not_found",
      message: expect.stringContaining('"not-a-model"'),
    });
  });

  it("runs `auto` and Cursor's own spellings of it on Auto", async () => {
    for (const name of ["auto", "default", "default[]"]) {
      expect(await replyOf(await openOn(name))).toMatchObject({ text: expect.stringContaining("model default[]") });
    }
  });

  it("sends no model change for cursor-cli/auto while the session is already on Auto", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oac-cursor-"));
    try {
      const file = join(dir, "requests.jsonl");
      await openOn("auto", { FAKE_CURSOR_LOG: file });
      const methods = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).method);
      expect(methods).not.toContain("session/set_config_option");
      expect(methods).not.toContain("session/set_model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("switches back to Auto when Cursor starts the session on the model it remembered", async () => {
    // Cursor keeps the last model in its config directory, so `auto` after another model needs a switch.
    const session = await openOn("auto", { FAKE_CURSOR_DEFAULT_MODEL: "fake-fast[speed=fast,fast=true]" });
    expect(await replyOf(session)).toMatchObject({ text: expect.stringContaining("model default[]") });
  });

  it("keeps the session's model for `auto` when the agent lists no models", async () => {
    const session = await openOn("auto", { FAKE_CURSOR_NO_MODELS: "1" });
    expect(await replyOf(session)).toMatchObject({ kind: "result" });
  });

  describe("listModels", () => {
    const list = (env: Record<string, string> = {}, extra: { command?: string; timeoutMs?: number } = {}) =>
      cursorAdapter.listModels({
        command: extra.command ?? FAKE_CURSOR_AGENT,
        args: cursorAdapter.launchArgs,
        env: fakeEnv(env),
        ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}),
      });

    it("reports the listing's process and its group, and has stopped the group when it settles", async () => {
      const dir = mkdtempSync(join(tmpdir(), "oac-cursor-"));
      try {
        const file = join(dir, "requests.jsonl");
        const started: Array<{ pid: number; info: unknown }> = [];
        await cursorAdapter.listModels({
          command: FAKE_CURSOR_AGENT,
          args: cursorAdapter.launchArgs,
          env: fakeEnv({ FAKE_CURSOR_LOG: file, FAKE_CURSOR_WORKER: "1" }),
          onProcessStart: (pid, info) => started.push({ pid, info }),
        });
        expect(started).toHaveLength(1);
        if (process.platform !== "win32") expect(started[0]?.info).toEqual({ processGroup: true });
        // The worker the fake started in the listing's group is gone by the time the listing settles.
        const worker = readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { event?: string; pid?: number })
          .find((entry) => entry.event === "worker");
        expect(worker?.pid).toBeGreaterThan(0);
        expect((await inspectProcess(worker!.pid!)).kind).toBe("gone");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("lists the account's models with readable names and exact IDs, without a prompt", async () => {
      const dir = mkdtempSync(join(tmpdir(), "oac-cursor-"));
      try {
        const file = join(dir, "requests.jsonl");
        const models = await list({ FAKE_CURSOR_LOG: file });
        expect(models).toEqual([
          { name: "auto", label: "Auto", id: "default[]" },
          { name: "fake-fast", label: "fake-fast", id: "fake-fast[speed=fast,fast=true]" },
          { name: "fake-slow", label: "fake-slow", id: "fake-slow[context=1m,effort=high]", reasoning: true },
          { name: "twin", label: "twin (effort=low)", id: "twin[effort=low]", reasoning: true },
          { name: "twin-high", label: "twin (effort=high)", id: "twin[effort=high]", reasoning: true },
        ]);
        const methods = readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).method);
        expect(methods).toEqual(["initialize", "authenticate", "session/new"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("skips the login step with CURSOR_API_KEY, like a turn", async () => {
      const dir = mkdtempSync(join(tmpdir(), "oac-cursor-"));
      try {
        const file = join(dir, "requests.jsonl");
        await list({ FAKE_CURSOR_LOG: file, CURSOR_API_KEY: "key" });
        const methods = readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).method);
        expect(methods).toEqual(["initialize", "session/new"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("removes the listing's own session directory from the config dir, and nothing else", async () => {
      const dir = mkdtempSync(join(tmpdir(), "oac-cursor-"));
      try {
        const sessions = join(dir, "acp-sessions");
        mkdirSync(join(sessions, "fake-session-1"), { recursive: true });
        writeFileSync(join(sessions, "fake-session-1", "store.db"), "x");
        mkdirSync(join(sessions, "other-session"), { recursive: true });
        await list({ CURSOR_CONFIG_DIR: dir });
        expect(readdirSync(sessions)).toEqual(["other-session"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("discards only the named session's directory, and refuses a path-like id", async () => {
      const dir = mkdtempSync(join(tmpdir(), "oac-cursor-"));
      try {
        const sessions = join(dir, "acp-sessions");
        for (const name of ["refused", "user-chat"]) mkdirSync(join(sessions, name), { recursive: true });
        await cursorAdapter.discardSession!({ env: { CURSOR_CONFIG_DIR: dir }, sessionId: "../acp-sessions" });
        expect(readdirSync(sessions).sort()).toEqual(["refused", "user-chat"]);
        await cursorAdapter.discardSession!({ env: { CURSOR_CONFIG_DIR: dir }, sessionId: "refused" });
        expect(readdirSync(sessions)).toEqual(["user-chat"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("looks for the session directory under the HOME the child was given when no config dir is set", async () => {
      const home = mkdtempSync(join(tmpdir(), "oac-cursor-"));
      try {
        const sessions = join(home, ".cursor", "acp-sessions");
        mkdirSync(join(sessions, "fake-session-1"), { recursive: true });
        mkdirSync(join(sessions, "other-session"), { recursive: true });
        const { CURSOR_CONFIG_DIR: _unused, ...env } = fakeEnv({ HOME: home });
        await cursorAdapter.listModels({ command: FAKE_CURSOR_AGENT, args: cursorAdapter.launchArgs, env });
        expect(readdirSync(sessions)).toEqual(["other-session"]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it("still lists when the session directory does not exist", async () => {
      const dir = mkdtempSync(join(tmpdir(), "oac-cursor-"));
      try {
        await expect(list({ CURSOR_CONFIG_DIR: dir })).resolves.toHaveLength(5);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails with CliError when cursor-agent is missing", async () => {
      await expect(list({}, { command: "/nonexistent/cursor-agent" })).rejects.toMatchObject({
        code: "cli_not_found",
      });
    });

    it("fails with a timeout when the agent never answers", async () => {
      await expect(list({ FAKE_CURSOR_NO_INIT: "1" }, { timeoutMs: 300 })).rejects.toMatchObject({
        code: "timeout",
      });
    });
  });

  it("skips the login step when CURSOR_API_KEY is set, and runs it otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oac-cursor-"));
    try {
      const methodsFor = async (extra: Record<string, string>) => {
        const file = join(dir, `requests-${Object.keys(extra).length}.jsonl`);
        const session = await cursorAdapter.open({
          command: FAKE_CURSOR_AGENT,
          args: cursorAdapter.launchArgs,
          cwd: process.cwd(),
          env: fakeEnv({ FAKE_CURSOR_LOG: file, ...extra }),
          modelId: "auto",
          onPermissionRequest: async () => "reject_once",
        });
        open.push(session);
        return readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).method);
      };
      expect(await methodsFor({})).toContain("authenticate");
      expect(await methodsFor({ CURSOR_API_KEY: "key" })).not.toContain("authenticate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["session/new", {}],
    ["session/load", { resumeSessionId: "native-9" }],
  ])("hands the MCP proxy to %s in the ACP http shape", async (method, extra) => {
    const dir = mkdtempSync(join(tmpdir(), "oac-cursor-"));
    try {
      const file = join(dir, "requests.jsonl");
      const session = await cursorAdapter.open({
        command: FAKE_CURSOR_AGENT,
        args: cursorAdapter.launchArgs,
        cwd: process.cwd(),
        env: fakeEnv({ FAKE_CURSOR_LOG: file }),
        modelId: "auto",
        mcpServers: [{ name: "openclaw", url: "http://127.0.0.1:4711/mcp", headers: { Authorization: "Bearer proxy-token" } }],
        onPermissionRequest: async () => "reject_once",
        ...extra,
      });
      open.push(session);
      const request = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((entry) => entry.method === method);
      expect(request.params.mcpServers).toEqual([
        {
          type: "http",
          name: "openclaw",
          url: "http://127.0.0.1:4711/mcp",
          headers: [{ name: "Authorization", value: "Bearer proxy-token" }],
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens a side question in ask mode and never resumes or hands it an MCP server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oac-cursor-"));
    try {
      const file = join(dir, "requests.jsonl");
      const session = await cursorAdapter.open({
        command: FAKE_CURSOR_AGENT,
        args: cursorAdapter.launchArgs,
        cwd: process.cwd(),
        env: fakeEnv({ FAKE_CURSOR_LOG: file }),
        modelId: "auto",
        executionMode: "side-question",
        // The core hands a side question neither; the adapter ignores them anyway.
        resumeSessionId: "native-9",
        mcpServers: [{ name: "openclaw", url: "http://127.0.0.1:4711/mcp", headers: {} }],
        onPermissionRequest: async () => "reject_once",
      });
      open.push(session);
      const requests = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.map((entry) => entry.method)).not.toContain("session/load");
      expect(requests.find((entry) => entry.method === "session/new").params.mcpServers).toEqual([]);
      expect(requests.find((entry) => entry.method === "session/set_mode").params).toMatchObject({ modeId: "ask" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a side question without Cursor's read-only mode", async () => {
    await expect(
      cursorAdapter.open({
        command: FAKE_CURSOR_AGENT,
        args: cursorAdapter.launchArgs,
        cwd: process.cwd(),
        env: fakeEnv({ FAKE_CURSOR_NO_ASK_MODE: "1" }),
        modelId: "auto",
        executionMode: "side-question",
        onPermissionRequest: async () => "reject_once",
      }),
    ).rejects.toMatchObject({ code: "capability_mismatch" });
  });

  describe("the mode follows whether the host serves exec", () => {
    const modeOf = async (params: { hostShell?: boolean; executionMode?: "agent" | "side-question"; start?: string; env?: Record<string, string> }) => {
      const session = await cursorAdapter.open({
        command: FAKE_CURSOR_AGENT,
        args: cursorAdapter.launchArgs,
        cwd: process.cwd(),
        // The fake also offers a `plan` mode: "not ask" is not enough, the mode must be exactly the expected one.
        env: fakeEnv({ FAKE_CURSOR_START_MODE: params.start ?? "plan", ...params.env }),
        modelId: "auto",
        ...(params.hostShell === undefined ? {} : { hostShell: params.hostShell }),
        ...(params.executionMode ? { executionMode: params.executionMode } : {}),
        onPermissionRequest: async () => "reject_once",
      });
      open.push(session);
      const events: NormalizedEvent[] = [];
      for await (const event of session.prompt("[[mode]]")) events.push(event);
      return (events.at(-1) as { text: string }).text;
    };

    it("is exactly agent when exec is offered, even from another starting mode and without an ask mode", async () => {
      expect(await modeOf({ hostShell: true })).toBe("mode:agent");
      expect(await modeOf({ hostShell: true, start: "agent", env: { FAKE_CURSOR_NO_ASK_MODE: "1" } })).toBe("mode:agent");
    });

    it("is exactly ask when the host serves no exec (the second lock), by default and when told so", async () => {
      expect(await modeOf({})).toBe("mode:ask");
      expect(await modeOf({ hostShell: false })).toBe("mode:ask");
      expect(await modeOf({ hostShell: false, start: "agent" })).toBe("mode:ask");
    });

    it("is exactly ask for a side question, whatever the host serves", async () => {
      expect(await modeOf({ hostShell: true, executionMode: "side-question" })).toBe("mode:ask");
    });
  });

  describe("permission requests", () => {
    async function ask(spec: unknown, decide: (request: PermissionRequest) => Promise<PermissionDecision>) {
      const session = await cursorAdapter.open({
        command: FAKE_CURSOR_AGENT,
        args: cursorAdapter.launchArgs,
        cwd: process.cwd(),
        env: fakeEnv(),
        modelId: "auto",
        onPermissionRequest: decide,
      });
      open.push(session);
      const events: NormalizedEvent[] = [];
      for await (const event of session.prompt(`[[ask-json]]${JSON.stringify(spec)}`)) events.push(event);
      return JSON.stringify(events);
    }

    it("hands the core a request named in OpenClaw's terms, joined with the earlier tool_call update", async () => {
      const seen: PermissionRequest[] = [];
      const events = await ask(
        {
          announce: { toolCallId: "c9", title: "`ls -la`", kind: "execute", rawInput: { command: "ls -la" } },
          toolCall: { toolCallId: "c9", title: "`ls -la`", kind: "execute" },
        },
        async (request) => {
          seen.push(request);
          return "allow_once";
        },
      );
      expect(seen).toEqual([
        { title: "`ls -la`", kind: "execute", toolCallId: "c9", toolName: "exec", toolInput: { command: "ls -la" } },
      ]);
      expect(events).toContain('\\"optionId\\":\\"allow-once\\"');
    });

    it("hands the core a request it cannot name without a tool name, for the core to reject", async () => {
      const seen: PermissionRequest[] = [];
      await ask({ toolCall: { toolCallId: "c10", title: "Unknown operation", kind: "other" } }, async (request) => {
        seen.push(request);
        return "reject_once";
      });
      expect(seen).toEqual([{ title: "Unknown operation", kind: "other", toolCallId: "c10" }]);
    });
  });

  describe("per-agent home", () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "oac-home-"));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const configOf = (home: string) => join(home, "cli-config.json");
    const read = (home: string) => JSON.parse(readFileSync(configOf(home), "utf8")) as Record<string, unknown>;

    it("points Cursor's config and chat store at the home and writes the static permissions", async () => {
      const home = join(root, "agent-a", "openclaw-all-cli", "cursor-cli");
      await expect(cursorAdapter.prepareHome(home)).resolves.toEqual({
        CURSOR_CONFIG_DIR: home,
        CURSOR_DATA_DIR: join(home, "data"),
      });
      expect(read(home)).toEqual({ permissions: CURSOR_PERMISSIONS });
      expect(CURSOR_PERMISSIONS).toEqual({
        allow: ["Read(**)", "Mcp(openclaw:*)"],
        deny: ["Shell(*)", "Write(**)", "WebFetch(*)"],
      });
    });

    it("gives two agents separate homes with the same permissions", async () => {
      const a = join(root, "a");
      const b = join(root, "b");
      const [envA, envB] = await Promise.all([cursorAdapter.prepareHome(a), cursorAdapter.prepareHome(b)]);
      expect(envA.CURSOR_CONFIG_DIR).not.toBe(envB.CURSOR_CONFIG_DIR);
      expect(envA.CURSOR_DATA_DIR).not.toBe(envB.CURSOR_DATA_DIR);
      expect(read(a)).toEqual(read(b));
    });

    it("does not rewrite a file that already holds the permissions", async () => {
      const home = join(root, "a");
      await cursorAdapter.prepareHome(home);
      const before = statSync(configOf(home));
      await cursorAdapter.prepareHome(home);
      const after = statSync(configOf(home));
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    it("keeps keys Cursor wrote and replaces only the permissions", async () => {
      const home = join(root, "a");
      mkdirSync(home, { recursive: true });
      writeFileSync(
        configOf(home),
        JSON.stringify({ version: 1, editor: { vimMode: true }, permissions: { allow: ["Shell(*)"], deny: [] } }),
      );
      await cursorAdapter.prepareHome(home);
      expect(read(home)).toEqual({ version: 1, editor: { vimMode: true }, permissions: CURSOR_PERMISSIONS });
    });

    it("replaces an unreadable config file", async () => {
      const home = join(root, "a");
      mkdirSync(home, { recursive: true });
      writeFileSync(configOf(home), "{broken");
      await cursorAdapter.prepareHome(home);
      expect(read(home)).toEqual({ permissions: CURSOR_PERMISSIONS });
    });

    it("fails with a CliError naming the file when the config cannot be read, and changes nothing", async () => {
      const home = join(root, "a");
      mkdirSync(configOf(home), { recursive: true });
      const error = await cursorAdapter.prepareHome(home).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain(configOf(home));
      expect(statSync(configOf(home)).isDirectory()).toBe(true);
      expect(readdirSync(home)).toEqual(["cli-config.json"]);
    });

    it("writes the config with mode 0600 in a 0700 home", async () => {
      const home = join(root, "agent", "openclaw-all-cli", "cursor-cli");
      await cursorAdapter.prepareHome(home);
      expect(statSync(configOf(home)).mode & 0o777).toBe(0o600);
      expect(statSync(home).mode & 0o777).toBe(0o700);
    });

    it("leaves one valid file when many turns prepare one home at once", async () => {
      const home = join(root, "a");
      mkdirSync(home, { recursive: true });
      writeFileSync(configOf(home), JSON.stringify({ keep: true }));
      await Promise.all(Array.from({ length: 25 }, () => cursorAdapter.prepareHome(home)));
      expect(read(home)).toEqual({ keep: true, permissions: CURSOR_PERMISSIONS });
      expect(readdirSync(home)).toEqual(["cli-config.json"]);
    });

    it("runs Cursor with the home's env and creates nothing in the working directory", async () => {
      const home = join(root, "agent", "openclaw-all-cli", "cursor-cli");
      const cwd = join(root, "workspace");
      mkdirSync(cwd);
      const log = join(root, "requests.jsonl");
      const env = await cursorAdapter.prepareHome(home);
      const session = await cursorAdapter.open({
        command: FAKE_CURSOR_AGENT,
        args: cursorAdapter.launchArgs,
        cwd,
        env: fakeEnv({ FAKE_CURSOR_LOG: log, ...env }),
        modelId: "auto",
        onPermissionRequest: async () => "reject_once",
      });
      open.push(session);
      for await (const _ of session.prompt("say:hi")) void _;
      const initialize = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((entry) => entry.method === "initialize");
      expect(initialize.env).toEqual({ CURSOR_CONFIG_DIR: home, CURSOR_DATA_DIR: join(home, "data") });
      expect(readdirSync(cwd)).toEqual([]);
    });
  });

  it("has a manifest row for every parity row", () => {
    expect(Object.keys(cursorManifest.rows)).toEqual([...PARITY_ROWS]);
    expect(cursorManifest.rows.P4.status).toBe("approx");
    expect(cursorManifest.rows.P7.status).toBe("match");
    expect(cursorManifest.rows.P6.status).toBe("gap");
  });
});

describe("cursor adapter operations (P17, P19)", () => {
  const check = (extra: Record<string, string>, options: { command?: string; signal?: AbortSignal } = {}) =>
    cursorAdapter.checkVersion({
      command: options.command ?? FAKE_CURSOR_AGENT,
      env: fakeEnv(extra),
      ...(options.signal ? { signal: options.signal } : {}),
    });

  it("floors the version at the manifest's minimum", () => {
    expect(cursorManifest.minVersion).toBe(CURSOR_MIN_VERSION);
    expect(CURSOR_MIN_VERSION).toBe("2026.07.06");
  });

  it.each(["2026.10.16-e3cb207", "2026.07.06", "2026.07.06-abc", "2027.01.01-x", "cursor-agent 2026.10.16-e3cb207"])(
    "accepts %s",
    async (version) => {
      await expect(check({ FAKE_CURSOR_VERSION: version })).resolves.toBe("ok");
    },
  );

  it.each([
    ["2026.05.01-abc", "2026.05.01"],
    ["2026.07.05", "2026.07.05"],
    ["2025.12.31-z", "2025.12.31"],
  ])("fails %s as unsupported_version, naming the found and required versions and the update command", async (version, found) => {
    const error = await check({ FAKE_CURSOR_VERSION: version }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("unsupported_version");
    expect((error as CliError).message).toContain(found);
    expect((error as CliError).message).toContain("2026.07.06");
    expect((error as CliError).message).toContain("cursor-agent update");
  });

  it("compares numerically, not as text", async () => {
    await expect(check({ FAKE_CURSOR_VERSION: "2026.10.9" })).resolves.toBe("ok");
    await expect(check({ FAKE_CURSOR_VERSION: "2026.7.6" })).resolves.toBe("ok");
    await expect(check({ FAKE_CURSOR_VERSION: "2026.7.5" })).rejects.toMatchObject({ code: "unsupported_version" });
  });

  it("warns, and does not fail, when the version cannot be read", async () => {
    const cases: Record<string, string>[] = [
      { FAKE_CURSOR_VERSION: "no version here" },
      { FAKE_CURSOR_VERSION: "2026.05.01-old", FAKE_CURSOR_VERSION_EXIT: "1" },
    ];
    for (const extra of cases) {
      const result = await check(extra);
      expect(result).toEqual({ warning: expect.stringContaining("not checked") });
    }
  });

  it("warns when the check is cut off", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await check({}, { signal: controller.signal });
    expect(result).toEqual({ warning: expect.stringContaining("did not answer") });
  });

  it("fails a missing binary as cli_not_found, with the transport's wording", async () => {
    const error = await check({}, { command: "/nonexistent/cursor-agent" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe("cli_not_found");
    expect((error as CliError).message).toBe(
      'Could not find the CLI binary "/nonexistent/cursor-agent". Install it or set its path in the plugin config.',
    );
  });

  it("clears endpoint, harness, debug, and telemetry keys, and keeps the logins", () => {
    expect(cursorAdapter.clearEnv).toBe(CURSOR_CLEAR_ENV);
    for (const key of ["CURSOR_API_BASE_URL", "CURSOR_API_ENDPOINT", "NODE_OPTIONS", "OTEL_EXPORTER_OTLP_ENDPOINT", "CURSOR_CONFIG_DIR"]) {
      expect(CURSOR_CLEAR_ENV).toContain(key);
    }
    expect(CURSOR_CLEAR_ENV).not.toContain("CURSOR_API_KEY");
    expect(CURSOR_CLEAR_ENV).not.toContain("CURSOR_AUTH_TOKEN");
    expect(new Set(CURSOR_CLEAR_ENV).size).toBe(CURSOR_CLEAR_ENV.length);
  });

  it("reports the process ID as soon as it starts, before the session is open", async () => {
    const pids: number[] = [];
    const session = await cursorAdapter.open({
      command: FAKE_CURSOR_AGENT,
      args: cursorAdapter.launchArgs,
      cwd: process.cwd(),
      env: fakeEnv(),
      modelId: "auto",
      onPermissionRequest: async () => "reject_once",
      onProcessStart: (pid) => pids.push(pid),
    });
    open.push(session);
    expect(pids).toHaveLength(1);
    expect(session.pid).toBe(pids[0]);
  });
});

describe("cursor usage through the core", () => {
  const home = { dir: mkdtempSync(join(tmpdir(), "oac-cursor-usage-")), env: {} as Record<string, string> };
  let stub: Awaited<ReturnType<typeof startLedgerStub>>;
  beforeEach(async () => {
    stub = await startLedgerStub();
  });
  afterEach(async () => {
    await stub.close();
  });

  /** Runs one turn on the fake agent; the stub serves an event for the session id the turn announces. */
  async function turn(apiKey: string | undefined) {
    const execute = createExecute(cursorAdapter, { home, mcp: false });
    const env = fakeEnv({ [USAGE_URL_ENV]: stub.url, ...(apiKey ? { CURSOR_API_KEY: apiKey } : {}) });
    const lines: string[] = [];
    const ctx = {
      command: FAKE_CURSOR_AGENT,
      args: [...cursorAdapter.launchArgs],
      cwd: process.cwd(),
      env,
      prompt: "say:hi",
      modelId: "auto",
      systemPrompt: "",
      useResume: false,
      timeoutMs: 30_000,
      requestToolPermission: async () => ({ behavior: "deny" as const, message: "no" }),
      requestUserInput: async () => ({ status: "cancelled" as const, message: "no" }),
    };
    {
      for await (const record of execute(ctx)) {
        const line = JSON.stringify(record);
        lines.push(line);
        const parsed = parseJsonlEvent(line);
        for (const item of parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed]) {
          const sessionId = (item as { sessionId?: string }).sessionId;
          if (sessionId && !("text" in item)) {
            stub.events = () => ({
              usageEventsDisplay: [
                {
                  conversationId: sessionId,
                  timestamp: String(Date.now()),
                  tokenUsage: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33 },
                },
              ],
            });
          }
        }
      }
    }
    const result = lines.map((line) => parseJsonlEvent(line)).flat().filter(Boolean).at(-1) as Record<string, unknown>;
    return result;
  }

  it("puts the ledger's counts on the result the host parses", async () => {
    const result = await turn("key-usage-wired");
    expect(result).toMatchObject({ usage: { input: 11, output: 22, cacheRead: 33, cacheWrite: 0, total: 66 } });
    expect(stub.count("/aiserver.v1.DashboardService/GetFilteredUsageEvents")).toBeGreaterThan(0);
  });

  it("leaves usage off and calls nothing without a key", async () => {
    const result = await turn(undefined);
    expect(result).toMatchObject({ text: "hi" });
    expect((result as { usage?: unknown }).usage).toBeUndefined();
    expect(stub.requests).toHaveLength(0);
  });

  it("clears the base URL override from the host's turn env", () => {
    expect(cursorAdapter.clearEnv).toContain(USAGE_URL_ENV);
    expect(CURSOR_CLEAR_ENV).toContain("OPENCLAW_ALL_CLI_CURSOR_USAGE_URL");
  });
});
