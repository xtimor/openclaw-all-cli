import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openclaw, replyLines } from "../../live/harness.ts";
import {
  CURSOR_COMMAND_KEY,
  REGRESSION_TIMEOUT_MS,
  chatPids,
  configure,
  describeRegression,
  fakeCommand,
  finishRegression,
  freePort,
  gatewayAgentTurn,
  readFakeLog,
  startRegressionGateway,
  type FakeCommand,
  type RegressionGateway,
} from "../harness.ts";

// Gateway scenario for the past update-path bug (epic-regression-gate ticket 9, #80): the README told users to run
// `openclaw plugins update` with the Gateway running, which current OpenClaw refuses (2026.11.x: offline-only) or which
// leaves an archive install as it is (2026.10.3: "Skipping"). The fix was docs only: the README's running-Gateway path is
// a reinstall over the old copy. Here that command runs with the ClawHub spec replaced by the packed `.tgz` (no network),
// against a running Gateway with the installed plugin. Run with `scripts/regression.sh gateway [--openclaw <version>]`.
describeRegression("Gateway scenarios: updating the plugin while the Gateway runs", () => {
  let root: string | undefined;
  let fake: FakeCommand | undefined;
  let gateway: RegressionGateway | undefined;
  let stopGateway: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oac-regression-update-"));
    mkdirSync(join(root, "store"));
    fake = fakeCommand(root, "cursor-agent", { FAKE_CURSOR_STORE: join(root, "store") });
    configure({ [CURSOR_COMMAND_KEY]: fake.command, "agents.defaults.model.primary": "cursor-cli/auto" });
    gateway = await startRegressionGateway(await freePort(), { logFile: join(root, "gateway.log"), onStarted: (stop) => (stopGateway = stop) });
  }, REGRESSION_TIMEOUT_MS);

  afterAll(() => finishRegression({ stop: stopGateway, fakes: [fake], root }), 120_000);

  const output = (run: { status: number | null; stdout: string; stderr: string }) =>
    `exit ${run.status}\n--- stdout\n${run.stdout.slice(-4_000)}\n--- stderr\n${run.stderr.slice(-4_000)}`;
  /** The `.tgz` scripts/regression.sh packed and installed for this run (`.regression/pack`, next to the OpenClaw dirs). */
  const tarball = () => {
    const pack = join(dirname(process.env.SPIKE_DIR!), "pack");
    const found = readdirSync(pack).filter((name) => /^openclaw-all-cli-.*\.tgz$/.test(name));
    expect(found, `packed tarballs in ${pack}`).toHaveLength(1);
    return join(pack, found[0]!);
  };
  const turn = async (word: string) => {
    const id = randomUUID().slice(0, 8);
    const logFrom = readFakeLog(fake!.log).length;
    const run = await gatewayAgentTurn(gateway!.port, `regression-update-${word}-${id}`, `say:${word}${id}`);
    expect(run.status, output(run)).toBe(0);
    expect(replyLines(run.stdout), output(run)).toEqual([`${word}${id}`]);
    // The reply came from the plugin's cursor-agent, not from anything else.
    expect(chatPids(readFakeLog(fake!.log).slice(logFrom), `say:${word}${id}`), output(run)).toHaveLength(1);
  };

  // #80: the README's Update section now gives `openclaw plugins install clawhub:openclaw-all-cli --accept-capabilities
  // --force` for a running Gateway.
  it(
    "#80: the README's running-Gateway update (`plugins install <package> --accept-capabilities --force`) succeeds while the Gateway runs, and turns still answer through the plugin",
    async () => {
      await turn("before");
      const installed = openclaw(["plugins", "install", tarball(), "--accept-capabilities", "--force"], { timeoutMs: 180_000 });
      expect(installed.status, output(installed)).toBe(0);
      expect(`${installed.stdout}${installed.stderr}`, output(installed)).toMatch(/Installed plugin: openclaw-all-cli/);
      // The reinstall keeps the plugin's config (the fake as cursor-cli.command), and the running Gateway serves turns with it.
      const command = openclaw(["config", "get", CURSOR_COMMAND_KEY], { timeoutMs: 30_000 });
      expect(command.stdout, output(command)).toContain(fake!.command);
      await turn("after");
    },
    REGRESSION_TIMEOUT_MS,
  );

  // The old documented path, kept as the bug's evidence: against a running Gateway it refreshes nothing for this install.
  it(
    "#80: the old documented `plugins update openclaw-all-cli` does not update the plugin while the Gateway runs",
    async () => {
      const updated = openclaw(["plugins", "update", "openclaw-all-cli"], { timeoutMs: 180_000 });
      const text = `${updated.stdout}${updated.stderr}`;
      // 2026.11.x refuses it (state ownership is the Gateway's); 2026.10.3 accepts the command but skips an archive install.
      const refused = updated.status !== 0 && /offline-only|stop the Gateway/i.test(text);
      const skipped = updated.status === 0 && /Skipping "openclaw-all-cli"/.test(text);
      expect(refused || skipped, output(updated)).toBe(true);
      await turn("still");
    },
    REGRESSION_TIMEOUT_MS,
  );
});
