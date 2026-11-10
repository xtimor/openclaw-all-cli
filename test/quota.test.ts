import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createCursorQuotaReader, toSnapshot, type CursorQuotaOptions } from "../src/adapters/cursor/quota.ts";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import type { CliAdapter, QuotaReport } from "../src/core/ports.ts";
import { createUsageHooks, toUsageSnapshot } from "../src/core/quota.ts";
import { registerAdapters } from "../src/core/register.ts";
import { PLUGIN_ID } from "../src/core/synthetic-auth.ts";
import { fakeJwt } from "./fixtures/ledger-stub.ts";

// A key and a body text that are easy to find in any output a test captures.
const KEY = "key_test_0123456789abcdef";
const SECRET_BODY = "secret-looking-body";
const EXCHANGE = "/auth/exchange_user_api_key";
const PLAN = "/aiserver.v1.DashboardService/GetPlanInfo";
const PERIOD = "/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CYCLE_END = 1_790_000_000_000;

const planAnswer = { planInfo: { planName: "Ultra", price: "$200/mo", billingCycleEnd: String(CYCLE_END) } };
const periodAnswer = {
  billingCycleStart: "1787400000000",
  billingCycleEnd: String(CYCLE_END),
  planUsage: { totalSpend: 102122, includedSpend: 40000, bonusSpend: 62122, limit: 40000, totalPercentUsed: 41.5, autoPercentUsed: 12.25, apiPercentUsed: 80 },
};

type Request = { path: string; authorization: string | undefined; connect: string | undefined; contentType: string | undefined; body: string };

/** An in-memory Cursor: the exchange and the two dashboard calls, steered per path. */
function createFake() {
  let time = Date.UTC(2026, 10, 10, 12, 0, 0);
  const fake = {
    requests: [] as Request[],
    /** Per path, the statuses for the next calls (one per call); empty means the default answer. */
    statuses: {} as Record<string, number[]>,
    answers: { [PLAN]: planAnswer as unknown, [PERIOD]: periodAnswer as unknown } as Record<string, unknown>,
    /** Per path, raw bodies that replace the answer of the next 200s (one per call). */
    queue: {} as Record<string, string[]>,
    /** A thrown network error for the next call of a path. */
    networkError: new Set<string>(),
    /** Tokens the dashboard calls accept; undefined accepts all. */
    validTokens: undefined as Set<string> | undefined,
    tokens: 0,
    /** Each answer waits this long (real timers), to hold a request in flight. */
    delayMs: 0,
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    count: (path: string) => fake.requests.filter((request) => request.path === path).length,
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      const path = new URL(url).pathname;
      const headers = init.headers as Record<string, string>;
      fake.requests.push({ path, authorization: headers.Authorization, connect: headers["Connect-Protocol-Version"], contentType: headers["Content-Type"], body: String(init.body) });
      if (fake.delayMs) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
      if (fake.networkError.delete(path)) throw new TypeError("fetch failed");
      const status = fake.statuses[path]?.shift() ?? 200;
      if (status !== 200) return new Response(JSON.stringify({ error: SECRET_BODY }), { status });
      const raw = fake.queue[path]?.shift();
      if (raw !== undefined) return new Response(raw, { status: 200 });
      if (path === EXCHANGE) {
        fake.tokens += 1;
        const token = fakeJwt(Math.floor(time / 1000) + 3600) + `.${fake.tokens}`;
        fake.validTokens?.add(token);
        return new Response(JSON.stringify({ accessToken: token }), { status: 200 });
      }
      const bearer = headers.Authorization?.replace(/^Bearer /, "") ?? "";
      if (fake.validTokens && !fake.validTokens.has(bearer)) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify(fake.answers[path] ?? {}), { status: 200 });
    },
  };
  return fake;
}

type Fake = ReturnType<typeof createFake>;
const make = (fake: Fake, over: CursorQuotaOptions = {}) => createCursorQuotaReader({ now: fake.now, fetch: fake.fetch, baseUrl: "https://cursor.test", ...over });
const requestSets = (fake: Fake) => ({ exchange: fake.count(EXCHANGE), plan: fake.count(PLAN), period: fake.count(PERIOD) });
const TTL = 60_000;
const BACKOFF = 600_000;

describe("snapshot mapping", () => {
  it("maps Cursor's plan and period answers to windows, a reset time, a plan, and a spend summary", async () => {
    const fake = createFake();
    const report = await make(fake).read({ apiKey: KEY });
    expect(report).toEqual({
      snapshot: {
        plan: "Ultra",
        windows: [
          { label: "Total", usedPercent: 41.5, resetAt: CYCLE_END },
          { label: "Auto + Composer", usedPercent: 12.25, resetAt: CYCLE_END },
          { label: "API models", usedPercent: 80, resetAt: CYCLE_END },
        ],
        summary: "Spend this cycle: $400.00 of $400.00 included, $621.22 bonus",
      },
    });
  });

  it("sends the key to the exchange only, then the token with the Connect headers and an empty body", async () => {
    const fake = createFake();
    await make(fake).read({ apiKey: ` ${KEY} ` });
    const [exchange, ...dashboard] = fake.requests;
    expect(exchange).toMatchObject({ path: EXCHANGE, authorization: `Bearer ${KEY}`, body: "{}" });
    expect(dashboard.map((request) => request.path).sort()).toEqual([PERIOD, PLAN]);
    for (const request of dashboard) {
      expect(request).toMatchObject({ connect: "1", contentType: "application/json", body: "{}" });
      expect(request.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.sig\.1$/);
      expect(request.authorization).not.toContain(KEY);
    }
  });

  it("reads a field Cursor leaves out (proto3 default) as 0 and estimates nothing", () => {
    const zero = (label: string, usedPercent = 0) => ({ label, usedPercent });
    expect(toSnapshot(undefined, { planUsage: { totalPercentUsed: 7 } })).toEqual({
      windows: [zero("Total", 7), zero("Auto + Composer"), zero("API models")],
    });
    expect(toSnapshot(undefined, { planUsage: {} })).toEqual({ windows: [zero("Total"), zero("Auto + Composer"), zero("API models")] });
    expect(toSnapshot({ planInfo: { planName: "  " } }, { billingCycleEnd: "5", planUsage: { totalSpend: 1234 } })).toMatchObject({
      summary: "Spend this cycle: $12.34",
    });
  });

  it("takes the reset time from the plan answer when the period has none, and numeric strings as numbers", () => {
    const snapshot = toSnapshot({ planInfo: { planName: "Pro", billingCycleEnd: "1790000000000" } }, { planUsage: { autoPercentUsed: "3.5" } });
    expect(snapshot.plan).toBe("Pro");
    expect(snapshot.windows.map((w) => [w.label, w.usedPercent, w.resetAt])).toEqual([
      ["Total", 0, 1_790_000_000_000],
      ["Auto + Composer", 3.5, 1_790_000_000_000],
      ["API models", 0, 1_790_000_000_000],
    ]);
  });

  it("shows a plain spend line when the included limit is zero or missing", () => {
    expect(toSnapshot(undefined, { planUsage: { totalSpend: 500, includedSpend: 500, limit: 0 } }).summary).toBe("Spend this cycle: $5.00");
    expect(toSnapshot(undefined, { planUsage: { totalSpend: 500, includedSpend: 500, limit: 2000 } }).summary).toBe("Spend this cycle: $5.00 of $20.00 included");
  });

  it("still answers without the plan name when GetPlanInfo fails", async () => {
    const fake = createFake();
    fake.statuses[PLAN] = [500];
    const report = await make(fake).read({ apiKey: KEY });
    expect(report.snapshot?.plan).toBeUndefined();
    expect(report.snapshot?.windows).toHaveLength(3);
    expect(report.warning).toBeUndefined();
  });
});

describe("cache, merge, and token reuse", () => {
  it("makes one request set for N reads inside the TTL, and reuses the token after it", async () => {
    const fake = createFake();
    const reader = make(fake);
    for (let i = 0; i < 5; i += 1) {
      expect((await reader.read({ apiKey: KEY })).snapshot).toBeDefined();
      fake.advance(5_000);
    }
    expect(requestSets(fake)).toEqual({ exchange: 1, plan: 1, period: 1 });
    fake.advance(TTL);
    const after = await reader.read({ apiKey: KEY });
    expect(after.snapshot?.staleSince).toBeUndefined();
    // The TTL ended: both dashboard calls repeat, the 1 h token is reused.
    expect(requestSets(fake)).toEqual({ exchange: 1, plan: 2, period: 2 });
  });

  it("merges concurrent reads into one request set", async () => {
    const fake = createFake();
    fake.delayMs = 15;
    const reader = make(fake);
    const reports = await Promise.all(Array.from({ length: 8 }, () => reader.read({ apiKey: KEY })));
    expect(requestSets(fake)).toEqual({ exchange: 1, plan: 1, period: 1 });
    expect(new Set(reports.map((report) => JSON.stringify(report))).size).toBe(1);
    expect(reports[0]?.snapshot?.plan).toBe("Ultra");
  });

  it("keeps a separate cache, token, and back-off per key", async () => {
    const fake = createFake();
    const reader = make(fake);
    await reader.read({ apiKey: KEY });
    await reader.read({ apiKey: `${KEY}-other` });
    expect(requestSets(fake)).toEqual({ exchange: 2, plan: 2, period: 2 });
    expect(fake.requests.filter((request) => request.path === EXCHANGE).map((request) => request.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}-other`]);
  });

  it("exchanges the key again once the token is near its expiry", async () => {
    const fake = createFake();
    const reader = make(fake);
    await reader.read({ apiKey: KEY });
    fake.advance(3600_000 - 6 * 60_000);
    await reader.read({ apiKey: KEY });
    expect(fake.count(EXCHANGE)).toBe(1);
    fake.advance(2 * 60_000);
    await reader.read({ apiKey: KEY });
    expect(fake.count(EXCHANGE)).toBe(2);
  });

  it("renews a token the dashboard rejects once, and repeats both calls", async () => {
    const fake = createFake();
    fake.validTokens = new Set();
    const reader = make(fake);
    await reader.read({ apiKey: KEY });
    fake.validTokens.clear();
    fake.advance(TTL);
    // The cached token is no longer valid for Cursor: one new exchange, then both calls again.
    const report = await reader.read({ apiKey: KEY });
    expect(report.snapshot?.staleSince).toBeUndefined();
    expect(report.warning).toBeUndefined();
    expect(requestSets(fake)).toEqual({ exchange: 2, plan: 3, period: 3 });
  });

  it("counts the request of a caller that stopped waiting", async () => {
    const fake = createFake();
    fake.delayMs = 15;
    const reader = make(fake);
    const controller = new AbortController();
    const first = reader.read({ apiKey: KEY, signal: controller.signal });
    controller.abort();
    expect(await first).toEqual({});
    const second = await reader.read({ apiKey: KEY });
    expect(second.snapshot?.plan).toBe("Ultra");
    expect(requestSets(fake)).toEqual({ exchange: 1, plan: 1, period: 1 });
  });

  it("makes no request for an empty key", async () => {
    const fake = createFake();
    expect(await make(fake).read({ apiKey: "  " })).toEqual({});
    expect(fake.requests).toHaveLength(0);
  });
});

describe("failures degrade and back off", () => {
  type Failure = { name: string; arrange: (fake: Fake) => void };
  const failures: Failure[] = [
    { name: "429 from the dashboard", arrange: (fake) => void (fake.statuses[PERIOD] = [429]) },
    { name: "5xx from the dashboard", arrange: (fake) => void (fake.statuses[PERIOD] = [503]) },
    { name: "5xx from the exchange", arrange: (fake) => void (fake.statuses[EXCHANGE] = [500]) },
    { name: "a rejected key (401 at the exchange)", arrange: (fake) => void (fake.statuses[EXCHANGE] = [401]) },
    { name: "a rejected key (403 at the exchange)", arrange: (fake) => void (fake.statuses[EXCHANGE] = [403]) },
    { name: "a token rejected twice (401 after a renewal)", arrange: (fake) => void (fake.statuses[PERIOD] = [401, 401]) },
    { name: "a network error", arrange: (fake) => void fake.networkError.add(PERIOD) },
    { name: "a changed shape: no planUsage", arrange: (fake) => void (fake.queue[PERIOD] = [JSON.stringify({ billingCycleEnd: "1" })]) },
    { name: "a changed shape: planUsage is not an object", arrange: (fake) => void (fake.queue[PERIOD] = [JSON.stringify({ planUsage: "x" })]) },
    { name: "a changed shape: not JSON", arrange: (fake) => void (fake.queue[PERIOD] = ["<html>"]) },
    { name: "a changed shape: 404", arrange: (fake) => void (fake.statuses[PERIOD] = [404]) },
    { name: "a changed shape: an exchange with no token", arrange: (fake) => void (fake.queue[EXCHANGE] = ["{}"]) },
  ];

  it.each(failures)("$name with no earlier reading: no snapshot, no throw, one warning, held off", async ({ arrange }) => {
    const fake = createFake();
    arrange(fake);
    const reader = make(fake);
    const first = await reader.read({ apiKey: KEY });
    expect(first.snapshot).toBeUndefined();
    expect(first.warning).toMatch(/^Cursor quota: /);
    expect(first.warning).toContain("not asked again for 10 min");
    for (const secret of [KEY, SECRET_BODY, "Bearer"]) expect(first.warning).not.toContain(secret);
    const sent = fake.requests.length;

    // Inside the back-off nothing is asked and the warning is not repeated.
    fake.advance(BACKOFF - 1_000);
    expect(await reader.read({ apiKey: KEY })).toEqual({});
    expect(fake.requests).toHaveLength(sent);

    // After it Cursor is asked again, and recovers.
    fake.advance(2_000);
    const later = await reader.read({ apiKey: KEY });
    expect(later.snapshot?.plan).toBe("Ultra");
    expect(later.snapshot?.staleSince).toBeUndefined();
    expect(fake.requests.length).toBeGreaterThan(sent);
  });

  it.each(failures)("$name after a good reading: the last snapshot marked stale", async ({ arrange }) => {
    const fake = createFake();
    const reader = make(fake);
    const good = await reader.read({ apiKey: KEY });
    const readAt = fake.now();
    // Past the TTL and the token's life, so a failure at the exchange is reached too.
    fake.advance(3_600_000);
    arrange(fake);
    const failed = await reader.read({ apiKey: KEY });
    expect(failed.snapshot).toEqual({ ...good.snapshot, staleSince: readAt });
    expect(failed.warning).toMatch(/^Cursor quota: /);
    const sent = fake.requests.length;

    fake.advance(BACKOFF - 5_000);
    const held = await reader.read({ apiKey: KEY });
    expect(held).toEqual({ snapshot: { ...good.snapshot, staleSince: readAt } });
    expect(fake.requests).toHaveLength(sent);
  });

  it("never rejects, whatever the transport does", async () => {
    const reader = createCursorQuotaReader({
      fetch: async () => {
        throw new Error(`boom ${KEY}`);
      },
    });
    const report = await reader.read({ apiKey: KEY });
    expect(report.snapshot).toBeUndefined();
    expect(report.warning).not.toContain(KEY);
  });

  it("does not follow a redirect with the key", async () => {
    const seen: RequestInit[] = [];
    const reader = createCursorQuotaReader({
      fetch: async (_url, init) => {
        seen.push(init);
        return new Response("{}", { status: 200 });
      },
    });
    await reader.read({ apiKey: KEY });
    expect(seen[0]?.redirect).toBe("error");
  });

  it("answers the stale reading when the caller's signal aborts during a request", async () => {
    const fake = createFake();
    const reader = make(fake);
    const good = await reader.read({ apiKey: KEY });
    const readAt = fake.now();
    fake.advance(TTL + 1);
    fake.delayMs = 15;
    const controller = new AbortController();
    const pending = reader.read({ apiKey: KEY, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ snapshot: { ...good.snapshot, staleSince: readAt } });
  });
});

describe("usage hooks", () => {
  const warn = vi.fn();
  const report: QuotaReport = { snapshot: { plan: "Ultra", windows: [{ label: "Total", usedPercent: 10, resetAt: 5 }], summary: "Spend this cycle: $1.00" } };
  const adapterWith = (readQuota: CliAdapter["readQuota"]): CliAdapter => ({ ...cursorAdapter, readQuota });
  const config = (env: Record<string, string>) => ({ plugins: { entries: { [PLUGIN_ID]: { config: { "cursor-cli": { env } } } } } });

  it("offers no hooks for an adapter without a quota reader, or without a key variable", () => {
    const { readQuota: _gone, ...noPort } = cursorAdapter;
    expect(createUsageHooks(noPort, PLUGIN_ID, warn)).toBeUndefined();
    const { apiKeyEnvVar: _key, ...noKey } = cursorAdapter;
    expect(createUsageHooks(noKey, PLUGIN_ID, warn)).toBeUndefined();
    expect(createUsageHooks(cursorAdapter, PLUGIN_ID, warn)).toBeDefined();
  });

  it("registers no usage hooks for an adapter without the port, and both for one with it", () => {
    const registered: Array<Record<string, unknown>> = [];
    const api = (): never =>
      ({
        pluginConfig: {},
        registrationMode: "setup-only",
        registerProvider: (provider: Record<string, unknown>) => registered.push(provider),
        registerCliBackend: () => {},
        logger: { warn: () => {}, debug: () => {} },
      }) as never;
    const { readQuota: _gone, ...noPort } = cursorAdapter;
    registerAdapters(api(), [noPort]);
    registerAdapters(api(), [cursorAdapter]);
    expect(registered).toHaveLength(2);
    expect(registered[0]).toMatchObject({ id: "cursor-cli" });
    expect(registered[0]).not.toHaveProperty("resolveUsageAuth");
    expect(registered[0]).not.toHaveProperty("fetchUsageSnapshot");
    expect(registered[1]).toMatchObject({ id: "cursor-cli", resolveUsageAuth: expect.any(Function), fetchUsageSnapshot: expect.any(Function) });
  });

  it("resolveUsageAuth takes the key from the plugin config, then the host env, then OpenClaw's store", () => {
    const hooks = createUsageHooks(adapterWith(async () => report), PLUGIN_ID, warn)!;
    const store = vi.fn(() => " store-key ");
    expect(hooks.resolveUsageAuth({ config: config({ CURSOR_API_KEY: " cfg-key " }), env: { CURSOR_API_KEY: "env-key" }, resolveApiKeyFromConfigAndStore: store })).toEqual({ token: "cfg-key" });
    expect(hooks.resolveUsageAuth({ config: config({}), env: { CURSOR_API_KEY: "env-key" }, resolveApiKeyFromConfigAndStore: store })).toEqual({ token: "env-key" });
    expect(store).not.toHaveBeenCalled();
    expect(hooks.resolveUsageAuth({ resolveApiKeyFromConfigAndStore: store })).toEqual({ token: "store-key" });
    expect(store).toHaveBeenCalledWith({ providerIds: ["cursor-cli"] });
  });

  it("resolveUsageAuth answers handled, with no token, for a login only", () => {
    const hooks = createUsageHooks(adapterWith(async () => report), PLUGIN_ID, warn)!;
    expect(hooks.resolveUsageAuth({})).toEqual({ handled: true });
    expect(hooks.resolveUsageAuth({ config: config({ CURSOR_API_KEY: "  " }), env: { CURSOR_API_KEY: "" }, resolveApiKeyFromConfigAndStore: () => undefined })).toEqual({ handled: true });
    // A malformed plugin config is not a reason to throw.
    expect(hooks.resolveUsageAuth({ config: { plugins: { entries: { [PLUGIN_ID]: { config: { "cursor-cli": 5 } } } } } })).toEqual({ handled: true });
  });

  it("fetchUsageSnapshot hands the key and signal to the port and answers OpenClaw's shape", async () => {
    const readQuota = vi.fn(async () => report);
    const hooks = createUsageHooks(adapterWith(readQuota), PLUGIN_ID, warn)!;
    const signal = new AbortController().signal;
    const snapshot = await hooks.fetchUsageSnapshot({ token: KEY, signal });
    expect(readQuota).toHaveBeenCalledWith({ apiKey: KEY, signal });
    expect(snapshot).toEqual({
      provider: "cursor-cli",
      displayName: cursorAdapter.displayName,
      windows: [{ label: "Total", usedPercent: 10, resetAt: 5 }],
      summary: "Spend this cycle: $1.00",
      plan: "Ultra",
    });
  });

  it("marks a stale snapshot in every label and the summary, with the reading's time", async () => {
    const stale = Date.UTC(2026, 10, 10, 14, 3);
    const hooks = createUsageHooks(adapterWith(async () => ({ snapshot: { ...report.snapshot!, staleSince: stale }, warning: "Cursor quota: request failed" })), PLUGIN_ID, warn)!;
    const warned = vi.fn();
    const withWarn = createUsageHooks(adapterWith(async () => ({ snapshot: { ...report.snapshot!, staleSince: stale }, warning: "Cursor quota: request failed" })), PLUGIN_ID, warned)!;
    const snapshot = await hooks.fetchUsageSnapshot({ token: KEY });
    expect(snapshot.windows).toEqual([{ label: "Total (stale)", usedPercent: 10, resetAt: 5 }]);
    expect(snapshot.summary).toBe(`Stale: ${cursorAdapter.displayName} did not answer, showing the reading of 2026-11-10 14:03 UTC. Spend this cycle: $1.00`);
    await withWarn.fetchUsageSnapshot({ token: KEY });
    expect(warned).toHaveBeenCalledWith("Cursor quota: request failed");
    expect(toUsageSnapshot(cursorAdapter, { windows: [], staleSince: stale }).summary).toMatch(/^Stale: /);
  });

  it("answers a short error row, never a throw, when the port has no snapshot or throws", async () => {
    const warned = vi.fn();
    const empty = createUsageHooks(adapterWith(async () => ({ warning: "Cursor quota: request failed" })), PLUGIN_ID, warned)!;
    const row = await empty.fetchUsageSnapshot({ token: KEY });
    expect(row).toEqual({ provider: "cursor-cli", displayName: cursorAdapter.displayName, windows: [], error: `${cursorAdapter.displayName} quota unavailable` });
    expect(warned).toHaveBeenCalledWith("Cursor quota: request failed");

    const throwing = createUsageHooks(
      adapterWith(async () => {
        throw new Error(`leaked ${KEY}`);
      }),
      PLUGIN_ID,
      warned,
    )!;
    const thrown = await throwing.fetchUsageSnapshot({ token: KEY });
    expect(thrown.windows).toEqual([]);
    expect(JSON.stringify(thrown)).not.toContain(KEY);
  });
});

describe("manifest and boundaries", () => {
  const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

  it("declares the usage provider and the env var OpenClaw checks before it asks for usage", () => {
    expect(manifest.contracts.usageProviders).toEqual(["cursor-cli"]);
    expect(manifest.providerUsageAuthEnvVars).toEqual({ "cursor-cli": ["CURSOR_API_KEY"] });
  });

  it("keeps the quota request out of the turn path", () => {
    for (const file of ["../src/core/execute.ts", "../src/core/backend.ts", "../src/core/usage.ts"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toMatch(/readQuota|createUsageHooks/);
    }
  });
});
