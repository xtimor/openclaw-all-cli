import type { CliAdapter, NormalizedUsage, UsageQuery } from "./ports.ts";

/**
 * Asks the adapter for a finished turn's usage (see `CliAdapter.readUsage`). Never fails the
 * turn: no port, an already aborted signal, a throw, or an abort while waiting all mean no usage.
 * The adapter owns the timers; the core only stops waiting when the turn is aborted.
 */
export async function readTurnUsage(
  adapter: CliAdapter,
  query: UsageQuery,
  warn: (message: string) => void,
): Promise<NormalizedUsage | undefined> {
  if (!adapter.readUsage || query.signal?.aborted) return undefined;
  const { signal } = query;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    onAbort = () => resolve(undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const report = await Promise.race([adapter.readUsage(query), aborted]);
    if (!report) return undefined;
    if (report.warning) warn(report.warning);
    return report.usage;
  } catch {
    return undefined;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
