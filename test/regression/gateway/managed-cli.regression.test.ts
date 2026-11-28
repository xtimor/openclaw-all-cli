import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { replyLines, waitFor } from "../../live/harness.ts";
import {
  REGRESSION_TIMEOUT_MS,
  chatPids,
  configure,
  describeRegression,
  fakeCommand,
  finishRegression,
  freePort,
  gatewayAgentTurn,
  gatewayLog,
  linesOf,
  readFakeLog,
  runsOfflineCatalog,
  startRegressionGateway,
  type FakeCommand,
  type RegressionGateway,
} from "../harness.ts";

/** The plugin's whole cursor-cli config entry: setting it replaces `command` and `env` at once. */
const CURSOR_CONFIG_KEY = "plugins.entries.openclaw-all-cli.config.cursor-cli";

// Gateway scenarios for the managed cursor-agent (epic-regression-gate ticket 9, PR #92): a cursor-agent the plugin
// installed for an API key goes at the next Gateway start once that key is gone, and stays while a key exists. Each
// case starts a Gateway of its own, since what it checks happens at a Gateway start; the packed plugin, and
// fake-cursor-agent placed where the plugin keeps its managed CLI (`<state>/tools/cursor-agent/<version>/`, as
// `src/core/managed-install.ts` lays it out). The download itself (Cursor's URL and sha256 in
// `src/adapters/cursor/install.ts`) needs the network and stays a unit test. Every key is a dummy.
// Run with `scripts/regression.sh gateway [--openclaw <version>]`.
describeRegression("Gateway scenarios: the managed cursor-agent at a Gateway start", () => {
  let root: string | undefined;
  let fake: FakeCommand | undefined;
  /** `managedRoot(<state>, "cursor-agent")`: the only folder managed installs live in. */
  const managed = join(process.env.SPIKE_DIR ?? "", "state", "tools", "cursor-agent");
  const launcher = join(managed, "2026.10.14-fake", "cursor-agent");
  const configFile = join(process.env.SPIKE_DIR ?? "", "openclaw.json");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "oac-regression-managed-"));
    mkdirSync(join(root, "store"));
    // Logged out: the managed CLI has no login of its own, so only the saved key kept it. The log and the pid record
    // live outside the managed folder, which the plugin may remove.
    fake = fakeCommand(root, "cursor-agent", { FAKE_CURSOR_STORE: join(root, "store"), FAKE_CURSOR_LOGGED_IN: "0" });
  });

  afterAll(async () => {
    try {
      // Nothing of a case stays in the shared state: no managed folder, no key, no command into it.
      rmSync(managed, { recursive: true, force: true });
      configure({ [CURSOR_CONFIG_KEY]: { command: fake!.command } });
    } finally {
      await finishRegression({ fakes: [fake], root });
    }
  }, 120_000);

  /** What the API key method leaves after it installed the CLI and saved a key for it: the launcher and the marker. */
  const placeManagedCli = () => {
    rmSync(managed, { recursive: true, force: true });
    mkdirSync(join(managed, "2026.10.14-fake"), { recursive: true });
    writeFileSync(launcher, `#!/bin/sh\nexec '${fake!.command}' "$@"\n`);
    chmodSync(launcher, 0o755);
    writeFileSync(join(managed, ".key-saved"), "The API key method saved a key for this install.\n");
  };
  const pluginConfig = () =>
    (JSON.parse(readFileSync(configFile, "utf8")) as { plugins?: { entries?: Record<string, { config?: Record<string, any> }> } }).plugins?.entries?.[
      "openclaw-all-cli"
    ]?.config?.["cursor-cli"];
  const removedLines = (gateway: RegressionGateway) => gatewayLog(gateway).split("\n").filter((line) => line.includes(`Removed ${managed}`));
  const evidence = (gateway: RegressionGateway | undefined) =>
    `managed folder present=${existsSync(managed)} marker=${existsSync(join(managed, ".key-saved"))}; cursor-cli config ${JSON.stringify(pluginConfig())}\n` +
    `--- Gateway log, plugin lines:\n${gateway ? gatewayLog(gateway).split("\n").filter((line) => line.includes("[plugins]") || line.includes("Removed")).join("\n") : "(no Gateway)"}\n` +
    `--- fake log:\n${readFakeLog(fake!.log).map((line) => `${line.method ?? line.event} pid=${line.pid} keyed=${String(line.keyed)}`).join("\n") || "(none)"}`;
  /** One Gateway start with the case's state, stopped however the case went. */
  const withGateway = async (logName: string, check: (gateway: RegressionGateway) => Promise<void>) => {
    let stop: (() => Promise<void>) | undefined;
    try {
      // Nothing lists cursor-cli models here on 2026.10.3 (no login, or the command is gone), so the readiness wait ends on
      // an empty catalog early; the checks wait for what they need themselves.
      const gateway = await startRegressionGateway(await freePort(), { logFile: join(root!, logName), emptyMs: 5_000, onStarted: (s) => (stop = s) });
      await check(gateway);
    } finally {
      await stop?.();
    }
  };

  // PR #92: OpenClaw's Remove key deletes only the auth profile; the plugin removes the CLI it installed for that key at
  // the next Gateway start that loads it (a keyless turn there is refused by OpenClaw 2026.11.x before it reaches the plugin).
  it(
    "PR #92: at a Gateway start with the key gone, the managed cursor-agent is removed and cursor-cli.command is unset",
    async () => {
      placeManagedCli();
      // No key anywhere: not in the plugin config, not in the Gateway's env (the harness drops it), and no profile
      // (no scenario leaves one in the shared auth store).
      // cursor-cli as the primary model: OpenClaw 2026.10.3 loads a provider plugin at a Gateway start only when the config
      // uses it, and a file that runs first in a fresh state has no other file's model setting.
      configure({ [CURSOR_CONFIG_KEY]: { command: launcher }, "agents.defaults.model.primary": "cursor-cli/auto" });
      expect(pluginConfig()?.command, evidence(undefined)).toBe(launcher);
      await withGateway(`gateway-removed-${randomUUID().slice(0, 8)}.log`, async (gateway) => {
        await waitFor(() => removedLines(gateway).length > 0 && !existsSync(managed), 90_000, 500);
        expect(gatewayLog(gateway), evidence(gateway)).toMatch(/http server listening \(.*openclaw-all-cli/);
        expect(removedLines(gateway), evidence(gateway)).toHaveLength(1);
        expect(removedLines(gateway)[0], evidence(gateway)).toContain("that key is gone");
        expect(removedLines(gateway)[0], evidence(gateway)).toContain("cursor-cli.command pointed there and is unset");
        expect(existsSync(managed), evidence(gateway)).toBe(false);
        await waitFor(() => pluginConfig()?.command === undefined, 30_000, 500);
        expect(pluginConfig()?.command, evidence(gateway)).toBeUndefined();
        // It looked at the CLI's own login first (logged out, so the install was the key's only).
        expect(readFakeLog(fake!.log).some((line) => line.method === "status" && line.keyed === false), evidence(gateway)).toBe(true);
      });
    },
    REGRESSION_TIMEOUT_MS,
  );

  it(
    "PR #92: at a Gateway start with a key still saved, the managed cursor-agent and cursor-cli.command stay",
    async () => {
      placeManagedCli();
      configure({
        [CURSOR_CONFIG_KEY]: { command: launcher, env: { CURSOR_API_KEY: `regression-dummy-key-${randomUUID().slice(0, 8)}` } },
        "agents.defaults.model.primary": "cursor-cli/auto",
      });
      try {
        await withGateway(`gateway-kept-${randomUUID().slice(0, 8)}.log`, async (gateway) => {
          // The sweep runs when the plugin loads; it reads the key first, so with a key it ends there. Positive signals that the
          // plugin loaded with this config and the sweep's moment has passed, before the absence is checked: where the catalog
          // runs offline, its keyed `about` check on the managed CLI at plugin load; on every version, a turn served by the
          // managed CLI with the key (a keyed turn never starts a sweep of its own).
          if (runsOfflineCatalog()) {
            await waitFor(() => readFakeLog(fake!.log).some((line) => line.method === "about" && line.keyed === true), 60_000, 500);
            expect(readFakeLog(fake!.log).some((line) => line.method === "about" && line.keyed === true), evidence(gateway)).toBe(true);
          }
          const id = randomUUID().slice(0, 8);
          const logFrom = readFakeLog(fake!.log).length;
          const run = await gatewayAgentTurn(gateway.port, `regression-managed-kept-${id}`, `say:kept${id}`);
          const turnEvidence = `turn: exit ${run.status}\n--- stdout\n${run.stdout.slice(-2_000)}\n--- stderr\n${run.stderr.slice(-2_000)}\n--- ${evidence(gateway)}`;
          expect(run.status, turnEvidence).toBe(0);
          expect(replyLines(run.stdout), turnEvidence).toEqual([`kept${id}`]);
          const chats = chatPids(readFakeLog(fake!.log).slice(logFrom), `say:kept${id}`);
          expect(chats, turnEvidence).toHaveLength(1);
          expect(linesOf(readFakeLog(fake!.log), chats[0]!).find((line) => line.method === "initialize")?.keyed, turnEvidence).toBe(true);
          expect(removedLines(gateway), evidence(gateway)).toEqual([]);
          expect(existsSync(launcher), evidence(gateway)).toBe(true);
          expect(existsSync(join(managed, ".key-saved")), evidence(gateway)).toBe(true);
          expect(pluginConfig()?.command, evidence(gateway)).toBe(launcher);
        });
      } finally {
        rmSync(managed, { recursive: true, force: true });
        configure({ [CURSOR_CONFIG_KEY]: { command: fake!.command } });
      }
    },
    REGRESSION_TIMEOUT_MS,
  );
});
