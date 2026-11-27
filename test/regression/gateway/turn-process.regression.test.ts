import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openclaw, replyLines, waitFor } from "../../live/harness.ts";
import {
  CURSOR_COMMAND_KEY,
  REGRESSION_TIMEOUT_MS,
  configure,
  describeRegression,
  chatPids,
  fakeAlive,
  fakeCommand,
  finishRegression,
  freePort,
  gatewayAgentTurn,
  gatewayCall,
  gatewayLog,
  linesOf,
  readFakeLog,
  startRegressionGateway,
  type FakeCommand,
  type RegressionGateway,
} from "../harness.ts";

// Gateway scenarios for past process bugs (epic-regression-gate ticket 3): how many cursor-agent processes a chat
// gets, when its process ends, and which permission profile it runs under. One Gateway for the file, the packed
// plugin, fake-cursor-agent as the CLI. Run with `scripts/regression.sh gateway [--openclaw <version>]`.
describeRegression("Gateway scenarios: cursor-agent processes per chat", () => {
  let root: string | undefined;
  let fake: FakeCommand | undefined;
  let gateway: RegressionGateway | undefined;
  let stopGateway: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oac-regression-process-"));
    // A chat store gives every Cursor chat its own ID, as real Cursor does. Without it each fake process names its first
    // chat `fake-session-1`, and the plugin's chat registry closes the process that held that ID before (one process per chat).
    mkdirSync(join(root, "store"));
    fake = fakeCommand(root, "cursor-agent", { FAKE_CURSOR_STORE: join(root, "store") });
    configure({ [CURSOR_COMMAND_KEY]: fake.command, "agents.defaults.model.primary": "cursor-cli/auto" });
    gateway = await startRegressionGateway(await freePort(), { logFile: join(root, "gateway.log"), onStarted: (stop) => (stopGateway = stop) });
  }, REGRESSION_TIMEOUT_MS);

  afterAll(() => finishRegression({ stop: stopGateway, fakes: [fake], root }), 120_000);

  const nonce = () => randomUUID().slice(0, 8);
  const turnOutput = (run: { status: number | null; stdout: string; stderr: string }) =>
    `exit ${run.status}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`;
  const fakeLines = (from: number) => readFakeLog(fake!.log).slice(from);
  const describeLines = (lines: ReturnType<typeof readFakeLog>) =>
    lines.map((line) => `${line.method ?? line.event}${line.params?.sessionId ? ` ${line.params.sessionId}` : ""}${line.pid ? ` pid=${line.pid}` : ""}`).join("\n");

  // #11: OpenClaw hashed the per-turn MCP settings path into its live-session fingerprint, so every turn restarted
  // cursor-agent and resumed with session/load (15-20 s to the first token). #38 asked for one warm process per chat
  // from the first turn on. The Gateway's catalog is loaded before the first turn (startRegressionGateway), so the
  // host's image-support reading does not change between turn 1 and turn 2 (MEMORY, turn-2 restart).
  it(
    "#11/#38: two `openclaw agent` turns of one session run on one cursor-agent process with no session/load",
    async () => {
      const id = nonce();
      const sessionId = `regression-warm-${id}`;
      const logFrom = readFakeLog(fake!.log).length;
      const hostLogFrom = gatewayLog(gateway!).length;
      const first = await gatewayAgentTurn(gateway!.port, sessionId, `say:warm${id}a`);
      expect(first.status, turnOutput(first)).toBe(0);
      expect(replyLines(first.stdout), turnOutput(first)).toEqual([`warm${id}a`]);
      const second = await gatewayAgentTurn(gateway!.port, sessionId, `say:warm${id}b`);
      expect(second.status, turnOutput(second)).toBe(0);
      expect(replyLines(second.stdout), turnOutput(second)).toEqual([`warm${id}b`]);

      const lines = fakeLines(logFrom);
      // The chat's processes are the ones its prompts reached; the catalog's model listing opens ACP processes and
      // sessions of its own (`initialize`, `session/new`) at any time, so those lines alone do not name a chat process.
      const chats = chatPids(lines, `say:warm${id}`);
      const hostLines = gatewayLog(gateway!)
        .slice(hostLogFrom)
        .split("\n")
        .filter((line) => line.includes("cli exec") || line.includes("cli live session"));
      const evidence = `fake log:\n${describeLines(lines)}\n--- Gateway log (cli lines):\n${hostLines.join("\n")}`;
      expect(chats, `processes that got this session's prompts: ${chats.join(",")}\n${evidence}`).toHaveLength(1);
      const chatLines = linesOf(lines, chats[0]!);
      const count = (method: string) => chatLines.filter((line) => line.method === method).length;
      expect(count("initialize"), evidence).toBe(1);
      expect(count("session/new"), evidence).toBe(1);
      // No process resumed a chat: the model listing never loads one, so this holds for every process in the window.
      expect(lines.filter((line) => line.method === "session/load"), evidence).toEqual([]);
      const prompts = chatLines.filter((line) => line.method === "session/prompt");
      expect(prompts, evidence).toHaveLength(2);
      expect(prompts[1]!.params?.sessionId, evidence).toBe(prompts[0]!.params?.sessionId);
      // The host's own record of the same: one live session start for the two turns.
      expect(hostLines.filter((line) => line.includes("cli live session start")), evidence).toHaveLength(1);
    },
    REGRESSION_TIMEOUT_MS,
  );

  // #74: a finished conversation (here a reset through the Gateway) kept its pooled cursor-agent until the
  // 15-minute idle close, because the plugin did not listen to the host's `session_end`.
  it(
    "#74: `sessions.reset` of a chat ends that chat's cursor-agent process and leaves another chat's running",
    async () => {
      const id = nonce();
      const ended = `regression-ended-${id}`;
      const kept = `regression-kept-${id}`;
      const logFrom = readFakeLog(fake!.log).length;
      const endedTurn = await gatewayAgentTurn(gateway!.port, ended, `say:ended${id}`);
      expect(endedTurn.status, turnOutput(endedTurn)).toBe(0);
      const keptTurn = await gatewayAgentTurn(gateway!.port, kept, `say:kept${id}`);
      expect(keptTurn.status, turnOutput(keptTurn)).toBe(0);
      // Each chat's process is the one its prompt reached (not a model-listing process started in between).
      const endedPids = chatPids(fakeLines(logFrom), `say:ended${id}`);
      const keptPids = chatPids(fakeLines(logFrom), `say:kept${id}`);
      const pidEvidence = () =>
        `ended chat pids ${endedPids.join(",")} alive=${endedPids.map(fakeAlive).join(",")}; kept chat pids ${keptPids.join(",")} alive=${keptPids.map(fakeAlive).join(",")}`;
      expect(endedPids, pidEvidence()).toHaveLength(1);
      expect(keptPids, pidEvidence()).toHaveLength(1);
      expect(fakeAlive(endedPids[0]!), pidEvidence()).toBe(true);

      const reset = gatewayCall(gateway!.port, "sessions.reset", { key: `agent:main:explicit:${ended}` });
      expect(reset?.ok, JSON.stringify(reset)).toBe(true);
      // The pool's own idle close is 15 minutes; the hook closes the process at once (SIGTERM, then SIGKILL).
      await waitFor(() => !fakeAlive(endedPids[0]!), 20_000, 250);
      expect(fakeAlive(endedPids[0]!), `${pidEvidence()} (20 s after sessions.reset)`).toBe(false);
      expect(fakeAlive(keptPids[0]!), pidEvidence()).toBe(true);
    },
    REGRESSION_TIMEOUT_MS,
  );

  // #67: a run whose tool policy leaves no native tool was refused before any process started ("cursor-cli keeps
  // native read, grep, glob on ..."). An automation with a tool allow-list (`cron add --tools`) is such a run on
  // every supported OpenClaw: the host passes it an empty native selection, and the plugin serves it with its
  // `restricted` permission profile.
  it(
    "#67: a run with an empty native selection (an automation with a tool allow-list) runs on the restricted profile",
    async () => {
      const id = nonce();
      const port = String(gateway!.port);
      const logFrom = readFakeLog(fake!.log).length;
      const added = openclaw(
        ["cron", "add", "--name", `regression-restricted-${id}`, "--every", "1h", "--disabled", "--session", "isolated", "--no-deliver"]
          .concat(["--message", `say:restricted${id}`, "--tools", "sessions_history", "--agent", "main", "--port", port, "--json"]),
        { timeoutMs: 60_000 },
      );
      expect(added.status, turnOutput(added)).toBe(0);
      const job = JSON.parse(added.stdout.slice(added.stdout.indexOf("{"))) as { id?: string; payload?: { toolsAllow?: string[] } };
      expect(job.id, added.stdout).toBeTypeOf("string");
      let ran: ReturnType<typeof openclaw>;
      let runs: ReturnType<typeof openclaw>;
      let removed: ReturnType<typeof openclaw>;
      try {
        expect(job.payload?.toolsAllow, added.stdout).toEqual(["sessions_history"]);
        ran = openclaw(["cron", "run", job.id!, "--wait", "--wait-timeout", "120s", "--port", port, "--json"], { timeoutMs: 180_000 });
        runs = openclaw(["cron", "runs", "--id", job.id!, "--port", port, "--json"], { timeoutMs: 60_000 });
      } finally {
        // The job lives in the tier's shared state, which later files reuse: remove it however the run went.
        removed = openclaw(["cron", "rm", job.id!, "--port", port, "--json"], { timeoutMs: 60_000 });
        if (removed.status !== 0) console.warn(`cron rm ${job.id} failed: ${turnOutput(removed)}`);
      }
      expect(removed.status, `cron rm ${job.id}: ${turnOutput(removed)}`).toBe(0);
      const lines = fakeLines(logFrom);
      const evidence = `cron run: ${turnOutput(ran)}\n--- cron runs: ${runs.stdout.slice(0, 3_000)}\n--- fake log:\n${describeLines(lines)}`;
      expect(ran.status, evidence).toBe(0);
      const entry = (JSON.parse(runs.stdout.slice(runs.stdout.indexOf("{"))) as { entries?: Array<{ status?: string; summary?: string }> }).entries?.[0];
      expect(entry?.status, evidence).toBe("ok");
      expect(entry?.summary, evidence).toBe(`restricted${id}`);

      // The run's process is the one its prompt reached; a model-listing process may start in the same window.
      const chats = chatPids(lines, `say:restricted${id}`);
      expect(chats, `processes that got the run's prompt: ${chats.join(",")}\n${evidence}`).toHaveLength(1);
      const opened = linesOf(lines, chats[0]!).filter((line) => line.method === "initialize");
      expect(opened, evidence).toHaveLength(1);
      const configDir = (opened[0]!.env as { CURSOR_CONFIG_DIR?: string } | undefined)?.CURSOR_CONFIG_DIR ?? "";
      const home = join(process.env.SPIKE_DIR!, "state", "agents", "main", "agent", "openclaw-all-cli", "cursor-cli");
      expect(configDir, evidence).toBe(join(home, "profiles", "restricted"));
      const config = join(configDir, "cli-config.json");
      expect(existsSync(config), `${config} is missing\n${evidence}`).toBe(true);
      const permissions = (JSON.parse(readFileSync(config, "utf8")) as { permissions?: { deny?: string[] } }).permissions;
      expect(permissions?.deny, readFileSync(config, "utf8")).toContain("Read(*)");
    },
    REGRESSION_TIMEOUT_MS,
  );
});
