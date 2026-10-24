import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { cursorAdapter } from "../../src/adapters/cursor/index.ts";
import { homeDirFor } from "../../src/core/home.ts";
import { createExecute } from "../../src/core/execute.ts";
import type { CliAdapter, NormalizedEvent, OpenParams } from "../../src/core/ports.ts";
import type { ExecuteContext } from "../../src/core/sdk-types.ts";
import { STUB_TOOL, startStubMcpHost } from "../fixtures/stub-mcp-host.ts";
import {
  LIVE_TIMEOUT_MS,
  describeLive,
  hostMcpArgs,
  liveHostEnv,
  makeLiveSession,
  openclaw,
  replyLines,
  writeSettingsFile,
} from "./harness.ts";

// Parity row P7 (OpenClaw tools as MCP through the per-session proxy, AD-12). Real cursor-agent,
// one warm `createExecute` session, a stub HTTP MCP host standing in for OpenClaw. Each turn has
// its own config file, token, and capture key, as OpenClaw mints them per run; the warm process
// keeps the credentials it opened with, which the host accepts for it (it moves each later run's
// grant onto them).
describeLive("OpenClaw tools through the per-session MCP proxy (P7)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-live-mcp-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it(
    "reaches the opening target with the opening headers on every turn, and rejects calls between turns",
    async () => {
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      const opens: OpenParams[] = [];
      const adapter: CliAdapter = {
        ...cursorAdapter,
        open: (params) => {
          opens.push(params);
          return cursorAdapter.open(params);
        },
      };
      const homeDir = homeDirFor(join(root, "agent"), "cursor-cli");
      const home = { dir: homeDir, env: await cursorAdapter.prepareHome(homeDir) };
      const execute = createExecute(adapter, { home, warn: (message) => console.warn(message) });
      const live = makeLiveSession();

      const hostOne = await startStubMcpHost();
      const hostTwo = await startStubMcpHost();
      let sessionId: string | undefined;
      try {
        const turn = async (n: number, host: typeof hostOne) => {
          const marker = `turn-${n}-marker`;
          const ctx: ExecuteContext = {
            command: process.env.CURSOR_AGENT_BIN ?? cursorAdapter.command,
            args: [...cursorAdapter.launchArgs, ...hostMcpArgs(writeSettingsFile(root, `settings-${n}`, host.url, `host-token-${n}`, `capture-${n}`))],
            cwd: workspace,
            env: liveHostEnv(),
            prompt: `Call the MCP tool ${STUB_TOOL} (server "openclaw") with text "${marker}". Reply with the tool's output only.`,
            modelId: "auto",
            systemPrompt: "",
            useResume: n > 1,
            ...(sessionId ? { sessionId } : {}),
            timeoutMs: LIVE_TIMEOUT_MS,
            liveSession: live,
            requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
            requestUserInput: async () => ({ status: "cancelled", message: "no" }),
          };
          let reply = "";
          for await (const record of execute(ctx)) {
            const event = (record as unknown as { event: NormalizedEvent }).event;
            if (event.kind === "sessionId") sessionId = event.sessionId;
            if (event.kind === "result") reply = event.text;
            if (event.kind === "error") throw new Error(`turn ${n} failed: ${event.error.message}`);
            if (process.env.OAC_DEBUG) console.log("EVENT", JSON.stringify(event).slice(0, 300));
          }
          return { marker, reply };
        };

        const first = await turn(1, hostOne);
        const calls1 = hostOne.toolCalls();
        expect(calls1.length).toBeGreaterThanOrEqual(1);
        expect(calls1[0]!.headers.authorization).toBe("Bearer host-token-1");
        expect(calls1[0]!.headers["x-openclaw-cli-capture-key"]).toBe("capture-1");
        expect(JSON.stringify(calls1[0]!.rpc)).toContain(first.marker);
        expect(first.reply).toContain(`echo:${first.marker}`);

        // Between turns the proxy answers 503; nothing reaches the first turn's host.
        const proxyServer = opens[0]!.mcpServers![0]!;
        const before = hostOne.requests.length;
        const idle = await fetch(proxyServer.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...proxyServer.headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
        });
        expect(idle.status).toBe(503);
        expect(hostOne.requests.length).toBe(before);

        const second = await turn(2, hostTwo);
        // One warm process served both turns.
        expect(opens).toHaveLength(1);
        const calls2 = hostOne.toolCalls().slice(calls1.length);
        expect(calls2.length).toBeGreaterThanOrEqual(1);
        expect(calls2[0]!.headers.authorization).toBe("Bearer host-token-1");
        expect(calls2[0]!.headers["x-openclaw-cli-capture-key"]).toBe("capture-1");
        expect(JSON.stringify(calls2[0]!.rpc)).toContain(second.marker);
        expect(second.reply).toContain(`echo:${second.marker}`);
        // Turn 2's own file named another host and credentials; the warm process never used them.
        expect(hostTwo.toolCalls()).toHaveLength(0);
      } finally {
        live.current()?.close("abort");
        await hostOne.close();
        await hostTwo.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

// The same row through the real OpenClaw: its per-run loopback URL, token, and capture key reach the
// proxy only through the settings file. Run `npm run dev:install` first. Two turns of one session id:
// the second restarts the process (the host's live-session fingerprint changes with the per-turn
// settings path) and goes through `session/load` with `mcpServers` again.
describeLive("OpenClaw tools reach cursor-cli through the real host (P7)", () => {
  it(
    "answers from an OpenClaw tool call in two turns of one session",
    () => {
      const sessionId = `mcp-live-${Date.now()}`;
      // Turn 1 states the nonce; turn 2 must still know it, so a resume that lost the chat fails.
      const nonce = `nonce${Date.now().toString(36)}`;
      const turn = (n: number, message: string, mustContain: string[]) => {
        const run = openclaw(
          ["agent", "--local", "--model", "cursor-cli/auto", "--session-id", sessionId, "--message", message],
          { timeoutMs: 240_000 },
        );
        expect(run.status, `turn ${n}`).toBe(0);
        expect(run.stderr + run.stdout).not.toMatch(/cli terminal failure/);
        const reply = replyLines(run.stdout).join("\n");
        for (const text of mustContain) expect(reply, `turn ${n}`).toContain(text);
      };
      // session_status returns the session key, which contains the unique id.
      turn(
        1,
        `Remember the word ${nonce}. Call the OpenClaw MCP tool session_status, then reply with one line: "session:" followed by the session key or id it reports, copied exactly.`,
        [sessionId],
      );
      turn(
        2,
        `Call the OpenClaw MCP tool session_status again, then reply with one line: "session:" followed by the session key or id it reports, copied exactly, then "word:" followed by the word I asked you to remember.`,
        [sessionId, nonce],
      );
    },
    2 * LIVE_TIMEOUT_MS,
  );
});
