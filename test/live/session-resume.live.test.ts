import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { cursorAdapter } from "../../src/adapters/cursor/index.ts";
import { homeDirFor } from "../../src/core/home.ts";
import { createExecute } from "../../src/core/execute.ts";
import type { CliAdapter, CliSession, NormalizedEvent, OpenParams } from "../../src/core/ports.ts";
import type { ExecuteContext } from "../../src/core/sdk-types.ts";
import { ISOLATED_STATE_DIR, LIVE_TIMEOUT_MS, describeLive, liveHostEnv, makeLiveSession, openclaw, replyLines } from "./harness.ts";

// Parity rows P4 (warm process), P5 (resume), and P18 (side questions). Real cursor-agent through
// `createExecute`, the way the host drives it: one execute per run, a live-session handle per
// "Gateway". A new `makeLiveSession()` plus a closed handle stands in for a Gateway restart.
describeLive("session resume, live-process reuse, and side questions (P4, P5, P18)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-live-resume-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);

  type Watched = { opens: OpenParams[]; sessions: CliSession[]; prompts: string[][] };

  /** The Cursor adapter, recording every open and every prompt each process receives. */
  function watched(): { adapter: CliAdapter; seen: Watched } {
    const seen: Watched = { opens: [], sessions: [], prompts: [] };
    const adapter: CliAdapter = {
      ...cursorAdapter,
      open: async (params) => {
        seen.opens.push(params);
        const session = await cursorAdapter.open(params);
        const prompts: string[] = [];
        seen.prompts.push(prompts);
        seen.sessions.push(session);
        return {
          get sessionId() {
            return session.sessionId;
          },
          get alive() {
            return session.alive;
          },
          prompt: (text: string) => {
            prompts.push(text);
            return session.prompt(text);
          },
          cancel: () => session.cancel(),
          close: () => session.close(),
          waitForExit: () => session.waitForExit(),
        };
      },
    };
    return { adapter, seen };
  }

  async function homeFor(name: string) {
    const dir = homeDirFor(join(root, name), "cursor-cli");
    return { dir, env: await cursorAdapter.prepareHome(dir) };
  }

  type TurnResult = { reply: string; sessionId?: string; error?: { code: string; message: string } };

  async function turn(execute: ReturnType<typeof createExecute>, overrides: Partial<ExecuteContext>): Promise<TurnResult> {
    const ctx: ExecuteContext = {
      command: process.env.CURSOR_AGENT_BIN ?? cursorAdapter.command,
      args: cursorAdapter.launchArgs,
      cwd: workspace,
      env: liveHostEnv(),
      prompt: "",
      modelId: "auto",
      systemPrompt: "",
      useResume: false,
      timeoutMs: LIVE_TIMEOUT_MS,
      requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
      requestUserInput: async () => ({ status: "cancelled", message: "no" }),
      ...overrides,
    };
    const out: TurnResult = { reply: "" };
    for await (const record of execute(ctx)) {
      const event = (record as unknown as { event: NormalizedEvent }).event;
      if (event.kind === "sessionId") out.sessionId = event.sessionId;
      if (event.kind === "result") out.reply = event.text;
      if (event.kind === "error") out.error = { code: event.error.code, message: event.error.message };
    }
    return out;
  }

  const FACT = "Remember this code word for later: PELICAN-42. Reply with OK only.";
  const ASK = "What code word did I ask you to remember? Reply with the code word only, or UNKNOWN if you were not told one.";

  it(
    "answers a follow-up about the first turn from the warm process, also after the Gateway restarts, and /reset forgets it",
    async () => {
      const home = await homeFor("chat-agent");
      const { adapter, seen } = watched();
      const gatewayOne = makeLiveSession();
      const executeOne = () => createExecute(adapter, { home, mcp: false });
      try {
        const first = await turn(executeOne(), { liveSession: gatewayOne, prompt: FACT });
        expect(first.error).toBeUndefined();
        const chat = first.sessionId!;
        expect(chat).toBeTruthy();

        // Follow-up: the same process, only the new prompt.
        const second = await turn(executeOne(), { liveSession: gatewayOne, prompt: ASK, useResume: true, sessionId: chat });
        expect(second.error).toBeUndefined();
        expect(second.reply).toContain("PELICAN-42");
        expect(seen.opens).toHaveLength(1);
        expect(seen.prompts[0]).toEqual([FACT, ASK]);
        expect(second.sessionId).toBe(chat);

        // Gateway restart: the old process is gone, a new one loads the chat.
        gatewayOne.current()?.close("restart");
        const gatewayTwo = makeLiveSession();
        try {
          const third = await turn(executeOne(), { liveSession: gatewayTwo, prompt: ASK, useResume: true, sessionId: chat });
          expect(third.error).toBeUndefined();
          expect(third.reply).toContain("PELICAN-42");
          expect(seen.opens).toHaveLength(2);
          expect(seen.opens[1]!.resumeSessionId).toBe(chat);
          expect(seen.prompts[1]).toEqual([ASK]);

          // /reset: the host passes no resume id and gets a new chat that knows nothing.
          const reset = await turn(executeOne(), { liveSession: gatewayTwo, prompt: ASK, useResume: false });
          expect(reset.error).toBeUndefined();
          expect(reset.sessionId).not.toBe(chat);
          expect(reset.reply).not.toContain("PELICAN-42");
          expect(seen.opens[2]!.resumeSessionId).toBeUndefined();
        } finally {
          gatewayTwo.current()?.close("abort");
        }
      } finally {
        gatewayOne.current()?.close("abort");
      }
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "cannot resume another agent's chat: session_expired, and no fresh chat behind it",
    async () => {
      const owner = await homeFor("owner-agent");
      const { adapter: ownerAdapter } = watched();
      const made = await turn(createExecute(ownerAdapter, { home: owner, mcp: false }), { prompt: FACT });
      expect(made.sessionId).toBeTruthy();

      const stranger = await homeFor("stranger-agent");
      const { adapter, seen } = watched();
      const refused = await turn(createExecute(adapter, { home: stranger, mcp: false }), {
        prompt: ASK,
        useResume: true,
        sessionId: made.sessionId!,
      });
      expect(refused.error?.code).toBe("session_expired");
      expect(refused.error?.message).toMatch(/session not found/i);
      expect(refused.reply).toBe("");
      // One attempt, with the id: nothing started a new chat instead.
      expect(seen.opens).toHaveLength(1);
      expect(seen.opens[0]!.resumeSessionId).toBe(made.sessionId);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "runs a side question with no OpenClaw tool, no resume, and no writes",
    async () => {
      const home = await homeFor("side-agent");
      const { adapter, seen } = watched();
      const execute = createExecute(adapter, { home });
      const chat = await turn(execute, { prompt: FACT });
      expect(chat.sessionId).toBeTruthy();

      const side = await turn(execute, {
        executionMode: "side-question",
        useResume: true,
        sessionId: chat.sessionId!,
        prompt: `${ASK} Also run the shell command \`echo hi > side-effect.txt\` if you can.`,
      });
      expect(side.error).toBeUndefined();
      expect(side.sessionId).toBeUndefined();
      expect(side.reply).not.toContain("PELICAN-42");
      const open = seen.opens.at(-1)!;
      expect(open.executionMode).toBe("side-question");
      expect(open.mcpServers).toBeUndefined();
      expect(open.resumeSessionId).toBeUndefined();
      expect(existsSync(join(workspace, "side-effect.txt"))).toBe(false);
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "keeps one process per chat: a second Gateway loading the chat closes the first's process (spec Q4)",
    async () => {
      const home = await homeFor("two-process-agent");
      const { adapter, seen } = watched();
      const gatewayOne = makeLiveSession();
      const gatewayTwo = makeLiveSession();
      try {
        const first = await turn(createExecute(adapter, { home, mcp: false }), { liveSession: gatewayOne, prompt: FACT });
        const chat = first.sessionId!;
        expect(seen.sessions[0]!.alive).toBe(true);

        // Cursor itself lets two processes load one chat; each then keeps its own view and the
        // last writer wins (see the ticket notes). The core therefore never holds two.
        const second = await turn(createExecute(adapter, { home, mcp: false }), {
          liveSession: gatewayTwo,
          prompt: ASK,
          useResume: true,
          sessionId: chat,
        });
        expect(second.error).toBeUndefined();
        expect(second.reply).toContain("PELICAN-42");
        expect(seen.sessions[0]!.alive).toBe(false);
        expect(seen.sessions[1]!.alive).toBe(true);
      } finally {
        gatewayOne.current()?.close("abort");
        gatewayTwo.current()?.close("abort");
      }
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "resumes through the real OpenClaw, and fails a chat Cursor lost as session_expired",
    () => {
      // Each `openclaw agent --local` run is a new process, as after a Gateway restart; the host
      // stores the Cursor session ID the plugin reported and resumes it. Needs `npm run dev:install`.
      const sessionId = `live-resume-${Date.now()}`;
      const ask = (message: string) =>
        openclaw(["agent", "--local", "--model", "cursor-cli/auto", "--session-id", sessionId, "--message", message], {
          timeoutMs: 240_000,
        });
      const sessions = join(ISOLATED_STATE_DIR, "agents", "main", "agent", "openclaw-all-cli", "cursor-cli", "acp-sessions");
      const before = new Set(existsSync(sessions) ? readdirSync(sessions) : []);
      const first = ask(FACT);
      expect(first.status).toBe(0);
      expect(first.stderr + first.stdout).toMatch(/useResume=false/);

      const second = ask(ASK);
      expect(second.status).toBe(0);
      expect(replyLines(second.stdout).join("\n")).toContain("PELICAN-42");
      const log = second.stderr + second.stdout;
      expect(log).toMatch(/useResume=true session=present/);

      // Cursor loses the chat (a deleted or foreign one): the turn fails, clearly, with no fresh chat.
      // The chat is the one session directory the first run added to the agent's home.
      const lost = readdirSync(sessions).filter((name) => !before.has(name));
      expect(lost).toHaveLength(1);
      rmSync(join(sessions, lost[0]!), { recursive: true, force: true });
      const third = ask(ASK);
      expect(third.status).not.toBe(0);
      const output = third.stderr + third.stdout;
      expect(output).toMatch(/CLI session not found/);
      expect(output).toMatch(/reason=session_expired/);
      expect(replyLines(third.stdout).join("\n")).not.toContain("PELICAN-42");
    },
    LIVE_TIMEOUT_MS * 2,
  );
});
