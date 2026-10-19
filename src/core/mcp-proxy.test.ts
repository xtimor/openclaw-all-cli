import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startMcpProxy, type McpProxy } from "./mcp-proxy.ts";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

/** A stand-in for the host's loopback MCP endpoint. */
async function startStub(handler?: (req: IncomingMessage, res: import("node:http").ServerResponse, seen: Seen) => void) {
  const requests: Seen[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() };
      requests.push(seen);
      if (handler) return handler(req, res, seen);
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "s-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { echoed: seen.body } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

const proxies: McpProxy[] = [];
const stubs: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all([...proxies.splice(0).map((p) => p.close()), ...stubs.splice(0).map((s) => s.close())]);
});

async function proxy() {
  const p = await startMcpProxy();
  proxies.push(p);
  return p;
}
async function stub(handler?: Parameters<typeof startStub>[0]) {
  const s = await startStub(handler);
  stubs.push(s);
  return s;
}

const call = (p: McpProxy, init: RequestInit = {}, token: string | null = p.token) =>
  fetch(p.url, {
    method: "POST",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(init.headers as Record<string, string> | undefined),
    },
    body: init.body ?? JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
  });

describe("startMcpProxy", () => {
  it("binds 127.0.0.1 on a random port with its own token", async () => {
    const a = await proxy();
    const b = await proxy();
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(a.url).not.toBe(b.url);
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(32);
  });

  it("forwards method, path, body, and the turn's headers, and returns the response unchanged", async () => {
    const target = await stub();
    const p = await proxy();
    p.setTarget({ url: target.url, headers: { Authorization: "Bearer turn-1", "x-openclaw-cli-capture-key": "key-1" } });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x", arguments: { a: 1 } } });
    const res = await call(p, { body, headers: { Accept: "application/json, text/event-stream", "Mcp-Session-Id": "abc" } });

    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("s-1");
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { echoed: body } });
    expect(target.requests).toHaveLength(1);
    const seen = target.requests[0]!;
    expect(seen).toMatchObject({ method: "POST", url: "/mcp", body });
    // The CLI's own token never reaches the host; the turn's headers replace it.
    expect(seen.headers.authorization).toBe("Bearer turn-1");
    expect(seen.headers["x-openclaw-cli-capture-key"]).toBe("key-1");
    expect(seen.headers["mcp-session-id"]).toBe("abc");
    expect(seen.headers.accept).toBe("application/json, text/event-stream");
  });

  it("does not pass the CLI's own capture header on", async () => {
    const target = await stub();
    const p = await proxy();
    p.setTarget({ url: target.url, headers: { Authorization: "Bearer t" } });
    await call(p, { headers: { "x-openclaw-cli-capture-key": "from-cli" } });
    expect(target.requests[0]!.headers["x-openclaw-cli-capture-key"]).toBeUndefined();
  });

  it("sends each turn's calls to that turn's target with that turn's headers", async () => {
    const first = await stub();
    const second = await stub();
    const p = await proxy();

    p.setTarget({ url: first.url, headers: { Authorization: "Bearer turn-1", "x-openclaw-cli-capture-key": "k1" } });
    expect((await call(p)).status).toBe(200);
    p.clearTarget();
    p.setTarget({ url: second.url, headers: { Authorization: "Bearer turn-2", "x-openclaw-cli-capture-key": "k2" } });
    expect((await call(p)).status).toBe(200);

    expect(first.requests).toHaveLength(1);
    expect(first.requests[0]!.headers.authorization).toBe("Bearer turn-1");
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]!.headers.authorization).toBe("Bearer turn-2");
    expect(second.requests[0]!.headers["x-openclaw-cli-capture-key"]).toBe("k2");
  });

  it("replaces a target at the next turn start without a clear", async () => {
    const first = await stub();
    const second = await stub();
    const p = await proxy();
    p.setTarget({ url: first.url, headers: { Authorization: "Bearer a" } });
    p.setTarget({ url: second.url, headers: { Authorization: "Bearer b" } });
    await call(p);
    expect(first.requests).toHaveLength(0);
    expect(second.requests[0]!.headers.authorization).toBe("Bearer b");
  });

  it("rejects a call outside a turn with 503 and a JSON-RPC error, and never reuses an old target", async () => {
    const target = await stub();
    const p = await proxy();

    const before = await call(p);
    expect(before.status).toBe(503);
    expect(await before.json()).toMatchObject({ jsonrpc: "2.0", id: 7, error: { message: expect.any(String) } });

    p.setTarget({ url: target.url, headers: {} });
    expect((await call(p)).status).toBe(200);
    p.clearTarget();
    const after = await call(p);
    expect(after.status).toBe(503);
    expect(target.requests).toHaveLength(1);
  });

  it.each([
    ["no Authorization header", null],
    ["a wrong token", "not-the-token"],
  ])("rejects %s with 401 and forwards nothing", async (_name, token) => {
    const target = await stub();
    const p = await proxy();
    p.setTarget({ url: target.url, headers: { Authorization: "Bearer turn" } });
    const res = await call(p, {}, token);
    expect(res.status).toBe(401);
    expect(target.requests).toEqual([]);
  });

  it("rejects the host's own token as a client token", async () => {
    const target = await stub();
    const p = await proxy();
    p.setTarget({ url: target.url, headers: { Authorization: "Bearer turn" } });
    expect((await call(p, {}, "turn")).status).toBe(401);
    expect(target.requests).toEqual([]);
  });

  it("answers 404 for a path outside /mcp", async () => {
    const p = await proxy();
    const res = await fetch(p.url.replace("/mcp", "/other"), { method: "POST", headers: { Authorization: `Bearer ${p.token}` }, body: "{}" });
    expect(res.status).toBe(404);
  });

  it("answers 502 when the target is down, then keeps serving", async () => {
    const dead = await startStub();
    await dead.close();
    const live = await stub();
    const p = await proxy();
    p.setTarget({ url: dead.url, headers: {} });
    const res = await call(p);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", id: 7, error: { message: expect.stringContaining("unreachable") } });
    p.setTarget({ url: live.url, headers: {} });
    expect((await call(p)).status).toBe(200);
  });

  it("relays a streamed response as it arrives", async () => {
    const target = await stub((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 50);
    });
    const p = await proxy();
    p.setTarget({ url: target.url, headers: {} });
    const res = await call(p);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n");
    let rest = "";
    for (let part = await reader.read(); !part.done; part = await reader.read()) rest += new TextDecoder().decode(part.value);
    expect(rest).toBe("data: two\n\n");
  });

  it("relays a non-200 status and body from the target", async () => {
    const target = await stub((_req, res) => {
      res.writeHead(202);
      res.end();
    });
    const p = await proxy();
    p.setTarget({ url: target.url, headers: {} });
    const res = await call(p, { body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(res.status).toBe(202);
  });

  it("ends a call still running when the turn ends", async () => {
    let release: () => void = () => {};
    const target = await stub((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(":\n\n");
      release = () => res.end();
    });
    const p = await proxy();
    p.setTarget({ url: target.url, headers: {} });
    const res = await call(p);
    const reader = res.body!.getReader();
    await reader.read();
    p.clearTarget();
    // The stub never ends the stream: only the proxy can end it. A reset also counts as ended.
    const ended = await reader.read().then((part) => part.done, () => true);
    expect(ended).toBe(true);
    release();
  });

  it("relays keepalive frames before the body, then the body", async () => {
    const target = await stub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("\n");
      setTimeout(() => res.write("\n"), 30);
      setTimeout(() => res.end('{"jsonrpc":"2.0","id":7,"result":{}}'), 80);
    });
    const p = await proxy();
    p.setTarget({ url: target.url, headers: {} });
    const res = await call(p);
    const reader = res.body!.getReader();
    // The first frame arrives long before the body: the call is not buffered.
    const startedAt = Date.now();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("\n");
    expect(Date.now() - startedAt).toBeLessThan(60);
    let rest = "";
    for (let part = await reader.read(); !part.done; part = await reader.read()) rest += new TextDecoder().decode(part.value);
    expect(rest.trim()).toBe('{"jsonrpc":"2.0","id":7,"result":{}}');
  });

  it("closes the upstream call when the CLI hangs up mid-call", async () => {
    let upstreamClosed = false;
    let reached: () => void = () => {};
    const arrived = new Promise<void>((resolve) => (reached = resolve));
    const target = await stub((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("\n");
      res.on("close", () => (upstreamClosed = true));
      reached();
    });
    const p = await proxy();
    p.setTarget({ url: target.url, headers: {} });
    const controller = new AbortController();
    const res = await call(p, { signal: controller.signal });
    await res.body!.getReader().read();
    await arrived;
    controller.abort();
    const deadline = Date.now() + 3_000;
    while (!upstreamClosed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(upstreamClosed).toBe(true);
  });

  it("answers parallel calls separately", async () => {
    const target = await stub((_req, res, seen) => {
      const { id, params } = JSON.parse(seen.body) as { id: number; params: { delayMs: number } };
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { id } }));
      }, params.delayMs);
    });
    const p = await proxy();
    p.setTarget({ url: target.url, headers: {} });
    const body = (id: number, delayMs: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { delayMs } });
    const [slow, fast] = await Promise.all([call(p, { body: body(1, 150) }), call(p, { body: body(2, 0) })]);
    expect(await slow.json()).toMatchObject({ id: 1, result: { id: 1 } });
    expect(await fast.json()).toMatchObject({ id: 2, result: { id: 2 } });
  });

  it("closes and frees the port", async () => {
    const p = await proxy();
    const url = p.url;
    await p.close();
    await p.close();
    await expect(fetch(url, { method: "POST", body: "{}" })).rejects.toThrow();
    // The port can be bound again.
    const again = createServer();
    const port = Number(new URL(url).port);
    await new Promise<void>((resolve, reject) => {
      again.once("error", reject);
      again.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => again.close(() => resolve()));
  });

  it("keeps parallel proxies apart", async () => {
    const targetA = await stub();
    const targetB = await stub();
    const a = await proxy();
    const b = await proxy();
    a.setTarget({ url: targetA.url, headers: { Authorization: "Bearer a" } });
    b.setTarget({ url: targetB.url, headers: { Authorization: "Bearer b" } });

    await Promise.all([call(a), call(b), call(a)]);
    expect(targetA.requests.map((r) => r.headers.authorization)).toEqual(["Bearer a", "Bearer a"]);
    expect(targetB.requests.map((r) => r.headers.authorization)).toEqual(["Bearer b"]);
    // A's token does not open B.
    expect((await call(b, {}, a.token)).status).toBe(401);
    a.clearTarget();
    expect((await call(a)).status).toBe(503);
    expect((await call(b)).status).toBe(200);
  });

  it("forwards a GET with no body, keeping the method and the query", async () => {
    const target = await stub();
    const p = await proxy();
    p.setTarget({ url: target.url, headers: { Authorization: "Bearer t" } });
    const res = await fetch(`${p.url}?a=1`, { method: "GET", headers: { Authorization: `Bearer ${p.token}`, Accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    expect(target.requests[0]).toMatchObject({ method: "GET", url: "/mcp?a=1", body: "" });
    expect(target.requests[0]!.headers.authorization).toBe("Bearer t");
  });

  it("forwards a DELETE to a subpath with its query", async () => {
    const target = await stub();
    const p = await proxy();
    p.setTarget({ url: target.url, headers: {} });
    const res = await fetch(`${p.url}/x?y=1`, { method: "DELETE", headers: { Authorization: `Bearer ${p.token}` } });
    expect(res.status).toBe(200);
    expect(target.requests[0]).toMatchObject({ method: "DELETE", url: "/mcp/x?y=1" });
  });

  it("merges the incoming query onto a target URL that has its own", async () => {
    const target = await stub();
    const p = await proxy();
    p.setTarget({ url: `${target.url}?own=1`, headers: {} });
    await fetch(`${p.url}/sub?y=2`, { method: "POST", headers: { Authorization: `Bearer ${p.token}` }, body: "{}" });
    await fetch(p.url, { method: "POST", headers: { Authorization: `Bearer ${p.token}` }, body: "{}" });
    expect(target.requests.map((r) => r.url)).toEqual(["/mcp/sub?own=1&y=2", "/mcp?own=1"]);
  });

  it("tolerates a trailing slash on the target URL", async () => {
    const target = await stub();
    const p = await proxy();
    p.setTarget({ url: `${target.url}/`, headers: {} });
    await call(p);
    expect(target.requests[0]!.url).toBe("/mcp");
  });

  it("does not forward the CLI's x-openclaw-*, cookie, origin, or x-forwarded-* headers", async () => {
    const target = await stub();
    const p = await proxy();
    p.setTarget({ url: target.url, headers: { "x-openclaw-cli-capture-key": "turn-key" } });
    await call(p, {
      headers: {
        "x-openclaw-cli-capture-key": "from-cli",
        "x-openclaw-sender-owner": "true",
        Cookie: "a=b",
        Origin: "http://evil.example",
        "X-Forwarded-For": "1.2.3.4",
        "X-Forwarded-Host": "evil.example",
        Forwarded: "for=1.2.3.4",
        "X-Real-IP": "1.2.3.4",
        Referer: "http://evil.example/",
        Via: "1.1 evil",
        "Proxy-Connection": "keep-alive",
        "Mcp-Protocol-Version": "2025-03-26",
      },
    });
    const seen = target.requests[0]!.headers;
    expect(seen["x-openclaw-cli-capture-key"]).toBe("turn-key");
    for (const name of ["x-openclaw-sender-owner", "cookie", "origin", "x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip", "referer", "via", "proxy-connection"]) {
      expect(seen[name]).toBeUndefined();
    }
    expect(seen["mcp-protocol-version"]).toBe("2025-03-26");
  });
});
