import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import { buildCliBackend } from "../src/core/backend.ts";
import { liveEntries } from "../src/core/live-entry.ts";
import { readTurnTarget } from "../src/core/mcp-target.ts";
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
  const scratch = mkdtempSync(join(tmpdir(), "oac-host-contract-"));
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
    prepareCliBundleMcpConfig: (params: Json) => Promise<{ backend: Json; env: Record<string, string>; cleanup?: () => Promise<void> }>;
    prepareCliBundleMcpCaptureAttempt: (params: Json) => Promise<{ env: Record<string, string>; cleanup?: () => Promise<void> }>;
    createCliLiveSessionCapability: (params: Json) => LiveSessionCapability;
    acceptsCliLiveSession: (context: Json) => boolean;
    createCliRunCurrentAssertion: (params: Json, signal?: AbortSignal) => () => void;
    prepareSystemAgentRunAdmission: (cfg: Json, runId: string, agentId: string, boundary: string, assertSourceCurrent: () => void) => {
      admit(kind: string): Promise<unknown>;
      close(): void;
    };
    resolveCliMcpToolOwnership: (run: Json, options: Json) => { hostOwnedTools?: string[] };
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
    rmSync(scratch, { recursive: true, force: true });
  });

  it("the host resolves the real backend with the shape the contracts below depend on", () => {
    expect(resolved).toBeTruthy();
    expect(resolved).toMatchObject({
      id: "cursor-cli",
      pluginId: "openclaw-all-cli",
      bundleMcp: true,
      bundleMcpMode: "gemini-system-settings",
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

  describe("the settings file the host writes (P7, AD-12)", () => {
    const token = () => randomBytes(32).toString("hex");

    /** What the host does for a run: prepare the bundle MCP config, then the attempt's capture settings. */
    async function hostSettings(port: number, variant: "additionalConfig" | "exclusiveConfig", bearer: string) {
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
          const attempt = await host.prepareCliBundleMcpCaptureAttempt({ mode: resolved.bundleMcpMode, backend: resolved.config, env: prepared.env, captureKey });
          cleanups.push(() => attempt.cleanup?.());
          return attempt;
        },
      };
    }

    for (const variant of ["additionalConfig", "exclusiveConfig"] as const) {
      it(`reads as the loopback URL, bearer token, and capture key (${variant})`, async () => {
        const bearer = token();
        const settings = await hostSettings(48_231, variant, bearer);
        const key1 = randomUUID();
        const key2 = randomUUID();
        const first = await settings.attempt(key1);
        const second = await settings.attempt(key2);

        for (const [attempt, key] of [[first, key1], [second, key2]] as const) {
          const target = await readTurnTarget(attempt.env);
          expect(target).toEqual({
            ok: true,
            target: { url: "http://127.0.0.1:48231/mcp", headers: { Authorization: `Bearer ${bearer}`, "x-openclaw-cli-capture-key": key } },
          });
        }
        // A new file per attempt, and not the prepared one: this is why the host's fingerprint moves every turn.
        const paths = [settings.prepared.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, first.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, second.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH];
        expect(new Set(paths).size).toBe(3);
        expect(paths.every((path) => typeof path === "string" && path.length > 0)).toBe(true);
      });
    }

    it("reaches the stub host's tools call through a plugin turn: the host-written Authorization and capture key arrive", async () => {
      const stub = await startStubMcpHost();
      cleanups.push(() => stub.close());
      const bearer = token();
      const captureKey = randomUUID();
      const settings = await hostSettings(Number(new URL(stub.url).port), "additionalConfig", bearer);
      const attempt = await settings.attempt(captureKey);

      const prepared = await newBackend().backend.prepareExecution!({ agentDir: join(scratch, "agent-e2e") } as never);
      const records: Json[] = [];
      for await (const record of prepared!.execute!({
        command: resolved.config.command,
        args: [...resolved.config.args],
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

  describe("the live-session capability (P4, AD-12, AD-13)", () => {
    const sessionKey = (label: string) => `agent:main:explicit:oac-host-contract-${label}-${randomUUID().slice(0, 8)}`;
    const argv = () => [resolved.config.command as string, ...(resolved.config.args as string[])];

    /** The host's real capability for one turn, built the way the host's runner builds it. */
    async function capabilityFor(label: { sessionKey: string }, env: Record<string, string>, controller = new AbortController()) {
      const runId = randomUUID();
      const admission = host.prepareSystemAgentRunAdmission({}, runId, "main", "test", () => {});
      const admittedRunContext = await admission.admit("cli");
      cleanups.push(() => admission.close());
      const params = { provider: "cursor-cli", agentId: "main", sessionId: "oac-host-contract", sessionKey: label.sessionKey, admittedRunContext, abortSignal: controller.signal };
      const context = {
        params,
        backendResolved: { id: "cursor-cli" },
        preparedBackend: { backend: resolved.config, mcpConfigHash: "oac-host-contract" },
        workspaceDir: scratch,
        cwd: scratch,
        normalizedModel: "auto",
        modelId: "auto",
        systemPrompt: "",
        executionTarget: { kind: "plugin" },
      };
      const capability = host.createCliLiveSessionCapability({
        context,
        argv: argv(),
        argv0: undefined,
        env,
        beginCapture: () => {},
        abortSignal: controller.signal,
      });
      return { capability, context, assertCurrent: host.createCliRunCurrentAssertion(params, controller.signal), signal: controller.signal };
    }

    /** The env of `count` turns of one run's settings: the host writes a new settings file per attempt and nothing else differs. */
    async function attemptEnvs(base: Record<string, string>, port: number, count: number): Promise<Array<Record<string, string>>> {
      const prepared = await host.prepareCliBundleMcpConfig({
        enabled: true,
        mode: resolved.bundleMcpMode,
        backend: resolved.config,
        workspaceDir: scratch,
        config: {},
        agentDir: scratch,
        additionalConfig: host.createMcpLoopbackServerConfig(port),
        env: { OPENCLAW_MCP_TOKEN: randomBytes(32).toString("hex"), OPENCLAW_MCP_CLI_CAPTURE_KEY: "" },
        warn: () => {},
      });
      cleanups.push(() => prepared.cleanup?.());
      const envs: Array<Record<string, string>> = [];
      for (let n = 0; n < count; n += 1) {
        const attempt = await host.prepareCliBundleMcpCaptureAttempt({ mode: resolved.bundleMcpMode, backend: resolved.config, env: prepared.env, captureKey: randomUUID() });
        cleanups.push(() => attempt.cleanup?.());
        envs.push({ ...base, ...attempt.env });
      }
      return envs;
    }

    it("accepts the real backend as a plugin-owned live session", () => {
      expect(host.acceptsCliLiveSession({ executionTarget: { kind: "plugin" }, preparedBackend: { backend: resolved.config } })).toBe(true);
      // The conditions are the backend's: no `liveSession` flag, no acceptance.
      const { liveSession: _off, ...withoutLive } = resolved.config;
      expect(host.acceptsCliLiveSession({ executionTarget: { kind: "plugin" }, preparedBackend: { backend: withoutLive } })).toBe(false);
    });

    it("fingerprints a turn by its settings path, not by the capture key", async () => {
      const base = fakeCliEnv();
      const key = sessionKey("fp");
      const [envA, envB] = (await attemptEnvs(base, 48_232, 2)) as [Record<string, string>, Record<string, string>];
      const fingerprint = async (env: Record<string, string>) => (await capabilityFor({ sessionKey: key }, env)).capability.fingerprint;
      const failure =
        "OpenClaw's live-session fingerprint no longer follows GEMINI_CLI_SYSTEM_SETTINGS_PATH (or now follows the capture key). " +
        "Recheck the MEMORY.md open risks before lifting the per-turn restart: adoptProcessToken moves a later turn's grant onto the first " +
        "turn's bearer and capture key (the later file's credentials get 401); a degraded mark from one turn's settings; the proxy's SSE " +
        "stream cut between turns; Mcp-Session-Id kept while the target changes.";
      const a1 = await fingerprint(envA);
      expect(await fingerprint(envA), "equal env, equal fingerprint").toBe(a1);
      expect(await fingerprint(envB), failure).not.toBe(a1);
      // Only the settings path differs between these two.
      expect({ ...envB, GEMINI_CLI_SYSTEM_SETTINGS_PATH: envA.GEMINI_CLI_SYSTEM_SETTINGS_PATH }).toEqual(envA);
      expect(await fingerprint({ ...envA, OPENCLAW_MCP_CLI_CAPTURE_KEY: "other-capture-key" }), "the capture key is ignored").toBe(a1);
    });

    it("restarts and resumes on a new settings path, and reuses the process on the same one", async () => {
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

      /** One plugin turn with the host's capability for `env`. */
      async function turn(env: Record<string, string>, resume: { useResume: boolean; sessionId?: string }, prompt: string) {
        const { capability, assertCurrent, signal } = await capabilityFor(key, env);
        const records: Json[] = [];
        for await (const record of prepared!.execute!({
          command: resolved.config.command,
          args: [...resolved.config.args],
          cwd: scratch,
          env,
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
        return { capability, text: result!.event.text as string, sessionId: result!.sessionId as string };
      }

      const [envA, envB] = (await attemptEnvs(base, port, 2)) as [Record<string, string>, Record<string, string>];

      // Turn 1: a new chat in a new process.
      const first = await turn(envA, { useResume: false }, "say:one");
      expect(first.text).toBe("one");
      expect(first.sessionId).toBeTruthy();
      const firstHandle = first.capability.current();
      expect(firstHandle, "the plugin registered its handle with the host").toBeDefined();
      expect(liveEntries.get(firstHandle!), "the host's handle is the plugin's own").toBeDefined();
      expect(firstHandle!.fingerprint).toBe(first.capability.fingerprint);

      // Turn 2: another settings path (as the host writes per turn). New process, the chat resumed by ID.
      const second = await turn(envB, { useResume: true, sessionId: first.sessionId }, "say:two");
      expect(second.text).toBe("two");
      expect(second.capability.fingerprint).not.toBe(first.capability.fingerprint);
      const secondHandle = second.capability.current();
      expect(secondHandle).toBeDefined();
      expect(secondHandle).not.toBe(firstHandle);
      const afterSecond = logLines();
      const lifecycle = methods(afterSecond).filter((method) => ["initialize", "session/new", "session/load"].includes(method));
      expect(lifecycle).toEqual(["initialize", "session/new", "initialize", "session/load"]);
      const load = afterSecond.find((line) => line.method === "session/load");
      expect(load?.params?.sessionId).toBe(first.sessionId);
      expect(new Set(afterSecond.filter((line) => line.method === "initialize").map((line) => line.pid)).size).toBe(2);

      // Turn 3: the same settings path (same fingerprint). One process; only a prompt reaches it.
      const mark = logLines().length;
      const third = await turn(envB, { useResume: true, sessionId: second.sessionId }, "say:three");
      expect(third.text).toBe("three");
      expect(third.capability.fingerprint).toBe(second.capability.fingerprint);
      expect(third.capability.current(), "the same handle serves the second and third turn").toBe(secondHandle);
      expect(methods(logLines().slice(mark))).toEqual(["session/prompt"]);

      // Closing the process releases the host's record: the handle is no longer current.
      await pool.closeAll();
      const { capability: later } = await capabilityFor(key, envB);
      expect(later.current()).toBeUndefined();
    }, 60_000);
  });
});
