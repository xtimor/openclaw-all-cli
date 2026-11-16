import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  createAuthStore,
  createStoredKeyReader,
  defaultProfileIdFor,
  isPluginSupplied,
  keyOfCredential,
  resolveCliKey,
  type AuthStoreRuntime,
  type StoredKey,
} from "../src/core/auth-store.ts";
import { HOST_DIST, hostAvailable } from "./fixtures/host-code.ts";

const KEY = "key_store_0123456789abcdef";
const PROFILE = "cursor-cli:default";
const apiKey = (key: string, provider = "cursor-cli") => ({ type: "api_key", provider, key });
const found = (key: string): StoredKey => ({ kind: "key", key });
const ABSENT = { kind: "absent" };
const UNREADABLE = { kind: "unreadable" };

describe("the key of a stored credential (plan 27)", () => {
  it("is the inline key of an api_key profile of the provider, trimmed", () => {
    expect(keyOfCredential(apiKey(` ${KEY}\n`), "cursor-cli")).toBe(KEY);
    expect(keyOfCredential(apiKey(KEY, "Cursor-CLI"), "cursor-cli")).toBe(KEY);
  });

  it.each([
    ["another provider's key", apiKey(KEY, "openai")],
    ["a secret reference without an inline key", { type: "api_key", provider: "cursor-cli", keyRef: { source: "store", id: "X" } }],
    ["a token credential", { type: "token", provider: "cursor-cli", token: KEY }],
    ["an OAuth credential", { type: "oauth", provider: "cursor-cli", access: KEY }],
    ["an in-memory native-auth presence", { ...apiKey(KEY), nativeAuth: { runtime: "cursor-cli", mode: "oauth" } }],
    ["an openclaw: marker", apiKey("openclaw:cursor-cli-native-auth")],
    ["an empty key", apiKey("  ")],
    ["a key with a space", apiKey("a b")],
    ["nothing", undefined],
  ])("is none for %s", (_label, credential) => {
    expect(keyOfCredential(credential, "cursor-cli")).toBeUndefined();
  });

  it("is read from the profile <backendId>:default when the host names none", () => {
    expect(defaultProfileIdFor("cursor-cli")).toBe(PROFILE);
  });
});

describe("the auth store reader", () => {
  it("prefers OpenClaw's async lookup, passes the agent and the profile, and checks the provider", async () => {
    const asked: unknown[] = [];
    const read = createStoredKeyReader(async () => ({
      findPersistedAuthProfileCredentialAsync: async (params) => (asked.push(params), apiKey(KEY)),
      findPersistedAuthProfileCredential: () => {
        throw new Error("the deprecated sync lookup must not run");
      },
    }));
    expect(await read({ agentDir: "/agents/a", profileId: PROFILE, provider: "cursor-cli" })).toEqual(found(KEY));
    expect(await read({ profileId: PROFILE, provider: "other-cli" })).toEqual(ABSENT);
    expect(asked).toEqual([{ agentDir: "/agents/a", profileId: PROFILE }, { profileId: PROFILE }]);
  });

  it("uses the sync lookup of OpenClaw 2026.10.3 when the async one is missing", async () => {
    const read = createStoredKeyReader(async () => ({ findPersistedAuthProfileCredential: () => apiKey(KEY) }));
    expect(await read({ profileId: PROFILE, provider: "cursor-cli" })).toEqual(found(KEY));
    expect(await createStoredKeyReader(async () => ({ findPersistedAuthProfileCredential: () => undefined }))({ profileId: PROFILE, provider: "cursor-cli" })).toEqual(ABSENT);
  });

  it("never throws: a failing load, a failing lookup, or no lookup at all reads as unreadable, not as no key; a failed load is tried again", async () => {
    let loads = 0;
    const flaky = createStoredKeyReader(async () => {
      loads += 1;
      if (loads === 1) throw new Error("no host");
      return { findPersistedAuthProfileCredential: () => apiKey(KEY) };
    });
    expect(await flaky({ profileId: PROFILE, provider: "cursor-cli" })).toEqual(UNREADABLE);
    expect(await flaky({ profileId: PROFILE, provider: "cursor-cli" })).toEqual(found(KEY));
    expect(await flaky({ profileId: PROFILE, provider: "cursor-cli" })).toEqual(found(KEY));
    expect(loads).toBe(2);
    const failing = createStoredKeyReader(async () => ({
      findPersistedAuthProfileCredentialAsync: async () => {
        throw new Error(`store locked ${KEY}`);
      },
    }));
    expect(await failing({ profileId: PROFILE, provider: "cursor-cli" })).toEqual(UNREADABLE);
    expect(await createStoredKeyReader(async () => ({}))({ profileId: PROFILE, provider: "cursor-cli" })).toEqual(UNREADABLE);
  });
});

describe("any key of the provider in an agent's store (the sweep's lookup)", () => {
  const store = (profiles: Record<string, unknown>) => ({ profiles });
  const list = (s: { profiles?: Record<string, unknown> }, provider: string) =>
    Object.entries(s.profiles ?? {})
      .filter(([, credential]) => (credential as { provider?: string }).provider === provider)
      .map(([id]) => id);

  it("finds a key in any api_key profile of the provider, not only the default one, with the async loader first", async () => {
    const loaded: unknown[] = [];
    const { findAnyKey } = createAuthStore(async () => ({
      loadAuthProfileStoreWithoutExternalProfilesAsync: async (agentDir) => (loaded.push(agentDir), store({ "cursor-cli:manual": apiKey(KEY), "openai:default": apiKey("o", "openai") })),
      loadAuthProfileStoreWithoutExternalProfiles: () => {
        throw new Error("the deprecated sync loader must not run");
      },
      listProfilesForProvider: list,
    }));
    expect(await findAnyKey({ agentDir: "/agents/w", provider: "cursor-cli" })).toEqual(found(KEY));
    expect(await findAnyKey({ provider: "cursor-cli" })).toEqual(found(KEY));
    expect(loaded).toEqual(["/agents/w", undefined]);
  });

  it("is absent when the provider's profiles hold no usable key, and uses the sync loader of OpenClaw 2026.10.3", async () => {
    const { findAnyKey } = createAuthStore(async () => ({
      loadAuthProfileStoreWithoutExternalProfiles: () =>
        store({ "cursor-cli:ref": { type: "api_key", provider: "cursor-cli", keyRef: { id: "X" } }, "openai:default": apiKey(KEY, "openai") }),
      listProfilesForProvider: list,
    }));
    expect(await findAnyKey({ provider: "cursor-cli" })).toEqual(ABSENT);
  });

  it("is unreadable when the module or the store fails, and reads the default profile when the host lists no profiles", async () => {
    expect(await createAuthStore(async () => Promise.reject(new Error("no host"))).findAnyKey({ provider: "cursor-cli" })).toEqual(UNREADABLE);
    const broken = createAuthStore(async () => ({
      loadAuthProfileStoreWithoutExternalProfilesAsync: async () => {
        throw new Error("store locked");
      },
      listProfilesForProvider: list,
    }));
    expect(await broken.findAnyKey({ provider: "cursor-cli" })).toEqual(UNREADABLE);
    const asked: string[] = [];
    const unlisted = createAuthStore(async () => ({ findPersistedAuthProfileCredential: ({ profileId }) => (asked.push(profileId), apiKey(KEY)) }));
    expect(await unlisted.findAnyKey({ agentDir: "/a", provider: "cursor-cli" })).toEqual(found(KEY));
    expect(asked).toEqual([PROFILE]);
  });
});

describe("the key a CLI process gets", () => {
  const store = (keys: Record<string, string>, unreadable = false) => async ({ profileId }: { profileId: string }): Promise<StoredKey> =>
    unreadable ? { kind: "unreadable" } : keys[profileId] ? { kind: "key", key: keys[profileId] } : { kind: "absent" };
  const base = { keyVar: "CURSOR_API_KEY", provider: "cursor-cli" };

  it("is the auth store's first, then the plugin config's, then the Gateway env's", async () => {
    const pluginEnv = { CURSOR_API_KEY: "from-config" };
    const env = { CURSOR_API_KEY: "from-env" };
    const none = { key: undefined, source: undefined, storeUnreadable: false };
    expect(await resolveCliKey({ ...base, readKey: store({ [PROFILE]: KEY }), pluginEnv, env })).toEqual({ key: KEY, source: "store", storeUnreadable: false });
    expect(await resolveCliKey({ ...base, readKey: store({}), pluginEnv, env })).toEqual({ key: "from-config", source: "config", storeUnreadable: false });
    expect(await resolveCliKey({ ...base, readKey: store({}), pluginEnv: { CURSOR_API_KEY: " " }, env })).toEqual({ key: "from-env", source: "env", storeUnreadable: false });
    expect(await resolveCliKey({ ...base, readKey: store({}) })).toEqual(none);
  });

  it("falls back past an unreadable store and says so", async () => {
    expect(await resolveCliKey({ ...base, readKey: store({}, true), pluginEnv: { CURSOR_API_KEY: "c" } })).toEqual({ key: "c", source: "config", storeUnreadable: true });
    expect(await resolveCliKey({ ...base, readKey: store({}, true) })).toEqual({ key: undefined, source: undefined, storeUnreadable: true });
  });

  it("counts a profile's or the plugin config's key as the plugin's own, not one from the Gateway's env", () => {
    expect(isPluginSupplied({ key: "k", source: "store", storeUnreadable: false })).toBe(true);
    expect(isPluginSupplied({ key: "k", source: "config", storeUnreadable: false })).toBe(true);
    expect(isPluginSupplied({ key: "k", source: "env", storeUnreadable: false })).toBe(false);
    expect(isPluginSupplied({ key: undefined, source: undefined, storeUnreadable: false })).toBe(false);
  });

  it("reads the profile the host picked, not the default one, when the host names one", async () => {
    const readKey = store({ [PROFILE]: "default-key", "cursor-cli:manual": KEY });
    expect(await resolveCliKey({ ...base, readKey, profileId: "cursor-cli:manual" })).toMatchObject({ key: KEY, source: "store" });
    // A picked profile the store cannot give a key for falls back to the plugin config, not to another profile.
    expect(await resolveCliKey({ ...base, readKey, profileId: "cursor-cli:oauth", pluginEnv: { CURSOR_API_KEY: "c" } })).toMatchObject({ key: "c", source: "config" });
  });
});

/**
 * OpenClaw's own auth store: the profile its login flow persists is the one the reader finds. Runs
 * against the isolated OpenClaw (2026.10.3 under `.spike`, or `OPENCLAW_ALL_CLI_HOST_DIST`), in a
 * scratch state dir.
 */
describe.skipIf(!hostAvailable)("OpenClaw's auth store (host contract)", () => {
  const state = mkdtempSync(join(tmpdir(), "oac-auth-store-"));
  const previous = process.env.OPENCLAW_STATE_DIR;
  afterAll(() => {
    if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previous;
    rmSync(state, { recursive: true, force: true });
  });

  it("finds the api_key profile OpenClaw saved, for the agent and for the main store", async () => {
    process.env.OPENCLAW_STATE_DIR = state;
    const sdk = (name: string) => import(pathToFileURL(join(HOST_DIST, "plugin-sdk", `${name}.js`)).href);
    const auth = (await sdk("provider-auth")) as {
      upsertAuthProfileWithLock: (params: { profileId: string; credential: unknown; agentDir?: string }) => Promise<unknown>;
      removeProviderAuthProfilesWithLock?: (params: Record<string, unknown>) => Promise<unknown>;
    };
    const agentDir = join(state, "agents", "main", "agent");
    await auth.upsertAuthProfileWithLock({ profileId: PROFILE, credential: apiKey(KEY), agentDir });
    const { readKey: read, findAnyKey } = createAuthStore(async () => (await sdk("agent-runtime")) as AuthStoreRuntime);
    expect(await read({ agentDir, profileId: PROFILE, provider: "cursor-cli" })).toEqual(found(KEY));
    expect(await read({ profileId: PROFILE, provider: "cursor-cli" })).toEqual(found(KEY));
    expect(await read({ agentDir, profileId: "cursor-cli:none", provider: "cursor-cli" })).toEqual(ABSENT);
    // The sweep's lookup lists every profile of the provider: another agent's own profile, and main's through the fallback.
    const other = join(state, "agents", "w", "agent");
    await auth.upsertAuthProfileWithLock({ profileId: "cursor-cli:manual", credential: apiKey("key_other_agent_0123"), agentDir: other });
    expect(await findAnyKey({ agentDir: other, provider: "cursor-cli" })).toMatchObject({ kind: "key" });
    expect(await findAnyKey({ agentDir: join(state, "agents", "empty", "agent"), provider: "cursor-cli" })).toEqual(found(KEY));
    expect(await findAnyKey({ agentDir, provider: "openai" })).toEqual(ABSENT);
    expect(existsSync(state)).toBe(true);
  }, 60_000);
});
