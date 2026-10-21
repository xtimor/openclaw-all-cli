import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { UsageFetch } from "../../src/adapters/cursor/usage.ts";
import type { VirtualClock } from "./virtual-clock.ts";

/** One request the stub received. */
export type LedgerRequest = {
  path: string;
  authorization: string | undefined;
  connectVersion: string | undefined;
  contentType: string | undefined;
  body: string;
};

export type LedgerEventStub = {
  conversationId: string;
  timestamp: string;
  model?: string;
  tokenUsage?: Record<string, number>;
};

/** A JWT-shaped token with the given `exp` (epoch seconds); the signature is fake. */
export function fakeJwt(expSeconds: number): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp: expSeconds })}.sig`;
}

/** The fields tests set to steer the answers, and `requests` to see what was sent. */
function steering(now: () => number) {
  const stub = {
    requests: [] as LedgerRequest[],
    /** HTTP status of the exchange; 200 returns `accessToken`. */
    exchangeStatus: 200,
    /** The token the exchange hands out. Called per exchange. */
    token: () => fakeJwt(Math.floor(now() / 1000) + 3600),
    /** Statuses for the next event calls, one per call; empty means 200. */
    eventStatuses: [] as number[],
    /** The body of a 200 answer, evaluated per call with the request's `{page, pageSize}`. */
    events: (_request: { page: number; pageSize: number }): unknown => ({ totalUsageEventsCount: 0, usageEventsDisplay: [] as LedgerEventStub[] }),
    /** Delays every answer. */
    delayMs: 0,
    /** Delays for the next event calls only, one per call. */
    eventDelays: [] as number[],
    /** When set, the exchange answers 302 to this URL. */
    redirectTo: undefined as string | undefined,
    /** Tokens the events endpoint accepts; undefined accepts every token. */
    validTokens: undefined as Set<string> | undefined,
    count: (path: string) => stub.requests.filter((request) => request.path === path).length,
  };
  return stub;
}

type Steering = ReturnType<typeof steering>;

type Answer = { status: number; location?: string; text: string };

/**
 * The ledger's answer to one request, shared by the HTTP stub and the in-memory fake so they
 * cannot drift. `wait` is how a delay passes: a real timer, or the virtual clock.
 */
async function answer(
  stub: Steering,
  request: { path: string; headers: Record<string, string | undefined>; body: string },
  wait: (ms: number) => Promise<void>,
): Promise<Answer> {
  const { path, headers, body } = request;
  stub.requests.push({
    path,
    authorization: headers.authorization,
    connectVersion: headers["connect-protocol-version"],
    contentType: headers["content-type"],
    body,
  });
  if (stub.delayMs) await wait(stub.delayMs);
  const send = (status: number, payload: unknown): Answer => ({ status, text: typeof payload === "string" ? payload : JSON.stringify(payload) });
  if (path === "/auth/exchange_user_api_key") {
    if (stub.redirectTo) return { status: 302, location: `${stub.redirectTo}/auth/exchange_user_api_key`, text: "" };
    if (stub.exchangeStatus !== 200) return send(stub.exchangeStatus, { error: "secret-looking-body" });
    return send(200, { accessToken: stub.token(), refreshToken: "refresh" });
  }
  if (path === "/aiserver.v1.DashboardService/GetFilteredUsageEvents") {
    const token = headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (stub.validTokens && !stub.validTokens.has(token)) return send(401, { code: "unauthenticated" });
    const eventDelay = stub.eventDelays.shift();
    if (eventDelay) await wait(eventDelay);
    const status = stub.eventStatuses.shift() ?? 200;
    if (status !== 200) return send(status, { error: "secret-looking-body" });
    const payload = stub.events(JSON.parse(body || "{}") as { page: number; pageSize: number });
    return send(200, payload as object);
  }
  return send(404, {});
}

/**
 * A local stand-in for Cursor's usage ledger (token exchange and `GetFilteredUsageEvents`) on
 * 127.0.0.1. Tests set the fields to steer the answers and read `requests` to see what was sent.
 */
export async function startLedgerStub() {
  const stub = Object.assign(steering(() => Date.now()), {
    url: "",
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  const server = createServer(async (req, res) => {
    const body = await read(req);
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(", ") : value;
    const result = await answer(stub, { path: req.url ?? "", headers, body }, (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    res.writeHead(result.status, result.location ? { Location: result.location } : { "Content-Type": "application/json" });
    res.end(result.text || undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}

/**
 * The same ledger in memory, on a virtual clock: the same steering fields and answers as
 * `startLedgerStub`, plus `down` (the connection fails). `fetch` plugs into the reader's seam, so
 * no real I/O races a deadline; every delay is `clock.sleep`.
 */
export function createLedgerFake(clock: VirtualClock) {
  const stub = Object.assign(steering(() => clock.now()), {
    url: "http://ledger.invalid",
    /** When true, every call fails like a refused connection. */
    down: false,
    fetch: (async (input: string, init: RequestInit) => {
      const signal = init.signal ?? undefined;
      // Real fetch sends nothing on an already-aborted signal.
      if (signal?.aborted) throw signal.reason;
      if (stub.down) throw new TypeError("fetch failed");
      const url = new URL(input);
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
      const wait = async (ms: number) => {
        await clock.sleep(ms, signal);
        if (signal?.aborted) throw signal.reason;
      };
      const result = await answer(stub, { path: url.pathname + url.search, headers, body: String(init.body ?? "") }, wait);
      if (result.status >= 300 && result.status < 400 && init.redirect === "error") throw new TypeError("fetch failed");
      return {
        status: result.status,
        body: { cancel: async () => {} },
        json: async () => JSON.parse(result.text) as unknown,
      } as unknown as Response;
    }) satisfies UsageFetch,
  });
  return stub;
}
