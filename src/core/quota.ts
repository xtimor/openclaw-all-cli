import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { defaultProfileIdFor, readStoredKey, type ReadStoredKey } from "./auth-store.ts";
import { backendIdFor } from "./backend.ts";
import { readBackendConfig } from "./config.ts";
import type { CliAdapter, QuotaSnapshot } from "./ports.ts";

/** OpenClaw's usage snapshot, reduced to the fields the plugin sets. */
type UsageSnapshot = {
  provider: string;
  displayName: string;
  windows: Array<{ label: string; usedPercent: number; resetAt?: number }>;
  summary?: string;
  plan?: string;
  error?: string;
};

/** The hook contexts, reduced to what the plugin reads. */
type UsageAuthContext = {
  config?: { plugins?: { entries?: Record<string, { config?: Record<string, unknown> } | undefined> } };
  env?: Record<string, string | undefined>;
  agentDir?: string;
  signal?: AbortSignal;
  /** OpenClaw 2026.10.3 and 2026.11.x: the provider's keys from its config and auth store, best first. */
  resolveApiKeyCandidatesFromConfigAndStore?: (params?: { providerIds?: string[] }) => Promise<string[]> | string[];
  /** The same, first key only (deprecated in 2026.11.x). */
  resolveApiKeyFromConfigAndStore?: (params?: { providerIds?: string[] }) => string | undefined;
};
type UsageFetchContext = { token: string; signal?: AbortSignal };

const two = (n: number) => String(n).padStart(2, "0");
/** `2026-11-10 14:03 UTC`: the stale reading's time in a form that needs no locale. */
const utcStamp = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
};

/** An adapter snapshot in OpenClaw's shape; a stale one says so in every label and in the summary. */
export function toUsageSnapshot(adapter: CliAdapter, snapshot: QuotaSnapshot): UsageSnapshot {
  const stale = snapshot.staleSince;
  const note = stale === undefined ? undefined : `Stale: ${adapter.displayName} did not answer, showing the reading of ${utcStamp(stale)}`;
  const summary = [note, snapshot.summary].filter(Boolean).join(". ");
  return {
    provider: backendIdFor(adapter),
    displayName: adapter.displayName,
    windows: snapshot.windows.map((w) => ({ ...w, label: stale === undefined ? w.label : `${w.label} (stale)` })),
    ...(summary ? { summary } : {}),
    ...(snapshot.plan ? { plan: snapshot.plan } : {}),
  };
}

/** A key the quota reader can use: not empty, and not a marker such as the native-login one (`openclaw:...`). */
const usableKey = (value: unknown): string | undefined => {
  const key = typeof value === "string" ? value.trim() : "";
  return key && !key.startsWith("openclaw:") ? key : undefined;
};

/** OpenClaw's own answer for the provider's key; `asked` is false when the host offers no helper or it failed. */
async function hostKey(context: UsageAuthContext, backendId: string): Promise<{ key?: string; asked: boolean }> {
  const params = { providerIds: [backendId] };
  try {
    if (typeof context.resolveApiKeyCandidatesFromConfigAndStore === "function") {
      const candidates = await context.resolveApiKeyCandidatesFromConfigAndStore(params);
      const key = (Array.isArray(candidates) ? candidates : []).map(usableKey).find(Boolean);
      return { ...(key ? { key } : {}), asked: true };
    }
    if (typeof context.resolveApiKeyFromConfigAndStore === "function") {
      const key = usableKey(context.resolveApiKeyFromConfigAndStore(params));
      return { ...(key ? { key } : {}), asked: true };
    }
  } catch {
    // The host could not read its store: the plugin reads it below.
  }
  return { asked: false };
}

/** Whether `path` is a file this process may run. */
const isRunnable = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether the CLI `command` is on this host, without running it: a path (absolute, or relative to
 * the Gateway's working directory) must be a runnable file; a bare name must be one in a `PATH`
 * folder (on Windows also with a `PATHEXT` extension).
 */
export function cliOnHost(command: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const name = command.trim();
  if (!name) return false;
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) return isRunnable(resolve(name));
  const extensions = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => extensions.some((ext) => isRunnable(join(dir, name + ext))));
}

/** `work`, or the signal's reason when it aborts first. */
function raceSignal<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * OpenClaw's provider usage hooks for an adapter that can read its plan quota (`readQuota`), or
 * `undefined` for one that cannot: such a provider offers no snapshot. The hooks run only when a
 * usage surface asks, never from a turn.
 *
 * - `resolveUsageAuth` first checks that the CLI is on the host (`command`, or the adapter's
 *   default, as a path or on the CLI's `PATH`, not run): without it the answer is `handled`, so no quota
 *   shows, whatever key is left. Then it picks the API key the way the CLI process gets it. It asks OpenClaw first
 *   (`resolveApiKeyCandidatesFromConfigAndStore`, else `resolveApiKeyFromConfigAndStore`): that
 *   reads the auth store, where the API key method's profile lives, without the plugin importing
 *   OpenClaw's agent runtime, whose first import takes 4-10 s against the host's 5 s budget. Then
 *   the backend's plugin config `env`, then the host environment. Only a host without those helpers
 *   makes the plugin read the store itself (`<backendId>:default`), raced against `signal`. With no
 *   key (a login only) it answers `handled`, so no generic fallback runs and the provider has no row.
 * - `fetchUsageSnapshot` asks the adapter. A failure or an empty answer is a row with a short
 *   error text, never a throw.
 */
export function createUsageHooks(
  adapter: CliAdapter,
  pluginId: string,
  warn: (message: string) => void,
  options: { readKey?: ReadStoredKey; cliPresent?: (command: string, env: Readonly<Record<string, string | undefined>>) => boolean } = {},
) {
  const readQuota = adapter.readQuota?.bind(adapter);
  const keyVar = adapter.apiKeyEnvVar;
  if (!readQuota || !keyVar) return undefined;
  const backendId = backendIdFor(adapter);
  return {
    async resolveUsageAuth(context: UsageAuthContext): Promise<{ token: string } | { handled: true }> {
      context.signal?.throwIfAborted();
      const settings = readBackendConfig(context.config?.plugins?.entries?.[pluginId]?.config, backendId, () => {});
      // No CLI on the host, no quota: a key left in a profile, the config, or the env shows nothing.
      // Looked up with the `PATH` the CLI runs with: the host's env, then the backend's `env`.
      const cliEnv = { ...(context.env ?? process.env), ...settings.env };
      if (!(options.cliPresent ?? cliOnHost)(settings.command ?? adapter.command, cliEnv)) return { handled: true };
      const fromHost = await hostKey(context, backendId);
      context.signal?.throwIfAborted();
      if (fromHost.key) return { token: fromHost.key };
      const key = settings.env?.[keyVar]?.trim() || context.env?.[keyVar]?.trim();
      if (key) return { token: key };
      if (!fromHost.asked) {
        const stored = await raceSignal(
          (options.readKey ?? readStoredKey)({ agentDir: context.agentDir, profileId: defaultProfileIdFor(backendId), provider: backendId }),
          context.signal,
        );
        if (stored.kind === "key") return { token: stored.key };
      }
      return { handled: true };
    },
    async fetchUsageSnapshot(context: UsageFetchContext): Promise<UsageSnapshot> {
      try {
        const report = await readQuota({ apiKey: context.token, ...(context.signal ? { signal: context.signal } : {}) });
        if (report.warning) warn(report.warning);
        if (report.snapshot) return toUsageSnapshot(adapter, report.snapshot);
      } catch {
        // By contract the adapter does not throw; a throw is treated as no snapshot.
      }
      return { provider: backendId, displayName: adapter.displayName, windows: [], error: `${adapter.displayName} quota unavailable` };
    },
  };
}
