import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import type { FindAnyStoredKey, StoredKey } from "../src/core/auth-store.ts";
import { createModelCatalog } from "../src/core/catalog.ts";
import { dropKeyCache, KEY_CACHE_DIR, keyCacheDirFor, keyCacheEnvFor, THROWAWAY_MAX_AGE_MS, withThrowawayKeyCache } from "../src/core/key-cache.ts";
import { createManifest, type CliAdapter, type ListModelsParams } from "../src/core/ports.ts";
import { dropStaleKeyCaches, keyPresence } from "../src/core/register.ts";

// Plan 27: a CLI run with a key from the plugin caches that key in the agent's home (Cursor writes
// `$XDG_CONFIG_HOME/cursor/auth.json`), never in the user's own CLI config, and the cache goes with the key.

const scratch = mkdtempSync(join(tmpdir(), "oac-key-cache-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let count = 0;
const newHome = () => join(scratch, `home-${(count += 1)}`);

const acme = (overrides: Partial<CliAdapter> = {}): CliAdapter => ({
  id: "acme",
  displayName: "Acme",
  command: "acme",
  launchArgs: ["serve"],
  defaultModel: "acme-cli/auto",
  manifest: createManifest("1", {}),
  alwaysOnNativeTools: [],
  clearEnv: [],
  apiKeyEnvVar: "ACME_KEY",
  keyCacheEnv: (dir) => ({ ACME_CACHE: dir }),
  checkVersion: async () => "ok",
  probeAuth: async () => "available",
  prepareHome: async () => ({}),
  open: async () => {
    throw new Error("not used");
  },
  listModels: async () => [{ name: "auto", label: "Auto", id: "auto" }],
  ...overrides,
});

describe("the Cursor adapter's key cache", () => {
  it("moves Cursor's auth.json with XDG_CONFIG_HOME (CURSOR_CONFIG_DIR does not move it)", () => {
    expect(cursorAdapter.keyCacheEnv?.("/h/key-cache")).toEqual({ XDG_CONFIG_HOME: "/h/key-cache" });
  });
});

describe("a home's key cache", () => {
  it("is <home>/key-cache, private, and named to the CLI by the adapter's env", async () => {
    const home = newHome();
    expect(keyCacheDirFor(home)).toBe(join(home, KEY_CACHE_DIR));
    expect(await keyCacheEnvFor(acme(), home)).toEqual({ ACME_CACHE: join(home, "key-cache") });
    expect(statSync(join(home, "key-cache")).mode & 0o777).toBe(0o700);
    // An existing folder with looser bits is tightened.
    const loose = newHome();
    mkdirSync(join(loose, "key-cache"), { recursive: true, mode: 0o755 });
    await keyCacheEnvFor(acme(), loose);
    expect(statSync(join(loose, "key-cache")).mode & 0o777).toBe(0o700);
  });

  it("is nothing for an adapter that names no cache env", async () => {
    const home = newHome();
    const { keyCacheEnv: _none, ...plain } = acme();
    expect(await keyCacheEnvFor(plain, home)).toEqual({});
    expect(existsSync(join(home, "key-cache"))).toBe(false);
  });

  it("fails the run, rather than caching in the user's config, when the folder cannot be made", async () => {
    const blocked = newHome();
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "key-cache"), "a file, not a folder");
    await expect(keyCacheEnvFor(acme(), blocked)).rejects.toMatchObject({ code: "unclassified", message: expect.stringMatching(/key cache folder/) });
  });

  it("is deleted with everything in it, and a missing one is fine", async () => {
    const home = newHome();
    await keyCacheEnvFor(acme(), home);
    writeFileSync(join(home, "key-cache", "auth.json"), "{}");
    await dropKeyCache(home);
    expect(existsSync(join(home, "key-cache"))).toBe(false);
    await dropKeyCache(home);
  });

  it("keeps a throwaway cache a listing or probe of the same home is using, and drops a crash's old leftover", async () => {
    const home = newHome();
    await keyCacheEnvFor(acme(), home);
    writeFileSync(join(home, "key-cache", "auth.json"), "{}");
    let once = "";
    await withThrowawayKeyCache(acme(), home, async (env) => {
      once = env.ACME_CACHE!;
      writeFileSync(join(env.ACME_CACHE!, "auth.json"), "{}");
      // A keyless turn of the same home drops the cache meanwhile.
      await dropKeyCache(home);
      expect(existsSync(join(env.ACME_CACHE!, "auth.json"))).toBe(true);
      expect(existsSync(join(home, "key-cache", "auth.json"))).toBe(false);
    });
    expect(existsSync(once)).toBe(false);
    // A leftover older than any listing or probe goes.
    mkdirSync(join(home, "key-cache", "once-left"), { recursive: true });
    await dropKeyCache(home, Date.now() + THROWAWAY_MAX_AGE_MS + 1000);
    expect(existsSync(join(home, "key-cache"))).toBe(false);
  });

  it("gives a one-off process a throwaway folder, under the home's cache or the temp folder, deleted after (also on a throw)", async () => {
    const home = newHome();
    const seen: string[] = [];
    await withThrowawayKeyCache(acme(), home, async (env) => seen.push(env.ACME_CACHE!));
    expect(seen[0]!.startsWith(join(home, "key-cache", "once-"))).toBe(true);
    expect(existsSync(seen[0]!)).toBe(false);
    await expect(
      withThrowawayKeyCache(acme(), undefined, async (env) => {
        seen.push(env.ACME_CACHE!);
        expect(statSync(env.ACME_CACHE!).mode & 0o777).toBe(0o700);
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");
    expect(seen[1]!.startsWith(join(tmpdir(), "oac-key-cache-"))).toBe(true);
    expect(existsSync(seen[1]!)).toBe(false);
  });
});

describe("a model listing with a key from the plugin", () => {
  it("runs with a throwaway key cache under the listing's home, removed after, and shares the cache entry of the same env", async () => {
    const seen: ListModelsParams[] = [];
    const cacheSeen: Array<boolean> = [];
    const adapter = acme({
      listModels: async (params) => {
        seen.push(params);
        cacheSeen.push(existsSync(params.env.ACME_CACHE ?? "/nonexistent"));
        return [{ name: "auto", label: "Auto", id: "auto" }];
      },
    });
    const catalog = createModelCatalog(adapter);
    const home = newHome();
    await catalog.list({ command: "acme", env: { ACME_KEY: "k" }, lockDir: home, isolateKey: true });
    expect(seen[0]!.env.ACME_CACHE!.startsWith(join(home, "key-cache", "once-"))).toBe(true);
    expect(cacheSeen[0]).toBe(true);
    expect(existsSync(seen[0]!.env.ACME_CACHE!)).toBe(false);
    // Same env: served from the catalog's cache.
    await catalog.list({ command: "acme", env: { ACME_KEY: "k" }, lockDir: home, isolateKey: true });
    expect(seen).toHaveLength(1);
    // A key from the Gateway's env (not the plugin's) lists without one.
    await catalog.list({ command: "acme", env: { ACME_KEY: "other" }, lockDir: home });
    expect(seen[1]!.env).not.toHaveProperty("ACME_CACHE");
  });
});

describe("dropping the key caches of agents whose key is gone (Gateway start)", () => {
  const stores = (byAgent: Record<string, StoredKey>) => {
    const looked: Array<string | undefined> = [];
    const findAnyKey: FindAnyStoredKey = async ({ agentDir }) => (looked.push(agentDir), byAgent[agentDir ?? ""] ?? { kind: "absent" });
    return { looked, findAnyKey };
  };

  it("drops only a cache whose agent has no key, keeps one whose store cannot be read, and reads no store for a home without a cache", async () => {
    const homes = ["gone", "kept", "unreadable", "none"].map((name) => ({ agentDir: `/agents/${name}`, home: join(scratch, `drop-${name}`) }));
    for (const { home } of homes.slice(0, 3)) await keyCacheEnvFor(acme(), home);
    const { looked, findAnyKey } = stores({ "/agents/kept": { kind: "key", key: "k" }, "/agents/unreadable": { kind: "unreadable" } });
    expect(await dropStaleKeyCaches(acme(), { settings: {}, homes, findAnyKey })).toEqual([homes[0]!.home]);
    expect(existsSync(keyCacheDirFor(homes[0]!.home))).toBe(false);
    expect(existsSync(keyCacheDirFor(homes[1]!.home))).toBe(true);
    expect(existsSync(keyCacheDirFor(homes[2]!.home))).toBe(true);
    expect(looked).toEqual(["/agents/gone", "/agents/kept", "/agents/unreadable"]);
  });

  it("keeps every cache while the plugin config holds a key", async () => {
    const home = newHome();
    await keyCacheEnvFor(acme(), home);
    const { looked, findAnyKey } = stores({});
    expect(await dropStaleKeyCaches(acme(), { settings: { env: { ACME_KEY: "k" } }, homes: [{ agentDir: "/a", home }], findAnyKey })).toEqual([]);
    expect(existsSync(keyCacheDirFor(home))).toBe(true);
    expect(looked).toEqual([]);
  });
});

describe("whether the plugin has a key anywhere (the sweep's check)", () => {
  it("is a key from the plugin config or the Gateway's env before any store is read", async () => {
    let reads = 0;
    const findAnyKey: FindAnyStoredKey = async () => ((reads += 1), { kind: "absent" });
    expect(await keyPresence(acme(), { settings: { env: { ACME_KEY: "k" } }, findAnyKey, env: {} })).toBe("key");
    expect(await keyPresence(acme(), { settings: {}, findAnyKey, env: { ACME_KEY: "k" } })).toBe("key");
    expect(reads).toBe(0);
  });

  it("reads every agent's store, the main store when no agent is listed, and is unreadable when one fails without a key elsewhere", async () => {
    const looked: Array<string | undefined> = [];
    const answers: Record<string, StoredKey> = { "/a": { kind: "unreadable" }, "/b": { kind: "key", key: "k" } };
    const findAnyKey: FindAnyStoredKey = async ({ agentDir }) => (looked.push(agentDir), answers[agentDir ?? ""] ?? { kind: "absent" });
    expect(await keyPresence(acme(), { settings: {}, env: {}, findAnyKey, agentDirs: () => ["/a", "/b"] })).toBe("key");
    expect(await keyPresence(acme(), { settings: {}, env: {}, findAnyKey, agentDirs: () => ["/a", "/c"] })).toBe("unreadable");
    expect(await keyPresence(acme(), { settings: {}, env: {}, findAnyKey, agentDirs: () => ["/c"] })).toBe("none");
    looked.length = 0;
    expect(await keyPresence(acme(), { settings: {}, env: {}, findAnyKey })).toBe("none");
    expect(looked).toEqual([undefined]);
  });
});
