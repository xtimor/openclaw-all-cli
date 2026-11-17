import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import { buildCliBackend, type BuildBackendOptions } from "../src/core/backend.ts";
import { createUsageHooks } from "../src/core/quota.ts";
import { createSyntheticAuthProvider } from "../src/core/synthetic-auth.ts";
import type { SweepOutcome } from "../src/core/managed-install.ts";
import type { ReadStoredKey, StoredKey } from "../src/core/auth-store.ts";
import { PLUGIN_ID } from "../src/core/synthetic-auth.ts";
import type { CliAdapter } from "../src/core/ports.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";

// Plan 27: the API key lives in OpenClaw's auth store (profile cursor-cli:default). These tests run the
// real backend and the fake agent: the key reaches the CLI process from the profile, and nothing else.

const KEY = "key_profile_0123456789abcdef";
const CONFIG_KEY = "key_config_0123456789abcdef";
const hash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 8);

const scratch = mkdtempSync(join(tmpdir(), "oac-profile-key-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;

/** A store of profile ID to key, and the reads it served; `unreadable` makes every read fail. */
function store(keys: Record<string, string> = {}, options: { unreadable?: boolean } = {}) {
  const reads: Array<{ agentDir?: string | undefined; profileId: string; provider: string }> = [];
  const readKey: ReadStoredKey = async (query): Promise<StoredKey> => {
    reads.push(query);
    if (options.unreadable) return { kind: "unreadable" };
    const key = query.provider === "cursor-cli" ? keys[query.profileId] : undefined;
    return key ? { kind: "key", key } : { kind: "absent" };
  };
  return { reads, readKey };
}

type Line = Record<string, any>;

/** One prepared turn as the host runs it, with the fake agent's log. */
async function turn(options: Partial<BuildBackendOptions> & { authProfileId?: string; env?: Record<string, string>; adapter?: CliAdapter; agentDir?: string } = {}) {
  count += 1;
  const log = join(scratch, `log-${count}.jsonl`);
  const { authProfileId, env, adapter, agentDir: givenDir, ...build } = options;
  const agentDir = givenDir ?? join(scratch, `agent-${count}`);
  const backend = buildCliBackend(adapter ?? cursorAdapter, { settings: {}, gatewayEnv: {}, ...build });
  const prepared = await backend.prepareExecution!({ agentDir, ...(authProfileId ? { authProfileId } : {}) } as never);
  const records: Line[] = [];
  for await (const record of prepared!.execute!({
    command: FAKE_CURSOR_AGENT,
    args: ["acp"],
    cwd: scratch,
    env: fakeEnv({ FAKE_CURSOR_LOG: log, ...env }),
    prompt: "say:pong",
    modelId: "auto",
    systemPrompt: "",
    useResume: false,
    timeoutMs: 10_000,
    requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
    requestUserInput: async () => ({ status: "cancelled", message: "no" }),
  } as never)) {
    records.push(record as Line);
  }
  const lines: Line[] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { backend, prepared: prepared as Record<string, unknown>, records, lines, agentDir, logText: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

const init = (lines: Line[]) => lines.find((line) => line.method === "initialize")!;
const methods = (lines: Line[]) => lines.map((line) => line.method);

describe("a turn with the key only in the auth profile (plan 27)", () => {
  it("answers with the profile's key in the CLI process, and the key is nowhere else", async () => {
    const keys = store({ "cursor-cli:default": KEY });
    const before = process.env.CURSOR_API_KEY;
    const { backend, prepared, records, lines, agentDir, logText } = await turn({ readKey: keys.readKey });
    expect(records.at(-1)).toMatchObject({ type: "result", is_error: false });
    expect(init(lines)).toMatchObject({ keyed: true, keyHash: hash(KEY) });
    // With a key Cursor needs no login step.
    expect(methods(lines)).not.toContain("authenticate");
    expect(keys.reads).toEqual([{ agentDir, profileId: "cursor-cli:default", provider: "cursor-cli" }]);
    // Not in the backend's config env (the host's), not in a prepared env, not in the Gateway's env: `exec` cannot see it.
    expect(backend.config.env).toBeUndefined();
    expect(prepared).not.toHaveProperty("env");
    expect(process.env.CURSOR_API_KEY).toBe(before);
    expect(logText).not.toContain(KEY);
    expect(JSON.stringify(records)).not.toContain(KEY);
  });

  it("reads the profile the host picked for the run", async () => {
    const keys = store({ "cursor-cli:default": "other", "cursor-cli:manual": KEY });
    const { lines, agentDir } = await turn({ readKey: keys.readKey, authProfileId: "cursor-cli:manual" });
    expect(init(lines)).toMatchObject({ keyed: true, keyHash: hash(KEY) });
    expect(keys.reads).toEqual([{ agentDir, profileId: "cursor-cli:manual", provider: "cursor-cli" }]);
  });

  it("lets the profile's key win over a key in the plugin config", async () => {
    const keys = store({ "cursor-cli:default": KEY });
    const { lines } = await turn({ readKey: keys.readKey, settings: { env: { CURSOR_API_KEY: CONFIG_KEY } }, env: { CURSOR_API_KEY: CONFIG_KEY } });
    expect(init(lines)).toMatchObject({ keyHash: hash(KEY) });
  });

  it("falls back to the plugin config's key when the profile cannot be read, then to the CLI's own login", async () => {
    const config = await turn({ readKey: store().readKey, settings: { env: { CURSOR_API_KEY: CONFIG_KEY } }, env: { CURSOR_API_KEY: CONFIG_KEY } });
    expect(init(config.lines)).toMatchObject({ keyHash: hash(CONFIG_KEY) });
    const login = await turn({ readKey: store().readKey });
    expect(login.records.at(-1)).toMatchObject({ type: "result", is_error: false });
    expect(init(login.lines)).toMatchObject({ keyed: false });
    expect(methods(login.lines)).toContain("authenticate");
  });

  it("leaves an adapter without a key variable alone", async () => {
    const { apiKeyEnvVar: _none, ...noKey } = cursorAdapter;
    const keys = store({ "cursor-cli:default": KEY });
    const { lines } = await turn({ adapter: noKey, readKey: keys.readKey });
    expect(keys.reads).toEqual([]);
    expect(init(lines)).toMatchObject({ keyed: false });
  });
});

describe("a turn with no key anywhere sweeps a managed CLI whose key is gone", () => {
  const sweeper = (outcome: SweepOutcome | Promise<SweepOutcome>) => {
    const calls = { count: 0, triggers: [] as unknown[] };
    return { calls, sweep: async (trigger?: unknown) => (calls.count += 1, calls.triggers.push(trigger), outcome) };
  };

  it("starts the sweep and runs the turn without waiting for it", async () => {
    let finish!: (outcome: SweepOutcome) => void;
    const { calls, sweep } = sweeper(new Promise<SweepOutcome>((resolve) => (finish = resolve)));
    const { records } = await turn({ readKey: store().readKey, sweep });
    expect(calls.count).toBe(1);
    // The turn's own slot does not count as busy at the removal.
    expect(calls.triggers).toEqual([{ fromTurn: true }]);
    // The sweep is still running: the turn did not wait for it.
    expect(records.at(-1)).toMatchObject({ type: "result", is_error: false });
    finish({ kind: "removed", root: "/state/tools/cursor-agent", commandUnset: true });
  });

  it("is not held up by a sweep that fails", async () => {
    const { records } = await turn({ readKey: store().readKey, sweep: () => Promise.reject(new Error("boom")) });
    expect(records.at(-1)).toMatchObject({ type: "result", is_error: false });
  });

  it("does not sweep when a key exists: in the profile, the plugin config, or the Gateway's env", async () => {
    for (const options of [
      { readKey: store({ "cursor-cli:default": KEY }).readKey },
      { readKey: store().readKey, settings: { env: { CURSOR_API_KEY: CONFIG_KEY } } },
      { readKey: store().readKey, gatewayEnv: { CURSOR_API_KEY: CONFIG_KEY } },
    ]) {
      const { calls, sweep } = sweeper({ kind: "removed", root: "/x", commandUnset: false });
      const { records } = await turn({ ...options, sweep });
      expect(calls.count).toBe(0);
      expect(records.at(-1)).toMatchObject({ type: "result", is_error: false });
    }
  });
});

describe("a key the plugin hands over is cached in the agent's home, never in the user's CLI config", () => {
  /** A scratch HOME, so the fake's "user config" (`$HOME/.config/cursor/auth.json`) is one the test can look at. */
  const userHome = () => {
    count += 1;
    const home = join(scratch, `user-home-${count}`);
    mkdirSync(home, { recursive: true });
    return { home, userCache: join(home, ".config", "cursor", "auth.json") };
  };
  const cacheOf = (agentDir: string) => join(agentDir, "openclaw-all-cli", "cursor-cli", "key-cache");

  it("caches the profile's key under the home's key-cache, and a later keyless turn finds no cached copy", async () => {
    const { home, userCache } = userHome();
    const agentDir = join(scratch, `agent-cache-${count}`);
    const env = { HOME: home, FAKE_CURSOR_KEY_CACHE: "1" };
    const keyed = await turn({ agentDir, env, readKey: store({ "cursor-cli:default": KEY }).readKey });
    expect(init(keyed.lines)).toMatchObject({ keyed: true, keyHash: hash(KEY), env: { XDG_CONFIG_HOME: cacheOf(agentDir) } });
    expect(existsSync(join(cacheOf(agentDir), "cursor", "auth.json"))).toBe(true);
    expect(statSync(cacheOf(agentDir)).mode & 0o777).toBe(0o700);
    expect(existsSync(userCache)).toBe(false);
    // Remove key: the profile is gone. The next turn runs on the CLI's own config, without the key, and the cache is gone.
    const keyless = await turn({ agentDir, env, readKey: store().readKey });
    expect(init(keyless.lines)).toMatchObject({ keyed: false, cachedKeyHash: null });
    // The plugin sets no XDG_CONFIG_HOME: the run keeps whatever the Gateway's own env has (CI runners set one).
    expect(init(keyless.lines).env.XDG_CONFIG_HOME).toBe(process.env.XDG_CONFIG_HOME);
    expect(methods(keyless.lines)).toContain("authenticate");
    expect(existsSync(cacheOf(agentDir))).toBe(false);
    expect(existsSync(userCache)).toBe(false);
  });

  it("caches a plugin config key there too, but leaves a Gateway env key and a keyless run with the user's config", async () => {
    const { home } = userHome();
    const agentDir = join(scratch, `agent-config-${count}`);
    const config = await turn({ agentDir, env: { HOME: home, CURSOR_API_KEY: CONFIG_KEY }, readKey: store().readKey, settings: { env: { CURSOR_API_KEY: CONFIG_KEY } } });
    expect(init(config.lines)).toMatchObject({ keyHash: hash(CONFIG_KEY), env: { XDG_CONFIG_HOME: cacheOf(agentDir) } });
    const gateway = await turn({ agentDir, env: { HOME: home, CURSOR_API_KEY: CONFIG_KEY }, readKey: store().readKey, gatewayEnv: { CURSOR_API_KEY: CONFIG_KEY } });
    expect(init(gateway.lines)).toMatchObject({ keyHash: hash(CONFIG_KEY) });
    expect(init(gateway.lines).env.XDG_CONFIG_HOME).toBe(process.env.XDG_CONFIG_HOME);
    // No key from the plugin any more: its cache went with it.
    expect(existsSync(cacheOf(agentDir))).toBe(false);
  });

  it("keeps the cache when the auth store cannot be read: no key found is not no key", async () => {
    const { home } = userHome();
    const agentDir = join(scratch, `agent-unreadable-${count}`);
    await turn({ agentDir, env: { HOME: home }, readKey: store({ "cursor-cli:default": KEY }).readKey });
    expect(existsSync(cacheOf(agentDir))).toBe(true);
    const unreadable = await turn({ agentDir, env: { HOME: home }, readKey: store({}, { unreadable: true }).readKey });
    expect(init(unreadable.lines)).toMatchObject({ keyed: false });
    expect(existsSync(cacheOf(agentDir))).toBe(true);
  });
});

describe("probes and quota read the profile's key (plan 27)", () => {
  it("lists the account's models with the profile's key: the catalog probe and the listing see it, and cache it in a throwaway folder", async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const cacheDirs: string[] = [];
    const spy: CliAdapter = {
      ...cursorAdapter,
      probeAuth: async (params) => {
        seen.push(params.env);
        if (params.env.XDG_CONFIG_HOME) cacheDirs.push(params.env.XDG_CONFIG_HOME);
        return params.env.CURSOR_API_KEY ? "available" : "missing";
      },
    };
    const listed: Array<Record<string, unknown>> = [];
    const catalog = { list: async (params: Record<string, unknown>) => (listed.push(params), [{ id: "m", name: "m", label: "M" }]) };
    const keys = store({ "cursor-cli:default": KEY });
    const provider = createSyntheticAuthProvider(spy, catalog as never, { readKey: keys.readKey });
    const config = { plugins: { entries: { [PLUGIN_ID]: { config: { "cursor-cli": { command: FAKE_CURSOR_AGENT, env: { CURSOR_API_KEY: CONFIG_KEY } } } } } } };
    const agentDir = join(scratch, "agent-catalog");
    const home = join(agentDir, "openclaw-all-cli", "cursor-cli");
    const result = await provider.catalog!.run({ config, env: { PATH: "/bin", CURSOR_API_KEY: "gateway" }, agentDir });
    expect(result?.provider.models.map((model: { id: string }) => model.id)).toEqual(["m"]);
    expect(seen[0]?.CURSOR_API_KEY).toBe(KEY);
    expect((listed[0]?.env as Record<string, string>).CURSOR_API_KEY).toBe(KEY);
    // The key came from the plugin: the probe ran with a throwaway key cache under the home's, deleted after; the listing is told to do the same.
    expect(cacheDirs[0]?.startsWith(join(home, "key-cache", "once-"))).toBe(true);
    expect(existsSync(cacheDirs[0]!)).toBe(false);
    expect(listed[0]).toMatchObject({ lockDir: home, isolateKey: true });
    expect(keys.reads[0]).toEqual({ agentDir, profileId: "cursor-cli:default", provider: "cursor-cli" });
    // A Gateway env key alone is not the plugin's: no isolation, as before.
    const envOnly = createSyntheticAuthProvider(spy, catalog as never, { readKey: store().readKey });
    await envOnly.catalog!.run({ config: {}, env: { PATH: "/bin", CURSOR_API_KEY: "gateway-key" }, agentDir });
    expect(listed.at(-1)).not.toHaveProperty("isolateKey");
    expect(seen.at(-1)?.XDG_CONFIG_HOME).toBeUndefined();
    // Without any key: the default model only, as before.
    const bare = createSyntheticAuthProvider(spy, catalog as never, { readKey: store().readKey });
    const fallback = await bare.catalog!.run({ config: {}, env: { PATH: "/bin" } });
    expect(fallback?.provider.models.map((model: { id: string }) => model.id)).toEqual(["auto"]);
    // The native-login probe counts the stored key too, isolated in the temp folder (no agent there).
    expect(await provider.prepareSyntheticAuth({ config, provider: "cursor-cli", env: { PATH: "/bin" } })).toMatchObject({ mode: "oauth" });
    expect(cacheDirs.at(-1)?.startsWith(join(tmpdir(), "oac-key-cache-"))).toBe(true);
    expect(existsSync(cacheDirs.at(-1)!)).toBe(false);
  });

  it("asks OpenClaw first (its store holds the profile), then the plugin config, then the env, and reads the store itself only without OpenClaw's helpers", async () => {
    const hooks = (keys: Record<string, string>, reads?: string[]) =>
      createUsageHooks(cursorAdapter, PLUGIN_ID, () => {}, {
        readKey: async (query) => (reads?.push(query.profileId), keys[query.profileId] ? { kind: "key", key: keys[query.profileId]! } : { kind: "absent" }),
        cliPresent: () => true,
      })!;
    const config = { plugins: { entries: { [PLUGIN_ID]: { config: { "cursor-cli": { env: { CURSOR_API_KEY: CONFIG_KEY } } } } } } };
    const reads: string[] = [];
    // OpenClaw's answer wins, and the plugin then imports nothing.
    expect(
      await hooks({ "cursor-cli:default": "unused" }, reads).resolveUsageAuth({
        config,
        env: { CURSOR_API_KEY: "env" },
        resolveApiKeyCandidatesFromConfigAndStore: async () => ["openclaw:cursor-cli-native-auth", KEY],
        resolveApiKeyFromConfigAndStore: () => "legacy",
      }),
    ).toEqual({ token: KEY });
    expect(await hooks({}, reads).resolveUsageAuth({ env: {}, resolveApiKeyFromConfigAndStore: () => KEY })).toEqual({ token: KEY });
    expect(reads).toEqual([]);
    // OpenClaw has none: the plugin config's key, then the env's; the store is not read again.
    expect(await hooks({}, reads).resolveUsageAuth({ config, env: { CURSOR_API_KEY: "env" }, resolveApiKeyCandidatesFromConfigAndStore: async () => [] })).toEqual({ token: CONFIG_KEY });
    expect(await hooks({}, reads).resolveUsageAuth({ env: { CURSOR_API_KEY: "env" }, resolveApiKeyFromConfigAndStore: () => undefined })).toEqual({ token: "env" });
    expect(await hooks({}, reads).resolveUsageAuth({ env: {}, resolveApiKeyFromConfigAndStore: () => undefined })).toEqual({ handled: true });
    expect(reads).toEqual([]);
    // A host without the helpers (or one whose helper throws): the plugin reads the default profile itself.
    expect(await hooks({ "cursor-cli:default": KEY }, reads).resolveUsageAuth({ env: {} })).toEqual({ token: KEY });
    expect(
      await hooks({ "cursor-cli:default": KEY }, reads).resolveUsageAuth({
        env: {},
        resolveApiKeyCandidatesFromConfigAndStore: async () => {
          throw new Error("store locked");
        },
      }),
    ).toEqual({ token: KEY });
    expect(reads).toEqual(["cursor-cli:default", "cursor-cli:default"]);
    expect(await hooks({}).resolveUsageAuth({ env: {} })).toEqual({ handled: true });
  });

  it("honors the host's signal: an aborted request, and a slow store read cut short", async () => {
    const aborted = AbortSignal.abort(new Error("usage budget"));
    const hooks = createUsageHooks(cursorAdapter, PLUGIN_ID, () => {}, { readKey: () => new Promise<never>(() => {}), cliPresent: () => true })!;
    await expect(hooks.resolveUsageAuth({ env: {}, signal: aborted })).rejects.toThrow("usage budget");
    const controller = new AbortController();
    const pending = hooks.resolveUsageAuth({ env: {}, signal: controller.signal });
    controller.abort(new Error("timed out"));
    await expect(pending).rejects.toThrow("timed out");
  });
});
