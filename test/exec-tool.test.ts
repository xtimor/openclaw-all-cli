import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import { buildCliBackend } from "../src/core/backend.ts";
import { STUB_EXEC_TOOL, startStubMcpHost } from "./fixtures/stub-mcp-host.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";
import { MCP_CONFIG_TEST_KEY, withHostMcp } from "./fixtures/host-mcp.ts";

/**
 * The host-served `exec` path (ticket 1.19) end to end without Cursor: the real backend, the real
 * MCP proxy, a fake `cursor-agent` that calls its MCP server like a model, and a stand-in for the
 * host's loopback endpoint. It proves the plugin forwards exec calls faithfully and aborts them;
 * OpenClaw's own exec policy is covered by the gated live test.
 */
/** Polls until `condition` holds or the time is up. */
async function waitFor(condition: () => boolean, timeoutMs: number) {
  for (const deadline = Date.now() + timeoutMs; !condition() && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("exec through the MCP proxy", () => {
  const scratch = mkdtempSync(join(tmpdir(), "oac-exec-tool-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const hosts: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
  });

  let counter = 0;
  async function startHost() {
    const host = await startStubMcpHost({ execTool: true });
    hosts.push(host);
    return host;
  }

  /** One turn of the real backend. The prompt steers the fake agent. */
  async function turn(
    host: { url: string },
    prompt: string,
    options: {
      abort?: AbortController;
      callDeadlineMs?: number;
      /** What the backend's `resolveExecutionArgs` returned: with the marker, the host serves exec. */
      args?: readonly string[];
      requestToolPermission?: (request: { toolName: string }) => Promise<{ behavior: "allow" | "deny"; message?: string; updatedInput?: unknown }>;
    } = {},
  ) {
    const n = counter++;
    const settings = join(scratch, `settings-${n}.json`);
    writeFileSync(
      settings,
      JSON.stringify({
        mcpServers: { openclaw: { type: "http", url: host.url, headers: { Authorization: "Bearer turn-token", "x-openclaw-cli-capture-key": "capture-1" } } },
      }),
    );
    const backend = buildCliBackend(cursorAdapter, {
      settings: {},
      ...(options.callDeadlineMs ? { execute: { callDeadlineMs: options.callDeadlineMs } } : {}),
    });
    const prepared = await backend.prepareExecution!({ agentDir: join(scratch, `agent-${n}`) } as never);
    const texts: string[] = [];
    const records: Array<Record<string, any>> = [];
    for await (const record of prepared!.execute!({
      command: FAKE_CURSOR_AGENT,
      ...withHostMcp([...(options.args ?? ["acp"])], fakeEnv({ [MCP_CONFIG_TEST_KEY]: settings })),
      cwd: scratch,
      prompt,
      modelId: "auto",
      systemPrompt: "",
      useResume: false,
      timeoutMs: 20_000,
      ...(options.abort ? { abortSignal: options.abort.signal } : {}),
      requestToolPermission: (options.requestToolPermission ?? (async () => ({ behavior: "deny", message: "no" }))) as never,
      requestUserInput: async () => ({ status: "cancelled", message: "no" }),
    } as never)) {
      records.push(record as Record<string, any>);
    }
    const parse = backend.parseJsonlEvent!;
    for (const record of records) {
      const event = parse(JSON.stringify(record), {} as never) as { kind?: string; text?: string } | null;
      if (event?.kind === "result" && event.text !== undefined) texts.push(event.text);
    }
    return { records, text: texts.at(-1) ?? "" };
  }

  const execCall = (args: Record<string, unknown>) => `[[mcp-call]]${JSON.stringify({ tool: STUB_EXEC_TOOL, arguments: args })}`;

  it("delivers an exec call to the host with the turn's own headers, and the answer reaches the model", async () => {
    const host = await startHost();
    const { text } = await turn(host, execCall({ command: "echo hi" }));
    expect(text).toBe("stub-exec-ran:echo hi");
    const calls = host.toolCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.rpc?.params).toMatchObject({ name: "exec", arguments: { command: "echo hi" } });
    expect(calls[0]!.headers.authorization).toBe("Bearer turn-token");
    expect(calls[0]!.headers["x-openclaw-cli-capture-key"]).toBe("capture-1");
  });

  it("answers two concurrent exec calls separately", async () => {
    const host = await startHost();
    const { text } = await turn(
      host,
      `[[mcp-call]]${JSON.stringify([
        { tool: "exec", arguments: { command: "slow", delayMs: 200 } },
        { tool: "exec", arguments: { command: "fast" } },
      ])}`,
    );
    expect(text).toBe("stub-exec-ran:slow|stub-exec-ran:fast");
    expect(host.toolCalls()).toHaveLength(2);
  });

  it("runs two slow exec calls at the same time, each answered with its own text", async () => {
    const host = await startHost();
    const { text } = await turn(
      host,
      `[[mcp-call]]${JSON.stringify([
        { tool: "exec", arguments: { command: "a", delayMs: 300 } },
        { tool: "exec", arguments: { command: "b", delayMs: 300 } },
      ])}`,
    );
    expect(text).toBe("stub-exec-ran:a|stub-exec-ran:b");
    expect(host.maxInFlight()).toBe(2);
  });

  it("relays the host's keepalive frames and still delivers the answer", async () => {
    const host = await startHost();
    const { text } = await turn(host, execCall({ command: "sleep", delayMs: 400, keepaliveMs: 50 }));
    expect(text).toBe("stub-exec-ran:sleep");
    expect(host.closed()).toBe(0);
  });

  it("stops an exec call that outlives the deadline, tells the model, and lets it carry on", async () => {
    const host = await startHost();
    const { text } = await turn(host, execCall({ command: "sleep 600", hang: true, keepaliveMs: 50 }), { callDeadlineMs: 400 });
    // The fake agent prints the tool error it received.
    expect(text).toMatch(/^tool-error:.*stopped.*background/);
    // The host saw its request closed, which is what makes it kill the command.
    await waitFor(() => host.closed() > 0, 5_000);
    expect(host.closed()).toBe(1);
    expect(host.toolCalls()).toHaveLength(1);
  });

  it("does not touch an exec call that finishes before the deadline", async () => {
    const host = await startHost();
    const { text } = await turn(host, execCall({ command: "quick", delayMs: 100 }), { callDeadlineMs: 5_000 });
    expect(text).toBe("stub-exec-ran:quick");
    expect(host.closed()).toBe(0);
  });

  it("closes the upstream exec call when the turn is aborted mid-call, and ends the turn", async () => {
    const host = await startHost();
    const abort = new AbortController();
    const started = Date.now();
    const running = turn(host, execCall({ command: "sleep 600", hang: true, keepaliveMs: 50 }), { abort }).then(
      () => "ended",
      (error: Error) => error.name,
    );
    // Wait until the call reached the host, then abort the turn.
    while (host.toolCalls().length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();
    // The turn ends with the abort error, as for any aborted turn.
    expect(await running).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(15_000);
    // The host sees the hang-up: its tool call is aborted (OpenClaw kills the child on that signal).
    const deadline = Date.now() + 5_000;
    while (host.closed() === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.closed()).toBe(1);
  });

  it("runs Cursor in agent mode exactly when the backend's execution args say the host serves exec", async () => {
    const host = await startHost();
    const backend = buildCliBackend(cursorAdapter, { settings: {} });
    const served = backend.resolveExecutionArgs!({ baseArgs: ["acp"], hostOwnedTools: ["exec", "process"], executionMode: "agent" } as never)!;
    const notServed = backend.resolveExecutionArgs!({ baseArgs: ["acp"], executionMode: "agent" } as never)!;
    expect((await turn(host, "[[mode]]", { args: served })).text).toBe("mode:agent");
    expect((await turn(host, "[[mode]]", { args: notServed })).text).toBe("mode:ask");
  });

  it("stays in ask mode when the host's tool policy dropped exec (tools.deny, or tools.allow without exec), though the marker is there", async () => {
    // The host still passes hostOwnedTools in these runs; only its tool list shows that exec is gone.
    const withoutExec = await startStubMcpHost();
    hosts.push(withoutExec);
    const backend = buildCliBackend(cursorAdapter, { settings: {} });
    const marked = backend.resolveExecutionArgs!({ baseArgs: ["acp"], hostOwnedTools: ["exec", "process"], executionMode: "agent" } as never)!;
    expect(marked).toContain("--openclaw-all-cli:host-shell");
    expect((await turn(withoutExec, "[[mode]]", { args: marked })).text).toBe("mode:ask");
    // The same marker with exec in the list: agent.
    const withExec = await startHost();
    expect((await turn(withExec, "[[mode]]", { args: marked })).text).toBe("mode:agent");
  });

  it("keeps rejecting a native shell request, so the model cannot bypass the host's exec", async () => {
    const host = await startHost();
    const asked: string[] = [];
    const { text } = await turn(
      host,
      `[[ask-json]]${JSON.stringify({
        toolCall: { toolCallId: "shell-1", title: "`touch /tmp/oac-should-not-exist`", kind: "execute", rawInput: { command: "touch /tmp/oac-should-not-exist" } },
        announce: { toolCallId: "shell-1", title: "Shell", kind: "execute", rawInput: { command: "touch /tmp/oac-should-not-exist" } },
      })}`,
      {
        requestToolPermission: async (request) => {
          asked.push(request.toolName);
          // What OpenClaw answers for a native tool its exec replaces. That is true only in a run where
          // the host serves exec; in any other run the native shell is protected by `Shell(*)` in the home alone.
          return { behavior: "deny", message: "Use OpenClaw exec; its native equivalent is unavailable." };
        },
      },
    );
    expect(asked).toEqual(["exec"]);
    expect(text).toContain("reject");
    expect(host.toolCalls()).toHaveLength(0);
  });
});
