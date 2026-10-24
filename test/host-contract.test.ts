import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import { buildCliBackend } from "../src/core/backend.ts";
import { liveEntries } from "../src/core/live-entry.ts";
import { readTurnTarget, splitMcpArgs } from "../src/core/mcp-target.ts";
import { ProcessPool } from "../src/core/pool.ts";
import type { LiveSessionCapability } from "../src/core/sdk-types.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";
import { hostAvailable, hostExport, hostFunction } from "./fixtures/host-code.ts";
import { startStubMcpHost } from "./fixtures/stub-mcp-host.ts";

/**
 * The host contracts the backend shape relies on, checked against OpenClaw's own code (2026.10.3, from
 * `.spike/`; sweep F5, D13, D21). Each host function is found by name (see `fixtures/host-code.ts`) and run
 * unchanged against this plugin's real backend and real `execute`, with the fake `cursor-agent` as the
 * CLI. The tests are the recheck the MEMORY open risks ask for when the host changes. They need no
 * Cursor login and skip when the host's `dist` is missing.
 */
type Json = Record<string, any>;

describe.skipIf(!hostAvailable)("OpenClaw host contracts the backend relies on", () => {
  // Created in beforeAll: a skipped describe still runs its body, and nothing would remove the dir.
  let scratch = "";
  // The backend the host resolves (the registry keeps it), and the backend each turn test executes with.
  const backend = buildCliBackend(cursorAdapter, { settings: { command: FAKE_CURSOR_AGENT } });
  /** A backend of its own pool, so a test's `closeAll` (which is final for a pool) leaves the others alone. */
  function newBackend() {
    const pool = new ProcessPool({ maxTurns: Infinity, maxProcesses: Infinity });
    cleanups.push(() => pool.closeAll());
    return { pool, backend: buildCliBackend(cursorAdapter, { settings: { command: FAKE_CURSOR_AGENT }, pool }) };
  }

  let host: {
    resolveCliBackendConfig: (provider: string, cfg?: Json) => Json | null;
    createMcpLoopbackServerConfig: (port: number) => Json;
    prepareCliBundleMcpConfig: (params: Json) => Promise<{ backend: Json; env: Record<string, string>; mcpConfigHash: string; cleanup?: () => Promise<void> }>;
    prepareCliBundleMcpCaptureAttempt: (params: Json) => Promise<{ env: Record<string, string>; cleanup?: () => Promise<void> }>;
    createCliLiveSessionCapability: (params: Json) => LiveSessionCapability;
    acceptsCliLiveSession: (context: Json) => boolean;
    createCliRunCurrentAssertion: (params: Json, signal?: AbortSignal) => () => void;
    prepareSystemAgentRunAdmission: (cfg: Json, runId: string, agentId: string, boundary: string, assertSourceCurrent: () => void) => {
      admit(kind: string): Promise<unknown>;
      close(): void;
    };
    resolveCliMcpToolOwnership: (run: Json, options: Json) => { hostOwnedTools?: string[] };
    prepareModelRunCapabilities: (catalogs: [Json[] | undefined, Json[]], run: [string, string, string]) => { modelHasVision: boolean };
  };
  let registered: { backend: unknown; pluginId: string } | undefined;
  let registry: { cliBackends: unknown[] };
  let resolved: Json;

  const cleanups: Array<() => Promise<void> | void> = [];

  /** The fake CLI's clean env; its fresh Cursor config dir is removed with the test. */
  function fakeCliEnv(extra: Record<string, string> = {}): Record<string, string> {
    const env = fakeEnv(extra);
    cleanups.push(() => rmSync(env.CURSOR_CONFIG_DIR!, { recursive: true, force: true }));
    return env;
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "oac-host-contract-"));
    const requireActivePluginRegistry = await hostExport<() => { cliBackends: unknown[] }>("requireActivePluginRegistry");
    host = {
      resolveCliBackendConfig: await hostExport("resolveCliBackendConfig"),
      createMcpLoopbackServerConfig: await hostExport("createMcpLoopbackServerConfig"),
      prepareCliBundleMcpConfig: await hostExport("prepareCliBundleMcpConfig"),
      prepareCliBundleMcpCaptureAttempt: await hostExport("prepareCliBundleMcpCaptureAttempt"),
      createCliLiveSessionCapability: await hostExport("createCliLiveSessionCapability"),
      acceptsCliLiveSession: await hostExport("acceptsCliLiveSession"),
      createCliRunCurrentAssertion: await hostExport("createCliRunCurrentAssertion"),
      prepareSystemAgentRunAdmission: await hostExport("prepareSystemAgentRunAdmission"),
      // Private to the host's chunk: its own body, run against the chunk's own imports.
      resolveCliMcpToolOwnership: await hostFunction("resolveCliMcpToolOwnership"),
      prepareModelRunCapabilities: await hostExport("prepareModelRunCapabilities"),
    };
    // The host finds a CLI backend in the active plugin registry; register the real one, like the plugin's load does.
    registry = requireActivePluginRegistry();
    registered = { backend, pluginId: "openclaw-all-cli" };
    registry.cliBackends.push(registered);
    resolved = host.resolveCliBackendConfig("cursor-cli", {})!;
  }, 60_000);

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  afterAll(() => {
    if (registered && registry) registry.cliBackends.splice(registry.cliBackends.indexOf(registered), 1);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("the host resolves the real backend with the shape the contracts below depend on", () => {
    expect(resolved).toBeTruthy();
    expect(resolved).toMatchObject({
      id: "cursor-cli",
      pluginId: "openclaw-all-cli",
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "execution-args",
    });
    expect(typeof resolved.resolveExecutionArgs).toBe("function");
    expect(resolved.config).toMatchObject({ liveSession: "claude-stdio", output: "jsonl", input: "stdin", sessionMode: "existing" });
  });

  describe("host-served exec and process (P8, AD-9)", () => {
    const run = (extra: Json = {}) => ({ config: {}, agentId: "main", sessionKey: "agent:main:explicit:oac-host-contract", ...extra });
    const ownership = (runExtra: Json = {}, optionsExtra: Json = {}) =>
      host.resolveCliMcpToolOwnership(run(runExtra), { backend: resolved, enabled: true, rooted: false, nodePlacement: false, skipPreparation: false, ...optionsExtra }).hostOwnedTools;

    it("serves exec and process for the real backend with default config and MCP on", () => {
      expect(ownership()).toEqual(["exec", "process"]);
    });

    it("withholds them when the exec host is node, the run is rooted, the run has a tool selection, or MCP is off", () => {
      expect(ownership({ config: { tools: { exec: { host: "node" } } } })).toBeUndefined();
      expect(ownership({}, { rooted: true })).toBeUndefined();
      expect(ownership({ cliToolAvailability: { native: [], openClaw: [] } })).toBeUndefined();
      expect(ownership({}, { enabled: false })).toBeUndefined();
    });

    it("withholds them from a backend that does not declare them (the guard is the backend's `hostOwnedTools`)", () => {
      const { hostOwnedTools: _declared, ...withoutOwned } = resolved;
      expect(ownership({}, { backend: withoutOwned })).toBeUndefined();
    });
  });

  describe("the MCP config file the host writes (P7, AD-12)", () => {
    const token = () => randomBytes(32).toString("hex");

    /** What the host does for a run: prepare the bundle MCP config, then the attempt's capture settings. */
    async function hostConfig(port: number, variant: "additionalConfig" | "exclusiveConfig", bearer: string) {
      const prepared = await host.prepareCliBundleMcpConfig({
        enabled: true,
        mode: resolved.bundleMcpMode,
        backend: resolved.config,
        workspaceDir: scratch,
        config: {},
        agentDir: scratch,
        [variant]: host.createMcpLoopbackServerConfig(port),
        env: { OPENCLAW_MCP_TOKEN: bearer, OPENCLAW_MCP_CLI_CAPTURE_KEY: "" },
        warn: () => {},
      });
      cleanups.push(() => prepared.cleanup?.());
      return {
        prepared,
        attempt: async (captureKey: string) => {
          const attempt = await host.prepareCliBundleMcpCaptureAttempt({ mode: resolved.bundleMcpMode, backend: prepared.backend, env: prepared.env, captureKey });
          cleanups.push(() => attempt.cleanup?.());
          return attempt;
        },
      };
    }

    for (const variant of ["additionalConfig", "exclusiveConfig"] as const) {
      it(`reads as the loopback URL, bearer token, and capture key, from the --mcp-config file in the launch args (${variant})`, async () => {
        const bearer = token();
        const config = await hostConfig(48_231, variant, bearer);
        const key1 = randomUUID();
        const key2 = randomUUID();
        const launch = splitMcpArgs(config.prepared.backend.args);
        // The CLI must never see the host's flags: only `acp` is left.
        expect(launch.args).toEqual(["acp"]);
        expect(launch.mcpConfigPath).toBeTruthy();

        // The capture attempt rewrites the same file in place with its key.
        for (const key of [key1, key2]) {
          await config.attempt(key);
          expect(await readTurnTarget(launch.mcpConfigPath)).toEqual({
            ok: true,
            target: { url: "http://127.0.0.1:48231/mcp", headers: { Authorization: `Bearer ${bearer}`, "x-openclaw-cli-capture-key": key } },
          });
        }
      });
    }

    it("writes a new file per run, and puts no settings path into the env", async () => {
      const first = await hostConfig(48_233, "additionalConfig", token());
      const second = await hostConfig(48_233, "additionalConfig", token());
      const paths = [first, second].map((config) => splitMcpArgs(config.prepared.backend.args).mcpConfigPath);
      expect(new Set(paths).size).toBe(2);
      expect(Object.keys((await first.attempt(randomUUID())).env)).not.toContain("GEMINI_CLI_SYSTEM_SETTINGS_PATH");
    });

    it("reaches the stub host's tools call through a plugin turn: the host-written Authorization and capture key arrive", async () => {
      const stub = await startStubMcpHost();
      cleanups.push(() => stub.close());
      const bearer = token();
      const captureKey = randomUUID();
      const config = await hostConfig(Number(new URL(stub.url).port), "additionalConfig", bearer);
      const attempt = await config.attempt(captureKey);

      const prepared = await newBackend().backend.prepareExecution!({ agentDir: join(scratch, "agent-e2e") } as never);
      const records: Json[] = [];
      for await (const record of prepared!.execute!({
        command: resolved.config.command,
        args: [...config.prepared.backend.args],
        cwd: scratch,
        env: { ...fakeCliEnv(), ...attempt.env },
        prompt: `[[mcp-call]]${JSON.stringify({ tool: "oac_echo", arguments: { text: "hi" } })}`,
        modelId: "auto",
        systemPrompt: "",
        useResume: false,
        timeoutMs: 20_000,
        requestToolPermission: (async () => ({ behavior: "deny", message: "no" })) as never,
        requestUserInput: async () => ({ status: "cancelled", message: "no" }),
      } as never)) {
        records.push(record as Json);
      }
      const result = records.find((record) => record.type === "result");
      expect(result?.event?.text).toBe("echo:hi");
      const calls = stub.toolCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.headers.authorization).toBe(`Bearer ${bearer}`);
      expect(calls[0]!.headers["x-openclaw-cli-capture-key"]).toBe(captureKey);
    });
  });

  describe("the model capability a turn reads before the plugin's catalog has loaded (backlog bug 8)", () => {
    const auto = { id: "auto", name: "Auto", provider: "cursor-cli", api: "openai-completions", baseUrl: "cli://local", input: ["text", "image"], reasoning: false };
    const other = { id: "gpt", name: "GPT", provider: "openai", api: "openai-responses", input: ["text", "image"], reasoning: true };
    const vision = (catalog: Json[] | undefined) => host.prepareModelRunCapabilities([catalog, []], ["cursor-cli", "auto", "openclaw"]).modelHasVision;

    it("says a model has no vision when its row is missing from the catalog the run was given, and vision once the row is there", () => {
      const failure =
        "OpenClaw no longer derives `modelHasVision` from the catalog row's `input` alone. Backlog bug 8: a turn that starts before the Gateway has loaded " +
        "the plugin's rows gets no `computer` and `view_image` tools, and the next turn gets them, which restarts cursor-agent once. If the host fixed that, " +
        "the upstream issue in the plan is done: drop the note in docs/providers/cursor.md.";
      expect(vision([other]), failure).toBe(false);
      expect(vision(undefined), failure).toBe(false);
      expect(vision([other, auto]), failure).toBe(true);
      expect(vision([other, { ...auto, input: ["text"] }]), failure).toBe(false);
    });
  });

  describe("the live-session capability (P4, AD-12, AD-13)", () => {
    const sessionKey = (label: string) => `agent:main:explicit:oac-host-contract-${label}-${randomUUID().slice(0, 8)}`;

    /** One run's inputs, as the host prepares them: launch args with the MCP flags, env, and the run's grant. */
    type RunInput = { args: string[]; env: Record<string, string>; bearer: string; captureKey: string; mcpConfigHash: string };

    /** The inputs of `count` runs of one session: the host writes a new config file, bearer, and capture key per run. */
    async function runInputs(base: Record<string, string>, port: number, count: number): Promise<RunInput[]> {
      const inputs: RunInput[] = [];
      for (let n = 0; n < count; n += 1) {
        const bearer = randomBytes(32).toString("hex");
        const prepared = await host.prepareCliBundleMcpConfig({
          enabled: true,
          mode: resolved.bundleMcpMode,
          backend: resolved.config,
          workspaceDir: scratch,
          config: {},
          agentDir: scratch,
          additionalConfig: host.createMcpLoopbackServerConfig(port),
          env: { OPENCLAW_MCP_TOKEN: bearer, OPENCLAW_MCP_CLI_CAPTURE_KEY: "" },
          warn: () => {},
        });
        cleanups.push(() => prepared.cleanup?.());
        const captureKey = randomUUID();
        const attempt = await host.prepareCliBundleMcpCaptureAttempt({ mode: resolved.bundleMcpMode, backend: prepared.backend, env: prepared.env, captureKey });
        cleanups.push(() => attempt.cleanup?.());
        inputs.push({ args: [...prepared.backend.args], env: { ...base, ...attempt.env }, bearer, captureKey, mcpConfigHash: prepared.mcpConfigHash });
      }
      return inputs;
    }

    /** What the host's grant does with each live-session `activate`: the process's bearer and capture key win. */
    type GrantLog = { adopted: string[]; captured: string[] };

    /** The host's real capability for one run, built the way the host's runner builds it. */
    async function capabilityFor(
      label: { sessionKey: string },
      input: RunInput,
      options: { model?: string; controller?: AbortController; systemPrompt?: string; promptToolNamesHash?: string } = {},
    ) {
      const controller = options.controller ?? new AbortController();
      const runId = randomUUID();
      const admission = host.prepareSystemAgentRunAdmission({}, runId, "main", "test", () => {});
      const admittedRunContext = await admission.admit("cli");
      cleanups.push(() => admission.close());
      const params = { provider: "cursor-cli", agentId: "main", sessionId: "oac-host-contract", sessionKey: label.sessionKey, admittedRunContext, abortSignal: controller.signal };
      const grants: GrantLog = { adopted: [], captured: [] };
      const context = {
        params,
        backendResolved: { id: "cursor-cli" },
        preparedBackend: {
          backend: { ...resolved.config, args: input.args },
          mcpConfigHash: input.mcpConfigHash,
          mcpClientGrantCapture: {
            transportToken: input.bearer,
            adoptProcessToken: (processToken: string) => grants.adopted.push(processToken),
            revokeProcessToken: () => {},
            activate: () => {},
            deactivate: () => {},
          },
        },
        workspaceDir: scratch,
        cwd: scratch,
        normalizedModel: options.model ?? "auto",
        modelId: "auto",
        systemPrompt: options.systemPrompt ?? "",
        ...(options.promptToolNamesHash ? { promptToolNamesHash: options.promptToolNamesHash } : {}),
        executionTarget: { kind: "plugin" },
      };
      const capability = host.createCliLiveSessionCapability({
        context,
        argv: [resolved.config.command as string, ...input.args],
        argv0: undefined,
        env: input.env,
        captureKey: input.captureKey,
        beginCapture: (key: string) => grants.captured.push(key),
        abortSignal: controller.signal,
      });
      return { capability, context, grants, assertCurrent: host.createCliRunCurrentAssertion(params, controller.signal), signal: controller.signal };
    }

    it("accepts the real backend as a plugin-owned live session", () => {
      expect(host.acceptsCliLiveSession({ executionTarget: { kind: "plugin" }, preparedBackend: { backend: resolved.config } })).toBe(true);
      // The conditions are the backend's: no `liveSession` flag, no acceptance.
      const { liveSession: _off, ...withoutLive } = resolved.config;
      expect(host.acceptsCliLiveSession({ executionTarget: { kind: "plugin" }, preparedBackend: { backend: withoutLive } })).toBe(false);
    });

    it("fingerprints runs of one session equally although each has a new config file, bearer token, and capture key", async () => {
      const base = fakeCliEnv();
      const key = sessionKey("fp");
      const [runA, runB] = (await runInputs(base, 48_232, 2)) as [RunInput, RunInput];
      const failure =
        "OpenClaw's live-session fingerprint now follows something that changes every run (the --mcp-config file path, the bearer token, " +
        "or the capture key), so cursor-cli restarts the process every turn again (backlog bug 6, P4). If the host changed on purpose, " +
        "recheck the MEMORY.md notes on the warm-process target before changing the backend's `bundleMcpMode`.";
      const fingerprint = async (input: RunInput, model?: string) => (await capabilityFor({ sessionKey: key }, input, { model: model ?? "auto" })).capability.fingerprint;
      // The runs differ in these, and only in these.
      expect(splitMcpArgs(runA.args).mcpConfigPath).not.toBe(splitMcpArgs(runB.args).mcpConfigPath);
      expect(runA.bearer).not.toBe(runB.bearer);
      expect(runA.captureKey).not.toBe(runB.captureKey);
      const a1 = await fingerprint(runA);
      expect(await fingerprint(runA), "equal input, equal fingerprint").toBe(a1);
      expect(await fingerprint(runB), failure).toBe(a1);
      // Sanity: the fingerprint still follows what should restart a process.
      expect(await fingerprint(runB, "another-model")).not.toBe(a1);
    });

    it("fingerprints the system prompt text and the prompt tool names, so a changed tool list restarts the process (backlog bug 8)", async () => {
      const [run] = (await runInputs(fakeCliEnv(), 48_234, 1)) as [RunInput];
      const key = { sessionKey: sessionKey("fp-prompt") };
      const failure =
        "OpenClaw's live-session fingerprint no longer follows the system prompt text or the prompt tool names. Backlog bug 8 " +
        "(turn 2 of a fresh agent restarted the process) was that: recheck its plan and the upstream issue text before relying on this.";
      const fingerprint = async (options: { systemPrompt?: string; promptToolNamesHash?: string }) => (await capabilityFor(key, run, options)).capability.fingerprint;
      const tools = { 1: "hash-of-50-tool-names", 2: "hash-of-52-tool-names" };
      const prompt = "Tooling\n- exec\n- view_image\n- computer\n";
      const base = await fingerprint({ systemPrompt: prompt, promptToolNamesHash: tools[1] });
      expect(await fingerprint({ systemPrompt: prompt, promptToolNamesHash: tools[1] }), "equal input, equal fingerprint").toBe(base);
      // What turn 1 and turn 2 of a fresh agent differed in on OpenClaw 2026.10.3: two tools (and their lines in the prompt).
      expect(await fingerprint({ systemPrompt: prompt, promptToolNamesHash: tools[2] }), failure).not.toBe(base);
      expect(await fingerprint({ systemPrompt: `${prompt}- extra\n`, promptToolNamesHash: tools[1] }), failure).not.toBe(base);
    });

    it("reuses the process on a later turn (no initialize, no session/load) and restarts only when the host's fingerprint changes", async () => {
      const log = join(scratch, `live-session-${randomUUID().slice(0, 8)}.log`);
      const base = fakeCliEnv({ FAKE_CURSOR_LOG: log });
      const stub = await startStubMcpHost();
      cleanups.push(() => stub.close());
      const port = Number(new URL(stub.url).port);
      const key = { sessionKey: sessionKey("live") };
      const { pool, backend: live } = newBackend();
      const prepared = await live.prepareExecution!({ agentDir: join(scratch, `agent-live-${randomUUID().slice(0, 8)}`) } as never);

      const logLines = (): Json[] =>
        (() => {
          try {
            return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Json);
          } catch {
            return [];
          }
        })();
      const methods = (lines: Json[]) => lines.map((line) => line.method).filter((method) => typeof method === "string");

      /** One plugin turn with the host's capability for `input`. */
      async function turn(input: RunInput, resume: { useResume: boolean; sessionId?: string }, prompt: string, model?: string) {
        const { capability, assertCurrent, signal, grants } = await capabilityFor(key, input, model ? { model } : {});
        const records: Json[] = [];
        for await (const record of prepared!.execute!({
          command: resolved.config.command,
          args: [...input.args],
          cwd: scratch,
          env: input.env,
          prompt,
          modelId: "auto",
          systemPrompt: "",
          useResume: resume.useResume,
          ...(resume.sessionId ? { sessionId: resume.sessionId } : {}),
          timeoutMs: 20_000,
          abortSignal: signal,
          assertCurrent,
          liveSession: capability,
          requestToolPermission: (async () => ({ behavior: "deny", message: "no" })) as never,
          requestUserInput: async () => ({ status: "cancelled", message: "no" }),
        } as never)) {
          records.push(record as Json);
        }
        const result = records.find((record) => record.type === "result");
        expect(result?.event?.text, JSON.stringify(records)).toBeTypeOf("string");
        return { capability, grants, text: result!.event.text as string, sessionId: result!.sessionId as string };
      }

      const [runA, runB, runC] = (await runInputs(base, port, 3)) as [RunInput, RunInput, RunInput];

      // Turn 1: a new chat in a new process.
      const first = await turn(runA, { useResume: false }, "say:one");
      expect(first.text).toBe("one");
      expect(first.sessionId).toBeTruthy();
      const firstHandle = first.capability.current();
      expect(firstHandle, "the plugin registered its handle with the host").toBeDefined();
      expect(liveEntries.get(firstHandle!), "the host's handle is the plugin's own").toBeDefined();
      expect(firstHandle!.fingerprint).toBe(first.capability.fingerprint);
      expect(first.grants.captured).toEqual([runA.captureKey]);

      // Turn 2: the host wrote a new config file, bearer, and capture key. Same fingerprint, so the
      // same process: only a prompt reaches it, and the host moved this run's grant onto turn 1's bearer.
      const mark = logLines().length;
      const second = await turn(runB, { useResume: true, sessionId: first.sessionId }, `[[mcp-call]]${JSON.stringify({ tool: "oac_echo", arguments: { text: "warm" } })}`);
      expect(second.text).toBe("echo:warm");
      expect(second.capability.fingerprint).toBe(first.capability.fingerprint);
      expect(second.capability.current(), "the same handle serves the second turn").toBe(firstHandle);
      expect(methods(logLines().slice(mark))).toEqual(["session/prompt"]);
      expect(second.grants.adopted).toEqual([runA.bearer]);
      expect(second.grants.captured).toEqual([runA.captureKey]);
      // The tool call carries the credentials the host accepts for this process: turn 1's, not turn 2's file.
      const calls = stub.toolCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.headers.authorization).toBe(`Bearer ${runA.bearer}`);
      expect(calls[0]!.headers["x-openclaw-cli-capture-key"]).toBe(runA.captureKey);

      // Turn 3: the host's fingerprint changes (another model). New process, the chat resumed by ID.
      const third = await turn(runC, { useResume: true, sessionId: second.sessionId }, "say:three", "another-model");
      expect(third.text).toBe("three");
      expect(third.capability.fingerprint).not.toBe(first.capability.fingerprint);
      expect(third.capability.current()).not.toBe(firstHandle);
      const lifecycle = methods(logLines()).filter((method) => ["initialize", "session/new", "session/load"].includes(method));
      expect(lifecycle).toEqual(["initialize", "session/new", "initialize", "session/load"]);
      const load = logLines().find((line) => line.method === "session/load");
      expect(load?.params?.sessionId).toBe(first.sessionId);
      expect(new Set(logLines().filter((line) => line.method === "initialize").map((line) => line.pid)).size).toBe(2);

      // Closing the process releases the host's record: the handle is no longer current.
      await pool.closeAll();
      const { capability: later } = await capabilityFor(key, runC, { model: "another-model" });
      expect(later.current()).toBeUndefined();
    }, 60_000);
  });
});
