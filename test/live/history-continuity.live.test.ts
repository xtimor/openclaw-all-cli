import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MOCK_API_SCRIPT } from "../fixtures/paths.ts";
import { ISOLATED_STATE_DIR, LIVE_TIMEOUT_MS, describeLive, openclaw, startGateway, type TestGateway } from "./harness.ts";

const PORT = 18_913;
const LOG_DIR = "/tmp/openclaw";
const PROFILE = "cursor-cli:manual";

// Parity row P15 (history reseed and the continuity note). Real cursor-agent and a local mock API
// model behind one isolated Gateway; needs `npm run dev:install` and CURSOR_API_KEY. The host log
// (`historyPrompt=`, `auth-unknown`) is the evidence of what the host did with the history.
describeLive("chat continuity across a model switch (P15)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-live-history-"));
  const requestLog = join(root, "mock-requests.jsonl");
  let gateway: TestGateway;
  let mock: ChildProcess | undefined;
  let profileAdded = false;

  const word = (label: string) => `${label}-${randomBytes(3).toString("hex").toUpperCase()}`;
  const sessionId = (label: string) => `live-history-${label}-${Date.now()}`;

  /** The newest Gateway log file, and its size now: what a step appends to it is that step's evidence. */
  function hostLog() {
    const file = existsSync(LOG_DIR)
      ? readdirSync(LOG_DIR)
          .filter((name) => /^openclaw-.*\.log$/.test(name))
          .sort()
          .at(-1)
      : undefined;
    const path = file ? join(LOG_DIR, file) : undefined;
    return { path, offset: path ? statSync(path).size : 0 };
  }
  function logSince(mark: ReturnType<typeof hostLog>): string {
    if (!mark.path) return "";
    return readFileSync(mark.path).subarray(mark.offset).toString("utf8");
  }

  type Turn = { reply: string; tools: string[]; log: string; raw: string; status: number | null };

  /** One `openclaw agent` turn through the Gateway. */
  function ask(model: string, id: string, message: string, sessionFlag: "--session-id" | "--session-key" = "--session-id"): Turn {
    const mark = hostLog();
    const result = openclaw(["agent", "--model", model, sessionFlag, id, "--message", message, "--json"], {
      env: gateway.env,
      timeoutMs: 280_000,
    });
    let reply = "";
    let tools: string[] = [];
    try {
      const json = JSON.parse(result.stdout) as {
        payloads?: Array<{ text?: string }>;
        result?: { payloads?: Array<{ text?: string }>; meta?: { toolSummary?: { tools?: string[] } } };
        meta?: { toolSummary?: { tools?: string[] } };
      };
      const payloads = json.payloads ?? json.result?.payloads ?? [];
      reply = payloads.map((payload) => payload.text ?? "").join("\n");
      tools = json.meta?.toolSummary?.tools ?? json.result?.meta?.toolSummary?.tools ?? [];
    } catch {
      reply = result.stdout;
    }
    // The Gateway writes its log file a moment after the reply: wait for the turn's own line.
    let log = logSince(mark);
    for (let attempt = 0; attempt < 25 && model.startsWith("cursor-cli") && !log.includes("cli exec: provider=cursor-cli"); attempt += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      log = logSince(mark);
    }
    return { reply, tools, log, raw: result.stdout + result.stderr, status: result.status };
  }

  const cursorExecLines = (log: string) => log.split("\n").filter((line) => line.includes("cli exec: provider=cursor-cli"));

  beforeAll(async () => {
    const key = process.env.CURSOR_API_KEY;
    expect(key, "CURSOR_API_KEY is needed for the profile steps").toBeTruthy();
    // The mock API model.
    mock = spawn(process.execPath, [MOCK_API_SCRIPT, requestLog], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<number>((resolve, reject) => {
      mock!.once("error", reject);
      mock!.stdout!.on("data", (chunk: Buffer) => {
        const match = /listening (\d+)/.exec(chunk.toString("utf8"));
        if (match) resolve(Number(match[1]));
      });
    });
    const provider = JSON.stringify({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      api: "openai-completions",
      apiKey: "sk-mock",
      models: [{ id: "echo", name: "echo" }],
    });
    expect(openclaw(["config", "set", "models.providers.mockapi", provider, "--strict-json"]).status).toBe(0);
    expect(openclaw(["config", "set", "agents.defaults.model.primary", "cursor-cli/auto"]).status).toBe(0);
    gateway = await startGateway(PORT);
  }, LIVE_TIMEOUT_MS);

  // Leave nothing behind: the profile, the mock provider, the default model, the Gateway, the mock.
  afterAll(async () => {
    await gateway?.stop();
    if (profileAdded) openclaw(["models", "auth", "logout", PROFILE, "--yes"]);
    openclaw(["config", "unset", "models.providers.mockapi"]);
    openclaw(["config", "unset", "agents.defaults.model.primary"]);
    mock?.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }, 180_000);

  const question = "What was the code word I gave you earlier in this conversation? Answer with the word only.";

  let switchedChat: { id: string; fact: string; question: string; reply: string } | undefined;

  it(
    "(a) without a profile, a cursor-cli turn after an API turn reads the earlier turn with sessions_history",
    () => {
      const id = sessionId("a");
      const fact = word("KIWI");
      const first = ask("mockapi/echo", id, `Remember this: the code word is ${fact}.`);
      expect(first.status, first.raw).toBe(0);
      const second = ask("cursor-cli/auto", id, question);
      expect(second.status, second.raw).toBe(0);
      expect(second.reply).toContain(fact);
      expect(second.tools.some((name) => name.endsWith("sessions_history"))).toBe(true);
      expect(cursorExecLines(second.log).at(-1)).toContain("historyPrompt=none");
      switchedChat = { id, fact, question, reply: second.reply };
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "(d) an API turn after cursor-cli turns carries their user and assistant text",
    () => {
      expect(switchedChat, "step (a) must run first").toBeTruthy();
      const { id, question: asked, reply } = switchedChat!;
      const next = ask("mockapi/echo", id, "Thanks. Say ok.");
      expect(next.status, next.raw).toBe(0);
      const requests = readFileSync(requestLog, "utf8").trim().split("\n");
      const last = requests.at(-1)!;
      expect(last).toContain(asked);
      expect(last).toContain(reply.trim().split("\n")[0]!.slice(0, 40));
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "(e) probe: cursor-cli, then an API turn, then cursor-cli again (recorded, not asserted)",
    () => {
      const id = sessionId("e");
      const early = word("PEAR");
      const later = word("PLUM");
      ask("cursor-cli/auto", id, `Remember this: the first code word is ${early}. Say ok.`);
      ask("mockapi/echo", id, `Remember this: the second code word is ${later}.`);
      const back = ask("cursor-cli/auto", id, "What is the second code word? Answer with the word only.");
      process.stderr.write(
        `P15 probe (e): cursor -> API -> cursor: fetched the API-turn fact=${back.reply.includes(later)}; tools=${JSON.stringify(back.tools)}; reply=${JSON.stringify(back.reply.slice(0, 200))}\n`,
      );
      expect(back.status, back.raw).toBe(0);
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "(b) with a cursor-cli api_key profile, a switch still reads history with sessions_history, and the host still refuses reseed",
    () => {
      const add = openclaw(["models", "auth", "paste-api-key", "--provider", "cursor-cli"], {
        input: `${process.env.CURSOR_API_KEY}\n`,
      });
      expect(add.status, add.stdout + add.stderr).toBe(0);
      profileAdded = true;
      expect(add.stdout + add.stderr).toContain(PROFILE);
      const id = sessionId("b");
      const fact = word("MANGO");
      expect(ask("mockapi/echo", id, `Remember this: the code word is ${fact}.`).status).toBe(0);
      const second = ask("cursor-cli/auto", id, question);
      expect(second.status, second.raw).toBe(0);
      expect(second.reply).toContain(fact);
      expect(second.tools.some((name) => name.endsWith("sessions_history"))).toBe(true);
      expect(second.log).toContain("reason=auth-unknown");
      expect(cursorExecLines(second.log).at(-1)).toContain("historyPrompt=none");
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "(c) with a profile, a lost cursor-cli chat gets the host's history prompt (the fresh retry itself is recorded)",
    () => {
      expect(profileAdded, "step (b) must run first").toBe(true);
      const id = `agent:main:${sessionId("c")}`;
      const fact = word("FIG");
      const sessions = join(ISOLATED_STATE_DIR, "agents", "main", "agent", "openclaw-all-cli", "cursor-cli", "acp-sessions");
      const before = new Set(existsSync(sessions) ? readdirSync(sessions) : []);
      expect(ask("cursor-cli/auto", id, `Remember this: the code word is ${fact}. Say ok.`, "--session-key").status).toBe(0);
      // The new native chat is the new directory that holds the fact (a model listing may add another).
      const holdsFact = (dir: string) =>
        readdirSync(join(sessions, dir), { recursive: true, withFileTypes: true }).some(
          (entry) => entry.isFile() && readFileSync(join(entry.parentPath, entry.name)).includes(fact),
        );
      const created = readdirSync(sessions).filter((name) => !before.has(name) && holdsFact(name));
      expect(created).toHaveLength(1);
      rmSync(join(sessions, created[0]!), { recursive: true, force: true });
      const next = ask("cursor-cli/auto", id, question, "--session-key");
      // reseedFromRawTranscriptWhenUncompacted: the host builds its history prompt for the resumed turn
      // (without the flag the log says historyPrompt=none), the native chat is gone, and the turn is classified session_expired.
      expect(cursorExecLines(next.log).at(-1)).toContain("historyPrompt=present");
      expect(next.log).toContain("reason=session_expired");
      // OpenClaw 2026.10.3 then should retry once with a fresh chat. Recorded, not asserted: through a Gateway the
      // host cannot clear the stale binding (its session entry copy has an old activeWriterRunId), so the retry is skipped.
      process.stderr.write(
        `P15 probe (c): retry=${next.log.includes("cli session recovery retry")}; status=${next.status}; knewFact=${next.reply.includes(fact)}\n`,
      );
    },
    LIVE_TIMEOUT_MS * 2,
  );
});
