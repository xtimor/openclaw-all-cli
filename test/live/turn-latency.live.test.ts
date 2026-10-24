import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { cursorAdapter } from "../../src/adapters/cursor/index.ts";
import { homeDirFor } from "../../src/core/home.ts";
import { createExecute } from "../../src/core/execute.ts";
import type { CliAdapter, NormalizedEvent } from "../../src/core/ports.ts";
import type { ExecuteContext } from "../../src/core/sdk-types.ts";
import { startStubMcpHost } from "../fixtures/stub-mcp-host.ts";
import {
  LIVE_TIMEOUT_MS,
  describeLive,
  hostMcpArgs,
  liveHostEnv,
  makeLiveSession,
  openclaw,
  openclawAsync,
  replyLines,
  startGateway,
  watchGatewayEvents,
  writeSettingsFile,
} from "./harness.ts";

// Backlog bug 6 (parity row P4): what a plain turn costs, stage by stage, with the process restarted
// per turn (what OpenClaw 2026.10.3 forces) and with one warm process. Real cursor-agent through
// `createExecute`; a stub HTTP MCP host stands in for OpenClaw. The numbers print as `LATENCY` lines.
describeLive("per-turn latency of a plain cursor-cli turn (P4)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-live-latency-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);

  type Timing = { openMs: number; firstTextMs: number; resultMs: number; textEvents: number; lastTextMs: number };

  async function measure(options: { warm: boolean; turns: number; freshHome?: boolean; label: string }): Promise<Timing[]> {
    const host = await startStubMcpHost();
    let openStart = 0;
    let openMs = 0;
    const adapter: CliAdapter = {
      ...cursorAdapter,
      open: async (params) => {
        openStart = Date.now();
        const session = await cursorAdapter.open(params);
        openMs = Date.now() - openStart;
        return session;
      },
    };
    const live = makeLiveSession();
    const timings: Timing[] = [];
    let sessionId: string | undefined;
    try {
      for (let n = 1; n <= options.turns; n += 1) {
        const agentDir = join(root, options.freshHome ? `agent-${options.label}-${n}` : `agent-${options.label}`);
        const homeDir = homeDirFor(agentDir, "cursor-cli");
        const home = { dir: homeDir, env: await cursorAdapter.prepareHome(homeDir) };
        const execute = createExecute(adapter, { home, warn: (message) => console.warn(message) });
        // A changing fingerprint is what the real host gives: the next turn finds a handle it cannot reuse.
        if (!options.warm) (live as { fingerprint: string }).fingerprint = `fp-${options.label}-${n}`;
        const ctx: ExecuteContext = {
          command: process.env.CURSOR_AGENT_BIN ?? cursorAdapter.command,
          args: [...cursorAdapter.launchArgs, ...hostMcpArgs(writeSettingsFile(root, `settings-${options.label}-${n}`, host.url, `tok-${n}`, `cap-${n}`))],
          cwd: workspace,
          env: liveHostEnv(),
          prompt: "Reply with the single word OK.",
          modelId: "auto",
          systemPrompt: "",
          useResume: n > 1 && !options.freshHome,
          ...(sessionId && !options.freshHome ? { sessionId } : {}),
          timeoutMs: LIVE_TIMEOUT_MS,
          liveSession: live,
          requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
          requestUserInput: async () => ({ status: "cancelled", message: "no" }),
        };
        const start = Date.now();
        openMs = 0;
        let firstTextMs = -1;
        let lastTextMs = -1;
        let textEvents = 0;
        let resultMs = -1;
        for await (const record of execute(ctx)) {
          const event = (record as unknown as { event: NormalizedEvent }).event;
          if (event.kind === "sessionId") sessionId = event.sessionId;
          if (event.kind === "text") {
            textEvents += 1;
            lastTextMs = Date.now() - start;
            if (firstTextMs < 0) firstTextMs = lastTextMs;
          }
          if (event.kind === "result") resultMs = Date.now() - start;
          if (event.kind === "error") throw new Error(`turn ${n} failed: ${event.error.message}`);
        }
        timings.push({ openMs, firstTextMs, resultMs, textEvents, lastTextMs });
        console.log(`LATENCY ${options.label} turn ${n}: ${JSON.stringify(timings.at(-1))}`);
      }
    } finally {
      live.current()?.close("abort");
      await host.close();
    }
    return timings;
  }

  it(
    "times three plain turns: restarted every turn, and on one warm process",
    async () => {
      const restarted = await measure({ warm: false, turns: 3, label: "restart" });
      const warm = await measure({ warm: true, turns: 3, label: "warm" });
      for (const timing of [...restarted, ...warm]) expect(timing.resultMs).toBeGreaterThan(0);
      // Text goes on as the CLI sends it: the first text comes before the result (the usage read follows the text).
      for (const timing of [...restarted, ...warm]) expect(timing.firstTextMs).toBeLessThan(timing.resultMs);
      // The bound: a warm follow-up reaches its first text clearly sooner than a turn that starts the process
      // (measured 1.8-2.1 s against 5.4-6.5 s; the margin is wide because the model's own time varies).
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
      const restartedFirst = median(restarted.map((timing) => timing.firstTextMs));
      const warmFollowUp = median(warm.slice(1).map((timing) => timing.firstTextMs));
      expect(warmFollowUp, `warm ${warmFollowUp} ms, restarted ${restartedFirst} ms`).toBeLessThan(restartedFirst * 0.75);
    },
    LIVE_TIMEOUT_MS * 3,
  );
});

/** The Gateway's newest log file (`/tmp/openclaw/openclaw-<date>.log`, JSON lines) and its size now. */
function gatewayLog(): { file: string | undefined; offset: number } {
  const dir = "/tmp/openclaw";
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => /^openclaw-.*\.log$/.test(name)).sort() : [];
  const file = files.length > 0 ? join(dir, files.at(-1)!) : undefined;
  return { file, offset: file ? statSync(file).size : 0 };
}

/** How many live CLI processes the host registered since `offset` (one log line each; the Gateway writes its log a moment late). */
async function liveSessionStarts(log: { file: string | undefined; offset: number }): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  if (!log.file) return 0;
  return readFileSync(log.file).subarray(log.offset).toString("utf8").split("\n").filter((line) => line.includes("cli live session start: provider=cursor-cli")).length;
}

// The same turns through the real OpenClaw Gateway (needs `npm run dev:install`): the time from the CLI
// call to the first assistant text and to the final reply, from the Gateway's own event frames, and how
// many times the host started a CLI process (one per session when the process stays warm).
describeLive("per-turn latency through the real Gateway (P4)", () => {
  it(
    "times four plain turns of one session on one warm process",
    async () => {
      expect(openclaw(["config", "set", "agents.defaults.model.primary", "cursor-cli/auto"]).status).toBe(0);
      const gateway = await startGateway(18972);
      const watcher = await watchGatewayEvents(gateway.port);
      const sessionId = `latency-${Date.now()}`;
      const log = gatewayLog();
      const timings: Array<{ wallMs: number; firstAssistantMs: number; chatFinalMs: number }> = [];
      let startsAfterTwo = 0;
      try {
        for (let n = 1; n <= 4; n += 1) {
          const mark = watcher.frames.length;
          const start = Date.now();
          const run = await openclawAsync(["agent", "--session-id", sessionId, "--message", "Reply with the single word OK."], {
            timeoutMs: 240_000,
            env: gateway.env,
          });
          expect(run.status, run.stderr).toBe(0);
          const frames = watcher.frames.slice(mark);
          const firstOf = (match: (frame: (typeof frames)[number]) => boolean) => {
            const frame = frames.find(match);
            return frame ? frame.at - start : -1;
          };
          const timing = {
            wallMs: Date.now() - start,
            firstAgentFrameMs: firstOf((frame) => frame.event === "agent"),
            firstAssistantMs: firstOf((frame) => frame.event === "agent" && frame.payload?.stream === "assistant"),
            firstChatDeltaMs: firstOf((frame) => frame.event === "chat" && frame.payload?.state === "delta"),
            chatFinalMs: firstOf((frame) => frame.event === "chat" && frame.payload?.state === "final"),
          };
          timings.push(timing);
          if (n === 2) startsAfterTwo = await liveSessionStarts(log);
          console.log(`LATENCY gateway turn ${n}: ${JSON.stringify(timing)}`);
        }
        // The host's fingerprint no longer changes per turn: after the first two turns (the first turn of a
        // fresh agent changes the system prompt and the tool list once) no turn starts a process.
        expect(startsAfterTwo).toBeLessThanOrEqual(2);
        expect(await liveSessionStarts(log)).toBe(startsAfterTwo);
        for (const timing of timings.slice(1)) expect(timing.firstAssistantMs).toBeGreaterThan(0);
      } finally {
        watcher.close();
        await gateway.stop();
      }
    },
    LIVE_TIMEOUT_MS * 3,
  );

  it(
    "serves an OpenClaw tool call on every turn of one session from the same warm process",
    async () => {
      expect(openclaw(["config", "set", "agents.defaults.model.primary", "cursor-cli/auto"]).status).toBe(0);
      const gateway = await startGateway(18973);
      try {
        // OpenClaw's own budget compaction can fail a long agent-mode turn when no API model is configured
        // (MEMORY, entry 19): such a try says nothing about the plugin and is run again in a new session.
        let usable = false;
        for (let attempt = 0; attempt < 3 && !usable; attempt += 1) {
          const sessionId = `warm-tools-${Date.now()}`;
          const nonce = `nonce${Date.now().toString(36)}`;
          const log = gatewayLog();
          const turn = async (n: number, message: string, mustContain: string[]): Promise<boolean> => {
            const run = await openclawAsync(["agent", "--session-id", sessionId, "--message", message], { timeoutMs: 240_000, env: gateway.env });
            if (/transcript compaction failed/.test(run.stderr + run.stdout)) return false;
            expect(run.status, `turn ${n}: ${run.stderr}`).toBe(0);
            expect(run.stderr + run.stdout).not.toMatch(/cli terminal failure/);
            const reply = replyLines(run.stdout).join("\n");
            for (const text of mustContain) expect(reply, `turn ${n}`).toContain(text);
            return true;
          };
          // session_status returns the session key, which contains the unique id: only a call that reached the host can say it.
          const turns = [
            () =>
              turn(
                1,
                `Remember the word ${nonce}. Call the OpenClaw MCP tool session_status, then reply with one line: "session:" followed by the session key or id it reports, copied exactly.`,
                [sessionId],
              ),
            ...[2, 3].map(
              (n) => () =>
                turn(
                  n,
                  `Call the OpenClaw MCP tool session_status again, then reply with one line: "session:" followed by the session key or id it reports, copied exactly, then "word:" followed by the word I asked you to remember.`,
                  [sessionId, nonce],
                ),
            ),
          ];
          usable = true;
          for (const run of turns) {
            if (!(await run())) {
              usable = false;
              break;
            }
          }
          // The first turn of a fresh agent changes the system prompt and the tool list once; after that no turn starts a process.
          if (usable) expect(await liveSessionStarts(log)).toBeLessThanOrEqual(2);
        }
        expect(usable, "three tries ended in OpenClaw's budget compaction").toBe(true);
      } finally {
        await gateway.stop();
      }
    },
    LIVE_TIMEOUT_MS * 3,
  );
});
