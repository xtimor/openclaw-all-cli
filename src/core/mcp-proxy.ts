import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

/**
 * A stable local MCP endpoint for one live session (AD-12). The CLI is given only this endpoint
 * and its own Bearer token. The host mints a new loopback URL and token for every run, so the
 * proxy forwards each request to the current turn's target and rejects calls outside a turn.
 *
 * It is a thin forwarder, not an MCP server: it reads no tool call and relays method, path,
 * body, and the response stream.
 */

/** Where the current turn's MCP calls go: the host's loopback URL and the headers it expects. */
export type McpTarget = {
  url: string;
  headers: Readonly<Record<string, string>>;
};

export type StartMcpProxyOptions = {
  /**
   * Deadline for each forwarded `tools/call`, in ms; other requests have none. Absent: no deadline.
   * A CLI whose MCP client gives up on a call without hanging up needs one just under its own
   * limit: otherwise the host keeps the work running while the model sees a timeout and starts it again.
   */
  callDeadlineMs?: number;
};

export type McpProxy = {
  /** The endpoint to hand to the CLI. */
  readonly url: string;
  /** The Bearer token the CLI must present. */
  readonly token: string;
  /** Replaces the target at a turn start. Calls still running against the old target end. */
  setTarget(target: McpTarget): void;
  /** Rejects every call until the next `setTarget`. Calls still running end. */
  clearTarget(): void;
  /** Stops the server, ends running calls, and frees the port. Safe to call twice. */
  close(): Promise<void>;
};

const PROXY_PATH = "/mcp";

/** Headers that describe one hop, not the message. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Request headers the proxy never copies: its own auth, framing the fetch recomputes, browser and proxy context. */
const REQUEST_DROP = new Set([
  "authorization",
  "host",
  "content-length",
  "accept-encoding",
  "cookie",
  "origin",
  "referer",
  "forwarded",
  "via",
  "x-real-ip",
  "proxy-connection",
]);

/** Header prefixes the proxy never copies: the host's own `x-openclaw-*` headers come only from the turn's target. */
const REQUEST_DROP_PREFIXES = ["x-openclaw-", "x-forwarded-"];

/** Response headers the proxy never copies: fetch already decoded the body. */
const RESPONSE_DROP = new Set(["content-length", "content-encoding"]);

const digest = (value: string) => createHash("sha256").update(value).digest();

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return timingSafeEqual(digest(match[1]!), digest(token));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Whether a request body is a single JSON-RPC `tools/call`. The tool and its arguments are never read. */
function isToolCall(body: Buffer): boolean {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { method?: unknown }).method === "tools/call";
  } catch {
    return false;
  }
}

/** The text the model reads when a call hit the deadline. */
function deadlineMessage(ms: number): string {
  return (
    `This tool call ran longer than ${Math.round(ms / 1000)} seconds, the longest the CLI waits for one call, so it was stopped and ` +
    "the work it started was cancelled. Do not run it again the same way: start a long command in the background " +
    "(exec with background or yieldMs) and poll it with the process tool."
  );
}

/** The JSON-RPC id of a single request body, so an error answers the right call. */
function requestId(body: Buffer): string | number | null {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") return id;
    }
  } catch {
    // Not JSON (a GET or DELETE has no body): the error carries a null id.
  }
  return null;
}

function reject(res: ServerResponse, status: number, message: string, id: string | number | null = null): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id }));
}

function forwardedHeaders(req: IncomingMessage, target: McpTarget): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(lower) || REQUEST_DROP.has(lower)) continue;
    if (REQUEST_DROP_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  for (const [name, value] of Object.entries(target.headers)) headers.set(name, value);
  // The response is relayed as the fetch decoded it.
  headers.set("accept-encoding", "identity");
  return headers;
}

/** Starts the proxy on `127.0.0.1` with a random port and a random Bearer token. */
export async function startMcpProxy(options: StartMcpProxyOptions = {}): Promise<McpProxy> {
  const callDeadlineMs = options.callDeadlineMs;
  const token = randomBytes(32).toString("hex");
  let target: McpTarget | undefined;
  let closed = false;
  /** Calls running against a target; they end when the target changes or the proxy closes. */
  const running = new Set<AbortController>();

  const endRunning = () => {
    for (const controller of running) controller.abort();
    running.clear();
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!tokenMatches(req.headers.authorization, token)) {
      req.resume();
      return reject(res, 401, "Unauthorized.");
    }
    const incoming = new URL(req.url ?? "/", "http://127.0.0.1");
    if (incoming.pathname !== PROXY_PATH && !incoming.pathname.startsWith(`${PROXY_PATH}/`)) {
      req.resume();
      return reject(res, 404, "Not found.");
    }
    const body = await readBody(req);
    const id = requestId(body);
    // Read after the body: the turn may have ended while the request was arriving.
    const current = target;
    if (!current) return reject(res, 503, "OpenClaw tools are not available outside a turn.", id);

    const controller = new AbortController();
    running.add(controller);
    // A tool call gets a deadline just under the CLI's own; on expiry the upstream request is
    // aborted (the host then stops the work) and the CLI gets a tool error it can act on.
    let expired = false;
    let eventStream = false;
    let relayed: Readable | undefined;
    const deadline = callDeadlineMs !== undefined && isToolCall(body)
      ? setTimeout(() => {
          expired = true;
          relayed?.unpipe(res);
          controller.abort();
          answerExpired();
        }, callDeadlineMs)
      : undefined;
    function answerExpired() {
      if (res.writableEnded || res.destroyed) return;
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: deadlineMessage(callDeadlineMs ?? 0) }] },
      });
      // Keepalive frames may already have started the response: only the body is left to write.
      if (!res.headersSent) res.writeHead(200, { "Content-Type": eventStream ? "text/event-stream" : "application/json" });
      res.end(eventStream ? `event: message\ndata: ${payload}\n\n` : payload);
    }
    // The CLI hung up: stop the upstream call.
    res.on("close", () => {
      clearTimeout(deadline);
      if (!res.writableEnded) controller.abort();
      running.delete(controller);
    });
    try {
      // The target keeps its own path and query; the CLI's subpath and query are merged onto them.
      const url = new URL(current.url);
      url.pathname = url.pathname.replace(/\/+$/, "") + incoming.pathname.slice(PROXY_PATH.length);
      for (const [name, value] of incoming.searchParams) url.searchParams.append(name, value);
      const upstream = await fetch(url, {
        method: req.method ?? "POST",
        headers: forwardedHeaders(req, current),
        ...(body.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? { body: new Uint8Array(body) } : {}),
        signal: controller.signal,
      });
      const headers: Record<string, string | string[]> = {};
      upstream.headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        if (!HOP_BY_HOP.has(lower) && !RESPONSE_DROP.has(lower) && lower !== "set-cookie") headers[name] = value;
      });
      eventStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
      if (expired) return;
      res.writeHead(upstream.status, headers);
      if (!upstream.body) return void res.end();
      const stream = Readable.fromWeb(upstream.body as never);
      relayed = stream;
      stream.on("error", () => (expired ? answerExpired() : res.destroy()));
      stream.pipe(res, { end: false });
      stream.on("end", () => {
        if (!expired) res.end();
      });
    } catch (error) {
      if (expired) return;
      if (controller.signal.aborted) return void res.destroy();
      const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      reject(res, 502, `OpenClaw's tool endpoint is unreachable: ${reason}`, id);
    }
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => reject(res, 500, "The MCP proxy failed."));
  });
  // Calls are long (a tool may run for minutes); the host's timers decide when a turn ends.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  await new Promise<void>((resolve, reject_) => {
    server.once("error", reject_);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject_);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}${PROXY_PATH}`,
    token,
    setTarget(next) {
      if (closed) return;
      endRunning();
      target = { url: next.url, headers: { ...next.headers } };
    },
    clearTarget() {
      target = undefined;
      endRunning();
    },
    close() {
      closed = true;
      target = undefined;
      closing ??= new Promise<void>((resolve) => {
        endRunning();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
