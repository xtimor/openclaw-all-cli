/**
 * The one place the plugin reads OpenClaw's auth store: the API key a CLI provider's auth profile
 * holds. The API key method returns that profile (`<backendId>:default`, type `api_key`); OpenClaw
 * stores it, and turns, probes, quota reads, and the managed-CLI sweep find the key here.
 *
 * The reader loads `openclaw/plugin-sdk/provider-auth` on first use, a focused SDK subpath (the broad
 * `agent-runtime` barrel is retiring). It reads the agent's store read-only, without a keychain
 * prompt, and without other CLIs' credentials (`externalCli: { mode: "none" }`): `ensureAuthProfileStoreAsync` on 2026.11.x, `ensureAuthProfileStore` on 2026.10.3 (deprecated
 * in 2026.11.x). That store includes the main agent's profiles, and an agent's own profile wins. The
 * reader never throws. Its answer has three states: a key, no key (`absent`), or `unreadable` (the
 * module or the store failed). A turn treats `unreadable` like `absent` and falls back to the plugin
 * config and the environment; the sweep keeps the managed CLI. Its one write, on 2026.10.3 only, is a
 * no-op locked update at Gateway start that changes no profile (`settleSharedStore`, issue #106).
 */

/** OpenClaw's auth store as `ensureAuthProfileStore[Async]` returns it. */
type AuthProfileStore = { profiles?: Record<string, unknown> };

/** How the reader reads the store: never written, never a keychain prompt, no other CLI's credentials overlaid. */
type StoreReadOptions = { readOnly: true; allowKeychainPrompt: false; externalCli: { mode: "none" } };
export const STORE_READ_OPTIONS: StoreReadOptions = { readOnly: true, allowKeychainPrompt: false, externalCli: { mode: "none" } };

/** What the reader uses of `openclaw/plugin-sdk/provider-auth`. */
export type AuthStoreRuntime = {
  /** 2026.11.x. */
  ensureAuthProfileStoreAsync?: (agentDir?: string, options?: StoreReadOptions) => Promise<AuthProfileStore>;
  /** 2026.10.3 (deprecated in 2026.11.x). */
  ensureAuthProfileStore?: (agentDir?: string, options?: StoreReadOptions) => AuthProfileStore;
  listProfilesForProvider?: (store: AuthProfileStore, provider: string) => string[];
  /** One locked update of the main store; `null` when it could not run (the SDK's wrapper catches). Used on 2026.10.3 only. */
  updateAuthProfileStoreWithLock?: (params: { updater: (store: AuthProfileStore) => boolean }) => Promise<AuthProfileStore | null>;
};

/** What the start-time settle did: ran the host's no-op update, had nothing to do, or could not run it. */
export type SettleOutcome = "settled" | "skipped" | "failed";

export type StoredKeyQuery = {
  /** The agent whose store is read; absent: the main agent's (OpenClaw falls back to it anyway). */
  agentDir?: string | undefined;
  profileId: string;
  /** The profile must belong to this provider: another provider's key never reaches the CLI. */
  provider: string;
};

/** A read of the auth store: a key, none, or a store the plugin could not read. */
export type StoredKey = { kind: "key"; key: string } | { kind: "absent" } | { kind: "unreadable" };

export type ReadStoredKey = (query: StoredKeyQuery) => Promise<StoredKey>;

/**
 * Whether any `api_key` profile of `provider` holds a key in an agent's store (the main store's
 * profiles included). Without OpenClaw's profile listing it reads `<provider>:default` alone.
 */
export type FindAnyStoredKey = (query: { agentDir?: string | undefined; provider: string }) => Promise<StoredKey>;

export const ABSENT: StoredKey = { kind: "absent" };
export const UNREADABLE: StoredKey = { kind: "unreadable" };

/** The profile the API key method saves, and the one read when the host names none. */
export function defaultProfileIdFor(backendId: string): string {
  return `${backendId}:default`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The key of a stored credential, or undefined. Only an inline `api_key` of the provider counts: a
 * secret reference, an OAuth or token credential, an in-memory native-auth presence, or an
 * `openclaw:` marker is not a key the CLI can use, so it is never handed over.
 */
export function keyOfCredential(credential: unknown, provider: string): string | undefined {
  if (!isRecord(credential) || credential.type !== "api_key") return undefined;
  if (typeof credential.provider !== "string" || credential.provider.trim().toLowerCase() !== provider.toLowerCase()) return undefined;
  if (credential.nativeAuth !== undefined) return undefined;
  const key = typeof credential.key === "string" ? credential.key.trim() : "";
  if (!key || /\s/.test(key) || key.startsWith("openclaw:")) return undefined;
  return key;
}

const asStored = (key: string | undefined): StoredKey => (key ? { kind: "key", key } : ABSENT);

export type AuthStore = { readKey: ReadStoredKey; findAnyKey: FindAnyStoredKey; settleSharedStore: () => Promise<SettleOutcome> };

/** The auth store over `load` (tests inject one; the default imports OpenClaw's provider-auth subpath once). */
export function createAuthStore(
  load: () => Promise<AuthStoreRuntime> = async () =>
    (await import("openclaw/plugin-sdk/provider-auth")) as unknown as AuthStoreRuntime,
): AuthStore {
  let runtime: Promise<AuthStoreRuntime> | undefined;
  const loadOnce = () => {
    runtime ??= load().catch((error: unknown) => {
      // A failed load is tried again on the next read.
      runtime = undefined;
      throw error;
    });
    return runtime;
  };
  /** The agent's store (main's profiles included), or undefined when the host has no reader. Throws when the read fails. */
  const readStore = async (host: AuthStoreRuntime, agentDir: string | undefined): Promise<AuthProfileStore | undefined> => {
    const dir = agentDir?.trim() ? agentDir : undefined;
    if (typeof host.ensureAuthProfileStoreAsync === "function") return host.ensureAuthProfileStoreAsync(dir, STORE_READ_OPTIONS);
    if (typeof host.ensureAuthProfileStore === "function") return host.ensureAuthProfileStore(dir, STORE_READ_OPTIONS);
    return undefined;
  };
  const readKey: ReadStoredKey = async (query) => {
    try {
      const store = await readStore(await loadOnce(), query.agentDir);
      // A host without a reader cannot say whether a key is there.
      if (!store) return UNREADABLE;
      return asStored(keyOfCredential(store.profiles?.[query.profileId], query.provider));
    } catch {
      return UNREADABLE;
    }
  };
  const findAnyKey: FindAnyStoredKey = async (query) => {
    try {
      const host = await loadOnce();
      const store = await readStore(host, query.agentDir);
      if (!store) return UNREADABLE;
      const profileIds =
        typeof host.listProfilesForProvider === "function"
          ? host.listProfilesForProvider(store, query.provider)
          : [defaultProfileIdFor(query.provider)];
      for (const profileId of profileIds) {
        const key = keyOfCredential(store.profiles?.[profileId], query.provider);
        if (key) return { kind: "key", key };
      }
      return ABSENT;
    } catch {
      return UNREADABLE;
    }
  };
  /**
   * Issue #106, OpenClaw 2026.10.3 only. On a state with no auth store yet, the shared store's location
   * is settled by the first auth write, which moves it into the state database and records that in the
   * writing thread only. The host's model-catalog worker thread caches the old location at its first
   * read and keeps reading that empty store, so its auth view, which `models.authStatus` shows, misses
   * a key saved later through Connect provider until a restart. One locked update that changes nothing
   * makes the host settle the location now, before that worker starts. It writes no profile; on a
   * state already settled the host returns at once. A host with the async reader (2026.11.x) is left
   * alone. Never throws.
   */
  const settleSharedStore = async (): Promise<SettleOutcome> => {
    try {
      const host = await loadOnce();
      if (typeof host.ensureAuthProfileStoreAsync === "function" || typeof host.updateAuthProfileStoreWithLock !== "function") return "skipped";
      return (await host.updateAuthProfileStoreWithLock({ updater: () => false })) ? "settled" : "failed";
    } catch {
      return "failed";
    }
  };
  return { readKey, findAnyKey, settleSharedStore };
}

/** A reader over `load` (tests inject one). */
export function createStoredKeyReader(load?: () => Promise<AuthStoreRuntime>): ReadStoredKey {
  return createAuthStore(load).readKey;
}

/** The plugin's auth store. */
const pluginStore = createAuthStore();
/** The plugin's reader. */
export const readStoredKey: ReadStoredKey = pluginStore.readKey;
/** The plugin's "any key of the provider" lookup. */
export const findAnyStoredKey: FindAnyStoredKey = pluginStore.findAnyKey;
/** The plugin's start-time settle of the shared store's location (issue #106, 2026.10.3). */
export const settleSharedAuthStore: () => Promise<SettleOutcome> = pluginStore.settleSharedStore;

export type KeySource = "store" | "config" | "env";

/** The key a CLI process gets and where it came from, and whether the store could be read. */
export type ResolvedKey = {
  key: string | undefined;
  source: KeySource | undefined;
  /** True when the auth store could not be read: no key from it does not mean none is there. */
  storeUnreadable: boolean;
};

/** A key the plugin hands over itself (the auth store's or the plugin config's), not one the Gateway's env already holds. */
export function isPluginSupplied(resolved: ResolvedKey): boolean {
  return resolved.source === "store" || resolved.source === "config";
}

/**
 * The key a CLI process gets, and where it came from: the auth store first, then the plugin config's
 * `env`, then the Gateway's environment. `key` is undefined when none holds one.
 */
export async function resolveCliKey(params: {
  readKey: ReadStoredKey;
  keyVar: string;
  provider: string;
  agentDir?: string | undefined;
  /** The profile the host picked; absent: `<provider>:default`. */
  profileId?: string | undefined;
  pluginEnv?: Readonly<Record<string, string | undefined>> | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
}): Promise<ResolvedKey> {
  const stored = await params.readKey({
    agentDir: params.agentDir,
    profileId: params.profileId?.trim() || defaultProfileIdFor(params.provider),
    provider: params.provider,
  });
  const storeUnreadable = stored.kind === "unreadable";
  if (stored.kind === "key") return { key: stored.key, source: "store", storeUnreadable };
  const configured = params.pluginEnv?.[params.keyVar]?.trim();
  if (configured) return { key: configured, source: "config", storeUnreadable };
  const inherited = params.env?.[params.keyVar]?.trim();
  if (inherited) return { key: inherited, source: "env", storeUnreadable };
  return { key: undefined, source: undefined, storeUnreadable };
}
