import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeJwt, startLedgerStub, type LedgerEventStub } from "../../../test/fixtures/ledger-stub.ts";
import type { UsageQuery } from "../../core/ports.ts";
import { createCursorUsageReader, matchTurnEvents, USAGE_URL_ENV, type CursorUsageOptions } from "./usage.ts";

const KEY = "key_test_0123456789abcdef";
const EXCHANGE = "/auth/exchange_user_api_key";
const EVENTS = "/aiserver.v1.DashboardService/GetFilteredUsageEvents";

const FAST: CursorUsageOptions = {
  firstPollMs: 5,
  pollIntervalMs: 10,
  deadlineMs: 120,
  requestTimeoutMs: 150,
  cooldownMs: 60_000,
};

let stub: Awaited<ReturnType<typeof startLedgerStub>>;
beforeEach(async () => {
  stub = await startLedgerStub();
});
afterEach(async () => {
  await stub.close();
});

const event = (over: Partial<LedgerEventStub> & { at?: number } = {}): LedgerEventStub => ({
  conversationId: "sess",
  timestamp: String(over.at ?? Date.now() + 20),
  model: "auto",
  tokenUsage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 4 },
  ...over,
});
const serve = (...events: LedgerEventStub[]) => {
  stub.events = () => ({ totalUsageEventsCount: events.length, usageEventsDisplay: events });
};
const query = (over: Partial<UsageQuery> = {}): UsageQuery => ({
  sessionId: "sess",
  startedAt: Date.now(),
  endedAt: Date.now(),
  env: { CURSOR_API_KEY: KEY, [USAGE_URL_ENV]: stub.url },
  ...over,
});
const FULL = { input: 100, output: 20, cacheRead: 300, cacheWrite: 4, total: 424 };

describe("cursor usage reader", () => {
  it("reads the turn's event: exchange, then the ledger, with the documented headers and body", async () => {
    serve(event());
    const report = await createCursorUsageReader(FAST).read(query());
    expect(report).toEqual({ usage: FULL });
    const [exchange, events] = stub.requests;
    expect(exchange).toMatchObject({ path: EXCHANGE, authorization: `Bearer ${KEY}`, body: "{}" });
    expect(events).toMatchObject({ path: EVENTS, connectVersion: "1", contentType: "application/json" });
    expect(events?.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.sig$/);
    expect(events?.authorization).not.toContain(KEY);
    expect(JSON.parse(events!.body)).toEqual({ page: 1, pageSize: 50 });
  });

  it("accepts a base URL with a trailing slash", async () => {
    serve(event());
    const report = await createCursorUsageReader(FAST).read(query({ env: { CURSOR_API_KEY: KEY, [USAGE_URL_ENV]: `${stub.url}/` } }));
    expect(report.usage).toEqual(FULL);
  });

  it("keeps polling while the event lags", async () => {
    let calls = 0;
    stub.events = () => {
      calls += 1;
      return { usageEventsDisplay: calls >= 3 ? [event()] : [] };
    };
    const report = await createCursorUsageReader(FAST).read(query());
    expect(report.usage).toEqual(FULL);
    expect(stub.count(EVENTS)).toBe(3);
  });

  it("answers quietly when the event never appears", async () => {
    serve();
    const report = await createCursorUsageReader(FAST).read(query());
    expect(report).toEqual({});
    expect(stub.count(EVENTS)).toBeGreaterThan(1);
  });

  it("gives a second turn of one session only its own event", async () => {
    const reader = createCursorUsageReader(FAST);
    const first = event({ at: Date.now() + 10 });
    serve(first);
    expect((await reader.read(query())).usage).toEqual(FULL);

    // Turn 2 starts a little later; the ledger still lists turn 1's event first.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = event({ at: Date.now() + 10, tokenUsage: { inputTokens: 7, outputTokens: 1 } });
    serve(second, first);
    expect((await reader.read(query())).usage).toEqual({ input: 7, output: 1, cacheRead: 0, cacheWrite: 0, total: 8 });

    // Nothing new: turn 3 gets nothing.
    expect((await reader.read(query())).usage).toBeUndefined();
  });

  it("sums several events of one turn and ignores other conversations", async () => {
    const now = Date.now();
    serve(
      event({ at: now + 10, tokenUsage: { inputTokens: 1, outputTokens: 2 } }),
      event({ at: now + 20, tokenUsage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 } }),
      event({ conversationId: "other", at: now + 30, tokenUsage: { inputTokens: 999 } }),
      event({ conversationId: "ide", at: now + 40, tokenUsage: { inputTokens: 999 } }),
    );
    const report = await createCursorUsageReader(FAST).read(query({ startedAt: now, endedAt: now }));
    expect(report.usage).toEqual({ input: 11, output: 22, cacheRead: 5, cacheWrite: 0, total: 38 });
  });

  it("treats missing counts as zero and all zeros as no usage", async () => {
    serve(event({ tokenUsage: { inputTokens: 5, outputTokens: 6 } }));
    expect((await createCursorUsageReader(FAST).read(query())).usage).toEqual({ input: 5, output: 6, cacheRead: 0, cacheWrite: 0, total: 11 });

    const bare = event();
    delete bare.tokenUsage;
    serve(bare);
    expect(await createCursorUsageReader(FAST).read(query({ sessionId: "sess" }))).toEqual({});
  });

  it("makes no request without a key", async () => {
    const reader = createCursorUsageReader(FAST);
    expect(await reader.read(query({ env: { [USAGE_URL_ENV]: stub.url } }))).toEqual({});
    expect(await reader.read(query({ env: { CURSOR_API_KEY: "  ", [USAGE_URL_ENV]: stub.url } }))).toEqual({});
    expect(stub.requests).toHaveLength(0);
  });

  it("caches the token across turns and shares one exchange between concurrent turns", async () => {
    const reader = createCursorUsageReader(FAST);
    serve(event());
    const [a, b] = await Promise.all([reader.read(query({ sessionId: "sess" })), reader.read(query({ sessionId: "sess2" }))]);
    expect(a.usage).toBeDefined();
    expect(b.usage).toBeUndefined();
    expect(stub.count(EXCHANGE)).toBe(1);
    await reader.read(query());
    expect(stub.count(EXCHANGE)).toBe(1);
  });

  it("exchanges again when the cached token is about to expire", async () => {
    // exp is 10 min away and the margin is 10 min: the token counts as expiring at once, but is still used for a moment.
    stub.token = () => fakeJwt(Math.floor(Date.now() / 1000) + 600);
    serve(event());
    const reader = createCursorUsageReader({ ...FAST, tokenMarginMs: 600_000 });
    await reader.read(query({ sessionId: "a" }));
    expect(stub.count(EXCHANGE)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await reader.read(query({ sessionId: "b" }));
    expect(stub.count(EXCHANGE)).toBe(2);
  });

  it("exchanges once more and retries after an RPC 401", async () => {
    let issued = 0;
    stub.token = () => `${fakeJwt(Math.floor(Date.now() / 1000) + 3600)}${(issued += 1)}`;
    stub.validTokens = new Set();
    const reader = createCursorUsageReader(FAST);
    serve(event());
    // The first token is rejected, the second is accepted.
    const original = stub.token;
    stub.token = () => {
      const token = original();
      if (issued >= 2) stub.validTokens!.add(token);
      return token;
    };
    const report = await reader.read(query());
    expect(report.usage).toEqual(FULL);
    expect(stub.count(EXCHANGE)).toBe(2);
  });

  it("treats a second RPC 401 as a rejected key", async () => {
    stub.validTokens = new Set();
    const reader = createCursorUsageReader(FAST);
    const report = await reader.read(query());
    expect(report.usage).toBeUndefined();
    expect(report.warning).toMatch(/key was rejected/);
    expect(stub.count(EXCHANGE)).toBe(2);
    stub.requests.length = 0;
    expect(await reader.read(query())).toEqual({});
    expect(stub.requests).toHaveLength(0);
  });

  it.each([401, 403])("skips the ledger for the key after the exchange answers %i", async (status) => {
    stub.exchangeStatus = status;
    const reader = createCursorUsageReader(FAST);
    const report = await reader.read(query());
    expect(report.usage).toBeUndefined();
    expect(report.warning).toContain(EXCHANGE);
    expect(report.warning).toContain(String(status));
    expect(report.warning).not.toContain("secret-looking-body");
    expect(report.warning).not.toContain(KEY);
    expect(stub.count(EVENTS)).toBe(0);
    stub.requests.length = 0;
    expect(await reader.read(query())).toEqual({});
    expect(stub.requests).toHaveLength(0);
  });

  it("leaves the cooldown after its time and tracks keys separately", async () => {
    stub.exchangeStatus = 401;
    const reader = createCursorUsageReader({ ...FAST, cooldownMs: 60 });
    expect((await reader.read(query())).warning).toBeDefined();
    stub.exchangeStatus = 200;
    serve(event());
    const other = await reader.read(query({ env: { CURSOR_API_KEY: "another-key", [USAGE_URL_ENV]: stub.url } }));
    expect(other.usage).toEqual(FULL);
    await new Promise((resolve) => setTimeout(resolve, 80));
    serve(event({ at: Date.now() + 20 }));
    expect((await reader.read(query())).usage).toEqual(FULL);
  });

  it.each([400, 404, 415])("warns once and cools down when the RPC answers %i", async (status) => {
    stub.eventStatuses = [status];
    const reader = createCursorUsageReader(FAST);
    const report = await reader.read(query());
    expect(report.usage).toBeUndefined();
    expect(report.warning).toContain(EVENTS);
    expect(report.warning).toContain(String(status));
    expect(report.warning).not.toContain("secret-looking-body");
    stub.requests.length = 0;
    expect(await reader.read(query())).toEqual({});
    expect(stub.requests).toHaveLength(0);
  });

  it.each([{}, { totalUsageEventsCount: 0 }])("treats an answer without the events list (%j) as no event yet", async (answer) => {
    // Proto3 JSON drops an empty list.
    stub.events = () => answer;
    const reader = createCursorUsageReader({ ...FAST, deadlineMs: 30 });
    expect(await reader.read(query())).toEqual({});
    expect(await reader.read(query())).toEqual({});
    // It counts toward the miss streak, but is not a changed RPC.
    const third = await reader.read(query());
    expect(third.warning).toMatch(/unavailable for 3 turns/);
  });

  it.each([{ usageEventsDisplay: "nope" }, { usageEventsDisplay: {} }, "text", null])("treats a present non-array (%j) as a changed RPC", async (answer) => {
    stub.events = () => answer;
    const report = await createCursorUsageReader(FAST).read(query());
    expect(report.warning).toMatch(/unexpected ledger answer/);
  });

  it("treats an exchange answer without a token as a changed RPC", async () => {
    stub.token = () => "";
    const report = await createCursorUsageReader(FAST).read(query());
    expect(report.warning).toContain(EXCHANGE);
  });

  it.each([500, 503, 429, 403])("retries at the next poll after a transient %i", async (status) => {
    stub.eventStatuses = [status];
    serve(event());
    const report = await createCursorUsageReader(FAST).read(query());
    expect(report).toEqual({ usage: FULL });
    expect(stub.count(EVENTS)).toBe(2);
  });

  it.each([500, 429, 403])("answers quietly when %i lasts to the deadline, as one miss", async (status) => {
    stub.eventStatuses = Array<number>(50).fill(status);
    const reader = createCursorUsageReader({ ...FAST, deadlineMs: 60, missStreak: 2 });
    expect(await reader.read(query())).toEqual({});
    stub.eventStatuses = [];
    serve();
    const second = await reader.read(query({ sessionId: "next" }));
    expect(second.warning).toMatch(/unavailable for 2 turns/);
  });

  it("answers quietly to a network error", async () => {
    const reader = createCursorUsageReader({ ...FAST, deadlineMs: 40 });
    const dead = await startLedgerStub();
    const deadUrl = dead.url;
    await dead.close();
    expect(await reader.read(query({ env: { CURSOR_API_KEY: KEY, [USAGE_URL_ENV]: deadUrl } }))).toEqual({});
  });

  it("gives up a slow request after the request timeout and polls again", async () => {
    serve(event());
    stub.eventDelays = [600];
    const reader = createCursorUsageReader({ ...FAST, requestTimeoutMs: 50, deadlineMs: 3000 });
    const started = Date.now();
    expect((await reader.read(query())).usage).toEqual(FULL);
    expect(Date.now() - started).toBeLessThan(450);
  });

  it("never holds the read much past the deadline, however slow the ledger is", async () => {
    stub.delayMs = 2000;
    serve(event());
    const reader = createCursorUsageReader({ ...FAST, requestTimeoutMs: 1500, deadlineMs: 150 });
    const started = Date.now();
    expect(await reader.read(query())).toEqual({});
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("never holds the read past the deadline through a slow exchange either", async () => {
    stub.delayMs = 2000;
    const reader = createCursorUsageReader({ ...FAST, requestTimeoutMs: 1500, deadlineMs: 150 });
    const started = Date.now();
    expect(await reader.read(query())).toEqual({});
    expect(Date.now() - started).toBeLessThan(400);
    expect(stub.count(EVENTS)).toBe(0);
  });

  it("does not count the previous turn's event when that turn's read found nothing", async () => {
    const reader = createCursorUsageReader({ ...FAST, deadlineMs: 40 });
    const t0 = Date.now() - 1000;
    // Turn N: its event exists, but its read sees an empty ledger and gives up.
    serve();
    await reader.read(query({ startedAt: t0 - 2000, endedAt: t0 }));
    const earlier = event({ at: t0 - 1500 });
    // Turn N+1 starts now, well inside the 5 s skew window of the old event.
    serve(earlier);
    expect(await reader.read(query())).toEqual({});
    const own = event({ at: Date.now() + 10, tokenUsage: { inputTokens: 3 } });
    serve(own, earlier);
    expect((await reader.read(query())).usage).toEqual({ input: 3, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 });
  });

  it("does not count an older event of the session when nothing was consumed yet (after a restart)", async () => {
    const now = Date.now();
    serve(event({ at: now - 60_000 }));
    const report = await createCursorUsageReader({ ...FAST, deadlineMs: 30 }).read(query({ startedAt: now, endedAt: now }));
    expect(report).toEqual({});
  });

  it("marks an event without counts consumed and answers at once, without a miss", async () => {
    const reader = createCursorUsageReader({ ...FAST, deadlineMs: 5000, missStreak: 1 });
    serve(event({ tokenUsage: {} }));
    const started = Date.now();
    expect(await reader.read(query())).toEqual({});
    expect(Date.now() - started).toBeLessThan(500);
    expect(stub.count(EVENTS)).toBe(1);
    // missStreak 1 would have started a cooldown (and a warning) had it counted as a miss.
    serve(event({ at: Date.now() + 20 }));
    expect((await reader.read(query())).usage).toEqual(FULL);
  });

  it("reads further pages while the oldest event is still inside the window", async () => {
    const now = Date.now();
    const others = (page: number) =>
      Array.from({ length: 3 }, (_, i) => event({ conversationId: `other-${page}-${i}`, at: now + 100 - page * 10 - i }));
    stub.events = ({ page }) => ({
      usageEventsDisplay: page === 1 ? others(1) : page === 2 ? others(2) : [event({ at: now + 20 }), ...others(3).slice(0, 2)],
    });
    const reader = createCursorUsageReader({ ...FAST, pageSize: 3 });
    expect((await reader.read(query({ startedAt: now, endedAt: now }))).usage).toEqual(FULL);
    expect(stub.requests.filter((r) => r.path === EVENTS).map((r) => JSON.parse(r.body).page)).toEqual([1, 2, 3]);
  });

  it("stops paging at the cap and when the page is older than the window", async () => {
    const now = Date.now();
    stub.events = () => ({ usageEventsDisplay: Array.from({ length: 3 }, (_, i) => event({ conversationId: `o${i}`, at: now + 50 })) });
    await createCursorUsageReader({ ...FAST, pageSize: 3, deadlineMs: 5 }).read(query({ startedAt: now, endedAt: now }));
    const pages = stub.requests.filter((r) => r.path === EVENTS).map((r) => JSON.parse(r.body).page);
    expect(Math.max(...pages)).toBeLessThanOrEqual(3);

    stub.requests.length = 0;
    stub.events = () => ({ usageEventsDisplay: Array.from({ length: 3 }, (_, i) => event({ conversationId: `o${i}`, at: now - 60_000 })) });
    await createCursorUsageReader({ ...FAST, pageSize: 3, deadlineMs: 5 }).read(query({ startedAt: now, endedAt: now }));
    expect(stub.requests.filter((r) => r.path === EVENTS).every((r) => JSON.parse(r.body).page === 1)).toBe(true);
  });

  it("warns once when concurrent turns share a rejected exchange", async () => {
    stub.exchangeStatus = 401;
    stub.delayMs = 30;
    const reader = createCursorUsageReader(FAST);
    const reports = await Promise.all([1, 2, 3, 4].map((n) => reader.read(query({ sessionId: `s${n}` }))));
    expect(reports.filter((report) => report.warning)).toHaveLength(1);
    expect(stub.count(EXCHANGE)).toBe(1);
  });

  it("does not follow a redirect with the key, and answers without usage", async () => {
    const target = await startLedgerStub();
    try {
      stub.redirectTo = target.url;
      const report = await createCursorUsageReader({ ...FAST, deadlineMs: 40 }).read(query());
      expect(report.usage).toBeUndefined();
      expect(stub.count(EXCHANGE)).toBeGreaterThan(0);
      expect(target.requests).toHaveLength(0);
      expect(JSON.stringify(report)).not.toContain(KEY);
    } finally {
      await target.close();
    }
  });

  it("never starts a cooldown from aborted reads", async () => {
    const reader = createCursorUsageReader({ ...FAST, missStreak: 2, firstPollMs: 200, deadlineMs: 2000 });
    for (let i = 0; i < 6; i += 1) {
      const controller = new AbortController();
      const pending = reader.read(query({ signal: controller.signal, sessionId: `a${i}` }));
      setTimeout(() => controller.abort(), 10);
      expect(await pending).toEqual({});
    }
    serve(event({ conversationId: "fresh" }));
    expect((await reader.read(query({ sessionId: "fresh" }))).usage).toEqual(FULL);
  });

  it("starts a cooldown after three turns in a row without usage, with one warning", async () => {
    serve();
    const reader = createCursorUsageReader({ ...FAST, deadlineMs: 20 });
    expect(await reader.read(query())).toEqual({});
    expect(await reader.read(query())).toEqual({});
    const third = await reader.read(query());
    expect(third.usage).toBeUndefined();
    expect(third.warning).toMatch(/unavailable for 3 turns/);
    expect(third.warning).toContain("no event for the session");
    stub.requests.length = 0;
    expect(await reader.read(query())).toEqual({});
    expect(stub.requests).toHaveLength(0);
  });

  it("resets the miss streak on a success", async () => {
    const reader = createCursorUsageReader({ ...FAST, deadlineMs: 20 });
    serve();
    await reader.read(query());
    await reader.read(query());
    serve(event());
    expect((await reader.read(query())).usage).toEqual(FULL);
    serve();
    expect(await reader.read(query())).toEqual({});
    expect(await reader.read(query())).toEqual({});
  });

  it("counts a network failure as a miss and names it in the cooldown warning", async () => {
    const reader = createCursorUsageReader({ ...FAST, missStreak: 2, deadlineMs: 20 });
    const dead = await startLedgerStub();
    const env = { CURSOR_API_KEY: KEY, [USAGE_URL_ENV]: dead.url };
    await dead.close();
    expect(await reader.read(query({ env }))).toEqual({});
    const report = await reader.read(query({ env }));
    expect(report.warning).toContain("network error");
  });

  it("ends the wait at once when the signal aborts", async () => {
    serve();
    const reader = createCursorUsageReader({ ...FAST, firstPollMs: 5000, deadlineMs: 10_000 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = reader.read(query({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toEqual({});
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stub.requests).toHaveLength(0);
  });

  it("never puts the key or a token into a warning", async () => {
    const warnings: string[] = [];
    for (const setup of [
      () => { stub.exchangeStatus = 403; },
      () => { stub.exchangeStatus = 200; stub.eventStatuses = [404]; },
      () => { stub.eventStatuses = []; stub.events = () => "not json {"; },
    ]) {
      stub.requests.length = 0;
      setup();
      const report = await createCursorUsageReader(FAST).read(query({ env: { CURSOR_API_KEY: `${KEY}-${warnings.length}`, [USAGE_URL_ENV]: stub.url } }));
      if (report.warning) warnings.push(report.warning);
    }
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      expect(warning).not.toContain(KEY);
      expect(warning).not.toContain("sig");
      expect(warning).not.toContain("secret-looking-body");
    }
  });
});

describe("matchTurnEvents", () => {
  const base = { sessionId: "s", notBefore: 1000 };
  const ev = (timestamp: unknown, tokens: Record<string, unknown> = { inputTokens: 1 }, conversationId = "s") =>
    ({ conversationId, timestamp, tokenUsage: tokens }) as never;

  it("keeps events at or after notBefore and drops older ones", () => {
    expect(matchTurnEvents([ev("999"), ev("1000", { inputTokens: 2 })], base).usage).toEqual({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 });
    expect(matchTurnEvents([ev("999")], base)).toEqual({});
  });

  it("drops events at or before the last consumed stamp", () => {
    expect(matchTurnEvents([ev("1500"), ev("2000")], { ...base, after: 1500 }).latest).toBe(2000);
    expect(matchTurnEvents([ev("1500")], { ...base, after: 1500 })).toEqual({});
  });

  it("reads numbers as strings or numbers and ignores junk", () => {
    const result = matchTurnEvents(
      [ev(1200, { inputTokens: "10", outputTokens: 5, cacheReadTokens: "x", cacheWriteTokens: -3 }), ev("nope"), null as never, ev("1300", {}, "other")],
      base,
    );
    expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 });
    expect(result.latest).toBe(1200);
  });

  it("ignores unsafe counts and keeps the total finite", () => {
    const big = Number.MAX_SAFE_INTEGER;
    const result = matchTurnEvents(
      [ev(1200, { inputTokens: big, outputTokens: big }), ev(1300, { inputTokens: big, cacheReadTokens: 1e300, cacheWriteTokens: 1.5 })],
      base,
    );
    expect(result.usage?.input).toBe(big);
    expect(result.usage?.cacheRead).toBe(0);
    expect(result.usage?.cacheWrite).toBe(0);
    expect(Number.isSafeInteger(result.usage?.total)).toBe(true);
  });

  it("reports latest even when every count is zero", () => {
    expect(matchTurnEvents([ev("1200", {})], base)).toEqual({ latest: 1200 });
  });
});
