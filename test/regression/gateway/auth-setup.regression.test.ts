import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { waitFor } from "../../live/harness.ts";
import {
  REGRESSION_TIMEOUT_MS,
  authLogin,
  chatPids,
  configure,
  cursorCatalog,
  describeRegression,
  fakeCommand,
  finishRegression,
  freePort,
  gatewayCall,
  linesOf,
  promptText,
  readFakeLog,
  startRegressionGateway,
  type FakeCommand,
  type FakeLogEntry,
  type RegressionGateway,
} from "../harness.ts";

/** The plugin's whole cursor-cli config entry: setting it replaces `command` and drops any `env` key a case set. */
const CURSOR_CONFIG_KEY = "plugins.entries.openclaw-all-cli.config.cursor-cli";

/** Cursor's refusal of a key as a failed turn's one reply chunk; the plugin reads it as `auth`. */
const REFUSED_TURN = "\n\nError: NonRetriableError: [unauthenticated] Invalid API key";

/** cursor-agent 2026.11.11's `status` when it holds a credential it could not confirm (issue #98). */
const DEGRADED_STATUS = "Logged in (unable to fetch user details)";

// Gateway scenarios for past auth and setup bugs (epic-regression-gate ticket 9): what the Gateway's surfaces (the
// catalog, `models.authStatus`, Control UI Test connection = `models.probe`, Connect provider = `models.authLogin`) report
// for a CLI login, a saved key, a refused key, and a degraded status. One Gateway for the file, the packed plugin,
// fake-cursor-agent as the CLI; a case that needs other CLI behavior points `cursor-cli.command` at a shim of its own
// (a config change the Gateway applies without a restart, which also gives a fresh login probe). Every key is a dummy.
// Run with `scripts/regression.sh gateway [--openclaw <version>]`.
describeRegression("Gateway scenarios: cursor-cli auth, key setup, and Test connection", () => {
  let root: string | undefined;
  let base: FakeCommand | undefined;
  const fakes: FakeCommand[] = [];
  let gateway: RegressionGateway | undefined;
  let stopGateway: (() => Promise<void>) | undefined;

  /** A shim of its own for one case, with the file's chat store and these knobs. */
  const shim = (name: string, env: Record<string, string> = {}) => {
    const fake = fakeCommand(root!, name, { FAKE_CURSOR_STORE: join(root!, "store"), ...env });
    fakes.push(fake);
    return fake;
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oac-regression-auth-"));
    mkdirSync(join(root, "store"));
    // Logged in (the fake's default) and no key anywhere: a CLI login only.
    base = shim("cursor-agent");
    configure({ [CURSOR_CONFIG_KEY]: { command: base.command }, "agents.defaults.model.primary": "cursor-cli/auto" });
    gateway = await startRegressionGateway(await freePort(), { logFile: join(root, "gateway.log"), onStarted: (stop) => (stopGateway = stop) });
  }, REGRESSION_TIMEOUT_MS);

  afterAll(async () => {
    try {
      // The config and the auth store outlive this file: no key, profile, or shim of a case stays.
      if (gateway) {
        gatewayCall(gateway.port, "models.authLogout", { provider: "cursor-cli" });
        configure({ [CURSOR_CONFIG_KEY]: { command: base!.command } });
      }
    } finally {
      await finishRegression({ stop: stopGateway, fakes, root });
    }
  }, 120_000);

  const nonce = () => randomUUID().slice(0, 8);
  const skipReason = () =>
    `OpenClaw ${process.env.OPENCLAW_VERSION} lists no model offline (models.list is empty for every provider and runs no provider catalog), so the catalog cannot show cursor-cli's auth and models.probe answers "format" without starting the CLI`;
  const describeLines = (lines: readonly FakeLogEntry[]) =>
    lines
      .map((line) => `${line.method ?? line.event}${line.params?.sessionId ? ` ${line.params.sessionId}` : ""}${line.pid ? ` pid=${line.pid}` : ""}${line.keyed === undefined ? "" : ` keyed=${String(line.keyed)}`}`)
      .join("\n") || "(none)";
  /** `models.authStatus`: the cursor-cli entry (profiles the auth store holds for it) and its Connect provider options. */
  const authStatus = () => {
    const status = gatewayCall(gateway!.port, "models.authStatus", {});
    const provider = (status?.providers ?? []).find((entry: { provider?: string }) => entry.provider === "cursor-cli");
    const capability = (status?.providerCapabilities ?? []).find((entry: { provider?: string }) => entry.provider === "cursor-cli");
    return { provider, capability, text: JSON.stringify({ provider, capability }).slice(0, 3_000) };
  };
  /** The Connect provider option of the plugin's API key method, as the Control UI lists it. */
  const apiKeyChoice = () => {
    const { capability, text } = authStatus();
    const option = (capability?.loginOptions ?? []).find((entry: { id?: string }) => entry.id?.endsWith("/cursor-cli-api-key"));
    expect(option?.id, `models.authStatus offers no cursor-cli API key option: ${text}`).toBeTypeOf("string");
    return option.id as string;
  };
  const catalogNow = () => {
    const rows = cursorCatalog(gateway!.port);
    return "error" in rows ? { cursor: [] as string[], all: -1, error: rows.error } : { ...rows, error: undefined };
  };
  const waitCatalog = async (holds: (ids: string[]) => boolean, timeoutMs = 60_000) => {
    let last = catalogNow();
    await waitFor(() => holds((last = catalogNow()).cursor) && last.error === undefined, timeoutMs, 2_000);
    return last;
  };
  const probe = () => gatewayCall(gateway!.port, "models.probe", { provider: "cursor-cli", timeoutMs: 60_000 }, 90_000);
  const logout = () => gatewayCall(gateway!.port, "models.authLogout", { provider: "cursor-cli" });
  /** Points cursor-cli at the file's logged-in shim again (no key) and waits until the catalog lists it again. */
  const restoreBase = async () => {
    configure({ [CURSOR_CONFIG_KEY]: { command: base!.command } });
    if (gateway!.catalog === "cursor-cli") await waitCatalog((ids) => ids.length > 1);
  };

  // #39: the provider card read "Not configured" although the cursor-agent login worked. The host limit is documented
  // (docs/providers/cursor.md: the card reads only auth profiles and keys, so a CLI login shows no profile); plan 27 made
  // the API key method save a real `api_key` profile that the card reads.
  it(
    "#39: a working cursor-agent login with no key is usable, and a key saved with the API key method is a cursor-cli api_key profile",
    async () => {
      const before = authStatus();
      expect(before.provider?.profiles ?? [], `a cursor-cli profile exists before any key was saved: ${before.text}`).toEqual([]);
      if (gateway!.catalog === "cursor-cli") {
        const rows = catalogNow();
        // The login counts: the catalog holds the CLI's own listing (five models), not the one default row it falls back to.
        expect(rows.cursor, `models.list cursor-cli rows with only the CLI login: ${JSON.stringify(rows)}`).toHaveLength(5);
        expect(rows.cursor, JSON.stringify(rows)).toContain("auto");
        // What it counted is the CLI's own login: `status` ran, and no key reached it.
        const probes = readFakeLog(base!.log).filter((line) => line.method === "status");
        expect(probes.length, `the login probe never ran \`status\`:\n${describeLines(readFakeLog(base!.log))}`).toBeGreaterThan(0);
        expect(probes.filter((line) => line.keyed === true), `a key reached the login probe:\n${describeLines(probes)}`).toEqual([]);
      }

      const key = `regression-dummy-key-${nonce()}`;
      const logFrom = readFakeLog(base!.log).length;
      try {
        const login = await authLogin(gateway!.port, apiKeyChoice(), key);
        const evidence = `models.authLogin: ${JSON.stringify(login).slice(0, 3_000)}\n--- fake log:\n${describeLines(readFakeLog(base!.log).slice(logFrom))}`;
        expect(login.start?.ok, evidence).toBe(true);
        expect(login.steps.map((step) => step.type), evidence).toContain("text");
        expect(login.steps.find((step) => step.type === "text")?.sensitive, evidence).toBe(true);
        expect(login.final?.status, evidence).toBe("done");
        expect(login.steps.map((step) => step.message ?? "").join("\n"), evidence).toContain("accepted the key");
        // The key was checked with `about` before it was saved.
        expect(readFakeLog(base!.log).slice(logFrom).filter((line) => line.method === "about" && line.keyed === true).length, evidence).toBeGreaterThan(0);
        // The Control UI reads the card again after the dialog: give the host's auth snapshot a moment to catch up. (On OpenClaw
        // 2026.10.3, in a Gateway that loaded the plugin at start with no profile in the store, it never does: a new bug, see
        // the ticket 9 plan.)
        await waitFor(() => (authStatus().provider?.profiles ?? []).length > 0, 30_000, 1_000);
        const after = authStatus();
        const profiles = (after.provider?.profiles ?? []) as Array<{ profileId?: string; type?: string }>;
        expect(profiles.map((profile) => [profile.profileId, profile.type]), `${after.text}\n--- ${evidence}`).toEqual([["cursor-cli:default", "api_key"]]);
      } finally {
        logout();
      }
      const cleaned = authStatus();
      expect(cleaned.provider?.profiles ?? [], `the saved profile is still there after models.authLogout: ${cleaned.text}`).toEqual([]);
    },
    REGRESSION_TIMEOUT_MS,
  );

  // PR #96: the Control UI's Test connection (`models.probe`) sent OpenClaw's own runtime to the catalog's placeholder URL;
  // the provider's stream hook now answers it with one text-only CLI turn, and a failed turn keeps its own reason.
  it(
    "PR #96: Test connection (models.probe) with a saved key runs one text-only turn through the plugin and is ok; a refused turn is reported as auth, not a timeout",
    async (ctx) => {
      if (gateway!.catalog === "empty") ctx.skip(skipReason());
      const login = await authLogin(gateway!.port, apiKeyChoice(), `regression-dummy-key-${nonce()}`);
      try {
        expect(login.final?.status, JSON.stringify(login).slice(0, 3_000)).toBe("done");
        const logFrom = readFakeLog(base!.log).length;
        const ok = probe();
        const lines = readFakeLog(base!.log).slice(logFrom);
        const evidence = `models.probe: ${JSON.stringify(ok)}\n--- fake log:\n${describeLines(lines)}`;
        expect(ok?.status, evidence).toBe("ok");
        expect(ok?.results?.[0]?.profileId, evidence).toBe("cursor-cli:default");
        // One prompt, on a process of its own: a side question (no MCP server, `ask` mode) with text blocks only.
        const prompts = lines.filter((line) => line.method === "session/prompt");
        expect(prompts, evidence).toHaveLength(1);
        const pids = chatPids(lines);
        expect(pids, evidence).toHaveLength(1);
        const own = linesOf(lines, pids[0]!);
        expect(own.find((line) => line.method === "session/new")?.params?.mcpServers, evidence).toEqual([]);
        expect(own.filter((line) => line.method === "session/set_mode").map((line) => line.params?.modeId), evidence).toEqual(["ask"]);
        expect((prompts[0]!.params?.prompt ?? []).map((block: { type?: string }) => block.type), evidence).toEqual(
          (prompts[0]!.params?.prompt ?? []).map(() => "text"),
        );
        expect(promptText(prompts[0]!).length, evidence).toBeGreaterThan(0);
        expect(own.find((line) => line.method === "initialize")?.keyed, evidence).toBe(true);

        // The same check against a CLI that refuses the turn: the probe names the failure.
        const failing = shim("cursor-agent-failing", { FAKE_CURSOR_PROMPT_ERROR: JSON.stringify(REFUSED_TURN) });
        configure({ [CURSOR_CONFIG_KEY]: { command: failing.command } });
        // The probe needs its model in the catalog, which the config change rebuilds: wait until the new command listed it.
        await waitFor(() => readFakeLog(failing.log).some((line) => line.method === "session/new"), 60_000, 500);
        const relisted = await waitCatalog((ids) => ids.length > 1);
        expect(relisted.cursor.length, `the catalog did not list again on the failing command: ${JSON.stringify(relisted)}`).toBeGreaterThan(1);
        const refused = probe();
        const failed = readFakeLog(failing.log);
        const failEvidence = `models.probe: ${JSON.stringify(refused)}\n--- failing fake log:\n${describeLines(failed)}`;
        expect(failed.filter((line) => line.method === "session/prompt"), failEvidence).toHaveLength(1);
        expect(refused?.status, failEvidence).not.toBe("ok");
        expect(refused?.status, failEvidence).not.toBe("timeout");
        expect(refused?.status, failEvidence).toBe("auth");
      } finally {
        logout();
        await restoreBase();
      }
    },
    REGRESSION_TIMEOUT_MS,
  );

  /**
   * Points cursor-cli at `fake` (with `env` as its plugin-config env, if any), waits until the plugin's catalog ran on
   * it, and checks that no Gateway surface counts its credential as a login.
   */
  const expectNoLogin = async (fake: FakeCommand, env: Record<string, string> | undefined) => {
    const catalogBefore = await waitCatalog((ids) => ids.length > 1);
    expect(catalogBefore.cursor.length, `the CLI login did not list the catalog before the case: ${JSON.stringify(catalogBefore)}`).toBeGreaterThan(1);
    configure({ [CURSOR_CONFIG_KEY]: { command: fake.command, ...(env ? { env } : {}) } });
    try {
      // The catalog runs again for the new command (a config change): the shim logs its first run (the login probe).
      await waitFor(() => readFakeLog(fake.log).length > 0, 60_000, 500);
      const evidence = () => `models.list: ${JSON.stringify(catalogNow())}\n--- fake log:\n${describeLines(readFakeLog(fake.log))}`;
      expect(readFakeLog(fake.log).length, `the plugin never probed the new command\n${evidence()}`).toBeGreaterThan(0);
      // The catalog falls back to its unauthenticated form, which this OpenClaw does not list (no cursor-cli row) ...
      const after = await waitCatalog((ids) => ids.length === 0, 60_000);
      expect(after.cursor, evidence()).toEqual([]);
      // ... and stays there: no model listing ever ran on the credential (it runs only after a login probe said "available").
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      expect(catalogNow().cursor, evidence()).toEqual([]);
      expect(readFakeLog(fake.log).filter((line) => line.method === "initialize" || line.method === "session/new"), evidence()).toEqual([]);
      const status = authStatus();
      expect(status.provider?.profiles ?? [], `${status.text}\n--- ${evidence()}`).toEqual([]);
      const probed = probe();
      expect(probed?.status, `models.probe: ${JSON.stringify(probed)}\n--- ${evidence()}`).not.toBe("ok");
      return readFakeLog(fake.log);
    } finally {
      await restoreBase();
    }
  };

  // #98: the provider reported authenticated with an invalid CURSOR_API_KEY: a present key counted as a login. The plugin
  // now checks it with `cursor-agent about` (here in the plugin config's env, which the Gateway's surfaces read).
  it(
    "#98: a CURSOR_API_KEY that cursor-agent refuses is no login on any Gateway surface",
    async (ctx) => {
      if (gateway!.catalog === "empty") ctx.skip(skipReason());
      const refused = shim("cursor-agent-refused", { FAKE_CURSOR_ABOUT: "invalid" });
      const lines = await expectNoLogin(refused, { CURSOR_API_KEY: `regression-dummy-refused-${nonce()}` });
      // The key was checked, never trusted: `about` with the key, and no `status` read it as a login.
      expect(lines.filter((line) => line.method === "about" && line.keyed === true).length, describeLines(lines)).toBeGreaterThan(0);
      expect(lines.filter((line) => line.method === "status" && line.keyed === true), describeLines(lines)).toEqual([]);
    },
    REGRESSION_TIMEOUT_MS,
  );

  // #98, second half: cursor-agent 2026.11.11 prints `Logged in (unable to fetch user details)` for a credential it could
  // not confirm; that line read as a login.
  it(
    "#98: a degraded `status` (Logged in, unable to fetch user details) with no key is no login on any Gateway surface",
    async (ctx) => {
      if (gateway!.catalog === "empty") ctx.skip(skipReason());
      const degraded = shim("cursor-agent-degraded", { FAKE_CURSOR_STATUS_TEXT: DEGRADED_STATUS });
      const lines = await expectNoLogin(degraded, undefined);
      expect(lines.filter((line) => line.method === "status" && line.keyed === false).length, describeLines(lines)).toBeGreaterThan(0);
      expect(lines.filter((line) => line.method === "about"), describeLines(lines)).toEqual([]);
    },
    REGRESSION_TIMEOUT_MS,
  );
});
