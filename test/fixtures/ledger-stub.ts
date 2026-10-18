import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

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

/**
 * A local stand-in for Cursor's usage ledger (token exchange and `GetFilteredUsageEvents`) on
 * 127.0.0.1. Tests set the fields to steer the answers and read `requests` to see what was sent.
 */
export async function startLedgerStub() {
  const stub = {
    url: "",
    requests: [] as LedgerRequest[],
    /** HTTP status of the exchange; 200 returns `accessToken`. */
    exchangeStatus: 200,
    /** The token the exchange hands out. Called per exchange. */
    token: () => fakeJwt(Math.floor(Date.now() / 1000) + 3600),
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  const server = createServer(async (req, res) => {
    const body = await read(req);
    const path = req.url ?? "";
    stub.requests.push({
      path,
      authorization: req.headers.authorization,
      connectVersion: req.headers["connect-protocol-version"] as string | undefined,
      contentType: req.headers["content-type"],
      body,
    });
    if (stub.delayMs) await new Promise((resolve) => setTimeout(resolve, stub.delayMs));
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    if (path === "/auth/exchange_user_api_key") {
      if (stub.redirectTo) {
        res.writeHead(302, { Location: `${stub.redirectTo}/auth/exchange_user_api_key` });
        return res.end();
      }
      if (stub.exchangeStatus !== 200) return send(stub.exchangeStatus, { error: "secret-looking-body" });
      return send(200, { accessToken: stub.token(), refreshToken: "refresh" });
    }
    if (path === "/aiserver.v1.DashboardService/GetFilteredUsageEvents") {
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
      if (stub.validTokens && !stub.validTokens.has(token)) return send(401, { code: "unauthenticated" });
      const eventDelay = stub.eventDelays.shift();
      if (eventDelay) await new Promise((resolve) => setTimeout(resolve, eventDelay));
      const status = stub.eventStatuses.shift() ?? 200;
      if (status !== 200) return send(status, { error: "secret-looking-body" });
      const payload = stub.events(JSON.parse(body || "{}") as { page: number; pageSize: number });
      return send(200, payload as object);
    }
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}
