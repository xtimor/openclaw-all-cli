import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MUTATING_HOST_TOOLS } from "../../src/core/turn-prompt.ts";
import { ISOLATED_STATE_DIR, LIVE_TIMEOUT_MS, describeLive, openclaw, openclawAsync, openclawVersion, startGateway, type TestGateway } from "./harness.ts";

const PORT = 18_982;
/** The OpenClaw tools that change files and records, as the MCP proxy names them in `toolSummary`. */
const MUTATING = MUTATING_HOST_TOOLS.map((name) => `mcp__openclaw__${name}`);
/** The reporter's tool cap for an automation (#102): OpenClaw's own file tools, no `exec`. */
const CRON_TOOLS = "read,write,edit,apply_patch,sessions_history";

type Turn = { reply: string; tools: string[]; status: number | null; raw: string };
type MeterEntry = { kind?: string; pid?: number; tool?: string; status?: string };

// Issue #102 at the live tier, in the reporter's conditions: a run with no native tool selection (the `restricted`
// profile: native read, grep and glob closed) whose OpenClaw tool list holds OpenClaw's own `write` and `edit` and no
// `exec`. The model took Cursor's read-only `ask` mode for a read-only session and refused every write those tools
// allow, on turn 1 and on turn 2 of one process; a sentence in the prompt did not change that (0 of 12 live tries),
// so such a turn now runs in `agent` mode, with the native shell and write still denied by the profile. The ask names
// no tool. The evidence is on disk (the file and its unguessable content) and in the tools called, not in the
// model's words. No retry loop of its own: the live config's 3 tries are all it gets.
//
// Route to those conditions: `tools.fs.workspaceOnly: true`, an ordinary chat whose process lives across turns, on
// OpenClaw 2026.10.9 and later. OpenClaw 2026.10.3 does not narrow the tool selection for that setting (it serves
// `exec` there); its only route is an automation with a tool allow-list (`cron add --tools`), the reporter's own
// setup, whose every run gets a process of its own on that host. There the two turns are two runs of one cron session.
describeLive("a no-exec chat offered OpenClaw's file tools writes files (#102)", () => {
  let gateway: TestGateway | undefined;
  let priorWorkspaceOnly: string | undefined;
  const dir = join(ISOLATED_STATE_DIR, "workspace", "live-ask-mode");
  /** Set in `beforeAll`: the version is read only when the tier runs, never while a plain `npm test` collects the file. */
  let workspaceOnlyServed = false;

  const readConfig = (key: string) => {
    const result = openclaw(["config", "get", key, "--json"]);
    return result.status === 0 ? result.stdout.trim() : undefined;
  };
  const priorPrimary = { value: undefined as string | undefined };

  beforeAll(async () => {
    const [year, month, patch] = openclawVersion();
    workspaceOnlyServed = year * 10_000 + month * 100 + patch >= 20_261_009;
    // The cron route has no other record of the tools a run called: it needs the turn meter's log.
    if (!workspaceOnlyServed && !process.env.OAC_LIVE_TURN_LOG) {
      throw new Error(`on OpenClaw ${year}.${month}.${patch} this scenario needs the turn meter (OAC_LIVE_TURN_LOG): run it through scripts/regression.sh live`);
    }
    priorPrimary.value = readConfig("agents.defaults.model.primary");
    priorWorkspaceOnly = readConfig("tools.fs.workspaceOnly");
    expect(openclaw(["config", "set", "agents.defaults.model.primary", "cursor-cli/auto"]).status).toBe(0);
    if (workspaceOnlyServed) expect(openclaw(["config", "set", "tools.fs.workspaceOnly", "true", "--strict-json"]).status).toBe(0);
    mkdirSync(dir, { recursive: true });
    gateway = await startGateway(PORT);
  }, LIVE_TIMEOUT_MS);

  afterAll(async () => {
    await gateway?.stop();
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [
      ["agents.defaults.model.primary", priorPrimary.value],
      ["tools.fs.workspaceOnly", priorWorkspaceOnly],
    ] as const) {
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

  /** One run of a cron job whose message is the ask, on the cron session `session`; the tools come from the turn meter. */
  async function cronAsk(session: string, name: string, message: string, from: number): Promise<Turn> {
    const port = String(PORT);
    const added = openclaw(
      ["cron", "add", "--name", name, "--every", "1h", "--disabled", "--session", `session:${session}`, "--no-deliver"]
        .concat(["--message", message, "--tools", CRON_TOOLS, "--agent", "main", "--port", port, "--json"]),
      { timeoutMs: 60_000, env: gateway!.env },
    );
    expect(added.status, added.stdout + added.stderr).toBe(0);
    const job = JSON.parse(added.stdout.slice(added.stdout.indexOf("{"))) as { id?: string };
    try {
      const ran = await openclawAsync(["cron", "run", job.id!, "--wait", "--wait-timeout", "240s", "--port", port, "--json"], { timeoutMs: 280_000, env: gateway!.env });
      let reply = ran.stdout;
      let ok = false;
      try {
        const json = JSON.parse(ran.stdout.slice(ran.stdout.indexOf("{"))) as { status?: string; run?: { status?: string; summary?: string; error?: string } };
        ok = json.status === "ok" || json.run?.status === "ok";
        reply = json.run?.summary ?? json.run?.error ?? ran.stdout;
      } catch {
        // The raw output is the evidence.
      }
      const tools = meterEntries(from).filter((entry) => entry.kind === "tool" && entry.status === "completed").map((entry) => `mcp__openclaw__${entry.tool}`);
      return { reply, tools, status: ok ? 0 : (ran.status ?? 1), raw: ran.stdout + ran.stderr };
    } finally {
      openclaw(["cron", "rm", job.id!, "--port", port, "--json"], { timeoutMs: 60_000, env: gateway!.env });
    }
  }

  /** The turn meter's log (the live tier's) from line `from` on. */
  const meterEntries = (from: number): MeterEntry[] => {
    const log = process.env.OAC_LIVE_TURN_LOG;
    if (!log || !existsSync(log)) return [];
    return readFileSync(log, "utf8").split("\n").filter(Boolean).slice(from).map((line) => JSON.parse(line) as MeterEntry);
  };
  const promptPids = (from: number): number[] => [...new Set(meterEntries(from).filter((entry) => entry.kind === "prompt" && typeof entry.pid === "number").map((entry) => entry.pid!))];
  const logLines = () => {
    const log = process.env.OAC_LIVE_TURN_LOG;
    return log && existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  };

  it(
    "#102: a file asked for without naming a tool is written through an OpenClaw tool, on turn 1 and turn 2 of one process",
    async () => {
      const id = randomBytes(6).toString("hex");
      const sessionId = `live-ask-${id}`;
      const pids: number[][] = [];
      for (const turn of [1, 2]) {
        const file = join(dir, `note-${id}-${turn}.txt`);
        const content = randomBytes(8).toString("hex");
        const from = logLines();
        const message = `Please create the file ${file} with exactly this content and nothing else: ${content}\nThen tell me when it is done.`;
        const answer = workspaceOnlyServed ? await ask(sessionId, message) : await cronAsk(sessionId, `live-ask-${id}-${turn}`, message, from);
        const evidence = `turn ${turn} (${workspaceOnlyServed ? "workspaceOnly chat" : "cron run"}; tools: ${answer.tools.join(", ") || "none"}); reply: ${answer.reply.slice(0, 600)}`;
        expect(answer.raw, "OpenClaw's budget compaction failed the turn (not #102)").not.toMatch(/transcript compaction failed/);
        expect(answer.status, `${evidence}\n${answer.raw.slice(-2_000)}`).toBe(0);
        expect(answer.tools.filter((tool) => tool === "mcp__openclaw__exec"), `exec was served: not a no-exec turn; ${evidence}`).toEqual([]);
        expect(existsSync(file), `the file was never written; ${evidence}`).toBe(true);
        expect(readFileSync(file, "utf8").trim(), evidence).toBe(content);
        expect(answer.tools.some((tool) => MUTATING.includes(tool)), `no OpenClaw tool that changes files was called; ${evidence}`).toBe(true);
        pids.push(promptPids(from));
      }
      // With the turn meter (the live tier): one cursor-agent process per turn, and in a chat the same one for both.
      if (process.env.OAC_LIVE_TURN_LOG) {
        expect(pids[0]!.length, JSON.stringify(pids)).toBe(1);
        expect(pids[1]!.length, JSON.stringify(pids)).toBe(1);
        // OpenClaw 2026.10.3 gives every cron run a process of its own: there is no turn 2 of one process to check.
        if (workspaceOnlyServed) expect(pids[1], JSON.stringify(pids)).toEqual(pids[0]);
      }
    },
    LIVE_TIMEOUT_MS * 2,
  );
});
