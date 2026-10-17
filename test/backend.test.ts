import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/registry.ts";
import { CURSOR_PERMISSIONS, cursorAdapter } from "../src/adapters/cursor/index.ts";
import { createManifest } from "../src/core/ports.ts";
import { backendIdFor, buildCliBackend, nativeAuthMarkerFor } from "../src/core/backend.ts";
import { createConfigValidator, registerAdapters } from "../src/core/register.ts";
import provider from "../src/provider-discovery.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("cursor-cli backend", () => {
  const backend = buildCliBackend(cursorAdapter, { settings: {} });

  it("registers as cursor-cli with the flags the manifest implies", () => {
    expect(backend.id).toBe("cursor-cli");
    expect(backend.config).toMatchObject({
      command: "cursor-agent",
      args: ["acp"],
      resumeArgs: ["acp"],
      output: "jsonl",
      input: "stdin",
      liveSession: "claude-stdio",
      sessionMode: "existing",
    });
    expect(backend).toMatchObject({
      bundleMcp: true,
      bundleMcpMode: "gemini-system-settings",
      hostOwnedTools: ["exec", "process"],
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "prepare-execution",
    });
    expect(backend.parseJsonlEvent).toBeTypeOf("function");
  });

  it("takes the binary from the plugin config", () => {
    const custom = buildCliBackend(cursorAdapter, { settings: { command: "/opt/cursor-agent" } });
    expect(custom.config.command).toBe("/opt/cursor-agent");
  });

  const scratch = mkdtempSync(join(tmpdir(), "oac-backend-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  type Turn = { records: Record<string, unknown>[]; events: Array<Record<string, unknown> | null> };
  async function runTurn(agentDir: string | undefined, env: Record<string, string> = {}, cwd = process.cwd()): Promise<Turn> {
    const prepared = await backend.prepareExecution!({ ...(agentDir === undefined ? {} : { agentDir }) } as never);
    const records: Record<string, unknown>[] = [];
    for await (const record of prepared!.execute!({
      command: FAKE_CURSOR_AGENT,
      args: ["acp"],
      cwd,
      env: fakeEnv(env),
      prompt: "say:pong",
      modelId: "auto",
      systemPrompt: "",
      useResume: false,
      timeoutMs: 10_000,
      requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
      requestUserInput: async () => ({ status: "cancelled", message: "no" }),
    })) {
      records.push(record);
    }
    const parse = backend.parseJsonlEvent!;
    return { records, events: records.map((record) => parse(JSON.stringify(record), {} as never) as never) };
  }

  const homeOf = (agentDir: string) => join(agentDir, "openclaw-all-cli", "cursor-cli");

  it("runs a prepared turn end to end against an ACP agent", async () => {
    const { events } = await runTurn(join(scratch, "end-to-end"));
    expect(events.at(-1)).toMatchObject({ kind: "result", text: "pong", sessionId: "fake-session-1" });
  });

  it("gives each agent its own home with the static permissions and leaves the workspace alone", async () => {
    const workspace = join(scratch, "workspace");
    mkdirSync(workspace);
    const homes: Record<string, { config: string; data: string }> = {};
    for (const name of ["agent-a", "agent-b"]) {
      const agentDir = join(scratch, name);
      const log = join(scratch, `${name}.jsonl`);
      const { events } = await runTurn(agentDir, { FAKE_CURSOR_LOG: log }, workspace);
      expect(events.at(-1)).toMatchObject({ kind: "result", text: "pong" });
      const initialize = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((entry) => entry.method === "initialize");
      homes[name] = { config: initialize.env.CURSOR_CONFIG_DIR, data: initialize.env.CURSOR_DATA_DIR };
      expect(homes[name]).toEqual({ config: homeOf(agentDir), data: join(homeOf(agentDir), "data") });
      expect(JSON.parse(readFileSync(join(homeOf(agentDir), "cli-config.json"), "utf8"))).toEqual({
        permissions: CURSOR_PERMISSIONS,
      });
    }
    expect(homes["agent-a"]!.config).not.toBe(homes["agent-b"]!.config);
    expect(readdirSync(workspace)).toEqual([]);
  });

  it.each([undefined, ""])("fails the turn when OpenClaw gives no agent directory (%j)", async (agentDir) => {
    const cwd = mkdtempSync(join(scratch, "no-agent-dir-"));
    const { records, events } = await runTurn(agentDir, {}, cwd);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "result", is_error: true });
    expect(events.at(-1)).toMatchObject({
      kind: "result",
      errorText: expect.stringContaining("OpenClaw gave no agent directory"),
    });
    // No shared home appears anywhere: nothing was created next to the scratch agent homes or in the cwd.
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync(join(process.cwd(), "openclaw-all-cli"))).toBe(false);
  });
});

describe("tool availability (AD-9)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "oac-backend-tools-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const backend = buildCliBackend(cursorAdapter, { settings: {} });
  const prepare = (toolAvailability?: { native: string[]; openClaw: string[] }) =>
    backend.prepareExecution!({ agentDir: join(scratch, "agent"), ...(toolAvailability ? { toolAvailability } : {}) } as never);

  it("asks for no confirmation when the host selects no tools", async () => {
    const prepared = await prepare();
    expect(prepared?.execute).toBeTypeOf("function");
    expect(prepared).not.toHaveProperty("toolAvailabilityEnforced");
  });

  it("confirms a selection that keeps the native tools Cursor cannot switch off", async () => {
    const prepared = await prepare({ native: ["read", "grep", "glob"], openClaw: ["memory_search"] });
    expect(prepared?.toolAvailabilityEnforced).toBe(true);
    expect(prepared?.execute).toBeTypeOf("function");
    const withMore = await prepare({ native: ["read", "grep", "glob", "exec"], openClaw: [] });
    expect(withMore?.toolAvailabilityEnforced).toBe(true);
  });

  it.each([
    [[], "read, grep, glob"],
    [["read"], "grep, glob"],
    [["grep", "glob", "exec"], "read"],
  ])("refuses a selection of native tools %j, which Cursor cannot honor", async (native, blocked) => {
    await expect(prepare({ native, openClaw: ["memory_search"] })).rejects.toThrow(
      new RegExp(`keeps native ${blocked.replaceAll(", ", ", ")} on in every turn.*did not start the run`),
    );
  });

  it("stays on always-on tools when the manifest leaves P10 undecided", () => {
    const adapter = {
      ...cursorAdapter,
      manifest: createManifest(cursorAdapter.manifest.minVersion, {
        ...cursorAdapter.manifest.rows,
        P10: { status: "spike", note: "off" },
      }),
    };
    const undecided = buildCliBackend(adapter, { settings: {} });
    expect(undecided.nativeToolMode).toBe("always-on");
    expect(undecided.toolAvailabilityEnforcement).toBeUndefined();
  });
});

describe("plugin registration", () => {
  it("registers one backend per adapter", () => {
    const registered: string[] = [];
    registerAdapters(
      {
        pluginConfig: { "cursor-cli": { command: "/x/cursor-agent" } },
        logger: { warn: () => {} },
        registerCliBackend: (b: { id: string; config: { command: string } }) => {
          registered.push(`${b.id}:${b.config.command}`);
        },
      } as never,
      ADAPTERS,
    );
    expect(registered).toEqual(["cursor-cli:/x/cursor-agent"]);
  });
});

describe("MCP proxy wiring", () => {
  const scratch = mkdtempSync(join(tmpdir(), "oac-backend-mcp-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  type Backend = ReturnType<typeof buildCliBackend>;
  /** Runs one turn of `backend` against the fake agent, without the host's MCP settings env. */
  async function turn(backend: Backend, name: string): Promise<Record<string, unknown>[]> {
    const log = join(scratch, `${name}.jsonl`);
    const prepared = await backend.prepareExecution!({ agentDir: join(scratch, name) } as never);
    const records: Record<string, unknown>[] = [];
    for await (const record of prepared!.execute!({
      command: FAKE_CURSOR_AGENT,
      args: ["acp"],
      cwd: process.cwd(),
      env: fakeEnv({ FAKE_CURSOR_LOG: log }),
      prompt: "say:pong",
      modelId: "auto",
      systemPrompt: "",
      useResume: false,
      timeoutMs: 10_000,
      requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
      requestUserInput: async () => ({ status: "cancelled", message: "no" }),
    })) {
      records.push(record);
    }
    return records;
  }
  const sessionNewParams = (name: string) =>
    readFileSync(join(scratch, `${name}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((entry) => entry.method === "session/new").params;

  it("warns once, naming the settings variable, when a turn has no settings file (buildCliBackend)", async () => {
    const warnings: string[] = [];
    const backend = buildCliBackend(cursorAdapter, { settings: {}, warn: (message) => warnings.push(message) });
    const records = await turn(backend, "warn-direct");
    expect(records.at(-1)).toMatchObject({ type: "result", is_error: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("GEMINI_CLI_SYSTEM_SETTINGS_PATH");
    expect(sessionNewParams("warn-direct").mcpServers).toHaveLength(1);
  });

  it("warns once through the plugin logger when registered by registerAdapters", async () => {
    const warnings: string[] = [];
    const backends: Backend[] = [];
    registerAdapters(
      {
        pluginConfig: {},
        logger: { warn: (message: string) => warnings.push(message) },
        registerCliBackend: (backend: Backend) => backends.push(backend),
      } as never,
      ADAPTERS,
    );
    const records = await turn(backends[0]!, "warn-registered");
    expect(records.at(-1)).toMatchObject({ type: "result", is_error: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("GEMINI_CLI_SYSTEM_SETTINGS_PATH");
  });

  it("starts no proxy and warns about nothing when the manifest leaves P7 undecided", async () => {
    const warnings: string[] = [];
    const adapter = {
      ...cursorAdapter,
      manifest: createManifest(cursorAdapter.manifest.minVersion, {
        ...cursorAdapter.manifest.rows,
        P7: { status: "spike", note: "off" },
      }),
    };
    const backend = buildCliBackend(adapter, { settings: {}, warn: (message) => warnings.push(message) });
    expect(backend.bundleMcp).toBeUndefined();
    expect(backend.bundleMcpMode).toBeUndefined();
    const records = await turn(backend, "mcp-off");
    expect(records.at(-1)).toMatchObject({ type: "result", is_error: false });
    expect(warnings).toEqual([]);
    expect(sessionNewParams("mcp-off").mcpServers).toEqual([]);
  });
});

describe("plugin config validator", () => {
  const validator = createConfigValidator(ADAPTERS);

  it("accepts no config and a valid one", () => {
    expect(validator.safeParse(undefined)).toEqual({ success: true, data: {} });
    expect(validator.safeParse({ "cursor-cli": { command: "/x/cursor-agent" } })).toEqual({
      success: true,
      data: { "cursor-cli": { command: "/x/cursor-agent" } },
    });
  });

  it("rejects an empty command with its path", () => {
    const result = validator.safeParse({ "cursor-cli": { command: "" } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["cursor-cli", "command"]);
  });
});

describe("openclaw.plugin.json", () => {
  const ids = ADAPTERS.map(backendIdFor);

  it("declares every adapter's backend, provider, and synthetic auth", () => {
    expect(manifest.id).toBe("openclaw-all-cli");
    expect(manifest.cliBackends).toEqual(ids);
    expect(manifest.setup.cliBackends).toEqual(ids);
    // OpenClaw loads the provider-catalog entry only for a plugin that owns the provider ID.
    expect(manifest.providers).toEqual(ids);
    expect(manifest.syntheticAuthRefs).toEqual(ids);
    expect(manifest.nonSecretAuthMarkers).toEqual(ADAPTERS.map(nativeAuthMarkerFor));
  });

  it("points at the built entries that package.json ships", () => {
    expect(manifest.providerCatalogEntry).toBe("./dist/provider-discovery.js");
    expect(pkg.openclaw.extensions).toEqual(["./src/plugin.ts"]);
    expect(pkg.openclaw.runtimeExtensions).toEqual(["./dist/plugin.js"]);
  });
});

describe("synthetic auth provider entry", () => {
  const entry = (provider as unknown as { prepareSyntheticAuth: (c: unknown) => Promise<unknown>; id: string }[])[0]!;
  const config = (command: string) => ({ plugins: { entries: { "openclaw-all-cli": { config: { "cursor-cli": { command } } } } } });

  it("offers one entry per backend", () => {
    expect((provider as unknown as { id: string }[]).map((p) => p.id)).toEqual(ADAPTERS.map(backendIdFor));
  });

  it("returns the native-auth marker when the CLI login works", async () => {
    await expect(
      entry.prepareSyntheticAuth({ provider: "cursor-cli", config: config(FAKE_CURSOR_AGENT), env: fakeEnv() }),
    ).resolves.toEqual({ apiKey: "openclaw:cursor-cli-native-auth", source: "Cursor CLI native auth", mode: "oauth" });
  });

  it("returns nothing when the login is missing, the provider differs, or there is no config", async () => {
    await expect(
      entry.prepareSyntheticAuth({
        provider: "cursor-cli",
        config: config(FAKE_CURSOR_AGENT),
        env: fakeEnv({ FAKE_CURSOR_LOGGED_IN: "0" }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      entry.prepareSyntheticAuth({ provider: "other-cli", config: config(FAKE_CURSOR_AGENT), env: fakeEnv() }),
    ).resolves.toBeUndefined();
    await expect(entry.prepareSyntheticAuth({ provider: "cursor-cli", env: fakeEnv() })).resolves.toBeUndefined();
  });
});
