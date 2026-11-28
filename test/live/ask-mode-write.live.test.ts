import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { gatewayCall } from "../regression/harness.ts";
import { ISOLATED_STATE_DIR, LIVE_TIMEOUT_MS, describeLive, openclaw, openclawAsync, startGateway, type TestGateway } from "./harness.ts";

const PORT = 18_982;
const CONFIG_KEYS = ["agents.defaults.model.primary"] as const;
/** The OpenClaw tools that change files and records (MUTATING_HOST_TOOLS in src/core/turn-prompt.ts), as the MCP proxy names them. */
const MUTATING = ["write", "edit", "apply_patch", "file_write", "workboard_create", "workboard_comment", "wiki_apply"].map((name) => `mcp__openclaw__${name}`);

type Turn = { reply: string; tools: string[]; status: number | null; raw: string };

// Issue #102 at the live tier: without OpenClaw's `exec` (a session whose exec host is `node`, as the Gateway scenario
// in test/regression/gateway/reply-prompt.regression.test.ts sets it) the turn runs in Cursor's `ask` mode, which has
// no edit tool, and the model took that for a read-only session and refused writes the OpenClaw tools allow, on turn 1
// and again on turn 2 of one process. The plugin now tells every prompt of such a process that the chat is not
// read-only and names the tools that change things. The ask names no tool, so only that sentence can lead the model to
// one. The evidence is on disk (the file and its unguessable content) and in the turn's tool list, not in the model's
// words. No retry loop of its own: the live config's 3 tries are all it gets.
describeLive("an ask-mode chat is not read-only (#102)", () => {
  let gateway: TestGateway | undefined;
  const prior = new Map<string, string | undefined>();
  const dir = join(ISOLATED_STATE_DIR, "workspace", "live-ask-mode");

  const readConfig = (key: string) => {
    const result = openclaw(["config", "get", key, "--json"]);
    return result.status === 0 ? result.stdout.trim() : undefined;
  };

  beforeAll(async () => {
    for (const key of CONFIG_KEYS) prior.set(key, readConfig(key));
    expect(openclaw(["config", "set", "agents.defaults.model.primary", "cursor-cli/auto"]).status).toBe(0);
    mkdirSync(dir, { recursive: true });
    gateway = await startGateway(PORT);
  }, LIVE_TIMEOUT_MS);

  afterAll(async () => {
    await gateway?.stop();
    rmSync(dir, { recursive: true, force: true });
    for (const key of CONFIG_KEYS) {
      const value = prior.get(key);
      if (value === undefined) openclaw(["config", "unset", key]);
      else openclaw(["config", "set", key, value, "--strict-json"]);
    }
  }, 120_000);

  /** One `openclaw agent` turn through the Gateway, with the tools it called. */
  async function ask(sessionId: string, message: string): Promise<Turn> {
    const result = await openclawAsync(["agent", "--session-id", sessionId, "--message", message, "--json", "--timeout", "240"], {
      env: gateway!.env,
      timeoutMs: 280_000,
    });
    let reply = "";
    let tools: string[] = [];
    try {
      const json = JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
        payloads?: Array<{ text?: string }>;
        result?: { payloads?: Array<{ text?: string }>; meta?: { toolSummary?: { tools?: string[] } } };
        meta?: { toolSummary?: { tools?: string[] } };
      };
      reply = (json.payloads ?? json.result?.payloads ?? []).map((payload) => payload.text ?? "").join("\n");
      tools = json.meta?.toolSummary?.tools ?? json.result?.meta?.toolSummary?.tools ?? [];
    } catch {
      reply = result.stdout;
    }
    return { reply, tools, status: result.status, raw: result.stdout + result.stderr };
  }

  /** The cursor-agent processes that took a prompt since `from` lines of the turn meter's log (the live tier's). */
  const promptPids = (from: number): number[] => {
    const log = process.env.OAC_LIVE_TURN_LOG;
    if (!log || !existsSync(log)) return [];
    const entries = readFileSync(log, "utf8").split("\n").filter(Boolean).slice(from).map((line) => JSON.parse(line) as { kind?: string; pid?: number });
    return [...new Set(entries.filter((entry) => entry.kind === "prompt" && typeof entry.pid === "number").map((entry) => entry.pid!))];
  };
  const logLines = () => {
    const log = process.env.OAC_LIVE_TURN_LOG;
    return log && existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  };

  it(
    "#102: in ask mode a file asked for without naming a tool is written through an OpenClaw tool, on turn 1 and turn 2 of one process",
    async () => {
      const id = randomBytes(6).toString("hex");
      const sessionId = `live-ask-${id}`;
      const key = `agent:main:explicit:${sessionId}`;
      const patched = gatewayCall(PORT, "sessions.patch", { key, execHost: "node" });
      expect(patched?.entry?.execHost, JSON.stringify(patched)).toBe("node");
      const pids: number[][] = [];
      for (const turn of [1, 2]) {
        const file = join(dir, `note-${id}-${turn}.txt`);
        const content = randomBytes(8).toString("hex");
        const from = logLines();
        const answer = await ask(sessionId, `Please create the file ${file} with exactly this content and nothing else: ${content}\nThen tell me when it is done.`);
        const evidence = `turn ${turn} (tools: ${answer.tools.join(", ") || "none"}); reply: ${answer.reply.slice(0, 600)}`;
        expect(answer.raw, "OpenClaw's budget compaction failed the turn (not #102)").not.toMatch(/transcript compaction failed/);
        expect(answer.status, answer.raw.slice(-2_000)).toBe(0);
        expect(answer.tools.filter((tool) => tool === "mcp__openclaw__exec"), `exec was served: not an ask-mode turn; ${evidence}`).toEqual([]);
        expect(existsSync(file), `the file was never written; ${evidence}`).toBe(true);
        expect(readFileSync(file, "utf8").trim(), evidence).toBe(content);
        expect(answer.tools.some((tool) => MUTATING.includes(tool)), `no OpenClaw tool that changes files was called; ${evidence}`).toBe(true);
        pids.push(promptPids(from));
      }
      // With the turn meter (the live tier), both turns ran on one cursor-agent process.
      if (process.env.OAC_LIVE_TURN_LOG) {
        expect(pids[0]!.length, JSON.stringify(pids)).toBe(1);
        expect(pids[1], JSON.stringify(pids)).toEqual(pids[0]);
      }
    },
    LIVE_TIMEOUT_MS * 2,
  );
});
