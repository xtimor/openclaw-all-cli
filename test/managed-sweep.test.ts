import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import {
  hasKeySavedMarker,
  installManaged,
  KEY_SAVED_MARKER,
  readManaged,
  sweepManagedInstall,
  writeKeySavedMarker,
  type SweepParams,
} from "../src/core/managed-install.ts";
import type { StoredKey } from "../src/core/auth-store.ts";
import type { CliAdapter } from "../src/core/ports.ts";
import { createManagedSweep, reportSweep, unsetManagedCommand } from "../src/core/register.ts";
import { PLUGIN_ID } from "../src/core/synthetic-auth.ts";
import { HOST_DIST, hostAvailable } from "./fixtures/host-code.ts";
import { startPackageStub, testPackage, testSpec, TEST_VERSION, type PackageStub } from "./fixtures/package-stub.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";

// Plan 27: a CLI the plugin installed and saved a key for goes when that key is removed (OpenClaw's
// Remove key) and the CLI has no login of its own; a CLI the plugin did not key is never touched.

const scratch: string[] = [];
const newDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A state dir with a managed install (and the marker unless told not to); the launcher's path. */
function installed(options: { marker?: boolean } = {}) {
  const state = newDir("oac-sweep-");
  const root = join(state, "tools", "cursor-agent");
  mkdirSync(join(root, "1.0.0"), { recursive: true });
  const launcher = join(root, "1.0.0", "cursor-agent");
  writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o755 });
  if (options.marker !== false) writeFileSync(join(root, KEY_SAVED_MARKER), "");
  return { state, root, launcher };
}

function params(at: ReturnType<typeof installed>, overrides: Partial<SweepParams> = {}) {
  const calls = { hasKey: 0, login: 0, closeIdle: 0, unset: [] as string[] };
  const sweep: SweepParams = {
    stateDir: at.state,
    root: at.root,
    hasKey: async () => (calls.hasKey += 1, "none" as const),
    login: async () => (calls.login += 1, "missing"),
    pool: { turns: 0, queued: 0, closeIdle: () => (calls.closeIdle += 1, 0) },
    unsetCommand: async (root) => (calls.unset.push(root), true),
    ...overrides,
  };
  return { calls, sweep };
}

describe("sweepManagedInstall", () => {
  it("removes the install, closes idle processes, and unsets the command when the key is gone and the CLI is not logged in", async () => {
    const at = installed();
    const { calls, sweep } = params(at);
    expect(await sweepManagedInstall(sweep)).toEqual({ kind: "removed", root: at.root, commandUnset: true });
    expect(existsSync(at.root)).toBe(false);
    expect(calls.closeIdle).toBe(1);
    expect(calls.unset).toEqual([at.root]);
  });

  it("touches nothing without the marker: a CLI the plugin did not save a key for stays", async () => {
    const at = installed({ marker: false });
    const { calls, sweep } = params(at);
    expect(await sweepManagedInstall(sweep)).toEqual({ kind: "none" });
    expect(existsSync(at.launcher)).toBe(true);
    expect(calls).toMatchObject({ hasKey: 0, login: 0, closeIdle: 0, unset: [] });
  });

  it("keeps the install while a key exists anywhere, without asking the CLI", async () => {
    const at = installed();
    const { calls, sweep } = params(at, { hasKey: async () => "key" });
    expect(await sweepManagedInstall(sweep)).toEqual({ kind: "kept", reason: "key" });
    expect(existsSync(at.launcher)).toBe(true);
    expect(await hasKeySavedMarker(at.root)).toBe(true);
    expect(calls.login).toBe(0);
  });

  it("keeps the install and the marker when an auth store cannot be read: no key found is not no key", async () => {
    const at = installed();
    const { calls, sweep } = params(at, { hasKey: async () => "unreadable" });
    expect(await sweepManagedInstall(sweep)).toEqual({ kind: "kept", reason: "unreadable" });
    expect(existsSync(at.launcher)).toBe(true);
    expect(await hasKeySavedMarker(at.root)).toBe(true);
    expect(calls.login).toBe(0);
    let asked = 0;
    const later = params(at, { hasKey: async () => ((asked += 1) > 1 ? "unreadable" : "none") });
    expect(await sweepManagedInstall(later.sweep)).toEqual({ kind: "kept", reason: "unreadable" });
    expect(existsSync(at.launcher)).toBe(true);
  });

  it("reads the pool before it awaits anything: the turn that started the sweep and takes its slot right after is not counted", async () => {
    const at = installed();
    const pool = { turns: 0, queued: 0, closeIdle: () => 0 };
    const { sweep } = params(at, { pool, ownTurns: 1 });
    const pending = sweepManagedInstall(sweep);
    // The turn that started the sweep takes its slot right after.
    pool.turns = 1;
    expect(await pending).toEqual({ kind: "removed", root: at.root, commandUnset: true });
  });

  it("looks at the pool again right before the removal: a turn that started meanwhile keeps the install", async () => {
    for (const ownTurns of [0, 1]) {
      const at = installed();
      const pool = { turns: 0, queued: 0, closeIdle: () => 0 };
      let closed = 0;
      const { sweep } = params(at, {
        pool: { get turns() { return pool.turns; }, get queued() { return pool.queued; }, closeIdle: () => (closed += 1, 0) },
        ownTurns,
        // Another turn (beside the caller's own) starts while the login is probed.
        login: async () => ((pool.turns = ownTurns), (pool.queued = 1), "missing" as const),
      });
      expect(await sweepManagedInstall(sweep)).toEqual({ kind: "kept", reason: "busy" });
      expect(existsSync(at.launcher)).toBe(true);
      expect(await hasKeySavedMarker(at.root)).toBe(true);
      expect(closed).toBe(0);
    }
  });

  it.each([
    ["a turn runs", { turns: 1, queued: 0 }],
    ["a turn waits", { turns: 0, queued: 1 }],
  ])("keeps the install while %s", async (_label, busy) => {
    const at = installed();
    const { calls, sweep } = params(at, { pool: { ...busy, closeIdle: () => 0 } });
    expect(await sweepManagedInstall(sweep)).toEqual({ kind: "kept", reason: "busy" });
    expect(existsSync(at.launcher)).toBe(true);
    expect(calls.login).toBe(0);
  });

  it("keeps a CLI that is logged in by itself and drops the marker: it is the user's CLI now", async () => {
    const at = installed();
    const { calls, sweep } = params(at, { login: async () => "available" });
    expect(await sweepManagedInstall(sweep)).toEqual({ kind: "kept", reason: "login" });
    expect(existsSync(at.launcher)).toBe(true);
    expect(await hasKeySavedMarker(at.root)).toBe(false);
    expect(calls.unset).toEqual([]);
  });

  it("keeps the install and the marker when the login status is unclear, so a later sweep looks again", async () => {
    const at = installed();
    const { sweep } = params(at, { login: async () => "unreadable" });
    expect(await sweepManagedInstall(sweep)).toEqual({ kind: "kept", reason: "unclear" });
    expect(existsSync(at.launcher)).toBe(true);
    expect(await hasKeySavedMarker(at.root)).toBe(true);
  });

  it("looks for a key again after the login probe: a key saved meanwhile keeps the install", async () => {
    const at = installed();
    let asked = 0;
    const { sweep } = params(at, { hasKey: async () => ((asked += 1) > 1 ? "key" : "none") });
    expect(await sweepManagedInstall(sweep)).toEqual({ kind: "kept", reason: "key" });
    expect(existsSync(at.launcher)).toBe(true);
  });

  it("says when the command did not point there, and never throws", async () => {
    const at = installed();
    const { sweep } = params(at, { unsetCommand: async () => false });
    expect(await sweepManagedInstall(sweep)).toEqual({ kind: "removed", root: at.root, commandUnset: false });
    const other = installed();
    const failing = params(other, { stateDir: newDir("oac-elsewhere-") }).sweep;
    expect(await sweepManagedInstall(failing)).toMatchObject({ kind: "failed", reason: expect.stringMatching(/outside the plugin's managed tools folder/) });
    expect(existsSync(other.launcher)).toBe(true);
  });
});

describe("the marker beside a managed install", () => {
  let stub: PackageStub;
  beforeAll(async () => {
    stub = await startPackageStub();
  });
  afterAll(async () => {
    await stub.close();
  });

  it("is written without the key, is no install of its own, and survives a newer install's pruning", async () => {
    const state = newDir("oac-marker-");
    const root = join(state, "tools", "cursor-agent");
    await writeKeySavedMarker(root);
    expect(await readManaged(root)).toMatchObject({ present: false, versions: [] });
    const pkg = testPackage();
    stub.answer({ kind: "body", body: pkg });
    // Older than a day, as a stale temporary folder would be: still kept.
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    (await import("node:fs")).utimesSync(join(root, KEY_SAVED_MARKER), old, old);
    await installManaged({ spec: testSpec(pkg), platform: "linux-x64", root, fetch: stub.fetch, freeBytes: async () => 1024 ** 4 });
    expect(readdirSync(root).toSorted()).toEqual([KEY_SAVED_MARKER, TEST_VERSION]);
    expect(await readManaged(root)).toMatchObject({ present: true, versions: [TEST_VERSION] });
  });
});

describe("the plugin's sweep of a backend (createManagedSweep)", () => {
  type Stores = Record<string, StoredKey>;
  const sweepOf = (
    at: ReturnType<typeof installed>,
    options: {
      env?: Record<string, string>;
      stores?: Stores;
      agentDirs?: () => string[];
      settings?: Record<string, unknown>;
      adapter?: CliAdapter;
      pool?: { turns: number; queued: number; closeIdle(): number };
    } = {},
  ) => {
    const unset: string[] = [];
    const probes: Array<Record<string, string | undefined>> = [];
    const looked: Array<string | undefined> = [];
    const base = options.adapter ?? cursorAdapter;
    const adapter: CliAdapter = { ...base, probeAuth: async (p) => (probes.push(p.env), base.probeAuth(p)) };
    const sweep = createManagedSweep(adapter, {
      stateDir: () => at.state,
      settings: { command: at.launcher, ...options.settings },
      agentDirs: options.agentDirs ?? (() => ["/agents/main"]),
      findAnyKey: async ({ agentDir, provider }) => (looked.push(agentDir), provider === "cursor-cli" ? (options.stores?.[agentDir ?? ""] ?? { kind: "absent" }) : { kind: "absent" }),
      env: fakeEnv({ FAKE_CURSOR_LOGGED_IN: "0", ...options.env }),
      unsetCommand: async (backendId, root) => (unset.push(`${backendId}:${root}`), true),
      ...(options.pool ? { pool: options.pool } : {}),
    });
    return { sweep, unset, probes, looked };
  };

  it("removes the managed CLI when no key is left and the CLI is not logged in, probing the login without any key", async () => {
    const at = installed();
    // The managed launcher here is the fake agent, so the login probe runs a real CLI.
    writeFileSync(at.launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CURSOR_AGENT}" "$@"\n`, { mode: 0o755 });
    const { sweep, unset, probes } = sweepOf(at, { settings: { env: { OTHER: "1" } } });
    expect(await sweep()).toEqual({ kind: "removed", root: at.root, commandUnset: true });
    expect(existsSync(at.root)).toBe(false);
    expect(unset).toEqual([`cursor-cli:${at.root}`]);
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ OTHER: "1", FAKE_CURSOR_LOGGED_IN: "0" });
    expect(probes[0]).not.toHaveProperty("CURSOR_API_KEY");
  });

  it.each([
    ["the main agent's auth profile", { stores: { "/agents/main": { kind: "key", key: "k" } } }],
    [
      "another configured agent's profile (any cursor-cli profile, not only main's default)",
      { agentDirs: () => ["/agents/main", "/agents/w"], stores: { "/agents/w": { kind: "key", key: "k" } } },
    ],
    ["the plugin config", { settings: { env: { CURSOR_API_KEY: "k" } } }],
    ["the Gateway's env", { env: { CURSOR_API_KEY: "k" } }],
  ] as Array<[string, Parameters<typeof sweepOf>[1]]>)("keeps it while %s holds a key", async (_label, options) => {
    const at = installed();
    const { sweep, probes } = sweepOf(at, options);
    expect(await sweep()).toEqual({ kind: "kept", reason: "key" });
    expect(existsSync(at.launcher)).toBe(true);
    expect(probes).toEqual([]);
  });

  it("looks in every configured agent's store, and keeps the CLI when one cannot be read or the agent list fails", async () => {
    const at = installed();
    const both = sweepOf(at, { agentDirs: () => ["/agents/main", "/agents/w"], stores: { "/agents/w": { kind: "unreadable" } } });
    expect(await both.sweep()).toEqual({ kind: "kept", reason: "unreadable" });
    expect(both.looked).toEqual(["/agents/main", "/agents/w"]);
    const failing = sweepOf(at, {
      agentDirs: () => {
        throw new Error("no agent dir");
      },
    });
    expect(await failing.sweep()).toEqual({ kind: "kept", reason: "unreadable" });
    expect(existsSync(at.launcher)).toBe(true);
    expect(await hasKeySavedMarker(at.root)).toBe(true);
  });

  it("lets the turn that started it hold its own slot, and only that one", async () => {
    for (const [trigger, expected] of [
      [{ fromTurn: true }, "removed"],
      [undefined, "kept"],
    ] as const) {
      const at = installed();
      writeFileSync(at.launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CURSOR_AGENT}" "$@"\n`, { mode: 0o755 });
      const pool = { turns: 0, queued: 0, closeIdle: () => 0 };
      const { sweep } = sweepOf(at, { pool });
      const pending = sweep(trigger);
      // The keyless turn takes its slot right after it started the sweep.
      pool.turns = 1;
      expect(await pending).toMatchObject(expected === "removed" ? { kind: "removed" } : { kind: "kept", reason: "busy" });
    }
  });

  it("keeps a CLI that is logged in by itself", async () => {
    const at = installed();
    writeFileSync(at.launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CURSOR_AGENT}" "$@"\n`, { mode: 0o755 });
    const { sweep } = sweepOf(at, { env: { FAKE_CURSOR_LOGGED_IN: "1" } });
    expect(await sweep()).toEqual({ kind: "kept", reason: "login" });
    expect(existsSync(at.launcher)).toBe(true);
  });

  it("shares one run between calls that overlap, and does nothing for an adapter without a managed install", async () => {
    const at = installed();
    let probes = 0;
    const slow: CliAdapter = { ...cursorAdapter, probeAuth: async () => (probes += 1, await new Promise((r) => setTimeout(r, 20)), "unreadable") };
    const { sweep } = sweepOf(at, { adapter: slow });
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect(a).toEqual(b);
    expect(probes).toBe(1);
    const { managedInstall: _none, ...unmanaged } = cursorAdapter;
    expect(await sweepOf(at, { adapter: unmanaged }).sweep()).toEqual({ kind: "none" });
  });

  it("logs a removal and a failure, and nothing for a kept CLI", () => {
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(`info ${m}`), warn: (m: string) => lines.push(`warn ${m}`) };
    reportSweep(cursorAdapter, { kind: "removed", root: "/s/tools/cursor-agent", commandUnset: true }, log);
    reportSweep(cursorAdapter, { kind: "failed", reason: "EACCES" }, log);
    reportSweep(cursorAdapter, { kind: "kept", reason: "login" }, log);
    reportSweep(cursorAdapter, { kind: "none" }, log);
    expect(lines).toEqual([
      "info Removed /s/tools/cursor-agent: the plugin had installed Cursor CLI there for an API key, and that key is gone. cursor-cli.command pointed there and is unset. To use Cursor CLI again, connect it in Settings > Models > Connect provider, or run `openclaw models auth login --provider cursor-cli --method api-key-env` on the Gateway host.",
      "warn Could not remove the Cursor CLI the plugin installed for a removed API key: EACCES",
    ]);
  });
});

/** OpenClaw's own config mutation (the isolated OpenClaw under `.spike`), in a scratch state dir. */
describe.skipIf(!hostAvailable)("unsetting the command in OpenClaw's config (host contract)", () => {
  const previous = process.env.OPENCLAW_STATE_DIR;
  afterAll(() => {
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previous;
  });
  const load = async () => import(pathToFileURL(join(HOST_DIST, "plugin-sdk", "config-mutation.js")).href);

  it("deletes a command that points into the managed root, keeps the rest, and leaves any other command alone", async () => {
    const state = newDir("oac-unset-");
    process.env.OPENCLAW_STATE_DIR = state;
    const root = join(state, "tools", "cursor-agent");
    const file = join(state, "openclaw.json");
    const write = (command: string) =>
      writeFileSync(
        file,
        JSON.stringify({ gateway: { mode: "local" }, plugins: { entries: { [PLUGIN_ID]: { enabled: true, config: { "cursor-cli": { command, maxProcesses: 2 } } } } } }),
      );
    const backend = () => JSON.parse(readFileSync(file, "utf8")).plugins.entries[PLUGIN_ID].config["cursor-cli"];
    write(join(root, "1.0.0", "cursor-agent"));
    expect(await unsetManagedCommand("cursor-cli", root, load)).toBe(true);
    expect(backend()).toEqual({ maxProcesses: 2 });
    write("/usr/local/bin/cursor-agent");
    expect(await unsetManagedCommand("cursor-cli", root, load)).toBe(false);
    expect(backend()).toEqual({ command: "/usr/local/bin/cursor-agent", maxProcesses: 2 });
  }, 60_000);
});
