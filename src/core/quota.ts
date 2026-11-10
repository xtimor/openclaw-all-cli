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

/**
 * OpenClaw's provider usage hooks for an adapter that can read its plan quota (`readQuota`), or
 * `undefined` for one that cannot: such a provider offers no snapshot. The hooks run only when a
 * usage surface asks, never from a turn.
 *
 * - `resolveUsageAuth` picks the API key the way the CLI process gets it: the backend's plugin
 *   config `env`, then the host environment, then a key OpenClaw holds for the provider. With none
 *   (a login only) it answers `handled`, so no generic fallback runs and the provider has no row.
 * - `fetchUsageSnapshot` asks the adapter. A failure or an empty answer is a row with a short
 *   error text, never a throw.
 */
export function createUsageHooks(adapter: CliAdapter, pluginId: string, warn: (message: string) => void) {
  const readQuota = adapter.readQuota?.bind(adapter);
  const keyVar = adapter.apiKeyEnvVar;
  if (!readQuota || !keyVar) return undefined;
  const backendId = backendIdFor(adapter);
  return {
    resolveUsageAuth(context: UsageAuthContext): { token: string } | { handled: true } {
      const settings = readBackendConfig(context.config?.plugins?.entries?.[pluginId]?.config, backendId, () => {});
      const key =
        settings.env?.[keyVar]?.trim() ||
        context.env?.[keyVar]?.trim() ||
        context.resolveApiKeyFromConfigAndStore?.({ providerIds: [backendId] })?.trim();
      return key ? { token: key } : { handled: true };
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
