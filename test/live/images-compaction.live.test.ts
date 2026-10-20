import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FAKE_CURSOR_AGENT, MOCK_API_SCRIPT } from "../fixtures/paths.ts";
import { ISOLATED_CONFIG_PATH, ISOLATED_STATE_DIR, LIVE_TIMEOUT_MS, describeLive, openclaw, startGateway, type TestGateway } from "./harness.ts";
import { randomWord, wordPng } from "./png-word.ts";

const PORT = 18_941;

// Parity rows P13 (images) and P14 (compaction). Real Cursor reads a PNG that holds a random word
// without a native file read, and recalls it in a later turn of the same chat. A fake agent shows
// what reaches the CLI (a text block without the host's cache path, and one image block). Through a
// Gateway with a mock API compaction model, `sessions compact` drops the Cursor chat, the next turn
// opens a fresh one, and the model still learns the earlier fact. Run `npm run dev:install` first;
// the real turns need a Cursor login or CURSOR_API_KEY.
describeLive("images and compaction (P13, P14)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-live-images-"));
  const CONFIG_COMMAND = "plugins.entries.openclaw-all-cli.config.cursor-cli.command";
  const stamp = Date.now();
  const agent = "oac-images";
  const workspace = join(root, "workspace");
  const written: string[] = [];
  const requestLog = join(root, "mock-requests.jsonl");
  const acpSessions = join(ISOLATED_STATE_DIR, "agents", agent, "agent", "openclaw-all-cli", "cursor-cli", "acp-sessions");
  let gateway: TestGateway | undefined;
  let mock: ChildProcess | undefined;
  let priorPrimary: string | undefined;
  let compactionKeys: string[] | undefined;
  let mockConfigured = false;

  beforeAll(() => {
    mkdirSync(workspace, { recursive: true });
    expect(openclaw(["agents", "add", agent, "--non-interactive", "--workspace", workspace, "--model", "cursor-cli/auto"]).status).toBe(0);
    // `agents add` seeds the bootstrap files: drop the first-run ritual.
    rmSync(join(workspace, "BOOTSTRAP.md"), { force: true });
    writeFileSync(join(workspace, "AGENTS.md"), "# Agent\nAnswer briefly.\n");
    written.push("AGENTS.md");
    for (const name of readdirSync(workspace)) if (!written.includes(name)) written.push(name);
  }, 120_000);

  afterAll(async () => {
    await gateway?.stop();
    openclaw(["config", "unset", CONFIG_COMMAND]);
    if (mockConfigured) {
      openclaw(["config", "unset", "models.providers.mockapi"]);
      // `config get` reports defaults, so read what the file itself holds: leave no empty `compaction` object behind.
      openclaw(["config", "unset", "agents.defaults.compaction.model"]);
      if (compactionKeys === undefined && authoredCompactionKeys()?.length === 0) openclaw(["config", "unset", "agents.defaults.compaction"]);
      if (priorPrimary) openclaw(["config", "set", "agents.defaults.model.primary", priorPrimary]);
      else openclaw(["config", "unset", "agents.defaults.model.primary"]);
    }
    openclaw(["agents", "delete", agent, "--force"]);
    mock?.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }, 180_000);

  /** The keys the config file holds under `agents.defaults.compaction`, or undefined when it holds none. */
  function authoredCompactionKeys(): string[] | undefined {
    try {
      const config = JSON.parse(readFileSync(ISOLATED_CONFIG_PATH, "utf8")) as { agents?: { defaults?: { compaction?: Record<string, unknown> } } };
      const compaction = config.agents?.defaults?.compaction;
      return compaction ? Object.keys(compaction) : undefined;
    } catch {
      return undefined;
    }
  }

  type Turn = { reply: string; tools: string[]; status: number | null; raw: string };

  function parse(run: { status: number | null; stdout: string; stderr: string }): Turn {
    let reply = "";
    let tools: string[] = [];
    try {
      const json = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"))) as {
        payloads?: Array<{ text?: string }>;
        result?: { payloads?: Array<{ text?: string }>; meta?: { toolSummary?: { tools?: string[] } } };
        meta?: { toolSummary?: { tools?: string[] } };
      };
      reply = (json.payloads ?? json.result?.payloads ?? []).map((payload) => payload.text ?? "").join("\n");
      tools = json.meta?.toolSummary?.tools ?? json.result?.meta?.toolSummary?.tools ?? [];
    } catch {
      reply = run.stdout;
    }
    return { reply, tools, status: run.status, raw: run.stdout + run.stderr };
  }

  function ask(session: string, message: string): Turn {
    return parse(
      openclaw(["agent", "--local", "--agent", agent, "--session-id", session, "--message", message, "--json", "--timeout", "240"], {
        timeoutMs: 280_000,
      }),
    );
  }

  const readers = (turn: Turn) => turn.tools.filter((name) => ["read", "grep", "glob"].includes(name));
  // The file name has nothing to do with the word, and the word is in no text: only the pixels carry it.
  const writePng = (word: string): { file: string; bytes: Buffer } => {
    const bytes = wordPng(word);
    const name = `img-${randomBytes(6).toString("hex")}.png`;
    const file = join(workspace, name);
    writeFileSync(file, bytes);
    written.push(name);
    return { file, bytes };
  };

  // A model can answer wrong once, so the image step gets up to three tries, each with a new word and chat.
  const TRIES = 3;
  let chat = "";
  let chatWord = "";

  it("reads a word from an image without a native file read (a)", () => {
    const seen: string[] = [];
    for (let n = 0; n < TRIES; n += 1) {
      const word = randomWord();
      const { file } = writePng(word);
      chat = `live-images-${stamp}-${n}`;
      const question = (path: string) => `What word is written in the image ${path}? Reply with the word only. Do not use any tools.`;
      // Control: the same prompt naming a file that does not exist attaches no image, and must not yield the word.
      const control = ask(`${chat}-control`, question(join(workspace, `img-${randomBytes(6).toString("hex")}.png`)));
      expect(control.status, control.raw).toBe(0);
      expect(control.reply.toUpperCase(), "the word must not be derivable without the image").not.toContain(word);
      const turn = ask(chat, question(file));
      expect(turn.status, turn.raw).toBe(0);
      if (turn.reply.toUpperCase().includes(word) && readers(turn).length === 0) {
        chatWord = word;
        return;
      }
      seen.push(`want=${word} reply=${JSON.stringify(turn.reply)} tools=${turn.tools.join(",")}`);
    }
    expect.fail(`no try read the word without a native read: ${seen.join(" | ")}`);
  }, LIVE_TIMEOUT_MS * TRIES);

  it("recalls the image in a later turn of the same chat, with no read (b)", () => {
    expect(chatWord, "step (a) must pass first").toBeTruthy();
    const seen: string[] = [];
    for (let n = 0; n < TRIES; n += 1) {
      const turn = ask(chat, "What word was in the image I sent before? Reply with the word only. Do not use any tools.");
      expect(turn.status, turn.raw).toBe(0);
      if (turn.reply.toUpperCase().includes(chatWord) && readers(turn).length === 0) return;
      seen.push(`reply=${JSON.stringify(turn.reply)} tools=${turn.tools.join(",")}`);
    }
    expect.fail(`no try recalled the word: ${seen.join(" | ")}`);
  }, LIVE_TIMEOUT_MS * TRIES);

  it("leaves only the files the test wrote in the workspace (c)", () => {
    expect(readdirSync(workspace).sort()).toEqual([...new Set(written)].sort());
    expect(existsSync(join(workspace, ".openclaw-cli-images"))).toBe(false);
    expect(existsSync(join(workspace, ".cursor"))).toBe(false);
  });

  it("leaves no image file in the agent's home (c2)", () => {
    const stray: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name.includes("openclaw-cli-images")) stray.push(join(dir, entry.name));
          walk(join(dir, entry.name));
        } else if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(entry.name)) stray.push(join(dir, entry.name));
      }
    };
    walk(join(ISOLATED_STATE_DIR, "agents", agent, "agent"));
    expect(stray).toEqual([]);
  });

  it("hands the CLI a text block without the cache path and one PNG block (d)", () => {
    const log = join(root, "fake.jsonl");
    const shim = join(root, "fake-cursor.sh");
    writeFileSync(shim, `#!/bin/sh\nexport FAKE_CURSOR_LOG="${log}"\nexec "${process.execPath}" "${FAKE_CURSOR_AGENT}" "$@"\n`);
    chmodSync(shim, 0o755);
    expect(openclaw(["config", "set", CONFIG_COMMAND, shim]).status).toBe(0);
    try {
      const { file, bytes } = writePng(randomWord());
      const turn = ask(`live-images-fake-${stamp}`, `What word is written in the image ${file}? Reply with the word only.`);
      expect(turn.status, turn.raw).toBe(0);
      type Block = { type: string; text?: string; mimeType?: string; bytes?: number };
      const prompts = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params?: { prompt?: Block[] } })
        .filter((entry) => entry.method === "session/prompt")
        .map((entry) => entry.params!.prompt!);
      expect(prompts).toHaveLength(1);
      const blocks = prompts[0]!;
      for (const block of blocks.filter((item) => item.type === "text")) expect(block.text).not.toContain("openclaw-cli-images");
      const images = blocks.filter((block) => block.type === "image");
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({ mimeType: "image/png", bytes: bytes.length });
    } finally {
      openclaw(["config", "unset", CONFIG_COMMAND]);
    }
  }, LIVE_TIMEOUT_MS);

  it("compacts with an API model, opens a fresh Cursor chat, and keeps the fact (e)", async () => {
    const fact = `KW-${stamp}`;
    // The mock API answers every request with a fixed reply: as the compaction model its reply is the summary.
    mock = spawn(process.execPath, [MOCK_API_SCRIPT, requestLog], {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, MOCK_API_REPLY: `Summary of the conversation: the user asked to remember the code word ${fact}.` },
    });
    const port = await new Promise<number>((resolve, reject) => {
      mock!.once("error", reject);
      mock!.stdout!.on("data", (chunk: Buffer) => {
        const match = /listening (\d+)/.exec(chunk.toString("utf8"));
        if (match) resolve(Number(match[1]));
      });
    });
    const provider = JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "sk-mock", models: [{ id: "echo", name: "echo" }] });
    const prior = openclaw(["config", "get", "agents.defaults.model.primary", "--json"]);
    priorPrimary = prior.status === 0 && prior.stdout.trim().startsWith('"') ? (JSON.parse(prior.stdout.trim()) as string) : undefined;
    compactionKeys = authoredCompactionKeys();
    mockConfigured = true;
    expect(openclaw(["config", "set", "models.providers.mockapi", provider, "--strict-json"]).status).toBe(0);
    expect(openclaw(["config", "set", "agents.defaults.compaction.model", "mockapi/echo"]).status).toBe(0);
    // The plugin loads at Gateway start only when the config names it as the default model.
    expect(openclaw(["config", "set", "agents.defaults.model.primary", "cursor-cli/auto"]).status).toBe(0);
    gateway = await startGateway(PORT);

    const id = `live-images-compact-${stamp}`;
    const viaGateway = (message: string) =>
      parse(openclaw(["agent", "--agent", agent, "--model", "cursor-cli/auto", "--session-id", id, "--message", message, "--json"], { env: gateway!.env, timeoutMs: 280_000 }));
    const first = viaGateway(`Remember the code word ${fact}. Reply ok.`);
    expect(first.status, first.raw).toBe(0);

    const compact = openclaw(["sessions", "compact", `agent:${agent}:explicit:${id}`, "--json"], { env: gateway.env, timeoutMs: 120_000 });
    expect(compact.status, compact.stdout + compact.stderr).toBe(0);
    expect(JSON.parse(compact.stdout.slice(compact.stdout.indexOf("{")))).toMatchObject({ compacted: true });

    const chatsBefore = new Set(existsSync(acpSessions) ? readdirSync(acpSessions) : []);
    const second = viaGateway("What code word did I ask you to remember? Reply with it only.");
    expect(second.status, second.raw).toBe(0);
    expect(second.reply).toContain(fact);
    const added = readdirSync(acpSessions).filter((name) => !chatsBefore.has(name));
    expect(added, `new chat dirs: ${JSON.stringify(added)}`).toHaveLength(1);
  }, LIVE_TIMEOUT_MS * 3);
});
