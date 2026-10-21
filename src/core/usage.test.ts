import { describe, expect, it } from "vitest";
import { idle } from "../../test/fixtures/virtual-clock.ts";
import { createManifest, type CliAdapter, type UsageQuery, type UsageReport } from "./ports.ts";
import { readTurnUsage } from "./usage.ts";

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
