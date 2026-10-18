import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ADAPTERS } from "../src/registry.ts";
import { CURSOR_PERMISSIONS, cursorAdapter } from "../src/adapters/cursor/index.ts";
import { createManifest } from "../src/core/ports.ts";
import { backendIdFor, buildCliBackend, nativeAuthMarkerFor } from "../src/core/backend.ts";
import { createConfigValidator, registerAdapters } from "../src/core/register.ts";
import provider from "../src/provider-discovery.ts";
import { createModelCatalog } from "../src/core/catalog.ts";
import { createSyntheticAuthProvider } from "../src/core/synthetic-auth.ts";
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
      // P5: only an error that proves the chat is gone may start a fresh one.
      freshSessionRecovery: "invalidated-only",
    });
    // P18: the host runs a side question without OpenClaw's tools.
    expect(backend.sideQuestionToolMode).toBe("disabled");
    expect(backend).toMatchObject({
      bundleMcp: true,
      bundleMcpMode: "gemini-system-settings",
      hostOwnedTools: ["exec", "process"],
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "prepare-execution",
    });
    expect(backend.parseJsonlEvent).toBeTypeOf("function");
  });

  it("asks the host to clear the adapter's env keys from every turn, and keeps the logins (P17)", () => {
    expect(backend.config.clearEnv).toEqual([...cursorAdapter.clearEnv]);
    expect(backend.config.clearEnv).toContain("CURSOR_API_BASE_URL");
    expect(backend.config.clearEnv).not.toContain("CURSOR_API_KEY");
    // The backend declares no reliability: the host's watchdog defaults apply, like claude-cli.
    expect(backend.config).not.toHaveProperty("reliability");
    expect(backend).not.toHaveProperty("runtimeArtifact");
    expect(backend.config).not.toHaveProperty("serialize");
  });

  it("hands Cursor's own spellings of Auto to OpenClaw as model aliases", () => {
    expect(backend.config.modelAliases).toEqual({ "default[]": "auto", default: "auto" });
  });

  it("lets the host reseed a lost chat from its transcript exactly when P15 is decided", () => {
    expect(backend.config.reseedFromRawTranscriptWhenUncompacted).toBe(true);
    const undecided = buildCliBackend(
      { ...cursorAdapter, manifest: createManifest("1", { ...cursorAdapter.manifest.rows, P15: { status: "spike", note: "" } }) },
      { settings: {} },
    );
    expect(undecided.config).not.toHaveProperty("reseedFromRawTranscriptWhenUncompacted");
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

  it("starts a fresh chat's first prompt with the continuity note (P15)", async () => {
    const settings = join(scratch, "continuity-settings.json");
    writeFileSync(settings, JSON.stringify({ mcpServers: { openclaw: { url: "http://127.0.0.1:1/mcp", headers: {} } } }));
    const log = join(scratch, "continuity.jsonl");
    const env = { FAKE_CURSOR_LOG: log, GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings };
    const prompts = () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params: { prompt: Array<{ text: string }> } })
        .filter((line) => line.method === "session/prompt")
        .map((line) => line.params.prompt.map((part) => part.text).join(""));
    await runTurn(join(scratch, "continuity"), env);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toContain("sessions_history");
    expect(prompts()[0]).toMatch(/say:pong$/);
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

describe("operations wiring (P17, P19)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "oac-backend-ops-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  type Backend = ReturnType<typeof buildCliBackend>;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function turn(backend: Backend, name: string, prompt: string, env: Record<string, string> = {}) {
    const prepared = await backend.prepareExecution!({ agentDir: join(scratch, name) } as never);
    const records: Record<string, unknown>[] = [];
    for await (const record of prepared!.execute!({
      command: FAKE_CURSOR_AGENT,
      args: ["acp"],
      cwd: process.cwd(),
      env: fakeEnv(env),
      prompt,
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

  const entries = (file: string) =>
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; t: number });

  it("holds turns beyond maxConcurrentTurns until a slot frees, across agents", async () => {
    const log = join(scratch, "cap.jsonl");
    const env = { FAKE_CURSOR_LOG: log, FAKE_CURSOR_LOG_END: "1" };
    const backend = buildCliBackend(cursorAdapter, { settings: { maxConcurrentTurns: 1, maxProcesses: 2 } });
    const first = turn(backend, "cap-a", "[[sleep:400]]", env);
    await sleep(100);
    const second = turn(backend, "cap-b", "say:later", env);
    const [a, b] = await Promise.all([first, second]);
    expect(a.at(-1)).toMatchObject({ is_error: false });
    expect(b.at(-1)).toMatchObject({ is_error: false });
    const lines = entries(log);
    const firstEnd = lines.find((line) => line.method === "prompt/end")!.t;
    const prompts = lines.filter((line) => line.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.t).toBeGreaterThanOrEqual(firstEnd);
  });

  it("runs two agents at once under the defaults", async () => {
    const log = join(scratch, "open.jsonl");
    const env = { FAKE_CURSOR_LOG: log, FAKE_CURSOR_LOG_END: "1" };
    const backend = buildCliBackend(cursorAdapter, { settings: {} });
    await Promise.all([turn(backend, "open-a", "[[sleep:400]]", env), turn(backend, "open-b", "[[sleep:400]]", env)]);
    const lines = entries(log);
    const prompts = lines.filter((line) => line.method === "session/prompt");
    const ends = lines.filter((line) => line.method === "prompt/end");
    expect(prompts).toHaveLength(2);
    // Both prompts started before either ended.
    expect(Math.max(...prompts.map((line) => line.t))).toBeLessThan(Math.min(...ends.map((line) => line.t)));
  });

  it("fails a turn before any ACP session when the CLI is older than the floor", async () => {
    const log = join(scratch, "old.jsonl");
    const backend = buildCliBackend(cursorAdapter, { settings: {} });
    const records = await turn(backend, "old", "say:hi", { FAKE_CURSOR_LOG: log, FAKE_CURSOR_VERSION: "2026.05.01-old" });
    expect(records.at(-1)).toMatchObject({ type: "result", is_error: true });
    expect(JSON.stringify(records)).toContain("2026.05.01");
    expect(JSON.stringify(records)).toContain("2026.07.06");
    expect(existsSync(log)).toBe(false);
  });

  it("reaps leftovers of a killed Gateway before a turn in a home the plugin has not met", async () => {
    const dir = join(scratch, "reap-first-use", "openclaw-all-cli", "cursor-cli");
    mkdirSync(join(dir, "pids"), { recursive: true });
    const corrupt = join(dir, "pids", "4242.json");
    writeFileSync(corrupt, "not json");
    const warnings: string[] = [];
    const backend = buildCliBackend(cursorAdapter, { settings: {}, warn: (m) => warnings.push(m) });
    await turn(backend, "reap-first-use", "say:hi");
    expect(existsSync(corrupt)).toBe(false);
    expect(warnings.some((m) => m.includes("corrupt"))).toBe(true);
  });

  it("closes busy and idle processes when the plugin unloads, and refuses new turns", async () => {
    const hooks: { dispose: Array<() => unknown>; services: Array<{ id: string; stop: () => unknown }> } = { dispose: [], services: [] };
    const backends: Backend[] = [];
    const warnings: string[] = [];
    registerAdapters(
      {
        pluginConfig: {},
        logger: { warn: (m: string) => warnings.push(m) },
        registerCliBackend: (b: Backend) => backends.push(b),
        lifecycle: { onDispose: (fn: () => unknown) => (hooks.dispose.push(fn), () => {}) },
        registerService: (service: { id: string; stop: () => unknown }) => hooks.services.push(service),
      } as never,
      ADAPTERS,
    );
    expect(hooks.dispose).toHaveLength(1);
    expect(hooks.services).toHaveLength(1);
    const running = turn(backends[0]!, "unload", "[[hang]]");
    const outcome = running.then((records) => records.at(-1));
    await sleep(500);
    await hooks.services[0]!.stop();
    // The hung turn ended because its process was closed.
    expect(await outcome).toMatchObject({ type: "result", is_error: true });
    // Both hooks may run on a host that fires both; closing twice is harmless.
    await hooks.dispose[0]!();
    const after = await turn(backends[0]!, "unload", "say:hi");
    expect(after.at(-1)).toMatchObject({ type: "result", is_error: true });
    expect(JSON.stringify(after)).toContain("shutting down");
  });

  it("resolves the unload only after a stubborn process has exited", async () => {
    const services: Array<{ stop: () => Promise<void> }> = [];
    const backends: Backend[] = [];
    registerAdapters(
      {
        pluginConfig: {},
        logger: { warn: () => {} },
        registerCliBackend: (b: Backend) => backends.push(b),
        registerService: (service: { stop: () => Promise<void> }) => services.push(service),
      } as never,
      ADAPTERS,
    );
    // The fake ignores SIGTERM, so it exits only when the plugin escalates to SIGKILL (about 2 s).
    const running = turn(backends[0]!, "stubborn", "[[hang]]", {
      FAKE_CURSOR_IGNORE_TERM: "1",
      FAKE_CURSOR_IGNORE_STDIN_EOF: "1",
      FAKE_CURSOR_LOG: join(scratch, "stubborn.jsonl"),
    });
    const pids = join(scratch, "stubborn", "openclaw-all-cli", "cursor-cli", "pids");
    for (let i = 0; i < 100 && !(existsSync(pids) && readdirSync(pids).some((name) => name.endsWith(".json"))); i += 1) await sleep(50);
    expect(readdirSync(pids).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    // Wait for the turn itself: before that the fake still dies on SIGTERM.
    const log = join(scratch, "stubborn.jsonl");
    for (let i = 0; i < 100 && !(existsSync(log) && readFileSync(log, "utf8").includes("session/prompt")); i += 1) await sleep(50);
    const started = Date.now();
    await services[0]!.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    await sleep(150);
    // The lock goes when the process has exited, so an empty directory means the stop waited for it.
    expect(readdirSync(pids).filter((name) => name.endsWith(".json"))).toEqual([]);
    await running;
  });

  it("reaps the homes of the configured agents when fully loaded, and only then", async () => {
    const agentRoot = mkdtempSync(join(scratch, "reg-"));
    const agentDirOf = (id: string) => join(agentRoot, id);
    const lock = (id: string) => {
      const dir = join(agentDirOf(id), "openclaw-all-cli", "cursor-cli", "pids");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "4242.json");
      writeFileSync(file, "broken");
      return file;
    };
    const api = (mode: string) =>
      ({
        pluginConfig: {},
        registrationMode: mode,
        config: { agents: { entries: { work: {} } } },
        runtime: { agent: { resolveAgentDir: (_cfg: unknown, id: string) => agentDirOf(id) } },
        logger: { warn: () => {} },
        registerCliBackend: () => {},
      }) as never;
    const discovery = [lock("main-d"), lock("work-d")];
    registerAdapters(api("discovery"), ADAPTERS);
    await sleep(300);
    expect(discovery.every((file) => existsSync(file))).toBe(true);

    const files = [lock("main"), lock("work"), lock("other")];
    registerAdapters(api("full"), ADAPTERS);
    await sleep(500);
    expect(existsSync(files[0]!)).toBe(false);
    expect(existsSync(files[1]!)).toBe(false);
    // An agent the config does not name waits for its first use.
    expect(existsSync(files[2]!)).toBe(true);
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

  it("probes the login without the adapter's cleared env keys", async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const spy = { ...cursorAdapter, probeAuth: async (p: { env: Record<string, string | undefined> }) => (seen.push(p.env), "available" as const) };
    const spied = createSyntheticAuthProvider(spy as never) as unknown as typeof entry;
    await spied.prepareSyntheticAuth({
      provider: "cursor-cli",
      config: config(FAKE_CURSOR_AGENT),
      env: { PATH: "/bin", CURSOR_API_BASE_URL: "http://elsewhere", NODE_OPTIONS: "--require x", CURSOR_API_KEY: "key" },
    });
    expect(seen).toEqual([{ PATH: "/bin", CURSOR_API_KEY: "key" }]);
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

describe("provider catalog entry", () => {
  type Row = { id: string; name: string; cost: unknown; input: unknown; reasoning: boolean };
  type Result = { provider: { baseUrl: string; api: string; models: Row[] } } | null;
  const quickList = { ...cursorAdapter, listModels: (p: Parameters<typeof cursorAdapter.listModels>[0]) => cursorAdapter.listModels({ ...p, timeoutMs: 400 }) };
  const config = { plugins: { entries: { "openclaw-all-cli": { config: { "cursor-cli": { command: FAKE_CURSOR_AGENT } } } } } };
  const entryFor = (warn: (message: string) => void = () => {}) => {
    const entry = createSyntheticAuthProvider(quickList, createModelCatalog(quickList, { warn })) as unknown as {
      catalog: { order: string; run: (context: unknown) => Promise<Result> };
    };
    return entry.catalog;
  };
  const ids = (result: Result) => result?.provider.models.map((model) => model.id);

  it("lists the account's models as plain names, ordered after the other providers", async () => {
    const catalog = entryFor();
    expect(catalog.order).toBe("late");
    const result = await catalog.run({ config, env: fakeEnv(), providerIds: ["cursor-cli"] });
    expect(ids(result)).toEqual(["auto", "fake-fast", "fake-slow", "twin", "twin-high"]);
    expect(result?.provider.models[0]).toMatchObject({ id: "auto", name: "Auto", reasoning: false, input: ["text"] });
    // OpenClaw drops a provider with no base URL or api; no request goes to either.
    expect(result?.provider.baseUrl).toBeTruthy();
    expect(result?.provider.api).toBeTruthy();
  });

  it("offers images only when the manifest decided P13", async () => {
    const withImages = {
      ...quickList,
      manifest: createManifest(quickList.manifest.minVersion, { ...quickList.manifest.rows, P13: { status: "approx", note: "" } }),
    };
    const entry = createSyntheticAuthProvider(withImages, createModelCatalog(withImages)) as unknown as {
      catalog: { run: (context: unknown) => Promise<Result> };
    };
    const result = await entry.catalog.run({ config, env: fakeEnv() });
    expect(result?.provider.models.every((model) => (model.input as string[]).includes("image"))).toBe(true);
  });

  it("lists the models, and probes, without the adapter's cleared env keys", async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const probe: typeof quickList.probeAuth = async (p) => (seen.push(p.env), "available");
    const listed: Array<Record<string, string>> = [];
    const adapter = {
      ...quickList,
      probeAuth: probe,
      listModels: async (p: Parameters<typeof quickList.listModels>[0]) => (listed.push(p.env), quickList.listModels(p)),
    };
    const entry = createSyntheticAuthProvider(adapter, createModelCatalog(adapter)) as unknown as {
      catalog: { run: (context: unknown) => Promise<Result> };
    };
    await entry.catalog.run({
      config,
      env: fakeEnv({ CURSOR_API_BASE_URL: "http://elsewhere", OTEL_SDK_DISABLED: "true", CURSOR_API_KEY: "key" }),
    });
    for (const env of [...seen, ...listed]) {
      expect(env).not.toHaveProperty("CURSOR_API_BASE_URL");
      expect(env).not.toHaveProperty("OTEL_SDK_DISABLED");
      expect(env).toHaveProperty("CURSOR_API_KEY", "key");
    }
    expect(seen).toHaveLength(1);
    expect(listed).toHaveLength(1);
  });

  it("offers only Auto, and does not start Cursor, without a login or API key", async () => {
    const list = vi.fn(quickList.listModels);
    const adapter = { ...quickList, listModels: list };
    const entry = createSyntheticAuthProvider(adapter, createModelCatalog(adapter)) as unknown as {
      catalog: { run: (context: unknown) => Promise<Result> };
    };
    const result = await entry.catalog.run({ config, env: fakeEnv({ FAKE_CURSOR_LOGGED_IN: "0" }) });
    expect(ids(result)).toEqual(["auto"]);
    expect(list).not.toHaveBeenCalled();
  });

  it("lists the models with only CURSOR_API_KEY set", async () => {
    const result = await entryFor().run({
      config,
      env: fakeEnv({ FAKE_CURSOR_LOGGED_IN: "0", CURSOR_API_KEY: "key" }),
    });
    expect(ids(result)).toHaveLength(5);
  });

  it("offers only Auto and logs when listing fails, so no turn fails", async () => {
    const warn = vi.fn();
    const result = await entryFor(warn).run({ config, env: fakeEnv({ FAKE_CURSOR_NO_INIT: "1" }) });
    expect(ids(result)).toEqual(["auto"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("Cursor CLI");
  });

  it("answers only for its own provider, and stops when aborted", async () => {
    const catalog = entryFor();
    await expect(catalog.run({ config, env: fakeEnv(), providerIds: ["other-cli"] })).resolves.toBeNull();
    const controller = new AbortController();
    controller.abort();
    await expect(catalog.run({ config, env: fakeEnv(), signal: controller.signal })).rejects.toThrow();
  });

  it("is the entry the plugin ships", () => {
    const shipped = (provider as unknown as { catalog?: unknown }[])[0]!;
    expect(shipped.catalog).toBeTypeOf("object");
  });
});

describe("session resume and side questions (P4, P5, P18)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "oac-backend-resume-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const backend = buildCliBackend(cursorAdapter, { settings: {} });
  const workspace = join(scratch, "workspace");
  mkdirSync(workspace);

  type Parsed = Record<string, unknown> | null;
  /** One prepared turn, as the host runs it: prepareExecution, then execute. */
  async function turn(
    agentDir: string,
    prompt: string,
    extra: { env?: Record<string, string>; sessionId?: string; useResume?: boolean; executionMode?: "agent" | "side-question"; authProfileId?: string } = {},
  ) {
    const { env, sessionId, useResume, executionMode, authProfileId } = extra;
    const prepared = await backend.prepareExecution!({
      agentDir,
      ...(executionMode ? { executionMode } : {}),
      ...(authProfileId ? { authProfileId } : {}),
    } as never);
    const records: Record<string, unknown>[] = [];
    for await (const record of prepared!.execute!({
      command: FAKE_CURSOR_AGENT,
      args: ["acp"],
      cwd: workspace,
      env: fakeEnv(env),
      prompt,
      modelId: "auto",
      systemPrompt: "",
      useResume: useResume ?? false,
      ...(sessionId ? { sessionId } : {}),
      ...(executionMode ? { executionMode } : {}),
      timeoutMs: 10_000,
      requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
      requestUserInput: async () => ({ status: "cancelled", message: "no" }),
    })) {
      records.push(record);
    }
    const events = records.map((record) => backend.parseJsonlEvent!(JSON.stringify(record), {} as never) as unknown as Parsed);
    const last = events.at(-1) as { text?: string; errorText?: string; sessionId?: string } | null;
    return { records, events, last };
  }

  it("keeps the chat across a restart, answers the fact, and sends only the new prompt", async () => {
    const chats = mkdtempSync(join(scratch, "chats-"));
    const agentDir = join(scratch, "restart-agent");
    const env = { FAKE_CURSOR_STORE: chats };
    const first = await turn(agentDir, "remember: banana", { env });
    const id = first.last!.sessionId!;
    expect(id).toMatch(/^fake-session-/);

    // A new Gateway: a new process, resumed by the id the host stored.
    const log = join(scratch, "restart.jsonl");
    const second = await turn(agentDir, "[[recall]]", { env: { ...env, FAKE_CURSOR_LOG: log }, sessionId: id, useResume: true });
    // P15: the first prompt of the fresh chat carried the continuity note, and the chat keeps it.
    expect(second.last).toMatchObject({ kind: "result", sessionId: id });
    expect(second.last!.text).toMatch(/^recall:\[OpenClaw\].*sessions_history.*remember: banana$/s);
    const prompts = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.method === "session/prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].params.prompt).toEqual([{ type: "text", text: "[[recall]]" }]);
  });

  it("starts a fresh chat on /reset, which passes no resume id", async () => {
    const chats = mkdtempSync(join(scratch, "chats-"));
    const agentDir = join(scratch, "reset-agent");
    const env = { FAKE_CURSOR_STORE: chats };
    const first = await turn(agentDir, "remember: banana", { env });
    const reset = await turn(agentDir, "[[recall]]", { env, sessionId: first.last!.sessionId!, useResume: false });
    expect(reset.last).toMatchObject({ kind: "result", text: "recall:" });
    expect(reset.last!.sessionId).not.toBe(first.last!.sessionId);
  });

  it("fails another agent's chat as session_expired, in words the host classifies, without a fresh chat", async () => {
    const chats = mkdtempSync(join(scratch, "chats-"));
    const owner = await turn(join(scratch, "owner-agent"), "remember: banana", { env: { FAKE_CURSOR_STORE: chats } });
    // Another agent has its own home, so its Cursor does not know the id.
    const stranger = mkdtempSync(join(scratch, "chats-"));
    const log = join(scratch, "foreign.jsonl");
    const foreign = await turn(join(scratch, "other-agent"), "[[recall]]", {
      env: { FAKE_CURSOR_STORE: stranger, FAKE_CURSOR_LOG: log },
      sessionId: owner.last!.sessionId!,
      useResume: true,
    });
    expect(foreign.records.at(-1)).toMatchObject({
      type: "result",
      is_error: true,
      event: { kind: "error", error: { code: "session_expired" } },
    });
    expect(foreign.last?.errorText).toMatch(/session not found/i);
    const methods = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).method);
    expect(methods).toContain("session/load");
    expect(methods).not.toContain("session/new");
    expect(methods).not.toContain("session/prompt");
  });

  it("runs a side question in ask mode with no MCP server and no resume, and reports no session id", async () => {
    const chats = mkdtempSync(join(scratch, "chats-"));
    const agentDir = join(scratch, "side-agent");
    const env = { FAKE_CURSOR_STORE: chats };
    const chat = await turn(agentDir, "remember: banana", { env });
    const log = join(scratch, "side.jsonl");
    const side = await turn(agentDir, "say:42", {
      env: { ...env, FAKE_CURSOR_LOG: log },
      sessionId: chat.last!.sessionId!,
      useResume: true,
      executionMode: "side-question",
    });
    expect(side.last).toMatchObject({ kind: "result", text: "42" });
    expect(side.last!.sessionId).toBeUndefined();
    const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const methods = requests.map((entry) => entry.method);
    expect(methods).not.toContain("session/load");
    expect(requests.find((entry) => entry.method === "session/new").params.mcpServers).toEqual([]);
    expect(requests.find((entry) => entry.method === "session/set_mode").params).toMatchObject({ modeId: "ask" });
  });

  it("gives a side question no OpenClaw tools even when the host wrote its MCP settings", async () => {
    const dir = mkdtempSync(join(scratch, "settings-"));
    const file = join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { openclaw: { url: "http://127.0.0.1:1/mcp", headers: {} } } }));
    const log = join(scratch, "side-settings.jsonl");
    const env = { FAKE_CURSOR_LOG: log, GEMINI_CLI_SYSTEM_SETTINGS_PATH: file };
    await turn(join(scratch, "side-settings-agent"), "say:agent", { env: { ...env, FAKE_CURSOR_LOG: join(scratch, "agent-settings.jsonl") } });
    await turn(join(scratch, "side-settings-agent"), "say:side", { env, executionMode: "side-question" });
    const created = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.method === "session/new");
    expect(created.params.mcpServers).toEqual([]);
    const agentRequests = readFileSync(join(scratch, "agent-settings.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(agentRequests.find((entry) => entry.method === "session/new").params.mcpServers).toHaveLength(1);
  });

  it("still refuses an unenforceable native selection for a side question", async () => {
    await expect(
      backend.prepareExecution!({
        agentDir: join(scratch, "refuse-agent"),
        executionMode: "side-question",
        toolAvailability: { native: [], openClaw: [] },
      } as never),
    ).rejects.toThrow(/keeps native read, grep, glob on/);
  });
});
