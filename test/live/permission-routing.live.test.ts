import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { cursorAdapter } from "../../src/adapters/cursor/index.ts";
import { HOST_SHELL_ARG, createExecute } from "../../src/core/execute.ts";
import type { CliAdapter, CliSession, NormalizedEvent, PermissionDecision } from "../../src/core/ports.ts";
import type { ExecuteContext } from "../../src/core/sdk-types.ts";
import { STUB_EXEC_TOOL, startStubMcpHost } from "../fixtures/stub-mcp-host.ts";
import {
  LIVE_TIMEOUT_MS,
  describeLive,
  freshDir,
  liveHostEnv,
  makeLiveSession,
  openclaw,
  replyLines,
  hostMcpArgs,
  writeSettingsFile,
} from "./harness.ts";

// Parity rows P8, P9, P10 (permission routing, tool availability, abort; AD-9, AD-11). Real
// cursor-agent with a stub host. The production home denies Shell, so Cursor never asks about
// it: the fallback test uses that home; the approval and abort tests use a home that leaves shell
// to ask, the case permission routing exists for (a request the static file leaves open).
describeLive("permission requests go to the host (P8, P9)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-live-perm-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A home like the production one, except that shell is neither allowed nor denied. */
  function askingHome(name: string) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "cli-config.json"),
      JSON.stringify({
        permissions: { allow: ["Read(**)", "Mcp(openclaw:*)"], deny: ["Write(**)", "WebFetch(*)"] },
      }),
    );
    return { dir, env: { CURSOR_CONFIG_DIR: dir, CURSOR_DATA_DIR: join(dir, "data") } };
  }

  /** Records the decisions the core gave the CLI, the sessions it opened, and whether each opened with the host's shell. */
  function observed() {
    const decisions: Array<{ tool: string; decision: PermissionDecision }> = [];
    const sessions: CliSession[] = [];
    const hostShell: boolean[] = [];
    const adapter: CliAdapter = {
      ...cursorAdapter,
      open: async (params) => {
        const session = await cursorAdapter.open({
          ...params,
          onPermissionRequest: async (request) => {
            const decision = await params.onPermissionRequest(request);
            decisions.push({ tool: request.toolName ?? "", decision });
            return decision;
          },
        });
        sessions.push(session);
        hostShell.push(params.hostShell === true);
        return session;
      },
    };
    return { adapter, decisions, sessions, hostShell };
  }

  /** `hostShell`: the marker the backend adds when OpenClaw serves its own `exec` for the run (`HOST_SHELL_ARG`). */
  function turnContext(name: string, host: { url: string }, workspace: string, overrides: Partial<ExecuteContext>, hostShell = false): ExecuteContext {
    const settings = writeSettingsFile(root, `settings-${name}`, host.url, `token-${name}`, `capture-${name}`);
    return {
      command: process.env.CURSOR_AGENT_BIN ?? cursorAdapter.command,
      args: [...cursorAdapter.launchArgs, ...hostMcpArgs(settings), ...(hostShell ? [HOST_SHELL_ARG] : [])],
      cwd: workspace,
      env: liveHostEnv(),
      prompt: "",
      modelId: "auto",
      systemPrompt: "",
      useResume: false,
      timeoutMs: LIVE_TIMEOUT_MS,
      liveSession: makeLiveSession(),
      requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
      requestUserInput: async () => ({ status: "cancelled", message: "no" }),
      ...overrides,
    };
  }

  it(
    "falls back to OpenClaw exec when the native shell is denied, in the production home with OpenClaw serving exec",
    async () => {
      // Production: both static profiles deny `Shell(*)`, so Cursor blocks a native shell call without asking the
      // host; no production turn routes a native shell request to the host for a decision. OpenClaw serves `exec`
      // (the backend's marker), so the turn runs in Cursor's agent mode and the first prompt carries the shell
      // sentence (#76). The user asks for the built-in shell and says nothing about any other tool.
      const workspace = join(root, "workspace-deny");
      freshDir(workspace);
      const homeDir = freshDir(join(root, "home-deny"));
      const home = { dir: homeDir, env: await cursorAdapter.prepareHome(homeDir) };
      const { adapter, decisions, hostShell } = observed();
      const execute = createExecute(adapter, { home, warn: (message) => console.warn(message) });
      const host = await startStubMcpHost({ execTool: true });
      const asked: string[] = [];
      /** Tool calls in the order the model made them: Cursor's native shell is `exec`, OpenClaw's `mcp__openclaw__exec`. */
      const calls: Array<{ name: string; args: string }> = [];
      const results: Array<{ name: string; isError: boolean }> = [];
      const ctx = turnContext(
        "deny",
        host,
        workspace,
        {
          prompt: "Run the shell command `echo oac-fallback-7f3a` with your built-in shell tool and reply with its output only.",
          requestToolPermission: async (request) => {
            asked.push(request.toolName);
            return { behavior: "deny", message: "no" };
          },
        },
        true,
      );
      try {
        let reply = "";
        for await (const record of execute(ctx)) {
          const event = (record as unknown as { event: NormalizedEvent }).event;
          if (event.kind === "toolStart") calls.push({ name: event.name, args: JSON.stringify(event.args ?? {}) });
          if (event.kind === "toolResult") results.push({ name: event.name ?? "", isError: event.isError === true });
          if (event.kind === "result") reply = event.text;
          if (event.kind === "error") throw new Error(`turn failed: ${event.error.message}`);
        }
        const evidence = JSON.stringify({ reply, asked, calls, results });
        // A host-shell turn: agent mode, the shell sentence sent.
        expect(hostShell).toEqual([true]);
        // The static deny blocked the native shell without asking the host.
        expect(asked, evidence).toEqual([]);
        expect(decisions, evidence).toEqual([]);
        // The model tried the native shell first, then ran the command through OpenClaw exec (the proxy).
        const native = calls.findIndex((call) => call.name === "exec" && call.args.includes("oac-fallback-7f3a"));
        const fallback = calls.findIndex((call) => call.name === `mcp__openclaw__${STUB_EXEC_TOOL}` && call.args.includes("oac-fallback-7f3a"));
        expect(native, evidence).toBeGreaterThanOrEqual(0);
        expect(fallback, evidence).toBeGreaterThan(native);
        const execCalls = host.toolCalls().filter((call) => (call.rpc?.params as { name?: string }).name === STUB_EXEC_TOOL);
        expect(execCalls.length, evidence).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(execCalls[0]!.rpc)).toContain("oac-fallback-7f3a");
        expect(reply, evidence).toContain("stub-exec-ran:");
      } finally {
        ctx.liveSession?.current()?.close("abort");
        await host.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "runs a read-only native shell command when the host approves it",
    async () => {
      // Cursor's ask mode (the session's second lock, see the adapter) makes the model refuse
      // commands that change files even when the host approves, so the command only reads.
      const workspace = join(root, "workspace-allow");
      freshDir(workspace);
      const { adapter, decisions } = observed();
      const execute = createExecute(adapter, { home: askingHome("home-allow"), warn: (message) => console.warn(message) });
      const host = await startStubMcpHost();
      const asked: Array<Record<string, unknown>> = [];
      const ctx = turnContext("allow", host, workspace, {
        prompt: "Run the shell command `od -An -N4 -tu4 /dev/urandom` and reply with the number it prints, nothing else.",
        requestToolPermission: async (request) => {
          asked.push(request.toolInput);
          return { behavior: "allow", updatedInput: request.toolInput };
        },
      });
      try {
        let reply = "";
        for await (const record of execute(ctx)) {
          const event = (record as unknown as { event: NormalizedEvent }).event;
          if (event.kind === "result") reply = event.text;
          if (event.kind === "error") throw new Error(`turn failed: ${event.error.message}`);
        }
        expect(JSON.stringify(asked)).toContain("/dev/urandom");
        expect(decisions.map((entry) => entry.decision)).toContain("allow_once");
        // Four random bytes cannot be guessed: the number in the reply came from the shell.
        expect(reply).toMatch(/\d{4,}/);
      } finally {
        ctx.liveSession?.current()?.close("abort");
        await host.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "ends the turn cleanly when it is aborted while the host waits for a human",
    async () => {
      const workspace = join(root, "workspace-abort");
      freshDir(workspace);
      const { adapter, decisions, sessions } = observed();
      const execute = createExecute(adapter, { home: askingHome("home-abort"), warn: (message) => console.warn(message) });
      const host = await startStubMcpHost();
      const controller = new AbortController();
      let hostAsked: () => void = () => {};
      const asked = new Promise<void>((resolve) => (hostAsked = resolve));
      const ctx = turnContext("abort", host, workspace, {
        prompt: "Run the shell command `echo oac-abort-3e8b` and reply with its output only.",
        abortSignal: controller.signal,
        // A human who never answers: the request stays pending until the run is aborted.
        requestToolPermission: () => {
          hostAsked();
          return new Promise(() => {});
        },
      });
      try {
        const turn = (async () => {
          for await (const _record of execute(ctx)) {
            // Drain until the abort ends the stream.
          }
        })();
        const outcome = expect(turn).rejects.toThrow();
        await asked;
        controller.abort(new Error("stop"));
        await outcome;
        expect(decisions).toEqual([{ tool: "exec", decision: "cancelled" }]);
        // The process is gone: no hang, nothing left running.
        await sessions[0]!.waitForExit();
        expect(sessions[0]!.alive).toBe(false);
      } finally {
        ctx.liveSession?.current()?.close("abort");
        await host.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

// P10 through the real OpenClaw: the host filters the OpenClaw tool list; the adapter translates
// nothing. A tool in `tools.deny` is absent from what the model can list. Run `npm run dev:install` first.
describeLive("a tool the host denies is absent from the model's tool list (P10)", () => {
  it(
    "hides session_status and web_fetch under tools.deny and still lists the rest",
    () => {
      const list = () => {
        const run = openclaw(
          [
            "agent",
            "--local",
            "--model",
            "cursor-cli/auto",
            "--session-id",
            `deny-live-${Date.now()}`,
            "--message",
            'List the exact names of every tool you can call from the MCP server "openclaw", comma separated, nothing else.',
          ],
          { timeoutMs: 240_000 },
        );
        expect(run.status).toBe(0);
        return replyLines(run.stdout).join(" ");
      };
      const before = list();
      expect(before).toContain("session_status");
      expect(before).toContain("web_fetch");
      const set = openclaw(["config", "set", "tools.deny", '["session_status","web_fetch"]', "--strict-json"]);
      expect(set.status).toBe(0);
      try {
        const after = list();
        expect(after).not.toContain("session_status");
        expect(after).not.toContain("web_fetch");
        expect(after).toContain("memory_search");
      } finally {
        openclaw(["config", "unset", "tools.deny"]);
      }
    },
    3 * LIVE_TIMEOUT_MS,
  );
});
