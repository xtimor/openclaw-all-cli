import { describe, expect, it } from "vitest";
import { idle } from "../../test/fixtures/virtual-clock.ts";
import { createManifest, type CliAdapter, type UsageQuery, type UsageReport } from "./ports.ts";
import { boundTurnUsage, readTurnUsage } from "./usage.ts";

const query = (signal?: AbortSignal): UsageQuery => ({
  sessionId: "s1",
  startedAt: 1,
  endedAt: 2,
  env: {},
  ...(signal ? { signal } : {}),
});

const adapterWith = (readUsage?: (query: UsageQuery) => Promise<UsageReport>): CliAdapter => ({
  id: "acme",
  displayName: "Acme",
  command: "acme",
  launchArgs: [],
  defaultModel: "acme-cli/auto",
  manifest: createManifest("1", {}),
  alwaysOnNativeTools: [],
  clearEnv: [],
  checkVersion: async () => "ok",
  probeAuth: async () => "available",
  listModels: async () => [],
  prepareHome: async () => ({}),
  open: async () => {
    throw new Error("unused");
  },
  ...(readUsage ? { readUsage } : {}),
});

describe("readTurnUsage", () => {
  it("returns the port's usage", async () => {
    const warnings: string[] = [];
    const usage = await readTurnUsage(adapterWith(async () => ({ usage: { input: 1, total: 1 } })), query(), (m) => warnings.push(m));
    expect(usage).toEqual({ input: 1, total: 1 });
    expect(warnings).toEqual([]);
  });

  it("is undefined without the port", async () => {
    await expect(readTurnUsage(adapterWith(), query(), () => {})).resolves.toBeUndefined();
  });

  it("passes the query through and forwards a warning", async () => {
    const seen: UsageQuery[] = [];
    const warnings: string[] = [];
    const usage = await readTurnUsage(
      adapterWith(async (q) => {
        seen.push(q);
        return { warning: "careful" };
      }),
      query(),
      (m) => warnings.push(m),
    );
    expect(usage).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: "s1", startedAt: 1, endedAt: 2 });
    expect(warnings).toEqual(["careful"]);
  });

  it("treats a throw as no usage", async () => {
    const usage = await readTurnUsage(adapterWith(async () => { throw new Error("boom"); }), query(), () => {});
    expect(usage).toBeUndefined();
  });

  it("does not call the port when already aborted", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const usage = await readTurnUsage(adapterWith(async () => { calls += 1; return {}; }), query(controller.signal), () => {});
    expect(usage).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("stops waiting when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = readTurnUsage(adapterWith(() => new Promise<UsageReport>(() => {})), query(controller.signal), () => {});
    controller.abort();
    // The abort must settle the wait on its own; a wait that ignored it would still be pending after idle().
    expect(await Promise.race([pending.then(() => "settled"), idle().then(() => "pending")])).toBe("settled");
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("boundTurnUsage (issue #40)", () => {
  const GROK = 256_000;

  it("keeps a plausible ledger turn as reported (live shape: one event, cache read beside input)", () => {
    const usage = { input: 5_074, output: 31, cacheRead: 10_240, cacheWrite: 0, total: 15_345 };
    expect(boundTurnUsage(usage, GROK)).toEqual(usage);
  });

  it("drops the total of a ledger turn whose sums no request could hold, and keeps every count", () => {
    const usage = { input: 100_000, output: 86_800, cacheRead: 5_400_000, cacheWrite: 0, total: 5_586_800 };
    expect(boundTurnUsage(usage, GROK)).toEqual({ input: 100_000, output: 86_800, cacheRead: 5_400_000, cacheWrite: 0, contextUnknown: true });
  });

  it("keeps a plausible ACP total and clamps an implausible one", () => {
    expect(boundTurnUsage({ input: 3, output: 4, total: 7 }, GROK)).toEqual({ input: 3, output: 4, total: 7 });
    expect(boundTurnUsage({ input: 100_000, output: 86_800, total: 5_600_000 }, GROK)).toEqual({ input: 100_000, output: 86_800, contextUnknown: true });
  });

  it("counts the output: one request's prompt plus its output fits the window", () => {
    expect(boundTurnUsage({ input: 50_000, cacheRead: 200_000, output: 10_000 }, GROK)).toEqual({ input: 50_000, cacheRead: 200_000, output: 10_000, contextUnknown: true });
  });

  it("keeps a reading exactly at the ceiling", () => {
    const usage = { input: 6_000, cacheRead: 200_000, cacheWrite: 40_000, output: 10_000, total: 256_000 };
    expect(boundTurnUsage(usage, GROK)).toEqual(usage);
    expect(boundTurnUsage({ total: 256_001 }, GROK)).toEqual({ contextUnknown: true });
  });

  it("changes nothing without a usable ceiling", () => {
    const usage = { input: 100_000, output: 86_800, cacheRead: 5_400_000, total: 5_586_800 };
    for (const ceiling of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(boundTurnUsage(usage, ceiling)).toBe(usage);
  });

  it("ignores counts that are not positive numbers", () => {
    const odd = { input: Number.NaN, output: -5, cacheRead: 100, total: 100 } as const;
    expect(boundTurnUsage(odd, 1_000)).toBe(odd);
  });

  it("keeps a plausible total unaffected without a previous-high argument", () => {
    // The 2-argument call is exactly today's contract: nothing changes for a caller that does not
    // pass `previousTotal`.
    const usage = { input: 5_074, output: 31, cacheRead: 10_240, cacheWrite: 0, total: 15_345 };
    expect(boundTurnUsage(usage, GROK)).toEqual(usage);
  });

  it("keeps a plausible total that is at or above the previous high", () => {
    const usage = { input: 5_074, output: 31, cacheRead: 10_240, cacheWrite: 0, total: 15_345 };
    expect(boundTurnUsage(usage, GROK, 15_345)).toEqual(usage);
    expect(boundTurnUsage(usage, GROK, 10_000)).toEqual(usage);
  });

  it("withholds a plausible total that reads lower than the previous high, keeping every count (issue #97)", () => {
    const usage = { input: 2_200, output: 300, cacheRead: 71_000, cacheWrite: 500, total: 73_700 };
    expect(boundTurnUsage(usage, GROK, 101_000)).toEqual({ input: 2_200, output: 300, cacheRead: 71_000, cacheWrite: 500, contextUnknown: true });
  });
});

describe("triage #97: a turn's per-request usage sum is not a monotonic context reading", () => {
  const CEILING = 256_000;

  it("boundTurnUsage lets the reported total fall between turns within the ceiling, with nothing marking it as a per-turn sum", () => {
    const toolHeavyTurn = { input: 2_000, output: 1_500, cacheRead: 98_000, cacheWrite: 1_000, total: 101_000 };
    const plainFollowUpTurn = { input: 2_200, output: 300, cacheRead: 71_000, cacheWrite: 500, total: 73_700 };

    // Without the fix, both calls below reproduce the triage failure: both are returned unchanged
    // (`boundedTurn1.total` 101_000, `boundedTurn2.total` 73_700), so a consumer reading `total` as
    // context size sees it fall even though the conversation only grew.
    const boundedTurn1 = boundTurnUsage(toolHeavyTurn, CEILING);
    // Fixed: the session's own highest accepted reading travels into the next call, so a turn that
    // reads lower is withheld instead of reported as a drop.
    const boundedTurn2 = boundTurnUsage(plainFollowUpTurn, CEILING, boundedTurn1.total);

    expect(boundedTurn1.contextUnknown).toBeUndefined();
    expect(boundedTurn1.total).toBe(101_000);
    expect(boundedTurn2.contextUnknown).toBe(true);
    expect(boundedTurn2.total).toBeUndefined();
    expect(boundedTurn2).toMatchObject({ input: 2_200, output: 300, cacheRead: 71_000, cacheWrite: 500 });

    // The value a consumer reads as context size (`total`, or nothing when withheld) never falls:
    // turn 1's reading stands, turn 2's is withheld rather than shown lower.
    expect(boundedTurn2.total ?? boundedTurn1.total).toBeGreaterThanOrEqual(boundedTurn1.total ?? 0);
  });
});
