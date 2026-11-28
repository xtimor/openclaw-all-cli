import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  runsOfflineCatalog,
  startRegressionGateway,
  type FakeCommand,
  type RegressionGateway,
} from "../harness.ts";

// Gateway scenario for the past update-path bug (epic-regression-gate ticket 9, #80): the README told users to run
// `openclaw plugins update` with the Gateway running, which OpenClaw 2026.11.x refuses (offline-only). The fix was docs
// only: the README's running-Gateway path is a reinstall over the old copy. Here the README's own command runs, read from
// its Update section with the ClawHub spec replaced by the packed `.tgz` (no network), against a running Gateway with the
// installed plugin, so a README that goes back to the old path fails here. Run with `scripts/regression.sh gateway [--openclaw <version>]`.
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
  /**
   * The command README.md's Update section gives for a running Gateway: the first command of the section's first `sh`
   * block, as argv after `openclaw`, with `clawhub:openclaw-all-cli` replaced by the packed `.tgz`.
   */
  const readmeUpdateCommand = () => {
    const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
    const section = /^## Update\n([\s\S]*?)(?=^## )/m.exec(readme)?.[1] ?? "";
    const block = /```sh\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
    const line = block
      .split("\n")
      .map((text) => text.replace(/\s+#.*$/, "").trim())
      .find((text) => text.length > 0);
    expect(line, `README.md's Update section has no sh command:\n${section}`).toMatch(/^openclaw /);
    return { line: line!, argv: line!.split(/\s+/).slice(1).map((arg) => (arg === "clawhub:openclaw-all-cli" ? tarball() : arg)) };
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
      const command = readmeUpdateCommand();
      const installed = openclaw(command.argv, { timeoutMs: 180_000 });
      const evidence = `README command: ${command.line}\nran: openclaw ${command.argv.join(" ")}\n${output(installed)}`;
      expect(installed.status, evidence).toBe(0);
      // A reinstall, not an update that may skip or refuse: the plugin was installed again over the running Gateway's copy.
      expect(`${installed.stdout}${installed.stderr}`, evidence).toMatch(/Installed plugin: openclaw-all-cli/);
      // The reinstall keeps the plugin's config (the fake as cursor-cli.command), and the running Gateway serves turns with it.
      const configured = openclaw(["config", "get", CURSOR_COMMAND_KEY], { timeoutMs: 30_000 });
      expect(configured.stdout, output(configured)).toContain(fake!.command);
      await turn("after");
    },
    REGRESSION_TIMEOUT_MS,
  );

  // The bug's original condition: the old documented path against a running Gateway. OpenClaw 2026.11.x refuses it while
  // the Gateway owns the state. 2026.10.3 accepts `plugins update` with a running Gateway (README says so); for this
  // archive install it prints `Skipping "openclaw-all-cli" (source: archive)`, which comes from the install source and
  // would read the same with the Gateway stopped, so it shows nothing about the running Gateway there.
  it(
    "#80: OpenClaw 2026.11.x refuses the old documented `plugins update openclaw-all-cli` while the Gateway runs",
    async (ctx) => {
      if (runsOfflineCatalog()) {
        ctx.skip(
          `OpenClaw ${process.env.OPENCLAW_VERSION} accepts plugins update with a running Gateway; for an archive install it skips by install source, whether the Gateway runs or not`,
        );
      }
      const updated = openclaw(["plugins", "update", "openclaw-all-cli"], { timeoutMs: 180_000 });
      const text = `${updated.stdout}${updated.stderr}`;
      expect(updated.status, output(updated)).not.toBe(0);
      expect(text, output(updated)).toMatch(/requires exclusive offline state ownership/);
      expect(text, output(updated)).toMatch(/offline-only/);
      await turn("still");
    },
    REGRESSION_TIMEOUT_MS,
  );
});
