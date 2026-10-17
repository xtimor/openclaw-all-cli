import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_CURSOR_AGENT, fakeEnv } from "../../../test/fixtures/paths.ts";
import {
  CliError,
  type CliSession,
  type NormalizedEvent,
  type PermissionDecision,
  type PermissionRequest,
} from "../../core/ports.ts";
import { PARITY_ROWS } from "../../core/ports.ts";
import { CURSOR_PERMISSIONS, cursorAdapter, parseStatusOutput } from "./index.ts";
import { cursorManifest } from "./manifest.ts";

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

  it("selects a named model and leaves `auto` to Cursor", async () => {
    const session = await cursorAdapter.open({
      command: FAKE_CURSOR_AGENT,
      args: cursorAdapter.launchArgs,
      cwd: process.cwd(),
      env: fakeEnv(),
      modelId: "fake-fast",
      onPermissionRequest: async () => "reject_once",
    });
    open.push(session);
    const events: NormalizedEvent[] = [];
    for await (const event of session.prompt("hello")) events.push(event);
    expect(events.at(-1)).toMatchObject({ kind: "result", text: expect.stringContaining("model fake-fast") });
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

  it("sends no model change for cursor-cli/auto, even when the session starts on another model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oac-cursor-"));
    try {
      const file = join(dir, "requests.jsonl");
      const session = await cursorAdapter.open({
        command: FAKE_CURSOR_AGENT,
        args: cursorAdapter.launchArgs,
        cwd: process.cwd(),
        env: fakeEnv({ FAKE_CURSOR_LOG: file, FAKE_CURSOR_DEFAULT_MODEL: "fake-fast" }),
        modelId: "auto",
        onPermissionRequest: async () => "reject_once",
      });
      open.push(session);
      const methods = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).method);
      expect(methods).not.toContain("session/set_config_option");
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

  it("refuses to run without Cursor's read-only mode", async () => {
    await expect(
      cursorAdapter.open({
        command: FAKE_CURSOR_AGENT,
        args: cursorAdapter.launchArgs,
        cwd: process.cwd(),
        env: fakeEnv({ FAKE_CURSOR_NO_ASK_MODE: "1" }),
        modelId: "auto",
        onPermissionRequest: async () => "reject_once",
      }),
    ).rejects.toMatchObject({ code: "capability_mismatch" });
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
