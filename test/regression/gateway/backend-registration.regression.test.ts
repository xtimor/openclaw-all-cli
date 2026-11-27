import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openclaw } from "../../live/harness.ts";
import {
  CURSOR_COMMAND_KEY,
  REGRESSION_TIMEOUT_MS,
  configure,
  describeRegression,
  fakeCommand,
  finishRegression,
  freePort,
  gatewayLog,
  startRegressionGateway,
  type FakeCommand,
  type RegressionGateway,
} from "../harness.ts";

// Gateway scenario for the past backend-registration bug (epic-regression-gate ticket 3): what a Gateway start with
// the packed plugin registers. Run with `scripts/regression.sh gateway [--openclaw <version>]`.
describeRegression("Gateway scenarios: the cursor-cli backend registration", () => {
  let root: string | undefined;
  let fake: FakeCommand | undefined;
  let gateway: RegressionGateway | undefined;
  let stopGateway: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oac-regression-backend-"));
    fake = fakeCommand(root, "cursor-agent");
    configure({ [CURSOR_COMMAND_KEY]: fake.command, "agents.defaults.model.primary": "cursor-cli/auto" });
    gateway = await startRegressionGateway(await freePort(), { logFile: join(root, "gateway.log"), onStarted: (stop) => (stopGateway = stop) });
  }, REGRESSION_TIMEOUT_MS);

  afterAll(() => finishRegression({ stop: stopGateway, fakes: [fake], root }), 120_000);

  // #14: the Gateway logged `cli backend already registered: cursor-cli (...)` as an error of this plugin (the older
  // cursor-cli plugin held the ID). The fix documented the clash and pinned one registration.
  it(
    "#14: a Gateway start registers the cursor-cli backend once, with no `already registered` error",
    async () => {
      const log = gatewayLog(gateway!);
      const pluginLines = log.split("\n").filter((line) => line.includes("[plugins]") || /already registered/i.test(line));
      const logEvidence = `Gateway log, plugin lines:\n${pluginLines.join("\n") || "(none)"}`;
      expect(log.length, "the Gateway log is empty").toBeGreaterThan(0);
      expect(log, logEvidence).not.toMatch(/already registered/i);

      const inspected = openclaw(["plugins", "inspect", "openclaw-all-cli", "--runtime", "--json"], { timeoutMs: 120_000 });
      const output = `exit ${inspected.status}\n--- stdout\n${inspected.stdout.slice(0, 6_000)}\n--- stderr\n${inspected.stderr.slice(0, 2_000)}`;
      expect(inspected.status, output).toBe(0);
      const report = JSON.parse(inspected.stdout.slice(inspected.stdout.indexOf("{"))) as {
        plugin?: { cliBackendIds?: string[] };
        capabilities?: Array<{ kind?: string; ids?: string[] }>;
        diagnostics?: Array<{ level?: string; message?: string }>;
      };
      const evidence = `${logEvidence}\n--- plugins inspect: cliBackendIds ${JSON.stringify(report.plugin?.cliBackendIds)}, capabilities ${JSON.stringify(report.capabilities)}, diagnostics ${JSON.stringify(report.diagnostics)}`;
      expect(report.plugin?.cliBackendIds, evidence).toEqual(["cursor-cli"]);
      const backends = (report.capabilities ?? []).filter((capability) => capability.kind === "cli-backend").flatMap((capability) => capability.ids ?? []);
      expect(backends, evidence).toEqual(["cursor-cli"]);
      expect((report.diagnostics ?? []).filter((diagnostic) => /already registered/i.test(diagnostic.message ?? "")), evidence).toEqual([]);
      expect((report.diagnostics ?? []).filter((diagnostic) => diagnostic.level === "error"), evidence).toEqual([]);
    },
    REGRESSION_TIMEOUT_MS,
  );
});
