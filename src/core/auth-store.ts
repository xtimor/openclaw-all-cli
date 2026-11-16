/**
 * The one place the plugin reads OpenClaw's auth store: the API key a CLI provider's auth profile
 * holds. The API key method returns that profile (`<backendId>:default`, type `api_key`); OpenClaw
 * stores it, and turns, probes, quota reads, and the managed-CLI sweep find the key here.
 *
 * The reader loads `openclaw/plugin-sdk/agent-runtime` on first use (OpenClaw 2026.10.3 exports
 * `findPersistedAuthProfileCredential`; 2026.11.x also `findPersistedAuthProfileCredentialAsync`,
 * and warns about the sync one). It never throws. Its answer has three states: a key, no key
 * (`absent`), or `unreadable` (the module or the store failed). A turn treats `unreadable` like
 * `absent` and falls back to the plugin config and the environment; the sweep keeps the managed CLI.
 */

/** OpenClaw's auth store as `loadAuthProfileStoreWithoutExternalProfiles[Async]` returns it. */
type AuthProfileStore = { profiles?: Record<string, unknown> };

/** What the reader uses of OpenClaw's agent runtime. */
export type AuthStoreRuntime = {
  findPersistedAuthProfileCredentialAsync?: (params: { agentDir?: string; profileId: string }) => Promise<unknown>;
  findPersistedAuthProfileCredential?: (params: { agentDir?: string; profileId: string }) => unknown;
  /** 2026.11.x. The agent's store with the main store's profiles merged in. */
  loadAuthProfileStoreWithoutExternalProfilesAsync?: (agentDir?: string) => Promise<AuthProfileStore>;
  /** 2026.10.3 (deprecated in 2026.11.x). */
  loadAuthProfileStoreWithoutExternalProfiles?: (agentDir?: string) => AuthProfileStore;
  listProfilesForProvider?: (store: AuthProfileStore, provider: string) => string[];
};

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

export type AuthStore = { readKey: ReadStoredKey; findAnyKey: FindAnyStoredKey };

/** The auth store over `load` (tests inject one; the default imports OpenClaw's agent runtime once). */
export function createAuthStore(
  load: () => Promise<AuthStoreRuntime> = async () =>
    (await import("openclaw/plugin-sdk/agent-runtime")) as unknown as AuthStoreRuntime,
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
  const readKey: ReadStoredKey = async (query) => {
    try {
      const host = await loadOnce();
      const params = { ...(query.agentDir?.trim() ? { agentDir: query.agentDir } : {}), profileId: query.profileId };
      let credential: unknown;
      if (typeof host.findPersistedAuthProfileCredentialAsync === "function") {
        credential = await host.findPersistedAuthProfileCredentialAsync(params);
      } else if (typeof host.findPersistedAuthProfileCredential === "function") {
        credential = host.findPersistedAuthProfileCredential(params);
      } else {
        // A host without the lookup cannot say whether a key is there.
        return UNREADABLE;
      }
      return asStored(keyOfCredential(credential, query.provider));
    } catch {
      return UNREADABLE;
    }
  };
  const findAnyKey: FindAnyStoredKey = async (query) => {
    let host: AuthStoreRuntime;
    try {
      host = await loadOnce();
    } catch {
      return UNREADABLE;
    }
    const loadAsync = host.loadAuthProfileStoreWithoutExternalProfilesAsync;
    const loadSync = host.loadAuthProfileStoreWithoutExternalProfiles;
    const loadStore =
      typeof loadAsync === "function"
        ? (dir: string | undefined) => loadAsync.call(host, dir)
        : typeof loadSync === "function"
          ? async (dir: string | undefined) => loadSync.call(host, dir)
          : undefined;
    if (!loadStore || typeof host.listProfilesForProvider !== "function") {
      return readKey({ agentDir: query.agentDir, profileId: defaultProfileIdFor(query.provider), provider: query.provider });
    }
    try {
      const agentDir = query.agentDir?.trim() ? query.agentDir : undefined;
      const store = await loadStore(agentDir);
      for (const profileId of host.listProfilesForProvider(store, query.provider)) {
        const key = keyOfCredential(store?.profiles?.[profileId], query.provider);
        if (key) return { kind: "key", key };
      }
      return ABSENT;
    } catch {
      return UNREADABLE;
    }
  };
  return { readKey, findAnyKey };
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
