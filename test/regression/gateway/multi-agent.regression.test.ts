import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { waitFor } from "../../live/harness.ts";
import {
  CURSOR_COMMAND_KEY,
  REGRESSION_TIMEOUT_MS,
  chatPids,
  configure,
  describeRegression,
  fakeAlive,
  fakeCommand,
  finishRegression,
  freePort,
  gatewayAgentTurn,
  gatewayCall,
  isolatedState,
  readFakeLog,
  startRegressionGateway,
  type FakeCommand,
  type IsolatedState,
  type RegressionGateway,
} from "../harness.ts";

// Gateway scenarios with a second agent in the config. The config outlives a file, and a second agent changes how
// every later Gateway loads the plugin (MEMORY: never add agents to the tier's shared state), so this file runs on a
// state of its own (`isolatedState`). Run with `scripts/regression.sh gateway [--openclaw <version>]`.
describeRegression("Gateway scenarios: a config with a second agent", () => {
  let state: IsolatedState | undefined;
  let root: string | undefined;
  let fake: FakeCommand | undefined;
  let gateway: RegressionGateway | undefined;
  let stopGateway: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    state = isolatedState("two-agents");
    root = mkdtempSync(join(tmpdir(), "oac-regression-agents-"));
    // A chat store gives every Cursor chat its own ID, so two chats never share one (turn-process.regression.test.ts).
    mkdirSync(join(root, "store"));
    fake = fakeCommand(root, "cursor-agent", { FAKE_CURSOR_STORE: join(root, "store") });
    // Issue #105's reproduction: `config set agents.entries.second '{}'`, even an empty entry.
    configure({ [CURSOR_COMMAND_KEY]: fake.command, "agents.defaults.model.primary": "cursor-cli/auto", "agents.entries.second": {} });
    gateway = await startRegressionGateway(await freePort(), { logFile: join(root, "gateway.log"), onStarted: (stop) => (stopGateway = stop) });
  }, REGRESSION_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await finishRegression({ stop: stopGateway, fakes: [fake], root });
    } finally {
      state?.restore();
    }
  }, 120_000);

  const nonce = () => randomUUID().slice(0, 8);
  const turnOutput = (run: { status: number | null; stdout: string; stderr: string }) =>
    `exit ${run.status}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`;
  const fakeLines = (from: number) => readFakeLog(fake!.log).slice(from);
  const pidEvidence = (chats: Record<string, number[]>) =>
    Object.entries(chats)
      .map(([name, pids]) => `${name} chat pids ${pids.join(",")} alive=${pids.map(fakeAlive).join(",")}`)
      .join("; ");

  // #105: on OpenClaw 2026.10.3, once the config names a second agent, the Gateway's own plugin registry loads with no
  // workspace (no sole agent owns it), so a turn's prepared registry no longer borrows it and loads a second copy of
  // the plugin. The turn's process lives in that copy's pool, while `session_end` runs in the Gateway's copy, whose
  // pool was empty: the #74 release did nothing and the process stayed until the 15-minute idle close.
  it(
    "#105: with a second agent in the config, `sessions.reset` of a chat ends that chat's cursor-agent process and leaves another chat's running",
    async () => {
      const id = nonce();
      const ended = `regression-agents-ended-${id}`;
      const kept = `regression-agents-kept-${id}`;
      const logFrom = readFakeLog(fake!.log).length;
      const endedTurn = await gatewayAgentTurn(gateway!.port, ended, `say:ended${id}`, undefined, "main");
      expect(endedTurn.status, turnOutput(endedTurn)).toBe(0);
      const keptTurn = await gatewayAgentTurn(gateway!.port, kept, `say:kept${id}`, undefined, "main");
      expect(keptTurn.status, turnOutput(keptTurn)).toBe(0);
      // Each chat's process is the one its prompt reached (not a model-listing process started in between).
      const endedPids = chatPids(fakeLines(logFrom), `say:ended${id}`);
      const keptPids = chatPids(fakeLines(logFrom), `say:kept${id}`);
      const evidence = () => pidEvidence({ ended: endedPids, kept: keptPids });
      expect(endedPids, evidence()).toHaveLength(1);
      expect(keptPids, evidence()).toHaveLength(1);
      expect(fakeAlive(endedPids[0]!), evidence()).toBe(true);

      const reset = gatewayCall(gateway!.port, "sessions.reset", { key: `agent:main:explicit:${ended}` });
      expect(reset?.ok, JSON.stringify(reset)).toBe(true);
      // The pool's own idle close is 15 minutes; the release closes the process at once (SIGTERM, then SIGKILL).
      await waitFor(() => !fakeAlive(endedPids[0]!), 20_000, 250);
      expect(fakeAlive(endedPids[0]!), `${evidence()} (20 s after sessions.reset)`).toBe(false);
      expect(fakeAlive(keptPids[0]!), evidence()).toBe(true);
    },
    REGRESSION_TIMEOUT_MS,
  );

  // The same for a chat of the second agent itself, whose turns never run in the Gateway's own copy of the plugin.
  it(
    "#105: `sessions.reset` of the second agent's chat ends that chat's cursor-agent process",
    async () => {
      const id = nonce();
      const ended = `regression-second-ended-${id}`;
      const logFrom = readFakeLog(fake!.log).length;
      const turn = await gatewayAgentTurn(gateway!.port, ended, `say:second${id}`, undefined, "second");
      expect(turn.status, turnOutput(turn)).toBe(0);
      const pids = chatPids(fakeLines(logFrom), `say:second${id}`);
      const evidence = () => pidEvidence({ second: pids });
      expect(pids, evidence()).toHaveLength(1);
      expect(fakeAlive(pids[0]!), evidence()).toBe(true);

      const reset = gatewayCall(gateway!.port, "sessions.reset", { key: `agent:second:explicit:${ended}` });
      expect(reset?.ok, JSON.stringify(reset)).toBe(true);
      await waitFor(() => !fakeAlive(pids[0]!), 20_000, 250);
      expect(fakeAlive(pids[0]!), `${evidence()} (20 s after sessions.reset)`).toBe(false);
    },
    REGRESSION_TIMEOUT_MS,
  );
});
