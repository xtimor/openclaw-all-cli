import type { CliAdapter, NormalizedUsage, UsageQuery } from "./ports.ts";

const count = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * The context size OpenClaw actually reads off a turn's usage: `input + cacheRead + cacheWrite`
 * (see `test/host-contract.test.ts`). `output` is excluded: it is generated tokens, not context the
 * model saw, and it varies independently of the turn's request count, so comparing raw `total`
 * (which includes it) against an earlier total is not the same as comparing what the tile actually
 * shows.
 */
export function contextReading(usage: NormalizedUsage): number {
  return count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
}

/**
 * Keeps a turn's usage from being read as a context size it cannot be (issue #40), and keeps that
 * reading from ever falling while the conversation only grows (issue #97). OpenClaw reads a CLI
 * turn's `input + cacheRead + cacheWrite` (`contextReading` above) as the context the model saw,
 * but a CLI reports sums over every model request of the turn, so a turn with tool calls counts the
 * cached prompt once per request. When the reading plus `output` (or `total`) exceeds the session's
 * `ceiling`, no single request could have held it: `total` is dropped and the usage is marked
 * `contextUnknown`. The same thing happens when `previousReading` — the highest `contextReading`
 * already accepted for this session — is given and this turn's own `contextReading` is lower: a
 * turn with fewer round trips than the one before it can still be a correct sum, just not a context
 * size that ever decreases, so it is withheld rather than read as a drop. Input, output, and cache
 * counts always stay as reported. Without a ceiling, or within it and not below `previousReading`,
 * the usage is returned as is.
 */
export function boundTurnUsage(usage: NormalizedUsage, ceiling: number | undefined, previousReading?: number): NormalizedUsage {
  if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling <= 0) return usage;
  const reading = Math.max(contextReading(usage) + count(usage.output), count(usage.total));
  const ownReading = contextReading(usage);
  const fellBelowAcceptedHigh = previousReading !== undefined && ownReading > 0 && ownReading < previousReading;
  if (reading <= ceiling && !fellBelowAcceptedHigh) return usage;
  const { total: _dropped, ...counts } = usage;
  return { ...counts, contextUnknown: true };
}

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
