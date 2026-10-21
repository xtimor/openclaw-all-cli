import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CURSOR_PERMISSIONS } from "../../src/adapters/cursor/index.ts";
import { MOCK_API_SCRIPT } from "../fixtures/paths.ts";
import {
  ISOLATED_STATE_DIR,
  LIVE_TIMEOUT_MS,
  describeLive,
  openclaw,
  openclawAsync,
  startGateway,
  waitFor,
  watchGatewayEvents,
  type GatewayEventWatcher,
  type GatewayFrame,
  type OpenClawResult,
  type TestGateway,
} from "./harness.ts";

const PORT = 18_960;
const KEY = process.env.CURSOR_API_KEY?.trim();
const AGENT_A = "oac-signal-a";
const AGENT_B = "oac-signal-b";
const CONFIG_KEYS = ["agents.defaults.model.primary", "models.providers.mockapi"] as const;
/** A model can miss a step; a try that did is retried with new chats. Anything else fails at once. */
const TRIES = 3;

// The spec's success signal, as one scenario on a real Gateway (the epic's done-when), and AD-7:
//  1. an API-model turn tells agent A a code word;
//  2. a `cursor-cli` turn on the same OpenClaw chat answers with it (OpenClaw's `sessions_history` through the
//     MCP proxy), runs a shell command through OpenClaw's `exec`, and streams: the Gateway's operator stream
//     carries `chat` deltas of that run before its final;
//  3. its usage on the transcript is Cursor's own ledger numbers;
//  4. agent B, another agent with its own Cursor home, runs a turn at the same time and gets its own answer;
//  5. a resumed turn of A still knows the code word;
//  6. the plugin wrote nothing into either agent's workspace (AD-7).
// Needs `npm run dev:install` and CURSOR_API_KEY (the usage ledger needs a key). The code word, the nonce,
// and the exec marker are built at run time: the model reads test files, so no secret is written in one.
describeLive("success signal: API turn, then cursor-cli with tools, streaming, and usage, beside a second agent, writing nothing into a workspace (spec success signal, AD-7)", () => {
  // Created in beforeAll: a skipped describe still runs its body, and nothing would remove the dir.
  let root = "";
  let gateway: TestGateway | undefined;
  let watcher: GatewayEventWatcher | undefined;
  let mock: ChildProcess | undefined;
  let requestLog = "";
  const prior = new Map<string, string | undefined>();
  const agentsAdded: string[] = [];
  const stamp = Date.now();

  const workspaceOf = (agent: string) => join(root, `workspace-${agent}`);
  const homeOf = (agent: string) => join(ISOLATED_STATE_DIR, "agents", agent, "agent", "openclaw-all-cli", "cursor-cli");
  const chatsOf = (agent: string) => {
    const dir = join(homeOf(agent), "acp-sessions");
    return new Set(existsSync(dir) ? readdirSync(dir) : []);
  };
  const keyOf = (agent: string, session: string) => `agent:${agent}:explicit:${session}`;

  const secret = (prefix: string, bytes = 5) => `${prefix}-${randomBytes(bytes).toString("hex").toUpperCase()}`;

  /** Relative path, type, size, and sha256 of everything under a workspace, sorted. */
  function snapshot(dir: string): string[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        const stat = lstatOrUndefined(path);
        if (!stat) return `${relative(dir, path)}\tgone`;
        if (stat.isSymbolicLink()) return `${relative(dir, path)}\tlink`;
        if (stat.isDirectory()) return `${relative(dir, path)}\tdir`;
        return `${relative(dir, path)}\tfile\t${stat.size}\t${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
      })
      .sort();
  }
  const lstatOrUndefined = (path: string) => {
    try {
      return lstatSync(path);
    } catch {
      return undefined;
    }
  };

  type Turn = { status: number | null; raw: string; runId: string; reply: string; tools: string[] };

  function parseTurn(result: OpenClawResult): Turn {
    const raw = result.stdout + result.stderr;
    try {
      const json = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
        runId?: string;
        payloads?: Array<{ text?: string }>;
        result?: { payloads?: Array<{ text?: string }>; meta?: { toolSummary?: { tools?: string[] } } };
        meta?: { toolSummary?: { tools?: string[] } };
      };
      return {
        status: result.status,
        raw,
        runId: json.runId ?? "",
        reply: (json.payloads ?? json.result?.payloads ?? []).map((payload) => payload.text ?? "").join("\n"),
        tools: json.meta?.toolSummary?.tools ?? json.result?.meta?.toolSummary?.tools ?? [],
      };
    } catch {
      return { status: result.status, raw, runId: "", reply: result.stdout, tools: [] };
    }
  }

  /** One `openclaw agent` turn through the Gateway. */
  function startTurn(agent: string, session: string, message: string, model?: string): Promise<Turn> {
    return openclawAsync(
      ["agent", "--agent", agent, ...(model ? ["--model", model] : []), "--session-id", session, "--message", message, "--json", "--timeout", "240"],
      { env: gateway!.env, timeoutMs: 280_000 },
    ).then(parseTurn);
  }

  /** The newest `cursor-cli` assistant entry with usage in one OpenClaw session, read-only from the agent's SQLite. */
  function cursorEntry(agent: string, session: string): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | undefined {
    const db = new DatabaseSync(join(ISOLATED_STATE_DIR, "agents", agent, "agent", "openclaw-agent.sqlite"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq DESC").all(session) as Array<{ event_json: string }>;
      for (const row of rows) {
        const message = (JSON.parse(row.event_json) as { message?: { role?: string; provider?: string; usage?: Record<string, number> } }).message;
        if (message?.role === "assistant" && message.provider === "cursor-cli" && message.usage) return message.usage as never;
      }
    } finally {
      db.close();
    }
    return undefined;
  }

  const frameText = (frame: GatewayFrame): string =>
    ((frame.payload?.message?.content ?? []) as Array<{ type?: string; text?: string }>).map((part) => part.text ?? "").join("");

  function readConfig(key: string): string | undefined {
    const result = openclaw(["config", "get", key, "--json"]);
    return result.status === 0 ? result.stdout.trim() : undefined;
  }

  beforeAll(async () => {
    if (!KEY) return;
    root = mkdtempSync(join(tmpdir(), "oac-live-signal-"));
    mkdirSync(join(root, "markers"));
    requestLog = join(root, "mock-requests.jsonl");
    for (const key of CONFIG_KEYS) prior.set(key, readConfig(key));
    // The mock API model.
    mock = spawn(process.execPath, [MOCK_API_SCRIPT, requestLog], { stdio: ["ignore", "pipe", "inherit"] });
    const mockPort = await new Promise<number>((resolve, reject) => {
      mock!.once("error", reject);
      mock!.stdout!.on("data", (chunk: Buffer) => {
        const match = /listening (\d+)/.exec(chunk.toString("utf8"));
        if (match) resolve(Number(match[1]));
      });
    });
    const provider = JSON.stringify({ baseUrl: `http://127.0.0.1:${mockPort}/v1`, api: "openai-completions", apiKey: "sk-mock", models: [{ id: "echo", name: "echo" }] });
    expect(openclaw(["config", "set", "models.providers.mockapi", provider, "--strict-json"]).status).toBe(0);
    // The plugin loads at Gateway startup only when the config names it (OpenClaw #148584).
    expect(openclaw(["config", "set", "agents.defaults.model.primary", "cursor-cli/auto"]).status).toBe(0);
    // Two agents, each with its own workspace under the test's temp root.
    for (const agent of [AGENT_A, AGENT_B]) {
      mkdirSync(workspaceOf(agent), { recursive: true });
      const added = openclaw(["agents", "add", agent, "--non-interactive", "--workspace", workspaceOf(agent), "--model", "cursor-cli/auto"]);
      expect(added.status, added.stdout + added.stderr).toBe(0);
      agentsAdded.push(agent);
      // `agents add` seeds the bootstrap files: drop the first-run ritual.
      rmSync(join(workspaceOf(agent), "BOOTSTRAP.md"), { force: true });
      writeFileSync(join(workspaceOf(agent), "AGENTS.md"), "# Agent\nAnswer briefly.\n");
    }
    gateway = await startGateway(PORT);
    watcher = await watchGatewayEvents(PORT);
  }, 240_000);

  // Leave nothing behind: the watcher, the Gateway, the agents, the config keys, the mock, the temp dir.
  afterAll(async () => {
    watcher?.close();
    await gateway?.stop();
    for (const agent of agentsAdded) openclaw(["agents", "delete", agent, "--force"]);
    for (const key of CONFIG_KEYS) {
      if (!prior.has(key)) continue;
      const value = prior.get(key);
      if (value === undefined) openclaw(["config", "unset", key]);
      else openclaw(["config", "set", key, value, "--strict-json"]);
    }
    mock?.kill("SIGTERM");
    if (root) rmSync(root, { recursive: true, force: true });
  }, 240_000);

  /**
   * One try of the scenario with new chats. Returns the complaint when a model step missed (the caller
   * retries), `undefined` on success. A workspace change, a shared home, or a broken `cli-config.json`
   * fails the test at once.
   */
  async function attempt(n: number): Promise<string | undefined> {
    const session = `live-signal-${stamp}-${n}-a`;
    const sessionB = `live-signal-${stamp}-${n}-b`;
    const keyA = keyOf(AGENT_A, session);
    const keyB = keyOf(AGENT_B, sessionB);
    const code = secret("KIWI");
    const nonce = secret("NONCE", 6);
    const marker = join(root, "markers", `marker-${stamp}-${n}`);
    const complaints: string[] = [];
    const before = { a: snapshot(workspaceOf(AGENT_A)), b: snapshot(workspaceOf(AGENT_B)) };
    const chatsBefore = { a: chatsOf(AGENT_A), b: chatsOf(AGENT_B) };

    // The workspaces must hold exactly what they held, whichever way the try ends.
    const assertWorkspacesUntouched = () => {
      expect(snapshot(workspaceOf(AGENT_A)), "agent A's workspace changed (AD-7)").toEqual(before.a);
      expect(snapshot(workspaceOf(AGENT_B)), "agent B's workspace changed (AD-7)").toEqual(before.b);
    };

    // 1. An API turn gives agent A the code word.
    const api = await startTurn(AGENT_A, session, `Remember this: the code word is ${code}.`, "mockapi/echo");
    expect(api.status, api.raw).toBe(0);

    // 2. A cursor-cli turn on the same chat: look it up, run a command through OpenClaw's exec, and reply with both.
    const startOrder = watcher!.frames.length;
    const cursorTurn = startTurn(
      AGENT_A,
      session,
      `What was the code word I gave you earlier in this conversation? Then run this command with your shell tool: od -An -N8 -tx1 /dev/urandom | tr -d ' \\n' | tee ${marker}\nReply with the code word and the command's output.`,
      "cursor-cli/auto",
    );
    // 3. Once A's run streams, agent B runs a turn at the same time.
    const aStreams = await waitFor(() => watcher!.frames.some((frame) => frame.order > startOrder && frame.payload?.sessionKey === keyA), 120_000);
    const turnB = startTurn(AGENT_B, sessionB, `Reply with exactly: ${nonce}`);
    const a = await cursorTurn;
    const b = await turnB;
    if (!aStreams) complaints.push("no frame of A's run reached the operator stream while it ran");

    // Isolation (AD-6, AD-9): hard failures.
    const chatsA = [...chatsOf(AGENT_A)].filter((id) => !chatsBefore.a.has(id));
    const chatsB = [...chatsOf(AGENT_B)].filter((id) => !chatsBefore.b.has(id));
    if (a.status === 0 && b.status === 0) {
      expect(homeOf(AGENT_A)).not.toBe(homeOf(AGENT_B));
      expect(chatsA.length, `agent A's home holds no new chat\n${a.raw}`).toBeGreaterThan(0);
      expect(chatsB.length, `agent B's home holds no new chat\n${b.raw}`).toBeGreaterThan(0);
      for (const id of chatsA) expect(chatsOf(AGENT_B).has(id), `chat ${id} of agent A is in agent B's home`).toBe(false);
      for (const id of chatsB) expect(chatsOf(AGENT_A).has(id), `chat ${id} of agent B is in agent A's home`).toBe(false);
    }
    for (const agent of [AGENT_A, AGENT_B]) {
      const config = join(homeOf(agent), "cli-config.json");
      if (existsSync(config)) expect((JSON.parse(readFileSync(config, "utf8")) as { permissions: unknown }).permissions, `${agent}'s cli-config.json`).toEqual(CURSOR_PERMISSIONS);
    }
    assertWorkspacesUntouched();

    // Model-dependent steps: a miss makes the try a soft miss.
    if (a.status !== 0) complaints.push(`A's cursor-cli turn failed (status ${a.status})`);
    if (!a.reply.includes(code)) complaints.push(`A's reply lacks the code word: ${JSON.stringify(a.reply.slice(0, 300))}`);
    for (const tool of ["mcp__openclaw__sessions_history", "mcp__openclaw__exec"]) {
      if (!a.tools.includes(tool)) complaints.push(`A's tool summary lacks ${tool}: ${JSON.stringify(a.tools)}`);
    }
    const markerText = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
    if (!markerText) complaints.push("the exec marker file was not written");
    else if (!a.reply.includes(markerText)) complaints.push(`A's reply lacks the exec marker's content: ${JSON.stringify(a.reply.slice(0, 300))}`);

    // Streaming: chat deltas of A's cursor run, received after it started, before its final.
    const chat = watcher!.frames.filter((frame) => frame.event === "chat" && frame.order > startOrder && frame.payload?.runId === a.runId && a.runId !== "");
    const final = chat.find((frame) => frame.payload?.state === "final");
    const deltas = final ? chat.filter((frame) => frame.payload?.state === "delta" && frame.order < final.order) : [];
    if (!final) complaints.push(`no chat final frame for run ${a.runId || "(none)"} reached the operator stream`);
    else {
      if (deltas.length < 2) complaints.push(`only ${deltas.length} chat delta frame(s) before the final`);
      if (!frameText(final).includes(code)) complaints.push(`the final frame lacks the code word: ${JSON.stringify(frameText(final).slice(0, 300))}`);
    }

    // Agent B overlapped A and answered its nonce.
    if (b.status !== 0) complaints.push(`B's turn failed (status ${b.status})`);
    if (!b.reply.includes(nonce)) complaints.push(`B's reply lacks its nonce: ${JSON.stringify(b.reply.slice(0, 300))}`);
    const bFirst = watcher!.frames.find((frame) => frame.order > startOrder && frame.payload?.sessionKey === keyB);
    if (!bFirst || (final && bFirst.order > final.order)) complaints.push("B's run did not start before A's run ended");

    if (complaints.length > 0) return `try ${n}: ${complaints.join("; ")}\n--- A raw ---\n${a.raw.slice(-3000)}\n--- B raw ---\n${b.raw.slice(-1500)}`;

    process.stderr.write(
      `success signal, try ${n}: ${deltas.length} chat deltas before the final; tools=${JSON.stringify(a.tools)}; B overlapped (first B frame #${bFirst?.order}, A final #${final?.order})\n`,
    );

    // 4. Usage: Cursor's own numbers on A's transcript entry (a ledger failure is not a model miss).
    const usage = cursorEntry(AGENT_A, session);
    expect(usage, "agent A's transcript has no cursor-cli entry with usage").toBeDefined();
    expect(usage!.input, `usage ${JSON.stringify(usage)}`).toBeGreaterThan(0);
    expect(usage!.output, `usage ${JSON.stringify(usage)}`).toBeGreaterThan(0);
    expect(usage!.totalTokens).toBe(usage!.input + usage!.output + (usage!.cacheRead ?? 0) + (usage!.cacheWrite ?? 0));

    // 5. A resumed turn of A repeats the code word.
    const resumed = await startTurn(AGENT_A, session, "What is the code word? Answer with the word only.", "cursor-cli/auto");
    assertWorkspacesUntouched();
    if (resumed.status !== 0 || !resumed.reply.includes(code)) {
      return `try ${n}: the resumed turn did not repeat the code word (status ${resumed.status}): ${JSON.stringify(resumed.reply.slice(0, 300))}\n${resumed.raw.slice(-1500)}`;
    }
    return undefined;
  }

  it.skipIf(!KEY)(
    "answers from an earlier API turn, runs OpenClaw's exec, streams, reports usage, runs beside a second agent, and writes nothing into a workspace",
    async () => {
      const misses: string[] = [];
      for (let n = 0; n < TRIES; n += 1) {
        const miss = await attempt(n);
        if (miss === undefined) return;
        misses.push(miss);
      }
      expect.fail(`no usable try in ${TRIES}:\n${misses.join("\n=====\n")}`);
    },
    LIVE_TIMEOUT_MS * 3,
  );
});
